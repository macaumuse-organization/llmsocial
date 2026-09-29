import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { buildAdminServer } from '../src/server/api/server.ts';
import { APP_VERSION } from '../src/server/config.ts';
import { BACKUP_NAME, BackupExistsError, checkForUpdate, compareVersions, createBackup, listBackups, masterKeyInfo } from '../src/server/maintenance.ts';
import type { BackupFile, MaintenanceInfo, UpdateInfo } from '../src/shared/types.ts';
import { harness, testConfig } from './helpers.ts';

const made: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsocial-maint-'));
  made.push(dir);
  return dir;
}
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(testConfig().dataDir, 'backups'), { recursive: true, force: true });
});

function fileDb(dir: string): DatabaseSync {
  const db = new DatabaseSync(path.join(dir, 'llmsocial.db'));
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT); INSERT INTO notes (text) VALUES ('你好'), ('world');");
  return db;
}

test('备份：WAL 数据库拍成一个完整的快照，列表只认自己生成的文件', () => {
  const dir = tempDir();
  const db = fileDb(dir);
  const first = createBackup(db, dir, new Date(Date.UTC(2026, 8, 29, 1, 2, 3, 4)));
  const second = createBackup(db, dir, new Date(Date.UTC(2026, 8, 29, 1, 2, 4, 0)));
  db.close();
  fs.writeFileSync(path.join(dir, 'backups', 'notes.txt'), 'not a backup');

  assert.equal(first.name, 'llmsocial-2026-09-29T01-02-03-004Z.db');
  assert.match(first.name, BACKUP_NAME);
  assert.deepEqual(listBackups(dir).map((b) => b.name), [second.name, first.name]);

  const copy = new DatabaseSync(path.join(dir, 'backups', first.name), { readOnly: true });
  assert.deepEqual(copy.prepare('SELECT text FROM notes ORDER BY id').all().map((r) => r.text), ['你好', 'world']);
  copy.close();
});

test('备份：同一毫秒点两下不覆盖，报「刚刚已经备份过」', () => {
  const dir = tempDir();
  const db = fileDb(dir);
  const at = new Date(Date.UTC(2026, 8, 29, 1, 2, 3, 4));
  createBackup(db, dir, at);
  assert.throws(() => createBackup(db, dir, at), BackupExistsError);
  db.close();
});

test('备份文件名：拒绝路径和别的名字', () => {
  assert.ok(BACKUP_NAME.test('llmsocial-2026-09-29T01-02-03-004Z.db'));
  for (const bad of ['../llmsocial.db', 'llmsocial.db', 'llmsocial-2026-09-29T01-02-03-004Z.db/../../master.key', 'master.key']) assert.equal(BACKUP_NAME.test(bad), false, bad);
});

test('主密钥位置：环境变量 > 数据目录里的文件 > macOS 钥匙串', () => {
  const dir = tempDir();
  assert.deepEqual(masterKeyInfo(dir, { LLMSOCIAL_MASTER_KEY: 'x' }, 'win32'), { kind: 'env', path: null });
  assert.deepEqual(masterKeyInfo(dir, {}, 'win32'), { kind: 'missing', path: null });
  assert.deepEqual(masterKeyInfo(dir, {}, 'darwin'), { kind: 'keychain', path: null });
  fs.writeFileSync(path.join(dir, 'master.key'), 'k');
  assert.deepEqual(masterKeyInfo(dir, {}, 'darwin'), { kind: 'file', path: path.join(dir, 'master.key') });
});

test('版本比较：按数字比，不按字符串比', () => {
  assert.equal(compareVersions('v0.10.0', '0.9.3'), 1);
  assert.equal(compareVersions('0.1.0', 'v0.1.0'), 0);
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('v1.2.0-beta', '1.1.9'), 1);
});

