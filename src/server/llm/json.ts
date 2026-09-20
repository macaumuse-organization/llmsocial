// Models wrap JSON in prose, code fences, or <think> blocks. Dig the first object out.

export function extractJson(text: string): unknown {
  let s = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence && fence[1]) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    // fall through to the scanner
  }
  const start = s.indexOf('{');
  if (start === -1) throw new Error('no JSON object in model output');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON object in model output');
}
