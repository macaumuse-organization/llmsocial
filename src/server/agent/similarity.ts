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

/** Short acknowledgements ("好的～") are exempt: they are naturally identical. */
export function tooSimilarToRecent(text: string, recent: string[], threshold = 0.72): boolean {
  if ([...text.replace(/\s+/g, '')].length < 14) return false;
  return recent.some((r) => similarity(text, r) >= threshold);
}
