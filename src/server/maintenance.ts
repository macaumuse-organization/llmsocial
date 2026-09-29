import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BackupFile, MasterKeyInfo, UpdateInfo } from '../shared/types.ts';

/**
 * Backups, where the master key lives, and "is there a newer release" — the chores a person running the
 * Windows 免安装版 cannot do from a terminal. Nothing in here sends a secret to the browser: backups
 * carry platform keys only in encrypted form, and the master key is described, never served.
 */

/** Two backups in the same millisecond: a double click, not a disk problem. */
export class BackupExistsError extends Error {}

export const BACKUP_NAME = /^llmsocial-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;

export function backupDir(dataDir: string): string {
  return path.join(dataDir, 'backups');
}

/**
 * VACUUM INTO writes a consistent snapshot even while the server keeps writing; a plain copy of a WAL
 * database can be torn. Refuses to overwrite: two backups in the same millisecond are a double click.
 */
export function createBackup(db: DatabaseSync, dataDir: string, now: Date): BackupFile {
  const dir = backupDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `llmsocial-${now.toISOString().replace(/[:.]/g, '-')}.db`;
  const target = path.join(dir, name);
  if (fs.existsSync(target)) throw new BackupExistsError('刚刚已经备份过一份，等一秒再点');
  db.prepare('VACUUM INTO ?').run(target);
  fs.chmodSync(target, 0o600);
  const stat = fs.statSync(target);
  return { name, size: stat.size, createdAt: stat.mtimeMs };
}

/** Newest first. Only files this code wrote: anything else in the folder is somebody else's business. */
export function listBackups(dataDir: string): BackupFile[] {
  const dir = backupDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => BACKUP_NAME.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, createdAt: stat.mtimeMs };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Mirrors loadMasterKey's order (env → data/master.key → macOS keychain) without touching the key. */
export function masterKeyInfo(dataDir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): MasterKeyInfo {
  if (env.LLMSOCIAL_MASTER_KEY) return { kind: 'env', path: null };
  const file = path.join(dataDir, 'master.key');
  if (fs.existsSync(file)) return { kind: 'file', path: file };
  if (platform === 'darwin') return { kind: 'keychain', path: null };
  return { kind: 'missing', path: null };
}

/** "0.10.0" > "0.9.3"; a leading v and any -suffix are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/i, '').split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Asks GitHub for the latest published release. Only ever called when the person clicks 检查更新:
 * llmsocial does not phone home by itself. Network failures are thrown for the caller to explain in
 * terms of the proxy switch.
 */
export async function checkForUpdate(repo: string, current: string, fetchFn: typeof fetch): Promise<UpdateInfo> {
  const page = `https://github.com/${repo}/releases`;
  const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `llmsocial/${current}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) {
    return { current, latest: null, newer: false, url: page, publishedAt: null, detail: '还没有发布过正式版本（或者发布用的仓库不是公开的），没什么可更新的。' };
  }
  if (res.status === 403 || res.status === 429) {
    return { current, latest: null, newer: false, url: page, publishedAt: null, detail: 'GitHub 说查得太频繁了，过一会儿再点。' };
  }
  if (!res.ok) return { current, latest: null, newer: false, url: page, publishedAt: null, detail: `GitHub 返回 ${res.status}，过一会儿再试。` };
  const body = (await res.json()) as { tag_name?: string; html_url?: string; published_at?: string };
  const latest = typeof body.tag_name === 'string' ? body.tag_name : null;
  if (!latest) return { current, latest: null, newer: false, url: page, publishedAt: null, detail: 'GitHub 的回应里没有版本号。' };
  const newer = compareVersions(latest, current) > 0;
  return {
    current,
    latest,
    newer,
    url: typeof body.html_url === 'string' ? body.html_url : page,
    publishedAt: typeof body.published_at === 'string' ? body.published_at : null,
    detail: newer ? `有新版本 ${latest}。` : `已经是最新（${current}）。`,
  };
}

/** Opens a folder in the file manager of the machine llmsocial runs on. */
export function openFolder(dir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const [cmd, args] = platform === 'win32' ? ['explorer.exe', [dir]] : platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]];
  return new Promise((resolve, reject) => {
    // explorer.exe exits with 1 even when it opened the window, so only a failure to start counts.
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
