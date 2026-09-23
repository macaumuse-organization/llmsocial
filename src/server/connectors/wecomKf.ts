import { apiJson, ConnectorError } from './types.ts';
import type { Connector, ConnectorContext, InboundMessage, InboundSignal, SendRequest, SendResult, WebhookRequest, WebhookResponse } from './types.ts';
import { parseFlatXml, wxDecrypt, wxVerify } from './wxcrypto.ts';

/**
 * WeCom "WeChat Customer Service" (微信客服).
 *
 * The callback only says "something happened on this kf account"; the payload is pulled afterwards with
 * sync_msg, which is also how WeCom expects de-duplication to work (msgid is stable, the cursor is ours).
 *
 * Every qyapi call carries its credential in the query string — the platform offers no header form — so no
 * URL built in this file is ever logged or folded into an Error. apiJson only reports status + response body.
 */

const QYAPI = 'https://qyapi.weixin.qq.com';
/** Tokens live 7200s; refresh early so a call never lands on the boundary. */
const TOKEN_SKEW_MS = 5 * 60 * 1000;
const FIRST_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_SYNC_ROUNDS = 5;
const SYNC_LIMIT = 200;
/** text.content is capped at 2048 bytes by the platform. */
const MAX_TEXT_BYTES = 2048;

interface ApiResult {
  errcode?: number;
  errmsg?: string;
}

interface KfMsg {
  msgid?: string;
  open_kfid?: string;
  external_userid?: string;
  send_time?: number;
  origin?: number;
  servicer_userid?: string;
  msgtype?: string;
  text?: { content?: string };
  event?: { event_type?: string; external_userid?: string; scene?: string };
}

interface SyncMsgResult extends ApiResult {
  next_cursor?: string;
  has_more?: number;
  msg_list?: KfMsg[];
}

interface TokenResult extends ApiResult {
  access_token?: string;
  expires_in?: number;
}

interface AccountListResult extends ApiResult {
  account_list?: { open_kfid?: string; name?: string }[];
}

interface KfCursor {
  syncCursor: string;
  accessToken: string;
  accessTokenExpiresAt: number;
}

function readCursor(ctx: ConnectorContext): KfCursor {
  const raw = ctx.getCursor();
  return {
    syncCursor: typeof raw.syncCursor === 'string' ? raw.syncCursor : '',
    accessToken: typeof raw.accessToken === 'string' ? raw.accessToken : '',
    accessTokenExpiresAt: typeof raw.accessTokenExpiresAt === 'number' ? raw.accessTokenExpiresAt : 0,
  };
}

/** Merge, never overwrite: other keys in the account cursor belong to nobody here. */
function patchCursor(ctx: ConnectorContext, patch: Record<string, unknown>): void {
  ctx.setCursor({ ...ctx.getCursor(), ...patch });
}

/**
 * Codes verified against the WeCom global error-code table (document/path/90313).
 * 95001 and 95002 are quota-per-conversation, not time-based backoff: only the customer speaking again
 * reopens the window, so they map to window_closed rather than rate_limited.
 */
function mapErrcode(errcode: number, errmsg: string | undefined, what: string): ConnectorError {
  const detail = `${what}失败：errcode ${errcode}${typeof errmsg === 'string' && errmsg !== '' ? ` ${errmsg}` : ''}`;
  switch (errcode) {
    case 40001: // 不合法的 secret
    case 40014: // 不合法的 access_token
    case 41001: // 缺少 access_token 参数
    case 42001: // access_token 已过期
    case 48002: // API 接口无权限调用
    case 60011: // 指定的成员/部门/标签参数无权限
    case 60020: // 不安全的访问 IP（企业可信 IP 未加白）
    case 95017: // 基础应用权限下，api 开关处于关闭状态
      return new ConnectorError('auth', detail);
    case 95001: // 发送客服消息次数限制（同一轮对话最多 5 条）
    case 95002: // 发送客服消息时间限制（客户最后一条消息后 48 小时）
    case 95013: // 会话已经结束
      return new ConnectorError('window_closed', detail);
    case 45009: // 接口调用超过限制
    case 45033: // 接口并发调用超过限制
      // The platform reports no reset time on these, so the scheduler picks its own backoff.
      return new ConnectorError('rate_limited', detail, null);
    case 40096: // 不合法的外部联系人 userid
      return new ConnectorError('blocked', detail);
    default:
      return new ConnectorError('invalid', detail);
  }
}

