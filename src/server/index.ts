import { createApp } from './app.ts';
import { isLoopback, loadConfig } from './config.ts';
import { REAL_CONNECTORS } from './connectors/index.ts';
import { createLogger } from './logger.ts';
import { buildAdminServer } from './api/server.ts';
import { buildWebhookServer } from './webhooks/server.ts';
import { describeProxy } from './proxy.ts';
import { loadMasterKey } from './secrets/store.ts';
import { errMessage } from './util.ts';

/**
 * A port somebody else holds (or one Windows has reserved, which shows up as EACCES) is the most
 * common way a first start fails; say so in words instead of a stack trace in the black window.
 */
async function listen(server: { listen(opts: { host: string; port: number }): Promise<unknown> }, host: string, port: number, envName: string): Promise<void> {
  try {
    await server.listen({ host, port });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err;
    const why = code === 'EADDRINUSE' ? '被别的程序占着（也可能是已经开着一个 llmsocial）' : '被 Windows 保留了或者没有权限';
    process.stderr.write(`\n端口 ${port} 用不了：${why}。在 .env（免安装版是 app\\.env）里写一行 ${envName}=${port + 10} 换个端口，再启动。\n`);
    process.exit(1);
  }
}

const config = loadConfig();
const log = createLogger(config.logLevel);

const masterKey = await loadMasterKey(config.dataDir, log);
const app = createApp({ config, masterKey, log, extraConnectors: REAL_CONNECTORS });

const admin = buildAdminServer(app);
const webhooks = buildWebhookServer(app);

app.start();

await listen(admin, config.host, config.port, 'LLMSOCIAL_PORT');
const needsWebhooks = app.connectors.metas().some((m) => m.usesWebhook);
if (needsWebhooks) await listen(webhooks, config.webhookHost, config.webhookPort, 'LLMSOCIAL_WEBHOOK_PORT');

const url = `http://${isLoopback(config.host) ? '127.0.0.1' : config.host}:${config.port}`;
process.stdout.write(`\nllmsocial 已启动\n  管理界面 ${url}${app.auth.isSetup() ? '' : '   ← 第一次打开需要在本机设置密码'}\n`);
if (needsWebhooks) process.stdout.write(`  平台回调 端口 ${config.webhookPort}${config.publicWebhookUrl ? `（对外 ${config.publicWebhookUrl}）` : '（需要隧道才能被平台访问）'}\n`);
if (!isLoopback(config.host)) process.stdout.write('  ⚠️  管理界面没有绑定在回环地址上，请确认前面有 TLS 和访问控制\n');
const outbound = app.repos.settings.get();
const shownProxy = describeProxy(outbound);
// Where traffic goes, never a username or password that may sit in the proxy URL.
process.stdout.write(shownProxy ? `  对外请求 经代理 ${shownProxy}（直连：${outbound.noProxy || '无'}）——在「设置」页可以随时关掉\n` : '  对外请求 直连（要走代理去「设置」页打开）\n');
process.stdout.write('\n');

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    void (async () => {
      try {
        await Promise.all([admin.close(), needsWebhooks ? webhooks.close() : Promise.resolve()]);
        await app.stop();
      } catch (err) {
        log.error({ err: errMessage(err) }, 'shutdown failed');
      }
      process.exit(0);
    })();
  });
}

process.on('unhandledRejection', (reason) => log.error({ err: errMessage(reason) }, 'unhandled rejection'));
