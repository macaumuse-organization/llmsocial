import { randomBytes } from 'node:crypto';
import type { Analysis, Campaign, CompareCandidate, Contact, Conversation, Message, Mode, Persona, RiskFlag, Skill, Stage } from '../../shared/types.ts';
import { platformProfile } from '../../shared/platforms.ts';
import type { Bus } from '../bus.ts';
import { ConnectorError, type InboundMessage } from '../connectors/types.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_PERSONA_ID, type AccountRow, type Repos } from '../db/repos.ts';
import type { LlmRouter } from '../llm/router.ts';
import { LlmError } from '../llm/types.ts';
import { RetryLater, type Job, type JobQueue } from '../queue/jobs.ts';
import { nextAllowedTime, pacingDelayMs } from '../queue/schedule.ts';
import { DAY, HOUR, KeyedMutex, MINUTE, errMessage, newId, type Clock, type Logger } from '../util.ts';
import { HARD_FLAGS, RISK_LABELS, checkOutbound, detectOptOut, detectRisk, fitToPlatform, isValidDisclosure, matchMaterials } from './guards.ts';
import { LANGUAGE_LABELS, detectLanguage } from './language.ts';
import { buildReplyPrompt, buildSummaryPrompt, type PromptContext, type Trigger } from './prompt.ts';
import { ReplyWire, SummaryWire, normalizeReply, normalizeSummary, type ReplyOutput } from './schema.ts';
import { tooSimilarToRecent } from './similarity.ts';

export const FALLBACK_DISCLOSURE = '（我是这个账号的 AI 数字人助理，消息由 AI 生成，账号主人能看到我们的对话。）';
export const FALLBACK_COMMENT_SIGNATURE = '—— AI 助理回复';
const OPT_OUT_ACK: Record<string, string> = { en: "Understood. You won't hear from this account again.", latin: "Understood. You won't hear from this account again.", 'zh-Hant': '好的，不會再打擾你了。', yue: '好，唔會再打擾你。' };
const OPT_OUT_ACK_DEFAULT = '好的，不会再打扰你了。';

/** An inbound message older than this when we first see it is history, not something to answer. */
const STALE_INBOUND_MS = 24 * HOUR;
/** An unapproved AI message that still hasn't gone out after this long is dropped instead of sent late. */
const STALE_OUTBOUND_MS = 6 * HOUR;
const MIN_SEND_GAP_MS = 3000;
const REDISCLOSE_AFTER_MS = 7 * DAY;
const STAGE_RANK: Record<Stage, number> = { new: 0, engaged: 1, interested: 2, offer_made: 3, converted: 4, declined: 1 };

export interface GenerateOptions {
  trigger: Trigger;
  operatorHint?: string;
  providerId?: string;
  /** Sandbox simulations: no pacing delay, quiet hours or rate limits. */
  instant?: boolean;
  /** Last attempt of the job: a failure now becomes a hand-off instead of another retry. */
  finalAttempt?: boolean;
}

interface Prepared {
  conversation: Conversation;
  account: AccountRow;
  contact: Contact & { summarizedCount: number };
  campaign: Campaign;
  persona: Persona;
  skills: Skill[];
  mode: Mode;
  history: Message[];
  fresh: Message[];
  lastInboundId: string | null;
  lastOutboundActivityId: string | null;
  sharedMaterialIds: string[];
  expired: boolean;
}

export interface PipelineDeps {
  db: Db;
  repos: Repos;
  router: LlmRouter;
  connectors: ConnectorRegistry;
  queue: JobQueue;
  bus: Bus;
  clock: Clock;
  log: Logger;
  rand?: () => number;
}

export class Pipeline {
  private d: PipelineDeps;
  private rand: () => number;
  private mutex = new KeyedMutex();
  private sendMutex = new KeyedMutex();

  constructor(deps: PipelineDeps) {
    this.d = deps;
    this.rand = deps.rand ?? Math.random;
  }

  // ------------------------------------------------------------------ helpers

  private notify(conversationId: string): void {
    this.d.bus.emit({ type: 'conversation', conversationId });
  }

  effectiveMode(conversation: Conversation, account: AccountRow, campaign: Campaign | undefined): Mode {
    if (!this.d.connectors.canSend(account)) return 'copilot';
    return conversation.modeOverride ?? campaign?.mode ?? 'copilot';
  }

  private resolveCampaign(conversation: Conversation): Campaign | undefined {
    const { repos } = this.d;
    const own = conversation.campaignId ? repos.campaigns.get(conversation.campaignId) : undefined;
    return own ?? repos.campaigns.get('camp_default');
  }

  private resolvePersona(account: AccountRow, campaign: Campaign): Persona {
    const { repos } = this.d;
    const found = (account.personaId && repos.personas.get(account.personaId)) || (campaign.personaId && repos.personas.get(campaign.personaId)) || repos.personas.get(DEFAULT_PERSONA_ID);
    if (found) return found;
    return { id: DEFAULT_PERSONA_ID, name: 'AI 助理', identity: '这个账号的 AI 数字人助理，替账号主人回复消息。', style: '', disclosure: FALLBACK_DISCLOSURE, commentSignature: FALLBACK_COMMENT_SIGNATURE, createdAt: 0, updatedAt: 0 };
  }

  /** Drafts and scheduled sends that a newer event has made obsolete. */
  private supersedeOpen(conversationId: string, reason: string, includeApproved = false): number {
    let n = 0;
    for (const m of this.d.repos.messages.open(conversationId)) {
      if (m.approved && !includeApproved) continue;
      if (m.kind === 'optout_ack') continue;
      this.d.repos.messages.update(m.id, { status: 'superseded', error: reason });
      this.d.queue.cancelByKey(`send:${m.id}`);
      n++;
    }
    return n;
  }

  cancelPending(conversationId: string): void {
    this.supersedeOpen(conversationId, '对话设置已变更', true);
    this.d.queue.cancelByKey(`gen:${conversationId}`);
    this.notify(conversationId);
  }