async function accessToken(ctx: ConnectorContext, forceRefresh = false): Promise<string> {
  const cached = readCursor(ctx);
  if (!forceRefresh && cached.accessToken !== '' && cached.accessTokenExpiresAt > ctx.now() + TOKEN_SKEW_MS) return cached.accessToken;

  const corpId = (ctx.config.corpId ?? '').trim();
  const corpSecret = ((await ctx.getSecret('corpSecret')) ?? '').trim();
  if (corpId === '' || corpSecret === '') throw new ConnectorError('auth', '缺少 corpId 或 corpSecret');

  const url = `${QYAPI}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
  const data = await apiJson<TokenResult>(ctx, url);
  if (typeof data.errcode === 'number' && data.errcode !== 0) throw mapErrcode(data.errcode, data.errmsg, '获取 access_token');
  if (typeof data.access_token !== 'string' || data.access_token === '') throw new ConnectorError('auth', '企业微信未返回 access_token');

  const ttlSec = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 7200;
  patchCursor(ctx, { accessToken: data.access_token, accessTokenExpiresAt: ctx.now() + ttlSec * 1000 });
  return data.access_token;
}

function qyUrl(path: string, token: string): string {
  return `${QYAPI}${path}?access_token=${encodeURIComponent(token)}`;
}

async function callOnce<T>(ctx: ConnectorContext, path: string, token: string, body: Record<string, unknown> | null): Promise<T> {
  if (body === null) return apiJson<T>(ctx, qyUrl(path, token));
  return apiJson<T>(ctx, qyUrl(path, token), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** qyapi answers 200 with errcode in the body, so the mapping happens here rather than in apiJson. */
async function kfCall<T extends ApiResult>(ctx: ConnectorContext, path: string, body: Record<string, unknown> | null, what: string): Promise<T> {
  let data = await callOnce<T>(ctx, path, await accessToken(ctx), body);
  if (data.errcode === 40014 || data.errcode === 42001) {
    // The cached token died before its stated expiry (revoked, or the secret was rotated elsewhere).
    data = await callOnce<T>(ctx, path, await accessToken(ctx, true), body);
  }
  if (typeof data.errcode === 'number' && data.errcode !== 0) throw mapErrcode(data.errcode, data.errmsg, what);
  return data;
}

function toInbound(m: KfMsg, floorMs: number): InboundMessage | null {
  const msgid = typeof m.msgid === 'string' ? m.msgid : '';
  const externalUserId = typeof m.external_userid === 'string' ? m.external_userid : '';
  const content = m.msgtype === 'text' ? (m.text?.content ?? '') : '';
  // origin 4 is a system event (session transfer, menu click) and carries nothing to answer.
  if (msgid === '' || externalUserId === '' || content === '' || (m.origin !== 3 && m.origin !== 5)) return null;

  const timestamp = typeof m.send_time === 'number' && m.send_time > 0 ? m.send_time * 1000 : 0;
  if (timestamp === 0 || timestamp < floorMs) return null;

  return {
    platformMsgId: msgid.slice(0, 200),
    kind: 'dm',
    threadRef: externalUserId.slice(0, 200),
    contact: { platformUserId: externalUserId.slice(0, 200) },
    text: content.slice(0, 8000),
    timestamp,
    // origin 5 = a human servicer answered from the WeCom client, outside llmsocial.
    fromSelf: m.origin === 5,
  };
}

/**
 * Pulls everything queued for this kf account since the stored cursor.
 * The very first sync only admits the last 24 hours: sync_msg without a cursor replays the platform's whole
 * retention window, and backfilling months of history into a fresh inbox is never what the operator wants.
 */
/**
 * Someone opened the customer-service chat from a link. A lead only: WeCom hands back a
 * welcome_code good for one greeting, and the 48-hour window still needs them to write first.
 */
function toSignal(m: KfMsg, floorMs: number): InboundSignal | null {
  if (m.msgtype !== 'event' || m.event?.event_type !== 'enter_session') return null;
  const externalUserId = typeof m.event.external_userid === 'string' ? m.event.external_userid : '';
  const msgid = typeof m.msgid === 'string' ? m.msgid : '';
  const timestamp = typeof m.send_time === 'number' && m.send_time > 0 ? m.send_time * 1000 : 0;
  if (externalUserId === '' || msgid === '' || timestamp === 0 || timestamp < floorMs) return null;
  return { kind: 'enter_session', platformUserId: externalUserId.slice(0, 200), text: m.event.scene ? `来源场景：${m.event.scene}`.slice(0, 200) : '', ref: msgid.slice(0, 200), timestamp };
}

async function syncMessages(ctx: ConnectorContext, openKfId: string, eventToken: string): Promise<{ messages: InboundMessage[]; signals: InboundSignal[] }> {
  const start = readCursor(ctx);
  const firstSync = start.syncCursor === '';
  const floorMs = firstSync ? ctx.now() - FIRST_SYNC_WINDOW_MS : 0;
  const out: InboundMessage[] = [];
  const signals: InboundSignal[] = [];
  let cursor = start.syncCursor;

  for (let round = 0; round < MAX_SYNC_ROUNDS; round += 1) {
    const body: Record<string, unknown> = { limit: SYNC_LIMIT, open_kfid: openKfId };
    if (cursor !== '') body.cursor = cursor;
    // The callback token lifts sync_msg's rate limit for this event; it is valid for 10 minutes.
    if (eventToken !== '') body.token = eventToken;

    let page: SyncMsgResult;
    try {
      page = await kfCall<SyncMsgResult>(ctx, '/cgi-bin/kf/sync_msg', body, '拉取客服消息');
    } catch (err) {
      // Keep whatever earlier rounds produced; the un-advanced cursor makes the rest replayable.
      if (out.length === 0 && signals.length === 0) throw err;
      ctx.log.warn({ accountId: ctx.account.id, round, code: err instanceof ConnectorError ? err.code : 'unknown' }, 'wecom_kf: 分页中断，保留已拉取的部分');
      break;
    }

    for (const raw of page.msg_list ?? []) {
      const msg = toInbound(raw, floorMs);
      if (msg !== null) out.push(msg);
      const signal = toSignal(raw, floorMs);
      if (signal !== null) signals.push(signal);
    }

    if (typeof page.next_cursor === 'string' && page.next_cursor !== '') {
      cursor = page.next_cursor;
      patchCursor(ctx, { syncCursor: cursor });
    }
    if (page.has_more !== 1) break;
  }

  return { messages: out, signals };
}

function reply(status: number, body: string): { response: WebhookResponse; messages: InboundMessage[] } {
  return { response: { status, body, contentType: 'text/plain' }, messages: [] };
}

/** Truncate on a UTF-8 boundary so a clipped CJK character never becomes a replacement char. */
function clampBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return new TextDecoder('utf-8').decode(buf.subarray(0, maxBytes)).replace(/�+$/u, '');
}

export const wecomKfConnector: Connector = {
  meta: {
    kind: 'wecom_kf',
    label: '微信客服（企业微信）',
    description: '企业微信「微信客服」官方接口：接收微信用户在客服会话里发来的消息，并在平台允许的时间窗内回复。只读自己收到的消息，不主动加人、不群发。',
    platforms: ['wechat'],
    canSend: true,
    canPoll: false,
    canSignals: false,
    usesWebhook: true,
    oauth: null,
    untestedLive: true,
    fields: [
      { key: 'corpId', label: '企业 ID（CorpID）', required: true, placeholder: 'ww1234567890abcdef', help: '企业微信管理后台「我的企业 → 企业信息」页面底部。' },
      { key: 'openKfId', label: '客服帐号 ID（open_kfid）', required: true, placeholder: 'wk...', help: '微信客服后台「客服帐号」列表里那一条的 ID。一个 llmsocial 账号只对应一个客服帐号。' },
      { key: 'corpSecret', label: '客服 Secret', secret: true, required: true, help: '管理后台「应用管理 → 微信客服」里的 Secret，用来换 access_token。不要填通讯录 Secret。' },
      { key: 'token', label: '回调 Token', secret: true, required: true, help: '配置接收事件服务器时随 URL 一起生成的 Token。' },
      { key: 'encodingAesKey', label: '回调 EncodingAESKey', secret: true, required: true, help: '43 个字符，与 Token 在同一页生成。加解密方式必须选「安全模式」。' },
    ],
    setupNotes: [
      '应用类型：企业微信自建应用里的「微信客服」（管理后台 → 应用管理 → 微信客服）。个人微信、公众号都用不了这个接口。',
      '权限：该 Secret 只需要微信客服的消息读写权限；把服务器的公网出口 IP 加进「企业可信 IP」，否则所有接口返回 60020。',
      '回调 URL：在「微信客服 → 开发配置 → 接收事件服务器」里填 {webhook 基址}/webhooks/{账号ID}，必须是公网可访问的 https 地址；同页生成 Token 与 EncodingAESKey，加解密方式选「安全模式」。保存时企业微信会发一次 GET 验证，本连接器会自动应答。',
      '回调只通知「有新消息」，正文由 sync_msg 拉取，所以回调地址不通就收不到任何消息。',
      '已知限制：必须是微信用户先发消息，企业才能回复；只能在客户最后一条消息之后的 48 小时内回复，且同一轮最多连发 5 条，客户再次发言后额度重置（超出分别返回 95002、95001）。access_token 有效期 2 小时，本连接器自动缓存并刷新。',
      '接待模式：如果该客服帐号在企业微信里由人工接待，人工发出的消息也会同步进来并标记为「自己发的」，不会重复起草。',
    ].join('\n'),
  },

  async test(ctx: ConnectorContext): Promise<{ ok: boolean; detail: string }> {
    const missing: string[] = [];
    if ((ctx.config.corpId ?? '').trim() === '') missing.push('corpId');
    const openKfId = (ctx.config.openKfId ?? '').trim();
    if (openKfId === '') missing.push('openKfId');
    if (((await ctx.getSecret('corpSecret')) ?? '') === '') missing.push('corpSecret');
    if (((await ctx.getSecret('token')) ?? '') === '') missing.push('token');
    const aesKey = (await ctx.getSecret('encodingAesKey')) ?? '';
    if (aesKey === '') missing.push('encodingAesKey');
    if (missing.length > 0) return { ok: false, detail: `还缺少配置：${missing.join('、')}` };
    if (aesKey.length !== 43) return { ok: false, detail: 'EncodingAESKey 必须是 43 个字符' };

    try {
      await accessToken(ctx, true);
      const list = await kfCall<AccountListResult>(ctx, '/cgi-bin/kf/account/list', null, '获取客服帐号列表');
      const hit = (list.account_list ?? []).find((a) => a.open_kfid === openKfId);
      if (hit === undefined) return { ok: false, detail: `凭据可用，但这个企业下没有 open_kfid 为 ${openKfId} 的客服帐号` };
      return { ok: true, detail: `凭据可用，已匹配客服帐号「${hit.name ?? openKfId}」。回调 URL 仍需在微信客服后台配置后才会有消息进来。` };
    } catch (err) {
      return { ok: false, detail: err instanceof ConnectorError ? `连接失败（${err.code}）：${err.message}` : '连接失败' };
    }
  },

  async handleWebhook(ctx: ConnectorContext, req: WebhookRequest): Promise<{ response: WebhookResponse; messages: InboundMessage[]; signals?: InboundSignal[] }> {
    const token = (await ctx.getSecret('token')) ?? '';
    const aesKey = (await ctx.getSecret('encodingAesKey')) ?? '';
    if (token === '' || aesKey === '') return reply(500, 'not configured');

    const signature = req.query.msg_signature ?? '';
    const timestamp = req.query.timestamp ?? '';
    const nonce = req.query.nonce ?? '';

    if (req.method === 'GET') {
      const echostr = req.query.echostr ?? '';
      if (echostr === '' || !wxVerify(signature, [token, timestamp, nonce, echostr])) return reply(401, 'bad signature');
      try {
        return reply(200, wxDecrypt(aesKey, echostr).message);
      } catch {
        return reply(400, 'bad echostr');
      }
    }

    let encrypted = '';
    try {
      encrypted = parseFlatXml(req.rawBody.toString('utf8')).Encrypt ?? '';
    } catch {
      return reply(400, 'bad body');
    }
    if (encrypted === '' || !wxVerify(signature, [token, timestamp, nonce, encrypted])) return reply(401, 'bad signature');

    let event: Record<string, string>;
    let receiveId: string;
    try {
      const plain = wxDecrypt(aesKey, encrypted);
      event = parseFlatXml(plain.message);
      receiveId = plain.receiveId;
    } catch {
      return reply(400, 'bad ciphertext');
    }

    const corpId = (ctx.config.corpId ?? '').trim();
    if (corpId !== '' && receiveId !== corpId) return reply(401, 'corp mismatch');

    // Anything else (session-status events, other kf accounts on the same corp) is acknowledged and dropped:
    // a non-200 would only make WeCom retry a callback we have no use for.
    if (event.Event !== 'kf_msg_or_event') return reply(200, 'success');
    const openKfId = (ctx.config.openKfId ?? '').trim();
    if (openKfId === '' || (typeof event.OpenKfId === 'string' && event.OpenKfId !== '' && event.OpenKfId !== openKfId)) return reply(200, 'success');

    let synced: { messages: InboundMessage[]; signals: InboundSignal[] } = { messages: [], signals: [] };
    try {
      synced = await syncMessages(ctx, openKfId, event.Token ?? '');
    } catch (err) {
      // The cursor did not advance, so the next callback replays these. Acknowledge rather than trigger a retry storm.
      ctx.log.warn({ accountId: ctx.account.id, code: err instanceof ConnectorError ? err.code : 'unknown' }, 'wecom_kf: 拉取消息失败');
    }
    return { response: { status: 200, body: 'success', contentType: 'text/plain' }, messages: synced.messages, signals: synced.signals };
  },

  async send(ctx: ConnectorContext, req: SendRequest): Promise<SendResult> {
    if (req.kind !== 'dm') throw new ConnectorError('unsupported', '微信客服只有会话消息，没有评论');
    const openKfId = (ctx.config.openKfId ?? '').trim();
    if (openKfId === '') throw new ConnectorError('invalid', '未配置 openKfId');
    if (req.contactPlatformUserId === '') throw new ConnectorError('invalid', '缺少客户 external_userid');

    const content = clampBytes(req.text, MAX_TEXT_BYTES);
    if (content.trim() === '') throw new ConnectorError('invalid', '消息内容为空');

    const data = await kfCall<ApiResult & { msgid?: string }>(
      ctx,
      '/cgi-bin/kf/send_msg',
      { touser: req.contactPlatformUserId, open_kfid: openKfId, msgtype: 'text', text: { content } },
      '发送客服消息',
    );
    return { platformMsgId: typeof data.msgid === 'string' ? data.msgid : undefined };
  },
};
