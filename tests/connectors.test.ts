import assert from 'node:assert/strict';
import { createCipheriv, createHmac } from 'node:crypto';
import test from 'node:test';
import { instagramConnector } from '../src/server/connectors/instagram.ts';
import { accessTokenFor } from '../src/server/connectors/oauth.ts';
import { ConnectorError, type ConnectorContext, type InboundMessage, type WebhookRequest } from '../src/server/connectors/types.ts';
import { wechatOaConnector } from '../src/server/connectors/wechatOa.ts';
import { wecomKfConnector } from '../src/server/connectors/wecomKf.ts';
import { parseFlatXml, wxDecrypt, wxEncrypt, wxSignature, wxVerify } from '../src/server/connectors/wxcrypto.ts';
import { xConnector } from '../src/server/connectors/x.ts';
import { youtubeConnector } from '../src/server/connectors/youtube.ts';
import { REAL_CONNECTORS } from '../src/server/connectors/index.ts';
import type { AccountRow } from '../src/server/db/repos.ts';
import { silentLogger } from '../src/server/util.ts';

// ---------------------------------------------------------------------------
// fake ConnectorContext
// ---------------------------------------------------------------------------

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface FakeReply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

type FakeHandler = (call: FakeCall) => FakeReply;

interface Fake {
  ctx: ConnectorContext;
  calls: FakeCall[];
  notices: string[];
  cursor(): Record<string, unknown>;
  secret(field: string): string | undefined;
  setNow(ms: number): void;
}

let accountSeq = 0;

function headersOf(init: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = init.headers;
  if (raw === undefined || raw === null) return out;
  if (Array.isArray(raw)) {
    for (const [k, v] of raw) if (k !== undefined && v !== undefined) out[k.toLowerCase()] = v;
  } else if (raw instanceof Headers) {
    raw.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
  } else {
    for (const [k, v] of Object.entries(raw as Record<string, string>)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

function fake(opts: { config?: Record<string, string>; secrets?: Record<string, string>; cursor?: Record<string, unknown>; now?: number; handler?: FakeHandler } = {}): Fake {
  const calls: FakeCall[] = [];
  const notices: string[] = [];
  const secrets = new Map<string, string>(Object.entries(opts.secrets ?? {}));
  let cursor: Record<string, unknown> = { ...(opts.cursor ?? {}) };
  let now = opts.now ?? Date.UTC(2026, 8, 20, 12, 0, 0);

  const account: AccountRow = {
    id: `acct_test_${++accountSeq}`,
    name: '测试账号',
    platform: 'other',
    connector: 'webhook',
    config: opts.config ?? {},
    secretRefs: {},
    cursor: {},
    failures: 0,
    signalIntervalS: 0,
    personaId: null,
    defaultCampaignId: null,
    status: 'active',
    statusDetail: '',
    quietStart: '',
    quietEnd: '',
    timezone: 'Asia/Shanghai',
    maxPerHour: 10,
    maxPerDay: 100,
    maxPerContactDay: 5,
    pollIntervalS: 300,
    lastPolledAt: null,
    lastWebhookAt: null,
    createdAt: 0,
    updatedAt: 0,
  };

  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call: FakeCall = {
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      headers: headersOf(init),
      body: typeof init.body === 'string' ? init.body : '',
    };
    calls.push(call);
    const reply = opts.handler === undefined ? { status: 404, json: {} } : opts.handler(call);
    const status = reply.status ?? 200;
    const body = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json));
    return new Response(body, { status, headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) } });
  }) as typeof fetch;

  const ctx: ConnectorContext = {
    account,
    config: account.config,
    getSecret: async (field) => secrets.get(field) ?? null,
    setSecret: (field, value) => {
      secrets.set(field, value);
    },
    getCursor: () => cursor,
    setCursor: (next) => {
      cursor = { ...next };
    },
    now: () => now,
    log: silentLogger,
    fetch: fetchImpl,
    notice: (text) => {
      notices.push(text);
    },
  };

  return {
    ctx,
    calls,
    notices,
    cursor: () => cursor,
    secret: (field) => secrets.get(field),
    setNow: (ms) => {
      now = ms;
    },
  };
}

function webhook(over: Partial<WebhookRequest> = {}): WebhookRequest {
  return { method: 'POST', query: {}, headers: {}, rawBody: Buffer.alloc(0), ...over };
}

function xml(fields: Record<string, string>): string {
  return `<xml>${Object.entries(fields)
    .map(([k, v]) => `<${k}><![CDATA[${v}]]></${k}>`)
    .join('')}</xml>`;
}

async function connectorError(fn: () => Promise<unknown>): Promise<ConnectorError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ConnectorError) return err;
    throw new Error(`期望 ConnectorError，得到 ${String(err)}`);
  }
  throw new Error('期望抛出 ConnectorError，但没有抛出');
}

/** 43 valid base64 chars; "<key>=" decodes to exactly 32 bytes. */
const AES_KEY = 'a'.repeat(43);
const OTHER_AES_KEY = 'b'.repeat(43);

// ---------------------------------------------------------------------------
// wxcrypto
// ---------------------------------------------------------------------------

test('wxcrypto: encrypt→decrypt 往返，含 CJK 与空 receiveId', () => {
  const message = '<xml><Content><![CDATA[你好，世界 🌏]]></Content></xml>';
  const round = wxDecrypt(AES_KEY, wxEncrypt(AES_KEY, message, 'wx0123456789abcdef'));
  assert.equal(round.message, message);
  assert.equal(round.receiveId, 'wx0123456789abcdef');

  const empty = wxDecrypt(AES_KEY, wxEncrypt(AES_KEY, '', ''));
  assert.equal(empty.message, '');
  assert.equal(empty.receiveId, '');
});

test('wxcrypto: 密文被篡改 / 长度不对 / 换了密钥都抛错', () => {
  const cipher = wxEncrypt(AES_KEY, xml({ Content: 'hi' }), 'corp1');

  // Length is not a multiple of the AES block.
  assert.throws(() => wxDecrypt(AES_KEY, Buffer.from(Buffer.from(cipher, 'base64').subarray(0, 17)).toString('base64')), /multiple of the AES block/);
  assert.throws(() => wxDecrypt(AES_KEY, ''), /multiple of the AES block/);

  // Flipping the first block garbles the 4-byte length field that lives in the second block.
  const raw = Buffer.from(cipher, 'base64');
  raw[0] = (raw[0] ?? 0) ^ 0xff;
  assert.throws(() => wxDecrypt(AES_KEY, raw.toString('base64')), Error);

  // Right shape, wrong key.
  assert.throws(() => wxDecrypt(OTHER_AES_KEY, cipher), Error);

  assert.throws(() => wxDecrypt('tooshort', cipher), /43 characters/);
});

test('wxcrypto: 声明长度超出明文时抛错（手工构造的密文）', () => {
  // Built by hand so the failure is deterministic rather than a lucky garble.
  const key = Buffer.from(`${AES_KEY}=`, 'base64');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(0xffffffff, 0);
  const plain = Buffer.concat([Buffer.alloc(16, 1), len, Buffer.from('hi', 'utf8')]);
  const pad = 32 - (plain.length % 32);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const bad = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])), cipher.final()]).toString('base64');
  assert.throws(() => wxDecrypt(AES_KEY, bad), /declared message length/);
});

