import type { ConnectorMeta, ConversationKind, SignalKind } from '../../shared/types.ts';
import type { AccountRow } from '../db/repos.ts';
import type { Logger } from '../util.ts';

export interface InboundMessage {
  /** Platform-side id. Used for de-duplication, so it must be stable across polls and webhook retries. */
  platformMsgId: string;
  kind: ConversationKind;
  /** DM conversation id or comment thread id. */
  threadRef: string;
  threadTitle?: string;
  contact: { platformUserId: string; displayName?: string; handle?: string; avatarUrl?: string };
  text: string;
  /** Epoch ms, as reported by the platform. */
  timestamp: number;
  /** Written by the account itself outside llmsocial (the owner replied from their phone). */
  fromSelf?: boolean;
  /** What a reply should attach to (comment id, tweet id). */
  replyToRef?: string;
}

export interface SendRequest {
  kind: ConversationKind;
  threadRef: string;
  contactPlatformUserId: string;
  text: string;
  replyToRef: string | null;
}

export interface SendResult {
  platformMsgId?: string;
}

export type ConnectorErrorCode = 'auth' | 'rate_limited' | 'window_closed' | 'blocked' | 'transient' | 'invalid' | 'unsupported';

export class ConnectorError extends Error {
  code: ConnectorErrorCode;
  retryAfterMs: number | null;
  constructor(code: ConnectorErrorCode, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ConnectorContext {
  account: AccountRow;
  config: Record<string, string>;
  getSecret(field: string): Promise<string | null>;
  /** Persists a rotated token (OAuth refresh) encrypted; never logs it. */
  setSecret(field: string, value: string): void;
  getCursor(): Record<string, unknown>;
  setCursor(cursor: Record<string, unknown>): void;
  now(): number;
  log: Logger;
  fetch: typeof fetch;
  /**
   * Tell the operator about a degraded-but-working state (a permission the plan lacks, a feature the
   * platform switched off). Lands on the account card and in the event log — a log line alone is
   * something nobody reads.
   */
  notice(text: string): void;
}

export interface WebhookRequest {
  method: 'GET' | 'POST';
  query: Record<string, string>;
  headers: Record<string, string>;
  rawBody: Buffer;
}

export interface WebhookResponse {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * Something the other person did that is not a message: followed, subscribed, @-mentioned, opened
 * a chat window. Inbound and read-only — collecting these never touches the other account.
 */
export interface InboundSignal {
  kind: SignalKind;
  platformUserId: string;
  displayName?: string;
  handle?: string;
  avatarUrl?: string;
  text?: string;
  /** Stable per platform event, so re-polling and webhook retries do not duplicate the lead. */
  ref: string;
  timestamp: number;
}

export interface Connector {
  meta: ConnectorMeta;
  test(ctx: ConnectorContext): Promise<{ ok: boolean; detail: string }>;
  poll?(ctx: ConnectorContext): Promise<InboundMessage[]>;
  /** Read-only. Never sends, never follows back — it only reports what already happened. */
  pollSignals?(ctx: ConnectorContext): Promise<InboundSignal[]>;
  send?(ctx: ConnectorContext, req: SendRequest): Promise<SendResult>;
  /** Must verify the platform's signature before trusting anything in the body. */
  handleWebhook?(ctx: ConnectorContext, req: WebhookRequest): Promise<{ response: WebhookResponse; messages: InboundMessage[]; signals?: InboundSignal[] }>;
}

/** fetch + JSON with the error mapping every REST connector needs. */
export async function apiJson<T>(ctx: ConnectorContext, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  let res: Response;
  try {
    res = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 20_000) });
  } catch (err) {
    throw new ConnectorError('transient', `network: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  if (res.ok) {
    try {
      return (text === '' ? {} : JSON.parse(text)) as T;
    } catch {
      throw new ConnectorError('transient', 'platform returned non-JSON');
    }
  }
  const detail = text.slice(0, 300);
  if (res.status === 401) throw new ConnectorError('auth', `401 ${detail}`);
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const reset = Number(res.headers.get('x-rate-limit-reset'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - ctx.now()) : null;
    throw new ConnectorError('rate_limited', `429 ${detail}`, wait);
  }
  if (res.status >= 500) throw new ConnectorError('transient', `${res.status} ${detail}`);
  if (res.status === 403) throw new ConnectorError('blocked', `403 ${detail}`);
  throw new ConnectorError('invalid', `${res.status} ${detail}`);
}
