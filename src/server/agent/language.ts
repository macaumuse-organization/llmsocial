// Cheap script detection, passed to the model as a hint. The model makes the final call.

const YUE_MARKERS = /[嘅咗喺冇唔佢哋嚟啲乜嘢咁㗎喇噉嗰咩睇攞畀]/g;
// Characters that exist only in one of the two scripts, picked from very common words.
const HANT_ONLY = /[們個這來時說國會對經發現點麼還過無與為學樣實體關電東車長門開間問題業機條區數話該請讓從進遠運選邊愛歡買賣錢顧覺視聽讀寫書習親見語說誰課調識變]/g;
const HANS_ONLY = /[们个这来时说国会对经发现点么还过无与为学样实体关电东车长门开间问题业机条区数话该请让从进远运选边爱欢买卖钱顾觉视听读写书习亲见语说谁课调识变]/g;

function count(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

export function detectLanguage(text: string): string {
  const chars = [...text.replace(/\s+/g, '')];
  if (chars.length === 0) return '';
  const han = count(text, /\p{Script=Han}/gu);
  const kana = count(text, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const hangul = count(text, /\p{Script=Hangul}/gu);
  if (kana > 0 && kana + han >= chars.length * 0.3) return 'ja';
  if (hangul >= chars.length * 0.3) return 'ko';
  if (han >= Math.max(1, chars.length * 0.25)) {
    const hant = count(text, HANT_ONLY);
    const hans = count(text, HANS_ONLY);
    if (count(text, YUE_MARKERS) >= 2 || (count(text, YUE_MARKERS) >= 1 && hant >= hans)) return 'yue';
    if (hant > hans) return 'zh-Hant';
    return 'zh-Hans';
  }
  if (count(text, /\p{Script=Cyrillic}/gu) >= chars.length * 0.3) return 'ru';
  if (count(text, /\p{Script=Arabic}/gu) >= chars.length * 0.3) return 'ar';
  if (count(text, /\p{Script=Thai}/gu) >= chars.length * 0.3) return 'th';
  if (count(text, /[A-Za-z]/g) >= chars.length * 0.5) return 'latin';
  return '';
}

export const LANGUAGE_LABELS: Record<string, string> = {
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  yue: '粵語口語＋繁體字',
  ja: '日本語',
  ko: '한국어',
  ru: 'Русский',
  ar: 'العربية',
  th: 'ไทย',
  latin: '拉丁字母语言（多半是 English，以对方原文为准）',
};
