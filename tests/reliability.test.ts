import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMockClient } from '../src/server/llm/mock.ts';
import { LlmError, type ChatRequest } from '../src/server/llm/types.ts';
import { ConnectorError } from '../src/server/connectors/types.ts';
import { sandboxConnector } from '../src/server/connectors/local.ts';
import { RetryLater } from '../src/server/queue/jobs.ts';
import { harness, SANDBOX } from './helpers.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function autopilot(h: ReturnType<typeof harness>) {
  const campaign = h.campaign({ mode: 'autopilot' });
  h.app.repos.accounts.update(SANDBOX, { defaultCampaignId: campaign.id, quietStart: '00:00', quietEnd: '00:00' });
}

const request: ChatRequest = { purpose: 'reply', systemStatic: '', systemDynamic: '', user: '你好' };
const parse = (raw: unknown) => raw;

test('manual replies remain drafts until the operator confirms delivery', async (t) => {
  const h = harness();
  t.after(() => h.app.stop());
  const account = h.app.repos.accounts.create({ name: '微信', platform: 'wechat', connector: 'manual' });
  const id = h.inbound('你好', {}, account.id);
  const message = h.app.pipeline.operatorSend(id, '你好呀');
  assert.equal(message.status, 'pending_approval');
  assert.equal(message.sentAt, null);
  assert.equal(h.app.repos.conversations.get(id)!.lastOutboundAt, null);
  h.app.pipeline.markSent(message.id);
  assert.equal(h.app.repos.messages.get(message.id)!.status, 'sent');
  assert.equal(h.app.repos.conversations.get(id)!.lastOutboundAt, h.clock.now());
});

test('a webhook without an outbound endpoint uses manual delivery', async (t) => {
  const h = harness();
  t.after(() => h.app.stop());
  const campaign = h.campaign({ mode: 'autopilot' });
  const account = h.app.repos.accounts.create({ name: '收件桥', platform: 'wechat', connector: 'webhook', defaultCampaignId: campaign.id });
  const id = h.inbound('你好', {}, account.id);
  await h.tick(10_000);
  assert.equal(h.app.connectors.canSend(account), false);
  assert.equal(h.app.repos.conversations.listItem(id)!.effectiveMode, 'copilot');
  assert.equal(h.app.repos.messages.open(id)[0]!.status, 'pending_approval');
  assert.equal(h.app.pipeline.operatorSend(id, '收到').status, 'pending_approval');
});

for (const action of ['close', 'operator', 'mode', 'campaign'] as const) {
  test(`generation is invalidated when ${action} changes while the model is running`, async (t) => {
    const started = deferred();
    const release = deferred();
    const h = harness({ llmFactory: (rt) => ({ async chat(req) { started.resolve(); await release.promise; return createMockClient(rt).chat(req); } }) });
    t.after(() => h.app.stop());
    autopilot(h);
    const id = h.inbound('你好');
    const generation = h.app.pipeline.generate(id, { trigger: 'regenerate' });
    await started.promise;
    if (action === 'close') h.app.repos.conversations.update(id, { state: 'closed' });
    if (action === 'operator') h.app.pipeline.operatorSend(id, '我来回复');
    if (action === 'mode') h.app.repos.conversations.update(id, { modeOverride: 'copilot' });
    if (action === 'campaign') h.app.repos.campaigns.update(h.app.repos.conversations.get(id)!.campaignId!, { goal: '新的聊天目标' });
    release.resolve();
    assert.match(await generation, /对话已更新/);
    assert.equal(h.app.repos.messages.byConversation(id).filter((m) => m.author === 'ai').length, 0);
  });
}

test('queued automatic replies become drafts after switching to copilot', async (t) => {
  const h = harness();
  t.after(() => h.app.stop());
  autopilot(h);
  const id = h.inbound('你好');
  await h.app.pipeline.generate(id, { trigger: 'inbound', instant: true });
  h.app.repos.conversations.update(id, { modeOverride: 'copilot' });
  for (const message of h.app.repos.messages.open(id)) await h.app.pipeline.send(message.id);
  assert.ok(h.app.repos.messages.open(id).every((m) => m.status === 'pending_approval'));
  assert.equal(h.app.repos.messages.countSent({ accountId: SANDBOX, since: 0 }), 0);
});

test('concurrent sends on one account respect the account rate limit', async (t) => {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  const h = harness({ extraConnectors: [{ ...sandboxConnector, async send() { calls++; started.resolve(); await release.promise; return {}; } }] });
  t.after(() => h.app.stop());
  autopilot(h);
  h.app.repos.accounts.update(SANDBOX, { maxPerHour: 1 });
  const id = h.inbound('你好');
  const insert = (text: string) => h.app.repos.messages.insert({ accountId: SANDBOX, conversationId: id, direction: 'out', author: 'ai', text, status: 'scheduled' });
  const one = insert('第一条');
  const two = insert('第二条');
  const pending = Promise.allSettled([h.app.pipeline.send(one.id), h.app.pipeline.send(two.id)]);
  await started.promise;
  assert.equal(calls, 1);
  release.resolve();
  const results = await pending;
  assert.equal(calls, 1);
  assert.equal(results[0]!.status, 'fulfilled');
  const limited = results[1]!;
  assert.equal(limited.status, 'rejected');
  if (limited.status === 'rejected') assert.ok(limited.reason instanceof RetryLater);
  assert.equal(h.app.repos.messages.get(two.id)!.status, 'scheduled');
});

