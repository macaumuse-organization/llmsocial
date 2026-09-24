import type {
  Account,
  Campaign,
  Contact,
  Conversation,
  ConversationKind,
  ConversationListItem,
  EventRow,
  LlmCall,
  Message,
  MessageStatus,
  Mode,
  Persona,
  Provider,
  Settings,
  Signal,
  SignalKind,
  SignalListItem,
  SignalStatus,
  SimRun,
  Skill,
} from '../../shared/types.ts';
import { DEFAULT_NO_PROXY } from '../proxy.ts';
import { newId, type Clock } from '../util.ts';
import { parseJson, type Db, type SqlParam } from './index.ts';

export const DEFAULT_SETTINGS: Settings = {
  autopilotPaused: false,
  debounceMs: 8000,
  pauseOnOperatorReply: true,
  optOutAck: true,
  maxContextMessages: 30,
  summarizeEvery: 40,
  dailyLlmCallLimit: 2000,
  retentionDays: 0,
  ocrEngine: 'auto',
  proxyEnabled: false,
  proxyUrl: '',
  noProxy: DEFAULT_NO_PROXY,
};

export const DEFAULT_PERSONA_ID = 'persona_default';

type Row = Record<string, unknown>;

function hydrate<T>(row: Row | undefined, json: Record<string, unknown>, bools: string[]): T | undefined {
  if (!row) return undefined;
  const out: Row = { ...row };
  for (const [key, fallback] of Object.entries(json)) out[key] = parseJson(out[key], fallback);
  for (const key of bools) out[key] = out[key] === 1;
  return out as T;
}

function dehydrate(patch: Record<string, unknown>): Record<string, SqlParam> {
  const out: Record<string, SqlParam> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = v !== null && typeof v === 'object' && !(v instanceof Uint8Array) ? JSON.stringify(v) : (v as SqlParam);
  }
  return out;
}

/** Internal account row: carries the secret references and connector cursor that never reach the browser. */
export interface AccountRow extends Omit<Account, 'secretsSet'> {
  secretRefs: Record<string, string>;
  cursor: Record<string, unknown>;
  failures: number;
}

export function toAccountDto(row: AccountRow): Account {
  const { secretRefs, cursor: _cursor, failures: _failures, ...rest } = row;
  return { ...rest, secretsSet: Object.fromEntries(Object.entries(secretRefs).map(([k, v]) => [k, v !== ''])) };
}

export interface ConversationFilter {
  state?: string;
  accountId?: string;
  needsAction?: boolean;
  q?: string;
  limit?: number;
}

export interface NewMessage {
  conversationId: string;
  accountId: string;
  direction: 'in' | 'out';
  author: Message['author'];
  text: string;
  status: MessageStatus;
  platformMsgId?: string | null;
  replyToRef?: string | null;
  reviewReason?: string;
  sendAt?: number | null;
  sentAt?: number | null;
  llmCallId?: string | null;
  batchId?: string | null;
  seq?: number;
  kind?: Message['kind'];
  approved?: boolean;
}

const CONVERSATION_SELECT = `
  SELECT c.*, a.name AS accountName, a.platform AS platform, a.connector AS connector,
    ct.displayName AS contactName, ct.handle AS contactHandle,
    cp.name AS campaignName, cp.mode AS campaignMode,
    (SELECT m.text FROM messages m WHERE m.conversationId = c.id AND m.status IN ('received', 'sent') ORDER BY m.rowid DESC LIMIT 1) AS lastText,
    (SELECT m.direction FROM messages m WHERE m.conversationId = c.id AND m.status IN ('received', 'sent') ORDER BY m.rowid DESC LIMIT 1) AS lastDirection,
    (SELECT COUNT(*) FROM messages m WHERE m.conversationId = c.id AND m.status = 'pending_approval') AS pendingDrafts,
    (SELECT COUNT(*) FROM messages m WHERE m.conversationId = c.id AND m.status = 'failed') AS failedMessages
  FROM conversations c
  JOIN accounts a ON a.id = c.accountId
  JOIN contacts ct ON ct.id = c.contactId
  LEFT JOIN campaigns cp ON cp.id = c.campaignId`;

