import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildAdminServer } from '../src/server/api/server.ts';
import { REAL_CONNECTORS } from '../src/server/connectors/index.ts';
import { applyProxy } from '../src/server/proxy.ts';
import type { ConversationDetail } from '../src/shared/types.ts';
import { SANDBOX, harness, testConfig } from './helpers.ts';

const HOST = '127.0.0.1:7788';

/** A browser-shaped client: carries the anti-CSRF header and the session cookie the way the SPA does. */
function client(server: FastifyInstance) {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async call(method: string, url: string, payload?: unknown, over: Record<string, string> = {}) {
      const res = await server.inject({
        method: method as 'GET',
        url,
        payload: payload as object | undefined,
        headers: { host: HOST, 'x-llmsocial': '1', ...(cookie ? { cookie } : {}), ...over },
      });
      const set = res.headers['set-cookie'];
      if (typeof set === 'string') cookie = set.split(';')[0]!;
      return res;
    },
    json<T>(res: { payload: string }): T {
      return JSON.parse(res.payload) as T;
    },
  };
}

async function loggedIn() {
  // The real platform connectors are wired in by the entry point, not by createApp: register them here too.
  const h = harness({ extraConnectors: REAL_CONNECTORS });
  const server = buildAdminServer(h.app);
  const c = client(server);
  const setup = await c.call('POST', '/api/auth/setup', { password: 'a-long-enough-password' });
  assert.equal(setup.statusCode, 200, setup.payload);
  return { h, server, c };
}

test('every API route is closed until a password is set and a session exists', async () => {
  const h = harness();
  const server = buildAdminServer(h.app);
  const c = client(server);

  const state = c.json<{ setupRequired: boolean; authenticated: boolean }>(await c.call('GET', '/api/auth/state'));
  assert.deepEqual(state, { setupRequired: true, authenticated: false });
  assert.equal((await c.call('GET', '/api/conversations')).statusCode, 401);
  assert.equal((await c.call('GET', '/api/accounts')).statusCode, 401);

  // A too-short password is refused, so an install can't be protected by "1".
  assert.equal((await c.call('POST', '/api/auth/setup', { password: 'short' })).statusCode, 400);
  assert.equal((await c.call('POST', '/api/auth/setup', { password: 'a-long-enough-password' })).statusCode, 200);
  assert.ok(c.cookie.startsWith('llmsocial_sid='));
  assert.equal((await c.call('GET', '/api/conversations')).statusCode, 200);

  // Setup is one-shot: a second caller cannot take the install over.
  assert.equal((await c.call('POST', '/api/auth/setup', { password: 'another-password-x' })).statusCode, 409);

  const wrong = await c.call('POST', '/api/auth/login', { password: 'not-the-password' });
  assert.equal(wrong.statusCode, 401);
  assert.equal(c.json<{ error: string }>(wrong).error, '密码不对');

  await c.call('POST', '/api/auth/logout');
  assert.equal((await c.call('GET', '/api/conversations')).statusCode, 401, '退出后会话立即失效');
  assert.equal((await c.call('POST', '/api/auth/login', { password: 'a-long-enough-password' })).statusCode, 200);
  assert.equal((await c.call('GET', '/api/conversations')).statusCode, 200);
});

test('a hostile page cannot drive the local server', async () => {
  const { server, c } = await loggedIn();

  // 1. DNS rebinding: an attacker-controlled name pointed at 127.0.0.1.
  const rebind = await c.call('GET', '/api/conversations', undefined, { host: 'attacker.example.com' });
  assert.equal(rebind.statusCode, 421);

  // 2. A cross-site form post: no custom header, because setting one would require a preflight.
  const noHeader = await server.inject({ method: 'POST', url: '/api/conversations', payload: {}, headers: { host: HOST, cookie: c.cookie } });
  assert.equal(noHeader.statusCode, 403);
  assert.match(JSON.parse(noHeader.payload).error, /X-LLMSocial/);

  // 3. A fetch from another origin that somehow carried the header still fails the Origin check.
  const badOrigin = await c.call('POST', '/api/conversations', {}, { origin: 'https://evil.example.com' });
  assert.equal(badOrigin.statusCode, 403);

  // Reads are not gated on the header — but they are gated on the session, which is SameSite=Strict.
  assert.equal((await server.inject({ method: 'GET', url: '/api/conversations', headers: { host: HOST, cookie: c.cookie } })).statusCode, 200);
  assert.match(String((await c.call('GET', '/api/conversations')).headers['content-security-policy']), /frame-ancestors 'none'/);
});

