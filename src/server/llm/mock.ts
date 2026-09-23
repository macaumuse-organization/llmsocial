import { LABEL_AI_TURNS, LABEL_CONTACT, LABEL_LINKS, LABEL_MATERIALS, LABEL_SHARED_MATERIALS } from '../agent/prompt.ts';
import { LlmError, type ChatRequest, type ChatResult, type LlmClient, type ProviderRuntime } from './types.ts';
import { sleep } from '../util.ts';

// Offline, deterministic stand-in for a real model. Drives the tests, the classroom demo and
// first-run exploration without an API key. The `model` field selects a behaviour:
//   mock-friendly  plausible replies        mock-fail        always errors (tests fallback)
//   mock-badjson   never returns JSON       mock-humanclaim  claims to be human (tests the guard)
//   mock-badlink   sends an unlisted link   mock-slow        200 ms latency
//   mock-material  shares one library item   mock-material-multi  shares two at once

function lastContactLine(user: string): string {
  const fresh = /<new_messages>([\s\S]*?)<\/new_messages>/.exec(user)?.[1] ?? '';
  const lines = [...fresh.matchAll(new RegExp(`\\] ${LABEL_CONTACT}: (.*)$`, 'gm'))];
  return lines.length ? (lines[lines.length - 1]![1] ?? '') : '';
}

function reply(req: ChatRequest, variant: string): unknown {
  const last = lastContactLine(req.user);
  const english = last !== '' && /^[\x00-\x7F]+$/.test(last);
  const turns = Number(new RegExp(`${LABEL_AI_TURNS}：(\\d+)`).exec(req.systemDynamic)?.[1] ?? 0);
  const linkBlock = req.systemStatic.split(`## ${LABEL_LINKS}`)[1]?.split('\n#')[0] ?? '';
  const link = /^- (https?:\/\/\S+)/m.exec(linkBlock)?.[1] ?? '';
  const analysis = { intent: 'mock', sentiment: 'neutral', stage: 'engaged', goal_progress: Math.min(90, 20 + turns * 20), opt_out: false, risk_flags: [] as string[], language: english ? 'en' : 'zh-Hans', notes: 'mock provider' };
  const out = { analysis, action: 'reply', messages: [] as string[], memory_add: [] as string[], interest_tags: [] as string[], handoff_reason: '' };

  // The materials block sits after the links block, so it survives the `\n#` cut above.
  const materialBlock = req.systemStatic.split(`## ${LABEL_MATERIALS}`)[1]?.split('\n#')[0] ?? '';
  const materials = [...materialBlock.matchAll(/^- ([^｜\n]+)｜.*?链接：(https?:\/\/\S+)/gm)].map((m) => ({ title: m[1]!, url: m[2]! }));
  const alreadyShared = new RegExp(`${LABEL_SHARED_MATERIALS}[^\n]*：([^\n]*)`).exec(req.systemDynamic)?.[1] ?? '';

  if (variant === 'mock-humanclaim') {
    out.messages = ['放心，我是真人，不是机器人。'];
  } else if (variant === 'mock-badlink') {
    out.messages = ['看看这个 https://evil.example.com/promo'];
  } else if (variant === 'mock-material' && materials.length > 0) {
    // Falls back to an already-shared one on purpose, so the repeat hold is testable.
    const pick = materials.find((m) => !alreadyShared.includes(m.title)) ?? materials[0]!;
    out.messages = [`你说的这个我正好有一条，${pick.title}：${pick.url}`];
    out.interest_tags = ['露营'];
  } else if (variant === 'mock-material-multi' && materials.length > 0) {
    out.messages = [`两条都合适：${materials.map((m) => m.url).join(' 还有 ')}`];
  } else if (/不需要|不感兴趣|没兴趣|no thanks|not interested/i.test(last)) {
    analysis.stage = 'declined';
    analysis.sentiment = 'negative';
    out.action = 'close';
    out.messages = [english ? 'No problem at all. Have a good one!' : '好的，不打扰啦，祝一切顺利～'];
  } else if (/多少钱|价格|怎么收费|how much|price/i.test(last)) {
    analysis.stage = 'interested';
    out.messages = [english ? 'Let me confirm the exact pricing and get back to you.' : '具体价格我得确认一下再告诉你，免得说错。'];
  } else if (turns >= 3 && /好的|可以|看了|不错|ok|sounds good|will do/i.test(last)) {
    analysis.stage = 'converted';
    analysis.sentiment = 'positive';
    analysis.goal_progress = 100;
    out.messages = [english ? 'Great, tell me what you think after.' : '太好了，看完跟我说说感受～'];
  } else if (turns >= 2 && link) {
    analysis.stage = 'offer_made';
    out.messages = [english ? `This might be useful for that: ${link}` : `你说的这个需求，可以看看这个：${link}`];
  } else {
    const snippet = last.slice(0, 12);
    out.messages = [english ? `Got it${snippet ? ` — "${snippet}"` : ''}. What got you interested in that?` : `哈哈${snippet ? `，你说的「${snippet}」我懂` : '你好'}～平时也会关注这类内容吗？`];
    if (last.length > 6) out.memory_add = [`提到过：${last.slice(0, 40)}`];
  }
  return out;
}

const SIM_SCRIPT = ['你好，刷到你的视频了', '哈哈是吗，具体是做什么的？', '听起来还行，有链接吗？', '好的我看看', '看了，不错'];
const SIM_LEAVER = ['你好', '不太感兴趣', '别再发了'];

function simContact(req: ChatRequest): unknown {
  const turn = Number(/SIM_TURN: (\d+)/.exec(req.systemDynamic)?.[1] ?? 0);
  const script = req.systemStatic.includes('想结束对话') ? SIM_LEAVER : SIM_SCRIPT;
  return { messages: turn < script.length ? [script[turn]] : [], leave: turn >= script.length - 1 };
}

function judge(req: ChatRequest): unknown {
  const achieved = /https?:\/\//.test(req.user) && /不错|好的|great/i.test(req.user);
  return {
    goal_achieved: achieved,
    score: achieved ? 82 : 45,
    naturalness: 7,
    pushiness: 2,
    material_fit: 10,
    honesty_violations: [],
    summary: achieved ? '对方收到了链接并表示认可（mock 评审）。' : '目标未达成（mock 评审）。',
    suggestions: ['这是离线 mock 评审。接入真实模型后可以得到有区分度的评分。'],
  };
}

export function createMockClient(rt: ProviderRuntime): LlmClient {
  const variant = rt.provider.model;
  return {
    async chat(req: ChatRequest): Promise<ChatResult> {
      if (variant === 'mock-slow') await sleep(200);
      if (variant === 'mock-fail') throw new LlmError('server', 'mock provider configured to fail');
      let text: string;
      if (variant === 'mock-badjson') text = 'Sure! Here is my answer, with no JSON anywhere.';
      else if (req.purpose === 'sim_contact') text = JSON.stringify(simContact(req));
      else if (req.purpose === 'judge') text = JSON.stringify(judge(req));
      else if (req.purpose === 'summary') text = JSON.stringify({ summary: '（mock 摘要）对方聊过几句，态度友好。', facts: [] });
      else if (req.purpose === 'test') text = JSON.stringify({ ok: true });
      else text = JSON.stringify(reply(req, variant));
      const size = req.systemStatic.length + req.systemDynamic.length + req.user.length;
      return { text, model: variant, inputTokens: Math.ceil(size / 2), outputTokens: Math.ceil(text.length / 2), cacheReadTokens: 0 };
    },
  };
}
