import type { Provider } from '../../shared/types.ts';
import type { Db } from '../db/index.ts';
import type { Repos } from '../db/repos.ts';
import type { SecretStore } from '../secrets/store.ts';
import { DAY, errMessage, newId, type Clock, type Logger } from '../util.ts';
import { createAnthropicClient } from './anthropic.ts';
import { createGeminiClient } from './gemini.ts';
import { extractJson } from './json.ts';
import { createMockClient } from './mock.ts';
import { createOpenAiCompatClient } from './openaiCompat.ts';
import { LlmError, type ChatRequest, type LlmClient, type LlmClientFactory, type ProviderRuntime } from './types.ts';

export const defaultClientFactory: LlmClientFactory = (rt: ProviderRuntime): LlmClient => {
  switch (rt.provider.kind) {
    case 'anthropic':
      return createAnthropicClient(rt);
    case 'openai_compat':
      return createOpenAiCompatClient(rt);
    case 'gemini':
      return createGeminiClient(rt);
    case 'mock':
      return createMockClient(rt);
  }
};

export interface RouteOptions<T> {
  conversationId?: string | null;
  /** Ordered chain. Empty/undefined = every enabled provider by priority. */
  providerIds?: string[];
  /** Use exactly this provider, no fallback (compare view, provider test). */
  onlyProviderId?: string;
  /** Lenient reader for the model's JSON. Throwing marks the output unusable. */
  parse: (raw: unknown) => T;
}

export interface RouteResult<T> {
  value: T;
  provider: Provider;
  llmCallId: string;
  latencyMs: number;
}

interface Breaker {
  failures: number;
  openUntil: number;
}

export class LlmRouter {
  private db: Db;
  private repos: Repos;
  private secrets: SecretStore;
  private clock: Clock;
  private log: Logger;
  private factory: LlmClientFactory;
  private clients = new Map<string, { client: LlmClient; stamp: number }>();
  private breakers = new Map<string, Breaker>();
  private activeCalls = 0;

  constructor(deps: { db: Db; repos: Repos; secrets: SecretStore; clock: Clock; log: Logger; factory?: LlmClientFactory }) {
    this.db = deps.db;
    this.repos = deps.repos;
    this.secrets = deps.secrets;
    this.clock = deps.clock;
    this.log = deps.log;
    this.factory = deps.factory ?? defaultClientFactory;
  }

  private chain(opts: { providerIds?: string[]; onlyProviderId?: string }): Provider[] {
    if (opts.onlyProviderId) {
      const p = this.repos.providers.get(opts.onlyProviderId);
      return p ? [p] : [];
    }
    const enabled = this.repos.providers.list().filter((p) => p.enabled);
    if (opts.providerIds && opts.providerIds.length > 0) {
      const picked = opts.providerIds.map((id) => enabled.find((p) => p.id === id)).filter((p): p is Provider => p !== undefined);
      return picked;
    }
    const live = enabled.filter((p) => p.kind !== 'mock');
    return live.length > 0 ? live : enabled;
  }

  private async client(provider: Provider): Promise<LlmClient> {
    const hit = this.clients.get(provider.id);
    if (hit && hit.stamp === provider.updatedAt) return hit.client;
    const apiKey = await this.secrets.resolve(provider.apiKeyRef);
    if (provider.apiKeyRef && !apiKey) throw new LlmError('auth', `API key reference "${provider.apiKeyRef.split(':')[0]}:…" resolved to nothing`);
    const client = this.factory({ provider, apiKey });
    this.clients.set(provider.id, { client, stamp: provider.updatedAt });
    return client;
  }

  private tokensLastDay(providerId: string): number {
    const row = this.db.get<{ n: number | null }>('SELECT SUM(inputTokens + outputTokens) AS n FROM llm_calls WHERE providerId = ? AND createdAt > ?', providerId, this.clock.now() - DAY);
    return row?.n ?? 0;
  }

  callsLastDay(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM llm_calls WHERE createdAt > ? AND purpose != 'test'", this.clock.now() - DAY)?.n ?? 0;
  }