test('sending the same message concurrently delivers it once', async (t) => {
  let calls = 0;
  const h = harness({ extraConnectors: [{ ...sandboxConnector, async send() { calls++; await Promise.resolve(); return {}; } }] });
  t.after(() => h.app.stop());
  const id = h.inbound('你好');
  const message = h.app.pipeline.operatorSend(id, '回复');
  await Promise.all([h.app.pipeline.send(message.id), h.app.pipeline.send(message.id)]);
  assert.equal(calls, 1);
});

test('later bubbles wait for a failed earlier bubble to be reviewed', async (t) => {
  const h = harness();
  t.after(() => h.app.stop());
  autopilot(h);
  const id = h.inbound('你好');
  await h.app.pipeline.generate(id, { trigger: 'inbound', instant: true });
  const [first, second] = h.app.repos.messages.open(id);
  assert.ok(first && second);
  h.app.repos.messages.update(first.id, { status: 'failed' });
  await h.app.pipeline.send(second.id, { instant: true });
  assert.equal(h.app.repos.messages.get(second.id)!.status, 'pending_approval');
  assert.match(h.app.repos.messages.get(second.id)!.reviewReason, /前一条/);
});

test('an ambiguous network failure is not automatically resent', async (t) => {
  let calls = 0;
  const h = harness({ extraConnectors: [{ ...sandboxConnector, async send() { calls++; throw new ConnectorError('transient', 'connection lost after write'); } }] });
  t.after(() => h.app.stop());
  const id = h.inbound('你好');
  const message = h.app.pipeline.operatorSend(id, '回复');
  await h.tick();
  await h.tick(60 * 60_000);
  assert.equal(calls, 1);
  assert.equal(h.app.repos.messages.get(message.id)!.status, 'failed');
  assert.match(h.app.repos.messages.get(message.id)!.error, /发送结果不确定/);
});

test('queued messages also check suppression on another account', async (t) => {
  const h = harness();
  t.after(() => h.app.stop());
  const id = h.inbound('你好');
  const message = h.app.pipeline.operatorSend(id, '回复');
  h.app.repos.suppressions.add('sandbox', 'u1', '另一个账号');
  await h.app.pipeline.send(message.id);
  assert.equal(h.app.repos.messages.get(message.id)!.status, 'cancelled');
});

test('an explicit model chain never falls back to unrelated models when disabled', async (t) => {
  const h = harness();
  t.after(() => h.app.stop());
  const provider = h.provider('mock-friendly', { enabled: false });
  await assert.rejects(h.app.router.chat(request, { providerIds: [provider.id], parse }), /没有可用的 LLM/);
  assert.equal(h.app.router.callsLastDay(), 0);
});

