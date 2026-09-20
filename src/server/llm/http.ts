import { LlmError } from './types.ts';

export interface HttpJsonResult {
  status: number;
  json: unknown;
  text: string;
}

/** POST JSON with a hard timeout. Network failures and timeouts become LlmError; HTTP errors are returned. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HttpJsonResult> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (err) {
    if (timeout.aborted) throw new LlmError('timeout', `no response within ${timeoutMs} ms`);
    throw new LlmError('network', err instanceof Error ? err.message : String(err));
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON error page; callers only look at status and text.
  }
  return { status: res.status, json, text };
}

export function httpError(status: number, detail: string): LlmError {
  const msg = `HTTP ${status}: ${detail.slice(0, 300)}`;
  if (status === 401 || status === 403) return new LlmError('auth', msg);
  if (status === 429) return new LlmError('rate_limited', msg);
  if (status >= 500) return new LlmError('server', msg);
  return new LlmError('bad_request', msg);
}
