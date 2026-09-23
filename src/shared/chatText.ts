import type { ParsedChatMessage } from './types.ts';

// Shared by the screenshot parser and the paste parser. Both see chat-app timestamps and delivery
// notices and neither should keep them; only the screenshot parser sees on-screen chrome, so that
// list stays in ocr/parseChat.ts — a pasted line that is just「100」is a message, not a like counter.

export const TIME_OR_STATUS: RegExp[] = [
  /^\d{1,2}:\d{2}(:\d{2})?$/, // 10:25
  /^(上午|下午|凌晨|晚上|中午|早上)\s*\d{1,2}:\d{2}(:\d{2})?$/,
  /^(昨天|今天|前天|星期[一二三四五六日天]|周[一二三四五六日天])(\s*(上午|下午|凌晨|晚上)?\s*\d{1,2}:\d{2}(:\d{2})?)?$/,
  /^\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?(\s+\d{1,2}:\d{2}(:\d{2})?)?$/,
  /^\d{1,2}月\d{1,2}日(\s*(上午|下午|凌晨|晚上)?\s*\d{1,2}:\d{2}(:\d{2})?)?$/,
  /^(yesterday|today|mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?(\s+\d{1,2}:\d{2}\s*(am|pm)?)?$/i,
  /^\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)$/i,
  /^(以上是打招呼的内容|你已添加了.*现在可以开始聊天了。?|对方已撤回一条消息|你撤回了一条消息|已读|已送达|delivered|read|seen|sent)$/i,
  /^.{0,12}撤回了?一条消息$/,
];

export function isTimeOrStatus(text: string): boolean {
  return TIME_OR_STATUS.some((re) => re.test(text));
}

/** Glue two fragments of one message back together, spacing them only where Latin text needs it. */
export function joinFragments(prev: string, next: string): string {
  const needsSpace = /[A-Za-z0-9,.!?]$/.test(prev) && /^[A-Za-z0-9]/.test(next);
  return prev + (needsSpace ? ' ' : '') + next;
}

export const DEFAULT_MY_NAMES = ['我', '我方', 'me'];

const TIME = String.raw`\d{1,2}:\d{2}(?::\d{2})?`;
const DATE = String.raw`\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}日?`;
const MERIDIEM = String.raw`(?:上午|下午|凌晨|晚上|中午|早上)`;
const STAMP = String.raw`(?:${DATE}\s*)?(?:${MERIDIEM}\s*)?${TIME}`;
// Up to three space-separated words, lazily, so a trailing timestamp is not swallowed as part of the name.
const NAME = String.raw`[^\s:：\[\]()（）]{1,20}(?:[ \t][^\s:：\[\]()（）]{1,20}){0,2}?`;

const STAMP_NAME_TEXT = new RegExp(String.raw`^\[?(?:${STAMP})\]?\s+(${NAME})\s*[:：]\s*(.*)$`);
const STAMP_NAME = new RegExp(String.raw`^\[?(?:${STAMP})\]?\s+(${NAME})$`);
const NAME_STAMP = new RegExp(String.raw`^(${NAME})\s+(?:${STAMP})$`);
const NAME_TEXT = new RegExp(String.raw`^(${NAME})\s*[:：]\s*(.*)$`);
const URL_SCHEME = /^(https?|ftp|mailto|tel)$/i;

/**
 * How sure we are that a line names a speaker.
 * `stamped` — the line starts with a timestamp, so what follows it is a name, not prose.
 * `named` — WeChat desktop's「名字 10:23」header. A message that reads「明天 10:23」looks the same,
 *           and mistaking one for a header drops its text, so this tier has to earn it.
 * `plain` — a bare「名字：内容」prefix, which is also what「价格：200」looks like.
 */
type Tier = 'stamped' | 'named' | 'plain';

interface Speaker {
  kind: 'speaker';
  name: string;
  text: string;
  /** The line as typed, for when the prefix turns out not to be a speaker after all. */
  raw: string;
  tier: Tier;
}

