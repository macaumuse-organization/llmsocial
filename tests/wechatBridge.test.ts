import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildAdminServer } from '../src/server/api/server.ts';
import { BRIDGE_EXE, WechatBridge, type RunResult } from '../src/server/bridge/wechatBridge.ts';
import { silentLogger } from '../src/server/util.ts';
import type { WechatBridgeStatus } from '../src/shared/types.ts';
import { harness } from './helpers.ts';

const SECRET = 'bridge-shared-secret-at-least-24-chars';
const BASE = 'http://127.0.0.1:8788';
const ZIP = Buffer.from('not really a zip, the fake extractor does not care');
const ZIP_SHA = createHash('sha256').update(ZIP).digest('hex');

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llmsocial-bridge-'));
}

/** A stand-in for WeChatBridge.exe: remembers every call and answers --status --json from `state`. */
function fakeBridge(dir: string, over: { shaText?: string; zipStatus?: number; state?: Record<string, unknown>; registerOk?: boolean } = {}) {
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  const state: Record<string, unknown> = { version: '0.1.0', registered: false, externalLocationMatches: false, registeredUpToDate: false, settings: null, ...over.state };
  const run = async (exe: string, args: string[], opts: { env?: Record<string, string> }): Promise<RunResult> => {
    calls.push({ args, env: opts.env });
    assert.equal(exe, path.join(dir, BRIDGE_EXE));
    if (args[0] === '--status') return { ok: true, code: 0, stdout: `\n${JSON.stringify(state)}\n`, stderr: '' };
    if (args[0] === '--configure') {
      const acct = args[args.indexOf('--account-id') + 1];
      const base = args[args.indexOf('--base-url') + 1];
      state.settings = { configured: true, baseUrl: base, accountId: acct, autoDeliver: args.includes('on') };
      return { ok: true, code: 0, stdout: '已保存\n', stderr: '' };
    }
    if (args[0] === '--register') {
      if (over.registerOk === false) return { ok: false, code: 1, stdout: '管理员确认被取消了。\n', stderr: '' };
      Object.assign(state, { registered: true, externalLocationMatches: true, registeredUpToDate: true });
      return { ok: true, code: 0, stdout: '已注册：ChatBridgeWin_0.1.0.0_x64__abc\n', stderr: '' };
    }
    return { ok: false, code: 2, stdout: '', stderr: `unexpected ${args[0]}` };
  };
  const fetched: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    fetched.push(url);
    if (url.endsWith('.sha256')) return new Response(over.shaText ?? `${ZIP_SHA}  WeChatBridge-win-x64.zip\n`, { status: 200 });
    return new Response(over.zipStatus && over.zipStatus !== 200 ? 'nope' : ZIP, { status: over.zipStatus ?? 200 });
  }) as typeof fetch;
  const extracted: string[] = [];
  const extract = async (zip: string, target: string) => {
    extracted.push(zip);
    assert.ok(fs.existsSync(zip), 'the archive must exist when extraction runs');
    fs.writeFileSync(path.join(target, BRIDGE_EXE), 'exe');
  };
  const bridge = new WechatBridge({ installDir: dir, downloadUrl: 'http://127.0.0.1:9/WeChatBridge-win-x64.zip', webhookBaseUrl: BASE, log: silentLogger, fetch: fetchFn, run, extract, platform: 'win32' });
  return { bridge, calls, fetched, extracted, state };
}

test('不是 Windows 就明说，装不了', async () => {
  const dir = tempDir();
  const bridge = new WechatBridge({ installDir: dir, downloadUrl: 'http://x/y.zip', webhookBaseUrl: BASE, log: silentLogger, platform: 'darwin' });
  const status = await bridge.status('acct_1');
  assert.equal(status.supported, false);
  assert.match(status.detail, /Windows/);
  await assert.rejects(bridge.install('acct_1', SECRET), /Windows/);
});

