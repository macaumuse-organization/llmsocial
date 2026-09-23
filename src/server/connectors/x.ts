import { accessTokenFor } from './oauth.ts';
import { ConnectorError, apiJson, type Connector, type ConnectorContext, type InboundMessage, type SendResult } from './types.ts';

const API_BASE = 'https://api.x.com';
const MAX_PAGES = 3;
const PAGE_SIZE = 50;
const FIRST_POLL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** After a 403 on the DM endpoint (plan without DM access) stop asking for this long. */
const DM_BACKOFF_MS = 6 * 60 * 60 * 1000;
const TEXT_CAP = 8000;

interface XUser {
  id?: unknown;
  username?: unknown;
  name?: unknown;
  profile_image_url?: unknown;
}

interface XTweet {
  id?: unknown;
  text?: unknown;
  created_at?: unknown;
  author_id?: unknown;
  conversation_id?: unknown;
}

interface XDmEvent {
  id?: unknown;
  text?: unknown;
  created_at?: unknown;
  sender_id?: unknown;
  dm_conversation_id?: unknown;
  event_type?: unknown;
}

interface XPage<T> {
  data?: T[];
  includes?: { users?: XUser[] };
  meta?: { next_token?: unknown; newest_id?: unknown; result_count?: unknown };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function toMillis(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Snowflake ids are longer than Number can hold exactly, so compare them as BigInt. */
function idGreater(a: string, b: string): boolean {
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return a.length === b.length ? a > b : a.length > b.length;
  }
}

function cursorString(ctx: ConnectorContext, key: string): string | undefined {
  return str(ctx.getCursor()[key]);
}

function cursorNumber(ctx: ConnectorContext, key: string): number {
  const value = ctx.getCursor()[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Merge, never replace: the OAuth helper keeps tokenExpiresAt in the same cursor object. */
function patchCursor(ctx: ConnectorContext, patch: Record<string, unknown>): void {
  ctx.setCursor({ ...ctx.getCursor(), ...patch });
}

async function get<T>(ctx: ConnectorContext, token: string, path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(params)) if (value !== '') url.searchParams.set(key, value);
  return apiJson<T>(ctx, url.toString(), { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
}

async function post<T>(ctx: ConnectorContext, token: string, path: string, body: unknown): Promise<T> {
  return apiJson<T>(ctx, new URL(path, API_BASE).toString(), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function fetchSelf(ctx: ConnectorContext, token: string): Promise<{ id: string; username?: string; name?: string }> {
  const res = await get<{ data?: XUser }>(ctx, token, '/2/users/me', { 'user.fields': 'username,name' });
  const id = str(res.data?.id);
  if (!id) throw new ConnectorError('auth', 'GET /2/users/me 未返回账号 id');
  return { id, username: str(res.data?.username), name: str(res.data?.name) };
}

async function selfId(ctx: ConnectorContext, token: string): Promise<string> {
  const cached = cursorString(ctx, 'userId');
  if (cached) return cached;
  const me = await fetchSelf(ctx, token);
  patchCursor(ctx, { userId: me.id });
  return me.id;
}

function userIndex(pages: XPage<unknown>[]): Map<string, XUser> {
  const index = new Map<string, XUser>();
  for (const page of pages) for (const user of page.includes?.users ?? []) {
    const id = str(user.id);
    if (id) index.set(id, user);
  }
  return index;
}

function contactOf(index: Map<string, XUser>, platformUserId: string): InboundMessage['contact'] {
  const user = index.get(platformUserId);
  const username = str(user?.username);
  return {
    platformUserId,
    displayName: str(user?.name) ?? username,
    handle: username ? `@${username}` : undefined,
    avatarUrl: str(user?.profile_image_url),
  };
}

async function pollMentions(ctx: ConnectorContext, token: string, meId: string): Promise<InboundMessage[]> {
  const sinceId = cursorString(ctx, 'mentionsSinceId');
  const pages: XPage<XTweet>[] = [];
  let pageToken: string | undefined;

  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await get<XPage<XTweet>>(ctx, token, `/2/users/${encodeURIComponent(meId)}/mentions`, {
      max_results: String(PAGE_SIZE),
      'tweet.fields': 'created_at,author_id,conversation_id',
      expansions: 'author_id',
      'user.fields': 'username,name,profile_image_url',
      // No cursor yet: only look back 24h, so a fresh account never imports its history.
      ...(sinceId ? { since_id: sinceId } : { start_time: new Date(ctx.now() - FIRST_POLL_WINDOW_MS).toISOString() }),
      ...(pageToken ? { pagination_token: pageToken } : {}),
    });
    pages.push(page);
    pageToken = str(page.meta?.next_token);
    if (!pageToken) break;
  }

  const index = userIndex(pages);
  const messages: InboundMessage[] = [];
  let newest = sinceId ?? '';

  for (const page of pages) for (const tweet of page.data ?? []) {
    const id = str(tweet.id);
    const authorId = str(tweet.author_id);
    if (!id || !authorId) continue;
    if (newest === '' || idGreater(id, newest)) newest = id;
    messages.push({
      platformMsgId: `tw:${id}`,
      kind: 'comment',
      threadRef: str(tweet.conversation_id) ?? id,
      contact: contactOf(index, authorId),
      text: (str(tweet.text) ?? '').slice(0, TEXT_CAP),
      timestamp: toMillis(tweet.created_at, ctx.now()),
      fromSelf: authorId === meId,
      replyToRef: id,
    });
  }

  if (newest !== '' && newest !== sinceId) patchCursor(ctx, { mentionsSinceId: newest });
  return messages;
}

/** /2/dm_events has no since_id, so paging stops at the newest event id seen last time. */
async function pollDms(ctx: ConnectorContext, token: string, meId: string): Promise<InboundMessage[]> {
  const lastEventId = cursorString(ctx, 'dmLastEventId');
  const floor = lastEventId ? 0 : ctx.now() - FIRST_POLL_WINDOW_MS;
  const pages: XPage<XDmEvent>[] = [];
  let pageToken: string | undefined;
  let reachedKnown = false;

  for (let i = 0; i < MAX_PAGES && !reachedKnown; i++) {
    const page = await get<XPage<XDmEvent>>(ctx, token, '/2/dm_events', {
      event_types: 'MessageCreate',
      max_results: String(PAGE_SIZE),
      'dm_event.fields': 'id,text,created_at,sender_id,dm_conversation_id',
      expansions: 'sender_id',
      'user.fields': 'username,name',
      ...(pageToken ? { pagination_token: pageToken } : {}),
    });
    pages.push(page);
    reachedKnown = (page.data ?? []).some((event) => {
      const id = str(event.id);
      return id !== undefined && lastEventId !== undefined && !idGreater(id, lastEventId);
    });
    pageToken = str(page.meta?.next_token);
    if (!pageToken) break;
  }

  const index = userIndex(pages);
  const messages: InboundMessage[] = [];
  let newest = lastEventId ?? '';

  for (const page of pages) for (const event of page.data ?? []) {
    const id = str(event.id);
    const senderId = str(event.sender_id);
    const threadRef = str(event.dm_conversation_id);
    if (!id || !senderId || !threadRef) continue;
    if (lastEventId && !idGreater(id, lastEventId)) continue;
    const timestamp = toMillis(event.created_at, ctx.now());
    if (timestamp < floor) continue;
    if (newest === '' || idGreater(id, newest)) newest = id;
    messages.push({
      platformMsgId: `dm:${id}`,
      kind: 'dm',
      threadRef,
      contact: contactOf(index, senderId),
      text: (str(event.text) ?? '').slice(0, TEXT_CAP),
      timestamp,
      fromSelf: senderId === meId,
    });
  }

  if (newest !== '' && newest !== lastEventId) patchCursor(ctx, { dmLastEventId: newest });
  return messages;
}

export const xConnector: Connector = {
  meta: {
    kind: 'x',
    label: 'X（Twitter）',
    description: '用 X API v2 读取账号收到的提及和私信，并在原帖下回复或回私信。只处理别人先发给你的内容。',
    platforms: ['x'],
    canSend: true,
    canPoll: true,
    canSignals: false,
    usesWebhook: false,
    oauth: 'x',
    untestedLive: true,
    fields: [
      { key: 'clientId', label: 'Client ID', required: true, help: 'X 开发者后台 → 你的 App → Keys and tokens → OAuth 2.0 Client ID。' },
      { key: 'clientSecret', label: 'Client Secret', secret: true, help: 'App type 选 Confidential client 时才有；选 Public client 就留空。' },
    ],
    setupNotes:
      '1) 在 developer.x.com 建一个 Project + App（App type 选 Web App / Automated App or Bot）。2) User authentication settings 里打开 OAuth 2.0，Type of App 选 Confidential 或 Public client，App permissions 选「Read and write and Direct message」。3) Callback URI 填 http://127.0.0.1:{本机端口}/oauth/callback（端口＝llmsocial 的监听端口），Website URL 随便填一个可访问的地址。4) 授权 scope 固定为 tweet.read tweet.write users.read dm.read dm.write offline.access，少一个私信或发推就会 403。已知限制：私信端点 /2/dm_events 需要 Pro 及以上套餐（Basic 套餐已被移除），套餐不够时本连接器只收提及并在 6 小时内跳过私信；私信只回溯 30 天且没有增量参数；提及时间线最多回溯 7 天、约 800 条；免费/Basic 套餐的发推与发私信配额很低（发私信普遍是 15 分钟 15 条一类的上限），Autopilot 建议放慢轮询。',
  },

  async test(ctx) {
    const token = await accessTokenFor(ctx, 'x');
    const me = await fetchSelf(ctx, token);
    patchCursor(ctx, { userId: me.id });
    return { ok: true, detail: `已连接 ${me.name ?? ''}${me.username ? ` @${me.username}` : ''}`.trim() || '已连接' };
  },

  async poll(ctx) {
    const token = await accessTokenFor(ctx, 'x');
    const meId = await selfId(ctx, token);
    const messages = await pollMentions(ctx, token, meId);

    if (cursorNumber(ctx, 'dmDisabledUntil') > ctx.now()) return messages;
    try {
      messages.push(...(await pollDms(ctx, token, meId)));
    } catch (err) {
      // 403 here means the app's plan has no DM access; the mentions half of the poll still counts.
      if (err instanceof ConnectorError && err.code === 'blocked') {
        patchCursor(ctx, { dmDisabledUntil: ctx.now() + DM_BACKOFF_MS });
        ctx.log.warn({ accountId: ctx.account.id, connector: 'x' }, 'dm_events forbidden (plan lacks DM access); skipping DMs for 6h');
        // Otherwise this degrades silently to comments-only and looks like "nobody is messaging us".
        ctx.notice('X 拒绝读取私信（403）：这个开发者应用的层级没有私信权限，私信要 Pro 及以上。评论和提及照常收，私信 6 小时后再试。');
      } else {
        throw err;
      }
    }
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  },

  async send(ctx, req): Promise<SendResult> {
    const token = await accessTokenFor(ctx, 'x');

    if (req.kind === 'comment') {
      if (!req.replyToRef) throw new ConnectorError('invalid', '回复推文需要 replyToRef（被回复的推文 id）');
      try {
        const res = await post<{ data?: { id?: unknown } }>(ctx, token, '/2/tweets', { text: req.text, reply: { in_reply_to_tweet_id: req.replyToRef } });
        return { platformMsgId: str(res.data?.id) };
      } catch (err) {
        // A 403 on POST /2/tweets is usually duplicate content or a deleted/protected parent, not an unreachable user.
        if (err instanceof ConnectorError && err.code === 'blocked') throw new ConnectorError('invalid', `推文被拒绝：${err.message}`);
        throw err;
      }
    }

    const res = await post<{ data?: { dm_event_id?: unknown } }>(ctx, token, `/2/dm_conversations/${encodeURIComponent(req.threadRef)}/messages`, { text: req.text });
    return { platformMsgId: str(res.data?.dm_event_id) };
  },
};
