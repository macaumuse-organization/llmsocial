import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MY_NAMES, joinFragments, parseChatText } from '../src/shared/chatText.ts';

const sides = (text: string, opts?: { contactName?: string; myNames?: string[] }) => parseChatText(text, opts).map((m) => m.side);
const texts = (text: string, opts?: { contactName?: string; myNames?: string[] }) => parseChatText(text, opts).map((m) => m.text);

test('「名字：内容」前缀，半角和全角冒号都认', () => {
  const pasted = ['小王: 在吗', '我：在的', '小王：这个怎么收费'].join('\n');
  assert.deepEqual(texts(pasted, { contactName: '小王' }), ['在吗', '在的', '这个怎么收费']);
  assert.deepEqual(sides(pasted, { contactName: '小王' }), ['contact', 'me', 'contact']);
});

test('微信电脑版复制出来的「名字 时间」抬头，正文在下一行', () => {
  const pasted = ['小王 10:23', '在吗', '', '我 2024-01-01 10:24:05', '在的，什么事'].join('\n');
  assert.deepEqual(parseChatText(pasted, { contactName: '小王' }), [
    { side: 'contact', text: '在吗' },
    { side: 'me', text: '在的，什么事' },
  ]);
});

test('导出格式：时间在前的两种抬头', () => {
  assert.deepEqual(parseChatText('[10:23] 小王: 在吗\n2024-01-01 10:24:05 我\n在的', { contactName: '小王' }), [
    { side: 'contact', text: '在吗' },
    { side: 'me', text: '在的' },
  ]);
});

test('续行接到上一条：中文直接接，英文之间留空格', () => {
  assert.deepEqual(texts('小王: 你好\n我想问一下\n我: ok,\nthanks', { contactName: '小王' }), ['你好我想问一下', 'ok, thanks']);
  assert.equal(joinFragments('ok,', 'then'), 'ok, then');
  assert.equal(joinFragments('好', '的'), '好的');
});

test('时间和状态行丢掉，但「发送」「100」在粘贴文字里是正经内容', () => {
  const pasted = ['10:25', '昨天 14:02', '2024年1月1日', '小王: 在吗', '已读', '对方已撤回一条消息', '我: 100', '小王: 发送'].join('\n');
  assert.deepEqual(parseChatText(pasted, { contactName: '小王' }), [
    { side: 'contact', text: '在吗' },
    { side: 'me', text: '100' },
    { side: 'contact', text: '发送' },
  ]);
});

test('我方认「我」「me」和账号名，对方称呼优先，没见过的第三个名字归对方', () => {
  const pasted = ['我: a', 'Me: b', '小号运营: c', '小王: d', '老李: e', '老李: f'].join('\n');
  assert.deepEqual(sides(pasted, { contactName: '小王', myNames: ['小号运营'] }), ['me', 'me', 'me', 'contact', 'contact', 'contact']);
  // 对方称呼和我方名字撞了，按对方算——那是操作者当场填的，比默认值更可信。
  assert.deepEqual(sides('我: a', { contactName: '我' }), ['contact']);
  assert.ok(DEFAULT_MY_NAMES.includes('我'));
});

test('没见过、又只出现一次的前缀宁可当正文，不切成发言人', () => {
  // 和上面「价格：200」靠的是同一条规则。切错了会把一句话劈成两条、内容对不上人；
  // 并进上一条只是难看，操作者在行编辑器里看得见那个前缀，想拆随时能拆。
  const pasted = ['我: 问一下', '小王: 稍等', '老李: 我来答'].join('\n');
  assert.deepEqual(parseChatText(pasted, { contactName: '小王' }), [
    { side: 'me', text: '问一下' },
    { side: 'contact', text: '稍等老李: 我来答' },
  ]);
});

test('句子里的冒号不算发言人', () => {
  const pasted = ['小王: 想问下价格', '价格：200', '还有运费：15', '我: 好的'].join('\n');
  assert.deepEqual(parseChatText(pasted, { contactName: '小王' }), [
    { side: 'contact', text: '想问下价格价格：200还有运费：15' },
    { side: 'me', text: '好的' },
  ]);
});

test('只有两行、名字都没见过，照样当成两个人', () => {
  assert.deepEqual(parseChatText('小王：在吗\n小张：在'), [
    { side: 'contact', text: '在吗' },
    { side: 'contact', text: '在' },
  ]);
});

test('链接不会被当成发言人', () => {
  assert.deepEqual(parseChatText('我: 看这个 https://x.y/z\nhttps://a.b/c', { contactName: '小王' }), [
    { side: 'me', text: '看这个 https://x.y/z https://a.b/c' },
  ]);
});

test('一条前缀都没有时，每行一条，全算对方，不猜谁在说话', () => {
  assert.deepEqual(parseChatText('在吗\n想问一下这个怎么做的\n方便的话回我一下'), [
    { side: 'contact', text: '在吗' },
    { side: 'contact', text: '想问一下这个怎么做的' },
    { side: 'contact', text: '方便的话回我一下' },
  ]);
});

test('「明天 10:23」这种消息不会被当成抬头把内容吃掉', () => {
  assert.deepEqual(parseChatText('小王: 什么时候\n我: 明天 10:23', { contactName: '小王' }), [
    { side: 'contact', text: '什么时候' },
    { side: 'me', text: '明天 10:23' },
  ]);
});

test('空输入给空数组', () => {
  assert.deepEqual(parseChatText(''), []);
  assert.deepEqual(parseChatText('   \n\n  \n'), []);
});
