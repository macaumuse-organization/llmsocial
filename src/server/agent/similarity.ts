// Platforms treat the same text sent to many people as spam, and it reads as spam too.
// Character trigrams work for CJK and Latin alike.

function trigrams(text: string): Set<string> {
  const s = text.toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[\s\p{P}\p{S}]+/gu, '');
  const out = new Set<string>();
  const chars = [...s];
  for (let i = 0; i + 3 <= chars.length; i++) out.add(chars.slice(i, i + 3).join(''));
  return out;
}

export function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const g of ta) if (tb.has(g)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Measured with scripts/measure-similarity.ts over 中文/英文/粵語 private-message openers and
 * comment replies: templated messages with a word or a name swapped score 0.429 to 0.893, two
 * genuinely different messages score at most 0.064, and the hardest case — the same pleasantry
 * opening two unrelated replies — reaches 0.276 (Latin text shares more trigrams through its
 * function words). 0.4 sits in that gap, closer to the adversarial side on purpose: a hit only
 * asks the model to reword once and never blocks anything, so catching too much is the cheap
 * mistake and letting template spam out is the expensive one.
 */
export const SIMILARITY_THRESHOLD = 0.4;

/** Short acknowledgements ("好的～") are exempt: they are naturally identical. */
export function tooSimilarToRecent(text: string, recent: string[], threshold = SIMILARITY_THRESHOLD): boolean {
  if ([...text.replace(/\s+/g, '')].length < 14) return false;
  return recent.some((r) => similarity(text, r) >= threshold);
}
