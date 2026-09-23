import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MINUTE } from '../src/server/util.ts';
import { SANDBOX, harness } from './helpers.ts';

const lead = (h: ReturnType<typeof harness>, over: Partial<Parameters<typeof h.app.pipeline.ingestSignal>[1]> = {}) =>
  h.app.pipeline.ingestSignal(SANDBOX, { kind: 'manual', platformUserId: 'u9', displayName: '路人甲', ref: 'manual:1', timestamp: h.clock.now(), ...over });

const outbound = (h: ReturnType<typeof harness>, id: string) => h.app.repos.messages.byConversation(id).filter((m) => m.direction === 'out');

test('线索开聊后只出草稿：autopilot 任务也不会自动发出任何东西', async () => {
  const h = harness();
  const campaign = h.campaign({ mode: 'autopilot' });
  h.app.repos.accounts.update(SANDBOX, { defaultCampaignId: campaign.id });
  lead(h);

  const signal = h.app.repos.signals.list({ status: 'new' })[0]!;
  assert.equal(signal.platformUserId, 'u9');
  assert.equal(signal.kind, 'manual');

  const contact = h.app.repos.contacts.upsert(SANDBOX, { platformUserId: 'u9' });
  const conversation = h.app.repos.conversations.create({ accountId: SANDBOX, contactId: contact.id, campaignId: campaign.id, kind: 'dm', threadRef: 'u9', title: '', deadlineAt: null });
  h.app.repos.signals.setStatus(signal.id, 'contacted', conversation.id);

  // 空会话让 AI 写开场白：这是唯一的出口，而它必然是草稿。
  const refused = await h.app.pipeline.generate(conversation.id, { trigger: 'opener' });
  assert.equal(refused, '', `被拒了：${refused}`);
  const drafts = outbound(h, conversation.id);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.status, 'pending_approval', '开场白不该是 scheduled');
  assert.equal(drafts[0]!.kind, 'text', 'copilot 的稿子不带 AI 披露气泡，因为是主人自己发');

  // 等足够久，确认没有任何东西被排程发出
  await h.tick(10 * MINUTE);
  await h.settle();
  assert.equal(outbound(h, conversation.id).filter((m) => m.status === 'sent').length, 0, '不该有任何东西被发出去');
});

test('屏蔽名单里的人不会变成线索', () => {
  const h = harness();
  h.app.repos.suppressions.add('sandbox', 'u9', '测试');
  lead(h);
  assert.equal(h.app.repos.signals.list().length, 0);
});

test('同一个平台事件重复推送只留一条线索', () => {
  const h = harness();
  lead(h, { ref: 'sub:1700000000' });
  lead(h, { ref: 'sub:1700000000' });
  assert.equal(h.app.repos.signals.list().length, 1);
  // 换了 ref 就是新线索（比如取关后再订阅）
  lead(h, { ref: 'sub:1700000999' });
  assert.equal(h.app.repos.signals.list().length, 2);
});

test('对方自己来消息之后，线索自动从「新」变「已联系」', async () => {
  const h = harness();
  lead(h, { platformUserId: 'u1' });
  assert.equal(h.app.repos.signals.list({ status: 'new' }).length, 1);

  const id = h.inbound('你好');
  await h.tick(10_000);
  const after = h.app.repos.signals.list()[0]!;
  assert.equal(after.status, 'contacted');
  assert.equal(after.conversationId, id);
  assert.equal(h.app.repos.signals.countNew(), 0);
});

test('已经在聊的人再产生线索，直接记成已联系，不冒充新线索', async () => {
  const h = harness();
  const id = h.inbound('你好');
  await h.tick(10_000);
  lead(h, { platformUserId: 'u1', kind: 'subscribe', ref: 'sub:2' });
  const signal = h.app.repos.signals.list()[0]!;
  assert.equal(signal.status, 'contacted');
  assert.equal(signal.conversationId, id);
});

test('忽略和恢复', () => {
  const h = harness();
  lead(h);
  const signal = h.app.repos.signals.list()[0]!;
  assert.equal(h.app.repos.signals.setStatus(signal.id, 'ignored')!.status, 'ignored');
  assert.equal(h.app.repos.signals.countNew(), 0);
  assert.equal(h.app.repos.signals.setStatus(signal.id, 'new')!.status, 'new');
  assert.equal(h.app.repos.signals.countNew(), 1);
});

test('连接器的 meta 和方法一致：能报线索的才标 canSignals', async () => {
  const { REAL_CONNECTORS } = await import('../src/server/connectors/index.ts');
  for (const connector of REAL_CONNECTORS) {
    assert.equal(connector.meta.canSignals, typeof connector.pollSignals === 'function', `${connector.meta.kind}.canSignals 与 pollSignals() 不一致`);
  }
  // 信号层是入站只读：不该因此多出任何发送能力
  for (const connector of REAL_CONNECTORS) {
    assert.equal(connector.meta.canSend, typeof connector.send === 'function', `${connector.meta.kind}.canSend 变了`);
  }
});
