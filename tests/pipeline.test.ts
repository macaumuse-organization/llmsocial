import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOUR, MINUTE } from '../src/server/util.ts';
import { SANDBOX, harness } from './helpers.ts';

const texts = (h: ReturnType<typeof harness>, conversationId: string, status?: string) =>
  h.app.repos.messages.byConversation(conversationId).filter((m) => m.direction === 'out' && (!status || m.status === status));

function useCampaign(h: ReturnType<typeof harness>, over: Parameters<ReturnType<typeof harness>['campaign']>[0]) {
  const campaign = h.campaign(over);
  h.app.repos.accounts.update(SANDBOX, { defaultCampaignId: campaign.id });
  return campaign;
}

test('copilot: a draft waits for approval and nothing is sent until a person approves it', async () => {
  const h = harness();
  const id = h.inbound('你好，刷到你的视频了');
  assert.equal(await h.tick(1000), 0, 'debounce: nothing runs right away');
  await h.tick(10_000);
  const drafts = texts(h, id);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.status, 'pending_approval');
  assert.equal(drafts[0]!.kind, 'text', 'copilot drafts carry no AI disclosure: the owner sends them personally');

  h.app.pipeline.approve(drafts[0]!.id, '你好呀，谢谢关注');
  await h.tick(0);
  const sent = texts(h, id, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.text, '你好呀，谢谢关注');
  assert.equal(sent[0]!.approved, true);
  assert.equal(h.app.repos.conversations.get(id)!.aiTurns, 1);
});

test('一句「别发了」不退订，但到此为止：不调模型、不发东西、转人工', async () => {
  const h = harness();
  useCampaign(h, { mode: 'autopilot' });
  const id = h.inbound('你好，刷到你的视频了');
  await h.tick(10_000);
  await h.tick(2 * MINUTE);
  await h.settle();
  const before = h.app.db.all('SELECT id FROM llm_calls').length;
  const sentBefore = texts(h, id, 'sent').length;

  h.inbound('别发了');
  await h.tick(10_000);
  await h.tick(5 * MINUTE);
  await h.settle();

  const conversation = h.app.repos.conversations.get(id)!;
  assert.equal(conversation.state, 'handoff');
  assert.match(conversation.stateReason, /可能在要求停止联系/);
  assert.equal(h.app.db.all('SELECT id FROM llm_calls').length, before, '不该再调一次模型');
  assert.equal(texts(h, id, 'sent').length, sentBefore, '不该再发出任何东西');
  // 不是退订：联系人没被标记，屏蔽名单也没写。要不要退订由人决定。
  assert.equal(h.app.repos.contacts.get(conversation.contactId)!.optedOut, false);
  assert.equal(h.app.repos.suppressions.has('sandbox', 'u1'), false);
});

test('a burst of messages is answered once', async () => {
  const h = harness();
  const id = h.inbound('在吗');
  await h.tick(3000);
  h.inbound('想问个事');
  await h.tick(3000);
  h.inbound('你们那个数字人怎么用');
  await h.tick(3000);
  assert.equal(texts(h, id).length, 0, 'still inside the debounce window');
  await h.tick(10_000);
  const calls = h.app.db.all("SELECT id FROM llm_calls WHERE purpose = 'reply'");
  assert.equal(calls.length, 1);
  assert.equal(texts(h, id).length, 1);
});

test('autopilot: the first automated message discloses that an AI is writing, later ones do not repeat it', async () => {
  const h = harness();
  useCampaign(h, { mode: 'autopilot' });
  const id = h.inbound('你好');
  await h.tick(10_000);
  let out = texts(h, id);
  assert.deepEqual(out.map((m) => [m.kind, m.status]), [['disclosure', 'scheduled'], ['text', 'scheduled']]);
  assert.match(out[0]!.text, /AI/);
  assert.ok(out[0]!.sendAt! > h.clock.now(), 'paced, not instant');

  await h.tick(2 * MINUTE);
  await h.settle();
  out = texts(h, id, 'sent');
  assert.equal(out.length, 2);
  assert.ok(h.app.repos.conversations.get(id)!.disclosedAt);

  h.inbound('做什么的呀');
  await h.tick(10_000);
  await h.tick(2 * MINUTE);
  await h.settle();
  assert.equal(texts(h, id).filter((m) => m.kind === 'disclosure').length, 1);
  assert.equal(h.app.repos.conversations.get(id)!.aiTurns, 2);
});

