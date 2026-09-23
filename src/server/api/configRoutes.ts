import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GOAL_TYPES, PLATFORMS, PROVIDER_PRESETS, SIM_PERSONAS } from '../../shared/platforms.ts';
import type { Meta } from '../../shared/types.ts';
import type { App } from '../app.ts';
import { accountSecretName } from '../connectors/registry.ts';
import { ConnectorError } from '../connectors/types.ts';
import { toAccountDto } from '../db/repos.ts';
import { isValidTimezone } from '../queue/schedule.ts';
import { looksLikeRef, parseSecretRef } from '../secrets/store.ts';
import { parseSkillMarkdown, skillToMarkdown } from '../seed.ts';
import { buildStats } from '../stats.ts';
import { errMessage, newId } from '../util.ts';
import { HttpError, notFound } from './server.ts';
import { AccountInput, CampaignInput, PersonaInput, ProviderInput, SettingsInput, SimInput, SkillInput, patchBody } from './validators.ts';

const Id = z.object({ id: z.string().min(1).max(80) });

/**
 * Turns whatever the operator typed into a reference. A value that already looks like a reference is
 * kept as one (so a key can live in the keychain and never enter this database); anything else is
 * encrypted at rest under a derived name.
 */
function storeSecret(app: App, name: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    app.secrets.delete(name);
    return '';
  }
  if (looksLikeRef(trimmed)) {
    if (!parseSecretRef(trimmed)) throw new HttpError(400, '引用格式不对：应为 env:变量名、keychain:服务名[:账号] 或 secret:名称');
    return trimmed;
  }
  return app.secrets.put(name, trimmed);
}