test('wxcrypto: 签名排序与不匹配时返回 false', () => {
  assert.equal(wxSignature(['b', 'a', 'c']), wxSignature(['c', 'b', 'a']));
  assert.ok(wxVerify(wxSignature(['tok', '123', 'nonce']), ['123', 'nonce', 'tok']));
  assert.equal(wxVerify(wxSignature(['tok', '123', 'nonce']), ['tok', '123', 'other']), false);
  assert.equal(wxVerify('', ['tok']), false);
  assert.equal(wxVerify('deadbeef', ['tok']), false);
});

test('wxcrypto: parseFlatXml 解析 CDATA、裸文本与缺失 xml 包裹', () => {
  const fields = parseFlatXml('<xml><A><![CDATA[你好]]></A><B>42</B><C></C></xml>');
  assert.deepEqual(fields, { A: '你好', B: '42', C: '' });
  assert.deepEqual(parseFlatXml('<A>1</A><B>2</B>'), { A: '1', B: '2' });
  // Last one wins; the parser deliberately does not model repeats.
  assert.deepEqual(parseFlatXml('<xml><A>1</A><A>2</A></xml>'), { A: '2' });
  assert.deepEqual(parseFlatXml('<xml></xml>'), {});
  assert.throws(() => parseFlatXml('<xml>'.concat('<A>x</A>'.repeat(20_000), '</xml>')), /64 KB/);
});

// ---------------------------------------------------------------------------
// WeChat Official Account
// ---------------------------------------------------------------------------

const OA_TOKEN = 'oa-callback-token';
const OA_APPID = 'wx0123456789abcdef';

function oaFake(extra: { handler?: FakeHandler; secrets?: Record<string, string> } = {}): Fake {
  return fake({
    config: { appId: OA_APPID },
    secrets: { token: OA_TOKEN, appSecret: 'oa-app-secret', ...(extra.secrets ?? {}) },
    handler: extra.handler,
  });
}

function oaQuery(parts: string[], extra: Record<string, string> = {}, key = 'signature'): Record<string, string> {
  return { timestamp: '1758000000', nonce: 'nonce123', [key]: wxSignature([OA_TOKEN, ...parts]), ...extra };
}

test('微信公众号: GET 校验成功返回 echostr，签名错则 401 且无消息', async () => {
  const f = oaFake();
  const ok = await wechatOaConnector.handleWebhook!(f.ctx, webhook({ method: 'GET', query: oaQuery(['1758000000', 'nonce123'], { echostr: 'CHALLENGE' }) }));
  assert.equal(ok.response.status, 200);
  assert.equal(ok.response.body, 'CHALLENGE');
  assert.equal(ok.messages.length, 0);

  const bad = await wechatOaConnector.handleWebhook!(f.ctx, webhook({ method: 'GET', query: { timestamp: '1758000000', nonce: 'nonce123', signature: 'f'.repeat(40), echostr: 'CHALLENGE' } }));
  assert.equal(bad.response.status, 401);
  assert.equal(bad.response.body, 'bad signature');
  assert.equal(bad.messages.length, 0);
});

test('微信公众号: 明文 POST 映射成一条 dm，时间戳换算成毫秒', async () => {
  const f = oaFake();
  const body = `<xml><ToUserName><![CDATA[gh_abc]]></ToUserName><FromUserName><![CDATA[oUserOpenId]]></FromUserName><CreateTime>1758000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[请问怎么报名？]]></Content><MsgId>1234567890123456</MsgId></xml>`;
  const res = await wechatOaConnector.handleWebhook!(f.ctx, webhook({ query: oaQuery(['1758000000', 'nonce123']), rawBody: Buffer.from(body, 'utf8') }));
  assert.equal(res.response.status, 200);
  assert.equal(res.response.body, 'success');
  assert.equal(res.messages.length, 1);
  const msg = res.messages[0]!;
  assert.equal(msg.platformMsgId, '1234567890123456');
  assert.equal(msg.kind, 'dm');
  assert.equal(msg.threadRef, 'oUserOpenId');
  assert.equal(msg.contact.platformUserId, 'oUserOpenId');
  assert.equal(msg.text, '请问怎么报名？');
  assert.equal(msg.timestamp, 1_758_000_000_000);
});

test('微信公众号: 关注事件变成一条线索，不是消息', async () => {
  const f = oaFake();
  const body = `<xml><ToUserName><![CDATA[gh_abc]]></ToUserName><FromUserName><![CDATA[oNewFollower]]></FromUserName><CreateTime>1758000100</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event></xml>`;
  const res = await wechatOaConnector.handleWebhook!(f.ctx, webhook({ query: oaQuery(['1758000000', 'nonce123']), rawBody: Buffer.from(body, 'utf8') }));
  assert.equal(res.response.status, 200);
  assert.equal(res.response.body, 'success');
  assert.equal(res.messages.length, 0, '关注不是一条要回复的消息');
  assert.deepEqual(res.signals, [{ kind: 'follow', platformUserId: 'oNewFollower', ref: 'sub:1758000100', timestamp: 1_758_000_100_000 }]);

  // 取关不算线索
  const gone = `<xml><FromUserName><![CDATA[oNewFollower]]></FromUserName><CreateTime>1758000200</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[unsubscribe]]></Event></xml>`;
  const res2 = await wechatOaConnector.handleWebhook!(f.ctx, webhook({ query: oaQuery(['1758000000', 'nonce123']), rawBody: Buffer.from(gone, 'utf8') }));
  assert.deepEqual(res2.signals, []);
});

test('微信公众号: 明文 POST 签名不对 → 401 且无消息', async () => {
  const f = oaFake();
  const body = `<xml><FromUserName><![CDATA[oUserOpenId]]></FromUserName><CreateTime>1758000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hi]]></Content><MsgId>1</MsgId></xml>`;
  const res = await wechatOaConnector.handleWebhook!(f.ctx, webhook({ query: { timestamp: '1758000000', nonce: 'nonce123', signature: '0'.repeat(40) }, rawBody: Buffer.from(body, 'utf8') }));
  assert.equal(res.response.status, 401);
  assert.equal(res.messages.length, 0);
});

test('微信公众号: 安全模式 POST 解密后映射；坏 msg_signature 与错 receiveId 都拒绝', async () => {
  const f = oaFake({ secrets: { encodingAesKey: AES_KEY } });
  const inner = `<xml><FromUserName><![CDATA[oSecure]]></FromUserName><CreateTime>1758000100</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[加密的问题]]></Content><MsgId>77</MsgId></xml>`;
  const encrypt = wxEncrypt(AES_KEY, inner, OA_APPID);
  const rawBody = Buffer.from(xml({ Encrypt: encrypt }), 'utf8');

  const ok = await wechatOaConnector.handleWebhook!(f.ctx, webhook({ query: oaQuery(['1758000000', 'nonce123', encrypt], {}, 'msg_signature'), rawBody }));
  assert.equal(ok.response.status, 200);
  assert.equal(ok.messages.length, 1);
  assert.equal(ok.messages[0]!.text, '加密的问题');
  assert.equal(ok.messages[0]!.platformMsgId, '77');

  const badSig = await wechatOaConnector.handleWebhook!(f.ctx, webhook({ query: { timestamp: '1758000000', nonce: 'nonce123', msg_signature: 'a'.repeat(40) }, rawBody }));
  assert.equal(badSig.response.status, 401);
  assert.equal(badSig.messages.length, 0);

  // Same ciphertext, but it was minted for a different account.
  const foreign = wxEncrypt(AES_KEY, inner, 'wxdeadbeefdeadbeef');
  const foreignBody = Buffer.from(xml({ Encrypt: foreign }), 'utf8');
  const mismatch = await wechatOaConnector.handleWebhook!(f.ctx, webhook({ query: oaQuery(['1758000000', 'nonce123', foreign], {}, 'msg_signature'), rawBody: foreignBody }));
  assert.equal(mismatch.response.status, 401);
  assert.equal(mismatch.messages.length, 0);
});

