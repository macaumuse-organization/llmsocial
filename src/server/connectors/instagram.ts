import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConnectorError, type Connector, type ConnectorContext, type InboundMessage, type SendRequest, type SendResult, type WebhookRequest } from './types.ts';

/** "Instagram API with Instagram Login" — graph.instagram.com, no Facebook Page in the middle. */
const API = 'https://graph.instagram.com/v23.0';
/** refresh_access_token lives on the unversioned host. */
const HOST = 'https://graph.instagram.com';
const DAY_MS = 86_400_000;
const REFRESH_EVERY_MS = 7 * DAY_MS;
const MAX_PAGES = 3;

interface IgCursor {
  igUserId?: string;
  username?: string;
  /** epoch ms of the last successful long-lived token refresh */
  lastRefreshAt?: number;
  tokenExpiresAt?: number;
  /** high-water marks, epoch ms */
  lastDmAt?: number;
  lastCommentAt?: number;
  /** set on the first poll so history is never back-filled */
  seedAt?: number;
}

interface IgList<T> {
  data?: T[];
  paging?: { next?: string; cursors?: { after?: string } };
}

interface IgUserRef {
  id?: string;
  username?: string;
}

interface IgMessage {
  id?: string;
  created_time?: string;
  from?: IgUserRef;
  to?: { data?: IgUserRef[] };
  message?: string;
}

interface IgConversation {
  id?: string;
  updated_time?: string;
  participants?: { data?: IgUserRef[] };
  messages?: IgList<IgMessage>;
}

interface IgMedia {
  id?: string;
  caption?: string;
  comments_count?: number;
  timestamp?: string;
}

interface IgComment {
  id?: string;
  text?: string;
  username?: string;
  timestamp?: string;
  from?: IgUserRef;
}

function merge(ctx: ConnectorContext, patch: IgCursor): void {
  ctx.setCursor({ ...ctx.getCursor(), ...patch });
}

function readCursor(ctx: ConnectorContext): IgCursor {
  return ctx.getCursor() as IgCursor;
}

/** Meta returns "2026-09-20T07:11:07+0000"; ES date parsing wants "+00:00". */
function parseIsoMs(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(ms) ? ms : null;
}

/** estimated_time_to_regain_access is in minutes, inside x-business-use-case-usage. */
function regainMs(header: string | null): number | null {
  if (header === null || header === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  let minutes = 0;
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object') continue;
      const n = (entry as Record<string, unknown>).estimated_time_to_regain_access;
      if (typeof n === 'number' && n > minutes) minutes = n;
    }
  }
  return minutes > 0 ? minutes * 60_000 : null;
}

const RATE_CODES = new Set([4, 17, 32, 613]);

/**
 * apiJson only sees the HTTP status, but Meta hides the actionable part (code / error_subcode)
 * in the body of a 400, so this connector maps the response itself.
 */
