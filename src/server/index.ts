import { createApp } from './app.ts';
import { isLoopback, loadConfig } from './config.ts';
import { REAL_CONNECTORS } from './connectors/index.ts';
import { createLogger } from './logger.ts';
import { buildAdminServer } from './api/server.ts';
import { buildWebhookServer } from './webhooks/server.ts';
import { loadMasterKey } from './secrets/store.ts';
import { errMessage } from './util.ts';

const config = loadConfig();
const log = createLogger(config.logLevel);

const masterKey = await loadMasterKey(config.dataDir, log);
const app = createApp({ config, masterKey, log, extraConnectors: REAL_CONNECTORS });

const admin = buildAdminServer(app);
const webhooks = buildWebhookServer(app);

app.start();

await admin.listen({ host: config.host, port: config.port });
const needsWebhooks = app.connectors.metas().some((m) => m.usesWebhook);
if (needsWebhooks) await webhooks.listen({ host: '0.0.0.0', port: config.webhookPort });

const url = `http://${isLoopback(config.host) ? '127.0.0.1' : config.host}:${config.port}`;
process.stdout.write(`\nllmsocial 已启动\n  管理界面 ${url}${app.auth.isSetup() ? '' : '   ← 第一次打开需要在本机设置密码'}\n`);
if (needsWebhooks) process.stdout.write(`  平台回调 端口 ${config.webhookPort}${config.publicWebhookUrl ? `（对外 ${config.publicWebhookUrl}）` : '（需要隧道才能被平台访问）'}\n`);
if (!isLoopback(config.host)) process.stdout.write('  ⚠️  管理界面没有绑定在回环地址上，请确认前面有 TLS 和访问控制\n');
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