test('failure of a real model does not silently use the offline mock', async (t) => {
  const h = harness({ llmFactory: createMockClient });
  t.after(() => h.app.stop());
  h.provider('mock-fail', { kind: 'openai_compat' });
  await assert.rejects(h.app.router.chat(request, { parse }), /所有 LLM 都失败/);
  assert.equal(h.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM llm_calls WHERE providerId = 'prov_mock'")!.n, 0);
});

test('the daily call budget includes JSON retries and fallback attempts', async (t) => {
  const h = harness();
  t.after(() => h.app.stop());
  h.app.repos.settings.patch({ dailyLlmCallLimit: 1 });
  const provider = h.provider('mock-badjson');
  await assert.rejects(h.app.router.chat(request, { providerIds: [provider.id], parse }), (err: unknown) => err instanceof LlmError && err.kind === 'budget');
  assert.equal(h.app.router.callsLastDay(), 1);
});

test('concurrent model calls share the remaining daily budget', async (t) => {
  const started = deferred();
  const release = deferred();
  const h = harness({ llmFactory: (rt) => ({ async chat(req) { started.resolve(); await release.promise; return createMockClient(rt).chat(req); } }) });
  t.after(() => h.app.stop());
  h.app.repos.settings.patch({ dailyLlmCallLimit: 1 });
  const one = h.app.router.chat(request, { parse });
  await started.promise;
  await assert.rejects(h.app.router.chat(request, { parse }), (err: unknown) => err instanceof LlmError && err.kind === 'budget');
  release.resolve();
  await one;
  assert.equal(h.app.router.callsLastDay(), 1);
});

test('invalid output errors from a model client count towards the call budget', async (t) => {
  let calls = 0;
  const h = harness({ llmFactory: () => ({ async chat() { calls++; throw new LlmError('bad_output', 'empty content'); } }) });
  t.after(() => h.app.stop());
  h.app.repos.settings.patch({ dailyLlmCallLimit: 1 });
  await assert.rejects(h.app.router.chat(request, { parse }), (err: unknown) => err instanceof LlmError && err.kind === 'budget');
  assert.equal(calls, 1);
  assert.equal(h.app.router.callsLastDay(), 1);
});

test('zero account quotas mean unlimited as displayed in the interface', async (t) => {
  const h = harness();
  t.after(() => h.app.stop());
  autopilot(h);
  h.app.repos.accounts.update(SANDBOX, { maxPerHour: 0, maxPerDay: 0, maxPerContactDay: 0 });
  const id = h.inbound('你好');
  await h.app.pipeline.generate(id, { trigger: 'inbound', instant: true });
  const first = h.app.repos.messages.open(id)[0]!;
  await h.app.pipeline.send(first.id);
  assert.equal(h.app.repos.messages.get(first.id)!.status, 'sent');
});

test('manual polling works with a zero automatic polling interval and does not loop', async (t) => {
  let polls = 0;
  const h = harness({ extraConnectors: [{ ...sandboxConnector, async poll(ctx) { polls++; return [{ platformMsgId: 'poll-manual-1', kind: 'dm', threadRef: 'polled', contact: { platformUserId: 'polled' }, text: '收到的新消息', timestamp: ctx.now() }]; } }] });
  t.after(() => h.app.stop());
  h.app.repos.accounts.update(SANDBOX, { pollIntervalS: 0 });
  h.app.queue.enqueue('poll_account', { accountId: SANDBOX, manual: true });
  await h.tick();
  assert.equal(polls, 1);
  assert.equal(h.app.repos.conversations.list({ accountId: SANDBOX }).length, 1);
  await h.tick(60_000);
  assert.equal(polls, 1);
});

test('a reply owed to a real inbound message is drafted again, not dropped, when its context changes mid-generation', async (t) => {
  let contactId = '';
  let calls = 0;
  const h = harness({
    llmFactory: (rt) => ({
      async chat(req) {
        calls++;
        // The operator edits the contact's notes while the first model call is in flight.
        if (calls === 1) h.app.repos.contacts.update(contactId, { notes: '刚加的备注：对方是老客户' });
        return createMockClient(rt).chat(req);
      },
    }),
  });
  t.after(() => h.app.stop());
  const id = h.inbound('你好，还记得我吗');
  contactId = h.app.repos.conversations.get(id)!.contactId;

  await h.tick(10_000);
  assert.equal(calls, 1);
  assert.equal(h.app.repos.messages.byConversation(id).filter((m) => m.author === 'ai').length, 0, '第一稿建立在过时的上下文上，作废');
  assert.match(JSON.stringify(h.app.repos.events.list({ conversationId: id })), /generate_stale/);

  // The rerun lands a couple of seconds later and is built on the fresh notes.
  await h.tick(2000);
  assert.equal(calls, 2);
  const drafts = h.app.repos.messages.byConversation(id).filter((m) => m.author === 'ai');
  assert.equal(drafts.length, 1, '对方仍然在等回复，第二次生成必须落地');
  const prompts = h.app.db.all<{ userPrompt: string; systemPrompt: string }>("SELECT userPrompt, systemPrompt FROM llm_calls WHERE conversationId = ? ORDER BY createdAt", id);
  assert.equal(prompts.length, 2);
  assert.equal(`${prompts[0]!.systemPrompt}${prompts[0]!.userPrompt}`.includes('刚加的备注'), false);
  assert.equal(`${prompts[1]!.systemPrompt}${prompts[1]!.userPrompt}`.includes('刚加的备注'), true, '重跑用的是新备注');

  // But it does not loop: nothing changes during the second call, so no third run is queued.
  await h.tick(60_000);
  assert.equal(calls, 2);
});

test('an operator-triggered generation whose context changed reports back instead of silently re-running', async (t) => {
  let calls = 0;
  const h = harness({
    llmFactory: (rt) => ({
      async chat(req) {
        calls++;
        if (calls === 2) h.app.repos.campaigns.update('camp_default', { goal: '新的聊天目标' });
        return createMockClient(rt).chat(req);
      },
    }),
  });
  t.after(() => h.app.stop());
  const id = h.inbound('你好');
  await h.tick(10_000); // the automatic reply the inbound message itself queued
  assert.equal(calls, 1);
  assert.match(await h.app.pipeline.generate(id, { trigger: 'regenerate' }), /对话已更新/);
  await h.tick(60_000);
  assert.equal(calls, 2, '操作者点的生成不自动重跑，由他自己再点');
});