type Slice = { kind: 'noise' } | { kind: 'plain'; text: string } | Speaker;

function usableName(name: string): boolean {
  const n = name.trim();
  return n !== '' && !/^[\d\s.:/-]+$/.test(n) && !isTimeOrStatus(n);
}

function slice(raw: string): Slice {
  const line = raw.trim();
  if (line === '' || isTimeOrStatus(line)) return { kind: 'noise' };

  const withText = STAMP_NAME_TEXT.exec(line);
  if (withText && usableName(withText[1]!)) return { kind: 'speaker', name: withText[1]!, text: withText[2]!.trim(), raw: line, tier: 'stamped' };

  const header = STAMP_NAME.exec(line);
  if (header && usableName(header[1]!)) return { kind: 'speaker', name: header[1]!, text: '', raw: line, tier: 'stamped' };

  const trailing = NAME_STAMP.exec(line);
  if (trailing && usableName(trailing[1]!)) return { kind: 'speaker', name: trailing[1]!, text: '', raw: line, tier: 'named' };

  const prefixed = NAME_TEXT.exec(line);
  if (prefixed && usableName(prefixed[1]!) && !URL_SCHEME.test(prefixed[1]!.trim()) && !prefixed[2]!.startsWith('//')) {
    return { kind: 'speaker', name: prefixed[1]!, text: prefixed[2]!.trim(), raw: line, tier: 'plain' };
  }
  return { kind: 'plain', text: line };
}

const key = (s: string) => s.trim().toLowerCase();

/**
 * Pasted chat text to messages. Deliberately conservative: when it cannot tell speakers apart it
 * gives one row per line and lets the operator flip sides in the editor, rather than guessing that
 * the two of them took turns.
 */
export function parseChatText(text: string, opts: { contactName?: string; myNames?: string[] } = {}): ParsedChatMessage[] {
  const slices = text.split(/\r?\n/).map(slice);

  const mine = new Set([...DEFAULT_MY_NAMES, ...(opts.myNames ?? [])].filter((n) => n.trim() !== '').map(key));
  const theirs = opts.contactName && opts.contactName.trim() !== '' ? key(opts.contactName) : '';
  const known = new Set([...mine, ...(theirs ? [theirs] : [])]);

  const stamped = new Set<string>();
  const counts = new Map<string, number>();
  for (const s of slices) {
    if (s.kind !== 'speaker') continue;
    if (s.tier === 'stamped') stamped.add(key(s.name));
    counts.set(key(s.name), (counts.get(key(s.name)) ?? 0) + 1);
  }
  const plainNames = new Set(slices.filter((s): s is Speaker => s.kind === 'speaker' && s.tier === 'plain').map((s) => key(s.name)));

  const accepts = (s: Speaker): boolean => {
    const k = key(s.name);
    if (s.tier === 'stamped') return true;
    if (known.has(k) || stamped.has(k) || (counts.get(k) ?? 0) >= 2) return true;
    // Nothing else in the paste looks like a speaker, so a couple of distinct prefixes are probably names.
    return s.tier === 'plain' && stamped.size === 0 && plainNames.size <= 2;
  };

  const sideOf = (name: string): ParsedChatMessage['side'] => {
    const k = key(name);
    if (theirs !== '' && k === theirs) return 'contact';
    return mine.has(k) ? 'me' : 'contact';
  };

  const out: ParsedChatMessage[] = [];
  const anySpeaker = slices.some((s) => s.kind === 'speaker' && accepts(s));
  for (const s of slices) {
    if (s.kind === 'noise') continue;
    if (s.kind === 'speaker' && accepts(s)) {
      out.push({ side: sideOf(s.name), text: s.text });
      continue;
    }
    const body = s.kind === 'speaker' ? s.raw : s.text;
    const prev = out[out.length - 1];
    // Without a single speaker anywhere there is nothing to attach to: one row per line, all theirs.
    if (!anySpeaker || !prev) out.push({ side: 'contact', text: body });
    else prev.text = joinFragments(prev.text, body);
  }
  return out.filter((m) => m.text !== '');
}