test('an imported thread produces a draft that a person approves before anything is sent', async () => {
  const { h, c } = await loggedIn();

  const imported = c.json<ConversationDetail>(
    await c.call('POST', '/api/import/messages', {
      accountId: SANDBOX,
      contact: { platformUserId: 'u-import', displayName: '小周' },
      messages: [
        { side: 'contact', text: '你好，看到你发的数字人视频' },
        { side: 'me', text: '嗨' },
        { side: 'contact', text: '这个能接自己的号吗' },
      ],
    }),
  );
  assert.equal(imported.messages.length, 3);
  assert.equal(imported.messages.at(-1)!.direction, 'in');

  await h.tick(10_000);
  const detail = c.json<ConversationDetail>(await c.call('GET', `/api/conversations/${imported.conversation.id}`));
  const draft = detail.messages.find((m) => m.status === 'pending_approval');
  assert.ok(draft, '默认 copilot：应当生成待审核草稿');
  assert.equal(draft.approved, false);
  // The one already-sent outbound row is the imported '嗨' — the AI has sent nothing of its own.
  const sentBefore = h.app.repos.messages.byConversation(imported.conversation.id).filter((m) => m.direction === 'out' && m.status === 'sent');
  assert.deepEqual(sentBefore.map((m) => m.text), ['嗨'], '未经批准不得发出');

  // The operator edits the draft before approving: the edited text is what goes out.
  const after = c.json<ConversationDetail>(await c.call('POST', `/api/messages/${draft.id}/approve`, { text: '可以的，绑定自己的账号就行' }));
  await h.tick(5000);
  assert.equal(after.messages.find((m) => m.id === draft.id)!.text, '可以的，绑定自己的账号就行');
  const sent = h.app.repos.messages.byConversation(imported.conversation.id).filter((m) => m.direction === 'out' && m.status === 'sent' && m.id === draft.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.approved, true);

  // Discarding a second draft leaves nothing queued.
  h.app.pipeline.ingest(SANDBOX, { platformMsgId: 'api-2', kind: 'dm', threadRef: 'u-import', contact: { platformUserId: 'u-import', displayName: '小周' }, text: '那多少钱', timestamp: h.clock.now() });
  await h.tick(10_000);
  const second = c.json<ConversationDetail>(await c.call('GET', `/api/conversations/${imported.conversation.id}`)).messages.find((m) => m.status === 'pending_approval')!;
  assert.ok(second);
  const discarded = c.json<ConversationDetail>(await c.call('POST', `/api/messages/${second.id}/discard`));
  assert.equal(discarded.messages.find((m) => m.id === second.id)!.status, 'rejected');
  await h.tick(60_000);
  assert.equal(h.app.repos.messages.byConversation(imported.conversation.id).filter((m) => m.status === 'sent' && m.direction === 'out').length, 2, '丢弃的草稿不会稍后偷偷发出');
});

test('opting out is honoured over the API and cannot be undone by starting a new thread', async () => {
  const { h, c } = await loggedIn();
  const id = h.inbound('别再给我发了');
  await h.tick(10_000);

  const detail = c.json<ConversationDetail>(await c.call('GET', `/api/conversations/${id}`));
  assert.equal(detail.conversation.state, 'opted_out');
  assert.equal(detail.messages.some((m) => m.direction === 'out' && m.status === 'pending_approval' && m.kind === 'text'), false, '退订后不再起草正常回复');

  const blocked = await c.call('POST', '/api/conversations', { accountId: SANDBOX, platformUserId: 'u1', displayName: '测试用户' });
  assert.equal(blocked.statusCode, 400);
  assert.match(c.json<{ error: string }>(blocked).error, /屏蔽名单/);

  // Generating by hand is refused too — the operator cannot talk the AI past an opt-out.
  const forced = await c.call('POST', `/api/conversations/${id}/generate`, {});
  assert.equal(forced.statusCode, 400);
});