  private record(req: ChatRequest, provider: Provider, conversationId: string | null, started: number, result: { text: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number } | null, error: string): string {
    const id = newId('llm');
    const cost =
      result && provider.priceIn !== null && provider.priceOut !== null
        ? (result.inputTokens * provider.priceIn + result.cacheReadTokens * provider.priceIn * 0.1 + result.outputTokens * provider.priceOut) / 1_000_000
        : null;
    this.db.insert('llm_calls', {
      id,
      conversationId,
      purpose: req.purpose,
      providerId: provider.id,
      providerName: provider.name,
      model: result?.model ?? provider.model,
      systemPrompt: req.systemDynamic ? `${req.systemStatic}\n\n${req.systemDynamic}` : req.systemStatic,
      userPrompt: req.user,
      rawResponse: result?.text ?? '',
      ok: error === '',
      error,
      inputTokens: result?.inputTokens ?? 0,
      outputTokens: result?.outputTokens ?? 0,
      cacheReadTokens: result?.cacheReadTokens ?? 0,
      latencyMs: this.clock.now() - started,
      costUsd: cost,
      createdAt: this.clock.now(),
    });
    return id;
  }

  private trip(provider: Provider, kind: string): void {
    const b = this.breakers.get(provider.id) ?? { failures: 0, openUntil: 0 };
    b.failures++;
    // A bad key won't heal by itself; back off for longer than for a flaky network.
    if (kind === 'auth') b.openUntil = this.clock.now() + 10 * 60_000;
    else if (b.failures >= 3) b.openUntil = this.clock.now() + 60_000;
    this.breakers.set(provider.id, b);
  }

  /** Tries each provider in turn. Every attempt, good or bad, is written to llm_calls for the prompt inspector. */
  async chat<T>(req: ChatRequest, opts: RouteOptions<T>): Promise<RouteResult<T>> {
    const providers = this.chain(opts);
    if (providers.length === 0) throw new LlmError('bad_request', '没有可用的 LLM：请先在「模型」页添加并启用至少一个');
    const limit = this.repos.settings.get().dailyLlmCallLimit;
    if (req.purpose !== 'test' && limit > 0 && this.callsLastDay() >= limit) throw new LlmError('budget', `已达到 24 小时内 ${limit} 次 LLM 调用的上限`);

    const errors: string[] = [];
    for (const provider of providers) {
      const breaker = this.breakers.get(provider.id);
      if (!opts.onlyProviderId && breaker && breaker.openUntil > this.clock.now()) {
        errors.push(`${provider.name}: 熔断中`);
        continue;
      }
      if (provider.dailyTokenLimit !== null && provider.dailyTokenLimit > 0 && this.tokensLastDay(provider.id) >= provider.dailyTokenLimit) {
        errors.push(`${provider.name}: 已超过每日 token 上限`);
        continue;
      }
      // Second attempt on the same provider only for unusable output; transport errors go straight to the next one.
      for (let attempt = 0; attempt < 2; attempt++) {
        const counted = req.purpose !== 'test';
        if (counted && limit > 0 && this.callsLastDay() + this.activeCalls >= limit) throw new LlmError('budget', `已达到 24 小时内 ${limit} 次 LLM 调用的上限`);
        if (counted) this.activeCalls++;
        const started = this.clock.now();
        const wallStart = Date.now();
        const request: ChatRequest = attempt === 0 ? req : { ...req, user: `${req.user}\n\n上一次输出不是合法的 JSON。只输出一个符合格式的 JSON 对象。` };
        let recorded = false;
        try {
          const client = await this.client(provider);
          const result = await client.chat(request);
          let value: T;
          try {
            value = opts.parse(extractJson(result.text));
          } catch (parseErr) {
            this.record(request, provider, opts.conversationId ?? null, started, result, `bad_output: ${errMessage(parseErr)}`);
            recorded = true;
            throw new LlmError('bad_output', errMessage(parseErr));
          }
          const llmCallId = this.record(request, provider, opts.conversationId ?? null, started, result, '');
          this.breakers.delete(provider.id);
          return { value, provider, llmCallId, latencyMs: Date.now() - wallStart };
        } catch (err) {
          const e = err instanceof LlmError ? err : new LlmError('network', errMessage(err));
          if (!recorded) this.record(request, provider, opts.conversationId ?? null, started, null, `${e.kind}: ${e.message}`);
          this.log.warn({ provider: provider.name, kind: e.kind, attempt }, 'llm call failed');
          if (e.kind === 'bad_output' && attempt === 0) continue;
          this.trip(provider, e.kind);
          errors.push(`${provider.name}: ${e.kind} ${e.message}`);
          break;
        } finally {
          if (counted) this.activeCalls--;
        }
      }
    }
    throw new LlmError('server', `所有 LLM 都失败了：${errors.join('；')}`);
  }
}
