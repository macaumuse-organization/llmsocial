import { apiJson, ConnectorError, type Connector, type ConnectorContext, type InboundMessage, type WebhookResponse } from './types.ts';
import { parseFlatXml, wxDecrypt, wxVerify } from './wxcrypto.ts';

/**
 * WeChat Official Account (公众号) via the official server API.
 * Inbound is push-only: WeChat POSTs every user message to the callback URL, so there is nothing to poll.
 * Outbound is the customer-service ("客服") endpoint, which the platform only allows inside a 48-hour
 * window opened by the user's own message — the account can never start a conversation.
 */

const API_BASE = 'https://api.weixin.qq.com';
/** Refresh ahead of expiry so an in-flight send never races the cutover. */
const TOKEN_EARLY_REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_TTL_S = 7200;
const PLAIN_TEXT: WebhookResponse['contentType'] = 'text/plain; charset=utf-8';

interface WxReply {
  errcode?: number;
  errmsg?: string;
}

interface StableTokenReply extends WxReply {
  access_token?: string;
  expires_in?: number;
}

/** WeChat answers HTTP 200 with an errcode in the body, so every response has to be inspected. */
function wxError(errcode: number, errmsg: string): ConnectorError {
  const detail = errmsg.slice(0, 200);
  switch (errcode) {
    case 40001:
    case 42001:
      return new ConnectorError('auth', `wechat ${errcode}: access_token 无效或已过期（${detail}）`);
    case 40125:
      return new ConnectorError('auth', `wechat 40125: AppSecret 不正确（${detail}）`);
    case 40164:
      return new ConnectorError('auth', `wechat 40164: 本机出口 IP 不在公众号的 IP 白名单里，需要在公众号后台「基本配置 → IP 白名单」添加（${detail}）`);
    case 45015:
      return new ConnectorError('window_closed', `wechat 45015: 超出 48 小时客服消息窗口，用户需再次主动发消息（${detail}）`);
    case 45047:
      // The cap is per user-initiated window (5 replies), not a clock, so there is no retry-after to report.
      return new ConnectorError('rate_limited', `wechat 45047: 客服消息下行条数超过上限（${detail}）`);
    case 48001:
      return new ConnectorError('unsupported', `wechat 48001: 该公众号没有客服消息接口权限（未认证或未获得该接口）（${detail}）`);
    case 43004:
      return new ConnectorError('blocked', `wechat 43004: 对方未关注该公众号（${detail}）`);
    case 40003:
      return new ConnectorError('invalid', `wechat 40003: openid 不合法（${detail}）`);
    case 45002:
      return new ConnectorError('invalid', `wechat 45002: 消息内容超过长度上限（${detail}）`);
    case -1:
      return new ConnectorError('transient', `wechat -1: 微信系统繁忙（${detail}）`);
    default:
      return new ConnectorError('invalid', `wechat ${errcode}: ${detail}`);
  }
}

function mergeCursor(ctx: ConnectorContext, patch: Record<string, unknown>): void {
  ctx.setCursor({ ...ctx.getCursor(), ...patch });
}

/**
 * stable_token returns the account's current token instead of minting a new one, so several processes
 * can share it. force_refresh is deliberately never set: it invalidates the token other processes hold
 * and is capped at 20 calls a day.
 */
