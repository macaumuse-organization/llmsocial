import type { z } from 'zod';
import type { Provider } from '../../shared/types.ts';

export type LlmPurpose = 'reply' | 'summary' | 'sim_contact' | 'judge' | 'test' | 'compare';

export interface ChatRequest {
  purpose: LlmPurpose;
  /** Stable across conversations of one campaign. Comes first so providers can cache it. */
  systemStatic: string;
  /** Changes per conversation/turn. Comes after the cached prefix. */
  systemDynamic: string;
  user: string;
  /** When set, the model must answer with JSON matching this schema. */
  schema?: z.ZodType;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export type LlmErrorKind =
  | 'auth'
  | 'rate_limited'
  | 'refusal'
  | 'timeout'
  | 'truncated'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'bad_output'
  | 'budget';

export class LlmError extends Error {
  kind: LlmErrorKind;
  constructor(kind: LlmErrorKind, message: string) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
  }
}

export interface LlmClient {
  chat(req: ChatRequest): Promise<ChatResult>;
}

export interface ProviderRuntime {
  provider: Provider;
  apiKey: string | null;
}

export type LlmClientFactory = (rt: ProviderRuntime) => LlmClient;