export function createRepos(db: Db, clock: Clock) {
  const now = () => clock.now();

  const settings = {
    get(): Settings {
      const rows = db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
      const stored = Object.fromEntries(rows.map((r) => [r.key, parseJson<unknown>(r.value, undefined)]));
      return { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(stored).filter(([k, v]) => k in DEFAULT_SETTINGS && v !== undefined)) } as Settings;
    },
    getRaw(key: string): string | null {
      return db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
    },
    setRaw(key: string, value: string): void {
      db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
    },
    patch(patch: Partial<Settings>): Settings {
      for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS && v !== undefined) settings.setRaw(k, JSON.stringify(v));
      return settings.get();
    },
  };

  const providers = {
    list(): Provider[] {
      return db.all<Row>('SELECT * FROM providers ORDER BY priority, createdAt').map((r) => providers.map(r));
    },
    map(r: Row): Provider {
      const p = hydrate<Provider>(r, {}, ['jsonMode', 'enabled'])!;
      return { ...p, hasApiKey: p.apiKeyRef !== '' };
    },
    get(id: string): Provider | undefined {
      const r = db.get<Row>('SELECT * FROM providers WHERE id = ?', id);
      return r ? providers.map(r) : undefined;
    },
    create(input: Omit<Provider, 'id' | 'createdAt' | 'updatedAt' | 'hasApiKey'>, id = newId('prov')): Provider {
      db.insert('providers', dehydrate({ id, ...input, createdAt: now(), updatedAt: now() }));
      return providers.get(id)!;
    },
    update(id: string, patch: Partial<Provider>): Provider | undefined {
      const { id: _id, hasApiKey: _h, createdAt: _c, ...rest } = patch;
      db.update('providers', id, dehydrate({ ...rest, updatedAt: now() }));
      return providers.get(id);
    },
    delete(id: string): void {
      db.run('DELETE FROM providers WHERE id = ?', id);
    },
  };

  const personas = {
    list(): Persona[] {
      return db.all<Persona>('SELECT * FROM personas ORDER BY createdAt');
    },
    get(id: string): Persona | undefined {
      return db.get<Persona>('SELECT * FROM personas WHERE id = ?', id);
    },
    create(input: Omit<Persona, 'id' | 'createdAt' | 'updatedAt'>, id = newId('persona')): Persona {
      db.insert('personas', dehydrate({ id, ...input, createdAt: now(), updatedAt: now() }));
      return personas.get(id)!;
    },
    update(id: string, patch: Partial<Persona>): Persona | undefined {
      const { id: _id, createdAt: _c, ...rest } = patch;
      db.update('personas', id, dehydrate({ ...rest, updatedAt: now() }));
      return personas.get(id);
    },
    delete(id: string): void {
      db.run('DELETE FROM personas WHERE id = ?', id);
    },
  };

  const skills = {
    map: (r: Row) => hydrate<Skill>(r, { allowedPlatforms: [] }, ['enabled', 'builtin'])!,
    list(): Skill[] {
      return db.all<Row>('SELECT * FROM skills ORDER BY builtin DESC, name').map(skills.map);
    },
    get(id: string): Skill | undefined {
      const r = db.get<Row>('SELECT * FROM skills WHERE id = ?', id);
      return r ? skills.map(r) : undefined;
    },
    getBySlug(slug: string): Skill | undefined {
      const r = db.get<Row>('SELECT * FROM skills WHERE slug = ?', slug);
      return r ? skills.map(r) : undefined;
    },
    create(input: Omit<Skill, 'id' | 'createdAt' | 'updatedAt'>, id = newId('skill')): Skill {
      db.insert('skills', dehydrate({ id, ...input, createdAt: now(), updatedAt: now() }));
      return skills.get(id)!;
    },
    update(id: string, patch: Partial<Skill>): Skill | undefined {
      const { id: _id, createdAt: _c, ...rest } = patch;
      db.update('skills', id, dehydrate({ ...rest, updatedAt: now() }));
      return skills.get(id);
    },
    delete(id: string): void {
      db.run('DELETE FROM skills WHERE id = ?', id);
    },
  };

  const campaigns = {
    map: (r: Row) => hydrate<Campaign>(r, { allowedLinks: [], materials: [], allowedPlatforms: [], skillIds: [], providerIds: [] }, ['followupEnabled', 'enabled'])!,
    list(): Campaign[] {
      return db.all<Row>('SELECT * FROM campaigns ORDER BY createdAt').map(campaigns.map);
    },
    get(id: string): Campaign | undefined {
      const r = db.get<Row>('SELECT * FROM campaigns WHERE id = ?', id);
      return r ? campaigns.map(r) : undefined;
    },
    create(input: Omit<Campaign, 'id' | 'createdAt' | 'updatedAt'>, id = newId('camp')): Campaign {
      db.insert('campaigns', dehydrate({ id, ...input, createdAt: now(), updatedAt: now() }));
      return campaigns.get(id)!;
    },
    update(id: string, patch: Partial<Campaign>): Campaign | undefined {
      const { id: _id, createdAt: _c, ...rest } = patch;
      db.update('campaigns', id, dehydrate({ ...rest, updatedAt: now() }));
      return campaigns.get(id);
    },
    delete(id: string): void {
      db.run('DELETE FROM campaigns WHERE id = ?', id);
    },
  };

  const accounts = {
    map: (r: Row) => hydrate<AccountRow>(r, { config: {}, secretRefs: {}, cursor: {} }, [])!,
    list(): AccountRow[] {
      return db.all<Row>('SELECT * FROM accounts ORDER BY createdAt').map(accounts.map);
    },
    get(id: string): AccountRow | undefined {
      const r = db.get<Row>('SELECT * FROM accounts WHERE id = ?', id);
      return r ? accounts.map(r) : undefined;
    },
    create(input: Partial<AccountRow> & Pick<AccountRow, 'name' | 'platform' | 'connector'>, id = newId('acct')): AccountRow {
      db.insert('accounts', dehydrate({ id, ...input, createdAt: now(), updatedAt: now() }));
      return accounts.get(id)!;
    },
    update(id: string, patch: Partial<AccountRow>): AccountRow | undefined {
      const { id: _id, createdAt: _c, ...rest } = patch;
      db.update('accounts', id, dehydrate({ ...rest, updatedAt: now() }));
      return accounts.get(id);
    },
    delete(id: string): void {
      db.run('DELETE FROM accounts WHERE id = ?', id);
    },
  };

  const contacts = {
    map: (r: Row) => hydrate<Contact & { summarizedCount: number }>(r, { tags: [], facts: [] }, ['optedOut'])!,
    get(id: string) {
      const r = db.get<Row>('SELECT * FROM contacts WHERE id = ?', id);
      return r ? contacts.map(r) : undefined;
    },
    list(q: string, limit: number): Contact[] {
      const like = `%${q}%`;
      return db.all<Row>('SELECT * FROM contacts WHERE displayName LIKE ? OR handle LIKE ? OR platformUserId LIKE ? ORDER BY updatedAt DESC LIMIT ?', like, like, like, limit).map(contacts.map);
    },
    upsert(accountId: string, info: { platformUserId: string; displayName?: string; handle?: string; avatarUrl?: string }): Contact & { summarizedCount: number } {
      const existing = db.get<Row>('SELECT * FROM contacts WHERE accountId = ? AND platformUserId = ?', accountId, info.platformUserId);
      if (existing) {
        const patch: Record<string, SqlParam> = {};
        if (info.displayName && info.displayName !== existing.displayName) patch.displayName = info.displayName;
        if (info.handle && info.handle !== existing.handle) patch.handle = info.handle;
        if (info.avatarUrl && info.avatarUrl !== existing.avatarUrl) patch.avatarUrl = info.avatarUrl;
        if (Object.keys(patch).length > 0) db.update('contacts', existing.id as string, { ...patch, updatedAt: now() });
        return contacts.get(existing.id as string)!;
      }
      const id = newId('ct');
      db.insert('contacts', { id, accountId, platformUserId: info.platformUserId, displayName: info.displayName ?? '', handle: info.handle ?? '', avatarUrl: info.avatarUrl ?? '', createdAt: now(), updatedAt: now() });
      return contacts.get(id)!;
    },
    update(id: string, patch: Partial<Contact> & { summarizedCount?: number }) {
      const { id: _id, createdAt: _c, accountId: _a, platformUserId: _p, ...rest } = patch;
      db.update('contacts', id, dehydrate({ ...rest, updatedAt: now() }));
      return contacts.get(id);
    },
    delete(id: string): void {
      db.run('DELETE FROM contacts WHERE id = ?', id);
    },
  };

  const suppressions = {
    add(platform: string, platformUserId: string, reason: string): void {
      db.run('INSERT OR IGNORE INTO suppressions (platform, platformUserId, reason, createdAt) VALUES (?, ?, ?, ?)', platform, platformUserId, reason, now());
    },
    remove(platform: string, platformUserId: string): void {
      db.run('DELETE FROM suppressions WHERE platform = ? AND platformUserId = ?', platform, platformUserId);
    },
    has(platform: string, platformUserId: string): boolean {
      return db.get('SELECT 1 AS x FROM suppressions WHERE platform = ? AND platformUserId = ?', platform, platformUserId) !== undefined;
    },
  };

  const conversations = {
    map: (r: Row) => hydrate<Conversation>(r, { lastAnalysis: null }, [])!,
    get(id: string): Conversation | undefined {
      const r = db.get<Row>('SELECT * FROM conversations WHERE id = ?', id);
      return r ? conversations.map(r) : undefined;
    },
    find(accountId: string, contactId: string, kind: ConversationKind, threadRef: string): Conversation | undefined {
      const r = db.get<Row>('SELECT * FROM conversations WHERE accountId = ? AND contactId = ? AND kind = ? AND threadRef = ?', accountId, contactId, kind, threadRef);
      return r ? conversations.map(r) : undefined;
    },
    create(input: { accountId: string; contactId: string; campaignId: string | null; kind: ConversationKind; threadRef: string; title: string; deadlineAt: number | null }): Conversation {
      const id = newId('conv');
      db.insert('conversations', { id, ...input, createdAt: now(), updatedAt: now() });
      return conversations.get(id)!;
    },
    update(id: string, patch: Partial<Conversation>): void {
      const { id: _id, createdAt: _c, ...rest } = patch;
      db.update('conversations', id, dehydrate({ ...rest, updatedAt: now() }));
    },
    toListItem(r: Row): ConversationListItem {
      const base = conversations.map(r) as Conversation & Row;
      const campaignMode = (base.campaignMode as Mode | null) ?? 'copilot';
      delete base.campaignMode;
      // A manual account has no way to send, so it can only ever be copilot.
      const account = accounts.get(base.accountId as string);
      const receiveOnly = base.connector === 'manual' || (base.connector === 'webhook' && !account?.config.outboundUrl?.trim());
      const effectiveMode: Mode = receiveOnly ? 'copilot' : ((base.modeOverride as Mode | null) ?? campaignMode);
      return { ...(base as unknown as ConversationListItem), lastText: (base.lastText as string | null) ?? '', effectiveMode };
    },
    listItem(id: string): ConversationListItem | undefined {
      const r = db.get<Row>(`${CONVERSATION_SELECT} WHERE c.id = ?`, id);
      return r ? conversations.toListItem(r) : undefined;
    },
    list(f: ConversationFilter): ConversationListItem[] {
      const where: string[] = [];
      const params: SqlParam[] = [];
      if (f.state) {
        where.push('c.state = ?');
        params.push(f.state);
      }
      if (f.accountId) {
        where.push('c.accountId = ?');
        params.push(f.accountId);
      }
      if (f.q) {
        where.push('(ct.displayName LIKE ? OR ct.handle LIKE ? OR c.title LIKE ?)');
        params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
      }
      if (f.needsAction) {
        where.push(`(c.state = 'handoff' OR c.unread > 0 OR EXISTS (SELECT 1 FROM messages m WHERE m.conversationId = c.id AND m.status IN ('pending_approval', 'failed')))`);
      }
      const sql = `${CONVERSATION_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY COALESCE(c.lastMessageAt, c.createdAt) DESC LIMIT ?`;
      return db.all<Row>(sql, ...params, Math.min(f.limit ?? 200, 500)).map(conversations.toListItem);
    },
  };

  const messages = {
    map: (r: Row) => hydrate<Message>(r, {}, ['approved'])!,
    get(id: string): Message | undefined {
      const r = db.get<Row>('SELECT * FROM messages WHERE id = ?', id);
      return r ? messages.map(r) : undefined;
    },
    insert(m: NewMessage): Message {
      const id = newId('msg');
      db.insert('messages', {
        id,
        conversationId: m.conversationId,
        accountId: m.accountId,
        direction: m.direction,
        author: m.author,
        text: m.text,
        platformMsgId: m.platformMsgId ?? null,
        replyToRef: m.replyToRef ?? null,
        status: m.status,
        kind: m.kind ?? 'text',
        approved: m.approved ?? false,
        reviewReason: m.reviewReason ?? '',
        sendAt: m.sendAt ?? null,
        sentAt: m.sentAt ?? null,
        llmCallId: m.llmCallId ?? null,
        batchId: m.batchId ?? null,
        seq: m.seq ?? 0,
        createdAt: now(),
        updatedAt: now(),
      });
      return messages.get(id)!;
    },
    existsPlatformId(accountId: string, platformMsgId: string): boolean {
      return db.get('SELECT 1 AS x FROM messages WHERE accountId = ? AND platformMsgId = ?', accountId, platformMsgId) !== undefined;
    },
    update(id: string, patch: Partial<Message>): void {
      const { id: _id, createdAt: _c, ...rest } = patch;
      db.update('messages', id, dehydrate({ ...rest, updatedAt: now() }));
    },
    /** Chronological. Insert order (rowid) is the tiebreaker because several rows can share a millisecond. */
    byConversation(conversationId: string, limit = 500): Message[] {
      return db.all<Row>('SELECT * FROM (SELECT *, rowid AS rid FROM messages WHERE conversationId = ? ORDER BY rowid DESC LIMIT ?) ORDER BY rid', conversationId, limit).map(messages.strip);
    },
    /** The thread as the other person sees it: what they sent and what actually went out. */
    delivered(conversationId: string, limit: number): Message[] {
      return db.all<Row>("SELECT * FROM (SELECT *, rowid AS rid FROM messages WHERE conversationId = ? AND status IN ('received', 'sent', 'sending') ORDER BY rowid DESC LIMIT ?) ORDER BY rid", conversationId, limit).map(messages.strip);
    },
    strip(r: Row): Message {
      const { rid: _rid, ...rest } = r;
      return messages.map(rest);
    },
    open(conversationId: string): Message[] {
      return db.all<Row>("SELECT * FROM messages WHERE conversationId = ? AND status IN ('pending_approval', 'scheduled') ORDER BY rowid", conversationId).map(messages.map);
    },
    /** True when the other person wrote again after this message was drafted. */
    hasInboundAfter(conversationId: string, messageId: string): boolean {
      return db.get("SELECT 1 AS x FROM messages WHERE conversationId = ? AND direction = 'in' AND rowid > (SELECT rowid FROM messages WHERE id = ?) LIMIT 1", conversationId, messageId) !== undefined;
    },
    lastInboundId(conversationId: string): string | null {
      return db.get<{ id: string }>("SELECT id FROM messages WHERE conversationId = ? AND direction = 'in' ORDER BY rowid DESC LIMIT 1", conversationId)?.id ?? null;
    },
    lastOutboundActivityId(conversationId: string): string | null {
      return db.get<{ id: string }>("SELECT id FROM messages WHERE conversationId = ? AND direction = 'out' AND (author IN ('operator', 'external') OR status IN ('sent', 'sending')) ORDER BY rowid DESC LIMIT 1", conversationId)?.id ?? null;
    },
    countDelivered(conversationId: string): number {
      return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversationId = ? AND status IN ('received', 'sent')", conversationId)?.n ?? 0;
    },
    countSent(where: { accountId?: string; conversationId?: string; since: number }): number {
      const field = where.conversationId ? 'conversationId' : 'accountId';
      const value = where.conversationId ?? where.accountId ?? '';
      return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE ${field} = ? AND direction = 'out' AND status IN ('sent', 'sending') AND COALESCE(sentAt, updatedAt) > ?`, value, where.since)?.n ?? 0;
    },
    lastSentAt(accountId: string): number | null {
      return db.get<{ t: number | null }>("SELECT MAX(sentAt) AS t FROM messages WHERE accountId = ? AND direction = 'out' AND status = 'sent'", accountId)?.t ?? null;
    },
    /** What actually reached the other person. The context window is too short to tell what was already shared. */
    sentTexts(conversationId: string): string[] {
      return db.all<{ text: string }>("SELECT text FROM messages WHERE conversationId = ? AND direction = 'out' AND status IN ('sent', 'sending') ORDER BY rowid", conversationId).map((r) => r.text);
    },
    recentOutboundTexts(accountId: string, excludeConversationId: string, limit: number): string[] {
      return db
        .all<{ text: string }>("SELECT text FROM messages WHERE accountId = ? AND conversationId != ? AND direction = 'out' AND status IN ('sent', 'scheduled', 'pending_approval') ORDER BY rowid DESC LIMIT ?", accountId, excludeConversationId, limit)
        .map((r) => r.text);
    },
  };

  const signals = {
    map: (r: Row) => hydrate<Signal>(r, {}, [])!,
    /** INSERT OR IGNORE: polls overlap and webhooks retry, and the same lead must not appear twice. */
    add(input: { accountId: string; kind: SignalKind; platformUserId: string; displayName?: string; handle?: string; avatarUrl?: string; text?: string; ref: string; ts: number; status?: SignalStatus; conversationId?: string | null }): void {
      db.run(
        'INSERT OR IGNORE INTO signals (id, accountId, kind, platformUserId, displayName, handle, avatarUrl, text, ref, status, conversationId, ts, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        newId('sig'), input.accountId, input.kind, input.platformUserId, input.displayName ?? '', input.handle ?? '', input.avatarUrl ?? '', input.text ?? '', input.ref,
        input.status ?? 'new', input.conversationId ?? null, input.ts, now(), now(),
      );
    },
    get(id: string): Signal | undefined {
      const r = db.get<Row>('SELECT * FROM signals WHERE id = ?', id);
      return r ? signals.map(r) : undefined;
    },
    list(f: { accountId?: string; status?: SignalStatus; limit?: number } = {}): SignalListItem[] {
      const where: string[] = [];
      const params: SqlParam[] = [];
      if (f.accountId) {
        where.push('s.accountId = ?');
        params.push(f.accountId);
      }
      if (f.status) {
        where.push('s.status = ?');
        params.push(f.status);
      }
      return db
        .all<Row>(
          `SELECT s.*, a.name AS accountName, a.platform, a.connector FROM signals s JOIN accounts a ON a.id = s.accountId ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.ts DESC LIMIT ?`,
          ...params,
          Math.min(f.limit ?? 200, 500),
        )
        .map((r) => hydrate<SignalListItem>(r, {}, [])!);
    },
    countNew(): number {
      return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM signals WHERE status = 'new'")?.n ?? 0;
    },
    setStatus(id: string, status: SignalStatus, conversationId: string | null = null): Signal | undefined {
      db.update('signals', id, dehydrate({ status, ...(conversationId ? { conversationId } : {}), updatedAt: now() }));
      return signals.get(id);
    },
    /** The moment they message you the lead has served its purpose; stop showing it as new. */
    markContacted(accountId: string, platformUserId: string, conversationId: string): void {
      db.run("UPDATE signals SET status = 'contacted', conversationId = ?, updatedAt = ? WHERE accountId = ? AND platformUserId = ? AND status = 'new'", conversationId, now(), accountId, platformUserId);
    },
  };

  const events = {
    add(type: string, data: Record<string, unknown> = {}, refs: { accountId?: string | null; conversationId?: string | null; messageId?: string | null; level?: EventRow['level'] } = {}): void {
      db.run('INSERT INTO events (ts, type, level, accountId, conversationId, messageId, data) VALUES (?, ?, ?, ?, ?, ?, ?)', now(), type, refs.level ?? 'info', refs.accountId ?? null, refs.conversationId ?? null, refs.messageId ?? null, JSON.stringify(data));
    },
    list(f: { conversationId?: string; accountId?: string; level?: string; limit?: number }): EventRow[] {
      const where: string[] = [];
      const params: SqlParam[] = [];
      for (const key of ['conversationId', 'accountId', 'level'] as const) {
        if (f[key]) {
          where.push(`${key} = ?`);
          params.push(f[key]);
        }
      }
      return db.all<Row>(`SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...params, Math.min(f.limit ?? 200, 1000)).map((r) => hydrate<EventRow>(r, { data: {} }, [])!);
    },
  };

  const llmCalls = {
    get(id: string): LlmCall | undefined {
      return hydrate<LlmCall>(db.get<Row>('SELECT * FROM llm_calls WHERE id = ?', id), {}, ['ok']);
    },
    byConversation(conversationId: string, limit: number): LlmCall[] {
      return db.all<Row>('SELECT * FROM llm_calls WHERE conversationId = ? ORDER BY createdAt DESC LIMIT ?', conversationId, limit).map((r) => hydrate<LlmCall>(r, {}, ['ok'])!);
    },
  };

  const simRuns = {
    map: (r: Row) => hydrate<SimRun>(r, { persona: {}, report: null }, [])!,
    get(id: string): SimRun | undefined {
      const r = db.get<Row>('SELECT * FROM sim_runs WHERE id = ?', id);
      return r ? simRuns.map(r) : undefined;
    },
    list(limit = 50): SimRun[] {
      return db.all<Row>('SELECT * FROM sim_runs ORDER BY createdAt DESC LIMIT ?', limit).map(simRuns.map);
    },
    create(input: Pick<SimRun, 'campaignId' | 'agentProviderId' | 'contactProviderId' | 'persona' | 'maxTurns'>): SimRun {
      const id = newId('sim');
      db.insert('sim_runs', dehydrate({ id, ...input, status: 'running', createdAt: now(), updatedAt: now() }));
      return simRuns.get(id)!;
    },
    update(id: string, patch: Partial<SimRun>): void {
      const { id: _id, createdAt: _c, ...rest } = patch;
      db.update('sim_runs', id, dehydrate({ ...rest, updatedAt: now() }));
    },
  };

  return { settings, providers, personas, skills, campaigns, accounts, contacts, suppressions, conversations, messages, signals, events, llmCalls, simRuns };
}

export type Repos = ReturnType<typeof createRepos>;