test('微信公众号: 非文本消息不进收件箱；45015 映射成 window_closed', async () => {
  const f = oaFake({ secrets: {} });
  const imageBody = `<xml><FromUserName><![CDATA[oUser]]></FromUserName><CreateTime>1758000000</CreateTime><MsgType><![CDATA[image]]></MsgType><MsgId>9</MsgId></xml>`;
  const res = await wechatOaConnector.handleWebhook!(f.ctx, webhook({ query: oaQuery(['1758000000', 'nonce123']), rawBody: Buffer.from(imageBody, 'utf8') }));
  assert.equal(res.response.status, 200);
  assert.equal(res.messages.length, 0);

  const sender = oaFake({
    handler: (call) => {
      if (call.url.includes('/cgi-bin/stable_token')) return { json: { access_token: 'OA-ACCESS-TOKEN', expires_in: 7200 } };
      return { json: { errcode: 45015, errmsg: 'response out of time limit' } };
    },
  });
  const err = await connectorError(() => wechatOaConnector.send!(sender.ctx, { kind: 'dm', threadRef: 'oUser', contactPlatformUserId: 'oUser', text: '你好', replyToRef: null }));
  assert.equal(err.code, 'window_closed');
  assert.ok(!err.message.includes('OA-ACCESS-TOKEN'));
});

// ---------------------------------------------------------------------------
// WeCom customer service
// ---------------------------------------------------------------------------

const KF_TOKEN = 'kf-callback-token';
const KF_CORP = 'ww1234567890abcdef';
const KF_OPEN = 'wk-open-kfid';

function kfEvent(now: number): { rawBody: Buffer; query: Record<string, string> } {
  const inner = xml({ ToUserName: KF_CORP, Event: 'kf_msg_or_event', Token: 'EVENT-TOKEN', OpenKfId: KF_OPEN });
  const encrypt = wxEncrypt(AES_KEY, inner, KF_CORP);
  const ts = String(Math.floor(now / 1000));
  return {
    rawBody: Buffer.from(xml({ Encrypt: encrypt }), 'utf8'),
    query: { msg_signature: wxSignature([KF_TOKEN, ts, 'n1', encrypt]), timestamp: ts, nonce: 'n1' },
  };
}

test('企业微信客服: 进入会话事件变成线索，旧事件和其它事件都不算', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const sec = Math.floor(now / 1000);
  const f = fake({
    now,
    config: { corpId: KF_CORP, openKfId: KF_OPEN },
    secrets: { token: KF_TOKEN, encodingAesKey: AES_KEY, corpSecret: 'kf-secret' },
    handler: (call) => {
      if (call.url.includes('/cgi-bin/gettoken')) return { json: { errcode: 0, access_token: 'KF-ACCESS-TOKEN', expires_in: 7200 } };
      if (call.url.includes('/cgi-bin/kf/sync_msg')) {
        return {
          json: {
            errcode: 0,
            next_cursor: 'CURSOR-1',
            has_more: 0,
            msg_list: [
              { msgid: 'e-enter', open_kfid: KF_OPEN, send_time: sec - 60, origin: 4, msgtype: 'event', event: { event_type: 'enter_session', external_userid: 'wmLead1', scene: 'video_link' } },
              { msgid: 'e-transfer', open_kfid: KF_OPEN, send_time: sec - 50, origin: 4, msgtype: 'event', event: { event_type: 'session_status_change', external_userid: 'wmLead1' } },
              { msgid: 'e-ancient', open_kfid: KF_OPEN, send_time: sec - 3 * 86_400, origin: 4, msgtype: 'event', event: { event_type: 'enter_session', external_userid: 'wmOld' } },
              { msgid: 'm-text', open_kfid: KF_OPEN, external_userid: 'wmLead1', send_time: sec - 30, origin: 3, msgtype: 'text', text: { content: '你好' } },
            ],
          },
        };
      }
      return { status: 404, json: {} };
    },
  });

  const { rawBody, query } = kfEvent(now);
  const res = await wecomKfConnector.handleWebhook!(f.ctx, webhook({ query, rawBody }));
  assert.equal(res.response.status, 200);
  assert.deepEqual(res.signals, [{ kind: 'enter_session', platformUserId: 'wmLead1', text: '来源场景：video_link', ref: 'e-enter', timestamp: (sec - 60) * 1000 }]);
  // 消息照常收，信号不影响消息那一路
  assert.deepEqual(res.messages.map((m) => m.platformMsgId), ['m-text']);
});

test('企业微信客服: 回调解密后用 sync_msg 拉取，只收 origin 3/5 并标注 fromSelf', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const sec = Math.floor(now / 1000);
  const f = fake({
    now,
    config: { corpId: KF_CORP, openKfId: KF_OPEN },
    secrets: { token: KF_TOKEN, encodingAesKey: AES_KEY, corpSecret: 'kf-secret' },
    handler: (call) => {
      if (call.url.includes('/cgi-bin/gettoken')) return { json: { errcode: 0, access_token: 'KF-ACCESS-TOKEN', expires_in: 7200 } };
      if (call.url.includes('/cgi-bin/kf/sync_msg')) {
        return {
          json: {
            errcode: 0,
            next_cursor: 'CURSOR-1',
            has_more: 0,
            msg_list: [
              { msgid: 'm-customer', open_kfid: KF_OPEN, external_userid: 'wmUser1', send_time: sec - 60, origin: 3, msgtype: 'text', text: { content: '在吗？' } },
              { msgid: 'm-servicer', open_kfid: KF_OPEN, external_userid: 'wmUser1', send_time: sec - 30, origin: 5, servicer_userid: 'zhangsan', msgtype: 'text', text: { content: '在的' } },
              { msgid: 'm-system', open_kfid: KF_OPEN, external_userid: 'wmUser1', send_time: sec - 20, origin: 4, msgtype: 'text', text: { content: '会话已转接' } },
              { msgid: 'm-image', open_kfid: KF_OPEN, external_userid: 'wmUser1', send_time: sec - 10, origin: 3, msgtype: 'image' },
              { msgid: 'm-ancient', open_kfid: KF_OPEN, external_userid: 'wmUser1', send_time: sec - 3 * 86_400, origin: 3, msgtype: 'text', text: { content: '三天前的历史消息' } },
            ],
          },
        };
      }
      return { status: 404, json: {} };
    },
  });

  const { rawBody, query } = kfEvent(now);
  const res = await wecomKfConnector.handleWebhook!(f.ctx, webhook({ query, rawBody }));
  assert.equal(res.response.status, 200);
  assert.equal(res.response.body, 'success');
  assert.deepEqual(
    res.messages.map((m: InboundMessage) => [m.platformMsgId, m.kind, m.threadRef, m.text, m.fromSelf === true]),
    [
      ['m-customer', 'dm', 'wmUser1', '在吗？', false],
      ['m-servicer', 'dm', 'wmUser1', '在的', true],
    ],
  );
  assert.equal(res.messages[0]!.timestamp, (sec - 60) * 1000);
  assert.equal(f.cursor().syncCursor, 'CURSOR-1');
  // The call carried the callback token, which lifts sync_msg's own rate limit.
  const sync = f.calls.find((c) => c.url.includes('sync_msg'))!;
  assert.equal(JSON.parse(sync.body).token, 'EVENT-TOKEN');
});