async function igJson<T>(ctx: ConnectorContext, url: string, token: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      ...init,
      headers: { accept: 'application/json', ...(init.headers ?? {}), authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ConnectorError('transient', `network: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  if (res.ok) {
    try {
      return (text === '' ? {} : JSON.parse(text)) as T;
    } catch {
      throw new ConnectorError('transient', 'instagram returned non-JSON');
    }
  }

  let code: number | null = null;
  let subcode: number | null = null;
  let message = '';
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown; error_subcode?: unknown; message?: unknown } };
    const e = body.error;
    if (e !== undefined && e !== null) {
      if (typeof e.code === 'number') code = e.code;
      if (typeof e.error_subcode === 'number') subcode = e.error_subcode;
      // Meta's error.message never echoes the token, unlike the raw request URL.
      if (typeof e.message === 'string') message = e.message.slice(0, 200);
    }
  } catch {
    message = '';
  }
  const label = `IG ${res.status}${code === null ? '' : `/${code}`}${subcode === null ? '' : `.${subcode}`}: ${message}`;
  const wait = regainMs(res.headers.get('x-business-use-case-usage'));

  if (code === 10 && subcode === 2534022) throw new ConnectorError('window_closed', label);
  if (code === 190) throw new ConnectorError('auth', label);
  if (code !== null && RATE_CODES.has(code)) throw new ConnectorError('rate_limited', label, wait);
  if (res.status === 401) throw new ConnectorError('auth', label);
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    throw new ConnectorError('rate_limited', label, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : wait);
  }
  if (res.status >= 500) throw new ConnectorError('transient', label);
  if (res.status === 403) throw new ConnectorError('blocked', label);
  throw new ConnectorError('invalid', label);
}

/**
 * Meta's paging.next repeats the access token in the query string, so the next page is rebuilt
 * from paging.cursors.after instead — the token stays in the Authorization header.
 */
async function pagedGet<T>(ctx: ConnectorContext, token: string, baseUrl: string, tooOld?: (item: T) => boolean, maxPages: number = MAX_PAGES): Promise<T[]> {
  const out: T[] = [];
  let after = '';
  for (let page = 0; page < Math.min(maxPages, MAX_PAGES); page += 1) {
    const url = after === '' ? baseUrl : `${baseUrl}&after=${encodeURIComponent(after)}`;
    const body = await igJson<IgList<T>>(ctx, url, token);
    const rows = Array.isArray(body.data) ? body.data : [];
    out.push(...rows);
    // Lists come back newest-first, so one row past the cutoff means the rest are too.
    if (tooOld !== undefined && rows.some(tooOld)) break;
    const next = body.paging?.cursors?.after;
    if (rows.length === 0 || body.paging?.next === undefined || typeof next !== 'string' || next === '') break;
    after = next;
  }
  return out;
}

/**
 * Long-lived tokens last 60 days and can only be refreshed once they are 24h old, so the very
 * first sighting only records the clock and the real refresh happens a week later.
 */
async function currentToken(ctx: ConnectorContext): Promise<string> {
  const token = await ctx.getSecret('accessToken');
  if (token === null || token === '') throw new ConnectorError('auth', '未配置访问令牌');
  const cursor = readCursor(ctx);
  const last = typeof cursor.lastRefreshAt === 'number' ? cursor.lastRefreshAt : 0;
  if (last === 0) {
    merge(ctx, { lastRefreshAt: ctx.now() });
    return token;
  }
  if (ctx.now() - last < REFRESH_EVERY_MS) return token;

  let refreshed: { access_token?: unknown; expires_in?: unknown };
  try {
    refreshed = await igJson(ctx, `${HOST}/refresh_access_token?grant_type=ig_refresh_token`, token);
  } catch (err) {
    if (err instanceof ConnectorError && err.code === 'auth') throw err;
    ctx.log.warn({ accountId: ctx.account.id }, 'instagram token refresh failed, continuing with the current token');
    return token;
  }
  if (typeof refreshed.access_token !== 'string' || refreshed.access_token === '') return token;
  ctx.setSecret('accessToken', refreshed.access_token);
  const ttl = typeof refreshed.expires_in === 'number' ? refreshed.expires_in * 1000 : 60 * DAY_MS;
  merge(ctx, { lastRefreshAt: ctx.now(), tokenExpiresAt: ctx.now() + ttl });
  return refreshed.access_token;
}

async function igUserId(ctx: ConnectorContext, token: string): Promise<string> {
  const known = readCursor(ctx).igUserId;
  if (typeof known === 'string' && known !== '') return known;
  const me = await igJson<{ user_id?: unknown; id?: unknown; username?: unknown }>(ctx, `${API}/me?fields=user_id,username`, token);
  const id = typeof me.user_id === 'string' ? me.user_id : typeof me.id === 'string' ? me.id : '';
  if (id === '') throw new ConnectorError('invalid', 'instagram /me returned no user_id');
  merge(ctx, { igUserId: id, username: typeof me.username === 'string' ? me.username : undefined });
  return id;
}

function reason(err: unknown): string {
  if (!(err instanceof ConnectorError)) return '连接失败';
  if (err.code === 'auth') return '访问令牌无效或已过期，请在 Meta 应用后台重新生成长期令牌';
  if (err.code === 'rate_limited') return '已触发平台调用配额，请稍后再试';
  if (err.code === 'blocked') return '权限不足：请确认账号是专业号，且应用已获得对应权限';
  if (err.code === 'transient') return '网络或平台暂时不可用';
  return `平台返回错误（${err.message.slice(0, 120)}）`;
}

function dmMessages(ctx: ConnectorContext, conversations: IgConversation[], selfId: string, since: number): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const conv of conversations) {
    const threadRef = typeof conv.id === 'string' ? conv.id : '';
    if (threadRef === '') continue;
    const others = (conv.participants?.data ?? []).filter((p) => p.id !== selfId);
    const fallback = others[0];
    for (const msg of conv.messages?.data ?? []) {
      const id = typeof msg.id === 'string' ? msg.id : '';
      const text = typeof msg.message === 'string' ? msg.message : '';
      const ts = parseIsoMs(msg.created_time);
      if (id === '' || text === '' || ts === null || ts <= since) continue;
      const fromSelf = msg.from?.id === selfId;
      const peer = fromSelf ? (msg.to?.data ?? [])[0] ?? fallback : msg.from ?? fallback;
      const peerId = typeof peer?.id === 'string' ? peer.id : '';
      if (peerId === '' || peerId === selfId) continue;
      out.push({
        platformMsgId: id,
        kind: 'dm',
        threadRef,
        contact: { platformUserId: peerId, displayName: peer?.username, handle: peer?.username },
        text: text.slice(0, 8000),
        timestamp: ts,
        fromSelf,
      });
    }
  }
  return out;
}

export const instagramConnector: Connector = {
  meta: {
    kind: 'instagram',
    label: 'Instagram 私信与评论',
    description: '通过 Meta 官方的 Instagram API with Instagram Login 读取专业号收到的私信和评论，并回复它们。只处理别人先发来的消息，不主动私信任何人。',
    platforms: ['instagram'],
    canSend: true,
    canPoll: true,
    usesWebhook: true,
    oauth: null,
    untestedLive: true,
    fields: [
      {
        key: 'accessToken',
        label: '访问令牌（长期）',
        secret: true,
        required: true,
        help: '在 Meta 应用后台 →「Instagram」→ API 设置里生成的长期用户令牌，直接粘贴过来。有效期 60 天，llmsocial 会每 7 天自动续期并保存新令牌。',
      },
      {
        key: 'appSecret',
        label: '应用密钥（App Secret）',
        secret: true,
        help: '只有启用 webhook 时才需要：用来校验 Meta 回调的 X-Hub-Signature-256 签名。留空则拒收所有回调。',
      },
      {
        key: 'verifyToken',
        label: '回调校验令牌（Verify Token）',
        placeholder: '自定义随机字符串',
        help: '自己取一串随机字符串，Meta 后台配置 webhook 时填同样的值，用于回调地址的一次性校验。',
      },
    ],
    setupNotes:
      '前置条件：Instagram 账号必须是专业号（商家或创作者），并在 Instagram App 内打开「设置 → 消息与故事回复 → 允许访问消息」。\n' +
      '1）在 Meta 应用后台新建一个「企业」类型应用，产品里添加「Instagram」，并选择「Instagram API 使用 Instagram 登录」（不要选带 Facebook 主页的那一套）。\n' +
      '2）权限申请：instagram_business_basic（读取账号资料）、instagram_business_manage_messages（读写私信）、instagram_business_manage_comments（读取并回复评论）。上线前需通过应用审核。\n' +
      '3）令牌：在「API 设置」页把账号授权后生成长期用户令牌，粘贴到上面的「访问令牌」。这里不做 OAuth 跳转，因为 Meta 只接受 HTTPS 回调地址，本地部署给不出。\n' +
      '4）Webhook（可选，配了就不必频繁轮询）：回调 URL 形如 https://你的域名/webhooks/{账号ID}，必须是公网可达的 HTTPS 地址；校验令牌填上面那一项；订阅字段勾选 messages 和 comments。\n' +
      '已知限制：私信只能在对方最后一次发消息后的 24 小时内回复，超时平台会报错（10/2534022），此时只能人工在 App 里处理；长期令牌 60 天到期，超过 60 天未续期就要重新生成；调用配额超限时平台返回 4 / 17 / 32 / 613。',
  },

  async test(ctx) {
    try {
      const token = await currentToken(ctx);
      const me = await igJson<{ user_id?: unknown; id?: unknown; username?: unknown }>(ctx, `${API}/me?fields=user_id,username`, token);
      const id = typeof me.user_id === 'string' ? me.user_id : typeof me.id === 'string' ? me.id : '';
      if (id === '') return { ok: false, detail: '平台未返回 user_id，请确认账号已切换为专业号' };
      const username = typeof me.username === 'string' ? me.username : '';
      merge(ctx, { igUserId: id, username: username === '' ? undefined : username });
      return { ok: true, detail: `已连接${username === '' ? '' : ` @${username}`}（账号 ID ${id}）` };
    } catch (err) {
      return { ok: false, detail: reason(err) };
    }
  },

  async poll(ctx) {
    const token = await currentToken(ctx);
    const selfId = await igUserId(ctx, token);
    const cursor = readCursor(ctx);
    const seeded = typeof cursor.seedAt === 'number';
    const floor = ctx.now() - DAY_MS;
    const dmSince = seeded ? Math.max(typeof cursor.lastDmAt === 'number' ? cursor.lastDmAt : 0, 0) : floor;
    const commentSince = seeded ? Math.max(typeof cursor.lastCommentAt === 'number' ? cursor.lastCommentAt : 0, 0) : floor;
    const out: InboundMessage[] = [];

    const conversations = await pagedGet<IgConversation>(
      ctx,
      token,
      `${API}/me/conversations?platform=instagram&fields=id,updated_time,participants,messages.limit(10){id,created_time,from,to,message}`,
      (conv) => {
        const ts = parseIsoMs(conv.updated_time);
        return ts !== null && ts <= dmSince;
      },
    );
    out.push(...dmMessages(ctx, conversations, selfId, dmSince));

    const selfName = typeof cursor.username === 'string' ? cursor.username : '';
    // Only the 10 most recent posts: older posts rarely get new comments and each one costs a request.
    const media = await pagedGet<IgMedia>(ctx, token, `${API}/me/media?fields=id,caption,comments_count,timestamp&limit=10`, undefined, 1);
    for (const item of media) {
      const mediaId = typeof item.id === 'string' ? item.id : '';
      if (mediaId === '' || typeof item.comments_count !== 'number' || item.comments_count <= 0) continue;
      const title = typeof item.caption === 'string' && item.caption !== '' ? item.caption.slice(0, 80) : undefined;
      const comments = await pagedGet<IgComment>(ctx, token, `${API}/${mediaId}/comments?fields=id,text,username,timestamp,from&limit=50`, (c) => {
        const ts = parseIsoMs(c.timestamp);
        return ts !== null && ts <= commentSince;
      });
      for (const comment of comments) {
        const id = typeof comment.id === 'string' ? comment.id : '';
        const text = typeof comment.text === 'string' ? comment.text : '';
        const ts = parseIsoMs(comment.timestamp);
        if (id === '' || text === '' || ts === null || ts <= commentSince) continue;
        const authorId = typeof comment.from?.id === 'string' ? comment.from.id : '';
        const handle = typeof comment.username === 'string' ? comment.username : comment.from?.username;
        const fromSelf = authorId === selfId || (selfName !== '' && handle === selfName);
        out.push({
          platformMsgId: id,
          kind: 'comment',
          threadRef: mediaId,
          threadTitle: title,
          contact: { platformUserId: authorId === '' ? (handle ?? id) : authorId, displayName: handle, handle },
          text: text.slice(0, 8000),
          timestamp: ts,
          fromSelf,
          replyToRef: id,
        });
      }
    }

    let lastDmAt = dmSince;
    let lastCommentAt = commentSince;
    for (const msg of out) {
      if (msg.kind === 'dm') lastDmAt = Math.max(lastDmAt, msg.timestamp);
      else lastCommentAt = Math.max(lastCommentAt, msg.timestamp);
    }
    merge(ctx, { seedAt: seeded ? cursor.seedAt : ctx.now(), lastDmAt, lastCommentAt });
    return out;
  },

  async send(ctx, req: SendRequest): Promise<SendResult> {
    const token = await currentToken(ctx);
    if (req.kind === 'dm') {
      if (req.contactPlatformUserId === '') throw new ConnectorError('invalid', '缺少收件人 ID');
      const sent = await igJson<{ message_id?: unknown }>(ctx, `${API}/me/messages`, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recipient: { id: req.contactPlatformUserId }, message: { text: req.text } }),
      });
      return { platformMsgId: typeof sent.message_id === 'string' ? sent.message_id : undefined };
    }
    if (req.kind === 'comment') {
      const commentId = req.replyToRef ?? '';
      if (commentId === '') throw new ConnectorError('invalid', '缺少要回复的评论 ID');
      const sent = await igJson<{ id?: unknown }>(ctx, `${API}/${encodeURIComponent(commentId)}/replies`, token, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ message: req.text }).toString(),
      });
      return { platformMsgId: typeof sent.id === 'string' ? sent.id : undefined };
    }
    throw new ConnectorError('unsupported', '该消息类型不支持自动发送');
  },

  async handleWebhook(ctx, req: WebhookRequest) {
    if (req.method === 'GET') {
      const expected = ctx.config.verifyToken ?? '';
      const given = req.query['hub.verify_token'] ?? '';
      if (req.query['hub.mode'] !== 'subscribe' || expected === '' || !safeEqual(given, expected)) {
        return { response: { status: 403, body: 'verification failed' }, messages: [] };
      }
      return { response: { status: 200, body: req.query['hub.challenge'] ?? '', contentType: 'text/plain' }, messages: [] };
    }

    const appSecret = await ctx.getSecret('appSecret');
    const signature = req.headers['x-hub-signature-256'] ?? '';
    if (appSecret === null || appSecret === '') return { response: { status: 401, body: 'app secret not configured' }, messages: [] };
    // Signature covers the raw bytes: verify before the body is parsed or trusted.
    const expectedSig = `sha256=${createHmac('sha256', appSecret).update(req.rawBody).digest('hex')}`;
    if (!safeEqual(signature, expectedSig)) return { response: { status: 401, body: 'bad signature' }, messages: [] };

    let body: { entry?: unknown };
    try {
      body = JSON.parse(req.rawBody.toString('utf8')) as { entry?: unknown };
    } catch {
      return { response: { status: 400, body: 'invalid JSON' }, messages: [] };
    }

    const selfId = typeof readCursor(ctx).igUserId === 'string' ? (readCursor(ctx).igUserId as string) : '';
    const messages: InboundMessage[] = [];
    for (const rawEntry of Array.isArray(body.entry) ? body.entry : []) {
      if (rawEntry === null || typeof rawEntry !== 'object') continue;
      const entry = rawEntry as { time?: unknown; messaging?: unknown; changes?: unknown };
      const entryTime = typeof entry.time === 'number' ? entry.time * 1000 : ctx.now();

      for (const rawEvent of Array.isArray(entry.messaging) ? entry.messaging : []) {
        if (rawEvent === null || typeof rawEvent !== 'object') continue;
        const event = rawEvent as { sender?: IgUserRef; recipient?: IgUserRef; timestamp?: unknown; message?: { mid?: unknown; text?: unknown; is_echo?: unknown } };
        const mid = typeof event.message?.mid === 'string' ? event.message.mid : '';
        const text = typeof event.message?.text === 'string' ? event.message.text : '';
        if (mid === '' || text === '') continue;
        const senderId = typeof event.sender?.id === 'string' ? event.sender.id : '';
        const recipientId = typeof event.recipient?.id === 'string' ? event.recipient.id : '';
        const fromSelf = event.message?.is_echo === true || (selfId !== '' && senderId === selfId);
        const peerId = fromSelf ? recipientId : senderId;
        if (peerId === '') continue;
        messages.push({
          platformMsgId: mid,
          kind: 'dm',
          // Webhooks carry no conversation id; the peer identifies the thread and poll() reconciles by platformMsgId.
          threadRef: peerId,
          contact: { platformUserId: peerId },
          text: text.slice(0, 8000),
          timestamp: typeof event.timestamp === 'number' ? event.timestamp : entryTime,
          fromSelf,
        });
      }

      for (const rawChange of Array.isArray(entry.changes) ? entry.changes : []) {
        if (rawChange === null || typeof rawChange !== 'object') continue;
        const change = rawChange as { field?: unknown; value?: unknown };
        if (change.field !== 'comments' || change.value === null || typeof change.value !== 'object') continue;
        const value = change.value as { id?: unknown; text?: unknown; from?: IgUserRef; media?: { id?: unknown }; parent_id?: unknown; timestamp?: unknown };
        const id = typeof value.id === 'string' ? value.id : '';
        const text = typeof value.text === 'string' ? value.text : '';
        if (id === '' || text === '') continue;
        const authorId = typeof value.from?.id === 'string' ? value.from.id : '';
        const mediaId = typeof value.media?.id === 'string' ? value.media.id : '';
        const ts = parseIsoMs(value.timestamp) ?? (typeof value.timestamp === 'number' ? value.timestamp * 1000 : entryTime);
        messages.push({
          platformMsgId: id,
          kind: 'comment',
          threadRef: mediaId === '' ? id : mediaId,
          contact: { platformUserId: authorId === '' ? id : authorId, displayName: value.from?.username, handle: value.from?.username },
          text: text.slice(0, 8000),
          timestamp: ts,
          fromSelf: selfId !== '' && authorId === selfId,
          replyToRef: id,
        });
      }
    }

    return { response: { status: 200, body: 'EVENT_RECEIVED', contentType: 'text/plain' }, messages };
  },
};

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
