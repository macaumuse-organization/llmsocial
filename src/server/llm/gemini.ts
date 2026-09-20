import { LlmError, type ChatRequest, type LlmClient, type ProviderRuntime } from './types.ts';
import { httpError, postJson } from './http.ts';

interface GenerateContentResponse {
  candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
  modelVersion?: string;
  error?: { message?: string };
}

const BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION']);

export function createGeminiClient(rt: ProviderRuntime): LlmClient {
  const { provider } = rt;
  const base = (provider.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const url = `${base}/v1beta/models/${encodeURIComponent(provider.model)}:generateContent`;

  return {
    async chat(req: ChatRequest) {
      const generationConfig: Record<string, unknown> = { maxOutputTokens: provider.maxTokens };
      if (provider.temperature !== null) generationConfig.temperature = provider.temperature;
      if (provider.jsonMode && req.schema) generationConfig.responseMimeType = 'application/json';
      const body = {
        systemInstruction: { parts: [{ text: req.systemDynamic ? `${req.systemStatic}\n\n${req.systemDynamic}` : req.systemStatic }] },
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        generationConfig,
      };
      // The key goes in a header, not the query string, so it can't end up in proxy or access logs.
      const res = await postJson(url, rt.apiKey ? { 'x-goog-api-key': rt.apiKey } : {}, body, provider.timeoutMs, req.signal);
      const data = (res.json ?? {}) as GenerateContentResponse;
      if (res.status < 200 || res.status >= 300) throw httpError(res.status, data.error?.message ?? res.text);
      if (data.promptFeedback?.blockReason) throw new LlmError('refusal', `prompt blocked: ${data.promptFeedback.blockReason}`);
      const candidate = data.candidates?.[0];
      if (!candidate) throw new LlmError('bad_output', 'response has no candidates');
      if (candidate.finishReason && BLOCKED.has(candidate.finishReason)) throw new LlmError('refusal', `blocked: ${candidate.finishReason}`);
      if (candidate.finishReason === 'MAX_TOKENS') throw new LlmError('truncated', 'output hit maxOutputTokens');
      const usage = data.usageMetadata ?? {};
      return {
        text: (candidate.content?.parts ?? []).map((p) => p.text ?? '').join(''),
        model: data.modelVersion ?? provider.model,
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
        cacheReadTokens: usage.cachedContentTokenCount ?? 0,
      };
    },
  };
}