test('secrets go in and never come back out', async () => {
  const { h, c } = await loggedIn();
  const created = await c.call('POST', '/api/providers', { name: '测试模型', kind: 'anthropic', model: 'claude-opus-5', apiKey: 'sk-ant-do-not-leak-me' });
  assert.equal(created.statusCode, 200, created.payload);
  const id = c.json<{ id: string }>(created).id;

  const list = (await c.call('GET', '/api/providers')).payload;
  assert.equal(list.includes('do-not-leak-me'), false);
  assert.match(list, /"hasApiKey":true/);

  // A reference is stored verbatim so the operator can see where the key lives, without holding it.
  await c.call('PATCH', `/api/providers/${id}`, { apiKey: 'keychain:llmsocial.anthropic' });
  assert.match((await c.call('GET', '/api/providers')).payload, /keychain:llmsocial\.anthropic/);
  assert.equal(h.app.repos.providers.get(id)!.apiKeyRef, 'keychain:llmsocial.anthropic');

  // Account secrets behave the same way.
  const account = await c.call('POST', '/api/accounts', {
    name: 'YouTube 测试',
    platform: 'youtube',
    connector: 'youtube',
    config: { channelId: 'UC123' },
    secrets: { clientSecret: 'super-secret-value' },
  });
  assert.equal(account.statusCode, 200, account.payload);
  const accounts = (await c.call('GET', '/api/accounts')).payload;
  assert.equal(accounts.includes('super-secret-value'), false);
  assert.match(accounts, /"secretsSet":\{"clientSecret":true\}/);
});

test('bad input is rejected with a readable message, not a 500', async () => {
  const { c } = await loggedIn();
  const cases: Array<[string, unknown]> = [
    ['/api/providers', { name: '', kind: 'anthropic', model: 'x' }],
    ['/api/providers', { name: 'x', kind: 'not-a-kind', model: 'x' }],
    ['/api/skills', { slug: 'Bad Slug', name: 'x', content: 'y' }],
    ['/api/campaigns', { name: 'x', goalType: 'rapport', goal: 'x', allowedLinks: ['javascript:alert(1)'] }],
    ['/api/campaigns', { name: 'x', goalType: 'rapport', goal: 'x', materials: [{ id: 'm1', title: 'a', url: 'javascript:alert(1)' }] }],
    ['/api/campaigns', { name: 'x', goalType: 'rapport', goal: 'x', materials: [{ id: 'm1', title: 'a', url: 'https://a.com' }, { id: 'm1', title: 'b', url: 'https://b.com' }] }],
    ['/api/accounts', { name: 'x', platform: 'mars', connector: 'sandbox' }],
    ['/api/accounts', { name: 'x', platform: 'x', connector: 'sandbox', timezone: 'Mars/Olympus' }],
  ];
  for (const [url, body] of cases) {
    const res = await c.call('POST', url, body);
    assert.equal(res.statusCode, 400, `${url} ${JSON.stringify(body)} → ${res.statusCode}`);
    assert.ok(c.json<{ error: string }>(res).error.length > 0);
  }
  assert.equal((await c.call('GET', '/api/conversations/does-not-exist')).statusCode, 404);
  assert.equal((await c.call('POST', '/api/import/messages', { accountId: 'nope', contact: { platformUserId: 'u' }, messages: [{ side: 'contact', text: 'hi' }] })).statusCode, 404);
});

test('一次部分更新只动它点名的字段，不把其余的抹回默认值', async () => {
  const { c } = await loggedIn();
  const created = c.json<{ id: string }>(
    await c.call('POST', '/api/campaigns', {
      name: '素材任务',
      goalType: 'share_content',
      goal: '让对方去看那条视频',
      facts: '视频讲的是露营装备',
      maxTurns: 12,
      materials: [{ id: 'm1', title: '露营清单', url: 'https://ex.com/v/1', description: '讲清楚买什么', tags: ['露营'] }],
    }),
  );
  // zod 的 .partial() 不会脱掉 .default()：没提交的字段会被默认值填上，把已存的内容悄悄冲掉。
  const patched = c.json<{ facts: string; maxTurns: number; materials: { id: string }[]; mode: string }>(await c.call('PATCH', `/api/campaigns/${created.id}`, { mode: 'autopilot' }));
  assert.equal(patched.mode, 'autopilot');
  assert.equal(patched.facts, '视频讲的是露营装备', 'facts 被抹掉了');
  assert.equal(patched.maxTurns, 12, 'maxTurns 被抹回默认值了');
  assert.deepEqual(patched.materials.map((m) => m.id), ['m1'], '素材库被抹掉了');

  // 明确提交空数组，仍然要能清空。
  const cleared = c.json<{ materials: unknown[] }>(await c.call('PATCH', `/api/campaigns/${created.id}`, { materials: [] }));
  assert.deepEqual(cleared.materials, []);
});

