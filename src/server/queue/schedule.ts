import { DAY, MINUTE } from '../util.ts';

export interface QuietHours {
  start: string;
  end: string;
  timezone: string;
}

function minutesOfDay(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function localMinutes(ts: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(ts);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

/**
 * Earliest moment at or after `ts` that falls outside quiet hours.
 * Works on wall-clock minutes in the account's timezone, so it follows DST without a tz library.
 */
export function nextAllowedTime(ts: number, quiet: QuietHours): number {
  const start = minutesOfDay(quiet.start);
  const end = minutesOfDay(quiet.end);
  if (start === null || end === null || start === end || !isValidTimezone(quiet.timezone)) return ts;
  const nowMin = localMinutes(ts, quiet.timezone);
  const inQuiet = start < end ? nowMin >= start && nowMin < end : nowMin >= start || nowMin < end;
  if (!inQuiet) return ts;
  const wait = (end - nowMin + 24 * 60) % (24 * 60);
  // `nowMin` is the floor of the current local minute, so counting from that minute's start lands
  // exactly on the end-of-quiet boundary — and still strictly after `ts`, since wait is >= 1 minute.
  return Math.min(ts - (ts % MINUTE) + wait * MINUTE, ts + DAY);
}

export function randomBetween(min: number, max: number, rand: () => number = Math.random): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + rand() * (hi - lo);
}

/** Reading/typing time grows with length, capped so long replies don't stall for minutes. */
export function pacingDelayMs(text: string, minS: number, maxS: number, rand: () => number = Math.random): number {
  const base = randomBetween(minS, maxS, rand) * 1000;
  const typing = Math.min(20_000, [...text].length * 120);
  return Math.round(base + typing * rand());
}
