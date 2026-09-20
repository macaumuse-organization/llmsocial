import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.ts';
import type { Repos } from '../db/repos.ts';
import { DAY, type Clock } from '../util.ts';

const SESSION_TTL = 7 * DAY;
const KEY = 'adminPasswordHash';

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password.normalize('NFKC'), salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key))));
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export class Auth {
  private db: Db;
  private repos: Repos;
  private clock: Clock;
  private failures = new Map<string, { count: number; resetAt: number }>();

  constructor(db: Db, repos: Repos, clock: Clock) {
    this.db = db;
    this.repos = repos;
    this.clock = clock;
  }

  isSetup(): boolean {
    return this.repos.settings.getRaw(KEY) !== null;
  }

  async setPassword(password: string): Promise<void> {
    if (password.length < 10) throw new Error('密码至少 10 个字符');
    const salt = randomBytes(16);
    const hash = await derive(password, salt);
    this.repos.settings.setRaw(KEY, `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`);
    this.db.run('DELETE FROM auth_sessions');
  }

  async verify(password: string): Promise<boolean> {
    const stored = this.repos.settings.getRaw(KEY);
    if (!stored) return false;
    const [, salt, hash] = stored.split('$');
    if (!salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = await derive(password, Buffer.from(salt, 'base64'));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** Five wrong passwords from one address locks it out for five minutes. */
  throttled(ip: string): boolean {
    const f = this.failures.get(ip);
    return f !== undefined && f.resetAt > this.clock.now() && f.count >= 5;
  }

  recordFailure(ip: string): void {
    const now = this.clock.now();
    const f = this.failures.get(ip);
    if (!f || f.resetAt <= now) this.failures.set(ip, { count: 1, resetAt: now + 5 * 60_000 });
    else f.count++;
  }

  clearFailures(ip: string): void {
    this.failures.delete(ip);
  }

  createSession(): string {
    const token = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    // Only a hash is stored: a copy of the database can't be replayed as a login.
    this.db.run('INSERT INTO auth_sessions (tokenHash, createdAt, expiresAt) VALUES (?, ?, ?)', sha256(token), now, now + SESSION_TTL);
    this.db.run('DELETE FROM auth_sessions WHERE expiresAt < ?', now);
    return token;
  }

  checkSession(token: string | undefined): boolean {
    if (!token) return false;
    return this.db.get('SELECT 1 AS x FROM auth_sessions WHERE tokenHash = ? AND expiresAt > ?', sha256(token), this.clock.now()) !== undefined;
  }

  destroySession(token: string | undefined): void {
    if (token) this.db.run('DELETE FROM auth_sessions WHERE tokenHash = ?', sha256(token));
  }
}