  private applyOptOut(conversation: Conversation, account: AccountRow, contact: Contact, source: string, language: string): void {
    const { repos } = this.d;
    this.supersedeOpen(conversation.id, 'opted out', true);
    repos.contacts.update(contact.id, { optedOut: true });
    repos.suppressions.add(account.platform, contact.platformUserId, source);
    const campaign = this.resolveCampaign(conversation);
    const wasAutopilot = this.effectiveMode(conversation, account, campaign) === 'autopilot';
    repos.conversations.update(conversation.id, { state: 'opted_out', stateReason: `对方要求停止联系（${source}）` });
    repos.events.add('opt_out', { source }, { accountId: account.id, conversationId: conversation.id, level: 'warn' });
    // One confirmation, then silence. Only where a machine was doing the talking; in copilot the owner decides.
    if (wasAutopilot && repos.settings.get().optOutAck && conversation.kind === 'dm') {
      const ack = repos.messages.insert({ conversationId: conversation.id, accountId: account.id, direction: 'out', author: 'ai', text: OPT_OUT_ACK[language] ?? OPT_OUT_ACK_DEFAULT, status: 'scheduled', kind: 'optout_ack', sendAt: this.d.clock.now() });
      this.d.queue.enqueue('send_message', { messageId: ack.id }, { dedupeKey: `send:${ack.id}` });
    }
  }

  // ------------------------------------------------------------------ inbound

  /** Stores one platform message and decides whether it warrants a reply. Idempotent per platformMsgId. */
  ingest(accountId: string, inbound: InboundMessage, opts: { debounceMs?: number; noSchedule?: boolean } = {}): { conversationId: string; duplicate: boolean } | null {
    const { db, repos, clock, queue } = this.d;
    const now = clock.now();
    const result = db.tx(() => {
      const account = repos.accounts.get(accountId);
      if (!account) return null;
      if (inbound.platformMsgId && repos.messages.existsPlatformId(account.id, inbound.platformMsgId)) return { conversationId: '', duplicate: true, schedule: false };

      const contact = repos.contacts.upsert(account.id, inbound.contact);
      let conversation = repos.conversations.find(account.id, contact.id, inbound.kind, inbound.threadRef);
      if (!conversation) {
        const campaign = account.defaultCampaignId ? repos.campaigns.get(account.defaultCampaignId) : undefined;
        const usable = campaign && campaign.enabled && (campaign.allowedPlatforms.length === 0 || campaign.allowedPlatforms.includes(account.platform));
        conversation = repos.conversations.create({ accountId: account.id, contactId: contact.id, campaignId: usable ? campaign.id : null, kind: inbound.kind, threadRef: inbound.threadRef, title: inbound.threadTitle ?? '', deadlineAt: usable ? now + campaign.maxDays * DAY : null });
      } else if (inbound.threadTitle && inbound.threadTitle !== conversation.title) {
        repos.conversations.update(conversation.id, { title: inbound.threadTitle });
      }

      if (inbound.fromSelf) {
        // Our own send echoed back by a poll: attach the platform id instead of storing it twice.
        const twin = db.get<{ id: string }>("SELECT id FROM messages WHERE conversationId = ? AND direction = 'out' AND status = 'sent' AND platformMsgId IS NULL AND text = ? AND sentAt > ? ORDER BY rowid DESC LIMIT 1", conversation.id, inbound.text, now - 30 * MINUTE);
        if (twin) {
          repos.messages.update(twin.id, { platformMsgId: inbound.platformMsgId });
          return { conversationId: conversation.id, duplicate: true, schedule: false };
        }
        repos.messages.insert({ conversationId: conversation.id, accountId: account.id, direction: 'out', author: 'external', text: inbound.text, status: 'sent', platformMsgId: inbound.platformMsgId, sentAt: inbound.timestamp, approved: true });
        repos.conversations.update(conversation.id, { lastOutboundAt: inbound.timestamp, lastMessageAt: now });
        // The owner answered from the app. Anything the AI had queued is now out of place.
        const dropped = this.supersedeOpen(conversation.id, 'owner replied from the platform');
        queue.cancelByKey(`gen:${conversation.id}`);
        const campaign = this.resolveCampaign(conversation);
        if (repos.settings.get().pauseOnOperatorReply && this.effectiveMode(conversation, account, campaign) === 'autopilot') {
          repos.conversations.update(conversation.id, { modeOverride: 'copilot' });
          repos.events.add('autopilot_paused_external_reply', { dropped }, { accountId: account.id, conversationId: conversation.id });
        }
        return { conversationId: conversation.id, duplicate: false, schedule: false };
      }

      repos.messages.insert({ conversationId: conversation.id, accountId: account.id, direction: 'in', author: 'contact', text: inbound.text, status: 'received', platformMsgId: inbound.platformMsgId || null, replyToRef: inbound.replyToRef ?? null, sentAt: inbound.timestamp });
      const language = detectLanguage(inbound.text) || contact.language;
      if (language !== contact.language) repos.contacts.update(contact.id, { language });

      const patch: Partial<Conversation> = { unread: conversation.unread + 1, lastInboundAt: now, lastMessageAt: now };
      // Someone who comes back after a closed conversation gets a fresh window, unless they opted out.
      if (conversation.state === 'closed') {
        const campaign = this.resolveCampaign(conversation);
        Object.assign(patch, { state: 'active', stateReason: '', deadlineAt: campaign ? now + campaign.maxDays * DAY : null, aiTurns: 0, followupsSent: 0 });
        conversation = { ...conversation, state: 'active' };
      }
      repos.conversations.update(conversation.id, patch);

      if (contact.optedOut || repos.suppressions.has(account.platform, contact.platformUserId)) {
        if (conversation.state !== 'opted_out') repos.conversations.update(conversation.id, { state: 'opted_out', stateReason: '对方在屏蔽名单中' });
        return { conversationId: conversation.id, duplicate: false, schedule: false };
      }
      if (detectOptOut(inbound.text)) {
        this.applyOptOut(conversation, account, contact, '关键词', language);
        return { conversationId: conversation.id, duplicate: false, schedule: false };
      }
      const hard = detectRisk(inbound.text).filter((f) => HARD_FLAGS.includes(f));
      if (hard.length > 0 && conversation.state !== 'handoff') {
        this.supersedeOpen(conversation.id, 'handed off');
        repos.conversations.update(conversation.id, { state: 'handoff', stateReason: `需要真人处理：${hard.map((f) => RISK_LABELS[f]).join('、')}` });
        repos.events.add('handoff', { flags: hard, source: 'keyword' }, { accountId: account.id, conversationId: conversation.id, level: 'warn' });
        return { conversationId: conversation.id, duplicate: false, schedule: false };
      }
      const live = account.connector === 'sandbox' || account.connector === 'manual' || now - inbound.timestamp <= STALE_INBOUND_MS;
      if (!live) repos.events.add('inbound_stale', { ageHours: Math.round((now - inbound.timestamp) / HOUR) }, { accountId: account.id, conversationId: conversation.id });
      return { conversationId: conversation.id, duplicate: false, schedule: live && conversation.state === 'active' };
    });

    if (!result) return null;
    if (result.schedule && !opts.noSchedule) {
      // People send thoughts in bursts. Each new message pushes the reply back so the burst is answered once.
      const debounce = opts.debounceMs ?? repos.settings.get().debounceMs;
      queue.enqueue('generate_reply', { conversationId: result.conversationId, trigger: 'inbound' }, { runAt: now + debounce, dedupeKey: `gen:${result.conversationId}`, reschedule: true });
    }
    if (result.conversationId) this.notify(result.conversationId);
    return { conversationId: result.conversationId, duplicate: result.duplicate };
  }

