import Fastify, { type FastifyInstance } from 'fastify';
import type { App } from '../app.ts';
import type { WebhookRequest } from '../connectors/types.ts';
import { errMessage } from '../util.ts';

/**
 * Platform callbacks live on their own port. Only this port ever needs to be reachable from the
 * internet (through a tunnel); the admin UI stays on loopback. Nothing here is authenticated by
 * session — each connector verifies the platform's own signature over the raw body.
 */
export function buildWebhookServer(app: App): FastifyInstance {
  const server = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: true });

  // Signatures are computed over the exact bytes; parsing first would destroy them. The built-in
  // application/json and text/plain parsers have to go too: a catch-all only applies when no specific
  // parser matches, so without this every JSON callback (Instagram, the self-hosted bridge) arrived
  // as a parsed object, rawBody came through empty, and every signature check failed.
  server.removeAllContentTypeParsers();
  server.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  server.get('/healthz', async () => ({ ok: true }));

  const handle = async (method: 'GET' | 'POST', accountId: string, req: { query: unknown; headers: Record<string, unknown>; body?: unknown }) => {
    const account = app.repos.accounts.get(accountId);
    const connector = account && app.connectors.get(account.connector);
    if (!account || !connector?.handleWebhook) return { status: 404, body: 'unknown webhook', contentType: 'text/plain' };

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries((req.query ?? {}) as Record<string, unknown>)) if (typeof v === 'string') query[k] = v;
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const webhookRequest: WebhookRequest = { method, query, headers, rawBody };

    try {
      const { response, messages, signals } = await connector.handleWebhook(app.connectors.context(account), webhookRequest);
      // Proof the platform can reach us and the credentials match: shown on the account card, so an
      // operator setting up a callback URL can see the moment it starts working.
      if (response.status < 400) app.repos.accounts.update(account.id, { lastWebhookAt: app.clock.now() });
      for (const message of messages.sort((a, b) => a.timestamp - b.timestamp)) app.pipeline.ingest(account.id, message);
      for (const signal of signals ?? []) app.pipeline.ingestSignal(account.id, signal);
      if (messages.length > 0) app.bus.emit({ type: 'account', accountId: account.id });
      return { ...response, contentType: response.contentType ?? 'text/plain' };
    } catch (err) {
      // Never echo the error to the caller: a signature-check failure should look the same as any other.
      app.log.warn({ accountId, err: errMessage(err) }, 'webhook handler failed');
      app.repos.events.add('webhook_failed', { error: errMessage(err).slice(0, 300) }, { accountId, level: 'error' });
      return { status: 500, body: 'error', contentType: 'text/plain' };
    }
  };

  for (const method of ['get', 'post'] as const) {
    server[method]<{ Params: { accountId: string } }>('/webhooks/:accountId', async (req, reply) => {
      const out = await handle(method.toUpperCase() as 'GET' | 'POST', req.params.accountId, req);
      return reply.status(out.status).type(out.contentType).send(out.body);
    });
  }

  return server;
}
