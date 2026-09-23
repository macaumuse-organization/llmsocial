import { isTimeOrStatus, joinFragments } from '../../shared/chatText.ts';
import type { OcrLine, ParsedChatMessage } from '../../shared/types.ts';

// Turns OCR lines from a chat screenshot into messages. Chat apps agree on one thing: the other
// person's bubbles hug the left edge and yours hug the right. Everything else is noise to drop.

// Only a screenshot has these. Timestamps and delivery notices are shared with the paste parser,
// but a pasted line that reads「100」is somebody's message, not a like counter.
const CHROME = [
  /^(发送|按住\s*说话|send|message|type a message|发消息…?|说点什么…?)$/i,
  /^[<＜‹←]$/,
  /^[\d.]+\s*[kKwW万]?$/, // like counters
  /^\d{1,3}%$/, // battery
];

function isNoise(line: OcrLine): boolean {
  const t = line.text.trim();
  if (t === '') return true;
  // Status bar and the input bar live in the top and bottom slivers of a phone screenshot.
  if (line.y < 0.045 || line.y > 0.955) return true;
  return isTimeOrStatus(t) || CHROME.some((re) => re.test(t));
}

export function parseChatScreenshot(lines: OcrLine[]): ParsedChatMessage[] {
  const kept = lines.filter((l) => !isNoise(l) && l.confidence >= 0.3).sort((a, b) => a.y - b.y || a.x - b.x);
  const out: (ParsedChatMessage & { bottom: number; left: number })[] = [];
  for (const line of kept) {
    const left = line.x;
    const right = line.x + line.w;
    const centre = (left + right) / 2;
    // A short centred line with margin on both sides is a timestamp or system notice we didn't pattern-match.
    if (Math.abs(centre - 0.5) < 0.06 && left > 0.25 && right < 0.75 && line.text.length <= 24) continue;
    // Right-aligned bubbles end near the right edge and start well away from the left one.
    const side: ParsedChatMessage['side'] = right > 0.72 && left > 0.3 ? 'me' : left < 0.3 ? 'contact' : centre > 0.5 ? 'me' : 'contact';
    const prev = out[out.length - 1];
    // Wrapped lines of one bubble: same side, nearly touching vertically, same left edge.
    if (prev && prev.side === side && line.y - prev.bottom < line.h * 0.9 && (side === 'me' || Math.abs(left - prev.left) < 0.04)) {
      prev.text = joinFragments(prev.text, line.text.trim());
      prev.bottom = line.y + line.h;
      continue;
    }
    out.push({ side, text: line.text.trim(), bottom: line.y + line.h, left });
  }
  return out.map(({ side, text }) => ({ side, text }));
}