  // ------------------------------------------------------------------ generation

  private prepare(conversationId: string, trigger: Trigger): Prepared | string {
    const { repos, clock } = this.d;
    const conversation = repos.conversations.get(conversationId);
    if (!conversation) return 'conversation not found';
    const account = repos.accounts.get(conversation.accountId);
    const contact = repos.contacts.get(conversation.contactId);
    if (!account || !contact) return '账号或联系人数据缺失';
    if (contact.optedOut || conversation.state === 'opted_out' || repos.suppressions.has(account.platform, contact.platformUserId)) return '对方已要求停止联系';
    if (account.status === 'paused') return '账号已暂停，请先在账号页恢复';
    const operatorAsked = trigger === 'regenerate' || trigger === 'opener';
    if (conversation.state !== 'active' && !operatorAsked) return `conversation is ${conversation.state}`;
    const campaign = this.resolveCampaign(conversation);
    if (!campaign || !campaign.enabled) return '没有可用的聊天任务';
    if (campaign.allowedPlatforms.length > 0 && !campaign.allowedPlatforms.includes(account.platform)) return `任务「${campaign.name}」不允许在 ${platformProfile(account.platform).label} 上运行`;

    const settings = repos.settings.get();
    let mode = this.effectiveMode(conversation, account, campaign);
    // The machine never makes first contact by itself: an opener is always a draft for the owner to send.
    if (settings.autopilotPaused || trigger === 'opener') mode = 'copilot';
    const delivered = repos.messages.delivered(conversation.id, settings.maxContextMessages);
    let lastOut = -1;
    delivered.forEach((m, i) => {
      if (m.direction === 'out') lastOut = i;
    });
    const skills = campaign.skillIds
      .map((id) => repos.skills.get(id))
      .filter((s): s is Skill => s !== undefined && s.enabled && (s.allowedPlatforms.length === 0 || s.allowedPlatforms.includes(account.platform)));
    return {
      conversation,
      account,
      contact,
      campaign,
      persona: this.resolvePersona(account, campaign),
      skills,
      mode,
      history: delivered.slice(0, lastOut + 1),
      fresh: delivered.slice(lastOut + 1),
      lastInboundId: repos.messages.lastInboundId(conversation.id),
      lastOutboundActivityId: repos.messages.lastOutboundActivityId(conversation.id),
      // Over the whole thread, not `delivered` — the context window is short and an item shared
      // forty messages ago would look unshared.
      sharedMaterialIds: campaign.materials.length === 0 ? [] : matchMaterials(repos.messages.sentTexts(conversation.id), campaign.materials).map((m) => m.id),
      expired: conversation.deadlineAt !== null && conversation.deadlineAt <= clock.now(),
    };
  }

  private contextChanged(p: Prepared, trigger: Trigger): boolean {
    const current = this.prepare(p.conversation.id, trigger);
    if (typeof current === 'string') return true;
    const stamp = (value: Prepared) => JSON.stringify([
      value.conversation.state, value.conversation.modeOverride, value.conversation.campaignId,
      value.account.status, value.campaign, value.persona, value.skills,
      value.contact.notes, value.contact.facts, value.contact.tags, value.lastOutboundActivityId,
    ]);
    return stamp(current) !== stamp(p);
  }

  /**
   * The draft was built on state that changed while the model ran (notes edited, campaign saved, mode
   * switched, owner replied…). An operator who clicked is told; a background trigger still owes the
   * other person an answer, so it runs again on the fresh state — the rerun's prepare() decides whether
   * anything is left to say (nothing, if the owner answered or closed the thread meanwhile).
   */
  private dropStale(p: Prepared, opts: GenerateOptions): string {
    const { repos, queue, clock } = this.d;
    repos.events.add('generate_stale', { trigger: opts.trigger }, { conversationId: p.conversation.id });
    if (opts.trigger === 'inbound' || opts.trigger === 'followup') {
      queue.enqueue('generate_reply', { conversationId: p.conversation.id, trigger: opts.trigger }, { runAt: clock.now() + 1500, dedupeKey: `gen:${p.conversation.id}`, reschedule: true });
    }
    return '对话已更新，请根据当前内容重新起草';
  }

  private promptContext(p: Prepared, trigger: Trigger, operatorHint: string, canary: string, correction: string): PromptContext {
    const language = p.contact.language || detectLanguage(p.fresh.map((m) => m.text).join(' '));
    return {
      mode: p.mode,
      persona: p.persona,
      campaign: p.campaign,
      skills: p.skills,
      platform: platformProfile(p.account.platform),
      kind: p.conversation.kind,
      conversation: p.conversation,
      contact: p.contact,
      history: p.history,
      fresh: p.fresh,
      trigger,
      operatorHint,
      languageHint: LANGUAGE_LABELS[language] ?? language,
      now: this.d.clock.now(),
      timezone: p.account.timezone,
      canary,
      correction,
      sharedMaterialIds: p.sharedMaterialIds,
    };
  }