test('a campaign restricted to overseas platforms never attaches itself to a Chinese account', async () => {
  const { h, c } = await loggedIn();
  const campaign = c.json<{ id: string; allowedPlatforms: string[] }>(
    await c.call('POST', '/api/campaigns', {
      name: '海外 VPN',
      goalType: 'recommend_product',
      goal: '向海外用户介绍 VPN 产品',
      allowedLinks: ['https://example.com/vpn'],
      allowedPlatforms: ['x', 'instagram', 'youtube'],
    }),
  );
  assert.deepEqual(campaign.allowedPlatforms, ['x', 'instagram', 'youtube']);
  h.app.repos.accounts.update(SANDBOX, { platform: 'wechat', defaultCampaignId: campaign.id });

  const id = h.inbound('你们有什么产品');
  await h.tick(10_000);
  const detail = c.json<ConversationDetail>(await c.call('GET', `/api/conversations/${id}`));
  assert.equal(detail.conversation.campaignId, null, '账号的默认任务在这个平台不可用，就不挂上去');

  // And nothing from that campaign — goal or link — reached the model.
  const prompts = h.app.db.all<{ systemPrompt: string; userPrompt: string }>("SELECT systemPrompt, userPrompt FROM llm_calls WHERE purpose = 'reply'");
  assert.ok(prompts.length > 0, '默认任务仍然照常回复');
  for (const p of prompts) {
    assert.equal(`${p.systemPrompt}\n${p.userPrompt}`.includes('VPN'), false);
    assert.equal(`${p.systemPrompt}\n${p.userPrompt}`.includes('example.com/vpn'), false);
  }

  // Forcing it by hand is refused at the pipeline, with a reason the operator can read.
  h.app.repos.conversations.update(id, { campaignId: campaign.id });
  await h.app.pipeline.generate(id, { trigger: 'regenerate' });
  assert.match(JSON.stringify(h.app.repos.events.list({ conversationId: id })), /不允许在 微信 上运行/);
});

test('message input, clock times and platform combinations reject unusable values', async (t) => {
  const { h, server, c } = await loggedIn();
  t.after(async () => { await server.close(); await h.app.stop(); });
  const id = h.inbound('你好');
  assert.equal((await c.call('POST', `/api/conversations/${id}/send`, { text: '   \n ' })).statusCode, 400);
  assert.equal((await c.call('POST', '/api/conversations/missing/send', { text: '你好' })).statusCode, 404);
  for (const time of ['24:00', '12:60', '99:99']) {
    assert.equal((await c.call('PATCH', `/api/accounts/${SANDBOX}`, { quietStart: time })).statusCode, 400);
  }
  assert.equal((await c.call('POST', '/api/accounts', { name: '错误组合', platform: 'wechat', connector: 'youtube' })).statusCode, 400);
});

test('an operator closing a conversation cancels scheduled replies', async (t) => {
  const { h, server, c } = await loggedIn();
  t.after(async () => { await server.close(); await h.app.stop(); });
  const campaign = h.campaign({ mode: 'autopilot' });
  h.app.repos.accounts.update(SANDBOX, { defaultCampaignId: campaign.id });
  const id = h.inbound('你好');
  await h.tick(10_000);
  assert.ok(h.app.repos.messages.open(id).length > 0);
  assert.equal((await c.call('PATCH', `/api/conversations/${id}`, { state: 'closed' })).statusCode, 200);
  await h.tick(60 * 60_000);
  assert.equal(h.app.repos.messages.countSent({ accountId: SANDBOX, since: 0 }), 0);
});

