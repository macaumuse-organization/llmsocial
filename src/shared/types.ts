// Types shared by the server and the web UI. Keep this file free of Node/DOM imports.

export type PlatformId = 'wechat' | 'xiaohongshu' | 'douyin' | 'x' | 'instagram' | 'youtube' | 'sandbox' | 'other';
export type ConnectorKind = 'sandbox' | 'manual' | 'webhook' | 'youtube' | 'x' | 'instagram' | 'wechat_oa' | 'wecom_kf';
export type Mode = 'copilot' | 'autopilot';
export type ConversationKind = 'dm' | 'comment';
export type ConversationState = 'active' | 'paused' | 'handoff' | 'opted_out' | 'closed';
export type Stage = 'new' | 'engaged' | 'interested' | 'offer_made' | 'converted' | 'declined';
export type MessageDirection = 'in' | 'out';
export type MessageAuthor = 'contact' | 'ai' | 'operator' | 'external';
export type MessageStatus =
  | 'received'
  | 'pending_approval'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'rejected'
  | 'superseded'
  | 'cancelled';
export type GoalType = 'rapport' | 'recommend_product' | 'share_content' | 'schedule_meeting' | 'support' | 'custom';
export type ProviderKind = 'anthropic' | 'openai_compat' | 'gemini' | 'mock';
export type AccountStatus = 'active' | 'paused' | 'error' | 'needs_auth';
export type RiskFlag =
  | 'payment'
  | 'verification_code'
  | 'credentials'
  | 'personal_id'
  | 'contract'
  | 'legal'
  | 'self_harm'
  | 'minor'
  | 'harassment';

export const STAGES: Stage[] = ['new', 'engaged', 'interested', 'offer_made', 'converted', 'declined'];

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  /** 'secret:<name>' | 'keychain:<service>[:<account>]' | 'env:<VAR>' | '' — never the raw key. */
  apiKeyRef: string;
  hasApiKey: boolean;
  temperature: number | null;
  maxTokens: number;
  /** Anthropic only: output_config.effort. */
  effort: 'low' | 'medium' | 'high' | null;
  jsonMode: boolean;
  timeoutMs: number;
  /** USD per million tokens; used only for the cost estimate shown in the UI. */
  priceIn: number | null;
  priceOut: number | null;
  dailyTokenLimit: number | null;
  enabled: boolean;
  priority: number;
  createdAt: number;
  updatedAt: number;
}

export interface Persona {
  id: string;
  name: string;
  /** Who the digital human is and whom it represents. */
  identity: string;
  style: string;
  /** Sent with the first automated message of a conversation. Must state that an AI is writing. */
  disclosure: string;
  /** Appended to every automated public comment reply. */
  commentSignature: string;
  createdAt: number;
  updatedAt: number;
}