test('企业微信客服: GET 校验回显解密后的 echostr；签名错 / corp 不符都拒绝', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const base = { corpId: KF_CORP, openKfId: KF_OPEN };
  const secrets = { token: KF_TOKEN, encodingAesKey: AES_KEY, corpSecret: 'kf-secret' };
  const f = fake({ now, config: base, secrets });

  const echostr = wxEncrypt(AES_KEY, 'ECHO-PLAIN', KF_CORP);
  const ok = await wecomKfConnector.handleWebhook!(
    f.ctx,
    webhook({ method: 'GET', query: { msg_signature: wxSignature([KF_TOKEN, '1758000000', 'n1', echostr]), timestamp: '1758000000', nonce: 'n1', echostr } }),
  );
  assert.equal(ok.response.status, 200);
  assert.equal(ok.response.body, 'ECHO-PLAIN');

  const bad = await wecomKfConnector.handleWebhook!(f.ctx, webhook({ method: 'GET', query: { msg_signature: 'b'.repeat(40), timestamp: '1758000000', nonce: 'n1', echostr } }));
  assert.equal(bad.response.status, 401);

  const g = fake({ now, config: base, secrets });
  const foreign = wxEncrypt(AES_KEY, xml({ Event: 'kf_msg_or_event', Token: 'T', OpenKfId: KF_OPEN }), 'wwOTHERCORP');
  const res = await wecomKfConnector.handleWebhook!(
    g.ctx,
    webhook({ query: { msg_signature: wxSignature([KF_TOKEN, '1758000000', 'n1', foreign]), timestamp: '1758000000', nonce: 'n1' }, rawBody: Buffer.from(xml({ Encrypt: foreign }), 'utf8') }),
  );
  assert.equal(res.response.status, 401);
  assert.equal(res.messages.length, 0);
  assert.equal(g.calls.length, 0);
});

test('企业微信客服: 95002 映射成 window_closed，40014 触发一次换 token 重试', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const f = fake({
    now,
    config: { corpId: KF_CORP, openKfId: KF_OPEN },
    secrets: { token: KF_TOKEN, encodingAesKey: AES_KEY, corpSecret: 'kf-secret' },
    handler: (call) => {
      if (call.url.includes('/cgi-bin/gettoken')) return { json: { errcode: 0, access_token: 'KF-ACCESS-TOKEN', expires_in: 7200 } };
      return { json: { errcode: 95002, errmsg: 'out of 48h window' } };
    },
  });
  const err = await connectorError(() => wecomKfConnector.send!(f.ctx, { kind: 'dm', threadRef: 'wmUser1', contactPlatformUserId: 'wmUser1', text: '你好', replyToRef: null }));
  assert.equal(err.code, 'window_closed');
  assert.ok(!err.message.includes('KF-ACCESS-TOKEN'));
  assert.ok(!err.message.includes('kf-secret'));

  let sends = 0;
  const g = fake({
    now,
    config: { corpId: KF_CORP, openKfId: KF_OPEN },
    secrets: { token: KF_TOKEN, encodingAesKey: AES_KEY, corpSecret: 'kf-secret' },
    handler: (call) => {
      if (call.url.includes('/cgi-bin/gettoken')) return { json: { errcode: 0, access_token: `KF-TOKEN-${sends}`, expires_in: 7200 } };
      sends += 1;
      return sends === 1 ? { json: { errcode: 42001, errmsg: 'access_token expired' } } : { json: { errcode: 0, msgid: 'sent-1' } };
    },
  });
  const sent = await wecomKfConnector.send!(g.ctx, { kind: 'dm', threadRef: 'wmUser1', contactPlatformUserId: 'wmUser1', text: '你好', replyToRef: null });
  assert.equal(sent.platformMsgId, 'sent-1');
  assert.equal(g.calls.filter((c) => c.url.includes('gettoken')).length, 2);
});

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

const IG_APP_SECRET = 'ig-app-secret';

function igSign(body: Buffer): string {
  return `sha256=${createHmac('sha256', IG_APP_SECRET).update(body).digest('hex')}`;
}