test('autopilot: a reply claiming to be human is blocked twice and handed to a person', async () => {
  const h = harness();
  const bad = h.provider('mock-humanclaim');
  useCampaign(h, { mode: 'autopilot', providerIds: [bad.id] });
  const id = h.inbound('你是真人吗');
  await h.tick(10_000);
  const c = h.app.repos.conversations.get(id)!;
  assert.equal(c.state, 'handoff');
  assert.match(c.stateReason, /human_claim/);
  assert.equal(texts(h, id).length, 0);
});

test('copilot: "it is really me" is allowed, because the owner is the one sending', async () => {
  const h = harness();
  const p = h.provider('mock-humanclaim');
  useCampaign(h, { mode: 'copilot', providerIds: [p.id] });
  const id = h.inbound('你是真人吗');
  await h.tick(10_000);
  assert.equal(texts(h, id, 'pending_approval').length, 1);
});

test('a link that is not on the campaign allowlist never goes out', async () => {
  const h = harness();
  const bad = h.provider('mock-badlink');
  useCampaign(h, { mode: 'autopilot', providerIds: [bad.id], allowedLinks: ['https://example.com/product'] });
  const id = h.inbound('有链接吗');
  await h.tick(10_000);
  assert.equal(h.app.repos.conversations.get(id)!.state, 'handoff');
  assert.equal(texts(h, id).length, 0);
});

test('opt-out: one confirmation, then permanent silence, across accounts', async () => {
  const h = harness();
  useCampaign(h, { mode: 'autopilot' });
  const id = h.inbound('你好');
  await h.tick(10_000);
  h.inbound('别再发了');
  await h.tick(5 * MINUTE);

  const c = h.app.repos.conversations.get(id)!;
  assert.equal(c.state, 'opted_out');
  assert.equal(h.app.repos.contacts.get(c.contactId)!.optedOut, true);
  assert.ok(h.app.repos.suppressions.has('sandbox', 'u1'));
  const out = texts(h, id);
  assert.equal(out.filter((m) => m.kind === 'optout_ack' && m.status === 'sent').length, 1);
  assert.equal(out.filter((m) => m.kind !== 'optout_ack' && m.status === 'sent').length, 0, 'the pending reply was dropped');

  const before = h.app.db.all('SELECT id FROM llm_calls').length;
  h.inbound('？');
  await h.tick(HOUR);
  assert.equal(h.app.db.all('SELECT id FROM llm_calls').length, before, 'no further generation');

  const manual = h.app.pipeline.operatorSend(id, '再聊聊？');
  await h.tick(0);
  assert.equal(h.app.repos.messages.get(manual.id)!.status, 'cancelled');

  // Same person, different account on the same platform: the suppression list still applies.
  const other = h.app.repos.accounts.create({ name: '沙盒2', platform: 'sandbox', connector: 'sandbox', defaultCampaignId: 'camp_default' });
  const id2 = h.inbound('hi', {}, other.id);
  await h.tick(HOUR);
  assert.equal(h.app.repos.conversations.get(id2)!.state, 'opted_out');
});

test('a minor or a crisis stops the AI before any model is called', async () => {
  for (const text of ['我今年15岁，能用吗', '最近真的不想活了']) {
    const h = harness();
    useCampaign(h, { mode: 'autopilot' });
    const id = h.inbound(text);
    await h.tick(HOUR);
    assert.equal(h.app.repos.conversations.get(id)!.state, 'handoff', text);
    assert.equal(h.app.db.all('SELECT id FROM llm_calls').length, 0, text);
  }
});