export interface Skill {
  id: string;
  slug: string;
  name: string;
  description: string;
  content: string;
  /** Empty = every platform. */
  allowedPlatforms: PlatformId[];
  enabled: boolean;
  builtin: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Material {
  id: string;
  title: string;
  url: string;
  /** One line the AI may use to introduce it. It must not claim more than this says. */
  description: string;
  /** Interests this suits, matched against Contact.tags. */
  tags: string[];
}

export interface Campaign {
  id: string;
  name: string;
  goalType: GoalType;
  goal: string;
  successCriteria: string;
  /** The only product facts the AI may state. */
  facts: string;
  allowedLinks: string[];
  /** Also whitelisted for sending. At most one goes out per turn, and never the same one twice. */
  materials: Material[];
  /** What to say instead of a link on platforms that block links. */
  linkFallback: string;
  /** Empty = every platform. */
  allowedPlatforms: PlatformId[];
  skillIds: string[];
  personaId: string | null;
  /** Ordered fallback chain. Empty = all enabled providers by priority. */
  providerIds: string[];
  mode: Mode;
  maxDays: number;
  maxTurns: number;
  replyDelayMinS: number;
  replyDelayMaxS: number;
  followupEnabled: boolean;
  followupAfterH: number;
  followupMax: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Account {
  id: string;
  name: string;
  platform: PlatformId;
  connector: ConnectorKind;
  config: Record<string, string>;
  /** field -> whether a secret is configured. Values are never sent to the browser. */
  secretsSet: Record<string, boolean>;
  personaId: string | null;
  defaultCampaignId: string | null;
  status: AccountStatus;
  statusDetail: string;
  quietStart: string;
  quietEnd: string;
  timezone: string;
  maxPerHour: number;
  maxPerDay: number;
  maxPerContactDay: number;
  pollIntervalS: number;
  /** 0 = off. Separate from pollIntervalS: lead endpoints are metered far more tightly than message ones. */
  signalIntervalS: number;
  lastPolledAt: number | null;
  /** Last webhook that passed its signature check — including the platform's own URL verification. */
  lastWebhookAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Contact {
  id: string;
  accountId: string;
  platformUserId: string;
  displayName: string;
  handle: string;
  avatarUrl: string;
  language: string;
  notes: string;
  tags: string[];
  facts: string[];
  summary: string;
  optedOut: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Analysis {
  intent: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  stage: Stage;
  goalProgress: number;
  optOut: boolean;
  riskFlags: RiskFlag[];
  language: string;
  notes: string;
}

export interface Conversation {
  id: string;
  accountId: string;
  contactId: string;
  campaignId: string | null;
  kind: ConversationKind;
  threadRef: string;
  title: string;
  modeOverride: Mode | null;
  state: ConversationState;
  stateReason: string;
  stage: Stage;
  goalProgress: number;
  lastAnalysis: Analysis | null;
  unread: number;
  aiTurns: number;
  followupsSent: number;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  lastMessageAt: number | null;
  deadlineAt: number | null;
  /** When the AI-identity notice last went out in this conversation. */
  disclosedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationListItem extends Conversation {
  accountName: string;
  platform: PlatformId;
  connector: ConnectorKind;
  contactName: string;
  contactHandle: string;
  campaignName: string | null;
  effectiveMode: Mode;
  lastText: string;
  lastDirection: MessageDirection | null;
  pendingDrafts: number;
  failedMessages: number;
}

export interface Message {
  id: string;
  conversationId: string;
  accountId: string;
  direction: MessageDirection;
  author: MessageAuthor;
  text: string;
  platformMsgId: string | null;
  replyToRef: string | null;
  status: MessageStatus;
  /** 'disclosure' = the AI-identity notice; 'optout_ack' = the one confirmation sent after an opt-out. */
  kind: 'text' | 'disclosure' | 'optout_ack';
  /** A human approved or wrote this message. */
  approved: boolean;
  /** Why an autopilot message was held for human review. */
  reviewReason: string;
  sendAt: number | null;
  sentAt: number | null;
  error: string;
  attempts: number;
  llmCallId: string | null;
  batchId: string | null;
  seq: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationDetail {
  conversation: ConversationListItem;
  contact: Contact;
  messages: Message[];
  canSend: boolean;
}

export interface LlmCall {
  id: string;
  conversationId: string | null;
  purpose: string;
  providerId: string | null;
  providerName: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  ok: boolean;
  error: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  latencyMs: number;
  costUsd: number | null;
  createdAt: number;
}

export interface EventRow {
  id: number;
  ts: number;
  type: string;
  level: 'info' | 'warn' | 'error';
  accountId: string | null;
  conversationId: string | null;
  messageId: string | null;
  data: Record<string, unknown>;
}

export interface SimPersona {
  name: string;
  description: string;
  language: string;
}

export interface JudgeReport {
  goalAchieved: boolean;
  score: number;
  naturalness: number;
  pushiness: number;
  honestyViolations: string[];
  /** 0-10: did the shared material fit, and was the timing natural. Nothing shared = 10. */
  materialFit: number;
  summary: string;
  suggestions: string[];
}

export interface SimRun {
  id: string;
  campaignId: string;
  agentProviderId: string | null;
  contactProviderId: string | null;
  persona: SimPersona;
  maxTurns: number;
  status: 'running' | 'done' | 'failed';
  conversationId: string | null;
  report: JudgeReport | null;
  error: string;
  createdAt: number;
  updatedAt: number;
}

export interface Settings {
  /** Global kill switch: nothing is sent automatically while true. */
  autopilotPaused: boolean;
  /** Wait this long after the last inbound message before replying, so bursts are answered once. */
  debounceMs: number;
  /** Operator typing a manual reply switches that conversation to copilot. */
  pauseOnOperatorReply: boolean;
  /** Send one short confirmation when someone opts out (autopilot only). */
  optOutAck: boolean;
  maxContextMessages: number;
  summarizeEvery: number;
  dailyLlmCallLimit: number;
  /** 0 = keep forever. */
  retentionDays: number;
  ocrEngine: 'auto' | 'vision' | 'off';
  /** Send outbound requests through proxyUrl. Switchable at runtime; no restart. */
  proxyEnabled: boolean;
  /** e.g. http://127.0.0.1:18081 — the Windows system proxy address, which Node does not pick up by itself. */
  proxyUrl: string;
  /** Comma-separated hosts that always go straight out: this machine and domestic services. */
  noProxy: string;
}

export interface FieldSpec {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

export interface ConnectorMeta {
  kind: ConnectorKind;
  label: string;
  description: string;
  platforms: PlatformId[];
  canSend: boolean;
  canPoll: boolean;
  /** Reports leads (follows, subscribes, mentions). Read-only; it does not imply any outbound ability. */
  canSignals: boolean;
  usesWebhook: boolean;
  oauth: 'google' | 'x' | null;
  /** Not exercised against the live API in this build. */
  untestedLive: boolean;
  fields: FieldSpec[];
  setupNotes: string;
}

export interface PlatformProfile {
  id: PlatformId;
  label: string;
  region: 'cn' | 'global' | 'test';
  maxLen: { dm: number; comment: number };
  links: { dm: 'ok' | 'discouraged' | 'blocked'; comment: 'ok' | 'discouraged' | 'blocked' };
  /** CJK characters count double (X/Twitter). */
  cjkDoubleWidth: boolean;
  hint: string;
}

export interface ProviderPreset {
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  keyHint: string;
}

export type SignalKind = 'follow' | 'subscribe' | 'mention' | 'enter_session' | 'manual';
export type SignalStatus = 'new' | 'contacted' | 'ignored';

/**
 * Something the other person did first — followed, subscribed, @-mentioned, opened a chat window.
 * Read-only: a signal never starts a conversation by itself. An operator opens one by hand, one
 * person at a time, and the opener that follows is always a draft (pipeline forces copilot).
 */
export interface Signal {
  id: string;
  accountId: string;
  kind: SignalKind;
  platformUserId: string;
  displayName: string;
  handle: string;
  avatarUrl: string;
  /** Mention text, or the operator's note on a manually added lead. */
  text: string;
  /** Platform-side idempotency key: media id, event id, subscription timestamp… */
  ref: string;
  status: SignalStatus;
  conversationId: string | null;
  ts: number;
  createdAt: number;
  updatedAt: number;
}

export interface SignalListItem extends Signal {
  accountName: string;
  platform: PlatformId;
  connector: ConnectorKind;
}

export const SIGNAL_KIND_LABELS: Record<SignalKind, string> = {
  follow: '关注了你',
  subscribe: '订阅了你',
  mention: '提到了你',
  enter_session: '打开了聊天窗口',
  manual: '手动录入',
};

export interface NetworkTestResult {
  name: string;
  ok: boolean;
  ms: number;
  /** Why it could not connect, in words, with the network error code in brackets; '' when ok. */
  error: string;
}

export interface Meta {
  version: string;
  platforms: PlatformProfile[];
  connectors: ConnectorMeta[];
  providerPresets: ProviderPreset[];
  goalTypes: { id: GoalType; label: string; hint: string }[];
  simPersonas: SimPersona[];
  webhookBaseUrl: string;
  ocrAvailable: boolean;
  /** One line about this machine's OCR: which engine, or what to install. Server-side so the UI stops guessing per platform. */
  ocrHint: string;
  /** The WeChat bridge (share target for 微信 Windows 版) can be installed from this server: Windows only. */
  wechatBridgeSupported: boolean;
}

/** State of the Windows WeChat bridge as it relates to one account. */
export interface WechatBridgeStatus {
  supported: boolean;
  installed: boolean;
  version: string;
  /** Registered in WeChat's "选择电脑中的应用" menu from its current folder, at the current package version. */
  registered: boolean;
  /** Its settings point at this account on this llmsocial. */
  configured: boolean;
  autoDeliver: boolean;
  ready: boolean;
  /** One line for the operator: where things stand, or the next thing to click. */
  detail: string;
  installDir: string;
}

export interface WechatBridgeInstallResult {
  log: string[];
  status: WechatBridgeStatus;
}

export interface FunnelRow {
  campaignId: string | null;
  campaignName: string;
  total: number;
  byStage: Record<Stage, number>;
  optedOut: number;
  handoff: number;
}

export interface Stats {
  conversations: { total: number; active: number; handoff: number; optedOut: number; needsAction: number };
  messages: { day: string; inbound: number; outbound: number }[];
  funnel: FunnelRow[];
  llm: { providerName: string; model: string; calls: number; failures: number; inputTokens: number; outputTokens: number; costUsd: number; avgLatencyMs: number }[];
  llmCallsToday: number;
  medianReplySeconds: number | null;
  materials: { campaignId: string; campaignName: string; materialId: string; title: string; shares: number }[];
  accounts: { id: string; name: string; platform: PlatformId; status: AccountStatus; statusDetail: string; sentToday: number; maxPerDay: number; lastInboundAt: number | null; lastSentAt: number | null }[];
}

export interface OcrLine {
  text: string;
  /** Normalised 0..1, origin top-left. */
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

export interface ParsedChatMessage {
  side: 'contact' | 'me';
  text: string;
}

export interface CompareCandidate {
  providerId: string;
  providerName: string;
  model: string;
  ok: boolean;
  error: string;
  messages: string[];
  analysis: Analysis | null;
  latencyMs: number;
  llmCallId: string | null;
}

export type StreamEvent =
  | { type: 'conversation'; conversationId: string }
  | { type: 'account'; accountId: string }
  | { type: 'sim'; runId: string }
  | { type: 'signal'; accountId: string }
  | { type: 'settings' }
  | { type: 'ping' };
