// One-off measurement, not part of `npm test`: prints the similarity distribution that the 0.72
// threshold has to separate. The recorded numbers in docs/安全边界.md came from this.
// Run: node scripts/measure-similarity.ts
import { similarity, tooSimilarToRecent } from '../src/server/agent/similarity.ts';

/** [语言/场景, 同一模板换了名字或词, 真正不同的另一条] */
const CASES: [string, string[], string[]][] = [
  [
    '中文私信开场白',
    [
      '你好呀，刚看到你分享的那条视频，讲的东西挺有意思的，想问问你平时都关注这方面吗？',
      '你好呀，刚看到你分享的那条视频，讲的东西挺有意思的，想问问你平时都关注这类内容吗？',
      '小王你好，刚看到你分享的那条视频，讲的东西挺有意思的，想问问你平时都关注这方面吗？',
    ],
    ['看到你在评论区说起这个，我也有同感。你是做设计的吗？', '刚翻到你三月那条，里面提到的那个做法我试过，确实省事。'],
  ],
  [
    '英文私信开场白',
    [
      'Hey! Just saw the video you shared and found it really interesting — do you usually follow this kind of thing?',
      'Hey! Just saw the video you shared and found it really interesting — do you usually follow this sort of content?',
      'Hi Mark! Just saw the video you shared and found it really interesting — do you usually follow this kind of thing?',
    ],
    ['Saw your comment under that post and I felt the same way. Are you in design?', 'Your March clip came up on my feed — the trick you showed actually saved me an hour.'],
  ],
  [
    '粵語口語',
    [
      '你好呀，啱啱睇到你分享嗰條片，講嘅嘢幾有趣，想問下你平時係咪都留意呢方面？',
      '你好呀，啱啱睇到你分享嗰條片，講嘅嘢幾有趣，想問下你平時係咪都留意呢類內容？',
      '阿明你好，啱啱睇到你分享嗰條片，講嘅嘢幾有趣，想問下你平時係咪都留意呢方面？',
    ],
    ['睇到你喺留言度講呢樣嘢，我都有同感。你係咪做設計？', '前排翻到你三月嗰條，入面講嗰個方法我試過，真係慳返唔少。'],
  ],
  [
    '评论区短回复',
    [
      '谢谢支持！这条确实花了点心思，后面还会出同系列的',
      '谢谢支持！这期确实花了点心思，后面还会出同系列的',
      '谢谢关注！这条确实花了点心思，之后还会出同系列的',
    ],
    ['这个问题下条视频会讲到', '用的是三脚架加一个补光灯，没别的'],
  ],
];

const fmt = (n: number) => n.toFixed(3);
let worstPositive = 1;
let bestNegative = 0;

for (const [label, templated, different] of CASES) {
  console.log(`\n## ${label}`);
  const base = templated[0]!;
  console.log('  模板换词（希望「高」，要被拦下）：');
  for (const t of templated.slice(1)) {
    const s = similarity(base, t);
    worstPositive = Math.min(worstPositive, s);
    console.log(`    ${fmt(s)}  ${tooSimilarToRecent(t, [base]) ? '拦下' : '★漏过'}  ${t.slice(0, 26)}…`);
  }
  console.log('  真正不同（希望「低」，要放行）：');
  for (const t of different) {
    const s = similarity(base, t);
    bestNegative = Math.max(bestNegative, s);
    console.log(`    ${fmt(s)}  ${tooSimilarToRecent(t, [base]) ? '★误拦' : '放行'}  ${t.slice(0, 26)}…`);
  }
  // 短文本豁免：14 个字符以下不检查，模板化的短开场白会整条溜过去。
  const shortOne = templated[0]!.slice(0, 13);
  console.log(`  短文本豁免：13 字的「${shortOne}」→ ${tooSimilarToRecent(shortOne, [shortOne]) ? '仍检查' : '不检查（豁免）'}`);
}

// 降阈值之前要先知道：共用客套话、但内容真的不同的两条，会到多高？
const ADVERSARIAL: [string, string][] = [
  ['谢谢支持！这条确实花了点心思，后面还会出同系列的', '谢谢支持！这个问题下条视频会讲到，可以蹲一下'],
  ['谢谢支持！这条确实花了点心思，后面还会出同系列的', '谢谢支持！用的是三脚架加一个补光灯，没别的'],
  ['你好呀，刚看到你分享的那条视频，想问问你平时都关注这方面吗？', '你好呀，刚看到你在评论区提的那个问题，我自己也踩过这个坑'],
  ['Thanks for watching! More of these coming soon.', 'Thanks for watching! The lens is a 35mm, nothing fancy.'],
  ['好的，那我先不打扰你了，有需要随时找我', '好的，那我把资料整理一下发你，你看方便什么时候'],
  ['收到，我这边先看看，稍后回你', '收到，我把链接发你，你先看着'],
];

console.log('\n## 对抗性反例（共用客套话，内容真的不同——降阈值最怕误伤这些）');
let worstAdversarial = 0;
for (const [a, b] of ADVERSARIAL) {
  const sim = similarity(a, b);
  worstAdversarial = Math.max(worstAdversarial, sim);
  console.log(`    ${fmt(sim)}  ${a.slice(0, 16)}… ｜ ${b.slice(0, 16)}…`);
}
console.log(`  对抗性反例里最高：${fmt(worstAdversarial)}`);

console.log('\n## 结论');
console.log(`  模板换词里最低的相似度：${fmt(worstPositive)}（低于阈值就会漏过）`);
console.log(`  真正不同里最高的相似度：${fmt(bestNegative)}（高于阈值就会误拦）`);
console.log(`  当前阈值 0.72 落在 [${fmt(bestNegative)}, ${fmt(worstPositive)}] 之间：${bestNegative < 0.72 && 0.72 < worstPositive ? '是，分得开' : '否，需要重新定'}`);