test('autopilot holds money talk for a human instead of sending it', async () => {
  const h = harness();
  useCampaign(h, { mode: 'autopilot' });
  const id = h.inbound('怎么付款？可以转账吗');
  await h.tick(10_000);
  const out = texts(h, id);
  assert.ok(out.length > 0);
  assert.ok(out.every((m) => m.status === 'pending_approval'));
  assert.match(out[0]!.reviewReason, /付款/);
});

test('provider fallback: the second model answers when the first one is down', async () => {
  const h = harness();
  const down = h.provider('mock-fail');
  const up = h.provider('mock-friendly');
  useCampaign(h, { providerIds: [down.id, up.id] });
  const id = h.inbound('你好');
  await h.tick(10_000);
  assert.equal(texts(h, id).length, 1);
  const calls = h.app.db.all<{ ok: number; providerId: string }>('SELECT ok, providerId FROM llm_calls ORDER BY rowid');
  assert.deepEqual(calls.map((c) => [c.providerId, c.ok]), [[down.id, 0], [up.id, 1]]);
});

test('when every model fails the conversation is handed off rather than left hanging', async () => {
  const h = harness();
  const down = h.provider('mock-fail');
  const junk = h.provider('mock-badjson');
  useCampaign(h, { providerIds: [down.id, junk.id] });
  const id = h.inbound('你好');
  await h.tick(10_000);
  assert.equal(h.app.repos.conversations.get(id)!.state, 'active', 'first failure: will retry');
  await h.tick(HOUR);
  await h.tick(HOUR);
  const c = h.app.repos.conversations.get(id)!;
  assert.equal(c.state, 'handoff');
  assert.match(c.stateReason, /AI 生成失败/);
});

test('the same platform message is stored once however often it is delivered', async () => {
  const h = harness();
  const id = h.inbound('你好', { platformMsgId: 'dup-1' });
  assert.equal(h.app.pipeline.ingest(SANDBOX, { platformMsgId: 'dup-1', kind: 'dm', threadRef: 'u1', contact: { platformUserId: 'u1' }, text: '你好', timestamp: h.clock.now() })!.duplicate, true);
  assert.equal(h.app.repos.messages.byConversation(id).length, 1);
});

test('a scheduled reply is dropped and rewritten if the person writes again before it goes out', async () => {
  const h = harness();
  useCampaign(h, { mode: 'autopilot', replyDelayMinS: 60, replyDelayMaxS: 60 });
  const id = h.inbound('你好');
  await h.tick(10_000);
  const first = texts(h, id, 'scheduled');
  assert.equal(first.length, 2);
  h.inbound('对了，多少钱');
  await h.tick(10_000);
  assert.ok(first.every((m) => h.app.repos.messages.get(m.id)!.status === 'superseded'));
  const next = texts(h, id, 'scheduled');
  assert.ok(next.some((m) => /价格/.test(m.text)), 'the new draft answers the newest message');
});

test('a campaign restricted to overseas platforms cannot run on a Chinese platform', async () => {
  const h = harness();
  const vpn = h.app.repos.campaigns.list().find((c) => c.name.includes('VPN'))!;
  assert.deepEqual(vpn.allowedPlatforms, ['x', 'instagram', 'youtube']);
  const wechat = h.app.repos.accounts.create({ name: '微信号', platform: 'wechat', connector: 'manual', defaultCampaignId: vpn.id });
  const id = h.inbound('你好', {}, wechat.id);
  assert.equal(h.app.repos.conversations.get(id)!.campaignId, null, 'not assigned at creation');

  h.app.repos.conversations.update(id, { campaignId: vpn.id });
  await h.app.pipeline.generate(id, { trigger: 'regenerate' });
  assert.equal(texts(h, id).length, 0);
  assert.match(JSON.stringify(h.app.repos.events.list({ conversationId: id })), /不允许在 微信 上运行/);

  const skill = h.app.repos.skills.getBySlug('vpn-intro-overseas')!;
  assert.deepEqual(skill.allowedPlatforms, ['x', 'instagram', 'youtube']);
});