test('从零安装：下载、校验、解压、写设置（密钥走环境变量）、注册', async () => {
  const dir = tempDir();
  const { bridge, calls, fetched, extracted } = fakeBridge(dir);
  assert.equal((await bridge.status('acct_1')).installed, false);

  const result = await bridge.install('acct_1', SECRET);

  assert.deepEqual(fetched, ['http://127.0.0.1:9/WeChatBridge-win-x64.zip', 'http://127.0.0.1:9/WeChatBridge-win-x64.zip.sha256']);
  assert.equal(extracted.length, 1);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.zip')).length, 0, 'the downloaded archive is removed afterwards');

  const configure = calls.find((c) => c.args[0] === '--configure')!;
  assert.ok(configure, 'configure ran');
  assert.ok(!configure.args.includes(SECRET), 'the secret is not on the command line');
  assert.equal(configure.env?.CHATBRIDGE_SECRET, SECRET);
  assert.deepEqual(configure.args, ['--configure', '--base-url', BASE, '--account-id', 'acct_1', '--auto', 'on', '--quiet']);
  assert.ok(calls.some((c) => c.args[0] === '--register'), 'register ran because nothing was registered');

  assert.equal(result.status.ready, true);
  assert.equal(result.status.configured, true);
  assert.equal(result.status.registered, true);
  assert.match(result.status.detail, /就绪/);
  assert.ok(result.log.some((l) => l.includes('校验通过')));
});

test('校验值对不上就不装、不写设置，并删掉下载', async () => {
  const dir = tempDir();
  const { bridge, calls } = fakeBridge(dir, { shaText: `${'0'.repeat(64)}  WeChatBridge-win-x64.zip\n` });
  await assert.rejects(bridge.install('acct_1', SECRET), /校验值对不上/);
  assert.equal(calls.length, 0);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('下载失败时说清楚是哪个地址', async () => {
  const dir = tempDir();
  const { bridge } = fakeBridge(dir, { zipStatus: 404 });
  await assert.rejects(bridge.install('acct_1', SECRET), /HTTP 404/);
});

test('已装好、已注册、连着别的账号：只改设置，不下载不注册', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, BRIDGE_EXE), 'exe');
  const { bridge, calls, fetched, state } = fakeBridge(dir, {
    state: { registered: true, externalLocationMatches: true, registeredUpToDate: true, settings: { configured: true, baseUrl: BASE, accountId: 'acct_other', autoDeliver: true } },
  });
  const before = await bridge.status('acct_1');
  assert.equal(before.installed, true);
  assert.equal(before.registered, true);
  assert.equal(before.configured, false);
  assert.match(before.detail, /另一个账号/);
  calls.length = 0;

  const result = await bridge.install('acct_1', SECRET);
  assert.equal(fetched.length, 0);
  assert.deepEqual(calls.map((c) => c.args[0]), ['--configure', '--status', '--status']);
  assert.equal((state.settings as { accountId: string }).accountId, 'acct_1');
  assert.equal(result.status.ready, true);
});

test('注册的是旧版本或别的目录时要求重新注册', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, BRIDGE_EXE), 'exe');
  const { bridge, calls } = fakeBridge(dir, { state: { registered: true, externalLocationMatches: false, registeredUpToDate: false } });
  const status = await bridge.status('acct_1');
  assert.equal(status.registered, false);
  assert.match(status.detail, /另一个目录/);
  await bridge.install('acct_1', SECRET);
  assert.ok(calls.some((c) => c.args[0] === '--register'));
});

test('管理员确认被取消：报注册失败，附上聊天桥的原话', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, BRIDGE_EXE), 'exe');
  const { bridge } = fakeBridge(dir, { registerOk: false });
  await assert.rejects(bridge.install('acct_1', SECRET), /注册失败：管理员确认被取消了/);
});

test('连的是别的 llmsocial 地址时提示改过来', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, BRIDGE_EXE), 'exe');
  const { bridge } = fakeBridge(dir, { state: { registered: true, externalLocationMatches: true, registeredUpToDate: true, settings: { configured: true, baseUrl: 'http://127.0.0.1:8798', accountId: 'acct_1', autoDeliver: false } } });
  const status = await bridge.status('acct_1');
  assert.equal(status.configured, false);
  assert.match(status.detail, /8798/);
});

// ---------------------------------------------------------------- routes

const HOST = '127.0.0.1:7788';

function client(server: FastifyInstance) {
  let cookie = '';
  return {
    async call(method: string, url: string, payload?: unknown) {
      const res = await server.inject({ method: method as 'GET', url, payload: payload as object | undefined, headers: { host: HOST, 'x-llmsocial': '1', ...(cookie ? { cookie } : {}) } });
      const set = res.headers['set-cookie'];
      if (typeof set === 'string') cookie = set.split(';')[0]!;
      return res;
    },
  };
}

