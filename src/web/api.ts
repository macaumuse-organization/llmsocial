import type { WechatBridgeInstallResult, WechatBridgeStatus } from '../shared/types.ts';
import type {
  Account,
  Campaign,
  CompareCandidate,
  Contact,
  ConversationDetail,
  ConversationListItem,
  EventRow,
  LlmCall,
  Meta,
  NetworkTestResult,
  OcrLine,
  ParsedChatMessage,
  Persona,
  Provider,
  Settings,
  SignalListItem,
  SimRun,
  Skill,
  Stats,
} from '../shared/types.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      // The server rejects mutations without this header: it is unsettable cross-origin without a
      // CORS preflight, which this server never answers.
      headers: { 'X-LLMSocial': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, '连不上本地服务，确认 llmsocial 还在运行');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  const data = contentType.includes('json') && text !== '' ? (JSON.parse(text) as unknown) : text;
  if (!res.ok) {
    const message = typeof data === 'object' && data !== null && 'error' in data ? String((data as { error: unknown }).error) : `请求失败（${res.status}）`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body);
const del = (path: string) => request<{ ok: true }>('DELETE', path);

const query = (params: Record<string, string | number | boolean | undefined>) => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') search.set(k, String(v));
  const s = search.toString();
  return s ? `?${s}` : '';
};

export interface AuthState {
  setupRequired: boolean;
  authenticated: boolean;
}
export interface TestResult {
  ok: boolean;
  detail: string;
}
export interface LlmCallSummary extends Omit<LlmCall, 'systemPrompt' | 'userPrompt' | 'rawResponse'> {
  promptChars: number;
  responseChars: number;
}
export interface ConversationFilters {
  state?: string;
  accountId?: string;
  needsAction?: boolean;
  q?: string;
}