  /** Model call plus the outbound guards, with one corrective retry. */
  private async draft(p: Prepared, opts: GenerateOptions): Promise<{ output: ReplyOutput; texts: string[]; llmCallId: string; blocked: string; materialReview: string }> {
    const { repos, router } = this.d;
    const profile = platformProfile(p.account.platform);
    const canary = `CANARY-${randomBytes(6).toString('hex')}`;
    const recent = repos.messages.recentOutboundTexts(p.account.id, p.conversation.id, 60);
    let correction = '';
    let last: { output: ReplyOutput; texts: string[]; llmCallId: string; blocked: string; materialReview: string } | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = buildReplyPrompt(this.promptContext(p, opts.trigger, opts.operatorHint ?? '', canary, correction));
      const routed = await router.chat({ purpose: 'reply', ...prompt, schema: ReplyWire }, { conversationId: p.conversation.id, providerIds: p.campaign.providerIds, onlyProviderId: opts.providerId, parse: normalizeReply });
      const output = routed.value;
      const texts = output.messages.length > 0 ? fitToPlatform(output.messages, profile, p.conversation.kind) : [];
      last = { output, texts, llmCallId: routed.llmCallId, blocked: '', materialReview: '' };
      if (texts.length === 0) return last;

      const check = checkOutbound(texts, {
        autopilot: p.mode === 'autopilot',
        allowedLinks: [...p.campaign.allowedLinks, ...p.campaign.materials.map((m) => m.url)],
        linksBlocked: profile.links[p.conversation.kind] === 'blocked',
        canary,
        protectedTexts: p.skills.map((s) => s.content),
      });
      if (!check.ok) {
        last.blocked = check.code;
        correction = check.correction;
        continue;
      }
      if (attempt === 0 && texts.some((t) => tooSimilarToRecent(t, recent))) {
        correction = '这条回复和这个账号最近发给别人的消息几乎一样。结合这位对方说过的具体内容，换一种写法。';
        continue;
      }
      // "One at a time" and "never twice" are prompt rules, and a model that ignores them gets a
      // person's eyes rather than a retry: "对方自己要链接" is a legitimate repeat an operator can approve.
      const shared = matchMaterials(texts, p.campaign.materials);
      const repeated = shared.filter((m) => p.sharedMaterialIds.includes(m.id));
      last.materialReview = shared.length > 1 ? `一次发了 ${shared.length} 条素材，确认只留一条再发` : repeated.length > 0 ? `又发了已经分享过的「${repeated[0]!.title}」，确认是对方要的再发` : '';
      return last;
    }
    return last!;
  }

  /** Returns '' when generation ran, or the reason it was refused — so an operator-triggered call can say so. */
  async generate(conversationId: string, opts: GenerateOptions): Promise<string> {
    return this.mutex.run(conversationId, () => this.generateLocked(conversationId, opts));
  }

  private async generateLocked(conversationId: string, opts: GenerateOptions): Promise<string> {
    const { db, repos, clock, queue, log } = this.d;
    const prepared = this.prepare(conversationId, opts.trigger);
    if (typeof prepared === 'string') {
      repos.events.add('generate_skipped', { reason: prepared, trigger: opts.trigger }, { conversationId });
      return prepared;
    }
    const p = prepared;
    if (opts.trigger === 'inbound' && p.fresh.length === 0) return '';
    if (opts.trigger === 'followup' && (p.fresh.length > 0 || p.history.length === 0)) return '';
    if (p.conversation.aiTurns >= p.campaign.maxTurns && opts.trigger !== 'regenerate') {
      repos.conversations.update(p.conversation.id, { state: 'closed', stateReason: `已达到任务设定的 ${p.campaign.maxTurns} 轮上限` });
      this.notify(p.conversation.id);
      return `已达到任务设定的 ${p.campaign.maxTurns} 轮上限`;
    }

    let drafted: Awaited<ReturnType<Pipeline['draft']>>;
    try {
      drafted = await this.draft(p, opts);
    } catch (err) {
      if (this.contextChanged(p, opts.trigger)) return this.dropStale(p, opts);
      const budget = err instanceof LlmError && err.kind === 'budget';
      repos.events.add('llm_failed', { error: errMessage(err).slice(0, 500) }, { accountId: p.account.id, conversationId, level: 'error' });
      if (budget || opts.finalAttempt) {
        // Never leave someone waiting silently on a model that isn't coming back.
        repos.conversations.update(conversationId, { state: 'handoff', stateReason: budget ? 'LLM 调用已达每日上限，请人工回复' : 'AI 生成失败，请人工回复' });
        this.notify(conversationId);
        return '';
      }
      throw err;
    }

    if (this.contextChanged(p, opts.trigger)) return this.dropStale(p, opts);

    // The other person kept typing while the model was thinking: this draft answers a stale thread.
    if (repos.messages.lastInboundId(conversationId) !== p.lastInboundId) {
      queue.enqueue('generate_reply', { conversationId, trigger: 'inbound' }, { runAt: clock.now() + 1500, dedupeKey: `gen:${conversationId}`, reschedule: true });
      return '';
    }

    const { output, texts, llmCallId, blocked, materialReview } = drafted;
    const now = clock.now();
    db.tx(() => {
      const current = repos.conversations.get(conversationId);
      const contact = repos.contacts.get(p.contact.id);
      if (!current || !contact) return;
      this.supersedeOpen(conversationId, 'newer draft');

      const analysis: Analysis = output.analysis;
      const keywordFlags = [...new Set(p.fresh.flatMap((m) => detectRisk(m.text)))];
      const flags: RiskFlag[] = [...new Set([...keywordFlags, ...analysis.riskFlags])];
      // Progress only moves forward, except that a clear "no" always registers.
      const stage: Stage = analysis.stage === 'declined' || STAGE_RANK[analysis.stage] >= STAGE_RANK[current.stage] ? analysis.stage : current.stage;
      repos.conversations.update(conversationId, { lastAnalysis: { ...analysis, riskFlags: flags }, stage, goalProgress: stage === 'converted' ? 100 : analysis.goalProgress });
      if (output.memoryAdd.length > 0) {
        const facts = [...new Set([...contact.facts, ...output.memoryAdd])].slice(-30);
        repos.contacts.update(contact.id, { facts });
      }
      if (output.interestTags.length > 0) {
        repos.contacts.update(contact.id, { tags: [...new Set([...contact.tags, ...output.interestTags])].slice(-20) });
      }
      if (analysis.language && analysis.language !== contact.language && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(analysis.language)) repos.contacts.update(contact.id, { language: analysis.language });

      if (analysis.optOut) {
        this.applyOptOut(current, p.account, contact, 'AI 判断', contact.language);
        return;
      }
      const hard = flags.filter((f) => HARD_FLAGS.includes(f));
      if (output.action === 'handoff' || hard.length > 0) {
        const reason = output.handoffReason || (hard.length ? hard.map((f) => RISK_LABELS[f]).join('、') : 'AI 认为需要真人处理');
        repos.conversations.update(conversationId, { state: 'handoff', stateReason: `需要真人处理：${reason}` });
        repos.events.add('handoff', { flags, reason, source: 'llm' }, { accountId: p.account.id, conversationId, level: 'warn' });
        return;
      }
      if (blocked) {
        repos.conversations.update(conversationId, { state: 'handoff', stateReason: `AI 的回复两次未通过安全检查（${blocked}），请人工回复` });
        repos.events.add('guard_blocked', { code: blocked, llmCallId }, { accountId: p.account.id, conversationId, level: 'warn' });
        return;
      }
      if (output.action === 'wait' || texts.length === 0) {
        repos.events.add('ai_wait', { notes: analysis.notes }, { conversationId });
        if (output.action === 'close') repos.conversations.update(conversationId, { state: 'closed', stateReason: 'AI 判断对话已结束' });
        return;
      }

      const soft = flags.filter((f) => !HARD_FLAGS.includes(f));
      const reviewReason = soft.length > 0 ? `涉及${soft.map((f) => RISK_LABELS[f]).join('、')}，需要人工确认` : materialReview !== '' ? materialReview : repos.settings.get().autopilotPaused && this.effectiveMode(current, p.account, p.campaign) === 'autopilot' ? '全局自动发送已暂停' : '';
      const auto = p.mode === 'autopilot' && reviewReason === '';
      const batchId = newId('batch');
      const outgoing: { text: string; kind: Message['kind'] }[] = texts.map((text) => ({ text, kind: 'text' as const }));

      // Whoever reads an automated message is told a machine wrote it. In copilot the owner sends it themselves.
      if (p.mode === 'autopilot') {
        if (current.kind === 'comment') {
          const signature = isValidDisclosure(p.persona.commentSignature) ? p.persona.commentSignature : FALLBACK_COMMENT_SIGNATURE;
          outgoing[0] = { text: `${outgoing[0]!.text} ${signature}`, kind: 'text' };
        } else if (current.disclosedAt === null || now - current.disclosedAt > REDISCLOSE_AFTER_MS) {
          outgoing.unshift({ text: isValidDisclosure(p.persona.disclosure) ? p.persona.disclosure : FALLBACK_DISCLOSURE, kind: 'disclosure' });
        }
      }

      const replyToRef = [...p.fresh].reverse().find((m) => m.replyToRef)?.replyToRef ?? null;
      let sendAt = now;
      outgoing.forEach((item, seq) => {
        if (auto && !opts.instant) {
          sendAt += seq === 0 ? pacingDelayMs(item.text, p.campaign.replyDelayMinS, p.campaign.replyDelayMaxS, this.rand) : pacingDelayMs(item.text, 2, 6, this.rand);
          sendAt = nextAllowedTime(sendAt, { start: p.account.quietStart, end: p.account.quietEnd, timezone: p.account.timezone });
        }
        const message = repos.messages.insert({ conversationId, accountId: p.account.id, direction: 'out', author: 'ai', text: item.text, status: auto ? 'scheduled' : 'pending_approval', kind: item.kind, reviewReason, sendAt: auto ? sendAt : null, replyToRef, llmCallId, batchId, seq });
        if (auto) queue.enqueue('send_message', { messageId: message.id, instant: opts.instant === true }, { runAt: sendAt, dedupeKey: `send:${message.id}`, maxAttempts: 1 });
      });
      if (opts.trigger === 'followup') repos.conversations.update(conversationId, { followupsSent: current.followupsSent + 1 });
      if (output.action === 'close' || p.expired) repos.conversations.update(conversationId, { state: 'closed', stateReason: p.expired ? '任务期限已到' : 'AI 判断对话已结束' });
      repos.events.add('draft_created', { mode: p.mode, auto, bubbles: outgoing.length, reviewReason, llmCallId }, { accountId: p.account.id, conversationId });

      const settings = repos.settings.get();
      if (settings.summarizeEvery > 0 && repos.messages.countDelivered(conversationId) - p.contact.summarizedCount >= settings.summarizeEvery) {
        queue.enqueue('summarize', { conversationId }, { dedupeKey: `sum:${conversationId}`, maxAttempts: 2 });
      }
    });
    log.debug({ conversationId, action: output.action }, 'generation applied');
    this.notify(conversationId);
    return '';
  }

  /** Same prompt, several models, nothing stored as a message. For teaching and for picking a provider. */
  async compare(conversationId: string, providerIds: string[], operatorHint: string): Promise<CompareCandidate[]> {
    const prepared = this.prepare(conversationId, 'regenerate');
    if (typeof prepared === 'string') throw new Error(prepared);
    return Promise.all(
      providerIds.slice(0, 6).map(async (providerId): Promise<CompareCandidate> => {
        const provider = this.d.repos.providers.get(providerId);
        const base = { providerId, providerName: provider?.name ?? providerId, model: provider?.model ?? '', messages: [] as string[], analysis: null, latencyMs: 0, llmCallId: null };
        try {
          const started = Date.now();
          const drafted = await this.draft(prepared, { trigger: 'regenerate', operatorHint, providerId });
          if (drafted.blocked) return { ...base, ok: false, error: `未通过安全检查：${drafted.blocked}`, latencyMs: Date.now() - started, llmCallId: drafted.llmCallId };
          return { ...base, ok: true, error: '', messages: drafted.texts, analysis: drafted.output.analysis, latencyMs: Date.now() - started, llmCallId: drafted.llmCallId };
        } catch (err) {
          return { ...base, ok: false, error: errMessage(err).slice(0, 300) };
        }
      }),
    );
  }

  /** Turns a compare candidate (or any operator-picked text) into a draft awaiting approval. */
  adoptDraft(conversationId: string, texts: string[], llmCallId: string | null): void {
    const { db, repos } = this.d;
    db.tx(() => {
      const conversation = repos.conversations.get(conversationId);
      if (!conversation) throw new Error('conversation not found');
      this.supersedeOpen(conversationId, 'replaced by picked candidate');
      const batchId = newId('batch');
      texts.forEach((text, seq) => repos.messages.insert({ conversationId, accountId: conversation.accountId, direction: 'out', author: 'ai', text, status: 'pending_approval', llmCallId, batchId, seq }));
    });
    this.notify(conversationId);
  }

  // ------------------------------------------------------------------ sending

  async send(messageId: string, opts: { instant?: boolean } = {}): Promise<void> {
    const message = this.d.repos.messages.get(messageId);
    if (!message) return;
    return this.sendMutex.run(message.accountId, () => this.sendLocked(messageId, opts));
  }

  private async sendLocked(messageId: string, opts: { instant?: boolean }): Promise<void> {
    const { repos, clock, connectors, queue } = this.d;
    const message = repos.messages.get(messageId);
    if (!message || message.status !== 'scheduled') return;
    const conversation = repos.conversations.get(message.conversationId);
    const account = conversation && repos.accounts.get(conversation.accountId);
    const contact = conversation && repos.contacts.get(conversation.contactId);
    if (!conversation || !account || !contact) return;
    const now = clock.now();
    const automated = !message.approved;
    const drop = (status: Message['status'], error: string) => {
      repos.messages.update(message.id, { status, error });
      this.notify(conversation.id);
    };

    if (message.kind !== 'optout_ack') {
      if (contact.optedOut || repos.suppressions.has(account.platform, contact.platformUserId)) return drop('cancelled', '对方已要求停止联系');
      if (['paused', 'handoff', 'opted_out'].includes(conversation.state) && automated) return drop('cancelled', `对话状态为 ${conversation.state}`);
    }
    if (automated && message.kind !== 'optout_ack') {
      const campaign = this.resolveCampaign(conversation);
      if (!campaign?.enabled || this.effectiveMode(conversation, account, campaign) !== 'autopilot') {
        repos.messages.update(message.id, { status: 'pending_approval', reviewReason: '自动回复已关闭', sendAt: null });
        return this.notify(conversation.id);
      }
      if (repos.settings.get().autopilotPaused) {
        repos.messages.update(message.id, { status: 'pending_approval', reviewReason: '全局自动发送已暂停', sendAt: null });
        return this.notify(conversation.id);
      }
      if (repos.messages.hasInboundAfter(conversation.id, message.id)) {
        // They wrote again before this went out. Answer what they said now, not what they said then.
        this.supersedeOpen(conversation.id, 'new inbound before send');
        queue.enqueue('generate_reply', { conversationId: conversation.id, trigger: 'inbound' }, { runAt: now + 1500, dedupeKey: `gen:${conversation.id}`, reschedule: true });
        return this.notify(conversation.id);
      }
      if (now - message.createdAt > STALE_OUTBOUND_MS) return drop('cancelled', '等待发送超过 6 小时，已作废');
      if (message.batchId) {
        const earlier = this.d.db.get<{ status: Message['status'] }>("SELECT status FROM messages WHERE batchId = ? AND seq < ? AND status != 'sent' ORDER BY seq LIMIT 1", message.batchId, message.seq);
        if (earlier) {
          if (earlier.status === 'scheduled' || earlier.status === 'sending') throw new RetryLater(now + MIN_SEND_GAP_MS, '等待前一条消息发送');
          repos.messages.update(message.id, { status: 'pending_approval', reviewReason: '前一条消息未发出，请确认后续回复', sendAt: null });
          return this.notify(conversation.id);
        }
      }
      const instant = opts.instant === true && account.connector === 'sandbox';
      if (!instant) {
        if (account.status !== 'active') throw new RetryLater(now + 5 * MINUTE, `account is ${account.status}`);
        const allowed = nextAllowedTime(now, { start: account.quietStart, end: account.quietEnd, timezone: account.timezone });
        if (allowed > now) throw new RetryLater(allowed, 'quiet hours');
        if (account.maxPerHour > 0 && repos.messages.countSent({ accountId: account.id, since: now - HOUR }) >= account.maxPerHour) throw new RetryLater(now + 10 * MINUTE, 'hourly limit');
        if (account.maxPerDay > 0 && repos.messages.countSent({ accountId: account.id, since: now - DAY }) >= account.maxPerDay) throw new RetryLater(now + HOUR, 'daily limit');
        if (account.maxPerContactDay > 0 && repos.messages.countSent({ conversationId: conversation.id, since: now - DAY }) >= account.maxPerContactDay) throw new RetryLater(now + HOUR, 'per-contact daily limit');
        const lastSent = repos.messages.lastSentAt(account.id);
        if (lastSent !== null && now - lastSent < MIN_SEND_GAP_MS) throw new RetryLater(lastSent + MIN_SEND_GAP_MS, 'send gap');
      }
    }

    const connector = connectors.get(account.connector);
    if (!connector?.send) return drop('failed', '这个账号的连接方式不能发送，请手动发送后点「标记已发送」');

    // Marked before the network call. If the process dies mid-send the row stays `sending`, and startup
    // recovery reports it as "delivery unknown" rather than sending a second copy.
    repos.messages.update(message.id, { status: 'sending', attempts: message.attempts + 1 });
    try {
      const sent = await connector.send(connectors.context(account), { kind: conversation.kind, threadRef: conversation.threadRef, contactPlatformUserId: contact.platformUserId, text: message.text, replyToRef: message.replyToRef });
      const sentAt = clock.now();
      const platformMsgId = sent.platformMsgId && !repos.messages.existsPlatformId(account.id, sent.platformMsgId) ? sent.platformMsgId : null;
      repos.messages.update(message.id, { status: 'sent', sentAt, platformMsgId, error: '' });
      this.recordMaterialShares(conversation, message.text, message.id);
      const fresh = repos.conversations.get(conversation.id)!;
      const patch: Partial<Conversation> = { lastOutboundAt: sentAt, lastMessageAt: sentAt, unread: 0 };
      if (message.kind === 'disclosure') patch.disclosedAt = sentAt;
      if (message.author === 'ai' && message.kind === 'text' && message.seq <= 1 && !this.earlierTextInBatch(message)) patch.aiTurns = fresh.aiTurns + 1;
      repos.conversations.update(conversation.id, patch);
      if (account.failures > 0 || account.status === 'error') repos.accounts.update(account.id, { failures: 0, status: 'active', statusDetail: '' });
    } catch (err) {
      const e = err instanceof ConnectorError ? err : new ConnectorError('invalid', errMessage(err));
      const attempts = message.attempts + 1;
      if (e.code === 'rate_limited' && attempts < 3) {
        repos.messages.update(message.id, { status: 'scheduled', error: `${e.code}: ${e.message}`.slice(0, 300) });
        throw new RetryLater(now + (e.retryAfterMs ?? 15 * MINUTE), e.code);
      }
      const friendly: Record<string, string> = { transient: '发送结果不确定，请先到平台确认是否已发出，再决定重试', window_closed: '已超出平台允许回复的时间窗口（对方需要先再发一条消息）', auth: '账号授权失效，请到「账号」页重新授权', blocked: '平台拒绝了这条消息', unsupported: '这个账号不能发送' };
      repos.messages.update(message.id, { status: 'failed', error: `${friendly[e.code] ?? e.code}：${e.message}`.slice(0, 400) });
      repos.events.add('send_failed', { code: e.code, error: e.message.slice(0, 300) }, { accountId: account.id, conversationId: conversation.id, messageId: message.id, level: 'error' });
      if (e.code === 'auth') {
        repos.accounts.update(account.id, { status: 'needs_auth', statusDetail: e.message.slice(0, 200) });
        this.d.bus.emit({ type: 'account', accountId: account.id });
      }
    }
    this.notify(conversation.id);
  }

  private earlierTextInBatch(message: Message): boolean {
    if (!message.batchId) return false;
    return this.d.db.get("SELECT 1 AS x FROM messages WHERE batchId = ? AND kind = 'text' AND seq < ? LIMIT 1", message.batchId, message.seq) !== undefined;
  }

  // ------------------------------------------------------------------ operator actions

  approve(messageId: string, editedText?: string): void {
    const { repos, clock, queue, connectors } = this.d;
    const message = repos.messages.get(messageId);
    if (!message || message.status !== 'pending_approval') throw new Error('这条草稿已经不在待审核状态');
    const conversation = repos.conversations.get(message.conversationId);
    const account = conversation && repos.accounts.get(conversation.accountId);
    if (!conversation || !account) throw new Error('conversation not found');
    if (!connectors.canSend(account)) throw new Error('这个账号不能自动发送：请复制后手动发送，再点「标记已发送」');
    const text = editedText?.trim() || message.text;
    const runAt = clock.now() + message.seq * 1500;
    repos.messages.update(messageId, { text, approved: true, status: 'scheduled', sendAt: runAt, reviewReason: '' });
    queue.enqueue('send_message', { messageId }, { runAt, dedupeKey: `send:${messageId}`, maxAttempts: 1 });
    repos.events.add('draft_approved', { edited: text !== message.text }, { conversationId: conversation.id, messageId });
    this.notify(conversation.id);
  }

  /** Manual-bridge accounts: the owner sent it from their phone. */
  /**
   * Only for text that actually went out. Counting drafts would include the ones an operator rejected
   * or rewrote, and the numbers would stop agreeing with what the other person saw.
   */
  private recordMaterialShares(conversation: Conversation, text: string, messageId: string): void {
    const { repos } = this.d;
    const campaign = conversation.campaignId === null ? undefined : repos.campaigns.get(conversation.campaignId);
    if (!campaign || campaign.materials.length === 0) return;
    for (const m of matchMaterials([text], campaign.materials)) {
      repos.events.add('material_shared', { materialId: m.id, title: m.title, campaignId: campaign.id }, { accountId: conversation.accountId, conversationId: conversation.id, messageId });
    }
  }

  markSent(messageId: string, editedText?: string): void {
    const { repos, clock } = this.d;
    const message = repos.messages.get(messageId);
    if (!message || !['pending_approval', 'failed'].includes(message.status)) throw new Error('这条消息不能标记为已发送');
    const now = clock.now();
    const finalText = editedText?.trim() || message.text;
    repos.messages.update(messageId, { text: finalText, approved: true, status: 'sent', sentAt: now, error: '' });
    const conversation = repos.conversations.get(message.conversationId);
    if (conversation) this.recordMaterialShares(conversation, finalText, messageId);
    if (conversation) repos.conversations.update(conversation.id, { lastOutboundAt: now, lastMessageAt: now, unread: 0, ...(message.kind === 'disclosure' ? { disclosedAt: now } : {}), aiTurns: conversation.aiTurns + (message.author === 'ai' && message.kind === 'text' && !this.earlierTextInBatch(message) ? 1 : 0) });
    this.notify(message.conversationId);
  }

  discard(messageId: string, status: 'rejected' | 'cancelled'): void {
    const { repos, queue } = this.d;
    const message = repos.messages.get(messageId);
    if (!message || !['pending_approval', 'scheduled'].includes(message.status)) throw new Error('这条消息已经不能撤回');
    repos.messages.update(messageId, { status });
    queue.cancelByKey(`send:${messageId}`);
    this.notify(message.conversationId);
  }

  retry(messageId: string): void {
    const { repos, clock, queue } = this.d;
    const message = repos.messages.get(messageId);
    if (!message || message.status !== 'failed') throw new Error('只有发送失败的消息可以重试');
    repos.messages.update(messageId, { status: 'scheduled', approved: true, attempts: 0, error: '', sendAt: clock.now() });
    queue.enqueue('send_message', { messageId }, { dedupeKey: `send:${messageId}`, maxAttempts: 1 });
    this.notify(message.conversationId);
  }

  operatorSend(conversationId: string, text: string): Message {
    const { db, repos, clock, queue, connectors } = this.d;
    const conversation = repos.conversations.get(conversationId);
    const account = conversation && repos.accounts.get(conversation.accountId);
    if (!conversation || !account) throw new Error('conversation not found');
    const canSend = connectors.canSend(account);
    const now = clock.now();
    const message = db.tx(() => {
      this.supersedeOpen(conversationId, 'operator replied');
      queue.cancelByKey(`gen:${conversationId}`);
      const replyToRef = db.get<{ replyToRef: string | null }>("SELECT replyToRef FROM messages WHERE conversationId = ? AND direction = 'in' AND replyToRef IS NOT NULL ORDER BY rowid DESC LIMIT 1", conversationId)?.replyToRef ?? null;
      const created = repos.messages.insert({ conversationId, accountId: account.id, direction: 'out', author: 'operator', text, approved: true, status: canSend ? 'scheduled' : 'pending_approval', sendAt: canSend ? now : null, replyToRef });
      const patch: Partial<Conversation> = { unread: 0 };
      const campaign = this.resolveCampaign(conversation);
      if (repos.settings.get().pauseOnOperatorReply && this.effectiveMode(conversation, account, campaign) === 'autopilot') {
        patch.modeOverride = 'copilot';
        repos.events.add('autopilot_paused_operator_reply', {}, { conversationId });
      }
      repos.conversations.update(conversationId, patch);
      return created;
    });
    if (canSend) queue.enqueue('send_message', { messageId: message.id }, { dedupeKey: `send:${message.id}`, maxAttempts: 1 });
    this.notify(conversationId);
    return message;
  }

  requestGenerate(conversationId: string, opts: { trigger: Trigger; operatorHint?: string; providerId?: string }): void {
    this.d.queue.enqueue('generate_reply', { conversationId, ...opts }, { dedupeKey: `gen:${conversationId}`, reschedule: true });
  }

  // ------------------------------------------------------------------ background jobs

  async handleGenerateJob(job: Job): Promise<void> {
    const payload = job.payload as { conversationId: string; trigger?: Trigger; operatorHint?: string; providerId?: string };
    await this.generate(payload.conversationId, { trigger: payload.trigger ?? 'inbound', operatorHint: payload.operatorHint, providerId: payload.providerId, finalAttempt: job.attempts + 1 >= job.maxAttempts });
  }

  async handleSendJob(job: Job): Promise<void> {
    const payload = job.payload as { messageId: string; instant?: boolean };
    await this.send(payload.messageId, { instant: payload.instant });
  }

  /** Conversations where the other person engaged, then went quiet. At most `followupMax` (hard cap 3) nudges. */
  scanFollowups(): number {
    const { db, repos, clock, queue } = this.d;
    const now = clock.now();
    const rows = db.all<{ id: string }>(
      `SELECT c.id FROM conversations c JOIN campaigns cp ON cp.id = c.campaignId
       WHERE c.state = 'active' AND cp.enabled = 1 AND cp.followupEnabled = 1
         AND c.lastInboundAt IS NOT NULL AND c.lastOutboundAt IS NOT NULL AND c.lastOutboundAt > c.lastInboundAt
         AND c.followupsSent < MIN(cp.followupMax, 3)
         AND c.lastOutboundAt <= ? - cp.followupAfterH * 3600000
         AND (c.deadlineAt IS NULL OR c.deadlineAt > ?)
         AND c.stage != 'declined'
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversationId = c.id AND m.status IN ('pending_approval', 'scheduled', 'sending'))`,
      now,
      now,
    );
    for (const row of rows) queue.enqueue('generate_reply', { conversationId: row.id, trigger: 'followup' }, { dedupeKey: `gen:${row.id}` });
    if (rows.length > 0) repos.events.add('followup_scan', { queued: rows.length });
    return rows.length;
  }

  async summarize(conversationId: string): Promise<void> {
    const { repos, router } = this.d;
    const conversation = repos.conversations.get(conversationId);
    const contact = conversation && repos.contacts.get(conversation.contactId);
    const account = conversation && repos.accounts.get(conversation.accountId);
    if (!conversation || !contact || !account) return;
    const all = repos.messages.delivered(conversationId, 400);
    const unsummarized = all.slice(Math.min(contact.summarizedCount, all.length));
    if (unsummarized.length === 0) return;
    const campaign = this.resolveCampaign(conversation);
    const prompt = buildSummaryPrompt(contact, unsummarized, account.timezone);
    const routed = await router.chat({ purpose: 'summary', ...prompt, schema: SummaryWire }, { conversationId, providerIds: campaign?.providerIds, parse: normalizeSummary });
    repos.contacts.update(contact.id, { summary: routed.value.summary, facts: [...new Set([...contact.facts, ...routed.value.facts])].slice(-30), summarizedCount: repos.messages.countDelivered(conversationId) });
    this.notify(conversationId);
  }

  /** After a crash: anything caught mid-send has unknown delivery, so a person decides rather than the queue. */
  recoverInterrupted(): void {
    const { db, repos, queue } = this.d;
    for (const job of queue.takeInterrupted()) {
      if (job.type === 'send_message' || job.type === 'sim_run') queue.abandon(job.id, 'interrupted by restart');
      else queue.requeue(job.id);
    }
    const stuck = db.all<{ id: string; conversationId: string }>("SELECT id, conversationId FROM messages WHERE status = 'sending'");
    for (const m of stuck) {
      repos.messages.update(m.id, { status: 'failed', error: '发送过程中程序重启，无法确认对方是否收到。请先到平台上核对，再决定是否重试。' });
      repos.events.add('send_interrupted', {}, { conversationId: m.conversationId, messageId: m.id, level: 'error' });
    }
    db.run("UPDATE sim_runs SET status = 'failed', error = 'interrupted by restart' WHERE status = 'running'");
  }
}
