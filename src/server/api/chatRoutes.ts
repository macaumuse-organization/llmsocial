import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ConversationDetail } from '../../shared/types.ts';
import type { App } from '../app.ts';
import { parseChatScreenshot } from '../ocr/parseChat.ts';
import { errMessage, newId } from '../util.ts';
import { HttpError, notFound } from './server.ts';
import { MessageText, ModeEnum, StageEnum, StateEnum } from './validators.ts';

const Id = z.object({ id: z.string().min(1).max(80) });

export function registerChatRoutes(server: FastifyInstance, app: App): void {
  const { repos, pipeline } = app;

  const detail = (id: string): ConversationDetail => {
    const conversation = repos.conversations.listItem(id);
    if (!conversation) throw notFound('对话');
    const contact = repos.contacts.get(conversation.contactId)!;
    const account = repos.accounts.get(conversation.accountId)!;
    return { conversation, contact, messages: repos.messages.byConversation(id, 400), canSend: app.connectors.canSend(account) };
  };

  // ---------------------------------------------------------------- conversations

  server.get('/api/conversations', async (req) => {
    const q = z
      .object({
        state: StateEnum.optional(),
        accountId: z.string().max(80).optional(),
        needsAction: z.enum(['0', '1']).optional(),
        q: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(req.query);
    return repos.conversations.list({ ...q, needsAction: q.needsAction === '1' });
  });

  server.get('/api/conversations/:id', async (req) => {
    const { id } = Id.parse(req.params);
    const out = detail(id);
    // Opening a conversation is how the operator "reads" it.
    if (out.conversation.unread > 0) {
      repos.conversations.update(id, { unread: 0 });
      out.conversation.unread = 0;
      app.bus.emit({ type: 'conversation', conversationId: id });
    }
    return out;
  });

  server.patch('/api/conversations/:id', async (req) => {
    const { id } = Id.parse(req.params);
    const conversation = repos.conversations.get(id);
    if (!conversation) throw notFound('对话');
    const patch = z
      .object({ state: StateEnum.optional(), modeOverride: ModeEnum.nullable().optional(), campaignId: z.string().max(80).nullable().optional(), stage: StageEnum.optional(), stateReason: z.string().max(300).optional() })
      .parse(req.body);
    // Someone who asked not to be contacted stays opted out; only clearing the contact flag undoes it.
    if (conversation.state === 'opted_out' && patch.state && patch.state !== 'opted_out') {
      throw new HttpError(400, '对方已要求停止联系。如果确认是误判，请到联系人里解除，再改状态。');
    }
    if (patch.campaignId && !repos.campaigns.get(patch.campaignId)) throw notFound('任务');
    if (patch.campaignId !== undefined && patch.campaignId !== conversation.campaignId) {
      const campaign = patch.campaignId ? repos.campaigns.get(patch.campaignId) : null;
      repos.conversations.update(id, { deadlineAt: campaign ? app.clock.now() + campaign.maxDays * 86_400_000 : null, aiTurns: 0, followupsSent: 0 });
    }
    repos.conversations.update(id, patch);
    if ((patch.state !== undefined && patch.state !== 'active') || (patch.campaignId !== undefined && patch.campaignId !== conversation.campaignId)) pipeline.cancelPending(id);
    app.bus.emit({ type: 'conversation', conversationId: id });
    return detail(id);
  });

  server.post('/api/conversations/:id/send', async (req) => {
    const { id } = Id.parse(req.params);
    const { text } = z.object({ text: MessageText }).parse(req.body);
    if (!repos.conversations.get(id)) throw notFound('对话');
    pipeline.operatorSend(id, text.trim());
    return detail(id);
  });

  server.post('/api/conversations/:id/generate', async (req) => {
    const { id } = Id.parse(req.params);
    const body = z.object({ trigger: z.enum(['inbound', 'followup', 'opener', 'regenerate']).default('regenerate'), operatorHint: z.string().max(2000).default(''), providerId: z.string().max(80).optional() }).parse(req.body ?? {});
    if (!repos.conversations.get(id)) throw notFound('对话');
    // Run inline so the UI can show the result (and any error) instead of silently queueing.
    const refused = await pipeline.generate(id, { trigger: body.trigger, operatorHint: body.operatorHint, providerId: body.providerId, finalAttempt: true });
    // A refusal here is a rule the operator cannot click past (opt-out, platform not allowed): say so.
    if (refused) throw new HttpError(400, refused);
    return detail(id);
  });

  server.post('/api/conversations/:id/compare', async (req) => {
    const { id } = Id.parse(req.params);
    const body = z.object({ providerIds: z.array(z.string().max(80)).min(1).max(6), operatorHint: z.string().max(2000).default('') }).parse(req.body);
    if (!repos.conversations.get(id)) throw notFound('对话');
    try {
      return await pipeline.compare(id, body.providerIds, body.operatorHint);
    } catch (err) {
      throw new HttpError(400, errMessage(err));
    }
  });

  server.post('/api/conversations/:id/adopt', async (req) => {
    const { id } = Id.parse(req.params);
    const body = z.object({ texts: z.array(MessageText).min(1).max(4), llmCallId: z.string().max(80).nullable().default(null) }).parse(req.body);
    if (!repos.conversations.get(id)) throw notFound('对话');
    if (body.llmCallId && repos.llmCalls.get(body.llmCallId)?.conversationId !== id) throw new HttpError(400, '模型回复不属于这段对话');
    pipeline.adoptDraft(id, body.texts, body.llmCallId);
    return detail(id);
  });

  server.get('/api/conversations/:id/llm-calls', async (req) => {
    const { id } = Id.parse(req.params);
    return repos.llmCalls.byConversation(id, 30).map(({ systemPrompt, userPrompt, rawResponse, ...rest }) => ({ ...rest, promptChars: systemPrompt.length + userPrompt.length, responseChars: rawResponse.length }));
  });

  // The full prompt is fetched on demand: it is the most sensitive text in the system.
  server.get('/api/llm-calls/:id', async (req) => {
    const { id } = Id.parse(req.params);
    const call = repos.llmCalls.get(id);
    if (!call) throw notFound('模型调用记录');
    return call;
  });

  // ---------------------------------------------------------------- messages

  const withText = z.object({ text: MessageText.optional() });

  server.post('/api/messages/:id/approve', async (req) => {
    const { id } = Id.parse(req.params);
    const { text } = withText.parse(req.body ?? {});
    const message = repos.messages.get(id);
    if (!message) throw notFound('消息');
    try {
      pipeline.approve(id, text);
    } catch (err) {
      throw new HttpError(400, errMessage(err));
    }
    return detail(message.conversationId);
  });

  server.post('/api/messages/:id/mark-sent', async (req) => {
    const { id } = Id.parse(req.params);
    const { text } = withText.parse(req.body ?? {});
    const message = repos.messages.get(id);
    if (!message) throw notFound('消息');
    try {
      pipeline.markSent(id, text);
    } catch (err) {
      throw new HttpError(400, errMessage(err));
    }
    return detail(message.conversationId);
  });

  server.post('/api/messages/:id/discard', async (req) => {
    const { id } = Id.parse(req.params);
    const message = repos.messages.get(id);
    if (!message) throw notFound('消息');
    try {
      pipeline.discard(id, message.status === 'scheduled' ? 'cancelled' : 'rejected');
    } catch (err) {
      throw new HttpError(400, errMessage(err));
    }
    return detail(message.conversationId);
  });

  server.post('/api/messages/:id/retry', async (req) => {
    const { id } = Id.parse(req.params);
    const message = repos.messages.get(id);
    if (!message) throw notFound('消息');
    try {
      pipeline.retry(id);
    } catch (err) {
      throw new HttpError(400, errMessage(err));
    }
    return detail(message.conversationId);
  });

  // ---------------------------------------------------------------- contacts

  server.get('/api/contacts', async (req) => {
    const q = z.object({ q: z.string().max(100).default(''), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
    return repos.contacts.list(q.q, q.limit);
  });

  server.patch('/api/contacts/:id', async (req) => {
    const { id } = Id.parse(req.params);
    const contact = repos.contacts.get(id);
    if (!contact) throw notFound('联系人');
    const patch = z.object({ displayName: z.string().max(100).optional(), notes: z.string().max(4000).optional(), tags: z.array(z.string().max(40)).max(20).optional(), facts: z.array(z.string().max(200)).max(30).optional(), summary: z.string().max(2000).optional(), optedOut: z.boolean().optional() }).parse(req.body);
    const account = repos.accounts.get(contact.accountId);
    if (patch.optedOut !== undefined && account) {
      if (patch.optedOut) repos.suppressions.add(account.platform, contact.platformUserId, '手动标记');
      else repos.suppressions.remove(account.platform, contact.platformUserId);
    }
    return repos.contacts.update(id, patch);
  });

  // ---------------------------------------------------------------- manual import

  server.post('/api/import/ocr', { bodyLimit: 24 * 1024 * 1024 }, async (req) => {
    const { image } = z.object({ image: z.string().min(16).max(32 * 1024 * 1024) }).parse(req.body);
    if (repos.settings.get().ocrEngine === 'off') throw new HttpError(400, '本地 OCR 已在设置里关闭');
    const buffer = Buffer.from(image.replace(/^data:[^,]+,/, ''), 'base64');
    if (buffer.length === 0) throw new HttpError(400, '图片解析失败');
    try {
      const lines = await app.ocr.recognize(buffer);
      return { lines, messages: parseChatScreenshot(lines) };
    } catch (err) {
      throw new HttpError(400, errMessage(err));
    }
  });

  server.post('/api/import/messages', async (req) => {
    const body = z
      .object({
        accountId: z.string().min(1).max(80),
        contact: z.object({ platformUserId: z.string().min(1).max(200), displayName: z.string().max(100).default('') }),
        threadRef: z.string().max(200).optional(),
        kind: z.enum(['dm', 'comment']).default('dm'),
        title: z.string().max(200).default(''),
        messages: z.array(z.object({ side: z.enum(['contact', 'me']), text: MessageText })).min(1).max(100),
        generate: z.boolean().default(true),
      })
      .parse(req.body);
    const account = repos.accounts.get(body.accountId);
    if (!account) throw notFound('账号');
    if (!['manual', 'sandbox'].includes(account.connector)) throw new HttpError(400, '聊天记录只能导入手动或沙盒账号');
    const threadRef = body.threadRef || body.contact.platformUserId;
    let conversationId = '';
    const now = app.clock.now();
    // Spread the imported turns over the preceding minutes so their order is preserved downstream.
    body.messages.forEach((m, i) => {
      const stored = pipeline.ingest(
        body.accountId,
        {
          platformMsgId: newId('import'),
          kind: body.kind,
          threadRef,
          threadTitle: body.title || undefined,
          contact: { platformUserId: body.contact.platformUserId, displayName: body.contact.displayName },
          text: m.text.trim(),
          timestamp: now - (body.messages.length - i) * 1000,
          fromSelf: m.side === 'me',
        },
        { noSchedule: true },
      );
      if (stored?.conversationId) conversationId = stored.conversationId;
    });
    if (!conversationId) throw new HttpError(400, '导入失败：没有可用的消息');
    if (body.generate && repos.conversations.get(conversationId)?.state === 'active') pipeline.requestGenerate(conversationId, { trigger: 'inbound' });
    return detail(conversationId);
  });

  /** Start a thread with someone who is already a contact (or whose handle the operator types in). */
  server.post('/api/conversations', async (req) => {
    const body = z.object({ accountId: z.string().min(1).max(80), platformUserId: z.string().min(1).max(200), displayName: z.string().max(100).default(''), campaignId: z.string().max(80).nullable().default(null), kind: z.enum(['dm', 'comment']).default('dm'), title: z.string().max(200).default('') }).parse(req.body);
    const account = repos.accounts.get(body.accountId);
    if (!account) throw notFound('账号');
    if (repos.suppressions.has(account.platform, body.platformUserId)) throw new HttpError(400, '这个人已在屏蔽名单里，不能再联系');
    const campaign = body.campaignId ? repos.campaigns.get(body.campaignId) : null;
    if (body.campaignId && !campaign) throw notFound('任务');
    const contact = repos.contacts.upsert(body.accountId, { platformUserId: body.platformUserId, displayName: body.displayName });
    const existing = repos.conversations.find(body.accountId, contact.id, body.kind, body.platformUserId);
    if (existing) return detail(existing.id);
    const created = repos.conversations.create({ accountId: body.accountId, contactId: contact.id, campaignId: campaign?.id ?? null, kind: body.kind, threadRef: body.platformUserId, title: body.title, deadlineAt: campaign ? app.clock.now() + campaign.maxDays * 86_400_000 : null });
    return detail(created.id);
  });
}
