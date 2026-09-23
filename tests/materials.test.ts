import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MINUTE } from '../src/server/util.ts';
import { SANDBOX, harness } from './helpers.ts';
import type { Material } from '../src/shared/types.ts';

const M1: Material = { id: 'm1', title: '露营装备清单', url: 'https://ex.com/v/1', description: '三分钟讲清新手要买什么', tags: ['露营', '户外'] };
const M2: Material = { id: 'm2', title: '二手车避坑', url: 'https://ex.com/v/2', description: '看车时最容易被骗的五处', tags: ['二手车'] };

const out = (h: ReturnType<typeof harness>, id: string, status?: string) =>
  h.app.repos.messages.byConversation(id).filter((m) => m.direction === 'out' && (!status || m.status === status));

const shares = (h: ReturnType<typeof harness>, conversationId: string) =>
  h.app.repos.events.list({ conversationId, limit: 100 }).filter((e) => e.type === 'material_shared');

function setup(h: ReturnType<typeof harness>, materials: Material[], model = 'mock-material') {
  const p = h.provider(model);
  const campaign = h.campaign({ mode: 'autopilot', providerIds: [p.id], materials });
  h.app.repos.accounts.update(SANDBOX, { defaultCampaignId: campaign.id });
  return campaign;
}

test('素材链接过得了白名单，发出去之后才记一次分享', async () => {
  const h = harness();
  setup(h, [M1]);
  const id = h.inbound('最近想去露营，装备完全不懂');
  await h.tick(10_000);

  const drafted = out(h, id).filter((m) => m.kind === 'text');
  assert.equal(drafted.length, 1, JSON.stringify(out(h, id).map((m) => m.text)));
  assert.ok(drafted[0]!.text.includes(M1.url), drafted[0]!.text);
  assert.equal(shares(h, id).length, 0, '草稿阶段不该记账：稿子可能被否决或改写');

  await h.tick(2 * MINUTE);
  await h.settle();
  assert.equal(out(h, id, 'sent').filter((m) => m.kind === 'text').length, 1);
  const ev = shares(h, id);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0]!.data, { materialId: 'm1', title: M1.title, campaignId: h.app.repos.conversations.get(id)!.campaignId });
});

test('兴趣写进联系人，下一轮提示词带上兴趣和已分享清单', async () => {
  const h = harness();
  setup(h, [M1]);
  const id = h.inbound('最近想去露营');
  await h.tick(10_000);
  await h.tick(2 * MINUTE);
  await h.settle();

  const contactId = h.app.repos.conversations.get(id)!.contactId;
  assert.ok(h.app.repos.contacts.get(contactId)!.tags.includes('露营'));

  h.inbound('看了，还不错');
  await h.tick(10_000);
  const calls = h.app.db.all<{ systemPrompt: string }>("SELECT systemPrompt FROM llm_calls WHERE purpose = 'reply' ORDER BY rowid DESC LIMIT 1");
  const prompt = calls[0]!.systemPrompt;
  assert.ok(prompt.includes('兴趣：露营'), '联系人兴趣没进提示词');
  assert.ok(prompt.includes('已分享过的素材'), '已分享清单没进提示词');
  assert.ok(prompt.includes(M1.title), '已分享的是哪一条没说清楚');
});

test('重复发已分享过的素材会被扣下来等人确认，不自动发出', async () => {
  const h = harness();
  setup(h, [M1]);
  const id = h.inbound('想去露营');
  await h.tick(10_000);
  await h.tick(2 * MINUTE);
  await h.settle();
  assert.equal(shares(h, id).length, 1);

  // 库里只有一条，mock 会退回去重发同一条——正是要拦的情况。
  h.inbound('再说说别的');
  await h.tick(10_000);
  const held = out(h, id).filter((m) => m.status === 'pending_approval');
  assert.equal(held.length, 1, JSON.stringify(out(h, id).map((m) => [m.status, m.reviewReason])));
  assert.match(held[0]!.reviewReason, /已经分享过/);

  await h.tick(5 * MINUTE);
  await h.settle();
  assert.equal(shares(h, id).length, 1, '扣下来的稿子不该再记一次分享');
});

test('一次发两条素材也会被扣下来', async () => {
  const h = harness();
  setup(h, [M1, M2], 'mock-material-multi');
  const id = h.inbound('想去露营，顺便想买个二手车');
  await h.tick(10_000);
  // autopilot 首轮前面还有一条 AI 身份披露气泡，只看正文那条。
  const held = out(h, id).filter((m) => m.status === 'pending_approval' && m.kind === 'text');
  assert.equal(held.length, 1, JSON.stringify(out(h, id).map((m) => [m.status, m.reviewReason])));
  assert.match(held[0]!.reviewReason, /一次发了 2 条素材/);
});

test('有素材库也不放过没列进来的链接：照样两次不过就转人工', async () => {
  const h = harness();
  setup(h, [M1], 'mock-badlink');
  const id = h.inbound('想去露营');
  await h.tick(10_000);
  assert.equal(h.app.repos.conversations.get(id)!.state, 'handoff');
  assert.equal(out(h, id).filter((m) => m.kind === 'text').length, 0);
});

test('屏蔽链接的平台上，提示词只报标题不给 URL', async () => {
  const h = harness();
  const p = h.provider('mock-material');
  const campaign = h.campaign({ mode: 'autopilot', providerIds: [p.id], materials: [M1], linkFallback: '主页置顶那条' });
  const account = h.app.repos.accounts.create({ name: '小红书号', platform: 'xiaohongshu', connector: 'manual', defaultCampaignId: campaign.id, quietStart: '00:00', quietEnd: '00:00', maxPerHour: 100, maxPerDay: 100, maxPerContactDay: 100, pollIntervalS: 0 });
  const id = h.inbound('想去露营', {}, account.id);
  await h.tick(10_000);

  const prompt = h.app.db.all<{ systemPrompt: string }>("SELECT systemPrompt FROM llm_calls WHERE purpose = 'reply' ORDER BY rowid DESC LIMIT 1")[0]!.systemPrompt;
  assert.ok(prompt.includes(M1.title), '标题该出现');
  assert.ok(!prompt.includes(M1.url), '屏蔽链接的平台不该把 URL 给模型');
  assert.ok(prompt.includes('主页置顶那条'), '替代说法该出现');
});

test('按兴趣分享素材这个技能随安装内置进来，并挂在示例任务上', () => {
  const h = harness();
  const skill = h.app.repos.skills.getBySlug('material-match');
  assert.ok(skill, '内置技能没装进来');
  const campaign = h.app.repos.campaigns.list().find((c) => c.name.includes('分享一条短视频'));
  assert.ok(campaign!.skillIds.includes(skill!.id), '示例任务没挂上这个技能');
});