test('kill switch: autopilot keeps drafting but stops sending', async () => {
  const h = harness();
  useCampaign(h, { mode: 'autopilot' });
  const id = h.inbound('你好');
  await h.tick(10_000);
  h.app.repos.settings.patch({ autopilotPaused: true });
  await h.tick(5 * MINUTE);
  const out = texts(h, id);
  assert.ok(out.every((m) => m.status === 'pending_approval'), JSON.stringify(out.map((m) => m.status)));
  assert.match(out[0]!.reviewReason, /暂停/);
});

test('per-account rate limits delay automated sends instead of dropping them', async () => {
  const h = harness();
  const campaign = h.campaign({ mode: 'autopilot' });
  const acct = h.app.repos.accounts.create({ name: '限速', platform: 'sandbox', connector: 'sandbox', defaultCampaignId: campaign.id, maxPerHour: 1, quietStart: '00:00', quietEnd: '00:00' });
  const id = h.inbound('你好', {}, acct.id);
  await h.tick(10_000);
  await h.tick(5 * MINUTE);
  assert.deepEqual(texts(h, id).map((m) => m.status), ['sent', 'scheduled']);
  await h.tick(HOUR + 11 * MINUTE);
  assert.deepEqual(texts(h, id).map((m) => m.status), ['sent', 'sent']);
});

test('quiet hours push automated sends to the morning; an approved message goes out regardless', async () => {
  const h = harness();
  const campaign = h.campaign({ mode: 'autopilot' });
  const acct = h.app.repos.accounts.create({ name: '夜间', platform: 'sandbox', connector: 'sandbox', defaultCampaignId: campaign.id, quietStart: '23:00', quietEnd: '08:00', timezone: 'Asia/Shanghai' });
  h.clock.set(Date.UTC(2026, 0, 5, 15, 30)); // 23:30 in Shanghai
  const id = h.inbound('睡了吗', {}, acct.id);
  await h.tick(10_000);
  const out = texts(h, id, 'scheduled');
  assert.ok(out.length > 0);
  const morning = Date.UTC(2026, 0, 6, 0, 0); // 08:00 in Shanghai
  assert.ok(out.every((m) => m.sendAt! >= morning), 'scheduled for after 08:00');
  await h.tick(HOUR);
  assert.equal(texts(h, id, 'sent').length, 0);

  const manual = h.app.pipeline.operatorSend(id, '我本人回一下');
  await h.tick(0);
  assert.equal(h.app.repos.messages.get(manual.id)!.status, 'sent');
});

test('crash recovery never resends: a message caught mid-send is reported, not retried', async () => {
  const h = harness();
  const id = h.inbound('你好');
  await h.tick(10_000);
  const draft = texts(h, id)[0]!;
  h.app.repos.messages.update(draft.id, { status: 'sending' });
  h.app.pipeline.recoverInterrupted();
  const after = h.app.repos.messages.get(draft.id)!;
  assert.equal(after.status, 'failed');
  assert.match(after.error, /无法确认/);
});

test('the owner replying from the platform app drops queued AI messages and pauses autopilot for that chat', async () => {
  const h = harness();
  useCampaign(h, { mode: 'autopilot', replyDelayMinS: 60, replyDelayMaxS: 60 });
  const id = h.inbound('你好');
  await h.tick(10_000);
  h.inbound('我自己回了', { fromSelf: true });
  await h.tick(5 * MINUTE);
  assert.equal(texts(h, id, 'sent').filter((m) => m.author === 'ai').length, 0);
  assert.equal(h.app.repos.conversations.get(id)!.modeOverride, 'copilot');
});

