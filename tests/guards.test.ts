import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkOutbound, detectOptOut, detectRisk, fitToPlatform, isValidDisclosure, weightedLength } from '../src/server/agent/guards.ts';
import { detectLanguage } from '../src/server/agent/language.ts';
import { parseChatScreenshot } from '../src/server/ocr/parseChat.ts';
import { similarity, tooSimilarToRecent } from '../src/server/agent/similarity.ts';
import { platformProfile } from '../src/shared/platforms.ts';
import { extractJson } from '../src/server/llm/json.ts';

test('opt-out is recognised across the phrasings people actually use', () => {
  for (const text of ['别再发了', '不要再联系我', '請停止發送', '唔好再煩我', 'STOP', 'unsubscribe', 'stop messaging me', "don't contact me", 'leave me alone', '再发我就举报你']) {
    assert.equal(detectOptOut(text), true, text);
  }
});

test('ordinary messages are not mistaken for opt-outs', () => {
  for (const text of ['别发太大的文件', '不要再想了，赶紧睡', '我不想再拖了，今天就做', 'stop by tomorrow?', '这个停止按钮在哪', '我要取消订单']) {
    assert.equal(detectOptOut(text), false, text);
  }
});

test('risk keywords fire on the sentences that matter', () => {
  assert.deepEqual(detectRisk('先转账 500 定金吧').includes('payment'), true);
  assert.deepEqual(detectRisk('验证码发我一下').includes('verification_code'), true);
  assert.deepEqual(detectRisk('我今年 16 岁').includes('minor'), true);
  assert.deepEqual(detectRisk("i'm 15 and i love your videos").includes('minor'), true);
  assert.deepEqual(detectRisk('最近真的不想活了').includes('self_harm'), true);
  assert.deepEqual(detectRisk('你这样是骚扰我').includes('harassment'), true);
  // "16 分钟" and "I'm 5 minutes away" must not read as an age.
  assert.equal(detectRisk('我 16 分钟后到').includes('minor'), false);
  assert.equal(detectRisk("i'm 5 minutes away").includes('minor'), false);
  assert.equal(detectRisk('今天天气不错').length, 0);
});

test('a disclosure that never says AI is not a disclosure', () => {
  assert.equal(isValidDisclosure('（我是这个账号的 AI 助理）'), true);
  assert.equal(isValidDisclosure('這是數字人自動回覆'), true);
  assert.equal(isValidDisclosure('This account uses an automated assistant.'), true);
  assert.equal(isValidDisclosure('你好呀～'), false);
  assert.equal(isValidDisclosure(''), false);
});

const ctx = { autopilot: true, allowedLinks: ['https://example.com/p'], linksBlocked: false, canary: 'CANARY-abc', protectedTexts: [] };

test('outbound guard catches human claims, sensitive asks, stray links and prompt leaks', () => {
  assert.equal(checkOutbound(['你好呀'], ctx).ok, true);
  assert.equal(checkOutbound(['我是真人啦'], ctx).code, 'human_claim');
  assert.equal(checkOutbound(["I'm not a bot, promise"], ctx).code, 'human_claim');
  assert.equal(checkOutbound(['把验证码发我'], ctx).code, 'sensitive_ask');
  assert.equal(checkOutbound(['看这个 https://evil.com/x'], ctx).code, 'link_not_allowed');
  assert.equal(checkOutbound(['看这个 https://example.com/p?ref=1'], ctx).ok, true);
  assert.equal(checkOutbound(['内部标记 CANARY-abc'], ctx).code, 'prompt_leak');
  assert.equal(checkOutbound(['看这个 https://example.com/p'], { ...ctx, linksBlocked: true }).code, 'link_not_allowed');
  // In copilot the owner is sending, so claiming to be a person is simply true.
  assert.equal(checkOutbound(['我是真人啦'], { ...ctx, autopilot: false }).ok, true);
});

