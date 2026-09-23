import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { buildWebhookServer } from '../src/server/webhooks/server.ts';
import { harness } from './helpers.ts';

// These go through the real HTTP server with inject(), not straight into handleWebhook(). The
// connector unit tests hand-build rawBody, so they never saw how Fastify parses a request — and
// that is exactly where JSON callbacks were losing their bytes.

const SECRET = 'bridge-shared-secret-at-least-24-chars';
const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

function bridge() {
  const h = harness();
  const account = h.app.repos.accounts.create({ name: '消息桥', platform: 'other', connector: 'webhook', defaultCampaignId: null, quietStart: '00:00', quietEnd: '00:00', maxPerHour: 100, maxPerDay: 100, maxPerContactDay: 100, pollIntervalS: 0 });
  const ref = h.app.secrets.put(`acct.${account.id}.sharedSecret`, SECRET);
  h.app.repos.accounts.update(account.id, { secretRefs: { sharedSecret: ref } });
  return { h, accountId: account.id, server: buildWebhookServer(h.app) };
}

const payload = (text: string) => JSON.stringify({ messageId: `m-${text}`, kind: 'dm', threadId: 't1', contact: { id: 'c1', name: '桥那头' }, text, timestamp: Date.UTC(2026, 8, 20) });

test('JSON 回调带着原始字节到达连接器，签名能验过', async () => {
  const { h, accountId, server } = bridge();
  const body = payload('你好');
  const res = await server.inject({ method: 'POST', url: `/webhooks/${accountId}`, headers: { 'content-type': 'application/json', 'x-llmsocial-signature': sign(body) }, payload: body });
  assert.equal(res.statusCode, 200, `签名本该通过：${res.body}`);
  const conversations = h.app.repos.conversations.list({ accountId });
  assert.equal(conversations.length, 1, '消息没有入库');
  assert.ok(h.app.repos.accounts.get(accountId)!.lastWebhookAt !== null, '接受的回调要记下时间');
  await server.close();
});

test('签名错的 JSON 回调被拒，而且不算「跑通」', async () => {
  const { h, accountId, server } = bridge();
  const body = payload('伪造');
  const res = await server.inject({ method: 'POST', url: `/webhooks/${accountId}`, headers: { 'content-type': 'application/json', 'x-llmsocial-signature': sign(body, 'wrong-secret-wrong-secret-wrong') }, payload: body });
  assert.equal(res.statusCode, 401);
  assert.equal(h.app.repos.accounts.get(accountId)!.lastWebhookAt, null);
  assert.equal(h.app.repos.conversations.list({ accountId }).length, 0);
  await server.close();
});

test('XML 和不带 content-type 的回调同样保留原始字节', async () => {
  const { accountId, server } = bridge();
  // 同一个签名方案、不同的 content-type：解析器不能按类型区别对待任何一种。
  for (const type of ['text/xml', 'text/plain', undefined]) {
    const body = payload(`type-${type ?? 'none'}`);
    const headers: Record<string, string> = { 'x-llmsocial-signature': sign(body) };
    if (type) headers['content-type'] = type;
    const res = await server.inject({ method: 'POST', url: `/webhooks/${accountId}`, headers, payload: body });
    assert.equal(res.statusCode, 200, `${type ?? '无 content-type'}：${res.body}`);
  }
  await server.close();
});
