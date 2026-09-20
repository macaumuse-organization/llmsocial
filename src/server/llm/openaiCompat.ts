import { LlmError, type ChatRequest, type ChatResult, type LlmClient, type ProviderRuntime } from './types.ts';
import { httpError, postJson } from './http.ts';

interface Completion {
  model?: string;
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string };
}

// One wire format, many vendors (OpenAI, DeepSeek, DashScope, Moonshot, Zhipu, OpenRouter, Ollama, LM Studio…).
// They disagree on three parameters, so a 400 that names one of them makes the client drop it and retry.
export function createOpenAiCompatClient(rt: ProviderRuntime): LlmClient {
  const { provider } = rt;
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const quirks = { tokenParam: 'max_tokens' as 'max_tokens' | 'max_completion_tokens', temperature: true, jsonMode: provider.jsonMode };

  async function once(req: ChatRequest): Promise<ChatResult | { retry: true }> {
    const body: Record<string, unknown> = {
      model: provider.model,
      messages: [
        { role: 'system', content: req.systemDynamic ? `${req.systemStatic}\n\n${req.systemDynamic}` : req.systemStatic },
        { role: 'user', content: req.user },
      ],
      [quirks.tokenParam]: provider.maxTokens,
    };
    if (quirks.temperature && provider.temperature !== null) body.temperature = provider.temperature;
    if (quirks.jsonMode && req.schema) body.response_format = { type: 'json_object' };

    const headers: Record<string, string> = rt.apiKey ? { authorization: `Bearer ${rt.apiKey}` } : {};
    const res = await postJson(url, headers, body, provider.timeoutMs, req.signal);
    const data = (res.json ?? {}) as Completion;
    if (res.status === 400) {
      const detail = (data.error?.message ?? res.text).toLowerCase();
      if (quirks.tokenParam === 'max_tokens' && detail.includes('max_completion_tokens')) {
        quirks.tokenParam = 'max_completion_tokens';
        return { retry: true };
      }
      if (quirks.temperature && detail.includes('temperature')) {
        quirks.temperature = false;
        return { retry: true };
      }
      if (quirks.jsonMode && detail.includes('response_format')) {
        quirks.jsonMode = false;
        return { retry: true };
      }
    }
    if (res.status < 200 || res.status >= 300) throw httpError(res.status, data.error?.message ?? res.text);

    const choice = data.choices?.[0];
    if (!choice) throw new LlmError('bad_output', 'response has no choices');
    if (choice.finish_reason === 'content_filter' || choice.message?.refusal) throw new LlmError('refusal', choice.message?.refusal ?? 'content filtered');
    if (choice.finish_reason === 'length') throw new LlmError('truncated', 'output hit the token limit');
    return {
      text: choice.message?.content ?? '',
      model: data.model ?? provider.model,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    };
  }

  return {
    async chat(req) {
      for (let i = 0; i < 4; i++) {
        const out = await once(req);
        if (!('retry' in out)) return out;
      }
      throw new LlmError('bad_request', 'provider kept rejecting request parameters');
    },
  };
}