async function loggedIn(bridge: WechatBridge) {
  const h = harness({ wechatBridge: bridge });
  const server = buildAdminServer(h.app);
  const c = client(server);
  const setup = await c.call('POST', '/api/auth/setup', { password: 'a-long-enough-password' });
  assert.equal(setup.statusCode, 200, setup.payload);
  return { h, server, c };
}

test('接口：只有微信 + 通用 Webhook 的账号有聊天桥；没密钥不能装；装完返回状态', async () => {
  const dir = tempDir();
  const { bridge } = fakeBridge(dir);
  const { h, server, c } = await loggedIn(bridge);

  const meta = await c.call('GET', '/api/meta');
  assert.equal(JSON.parse(meta.payload).wechatBridgeSupported, true);

  const manual = await c.call('POST', '/api/accounts', { name: '手动微信', platform: 'wechat', connector: 'manual' });
  assert.equal(manual.statusCode, 200, manual.payload);
  const wrong = await c.call('GET', `/api/accounts/${JSON.parse(manual.payload).id}/bridge`);
  assert.equal(wrong.statusCode, 400);

  const created = await c.call('POST', '/api/accounts', { name: '微信·聊天桥', platform: 'wechat', connector: 'webhook' });
  assert.equal(created.statusCode, 200, created.payload);
  const id = JSON.parse(created.payload).id as string;

  const status = await c.call('GET', `/api/accounts/${id}/bridge`);
  assert.equal(status.statusCode, 200);
  assert.equal((JSON.parse(status.payload) as WechatBridgeStatus).installed, false);

  const noSecret = await c.call('POST', `/api/accounts/${id}/bridge/install`, {});
  assert.equal(noSecret.statusCode, 400);
  assert.match(JSON.parse(noSecret.payload).error, /共享密钥/);

  const patched = await c.call('PATCH', `/api/accounts/${id}`, { secrets: { sharedSecret: SECRET } });
  assert.equal(patched.statusCode, 200, patched.payload);
  const installed = await c.call('POST', `/api/accounts/${id}/bridge/install`, {});
  assert.equal(installed.statusCode, 200, installed.payload);
  const body = JSON.parse(installed.payload) as { log: string[]; status: WechatBridgeStatus };
  assert.equal(body.status.ready, true);
  assert.ok(body.log.length > 0);

  const missing = await c.call('GET', '/api/accounts/acct_nope/bridge');
  assert.equal(missing.statusCode, 404);
  await server.close();
  await h.app.stop();
});

test('发布包也可以是本地路径：复制、校验、解压，不联网', async () => {
  const src = tempDir();
  const archive = path.join(src, 'WeChatBridge-win-x64.zip');
  fs.writeFileSync(archive, ZIP);
  fs.writeFileSync(`${archive}.sha256`, `${ZIP_SHA}  WeChatBridge-win-x64.zip\n`);
  const dir = tempDir();
  const { fetched, extracted, calls } = fakeBridge(dir);
  const bridge = new WechatBridge({
    installDir: dir,
    downloadUrl: archive,
    webhookBaseUrl: BASE,
    log: silentLogger,
    fetch: (async () => {
      throw new Error('must not fetch');
    }) as unknown as typeof fetch,
    run: async (exe, args, opts) => {
      calls.push({ args, env: opts.env });
      if (args[0] === '--status') return { ok: true, code: 0, stdout: '{"registered":true,"externalLocationMatches":true,"registeredUpToDate":true,"settings":{"configured":true,"baseUrl":"http://127.0.0.1:8788","accountId":"acct_1"}}', stderr: '' };
      return { ok: true, code: 0, stdout: '', stderr: '' };
    },
    extract: async (zip, target) => {
      extracted.push(zip);
      fs.writeFileSync(path.join(target, BRIDGE_EXE), 'exe');
    },
    platform: 'win32',
  });
  const result = await bridge.install('acct_1', SECRET);
  assert.equal(fetched.length, 0);
  assert.equal(extracted.length, 1);
  assert.equal(result.status.ready, true);
  assert.ok(result.log.some((l) => l.includes('从本地复制')));

  fs.writeFileSync(`${archive}.sha256`, `${'1'.repeat(64)}  x\n`);
  await assert.rejects(bridge.install('acct_1', SECRET, { force: true }), /校验值对不上/);
});
