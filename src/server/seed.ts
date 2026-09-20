import fs from 'node:fs';
import path from 'node:path';
import type { PlatformId, Skill } from '../shared/types.ts';
import { PLATFORMS } from '../shared/platforms.ts';
import { FALLBACK_COMMENT_SIGNATURE, FALLBACK_DISCLOSURE } from './agent/pipeline.ts';
import { SANDBOX_ACCOUNT_ID } from './agent/simulator.ts';
import { DEFAULT_PERSONA_ID, type Repos } from './db/repos.ts';

export interface SkillFile {
  slug: string;
  name: string;
  description: string;
  allowedPlatforms: PlatformId[];
  content: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,60}$/;

/** Markdown with a small `key: value` front matter block. Deliberately not a YAML parser. */
export function parseSkillMarkdown(text: string, fallbackSlug = ''): SkillFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const head: Record<string, string> = {};
  if (match) {
    for (const line of match[1]!.split(/\r?\n/)) {
      const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
      if (kv) head[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, '');
    }
  }
  const content = (match ? match[2]! : text).trim();
  const slug = (head.slug || fallbackSlug).toLowerCase();
  if (!SLUG.test(slug)) throw new Error('skill slug must be lowercase letters, digits and dashes');
  if (content === '') throw new Error('skill has no content');
  const known = new Set(PLATFORMS.map((p) => p.id));
  const allowedPlatforms = (head.allowed_platforms ?? '')
    .replace(/[[\]]/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is PlatformId => known.has(s as PlatformId));
  return { slug, name: head.name || slug, description: head.description ?? '', allowedPlatforms, content };
}

export function skillToMarkdown(skill: Pick<Skill, 'slug' | 'name' | 'description' | 'allowedPlatforms' | 'content'>): string {
  return `---\nslug: ${skill.slug}\nname: ${skill.name}\ndescription: ${skill.description}\nallowed_platforms: [${skill.allowedPlatforms.join(', ')}]\n---\n\n${skill.content.trim()}\n`;
}

/** Built-in skills come from ./skills/*.md. Existing rows are left alone so local edits survive upgrades. */
export function importBuiltinSkills(repos: Repos, skillsDir: string): number {
  if (!fs.existsSync(skillsDir)) return 0;
  let added = 0;
  for (const file of fs.readdirSync(skillsDir).filter((f) => f.endsWith('.md')).sort()) {
    const parsed = parseSkillMarkdown(fs.readFileSync(path.join(skillsDir, file), 'utf8'), file.replace(/\.md$/, ''));
    if (repos.skills.getBySlug(parsed.slug)) continue;
    repos.skills.create({ ...parsed, enabled: true, builtin: true });
    added++;
  }
  return added;
}