function github(status: number, body: unknown = {}): typeof fetch {
  return (async (url: string | URL | Request) => {
    assert.equal(String(url), 'https://api.github.com/repos/example/llmsocial/releases/latest');
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

test('检查更新：有新版、已是最新、还没发过版、被限流', async () => {
  const newer = await checkForUpdate('example/llmsocial', '0.1.0', github(200, { tag_name: 'v0.2.0', html_url: 'https://github.com/example/llmsocial/releases/tag/v0.2.0', published_at: '2026-10-01T00:00:00Z' }));
  assert.equal(newer.newer, true);
  assert.equal(newer.latest, 'v0.2.0');
  assert.equal(newer.url, 'https://github.com/example/llmsocial/releases/tag/v0.2.0');

  const same = await checkForUpdate('example/llmsocial', '0.1.0', github(200, { tag_name: 'v0.1.0' }));
  assert.equal(same.newer, false);
  assert.match(same.detail, /已经是最新/);

  const none = await checkForUpdate('example/llmsocial', '0.1.0', github(404, { message: 'Not Found' }));
  assert.equal(none.latest, null);
  assert.match(none.detail, /还没有发布过/);

  const limited = await checkForUpdate('example/llmsocial', '0.1.0', github(403));
  assert.match(limited.detail, /频繁/);
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

test('接口：备份、下载、打开数据目录、检查更新，都要先登录', async () => {
  const opened: string[] = [];
  let fetchFails = false;
  const fakeFetch = (async () => {
    if (fetchFails) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ENOTFOUND' }) });
    return new Response(JSON.stringify({ tag_name: 'v9.9.9', html_url: 'https://github.com/example/llmsocial/releases/tag/v9.9.9' }), { status: 200 });
  }) as unknown as typeof fetch;
  const h = harness({ fetch: fakeFetch, openFolder: async (dir) => void opened.push(dir) });
  const server = buildAdminServer(h.app);
  const c = client(server);

  assert.equal((await c.call('GET', '/api/maintenance')).statusCode, 401, 'not logged in yet');
  assert.equal((await c.call('POST', '/api/auth/setup', { password: 'a-long-enough-password' })).statusCode, 200);

  const meta = JSON.parse((await c.call('GET', '/api/meta')).payload) as { version: string };
  assert.equal(meta.version, APP_VERSION);

  const before = JSON.parse((await c.call('GET', '/api/maintenance')).payload) as MaintenanceInfo;
  assert.equal(before.version, APP_VERSION);
  assert.equal(before.dataDir, testConfig().dataDir);
  assert.equal(before.canOpenFolder, true);
  assert.equal(before.portable, false);

  const created = await c.call('POST', '/api/backups');
  assert.equal(created.statusCode, 200, created.payload);
  const backup = JSON.parse(created.payload) as BackupFile;
  assert.equal((await c.call('POST', '/api/backups')).statusCode, 409, 'same clock tick = double click');

  const listed = JSON.parse((await c.call('GET', '/api/maintenance')).payload) as MaintenanceInfo;
  assert.ok(listed.backups.some((b) => b.name === backup.name));

  const download = await c.call('GET', `/api/backups/${backup.name}`);
  assert.equal(download.statusCode, 200);
  assert.match(String(download.headers['content-disposition']), /^attachment; filename="llmsocial-.*\.db"$/);
  assert.equal(download.rawPayload.subarray(0, 16).toString('latin1'), 'SQLite format 3\0');
  const copyPath = path.join(tempDir(), 'copy.db');
  fs.writeFileSync(copyPath, download.rawPayload);
  const copy = new DatabaseSync(copyPath, { readOnly: true });
  assert.ok(copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").get(), 'the snapshot is the real schema');
  copy.close();

  assert.equal((await c.call('GET', '/api/backups/..%2F..%2Fmaster.key')).statusCode, 400);
  assert.equal((await c.call('GET', '/api/backups/llmsocial-2000-01-01T00-00-00-000Z.db')).statusCode, 404);

  assert.equal((await c.call('POST', '/api/data/open')).statusCode, 200);
  assert.deepEqual(opened, [testConfig().dataDir]);

  const update = JSON.parse((await c.call('GET', '/api/update')).payload) as UpdateInfo;
  assert.equal(update.newer, true);
  assert.equal(update.latest, 'v9.9.9');

  fetchFails = true;
  const offline = await c.call('GET', '/api/update');
  assert.equal(offline.statusCode, 200);
  assert.match((JSON.parse(offline.payload) as UpdateInfo).detail, /^查不到：/);

  await server.close();
  await h.app.stop();
});
