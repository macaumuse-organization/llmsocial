import { z } from 'zod';
import type { Analysis, JudgeReport, RiskFlag, Stage } from '../../shared/types.ts';
import { STAGES } from '../../shared/types.ts';
import { clamp } from '../util.ts';

export const RISK_FLAGS: RiskFlag[] = ['payment', 'verification_code', 'credentials', 'personal_id', 'contract', 'legal', 'self_harm', 'minor', 'harassment'];

// Strict schemas are handed to providers that support native structured output.
// They stay plain (every field required, no refinements) so they convert to JSON Schema cleanly.
export const ReplyWire = z.object({
  analysis: z.object({
    intent: z.string(),
    sentiment: z.enum(['positive', 'neutral', 'negative']),
    stage: z.enum(['new', 'engaged', 'interested', 'offer_made', 'converted', 'declined']),
    goal_progress: z.number(),
    opt_out: z.boolean(),
    risk_flags: z.array(z.enum(['payment', 'verification_code', 'credentials', 'personal_id', 'contract', 'legal', 'self_harm', 'minor', 'harassment'])),
    language: z.string(),
    notes: z.string(),
  }),
  action: z.enum(['reply', 'wait', 'handoff', 'close']),
  messages: z.array(z.string()),
  memory_add: z.array(z.string()),
  interest_tags: z.array(z.string()),
  handoff_reason: z.string(),
});

export type ReplyAction = 'reply' | 'wait' | 'handoff' | 'close';

export interface ReplyOutput {
  analysis: Analysis;
  action: ReplyAction;
  messages: string[];
  memoryAdd: string[];
  interestTags: string[];
  handoffReason: string;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function strList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (typeof v === 'string') v = [v];
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .slice(0, maxItems)
    .map((x) => x.slice(0, maxLen));
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * Lenient reader for the reply JSON. Weaker models drop fields or rename them; anything
 * recoverable is recovered, and only output with no usable decision is rejected.
 */
export function normalizeReply(raw: unknown): ReplyOutput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('reply JSON is not an object');
  const o = raw as Record<string, unknown>;
  const a = (typeof o.analysis === 'object' && o.analysis !== null ? o.analysis : {}) as Record<string, unknown>;
  const messages = strList(o.messages ?? o.reply ?? o.message, 4, 4000);
  const action = pick<ReplyAction>(o.action, ['reply', 'wait', 'handoff', 'close'], messages.length > 0 ? 'reply' : 'wait');
  if (action === 'reply' && messages.length === 0) throw new Error('action is "reply" but no messages were given');
  const progress = typeof a.goal_progress === 'number' ? a.goal_progress : typeof a.goalProgress === 'number' ? a.goalProgress : 0;
  return {
    analysis: {
      intent: str(a.intent).slice(0, 200),
      sentiment: pick(a.sentiment, ['positive', 'neutral', 'negative'] as const, 'neutral'),
      stage: pick<Stage>(a.stage, STAGES, 'engaged'),
      goalProgress: Math.round(clamp(progress, 0, 100)),
      optOut: a.opt_out === true || a.optOut === true,
      riskFlags: strList(a.risk_flags ?? a.riskFlags, 9, 40).filter((f): f is RiskFlag => (RISK_FLAGS as string[]).includes(f)),
      language: str(a.language).slice(0, 20),
      notes: str(a.notes).slice(0, 600),
    },
    action,
    messages,
    memoryAdd: strList(o.memory_add ?? o.memoryAdd, 5, 200),
    interestTags: strList(o.interest_tags ?? o.interestTags, 10, 30),
    handoffReason: str(o.handoff_reason ?? o.handoffReason).slice(0, 300),
  };
}

export const SummaryWire = z.object({ summary: z.string(), facts: z.array(z.string()) });

export function normalizeSummary(raw: unknown): { summary: string; facts: string[] } {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const summary = str(o.summary).trim();
  if (summary === '') throw new Error('summary JSON has no summary');
  return { summary: summary.slice(0, 2000), facts: strList(o.facts, 12, 200) };
}

export const SimContactWire = z.object({ messages: z.array(z.string()), leave: z.boolean() });

export function normalizeSimContact(raw: unknown): { messages: string[]; leave: boolean } {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const messages = strList(o.messages ?? o.message, 3, 1000);
  if (messages.length === 0 && o.leave !== true) throw new Error('simulated contact said nothing');
  return { messages, leave: o.leave === true };
}

export const JudgeWire = z.object({
  goal_achieved: z.boolean(),
  score: z.number(),
  naturalness: z.number(),
  pushiness: z.number(),
  honesty_violations: z.array(z.string()),
  material_fit: z.number(),
  summary: z.string(),
  suggestions: z.array(z.string()),
});

export function normalizeJudge(raw: unknown): JudgeReport {
  if (typeof raw !== 'object' || raw === null) throw new Error('judge JSON is not an object');
  const o = raw as Record<string, unknown>;
  const num = (v: unknown, hi: number) => Math.round(clamp(typeof v === 'number' ? v : 0, 0, hi));
  return {
    goalAchieved: o.goal_achieved === true || o.goalAchieved === true,
    score: num(o.score, 100),
    naturalness: num(o.naturalness, 10),
    pushiness: num(o.pushiness, 10),
    honestyViolations: strList(o.honesty_violations ?? o.honestyViolations, 10, 300),
    // Missing means an older run, judged before this score existed. Nothing shared scores full marks.
    materialFit: o.material_fit === undefined && o.materialFit === undefined ? 10 : num(o.material_fit ?? o.materialFit, 10),
    summary: str(o.summary).slice(0, 1500),
    suggestions: strList(o.suggestions, 8, 400),
  };
}
