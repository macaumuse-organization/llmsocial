import type { GoalType, PlatformId, PlatformProfile, ProviderPreset, SimPersona } from './types.ts';

export const PLATFORMS: PlatformProfile[] = [
  {
    id: 'wechat',
    label: '微信',
    region: 'cn',
    maxLen: { dm: 500, comment: 300 },
    links: { dm: 'discouraged', comment: 'blocked' },
    cjkDoubleWidth: false,
    hint: '微信里外链常被拦截或折叠；消息要短，像聊天不像文案。',
  },
  {
    id: 'xiaohongshu',
    label: '小红书',
    region: 'cn',
    maxLen: { dm: 300, comment: 300 },
    links: { dm: 'blocked', comment: 'blocked' },
    cjkDoubleWidth: false,
    hint: '小红书屏蔽外链和导流词；不要发链接、微信号、二维码。',
  },
  {
    id: 'douyin',
    label: '抖音',
    region: 'cn',
    maxLen: { dm: 300, comment: 100 },
    links: { dm: 'blocked', comment: 'blocked' },
    cjkDoubleWidth: false,
    hint: '抖音屏蔽外链；评论要很短。',
  },
  {
    id: 'x',
    label: 'X (Twitter)',
    region: 'global',
    maxLen: { dm: 1000, comment: 270 },
    links: { dm: 'ok', comment: 'ok' },
    cjkDoubleWidth: true,
    hint: 'Public replies are limited to 280 weighted characters (CJK counts double).',
  },
  {
    id: 'instagram',
    label: 'Instagram',
    region: 'global',
    maxLen: { dm: 900, comment: 500 },
    links: { dm: 'ok', comment: 'discouraged' },
    cjkDoubleWidth: false,
    hint: 'Links in comments are not clickable; point to the bio link instead. DMs can only be sent within 24h of the person’s last message.',
  },
  {
    id: 'youtube',
    label: 'YouTube',
    region: 'global',
    maxLen: { dm: 500, comment: 500 },
    links: { dm: 'ok', comment: 'discouraged' },
    cjkDoubleWidth: false,
    hint: 'Comments with links are often held for review; prefer “link in the description”.',
  },
  {
    id: 'sandbox',
    label: '沙盒（教学/测试）',
    region: 'test',
    maxLen: { dm: 1000, comment: 500 },
    links: { dm: 'ok', comment: 'ok' },
    cjkDoubleWidth: false,
    hint: '本地模拟，不连接任何真实平台。',
  },
  {
    id: 'other',
    label: '其它',
    region: 'global',
    maxLen: { dm: 800, comment: 400 },
    links: { dm: 'ok', comment: 'ok' },
    cjkDoubleWidth: false,
    hint: '',
  },
];

export function platformProfile(id: PlatformId): PlatformProfile {
  return PLATFORMS.find((p) => p.id === id) ?? PLATFORMS[PLATFORMS.length - 1]!;
}

export const GLOBAL_PLATFORMS: PlatformId[] = PLATFORMS.filter((p) => p.region === 'global' && p.id !== 'other').map((p) => p.id);

export const GOAL_TYPES: { id: GoalType; label: string; hint: string }[] = [
  { id: 'rapport', label: '建立好感', hint: '让对方觉得聊得舒服、愿意继续聊' },
  { id: 'recommend_product', label: '推荐产品', hint: '了解需求后推荐产品，让对方愿意去看一眼' },
  { id: 'share_content', label: '分享内容', hint: '让对方去看一条视频/帖子并说说看法' },
  { id: 'schedule_meeting', label: '约线下见面', hint: '替账号主人约一次公开场合的见面' },
  { id: 'support', label: '客服答疑', hint: '回答问题，解决不了就转人工' },
  { id: 'custom', label: '自定义', hint: '完全按「目标」一栏的文字执行' },
];

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { label: 'Claude Opus 5（Anthropic）', kind: 'anthropic', baseUrl: '', model: 'claude-opus-5', keyHint: 'keychain:fjosky.anthropic.etech 或 env:ANTHROPIC_API_KEY；留空则用 SDK 默认凭据' },
  { label: 'Claude Sonnet 5（Anthropic）', kind: 'anthropic', baseUrl: '', model: 'claude-sonnet-5', keyHint: '同上' },
  { label: 'Claude Haiku 4.5（Anthropic）', kind: 'anthropic', baseUrl: '', model: 'claude-haiku-4-5', keyHint: '同上' },
  { label: 'OpenAI', kind: 'openai_compat', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', keyHint: 'env:OPENAI_API_KEY' },
  { label: 'DeepSeek', kind: 'openai_compat', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyHint: 'env:DEEPSEEK_API_KEY' },
  { label: '通义千问（DashScope）', kind: 'openai_compat', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', keyHint: 'env:DASHSCOPE_API_KEY' },
  { label: 'Kimi（Moonshot）', kind: 'openai_compat', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-latest', keyHint: 'env:MOONSHOT_API_KEY' },
  { label: '智谱 GLM', kind: 'openai_compat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', keyHint: 'env:ZHIPU_API_KEY' },
  { label: 'OpenRouter', kind: 'openai_compat', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', keyHint: 'env:OPENROUTER_API_KEY' },
  { label: 'Ollama（本机，免费）', kind: 'openai_compat', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', keyHint: '不需要密钥' },
  { label: 'Google Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash', keyHint: 'env:GEMINI_API_KEY' },
  { label: 'Mock（离线演示，不花钱）', kind: 'mock', baseUrl: '', model: 'mock-friendly', keyHint: '不需要密钥' },
];

export const SIM_PERSONAS: SimPersona[] = [
  { name: '忙碌的上班族', description: '28 岁，互联网运营，回消息简短，没耐心看长文，但对能省时间的工具有兴趣。', language: 'zh-Hans' },
  { name: '精打细算的大学生', description: '21 岁，大三，对价格敏感，喜欢问「有没有免费的」，爱用表情和网络用语。', language: 'zh-Hans' },
  { name: '好奇的自媒体人', description: '32 岁，做短视频，对 AI 数字人很好奇，会追问技术细节和实际效果。', language: 'zh-Hans' },
  { name: '冷淡的怀疑派', description: '35 岁，被推销烦过很多次，开口就怀疑对方是不是机器人或者骗子，需要诚实回应才会继续。', language: 'zh-Hans' },
  { name: '香港上班族（粵語）', description: '30 歲，金融業，習慣用粵語口語同繁體字打字，講嘢直接。', language: 'yue' },
  { name: 'Overseas expat', description: '34, works in Singapore, writes in English, polite but direct, wants concrete facts before clicking any link.', language: 'en' },
  { name: '想结束对话的人', description: '不感兴趣，回两三句之后会明确说「别再发了」。用来检验系统是否立刻停止。', language: 'zh-Hans' },
];
