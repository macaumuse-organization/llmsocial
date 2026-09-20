import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.ts';
import type { Logger } from '../util.ts';

// A secret is never stored in a config column. Columns hold a *reference*:
//   secret:<name>                 AES-256-GCM blob in the `secrets` table, key = master key
//   keychain:<service>[:<account>] macOS login keychain item, read at use time, never copied
//   env:<VAR>                     process environment

export type SecretRef =
  | { kind: 'secret'; name: string }
  | { kind: 'keychain'; service: string; account: string | null }
  | { kind: 'env'; name: string };

const SAFE_TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_.@+-]{0,127}$/;

export function parseSecretRef(ref: string): SecretRef | null {
  const trimmed = ref.trim();
  if (trimmed.startsWith('secret:')) {
    const name = trimmed.slice(7);
    return SAFE_TOKEN.test(name) ? { kind: 'secret', name } : null;
  }
  if (trimmed.startsWith('env:')) {
    const name = trimmed.slice(4);
    return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ? { kind: 'env', name } : null;
  }
  if (trimmed.startsWith('keychain:')) {
    const [service, account, ...rest] = trimmed.slice(9).split(':');
    if (rest.length > 0 || !service || !SAFE_TOKEN.test(service)) return null;
    if (account !== undefined && account !== '' && !SAFE_TOKEN.test(account)) return null;
    return { kind: 'keychain', service, account: account ? account : null };
  }
  return null;
}

/** True when the user typed a reference rather than a raw secret value. */
export function looksLikeRef(value: string): boolean {
  return /^(secret|env|keychain):/.test(value.trim());
}

export type KeychainReader = (service: string, account: string | null) => Promise<string | null>;

const SECURITY_BIN = '/usr/bin/security';

export const readKeychain: KeychainReader = (service, account) =>
  new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve(null);
    const args = ['find-generic-password', '-s', service];
    if (account) args.push('-a', account);
    args.push('-w');
    execFile(SECURITY_BIN, args, { timeout: 10_000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const value = stdout.replace(/\r?\n$/, '');
      resolve(value === '' ? null : value);
    });
  });

/** Writes through `security -i` so the value travels on stdin and never appears in argv. */
function writeKeychain(service: string, account: string, value: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin' || !/^[A-Za-z0-9+/=_-]+$/.test(value)) return resolve(false);
    const child = spawn(SECURITY_BIN, ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.end(`add-generic-password -U -s ${service} -a ${account} -w ${value}\n`);
  });
}

const MASTER_SERVICE = 'llmsocial.master-key';
const MASTER_ACCOUNT = 'llmsocial';

function decodeKey(text: string): Buffer | null {
  const buf = Buffer.from(text.trim(), 'base64');
  return buf.length === 32 ? buf : null;
}

/** env → macOS keychain → data/master.key (0600). Generates and persists a key on first run. */
export async function loadMasterKey(dataDir: string, log: Logger, env: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
  if (env.LLMSOCIAL_MASTER_KEY) {
    const key = decodeKey(env.LLMSOCIAL_MASTER_KEY);
    if (!key) throw new Error('LLMSOCIAL_MASTER_KEY must be 32 bytes, base64-encoded');
    return key;
  }
  const keyFile = path.join(dataDir, 'master.key');
  if (fs.existsSync(keyFile)) {
    const key = decodeKey(fs.readFileSync(keyFile, 'utf8'));
    if (!key) throw new Error(`${keyFile} is corrupt; restore it or delete it together with the stored secrets`);
    return key;
  }
  const fromKeychain = await readKeychain(MASTER_SERVICE, MASTER_ACCOUNT);
  if (fromKeychain) {
    const key = decodeKey(fromKeychain);
    if (key) return key;
  }
  const fresh = randomBytes(32);
  if (await writeKeychain(MASTER_SERVICE, MASTER_ACCOUNT, fresh.toString('base64'))) {
    log.info({ service: MASTER_SERVICE }, 'master key created in the macOS keychain');
    return fresh;
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, fresh.toString('base64'), { mode: 0o600 });
  log.warn({ keyFile }, 'keychain unavailable; master key written to a file. Back it up and keep it out of any repository');
  return fresh;
}

export class SecretStore {
  private db: Db;
  private key: Buffer;
  private keychain: KeychainReader;
  private env: NodeJS.ProcessEnv;
  private cache = new Map<string, { value: string | null; at: number }>();

  constructor(db: Db, masterKey: Buffer, opts: { keychain?: KeychainReader; env?: NodeJS.ProcessEnv } = {}) {
    if (masterKey.length !== 32) throw new Error('master key must be 32 bytes');
    this.db = db;
    this.key = masterKey;
    this.keychain = opts.keychain ?? readKeychain;
    this.env = opts.env ?? process.env;
  }

  put(name: string, value: string): string {
    if (!SAFE_TOKEN.test(name)) throw new Error('invalid secret name');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    // The name is bound in as associated data so a blob can't be swapped under another name.
    cipher.setAAD(Buffer.from(name, 'utf8'));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    this.db.run(
      'INSERT INTO secrets (name, iv, tag, data, updatedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, data = excluded.data, updatedAt = excluded.updatedAt',
      name,
      iv,
      cipher.getAuthTag(),
      data,
      Date.now(),
    );
    return `secret:${name}`;
  }

  get(name: string): string | null {
    const row = this.db.get<{ iv: Uint8Array; tag: Uint8Array; data: Uint8Array }>('SELECT iv, tag, data FROM secrets WHERE name = ?', name);
    if (!row) return null;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv));
    decipher.setAAD(Buffer.from(name, 'utf8'));
    decipher.setAuthTag(Buffer.from(row.tag));
    return Buffer.concat([decipher.update(Buffer.from(row.data)), decipher.final()]).toString('utf8');
  }

  delete(name: string): void {
    this.db.run('DELETE FROM secrets WHERE name = ?', name);
  }

  deleteByPrefix(prefix: string): void {
    this.db.run("DELETE FROM secrets WHERE name LIKE ? ESCAPE '\\'", `${prefix.replace(/[\\%_]/g, '\\$&')}%`);
  }

  /** Resolves a reference to its value. Returns null when unset; throws only on a malformed reference. */
  async resolve(ref: string): Promise<string | null> {
    if (!ref) return null;
    const parsed = parseSecretRef(ref);
    if (!parsed) throw new Error('malformed secret reference (expected secret:, keychain: or env:)');
    if (parsed.kind === 'secret') return this.get(parsed.name);
    if (parsed.kind === 'env') return this.env[parsed.name] || null;
    const cacheKey = `${parsed.service}:${parsed.account ?? ''}`;
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
    const value = await this.keychain(parsed.service, parsed.account);
    this.cache.set(cacheKey, { value, at: Date.now() });
    return value;
  }
}
