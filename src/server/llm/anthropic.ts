import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { LlmError, type ChatRequest, type ChatResult, type LlmClient, type ProviderRuntime } from './types.ts';

// output_config.effort is rejected by Haiku 4.5 / Sonnet 4.5 and older.
function supportsEffort(model: string): boolean {
  return /^claude-(fable|mythos|opus-5|sonnet-5|opus-4-[5-9]|sonnet-4-[6-9])/.test(model);
}

// Safety classifiers on these models can decline with stop_reason "refusal"; the server-side
// fallback re-runs the request on Anthropic's recommended substitute inside the same call.
function wantsServerFallback(model: string, baseUrl: string): boolean {
  return baseUrl === '' && /^claude-(opus-5|fable-5)/.test(model);
}

function mapError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new LlmError('auth', err.message);
  if (err instanceof Anthropic.RateLimitError) return new LlmError('rate_limited', err.message);
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) return new LlmError('bad_request', err.message);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmError('timeout', err.message);
  if (err instanceof Anthropic.APIConnectionError) return new LlmError('network', err.message);
  if (err instanceof Anthropic.APIError) return new LlmError('server', err.message);
  return new LlmError('network', err instanceof Error ? err.message : String(err));
}

export function createAnthropicClient(rt: ProviderRuntime): LlmClient {
  const { provider } = rt;
  // With no key configured the SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile itself.
  const client = new Anthropic({
    ...(rt.apiKey ? { apiKey: rt.apiKey } : {}),
    ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
    timeout: provider.timeoutMs,
    maxRetries: 1,
  });
  // Flipped off after a 400 so a proxy or older model without structured outputs still works from the prompt alone.
  let structured = true;

  async function once(req: ChatRequest): Promise<ChatResult> {
    const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: req.systemStatic, cache_control: { type: 'ephemeral' } }];
    if (req.systemDynamic) system.push({ type: 'text', text: req.systemDynamic });
    const effort = provider.effort && supportsEffort(provider.model) ? { effort: provider.effort } : {};
    const useFormat = structured && req.schema !== undefined;
    const base = {
      model: provider.model,
      max_tokens: provider.maxTokens,
      system,
      messages: [{ role: 'user' as const, content: req.user }],
    };
    // Sampling parameters are deliberately never sent: Opus 5 / Sonnet 5 / Fable reject them with a 400.
    const response = wantsServerFallback(provider.model, provider.baseUrl)
      ? await client.beta.messages.create(
          {
            ...base,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: { ...effort, ...(useFormat ? { format: betaZodOutputFormat(req.schema!) } : {}) },
          },
          { signal: req.signal },
        )
      : await client.messages.create(
          { ...base, output_config: { ...effort, ...(useFormat ? { format: zodOutputFormat(req.schema!) } : {}) } },
          { signal: req.signal },
        );

    if (response.stop_reason === 'refusal') throw new LlmError('refusal', 'model declined the request');
    if (response.stop_reason === 'max_tokens') throw new LlmError('truncated', 'output hit max_tokens');
    let text = '';
    for (const block of response.content) if (block.type === 'text') text += block.text;
    const usage = response.usage;
    return {
      text,
      model: response.model,
      inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    };
  }

  return {
    async chat(req) {
      try {
        return await once(req);
      } catch (err) {
        if (err instanceof Anthropic.BadRequestError && structured && req.schema) {
          structured = false;
          try {
            return await once(req);
          } catch (again) {
            throw mapError(again);
          }
        }
        throw mapError(err);
      }
    },
  };
}