test('Instagram: webhook GET 校验；POST 签名通过则映射私信与评论，签名错则 401 且无消息', async () => {
  const f = fake({
    config: { verifyToken: 'VERIFY-ME' },
    secrets: { accessToken: 'IG-LONG-LIVED-TOKEN', appSecret: IG_APP_SECRET },
    cursor: { igUserId: 'igSelf', lastRefreshAt: Date.UTC(2026, 8, 20, 0, 0, 0) },
  });

  const verify = await instagramConnector.handleWebhook!(f.ctx, webhook({ method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'VERIFY-ME', 'hub.challenge': '98765' } }));
  assert.equal(verify.response.status, 200);
  assert.equal(verify.response.body, '98765');

  const wrong = await instagramConnector.handleWebhook!(f.ctx, webhook({ method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'NOPE', 'hub.challenge': '98765' } }));
  assert.equal(wrong.response.status, 403);

  const payload = Buffer.from(
    JSON.stringify({
      entry: [
        {
          time: 1_758_000_000,
          messaging: [
            { sender: { id: 'igFan' }, recipient: { id: 'igSelf' }, timestamp: 1_758_000_001_000, message: { mid: 'mid-1', text: '有折扣吗？' } },
            { sender: { id: 'igSelf' }, recipient: { id: 'igFan' }, timestamp: 1_758_000_002_000, message: { mid: 'mid-2', text: '有的', is_echo: true } },
          ],
          changes: [{ field: 'comments', value: { id: 'c-1', text: '好看', from: { id: 'igFan', username: 'fan' }, media: { id: 'media-1' }, timestamp: '2026-09-20T07:11:07+0000' } }],
        },
      ],
    }),
    'utf8',
  );

  const ok = await instagramConnector.handleWebhook!(f.ctx, webhook({ rawBody: payload, headers: { 'x-hub-signature-256': igSign(payload) } }));
  assert.equal(ok.response.status, 200);
  assert.equal(ok.messages.length, 3);
  assert.equal(ok.messages[0]!.platformMsgId, 'mid-1');
  assert.equal(ok.messages[0]!.kind, 'dm');
  assert.equal(ok.messages[0]!.contact.platformUserId, 'igFan');
  assert.equal(ok.messages[0]!.fromSelf, false);
  assert.equal(ok.messages[1]!.fromSelf, true);
  assert.equal(ok.messages[1]!.threadRef, 'igFan');
  assert.equal(ok.messages[2]!.kind, 'comment');
  assert.equal(ok.messages[2]!.threadRef, 'media-1');
  assert.equal(ok.messages[2]!.replyToRef, 'c-1');
  // "+0000" has to survive Date.parse.
  assert.equal(ok.messages[2]!.timestamp, Date.parse('2026-09-20T07:11:07Z'));

  const bad = await instagramConnector.handleWebhook!(f.ctx, webhook({ rawBody: payload, headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` } }));
  assert.equal(bad.response.status, 401);
  assert.equal(bad.messages.length, 0);

  const unsigned = await instagramConnector.handleWebhook!(f.ctx, webhook({ rawBody: payload }));
  assert.equal(unsigned.response.status, 401);
  assert.equal(unsigned.messages.length, 0);
});

test('Instagram: 24 小时私信窗口错误 (10/2534022) → window_closed；配额码 → rate_limited', async () => {
  const f = fake({
    secrets: { accessToken: 'IG-LONG-LIVED-TOKEN' },
    cursor: { igUserId: 'igSelf', lastRefreshAt: Date.UTC(2026, 8, 20, 0, 0, 0) },
    handler: () => ({
      status: 400,
      json: { error: { message: 'This message is sent outside of allowed window.', code: 10, error_subcode: 2534022, type: 'OAuthException' } },
    }),
  });
  const err = await connectorError(() => instagramConnector.send!(f.ctx, { kind: 'dm', threadRef: 't', contactPlatformUserId: 'igFan', text: '晚了', replyToRef: null }));
  assert.equal(err.code, 'window_closed');
  assert.ok(!err.message.includes('IG-LONG-LIVED-TOKEN'));
  assert.equal(f.calls[0]!.headers.authorization, 'Bearer IG-LONG-LIVED-TOKEN');

  const g = fake({
    secrets: { accessToken: 'IG-LONG-LIVED-TOKEN' },
    cursor: { igUserId: 'igSelf', lastRefreshAt: Date.UTC(2026, 8, 20, 0, 0, 0) },
    handler: () => ({
      status: 400,
      json: { error: { message: 'Application request limit reached', code: 4 } },
      headers: { 'x-business-use-case-usage': JSON.stringify({ '123': [{ call_count: 100, estimated_time_to_regain_access: 11 }] }) },
    }),
  });
  const limited = await connectorError(() => instagramConnector.send!(g.ctx, { kind: 'comment', threadRef: 'media-1', contactPlatformUserId: 'igFan', text: '谢谢', replyToRef: 'c-1' }));
  assert.equal(limited.code, 'rate_limited');
  assert.equal(limited.retryAfterMs, 11 * 60_000);
});

test('Instagram: 首次 poll 只取 24 小时内，并推进游标', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', '+0000');
  const f = fake({
    now,
    secrets: { accessToken: 'IG-LONG-LIVED-TOKEN' },
    cursor: { igUserId: 'igSelf', username: 'mybrand', lastRefreshAt: now - 3_600_000 },
    handler: (call) => {
      if (call.url.includes('/me/conversations')) {
        return {
          json: {
            data: [
              {
                id: 'conv-1',
                updated_time: iso(now - 3_600_000),
                participants: { data: [{ id: 'igSelf', username: 'mybrand' }, { id: 'igFan', username: 'fan' }] },
                messages: {
                  data: [
                    { id: 'dm-new', created_time: iso(now - 3_600_000), from: { id: 'igFan', username: 'fan' }, to: { data: [{ id: 'igSelf' }] }, message: '新私信' },
                    { id: 'dm-old', created_time: iso(now - 3 * 86_400_000), from: { id: 'igFan', username: 'fan' }, to: { data: [{ id: 'igSelf' }] }, message: '三天前的历史私信' },
                  ],
                },
              },
            ],
          },
        };
      }
      if (call.url.includes('/me/media')) return { json: { data: [{ id: 'media-1', caption: '新品', comments_count: 2, timestamp: iso(now - 7_200_000) }] } };
      if (call.url.includes('/media-1/comments')) {
        return {
          json: {
            data: [
              { id: 'c-new', text: '想要', username: 'fan', from: { id: 'igFan', username: 'fan' }, timestamp: iso(now - 1_800_000) },
              { id: 'c-mine', text: '已私信你', username: 'mybrand', from: { id: 'igSelf', username: 'mybrand' }, timestamp: iso(now - 1_700_000) },
              { id: 'c-old', text: '一周前', username: 'fan', from: { id: 'igFan', username: 'fan' }, timestamp: iso(now - 7 * 86_400_000) },
            ],
          },
        };
      }
      return { status: 404, json: {} };
    },
  });

  const msgs = await instagramConnector.poll!(f.ctx);
  assert.deepEqual(msgs.map((m) => m.platformMsgId).sort(), ['c-mine', 'c-new', 'dm-new']);
  assert.equal(msgs.find((m) => m.platformMsgId === 'c-mine')!.fromSelf, true);
  assert.equal(msgs.find((m) => m.platformMsgId === 'dm-new')!.contact.platformUserId, 'igFan');
  const cursor = f.cursor();
  assert.equal(cursor.lastDmAt, now - 3_600_000);
  assert.equal(cursor.lastCommentAt, now - 1_700_000);
  assert.equal(typeof cursor.seedAt, 'number');
  // The cursor keys the poll wrote must not have eaten the token bookkeeping.
  assert.equal(cursor.igUserId, 'igSelf');

  // A second poll with the advanced cursor brings back nothing new.
  const again = await instagramConnector.poll!(f.ctx);
  assert.equal(again.length, 0);
});

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

function ytFake(now: number, handler: FakeHandler, cursor: Record<string, unknown> = {}): Fake {
  return fake({
    now,
    config: { clientId: 'yt-client-id' },
    secrets: { accessToken: 'YT-ACCESS-TOKEN', refreshToken: 'yt-refresh', clientSecret: 'yt-client-secret' },
    cursor: { tokenExpiresAt: now + 3_600_000, ...cursor },
    handler,
  });
}

test('YouTube: 首次 poll 截断到 24 小时，标注 fromSelf，并推进游标', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const iso = (ms: number): string => new Date(ms).toISOString();
  const f = ytFake(now, (call) => {
    if (call.url.includes('/channels?')) return { json: { items: [{ id: 'UCself', snippet: { title: '我的频道' } }] } };
    if (call.url.includes('/commentThreads')) {
      return {
        json: {
          items: [
            {
              id: 'thread-1',
              snippet: {
                videoId: 'vid1',
                topLevelComment: { id: 'thread-1', snippet: { textOriginal: '最近的评论', authorDisplayName: '观众甲', authorChannelId: { value: 'UCviewer' }, publishedAt: iso(now - 3_600_000) } },
              },
              replies: {
                comments: [{ id: 'reply-1', snippet: { textOriginal: '谢谢支持', authorDisplayName: '我的频道', authorChannelId: { value: 'UCself' }, publishedAt: iso(now - 1_800_000) } }],
              },
            },
            {
              id: 'thread-old',
              snippet: {
                videoId: 'vid0',
                topLevelComment: { id: 'thread-old', snippet: { textOriginal: '三天前的评论', authorDisplayName: '观众乙', authorChannelId: { value: 'UCviewer2' }, publishedAt: iso(now - 3 * 86_400_000) } },
              },
            },
          ],
          nextPageToken: 'PAGE2',
        },
      };
    }
    return { status: 404, json: {} };
  });

  const msgs = await youtubeConnector.poll!(f.ctx);
  assert.deepEqual(
    msgs.map((m) => [m.platformMsgId, m.kind, m.threadRef, m.fromSelf === true]),
    [
      ['thread-1', 'comment', 'thread-1', false],
      ['reply-1', 'comment', 'thread-1', true],
    ],
  );
  assert.equal(msgs[0]!.threadTitle, '视频 vid1');
  assert.equal(msgs[0]!.replyToRef, 'thread-1');
  assert.equal(msgs[0]!.timestamp, now - 3_600_000);
  assert.equal(f.cursor().lastPublishedAt, now - 1_800_000);
  assert.equal(f.cursor().channelId, 'UCself');
  // Newest-first: hitting a thread older than the cutoff stops the walk, so page 2 is never fetched.
  assert.equal(f.calls.filter((c) => c.url.includes('commentThreads')).length, 1);

  const again = await youtubeConnector.poll!(f.ctx);
  assert.equal(again.length, 0);
});

test('YouTube: poll 最多翻 3 页', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const iso = (ms: number): string => new Date(ms).toISOString();
  let page = 0;
  const f = ytFake(
    now,
    (call) => {
      if (call.url.includes('/channels?')) return { json: { items: [{ id: 'UCself' }] } };
      page += 1;
      return {
        json: {
          items: [{ id: `t${page}`, snippet: { videoId: 'v', topLevelComment: { id: `t${page}`, snippet: { textOriginal: `评论 ${page}`, authorChannelId: { value: 'UCviewer' }, publishedAt: iso(now - page * 1000) } } } }],
          nextPageToken: `P${page + 1}`,
        },
      };
    },
    { channelId: 'UCself' },
  );
  const msgs = await youtubeConnector.poll!(f.ctx);
  assert.equal(msgs.length, 3);
  assert.equal(f.calls.filter((c) => c.url.includes('commentThreads')).length, 3);
});

test('YouTube: quotaExceeded → rate_limited 并给出到太平洋午夜的等待时间', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const f = ytFake(now, () => ({ status: 403, json: { error: { code: 403, message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }] } } }), { channelId: 'UCself' });
  const err = await connectorError(() => youtubeConnector.poll!(f.ctx));
  assert.equal(err.code, 'rate_limited');
  assert.ok((err.retryAfterMs ?? 0) > 60_000, `retryAfterMs=${String(err.retryAfterMs)}`);
  assert.ok(!err.message.includes('YT-ACCESS-TOKEN'));

  const g = ytFake(now, () => ({ status: 403, json: { error: { errors: [{ reason: 'forbidden' }] } } }), { channelId: 'UCself' });
  assert.equal((await connectorError(() => youtubeConnector.poll!(g.ctx))).code, 'blocked');

  const h = ytFake(now, () => ({ status: 401, json: { error: { errors: [{ reason: 'authError' }] } } }), { channelId: 'UCself' });
  assert.equal((await connectorError(() => youtubeConnector.poll!(h.ctx))).code, 'auth');
});

test('YouTube: 回复评论用 comments.insert，私信被拒为 unsupported', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const f = ytFake(now, () => ({ json: { id: 'new-reply-id' } }), { channelId: 'UCself' });
  const sent = await youtubeConnector.send!(f.ctx, { kind: 'comment', threadRef: 'thread-1', contactPlatformUserId: 'UCviewer', text: '谢谢', replyToRef: 'thread-1' });
  assert.equal(sent.platformMsgId, 'new-reply-id');
  assert.equal(JSON.parse(f.calls[0]!.body).snippet.parentId, 'thread-1');

  const g = ytFake(now, () => ({ json: {} }), { channelId: 'UCself' });
  assert.equal((await connectorError(() => youtubeConnector.send!(g.ctx, { kind: 'dm', threadRef: 't', contactPlatformUserId: 'u', text: 'hi', replyToRef: null }))).code, 'unsupported');
});

// ---------------------------------------------------------------------------
// X
// ---------------------------------------------------------------------------

function xFake(now: number, handler: FakeHandler, cursor: Record<string, unknown> = {}): Fake {
  return fake({
    now,
    config: { clientId: 'x-client-id' },
    secrets: { accessToken: 'X-ACCESS-TOKEN', refreshToken: 'x-refresh', clientSecret: 'x-client-secret' },
    cursor: { tokenExpiresAt: now + 3_600_000, userId: 'selfId', ...cursor },
    handler,
  });
}

test('X: 提及与私信都映射，fromSelf 与游标正确', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const iso = (ms: number): string => new Date(ms).toISOString();
  const f = xFake(now, (call) => {
    if (call.url.includes('/mentions')) {
      return {
        json: {
          data: [{ id: '1900000000000000002', text: '@brand 在吗', created_at: iso(now - 600_000), author_id: 'fanId', conversation_id: '1900000000000000001' }],
          includes: { users: [{ id: 'fanId', username: 'fan', name: '粉丝甲' }] },
          meta: { result_count: 1 },
        },
      };
    }
    if (call.url.includes('/2/dm_events')) {
      return {
        json: {
          data: [
            { id: '1800000000000000009', event_type: 'MessageCreate', text: '私信内容', created_at: iso(now - 300_000), sender_id: 'fanId', dm_conversation_id: 'conv-1' },
            { id: '1800000000000000010', event_type: 'MessageCreate', text: '我已回复', created_at: iso(now - 200_000), sender_id: 'selfId', dm_conversation_id: 'conv-1' },
          ],
          includes: { users: [{ id: 'fanId', username: 'fan', name: '粉丝甲' }] },
          meta: {},
        },
      };
    }
    return { status: 404, json: {} };
  });

  const msgs = await xConnector.poll!(f.ctx);
  assert.equal(msgs.length, 3);
  const mention = msgs.find((m) => m.platformMsgId === 'tw:1900000000000000002')!;
  assert.equal(mention.kind, 'comment');
  assert.equal(mention.threadRef, '1900000000000000001');
  assert.equal(mention.replyToRef, '1900000000000000002');
  assert.equal(mention.contact.handle, '@fan');
  assert.equal(mention.contact.displayName, '粉丝甲');
  assert.equal(mention.fromSelf, false);
  assert.equal(mention.timestamp, now - 600_000);

  const dm = msgs.find((m) => m.platformMsgId === 'dm:1800000000000000009')!;
  assert.equal(dm.kind, 'dm');
  assert.equal(dm.threadRef, 'conv-1');
  assert.equal(msgs.find((m) => m.platformMsgId === 'dm:1800000000000000010')!.fromSelf, true);
  // Sorted oldest first.
  assert.deepEqual([...msgs].map((m) => m.timestamp), [...msgs].map((m) => m.timestamp).sort((a, b) => a - b));

  assert.equal(f.cursor().mentionsSinceId, '1900000000000000002');
  assert.equal(f.cursor().dmLastEventId, '1800000000000000010');
  assert.equal(f.cursor().tokenExpiresAt, now + 3_600_000);

  // First poll has no cursor, so it must ask for a 24h start_time rather than the whole timeline.
  const mentionUrl = new URL(f.calls.find((c) => c.url.includes('/mentions'))!.url);
  assert.equal(mentionUrl.searchParams.get('start_time'), new Date(now - 86_400_000).toISOString());
  assert.equal(mentionUrl.searchParams.get('since_id'), null);
});

test('X: 私信 403 不影响提及，并在 6 小时内跳过私信', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const iso = (ms: number): string => new Date(ms).toISOString();
  let dmCalls = 0;
  const f = xFake(now, (call) => {
    if (call.url.includes('/mentions')) {
      // since_id is honoured the way the platform does it: nothing newer than the cursor.
      if (new URL(call.url).searchParams.get('since_id') !== null) return { json: { data: [], meta: { result_count: 0 } } };
      return {
        json: {
          data: [{ id: '1900000000000000002', text: '@brand 在吗', created_at: iso(now - 600_000), author_id: 'fanId', conversation_id: '1900000000000000001' }],
          includes: { users: [{ id: 'fanId', username: 'fan' }] },
        },
      };
    }
    if (call.url.includes('/2/dm_events')) {
      dmCalls += 1;
      return { status: 403, json: { title: 'Unsupported Authentication', detail: 'your plan does not include DM access' } };
    }
    return { status: 404, json: {} };
  });

  const msgs = await xConnector.poll!(f.ctx);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]!.platformMsgId, 'tw:1900000000000000002');
  assert.equal(dmCalls, 1);
  assert.equal(f.cursor().mentionsSinceId, '1900000000000000002');
  assert.ok((f.cursor().dmDisabledUntil as number) > now);
  // 以前这里只写一行日志，账号看起来就是「没人私信」。现在要让操作者看得见。
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0]!, /私信要 Pro/);

  // Next poll inside the backoff window does not touch the DM endpoint again.
  const second = await xConnector.poll!(f.ctx);
  assert.equal(second.length, 0);
  assert.equal(dmCalls, 1);
  assert.equal(f.notices.length, 1, '退避期内不重复提示');
});

test('X: 429 映射成 rate_limited 并带上 retry-after；错误里没有令牌', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const f = xFake(now, () => ({ status: 429, text: '{"title":"Too Many Requests"}', headers: { 'retry-after': '45' } }));
  const err = await connectorError(() => xConnector.poll!(f.ctx));
  assert.equal(err.code, 'rate_limited');
  assert.equal(err.retryAfterMs, 45_000);
  assert.ok(!err.message.includes('X-ACCESS-TOKEN'));
});

test('X: 私信也最多翻 3 页', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const iso = (ms: number): string => new Date(ms).toISOString();
  let dmPages = 0;
  const f = xFake(now, (call) => {
    if (call.url.includes('/mentions')) return { json: { data: [] } };
    dmPages += 1;
    return {
      json: {
        data: [{ id: `18000000000000000${10 + dmPages}`, text: `第 ${dmPages} 页`, created_at: iso(now - dmPages * 1000), sender_id: 'fanId', dm_conversation_id: 'conv-1' }],
        meta: { next_token: `P${dmPages}` },
      },
    };
  });
  const msgs = await xConnector.poll!(f.ctx);
  assert.equal(dmPages, 3);
  assert.equal(msgs.length, 3);
});

test('企业微信客服: 超长中文按 UTF-8 边界截到 2048 字节，不产生替换字符', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const f = fake({
    now,
    config: { corpId: KF_CORP, openKfId: KF_OPEN },
    secrets: { token: KF_TOKEN, encodingAesKey: AES_KEY, corpSecret: 'kf-secret' },
    handler: (call) => (call.url.includes('/cgi-bin/gettoken') ? { json: { errcode: 0, access_token: 'T', expires_in: 7200 } } : { json: { errcode: 0, msgid: 'ok' } }),
  });
  // 3 bytes per char, so the cut lands mid-character unless the connector rounds down.
  await wecomKfConnector.send!(f.ctx, { kind: 'dm', threadRef: 'w', contactPlatformUserId: 'w', text: '好'.repeat(1000), replyToRef: null });
  const sent = f.calls.find((c) => c.url.includes('send_msg'))!;
  const content = JSON.parse(sent.body).text.content as string;
  assert.ok(Buffer.byteLength(content, 'utf8') <= 2048, `实际 ${Buffer.byteLength(content, 'utf8')} 字节`);
  assert.equal(content, '好'.repeat(682));
  assert.ok(!content.includes('�'));
});

test('Instagram: 评论分页最多 3 页', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', '+0000');
  let pages = 0;
  const f = fake({
    now,
    secrets: { accessToken: 'IG-LONG-LIVED-TOKEN' },
    cursor: { igUserId: 'igSelf', lastRefreshAt: now - 3_600_000, seedAt: now - 3_600_000, lastDmAt: now, lastCommentAt: now - 7_200_000 },
    handler: (call) => {
      if (call.url.includes('/me/conversations')) return { json: { data: [] } };
      if (call.url.includes('/me/media')) return { json: { data: [{ id: 'media-1', comments_count: 99, timestamp: iso(now - 7_200_000) }] } };
      if (call.url.includes('/media-1/comments')) {
        pages += 1;
        return {
          json: {
            data: [{ id: `c-${pages}`, text: `第 ${pages} 页`, username: 'fan', from: { id: 'igFan', username: 'fan' }, timestamp: iso(now - pages * 1000) }],
            paging: { next: 'https://graph.instagram.com/next', cursors: { after: `AFTER-${pages}` } },
          },
        };
      }
      return { status: 404, json: {} };
    },
  });
  const msgs = await instagramConnector.poll!(f.ctx);
  assert.equal(pages, 3);
  assert.equal(msgs.length, 3);
  // Page 2 and 3 must be requested with the cursor the previous page handed back.
  const urls = f.calls.filter((c) => c.url.includes('/media-1/comments')).map((c) => new URL(c.url).searchParams.get('after'));
  assert.deepEqual(urls, [null, 'AFTER-1', 'AFTER-2']);
});

// ---------------------------------------------------------------------------
// oauth
// ---------------------------------------------------------------------------

test('oauth: 并发两次 accessTokenFor 只触发一次刷新，且轮换后的 refresh token 被持久化', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  let refreshes = 0;
  const f = fake({
    now,
    config: { clientId: 'x-client-id' },
    secrets: { accessToken: 'OLD-ACCESS', refreshToken: 'OLD-REFRESH', clientSecret: 'x-client-secret' },
    cursor: { tokenExpiresAt: now - 1000, userId: 'selfId' },
    handler: (call) => {
      assert.ok(call.url.includes('/2/oauth2/token'));
      refreshes += 1;
      return { json: { access_token: 'NEW-ACCESS', refresh_token: 'NEW-REFRESH', expires_in: 7200, token_type: 'bearer' } };
    },
  });

  const [a, b] = await Promise.all([accessTokenFor(f.ctx, 'x'), accessTokenFor(f.ctx, 'x')]);
  assert.equal(a, 'NEW-ACCESS');
  assert.equal(b, 'NEW-ACCESS');
  assert.equal(refreshes, 1);
  assert.equal(f.secret('accessToken'), 'NEW-ACCESS');
  assert.equal(f.secret('refreshToken'), 'NEW-REFRESH');
  assert.equal(f.cursor().tokenExpiresAt, now + 7_200_000);
  // Unrelated cursor keys survive the merge.
  assert.equal(f.cursor().userId, 'selfId');

  // Still valid: no further network call.
  assert.equal(await accessTokenFor(f.ctx, 'x'), 'NEW-ACCESS');
  assert.equal(refreshes, 1);
});

test('oauth: 从没授权过的账号报「还没授权」，不说「重新授权」', async () => {
  const f = fake({ config: { clientId: 'yt-client-id' }, secrets: { clientSecret: 'yt-client-secret' } });
  const err = await connectorError(() => accessTokenFor(f.ctx, 'google'));
  assert.equal(err.code, 'auth');
  assert.match(err.message, /还没授权/);
  assert.doesNotMatch(err.message, /重新授权/);
});

test('oauth: 连不上令牌接口时说清楚是哪台服务器、什么网络错误、下一步怎么办', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const f = fake({
    now,
    config: { clientId: 'yt-client-id' },
    secrets: { accessToken: 'OLD-ACCESS', refreshToken: 'LEAKY-REFRESH-0123', clientSecret: 'LEAKY-SECRET-0123' },
    cursor: { tokenExpiresAt: now - 1000 },
  });
  // What undici throws when the machine can reach the platform only through a VPN the process does not use.
  f.ctx.fetch = (async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
  }) as typeof fetch;
  const err = await connectorError(() => accessTokenFor(f.ctx, 'google'));
  assert.equal(err.code, 'transient');
  assert.match(err.message, /oauth2\.googleapis\.com/);
  assert.match(err.message, /UND_ERR_CONNECT_TIMEOUT/);
  assert.match(err.message, /设置 → 网络代理/);
  assert.ok(!err.message.includes('LEAKY'), '报错里不能带出令牌或密钥');
});

test('oauth: Google 不回传 refresh_token 时保留旧的；刷新失败映射成 auth', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const f = fake({
    now,
    config: { clientId: 'yt-client-id' },
    secrets: { accessToken: 'OLD-ACCESS', refreshToken: 'KEEP-ME', clientSecret: 'yt-client-secret' },
    cursor: { tokenExpiresAt: now - 1000 },
    handler: () => ({ json: { access_token: 'NEW-ACCESS', expires_in: 3599 } }),
  });
  assert.equal(await accessTokenFor(f.ctx, 'google'), 'NEW-ACCESS');
  assert.equal(f.secret('refreshToken'), 'KEEP-ME');

  const g = fake({
    now,
    config: { clientId: 'yt-client-id' },
    secrets: { accessToken: 'OLD-ACCESS', refreshToken: 'DEAD-REFRESH', clientSecret: 'yt-client-secret' },
    cursor: { tokenExpiresAt: now - 1000 },
    handler: () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }),
  });
  const err = await connectorError(() => accessTokenFor(g.ctx, 'google'));
  assert.equal(err.code, 'auth');
  assert.ok(!err.message.includes('DEAD-REFRESH'));
  assert.ok(!err.message.includes('yt-client-secret'));

  const h = fake({
    now,
    config: { clientId: 'yt-client-id' },
    secrets: { accessToken: 'OLD-ACCESS', clientSecret: 'yt-client-secret' },
    cursor: { tokenExpiresAt: now - 1000 },
    handler: () => ({ json: {} }),
  });
  assert.equal((await connectorError(() => accessTokenFor(h.ctx, 'google'))).code, 'auth');
  assert.equal(h.calls.length, 0);
});

// ---------------------------------------------------------------------------
// cross-cutting
// ---------------------------------------------------------------------------

test('所有连接器: meta 自洽，untestedLive 为 true，setupNotes 非空', () => {
  assert.deepEqual(REAL_CONNECTORS.map((c) => c.meta.kind), ['youtube', 'x', 'instagram', 'wechat_oa', 'wecom_kf']);
  for (const connector of REAL_CONNECTORS) {
    const { meta } = connector;
    assert.equal(meta.untestedLive, true, `${meta.kind}.untestedLive`);
    assert.ok(meta.setupNotes.length > 50, `${meta.kind}.setupNotes 太短`);
    assert.equal(meta.canPoll, typeof connector.poll === 'function', `${meta.kind}.canPoll 与 poll() 不一致`);
    assert.equal(meta.canSend, typeof connector.send === 'function', `${meta.kind}.canSend 与 send() 不一致`);
    assert.equal(meta.usesWebhook, typeof connector.handleWebhook === 'function', `${meta.kind}.usesWebhook 与 handleWebhook() 不一致`);
    assert.ok(meta.platforms.length > 0, `${meta.kind}.platforms 为空`);
    for (const field of meta.fields) assert.ok(field.label !== '', `${meta.kind}.${field.key} 缺少 label`);
  }
});

test('所有连接器: 抛出的错误里不含 Authorization 值或 access token', async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const LEAK = 'LEAKY-TOKEN-0123456789';
  // A plain upstream failure: anything credential-shaped in the resulting message can only have come
  // from the connector folding the request URL or the Authorization header into it.
  const echo: FakeHandler = () => ({ status: 500, text: '{"error":"upstream failure"}' });

  const cases: { name: string; run: () => Promise<unknown>; calls: () => FakeCall[] }[] = [];

  const yt = fake({ now, config: { clientId: 'c' }, secrets: { accessToken: LEAK, refreshToken: 'r', clientSecret: 's' }, cursor: { tokenExpiresAt: now + 3_600_000, channelId: 'UCself' }, handler: echo });
  cases.push({ name: 'youtube', run: () => youtubeConnector.poll!(yt.ctx), calls: () => yt.calls });

  const x = fake({ now, config: { clientId: 'c' }, secrets: { accessToken: LEAK, refreshToken: 'r', clientSecret: 's' }, cursor: { tokenExpiresAt: now + 3_600_000, userId: 'selfId' }, handler: echo });
  cases.push({ name: 'x', run: () => xConnector.poll!(x.ctx), calls: () => x.calls });

  const ig = fake({ now, secrets: { accessToken: LEAK }, cursor: { igUserId: 'igSelf', lastRefreshAt: now - 3_600_000 }, handler: echo });
  cases.push({ name: 'instagram', run: () => instagramConnector.poll!(ig.ctx), calls: () => ig.calls });

  const oa = fake({ now, config: { appId: OA_APPID }, secrets: { token: 't', appSecret: LEAK }, handler: echo });
  cases.push({ name: 'wechat_oa', run: () => wechatOaConnector.send!(oa.ctx, { kind: 'dm', threadRef: 'o', contactPlatformUserId: 'o', text: 'hi', replyToRef: null }), calls: () => oa.calls });

  const kf = fake({ now, config: { corpId: KF_CORP, openKfId: KF_OPEN }, secrets: { token: 't', encodingAesKey: AES_KEY, corpSecret: LEAK }, handler: echo });
  cases.push({ name: 'wecom_kf', run: () => wecomKfConnector.send!(kf.ctx, { kind: 'dm', threadRef: 'w', contactPlatformUserId: 'w', text: 'hi', replyToRef: null }), calls: () => kf.calls });

  const oauth = fake({ now, config: { clientId: 'c' }, secrets: { accessToken: 'stale', refreshToken: LEAK, clientSecret: LEAK }, cursor: { tokenExpiresAt: now - 1000 }, handler: echo });
  cases.push({ name: 'oauth', run: () => accessTokenFor(oauth.ctx, 'x'), calls: () => oauth.calls });

  for (const c of cases) {
    const err = await connectorError(c.run);
    assert.ok(!err.message.includes(LEAK), `${c.name} 的错误信息泄露了凭据：${err.message}`);
    assert.ok(!err.message.toLowerCase().includes('bearer '), `${c.name} 的错误信息里出现了 Authorization 头：${err.message}`);
    assert.ok(!err.message.includes('access_token='), `${c.name} 的错误信息里出现了 URL 上的 access_token：${err.message}`);
    assert.ok(c.calls().length > 0, `${c.name} 没有发出任何请求，用例没生效`);
  }
});