test('OAuth errors are displayed as text instead of HTML', async (t) => {
  const { h, server, c } = await loggedIn();
  t.after(async () => { await server.close(); await h.app.stop(); });
  const res = await c.call('GET', `/oauth/callback?error=${encodeURIComponent('<img src=x onerror=alert(1)>')}`);
  assert.equal(res.statusCode, 200);
  assert.ok(!res.payload.includes('<img'));
  assert.ok(res.payload.includes('&lt;img'));
});

test('failed account secret validation rolls back the entire save', async (t) => {
  const { h, server, c } = await loggedIn();
  t.after(async () => { await server.close(); await h.app.stop(); });
  const before = h.app.repos.accounts.list().length;
  const res = await c.call('POST', '/api/accounts', { name: '未完成', platform: 'wechat', connector: 'manual', secrets: { invalid: 'env:' } });
  assert.equal(res.statusCode, 400, res.payload);
  assert.equal(h.app.repos.accounts.list().length, before);
});

test('screenshot import cannot trigger sending through a live connector', async (t) => {
  const { h, server, c } = await loggedIn();
  t.after(async () => { await server.close(); await h.app.stop(); });
  const account = h.app.repos.accounts.create({ name: 'YouTube', platform: 'youtube', connector: 'youtube' });
  const res = await c.call('POST', '/api/import/messages', { accountId: account.id, contact: { platformUserId: 'u1' }, messages: [{ side: 'contact', text: '你好' }] });
  assert.equal(res.statusCode, 400);
  assert.equal(h.app.repos.conversations.list({ accountId: account.id }).length, 0);
});

test('new build assets are served after startup and missing scripts return 404', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsocial-assets-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>llmsocial</title>');
  const h = harness({ config: { ...testConfig(), webDir: dir } });
  const server = buildAdminServer(h.app);
  t.after(async () => { await server.close(); await h.app.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await server.ready();
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'updated.js'), 'console.log("ready")');
  const res = await server.inject({ method: 'GET', url: '/assets/updated.js', headers: { host: HOST } });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /javascript/);
  assert.equal(res.payload, 'console.log("ready")');
  const missing = await server.inject({ method: 'GET', url: '/assets/missing.js', headers: { host: HOST } });
  assert.equal(missing.statusCode, 404);
});

test('proxy switch: takes effect on save, refuses on-without-address, and a plain resave does not touch the network', async (t) => {
  const { h, server, c } = await loggedIn();
  t.after(async () => {
    applyProxy({ proxyEnabled: false, proxyUrl: '', noProxy: '' });
    await server.close();
    await h.app.stop();
  });
  const switches = () => h.app.repos.events.list({}).filter((e) => e.type === 'settings_proxy');

  assert.equal((await c.call('PATCH', '/api/settings', { proxyEnabled: true })).statusCode, 400, 'on with no address');
  for (const bad of ['127.0.0.1:18081', 'socks5://127.0.0.1:1080', 'javascript:alert(1)']) {
    assert.equal((await c.call('PATCH', '/api/settings', { proxyUrl: bad })).statusCode, 400, bad);
  }
  assert.equal(h.app.repos.settings.get().proxyEnabled, false);
  assert.equal(switches().length, 0);

  const on = await c.call('PATCH', '/api/settings', { proxyEnabled: true, proxyUrl: 'http://user:pw@127.0.0.1:18081' });
  assert.equal(on.statusCode, 200, on.payload);
  assert.deepEqual(switches()[0]?.data, { mode: 'proxy', proxy: 'http://127.0.0.1:18081' }, 'logged without the password');

  // The settings page sends every field on every save.
  assert.equal((await c.call('PATCH', '/api/settings', h.app.repos.settings.get())).statusCode, 200);
  assert.equal(switches().length, 1, 'unchanged proxy fields must not re-apply');

  // Clearing the address while the switch is still on would leave it on-without-address.
  assert.equal((await c.call('PATCH', '/api/settings', { proxyUrl: '' })).statusCode, 400);
  const off = await c.call('PATCH', '/api/settings', { proxyEnabled: false });
  assert.equal(off.statusCode, 200, off.payload);
  assert.deepEqual(switches()[0]?.data, { mode: 'direct', proxy: '' });
});
