import { createHmac, timingSafeEqual } from 'node:crypto';
import { newId } from '../util.ts';
import { ConnectorError, type Connector } from './types.ts';

/** Local simulator. Nothing leaves the machine; used for teaching, demos and the test-suite. */
export const sandboxConnector: Connector = {
  meta: {
    kind: 'sandbox',
    label: '沙盒',
    description: '本地模拟的聊天对象。用来试技能、比较模型、跑课堂演示，不连接任何真实平台。',
    platforms: ['sandbox'],
    canSend: true,
    canPoll: false,
    canSignals: false,
    usesWebhook: false,
    oauth: null,
    untestedLive: false,
    fields: [],
    setupNotes: '',
  },
  async test() {
    return { ok: true, detail: '沙盒随时可用' };
  },
  async send() {
    return { platformMsgId: newId('sbx') };
  },
};

/**
 * For platforms without an official messaging API (personal WeChat, Xiaohongshu, Douyin personal accounts).
 * llmsocial never touches the app: the owner pastes or screenshots what they received, reviews the draft,
 * and sends it from their own phone. Every outgoing message passes through a person.
 */
export const manualConnector: Connector = {
  meta: {
    kind: 'manual',
    label: '人工桥接',
    description: '没有官方消息接口的平台（个人微信、小红书、抖音个人号）。你把收到的消息粘贴或截图导入，AI 起草，你审核后自己在手机上发。',
    platforms: ['wechat', 'xiaohongshu', 'douyin', 'other'],
    canSend: false,
    canPoll: false,
    canSignals: false,
    usesWebhook: false,
    oauth: null,
    untestedLive: false,
    fields: [],
    setupNotes: '这类账号只有「AI 起草 + 人工发送」一种模式，不支持自动发送。',
  },
  async test() {
    return { ok: true, detail: '人工桥接不需要连接' };
  },
};

function sign(secret: string, body: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Bring-your-own bridge: any system that can POST JSON (n8n, a vendor's ISV gateway, an in-house service)
 * can feed messages in and receive replies. Both directions are HMAC-signed with a shared secret.
 */
export const webhookConnector: Connector = {
  meta: {
    kind: 'webhook',
    label: '通用 Webhook',
    description: '接你自己的桥：任何能收发 JSON 的系统（n8n、服务商网关、自建服务）。双向 HMAC-SHA256 签名。',
    platforms: ['wechat', 'xiaohongshu', 'douyin', 'x', 'instagram', 'youtube', 'other'],
    canSend: true,
    canPoll: false,
    canSignals: false,
    usesWebhook: true,
    oauth: null,
    untestedLive: false,
    fields: [
      { key: 'sharedSecret', label: '共享密钥', secret: true, required: true, help: '至少 24 个字符。入站请求用它签名，出站请求也用它签名。' },
      { key: 'outboundUrl', label: '出站 URL', placeholder: 'https://bridge.example.com/llmsocial/send', help: '留空则这个账号只收不发（只能起草）。' },
    ],
    setupNotes:
      '入站：POST {webhook 基址}/webhooks/{账号ID}，请求头 X-LLMSocial-Signature: sha256=<hex(HMAC-SHA256(密钥, 原始请求体))>，请求体 {"messageId","kind":"dm|comment","threadId","contact":{"id","name"},"text","timestamp"}。出站：同样的签名头，请求体 {"conversationThreadId","contactId","kind","text","replyTo"}，返回 {"messageId"}。',
  },
  async test(ctx) {
    const secret = await ctx.getSecret('sharedSecret');
    if (!secret || secret.length < 24) return { ok: false, detail: '共享密钥未设置或少于 24 个字符' };
    return { ok: true, detail: ctx.config.outboundUrl ? '密钥已设置，可收可发' : '密钥已设置，仅接收（未配置出站 URL）' };
  },
  async handleWebhook(ctx, req) {
    const secret = await ctx.getSecret('sharedSecret');
    const given = req.headers['x-llmsocial-signature'] ?? '';
    if (!secret || !safeEqual(given, sign(secret, req.rawBody))) return { response: { status: 401, body: 'bad signature' }, messages: [] };
    if (req.method !== 'POST') return { response: { status: 405, body: 'POST only' }, messages: [] };
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(req.rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      return { response: { status: 400, body: 'invalid JSON' }, messages: [] };
    }
    const contact = (body.contact ?? {}) as Record<string, unknown>;
    const text = typeof body.text === 'string' ? body.text.slice(0, 8000) : '';
    if (typeof body.messageId !== 'string' || typeof contact.id !== 'string' || text === '') return { response: { status: 400, body: 'messageId, contact.id and text are required' }, messages: [] };
    const kind = body.kind === 'comment' ? 'comment' : 'dm';
    return {
      response: { status: 200, body: '{"ok":true}', contentType: 'application/json' },
      messages: [
        {
          platformMsgId: body.messageId.slice(0, 200),
          kind,
          threadRef: typeof body.threadId === 'string' ? body.threadId.slice(0, 200) : contact.id.slice(0, 200),
          threadTitle: typeof body.threadTitle === 'string' ? body.threadTitle.slice(0, 200) : undefined,
          contact: { platformUserId: contact.id.slice(0, 200), displayName: typeof contact.name === 'string' ? contact.name.slice(0, 100) : undefined },
          text,
          timestamp: typeof body.timestamp === 'number' ? body.timestamp : ctx.now(),
          fromSelf: body.fromSelf === true,
          replyToRef: typeof body.replyTo === 'string' ? body.replyTo.slice(0, 200) : undefined,
        },
      ],
    };
  },
  async send(ctx, req) {
    const url = ctx.config.outboundUrl;
    const secret = await ctx.getSecret('sharedSecret');
    if (!url) throw new ConnectorError('unsupported', '未配置出站 URL');
    if (!secret) throw new ConnectorError('auth', '共享密钥未设置');
    const payload = JSON.stringify({ conversationThreadId: req.threadRef, contactId: req.contactPlatformUserId, kind: req.kind, text: req.text, replyTo: req.replyToRef });
    let res: Response;
    try {
      res = await ctx.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-llmsocial-signature': sign(secret, payload) }, body: payload, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new ConnectorError('transient', `bridge unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 429) throw new ConnectorError('rate_limited', 'bridge returned 429');
    if (res.status >= 500) throw new ConnectorError('transient', `bridge returned ${res.status}`);
    if (!res.ok) throw new ConnectorError('invalid', `bridge returned ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as { messageId?: unknown };
    return { platformMsgId: typeof data.messageId === 'string' ? data.messageId : undefined };
  },
};

export { sign as signWebhookBody };