test('a reply that quotes the skill text back is treated as a leak', () => {
  const skill = '推荐的前提是对方有这个需求。没有需求就不推荐，这一轮好好聊天就够了。步骤：听出需求，把产品和需求对上。';
  assert.equal(checkOutbound([skill], { ...ctx, protectedTexts: [skill] }).code, 'prompt_leak');
});

test('X counts CJK as double width, and long messages split at sentence ends', () => {
  assert.equal(weightedLength('你好', true), 4);
  assert.equal(weightedLength('hello', true), 5);
  const long = '这是第一句话。这是第二句话。'.repeat(60);
  // A public comment is one post, never a thread: the overflow is dropped, not chained.
  const parts = fitToPlatform([long], platformProfile('x'), 'comment');
  assert.equal(parts.length, 1);
  assert.ok(weightedLength(parts[0]!, true) <= 270, String(weightedLength(parts[0]!, true)));
  assert.ok(parts[0]!.endsWith('。'), 'split lands on a sentence boundary');
  const dmParts = fitToPlatform([long], platformProfile('x'), 'dm');
  assert.ok(dmParts.length > 1);
  assert.ok(dmParts.every((p) => weightedLength(p, true) <= 1000), dmParts.map((p) => weightedLength(p, true)).join(','));
});

test('language detection separates simplified, traditional, Cantonese and the rest', () => {
  assert.equal(detectLanguage('你好，这个视频真不错'), 'zh-Hans');
  assert.equal(detectLanguage('你好，這個影片真不錯'), 'zh-Hant');
  assert.equal(detectLanguage('你好呀，我喺香港嚟嘅，唔知呢個點用'), 'yue');
  assert.equal(detectLanguage('Hello, how does this work?'), 'latin');
  assert.equal(detectLanguage('こんにちは、これは何ですか'), 'ja');
  assert.equal(detectLanguage('안녕하세요'), 'ko');
});

test('near-duplicate outbound text is caught, genuinely different text is not', () => {
  const opener = '你好呀，刚看到你分享的那条视频，讲的东西挺有意思的，想问问你平时都关注这方面吗？';
  // The shape spam takes: one opener reused with a word or a name swapped.
  assert.ok(tooSimilarToRecent('你好呀，刚看到你分享的那条视频，讲的东西挺有意思的，想问问你平时都关注这类内容吗？', [opener]));
  assert.ok(tooSimilarToRecent('小王你好，刚看到你分享的那条视频，讲的东西挺有意思的，想问问你平时都关注这方面吗？', [opener]));
  assert.equal(tooSimilarToRecent('看到你在评论区说起这个，我也有同感。你是做设计的吗？', [opener]), false);
  assert.ok(similarity(opener, opener) === 1);
  // Short acknowledgements are naturally identical and must not be blocked.
  assert.equal(tooSimilarToRecent('好的～', ['好的～']), false);
});

test('a chat screenshot becomes ordered messages with the right sides', () => {
  const line = (text: string, x: number, w: number, y: number) => ({ text, x, y, w, h: 0.03, confidence: 0.95 });
  const parsed = parseChatScreenshot([
    line('10:25', 0.45, 0.1, 0.02),
    line('昨天 14:02', 0.42, 0.16, 0.1),
    line('你好，刷到你的视频了', 0.06, 0.4, 0.2),
    line('想问一下这个怎么做的', 0.06, 0.42, 0.24),
    line('你好呀，谢谢关注', 0.55, 0.39, 0.32),
    line('发送', 0.05, 0.08, 0.97),
  ]);
  assert.deepEqual(
    parsed.map((m) => m.side),
    ['contact', 'me'],
  );
  assert.equal(parsed[0]!.text, '你好，刷到你的视频了想问一下这个怎么做的');
  assert.equal(parsed[1]!.text, '你好呀，谢谢关注');
});

test('model JSON survives code fences, prose and thinking tags', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! {"a": "}"} done'), { a: '}' });
  assert.deepEqual(extractJson('<think>hmm</think>\n{"a":[1,2]}'), { a: [1, 2] });
  assert.throws(() => extractJson('no json here'));
});