export function registerConfigRoutes(server: FastifyInstance, app: App): void {
  const { repos } = app;

  // ---------------------------------------------------------------- meta & settings

  server.get('/api/meta', async (): Promise<Meta> => ({
    version: '0.1.0',
    platforms: PLATFORMS,
    connectors: app.connectors.metas(),
    providerPresets: PROVIDER_PRESETS,
    goalTypes: GOAL_TYPES,
    simPersonas: SIM_PERSONAS,
    webhookBaseUrl: app.config.publicWebhookUrl || `http://127.0.0.1:${app.config.webhookPort}`,
    ocrAvailable: await app.ocr.available(),
    ocrHint: await app.ocr.describe(),
  }));

  server.get('/api/settings', async () => repos.settings.get());

  server.patch('/api/settings', async (req) => {
    const patch = SettingsInput.parse(req.body);
    const settings = repos.settings.patch(patch);
    if (patch.autopilotPaused !== undefined) repos.events.add('settings_autopilot', { paused: patch.autopilotPaused }, { level: 'warn' });
    app.bus.emit({ type: 'settings' });
    return settings;
  });

  server.get('/api/stats', async () => buildStats(app.db, repos, app.clock));

  server.get('/api/events', async (req) => {
    const q = z.object({ conversationId: z.string().optional(), accountId: z.string().optional(), level: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
    return repos.events.list(q);
  });

  // ---------------------------------------------------------------- providers

  server.get('/api/providers', async () => repos.providers.list());

  server.post('/api/providers', async (req) => {
    const { apiKey, ...input } = ProviderInput.parse(req.body);
    const id = newId('prov');
    const provider = repos.providers.create({ ...input, apiKeyRef: '' }, id);
    if (apiKey !== undefined) repos.providers.update(id, { apiKeyRef: storeSecret(app, `prov.${id}.apiKey`, apiKey) });
    return repos.providers.get(provider.id);
  });

  server.patch('/api/providers/:id', async (req) => {
    const { id } = Id.parse(req.params);
    if (!repos.providers.get(id)) throw notFound('模型');
    const { apiKey, ...input } = patchBody(ProviderInput, req.body);
    if (apiKey !== undefined) repos.providers.update(id, { apiKeyRef: storeSecret(app, `prov.${id}.apiKey`, apiKey) });
    return repos.providers.update(id, input);
  });

  server.delete('/api/providers/:id', async (req) => {
    const { id } = Id.parse(req.params);
    repos.providers.delete(id);
    app.secrets.delete(`prov.${id}.apiKey`);
    return { ok: true };
  });

  server.post('/api/providers/:id/test', async (req) => {
    const { id } = Id.parse(req.params);
    const provider = repos.providers.get(id);
    if (!provider) throw notFound('模型');
    const started = Date.now();
    try {
      const routed = await app.router.chat(
        { purpose: 'test', systemStatic: '只输出 JSON：{"ok": true}', systemDynamic: '', user: '请输出 {"ok": true}', schema: z.object({ ok: z.boolean() }) },
        { onlyProviderId: id, parse: (raw) => raw as { ok: boolean } },
      );
      return { ok: true, detail: `连接正常（${routed.provider.model}，${Date.now() - started} ms）` };
    } catch (err) {
      return { ok: false, detail: errMessage(err).slice(0, 400) };
    }
  });

  // ---------------------------------------------------------------- personas

  server.get('/api/personas', async () => repos.personas.list());

  server.post('/api/personas', async (req) => repos.personas.create(PersonaInput.parse(req.body)));

  server.patch('/api/personas/:id', async (req) => {
    const { id } = Id.parse(req.params);
    if (!repos.personas.get(id)) throw notFound('人设');
    return repos.personas.update(id, PersonaInput.partial().parse(req.body));
  });

  server.delete('/api/personas/:id', async (req) => {
    const { id } = Id.parse(req.params);
    repos.personas.delete(id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- skills

  server.get('/api/skills', async () => repos.skills.list());

  server.post('/api/skills', async (req) => {
    const input = SkillInput.parse(req.body);
    if (repos.skills.getBySlug(input.slug)) throw new HttpError(409, `已经有一个标识为 ${input.slug} 的技能`);
    return repos.skills.create({ ...input, builtin: false });
  });

  server.post('/api/skills/import', async (req) => {
    const { markdown } = z.object({ markdown: z.string().min(1).max(40_000) }).parse(req.body);
    let parsed;
    try {
      parsed = parseSkillMarkdown(markdown);
    } catch (err) {
      throw new HttpError(400, errMessage(err));
    }
    const existing = repos.skills.getBySlug(parsed.slug);
    return existing ? repos.skills.update(existing.id, parsed) : repos.skills.create({ ...parsed, enabled: true, builtin: false });
  });

  server.get('/api/skills/:id/export', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const skill = repos.skills.get(id);
    if (!skill) throw notFound('技能');
    return reply.type('text/markdown; charset=utf-8').header('Content-Disposition', `attachment; filename="${skill.slug}.md"`).send(skillToMarkdown(skill));
  });

  server.patch('/api/skills/:id', async (req) => {
    const { id } = Id.parse(req.params);
    const existing = repos.skills.get(id);
    if (!existing) throw notFound('技能');
    const patch = patchBody(SkillInput, req.body);
    if (patch.slug && patch.slug !== existing.slug && repos.skills.getBySlug(patch.slug)) throw new HttpError(409, `已经有一个标识为 ${patch.slug} 的技能`);
    return repos.skills.update(id, patch);
  });

  server.delete('/api/skills/:id', async (req) => {
    const { id } = Id.parse(req.params);
    const skill = repos.skills.get(id);
    if (!skill) return { ok: true };
    const used = repos.campaigns.list().filter((c) => c.skillIds.includes(id));
    if (used.length > 0) throw new HttpError(409, `这个技能还被任务「${used.map((c) => c.name).join('、')}」使用中`);
    repos.skills.delete(id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- campaigns

  server.get('/api/campaigns', async () => repos.campaigns.list());

  server.post('/api/campaigns', async (req) => repos.campaigns.create(CampaignInput.parse(req.body)));

  server.patch('/api/campaigns/:id', async (req) => {
    const { id } = Id.parse(req.params);
    if (!repos.campaigns.get(id)) throw notFound('任务');
    return repos.campaigns.update(id, patchBody(CampaignInput, req.body));
  });

  server.delete('/api/campaigns/:id', async (req) => {
    const { id } = Id.parse(req.params);
    if (id === 'camp_default') throw new HttpError(400, '默认任务不能删除');
    repos.campaigns.delete(id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- accounts

  server.get('/api/accounts', async () => repos.accounts.list().map(toAccountDto));

  function applySecrets(accountId: string, secrets: Record<string, string>): Record<string, string> {
    const current = repos.accounts.get(accountId)?.secretRefs ?? {};
    const next = { ...current };
    for (const [field, value] of Object.entries(secrets)) {
      const ref = storeSecret(app, accountSecretName(accountId, field), value);
      if (ref === '') delete next[field];
      else next[field] = ref;
    }
    return next;
  }

  server.post('/api/accounts', async (req) => {
    const { secrets, ...input } = AccountInput.parse(req.body);
    const connector = app.connectors.get(input.connector);
    if (!connector) throw new HttpError(400, `连接方式 ${input.connector} 尚未提供`);
    if (!connector.meta.platforms.includes(input.platform)) throw new HttpError(400, '这个连接方式不支持所选平台');
    if (!isValidTimezone(input.timezone)) throw new HttpError(400, '时区无效');
    const id = newId('acct');
    app.db.tx(() => {
      repos.accounts.create({ ...input, status: input.status ?? 'active' }, id);
      repos.accounts.update(id, { secretRefs: applySecrets(id, secrets) });
    });
    app.ensurePolling();
    return toAccountDto(repos.accounts.get(id)!);
  });

  server.patch('/api/accounts/:id', async (req) => {
    const { id } = Id.parse(req.params);
    const existing = repos.accounts.get(id);
    if (!existing) throw notFound('账号');
    const { secrets, connector, platform, ...input } = patchBody(AccountInput, req.body);
    if (input.timezone && !isValidTimezone(input.timezone)) throw new HttpError(400, '时区无效');
    // Changing the connector or platform of a live account would orphan its threads and stored tokens.
    if ((connector && connector !== existing.connector) || (platform && platform !== existing.platform)) {
      throw new HttpError(400, '账号建立后不能更换平台或连接方式，请新建一个账号');
    }
    app.db.tx(() => {
      repos.accounts.update(id, input);
      if (secrets) repos.accounts.update(id, { secretRefs: applySecrets(id, secrets) });
    });
    app.ensurePolling();
    app.bus.emit({ type: 'account', accountId: id });
    return toAccountDto(repos.accounts.get(id)!);
  });

  server.delete('/api/accounts/:id', async (req) => {
    const { id } = Id.parse(req.params);
    repos.accounts.delete(id);
    app.secrets.deleteByPrefix(`acct.${id}.`);
    return { ok: true };
  });

  server.post('/api/accounts/:id/test', async (req) => {
    const { id } = Id.parse(req.params);
    const account = repos.accounts.get(id);
    const connector = account && app.connectors.get(account.connector);
    if (!account || !connector) throw notFound('账号');
    try {
      const result = await connector.test(app.connectors.context(account));
      if (result.ok && account.status === 'needs_auth') repos.accounts.update(id, { status: 'active', statusDetail: '', failures: 0 });
      return result;
    } catch (err) {
      const e = err instanceof ConnectorError ? err : null;
      return { ok: false, detail: `${e ? `${e.code}：` : ''}${errMessage(err).slice(0, 300)}` };
    }
  });

  server.post('/api/accounts/:id/poll', async (req) => {
    const { id } = Id.parse(req.params);
    const account = repos.accounts.get(id);
    if (!account) throw notFound('账号');
    if (!app.connectors.get(account.connector)?.poll) throw new HttpError(400, '这个连接方式不支持主动拉取');
    if (account.status === 'paused') throw new HttpError(400, '账号已暂停，请先恢复账号');
    if (account.status === 'needs_auth') throw new HttpError(400, '请先完成账号授权');
    app.queue.enqueue('poll_account', { accountId: id, manual: true }, { dedupeKey: `poll:${id}`, reschedule: true });
    return { ok: true };
  });

  // ---------------------------------------------------------------- OAuth

  // State lives in memory only: the code verifier is single-use and short-lived, and a restart
  // mid-flow should invalidate it rather than leave a usable token exchange on disk.
  const pending = new Map<string, { accountId: string; verifier: string; expiresAt: number }>();

  server.post('/api/accounts/:id/oauth/start', async (req) => {
    const { id } = Id.parse(req.params);
    const account = repos.accounts.get(id);
    const kind = account && app.connectors.get(account.connector)?.meta.oauth;
    if (!account || !kind) throw new HttpError(400, '这个账号不需要 OAuth 授权');
    const clientId = account.config.clientId;
    if (!clientId) throw new HttpError(400, '请先填写 clientId');
    const { buildAuthUrl, pkcePair } = await import('../connectors/oauth.ts');
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(24).toString('base64url');
    const now = app.clock.now();
    for (const [key, value] of pending) if (value.expiresAt < now) pending.delete(key);
    pending.set(state, { accountId: id, verifier, expiresAt: now + 10 * 60_000 });
    const redirectUri = `http://127.0.0.1:${app.config.port}/oauth/callback`;
    return { url: buildAuthUrl(kind, { clientId, redirectUri, state, codeChallenge: challenge }), redirectUri };
  });

  // The platform redirects the browser here. `state` is the authorisation: it was minted by a
  // logged-in session, is unguessable, single-use and expires, so no cookie is required (and a
  // SameSite=Strict cookie would not survive the cross-site redirect anyway).
  server.get('/oauth/callback', async (req, reply) => {
    const page = (message: string) => {
      const escaped = message.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
      return reply.type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><title>llmsocial</title><body style="font:16px/1.6 system-ui;padding:3rem;max-width:36rem;margin:auto"><p>${escaped}</p><p><a href="/">回到 llmsocial</a></p>`);
    };
    const q = z.object({ code: z.string().max(2000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() }).parse(req.query);
    if (q.error) return page(`授权被拒绝：${q.error}`);
    const entry = q.state ? pending.get(q.state) : undefined;
    if (!entry || !q.code) return page('授权链接已失效，请回到账号页重新发起。');
    pending.delete(q.state!);
    if (entry.expiresAt < app.clock.now()) return page('授权链接已过期，请重新发起。');
    const account = repos.accounts.get(entry.accountId);
    const kind = account && app.connectors.get(account.connector)?.meta.oauth;
    if (!account || !kind) return page('账号不存在或不需要授权。');
    try {
      const { exchangeCode, storeTokens } = await import('../connectors/oauth.ts');
      const tokens = await exchangeCode(kind, {
        clientId: account.config.clientId ?? '',
        clientSecret: await app.secrets.resolve(account.secretRefs.clientSecret ?? ''),
        redirectUri: `http://127.0.0.1:${app.config.port}/oauth/callback`,
        code: q.code,
        codeVerifier: entry.verifier,
        fetch,
        now: app.clock.now(),
      });
      storeTokens(app.connectors.context(account), tokens);
      repos.accounts.update(account.id, { status: 'active', statusDetail: '', failures: 0 });
      app.ensurePolling();
      app.bus.emit({ type: 'account', accountId: account.id });
      return page('授权成功，可以关掉这个页面了。');
    } catch (err) {
      app.log.warn({ accountId: account.id, err: errMessage(err) }, 'oauth exchange failed');
      return page(`换取令牌失败：${errMessage(err).slice(0, 200)}`);
    }
  });

  // ---------------------------------------------------------------- simulations

  server.get('/api/sim', async () => repos.simRuns.list());

  server.get('/api/sim/:id', async (req) => {
    const { id } = Id.parse(req.params);
    const run = repos.simRuns.get(id);
    if (!run) throw notFound('模拟记录');
    const messages = run.conversationId ? repos.messages.byConversation(run.conversationId, 200) : [];
    return { run, messages };
  });

  server.post('/api/sim', async (req) => {
    const input = SimInput.parse(req.body);
    if (!repos.campaigns.get(input.campaignId)) throw notFound('任务');
    const run = repos.simRuns.create(input);
    app.queue.enqueue('sim_run', { runId: run.id }, { dedupeKey: `sim:${run.id}`, maxAttempts: 1 });
    return run;
  });
}