export const api = {
  authState: () => get<AuthState>('/api/auth/state'),
  setup: (password: string) => post<{ ok: true }>('/api/auth/setup', { password }),
  login: (password: string) => post<{ ok: true }>('/api/auth/login', { password }),
  logout: () => post<{ ok: true }>('/api/auth/logout'),

  meta: () => get<Meta>('/api/meta'),
  settings: () => get<Settings>('/api/settings'),
  networkTest: () => post<NetworkTestResult[]>('/api/settings/network-test', {}),
  saveSettings: (patchBody: Partial<Settings>) => patch<Settings>('/api/settings', patchBody),
  stats: () => get<Stats>('/api/stats'),
  events: (params: { conversationId?: string; accountId?: string; level?: string; limit?: number } = {}) => get<EventRow[]>(`/api/events${query(params)}`),

  providers: () => get<Provider[]>('/api/providers'),
  createProvider: (body: unknown) => post<Provider>('/api/providers', body),
  updateProvider: (id: string, body: unknown) => patch<Provider>(`/api/providers/${id}`, body),
  deleteProvider: (id: string) => del(`/api/providers/${id}`),
  testProvider: (id: string) => post<TestResult>(`/api/providers/${id}/test`),

  personas: () => get<Persona[]>('/api/personas'),
  createPersona: (body: unknown) => post<Persona>('/api/personas', body),
  updatePersona: (id: string, body: unknown) => patch<Persona>(`/api/personas/${id}`, body),
  deletePersona: (id: string) => del(`/api/personas/${id}`),

  skills: () => get<Skill[]>('/api/skills'),
  createSkill: (body: unknown) => post<Skill>('/api/skills', body),
  updateSkill: (id: string, body: unknown) => patch<Skill>(`/api/skills/${id}`, body),
  deleteSkill: (id: string) => del(`/api/skills/${id}`),
  importSkill: (markdown: string) => post<Skill>('/api/skills/import', { markdown }),
  exportSkillUrl: (id: string) => `/api/skills/${id}/export`,

  campaigns: () => get<Campaign[]>('/api/campaigns'),
  createCampaign: (body: unknown) => post<Campaign>('/api/campaigns', body),
  updateCampaign: (id: string, body: unknown) => patch<Campaign>(`/api/campaigns/${id}`, body),
  deleteCampaign: (id: string) => del(`/api/campaigns/${id}`),

  accounts: () => get<Account[]>('/api/accounts'),
  createAccount: (body: unknown) => post<Account>('/api/accounts', body),
  updateAccount: (id: string, body: unknown) => patch<Account>(`/api/accounts/${id}`, body),
  deleteAccount: (id: string) => del(`/api/accounts/${id}`),
  testAccount: (id: string) => post<TestResult>(`/api/accounts/${id}/test`),
  pollAccount: (id: string) => post<{ ok: true }>(`/api/accounts/${id}/poll`),
  oauthStart: (id: string) => post<{ url: string; redirectUri: string }>(`/api/accounts/${id}/oauth/start`),
  bridgeStatus: (id: string) => get<WechatBridgeStatus>(`/api/accounts/${id}/bridge`),
  bridgeInstall: (id: string, force: boolean) => post<WechatBridgeInstallResult>(`/api/accounts/${id}/bridge/install`, { force }),

  conversations: (filters: ConversationFilters = {}) => get<ConversationListItem[]>(`/api/conversations${query({ ...filters, needsAction: filters.needsAction ? '1' : undefined })}`),
  conversation: (id: string) => get<ConversationDetail>(`/api/conversations/${id}`),
  updateConversation: (id: string, body: unknown) => patch<ConversationDetail>(`/api/conversations/${id}`, body),
  createConversation: (body: unknown) => post<ConversationDetail>('/api/conversations', body),
  signals: (f: { status?: string; accountId?: string } = {}) => get<SignalListItem[]>(`/api/signals${query(f)}`),
  createSignal: (body: unknown) => post<SignalListItem>('/api/signals', body),
  updateSignal: (id: string, status: 'new' | 'ignored') => patch<SignalListItem>(`/api/signals/${id}`, { status }),
  openSignal: (id: string) => post<ConversationDetail>(`/api/signals/${id}/open`, {}),
  sendMessage: (id: string, text: string) => post<ConversationDetail>(`/api/conversations/${id}/send`, { text }),
  generate: (id: string, body: { trigger?: string; operatorHint?: string; providerId?: string } = {}) => post<ConversationDetail>(`/api/conversations/${id}/generate`, body),
  compare: (id: string, providerIds: string[], operatorHint: string) => post<CompareCandidate[]>(`/api/conversations/${id}/compare`, { providerIds, operatorHint }),
  adopt: (id: string, texts: string[], llmCallId: string | null) => post<ConversationDetail>(`/api/conversations/${id}/adopt`, { texts, llmCallId }),
  llmCalls: (conversationId: string) => get<LlmCallSummary[]>(`/api/conversations/${conversationId}/llm-calls`),
  llmCall: (id: string) => get<LlmCall>(`/api/llm-calls/${id}`),

  approve: (messageId: string, text?: string) => post<ConversationDetail>(`/api/messages/${messageId}/approve`, text === undefined ? {} : { text }),
  markSent: (messageId: string, text?: string) => post<ConversationDetail>(`/api/messages/${messageId}/mark-sent`, text === undefined ? {} : { text }),
  discard: (messageId: string) => post<ConversationDetail>(`/api/messages/${messageId}/discard`),
  retry: (messageId: string) => post<ConversationDetail>(`/api/messages/${messageId}/retry`),

  contacts: (q = '') => get<Contact[]>(`/api/contacts${query({ q })}`),
  updateContact: (id: string, body: unknown) => patch<Contact>(`/api/contacts/${id}`, body),

  ocr: (image: string) => post<{ lines: OcrLine[]; messages: ParsedChatMessage[] }>('/api/import/ocr', { image }),
  importMessages: (body: unknown) => post<ConversationDetail>('/api/import/messages', body),

  simRuns: () => get<SimRun[]>('/api/sim'),
  simRun: (id: string) => get<{ run: SimRun; messages: ConversationDetail['messages'] }>(`/api/sim/${id}`),
  startSim: (body: unknown) => post<SimRun>('/api/sim', body),
};
