import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import type { App } from '../app.ts';
import { isLoopback } from '../config.ts';
import { errMessage } from '../util.ts';
import { registerChatRoutes } from './chatRoutes.ts';
import { registerConfigRoutes } from './configRoutes.ts';

export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const notFound = (what: string) => new HttpError(404, `${what}不存在`);

const COOKIE = 'llmsocial_sid';

function readCookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function sessionCookie(token: string, maxAgeS: number, secure: boolean): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure ? '; Secure' : ''}`;
}

/**
 * DNS-rebinding defence. A hostile page can point its own domain at 127.0.0.1 and reach this server
 * "same-origin". Accepting only IP literals, localhost and explicitly allowed names shuts that door.
 */
function hostAllowed(hostHeader: string | undefined, extra: string[]): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return true;
  return extra.includes(host);
}

export function buildAdminServer(app: App): FastifyInstance {
  const server = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });
  const allowedHosts = (process.env.LLMSOCIAL_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!isLoopback(app.config.host)) allowedHosts.push(app.config.host.toLowerCase());

  server.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.status(400).send({ error: `${first?.path.join('.') || '请求'}：${first?.message ?? '格式不对'}` });
    }
    const status = typeof (err as { statusCode?: unknown }).statusCode === 'number' ? (err as { statusCode: number }).statusCode : 500;
    if (status >= 500) {
      app.log.error({ url: req.url.split('?')[0], err: errMessage(err) }, 'request failed');
      return reply.status(500).send({ error: '服务器内部错误，详情见日志' });
    }
    return reply.status(status).send({ error: errMessage(err) });
  });

  server.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (!hostAllowed(req.headers.host, allowedHosts)) throw new HttpError(421, 'Host 不在允许列表内（LLMSOCIAL_ALLOWED_HOSTS）');

    const url = req.url.split('?')[0]!;
    if (!url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // A custom header can't be set cross-origin without a CORS preflight, and we never answer one.
      if (req.headers['x-llmsocial'] !== '1') throw new HttpError(403, '缺少 X-LLMSocial 请求头');
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origin 不匹配');
    }
    if (url.startsWith('/api/auth/')) return;
    if (!app.auth.checkSession(readCookie(req, COOKIE))) throw new HttpError(401, '未登录');
  });

  // ---------------------------------------------------------------- auth

  const Password = z.object({ password: z.string().min(1).max(200) });

  server.get('/api/auth/state', async (req) => ({ setupRequired: !app.auth.isSetup(), authenticated: app.auth.checkSession(readCookie(req, COOKIE)) }));

  server.post('/api/auth/setup', async (req, reply) => {
    if (app.auth.isSetup()) throw new HttpError(409, '已经设置过密码');
    // First-run setup from another machine would let whoever gets there first own the install.
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip)) throw new HttpError(403, '首次设置密码只能在本机进行');
    const { password } = Password.parse(req.body);
    try {
      await app.auth.setPassword(password);
    } catch (err) {
      throw new HttpError(400, errMessage(err));
    }
    reply.header('Set-Cookie', sessionCookie(app.auth.createSession(), 7 * 86400, req.protocol === 'https'));
    return { ok: true };
  });

  server.post('/api/auth/login', async (req, reply) => {
    if (app.auth.throttled(req.ip)) throw new HttpError(429, '尝试次数过多，请 5 分钟后再试');
    const { password } = Password.parse(req.body);
    if (!(await app.auth.verify(password))) {
      app.auth.recordFailure(req.ip);
      throw new HttpError(401, '密码不对');
    }
    app.auth.clearFailures(req.ip);
    reply.header('Set-Cookie', sessionCookie(app.auth.createSession(), 7 * 86400, req.protocol === 'https'));
    return { ok: true };
  });

  server.post('/api/auth/logout', async (req, reply) => {
    app.auth.destroySession(readCookie(req, COOKIE));
    reply.header('Set-Cookie', sessionCookie('', 0, false));
    return { ok: true };
  });

  // ---------------------------------------------------------------- live updates

  server.get('/api/stream', (req: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write('retry: 3000\n\n');
    const unsubscribe = app.bus.subscribe((event) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`));
    req.raw.on('close', unsubscribe);
  });

  registerConfigRoutes(server, app);
  registerChatRoutes(server, app);

  // ---------------------------------------------------------------- web UI

  const indexHtml = path.join(app.config.webDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    server.register(fastifyStatic, { root: app.config.webDir, index: ['index.html'], wildcard: true });
    server.setNotFoundHandler((_req, reply) => {
      return reply.status(404).send({ error: 'not found' });
    });
  } else {
    server.get('/', async (_req, reply) => reply.type('text/plain; charset=utf-8').send('界面还没有构建。运行 npm run build，或者用 npm run dev 启动开发模式。'));
  }

  return server;
}