/** First-run data: enough to open the sandbox and have a working conversation with no keys configured. */
export function seed(repos: Repos, skillsDir: string): void {
  if (!repos.personas.get(DEFAULT_PERSONA_ID)) {
    repos.personas.create(
      { name: '小E', identity: '这个账号的 AI 数字人助理，替账号主人回复消息、介绍内容和产品。', style: '友好、直接、口语化；像一个靠谱的朋友，不像客服话术。', disclosure: FALLBACK_DISCLOSURE, commentSignature: FALLBACK_COMMENT_SIGNATURE },
      DEFAULT_PERSONA_ID,
    );
  }
  importBuiltinSkills(repos, skillsDir);
  if (repos.providers.list().length === 0) {
    repos.providers.create(
      { name: 'Mock（离线演示）', kind: 'mock', baseUrl: '', model: 'mock-friendly', apiKeyRef: '', temperature: null, maxTokens: 1000, effort: null, jsonMode: true, timeoutMs: 10_000, priceIn: null, priceOut: null, dailyTokenLimit: null, enabled: true, priority: 900 },
      'prov_mock',
    );
  }
  if (!repos.campaigns.get('camp_default')) {
    const skillIds = ['rapport-basics', 'language-matching'].map((slug) => repos.skills.getBySlug(slug)?.id).filter((id): id is string => id !== undefined);
    repos.campaigns.create(
      { name: '默认：友好回复', goalType: 'support', goal: '友好、有帮助地回复对方，弄清楚对方想要什么。', successCriteria: '对方的问题得到回答，或者被转给了真人。', facts: '', allowedLinks: [], linkFallback: '', allowedPlatforms: [], skillIds, personaId: null, providerIds: [], mode: 'copilot', maxDays: 30, maxTurns: 60, replyDelayMinS: 8, replyDelayMaxS: 25, followupEnabled: false, followupAfterH: 24, followupMax: 1, enabled: true },
      'camp_default',
    );
  }
  if (repos.settings.getRaw('seededExamples') === null) {
    const ids = (...slugs: string[]) => slugs.map((slug) => repos.skills.getBySlug(slug)?.id).filter((id): id is string => id !== undefined);
    const base = { successCriteria: '', linkFallback: '', allowedPlatforms: [] as PlatformId[], personaId: null, providerIds: [] as string[], mode: 'copilot' as const, maxDays: 7, maxTurns: 20, replyDelayMinS: 8, replyDelayMaxS: 25, followupEnabled: false, followupAfterH: 20, followupMax: 1, enabled: true };
    repos.campaigns.create({ ...base, name: '示例：推荐数字人聊天产品', goalType: 'recommend_product', goal: '了解对方的场景，让对方愿意去看一眼数字人聊天产品的介绍。', successCriteria: '对方表示会去看介绍页，或者主动问怎么试用。', facts: '〔在这里写产品的真实信息：能做什么、不能做什么、价格、试用方式。AI 只会引用这里写的内容。〕', allowedLinks: [], linkFallback: '主页有介绍', skillIds: ids('rapport-basics', 'language-matching', 'digital-human-intro', 'soft-recommendation', 'objection-handling') });
    repos.campaigns.create({ ...base, name: '示例：VPN 推荐（仅海外平台）', goalType: 'recommend_product', goal: '对方有隐私或跨地区访问的需求时，让对方愿意看一眼 VPN 产品页。', successCriteria: '对方点开了产品页或问了怎么试用。', facts: '〔在这里写 VPN 的真实信息：节点、设备数、价格、退款政策。〕', allowedLinks: [], allowedPlatforms: ['x', 'instagram', 'youtube'], skillIds: ids('rapport-basics', 'language-matching', 'vpn-intro-overseas', 'soft-recommendation', 'objection-handling') });
    repos.campaigns.create({ ...base, name: '示例：分享一条短视频', goalType: 'share_content', goal: '让对方去看指定的那条视频，并回来说说看法。', successCriteria: '对方说看了，并给了一句具体的反馈。', facts: '〔视频讲什么、在哪个平台、标题是什么。〕', allowedLinks: [], linkFallback: '我主页置顶那条', skillIds: ids('rapport-basics', 'language-matching', 'content-share') });
    repos.campaigns.create({ ...base, name: '示例：约线下见面（只起草）', goalType: 'schedule_meeting', goal: '聊得投机之后，替账号主人约一次公开场合的见面。', successCriteria: '对方同意见面，并且时间地点由主人本人确认。', facts: '〔主人所在城市、方便的时间段。〕', allowedLinks: [], maxDays: 14, skillIds: ids('rapport-basics', 'language-matching', 'meeting-invite', 'objection-handling') });
    repos.campaigns.create({ ...base, name: '示例：评论区回复', goalType: 'support', goal: '回复视频下的评论：回答问题、感谢反馈，把需要细聊的人引到私信。', successCriteria: '评论得到有内容的回复。', facts: '', allowedLinks: [], maxDays: 30, maxTurns: 10, skillIds: ids('comment-reply', 'language-matching') });
    repos.settings.setRaw('seededExamples', '1');
  }
  if (!repos.accounts.get(SANDBOX_ACCOUNT_ID)) {
    repos.accounts.create({ name: '沙盒', platform: 'sandbox', connector: 'sandbox', defaultCampaignId: 'camp_default', quietStart: '00:00', quietEnd: '00:00', maxPerHour: 100000, maxPerDay: 1000000, maxPerContactDay: 100000, pollIntervalS: 0 }, SANDBOX_ACCOUNT_ID);
  }
}