test('follow-ups: only after the person engaged, and never more than the cap', async () => {
  const h = harness();
  useCampaign(h, { mode: 'autopilot', followupEnabled: true, followupAfterH: 20, followupMax: 1 });
  const id = h.inbound('你好');
  await h.tick(10_000);
  await h.tick(5 * MINUTE);
  await h.settle();
  assert.equal(h.app.pipeline.scanFollowups(), 0, 'too early');
  h.clock.advance(21 * HOUR);
  assert.equal(h.app.pipeline.scanFollowups(), 1);
  await h.tick(0);
  assert.equal(h.app.repos.conversations.get(id)!.followupsSent, 1);
  await h.tick(10 * MINUTE);
  await h.settle();
  h.clock.advance(21 * HOUR);
  assert.equal(h.app.pipeline.scanFollowups(), 0, 'cap reached');
});

test('old messages seen for the first time are history, not something to answer', async () => {
  const h = harness();
  const acct = h.app.repos.accounts.create({ name: 'hook', platform: 'other', connector: 'webhook', defaultCampaignId: 'camp_default' });
  const id = h.inbound('三天前的评论', { timestamp: h.clock.now() - 72 * HOUR }, acct.id);
  await h.tick(HOUR);
  assert.equal(h.app.repos.messages.byConversation(id).length, 1);
  assert.equal(h.app.db.all('SELECT id FROM llm_calls').length, 0);
});

test('manual bridge: nothing can be auto-sent; the owner marks it sent', async () => {
  const h = harness();
  const autopilot = h.campaign({ mode: 'autopilot' });
  const acct = h.app.repos.accounts.create({ name: '个人微信', platform: 'wechat', connector: 'manual', defaultCampaignId: autopilot.id });
  const id = h.inbound('你好', {}, acct.id);
  await h.tick(10_000);
  const draft = texts(h, id)[0]!;
  assert.equal(draft.status, 'pending_approval', 'autopilot campaign degrades to copilot on a manual account');
  assert.equal(draft.kind, 'text');
  assert.throws(() => h.app.pipeline.approve(draft.id), /不能自动发送/);
  h.app.pipeline.markSent(draft.id);
  assert.equal(h.app.repos.messages.get(draft.id)!.status, 'sent');
});

test('an opener is always a draft, even in an autopilot campaign', async () => {
  const h = harness();
  const campaign = h.campaign({ mode: 'autopilot' });
  const contact = h.app.repos.contacts.upsert(SANDBOX, { platformUserId: 'new-person', displayName: '新朋友' });
  const c = h.app.repos.conversations.create({ accountId: SANDBOX, contactId: contact.id, campaignId: campaign.id, kind: 'dm', threadRef: 'new-person', title: '', deadlineAt: null });
  await h.app.pipeline.generate(c.id, { trigger: 'opener' });
  const out = texts(h, c.id);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.status, 'pending_approval');
});

test('simulation: a full conversation is played and judged; a persona who says stop gets silence', async () => {
  const h = harness();
  const campaign = h.campaign({ mode: 'autopilot', allowedLinks: ['https://example.com/product'] });
  const run = h.app.repos.simRuns.create({ campaignId: campaign.id, agentProviderId: null, contactProviderId: null, persona: { name: '忙碌的上班族', description: '', language: 'zh-Hans' }, maxTurns: 6 });
  await h.app.simulator.run(run.id);
  const done = h.app.repos.simRuns.get(run.id)!;
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.report!.goalAchieved, true);
  const transcript = h.app.repos.messages.delivered(done.conversationId!, 100);
  assert.ok(transcript.some((m) => m.kind === 'disclosure'));
  assert.ok(transcript.some((m) => m.text.includes('https://example.com/product')));

  const leaver = h.app.repos.simRuns.create({ campaignId: campaign.id, agentProviderId: null, contactProviderId: null, persona: { name: '想结束对话的人', description: '', language: 'zh-Hans' }, maxTurns: 6 });
  await h.app.simulator.run(leaver.id);
  const left = h.app.repos.simRuns.get(leaver.id)!;
  assert.equal(h.app.repos.conversations.get(left.conversationId!)!.state, 'opted_out');
});