async function accessToken(ctx: ConnectorContext, bypassCache = false): Promise<string> {
  const cursor = ctx.getCursor();
  const cached = typeof cursor.wxAccessToken === 'string' ? cursor.wxAccessToken : '';
  const expiresAt = typeof cursor.wxAccessTokenExpiresAt === 'number' ? cursor.wxAccessTokenExpiresAt : 0;
  if (!bypassCache && cached !== '' && expiresAt - TOKEN_EARLY_REFRESH_MS > ctx.now()) return cached;

  const appId = (ctx.config.appId ?? '').trim();
  const appSecret = await ctx.getSecret('appSecret');
  if (appId === '') throw new ConnectorError('auth', 'AppID 未配置');
  if (!appSecret) throw new ConnectorError('auth', 'AppSecret 未配置');

  const data = await apiJson<StableTokenReply>(ctx, `${API_BASE}/cgi-bin/stable_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credential', appid: appId, secret: appSecret, force_refresh: false }),
  });
  if (typeof data.access_token !== 'string' || data.access_token === '') throw wxError(data.errcode ?? 0, data.errmsg ?? 'stable_token 未返回 access_token');
  const ttl = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : DEFAULT_TOKEN_TTL_S;
  mergeCursor(ctx, { wxAccessToken: data.access_token, wxAccessTokenExpiresAt: ctx.now() + ttl * 1000 });
  return data.access_token;
}

function queryOf(query: Record<string, string>, key: string): string {
  const value = query[key];
  return typeof value === 'string' ? value : '';
}

function textMessage(ctx: ConnectorContext, fields: Record<string, string>): InboundMessage[] {
  if (fields.MsgType !== 'text') return [];
  const from = (fields.FromUserName ?? '').trim();
  const text = fields.Content ?? '';
  if (from === '' || text === '') return [];
  const createTime = Number(fields.CreateTime);
  // MsgId is present on every ordinary text message; the composite key is a guard against a malformed push.
  const msgId = (fields.MsgId ?? '').trim() || `${from}:${fields.CreateTime ?? ''}`;
  return [
    {
      platformMsgId: msgId.slice(0, 200),
      kind: 'dm',
      threadRef: from.slice(0, 200),
      contact: { platformUserId: from.slice(0, 200) },
      text: text.slice(0, 8000),
      timestamp: Number.isFinite(createTime) && createTime > 0 ? createTime * 1000 : ctx.now(),
    },
  ];
}

export const wechatOaConnector: Connector = {
  meta: {
    kind: 'wechat_oa',
    label: '微信公众号',
    description: '微信公众号官方接口。用户给公众号发消息时微信推送到回调地址，回复通过客服消息接口发出（仅限用户最后一次发言后的 48 小时内）。',
    platforms: ['wechat'],
    canSend: true,
    canPoll: false,
    usesWebhook: true,
    oauth: null,
    untestedLive: true,
    fields: [
      { key: 'appId', label: 'AppID', required: true, placeholder: 'wx0123456789abcdef', help: '公众号后台「设置与开发 → 基本配置」里的开发者 ID。' },
      { key: 'appSecret', label: 'AppSecret', secret: true, required: true, help: '基本配置里的开发者密码。只在生成时显示一次，丢了只能重置。' },
      { key: 'token', label: 'Token（令牌）', secret: true, required: true, help: '「服务器配置」里你自己填的令牌，用于校验回调请求的签名。' },
      { key: 'encodingAesKey', label: 'EncodingAESKey', secret: true, help: '43 个字符。只有消息加解密方式选「安全模式」或「兼容模式」时才需要；明文模式留空。' },
    ],
    setupNotes:
      '需要已认证的服务号（订阅号没有客服消息接口权限，会返回 48001）。\n'
      + '1) 公众号后台「设置与开发 → 基本配置」拿到 AppID / AppSecret，并把本机的出口公网 IP 加进「IP 白名单」，否则所有接口调用返回 40164。\n'
      + '2) 同一页的「服务器配置」填 URL：{webhook 基址}/webhooks/{账号ID}，Token 自己设一串随机字符（和上面的「Token」字段填同一个），消息加解密方式建议选「安全模式」并把 EncodingAESKey 一并填进来（明文模式则留空该字段）。\n'
      + '   保存时微信会先发一次 GET 校验，服务必须已经在公网可访问。\n'
      + '3) 已知限制：只有用户主动发消息后的 48 小时内才能回复（超时返回 45015），每个窗口最多回复 5 条（超出返回 45047）；只处理文本消息，图片/语音/关注事件不会进收件箱；公众号无法主动发起对话。',
  },

  async test(ctx) {
    if ((ctx.config.appId ?? '').trim() === '') return { ok: false, detail: 'AppID 未配置' };
    if (!(await ctx.getSecret('token'))) return { ok: false, detail: '回调 Token 未配置，微信的服务器配置校验会失败' };
    const aesKey = await ctx.getSecret('encodingAesKey');
    if (aesKey && aesKey.length !== 43) return { ok: false, detail: 'EncodingAESKey 必须是 43 个字符' };
    try {
      await accessToken(ctx);
    } catch (err) {
      if (err instanceof ConnectorError) return { ok: false, detail: `获取 access_token 失败：${err.message}` };
      throw err;
    }
    return { ok: true, detail: `已取得 access_token${aesKey ? '（回调按安全模式校验）' : '（回调按明文模式校验）'}，可发客服消息；实际收发未经实测` };
  },

  async handleWebhook(ctx, req) {
    const token = await ctx.getSecret('token');
    if (!token) return { response: { status: 500, body: 'token not configured', contentType: PLAIN_TEXT }, messages: [] };
    const timestamp = queryOf(req.query, 'timestamp');
    const nonce = queryOf(req.query, 'nonce');
    const signature = queryOf(req.query, 'signature');

    if (req.method === 'GET') {
      if (!wxVerify(signature, [token, timestamp, nonce])) return { response: { status: 401, body: 'bad signature', contentType: PLAIN_TEXT }, messages: [] };
      return { response: { status: 200, body: queryOf(req.query, 'echostr'), contentType: PLAIN_TEXT }, messages: [] };
    }

    const body = req.rawBody.toString('utf8');
    let outer: Record<string, string>;
    try {
      outer = parseFlatXml(body);
    } catch {
      return { response: { status: 400, body: 'invalid xml', contentType: PLAIN_TEXT }, messages: [] };
    }

    const encrypted = outer.Encrypt ?? '';
    let fields: Record<string, string>;
    if (encrypted !== '') {
      const aesKey = await ctx.getSecret('encodingAesKey');
      if (!aesKey) return { response: { status: 500, body: 'encodingAesKey not configured', contentType: PLAIN_TEXT }, messages: [] };
      // Safe mode signs the ciphertext too, and msg_signature carries it instead of signature.
      if (!wxVerify(queryOf(req.query, 'msg_signature'), [token, timestamp, nonce, encrypted])) {
        return { response: { status: 401, body: 'bad signature', contentType: PLAIN_TEXT }, messages: [] };
      }
      let decrypted: { message: string; receiveId: string };
      try {
        decrypted = wxDecrypt(aesKey, encrypted);
      } catch {
        return { response: { status: 400, body: 'decrypt failed', contentType: PLAIN_TEXT }, messages: [] };
      }
      // receiveId pins the payload to this account: without it a body replayed from another account would be accepted.
      if (decrypted.receiveId !== (ctx.config.appId ?? '').trim()) {
        return { response: { status: 401, body: 'receiveId mismatch', contentType: PLAIN_TEXT }, messages: [] };
      }
      try {
        fields = parseFlatXml(decrypted.message);
      } catch {
        return { response: { status: 400, body: 'invalid xml', contentType: PLAIN_TEXT }, messages: [] };
      }
    } else {
      if (!wxVerify(signature, [token, timestamp, nonce])) return { response: { status: 401, body: 'bad signature', contentType: PLAIN_TEXT }, messages: [] };
      fields = outer;
    }

    // WeChat retries the push unless it sees "success" within 5 seconds, so the reply never rides on this response.
    return { response: { status: 200, body: 'success', contentType: PLAIN_TEXT }, messages: textMessage(ctx, fields) };
  },

  async send(ctx, req) {
    if (req.kind !== 'dm') throw new ConnectorError('unsupported', '公众号没有评论回复接口，只能回复用户私信');
    const touser = req.contactPlatformUserId.trim();
    const content = req.text.trim();
    if (touser === '') throw new ConnectorError('invalid', '缺少收件人 openid');
    if (content === '') throw new ConnectorError('invalid', '回复内容为空');
    const body = JSON.stringify({ touser, msgtype: 'text', text: { content } });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await accessToken(ctx, attempt > 0);
      const data = await apiJson<WxReply>(ctx, `${API_BASE}/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      const errcode = typeof data.errcode === 'number' ? data.errcode : 0;
      if (errcode === 0) break;
      // A token can die early if it was refreshed elsewhere; drop the cache and try once with a fresh one.
      if ((errcode === 40001 || errcode === 42001) && attempt === 0) {
        mergeCursor(ctx, { wxAccessToken: '', wxAccessTokenExpiresAt: 0 });
        continue;
      }
      throw wxError(errcode, data.errmsg ?? '');
    }
    // custom/send returns no message id, so de-duplication of outgoing messages stays llmsocial's own job.
    return {};
  },
};
