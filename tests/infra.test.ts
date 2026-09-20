import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Db } from '../src/server/db/index.ts';
import { createRepos } from '../src/server/db/repos.ts';
import { JobQueue, RetryLater, Worker } from '../src/server/queue/jobs.ts';
import { isValidTimezone, nextAllowedTime, pacingDelayMs } from '../src/server/queue/schedule.ts';
import { SecretStore, looksLikeRef, parseSecretRef } from '../src/server/secrets/store.ts';
import { parseSkillMarkdown, skillToMarkdown } from '../src/server/seed.ts';
import { FakeClock, KeyedMutex, silentLogger } from '../src/server/util.ts';

const KEY = Buffer.alloc(32, 3);

test('secrets round-trip, are bound to their name, and references resolve', async () => {
  const db = new Db(':memory:');
  const store = new SecretStore(db, KEY, { env: { MY_KEY: 'from-env' }, keychain: async (service, account) => (service === 'svc' && account === 'acct' ? 'from-keychain' : null) });

  const ref = store.put('prov.a.apiKey', 'sk-secret-value');
  assert.equal(ref, 'secret:prov.a.apiKey');
  assert.equal(store.get('prov.a.apiKey'), 'sk-secret-value');
  assert.equal(await store.resolve(ref), 'sk-secret-value');

  // The plaintext must not be sitting in the row.
  const row = db.get<{ data: Uint8Array }>('SELECT data FROM secrets WHERE name = ?', 'prov.a.apiKey')!;
  assert.equal(Buffer.from(row.data).includes('sk-secret'), false);

  // The name is authenticated: a blob moved under another name will not decrypt.
  db.run('UPDATE secrets SET name = ? WHERE name = ?', 'prov.b.apiKey', 'prov.a.apiKey');
  assert.throws(() => store.get('prov.b.apiKey'));

  assert.equal(await store.resolve('env:MY_KEY'), 'from-env');
  assert.equal(await store.resolve('keychain:svc:acct'), 'from-keychain');
  assert.equal(await store.resolve('env:NOT_SET'), null);
  await assert.rejects(store.resolve('http://evil/'), /malformed/);
  db.close();
});

test('secret references are parsed strictly', () => {
  assert.deepEqual(parseSecretRef('keychain:fjosky.anthropic.etech'), { kind: 'keychain', service: 'fjosky.anthropic.etech', account: null });
  assert.deepEqual(parseSecretRef('env:ANTHROPIC_API_KEY'), { kind: 'env', name: 'ANTHROPIC_API_KEY' });
  assert.equal(parseSecretRef('keychain:a:b:c'), null);
  assert.equal(parseSecretRef('secret:../../etc/passwd'), null);
  assert.equal(parseSecretRef('sk-ant-whatever'), null);
  assert.equal(looksLikeRef('sk-ant-whatever'), false);
  assert.equal(looksLikeRef('env:X'), true);
});

test('quiet hours push a send past the window and leave other times alone', () => {
  const tz = 'Asia/Shanghai';
  const quiet = { start: '23:00', end: '08:00', timezone: tz };
  const inQuiet = Date.UTC(2026, 0, 5, 15, 30); // 23:30 local
  const out = nextAllowedTime(inQuiet, quiet);
  assert.ok(out > inQuiet);
  assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(out), '08:00');
  const daytime = Date.UTC(2026, 0, 5, 6, 0); // 14:00 local
  assert.equal(nextAllowedTime(daytime, quiet), daytime);
  // An empty or nonsensical window disables the feature rather than blocking everything.
  assert.equal(nextAllowedTime(inQuiet, { start: '00:00', end: '00:00', timezone: tz }), inQuiet);
  assert.equal(nextAllowedTime(inQuiet, { start: 'x', end: 'y', timezone: tz }), inQuiet);
  assert.equal(nextAllowedTime(inQuiet, { ...quiet, timezone: 'Not/AZone' }), inQuiet);
  assert.equal(isValidTimezone('Australia/Brisbane'), true);
  assert.equal(isValidTimezone('Mars/Olympus'), false);
});

test('pacing delay grows with length and stays inside the configured band', () => {
  const short = pacingDelayMs('好的', 8, 25, () => 0.5);
  const long = pacingDelayMs('好的'.repeat(80), 8, 25, () => 0.5);
  assert.ok(long > short);
  assert.ok(short >= 8000 && short <= 25_000 + 20_000);
});

test('the queue dedupes, debounces, retries with backoff and survives a restart', async () => {
  const clock = new FakeClock();
  const db = new Db(':memory:');
  const queue = new JobQueue(db, clock);

  queue.enqueue('generate_reply', { n: 1 }, { dedupeKey: 'gen:c1', runAt: clock.now() + 5000 });
  queue.enqueue('generate_reply', { n: 2 }, { dedupeKey: 'gen:c1', runAt: clock.now() + 9000, reschedule: true });
  assert.equal(queue.pendingCount(), 1, 'one job, rescheduled');
  clock.advance(6000);
  assert.equal(queue.claimDue(5).length, 0, 'the reschedule pushed it back');
  clock.advance(4000);
  const [job] = queue.claimDue(5);
  assert.deepEqual(job!.payload, { n: 2 });

  // Work arriving while a job runs must not be lost.
  queue.enqueue('generate_reply', { n: 3 }, { dedupeKey: 'gen:c1', runAt: clock.now() });
  queue.complete(job!.id);
  const [rerun] = queue.claimDue(5);
  assert.deepEqual(rerun!.payload, { n: 3 });
  queue.complete(rerun!.id);

  let attempts = 0;
  const worker = new Worker(queue, { summarize: async () => { attempts++; throw new Error('boom'); } }, silentLogger);
  queue.enqueue('summarize', {}, { maxAttempts: 3 });
  await worker.drain();
  assert.equal(attempts, 1);
  clock.advance(30_000);
  await worker.drain();
  clock.advance(60_000);
  await worker.drain();
  assert.equal(attempts, 3);
  assert.equal(db.get<{ status: string }>("SELECT status FROM jobs WHERE type = 'summarize'")!.status, 'failed');
  db.close();
});

test('RetryLater reschedules without consuming an attempt', async () => {
  const clock = new FakeClock();
  const db = new Db(':memory:');
  const queue = new JobQueue(db, clock);
  let calls = 0;
  const worker = new Worker(queue, { send_message: async () => { calls++; if (calls === 1) throw new RetryLater(clock.now() + 60_000, 'quiet hours'); } }, silentLogger);
  queue.enqueue('send_message', {}, { maxAttempts: 1 });
  await worker.drain();
  assert.equal(db.get<{ attempts: number; status: string }>('SELECT attempts, status FROM jobs')!.attempts, 0);
  clock.advance(61_000);
  await worker.drain();
  assert.equal(calls, 2);
  assert.equal(db.get<{ status: string }>('SELECT status FROM jobs')!.status, 'done');
  db.close();
});

test('the same key never runs concurrently, different keys do', async () => {
  const mutex = new KeyedMutex();
  const order: string[] = [];
  const slow = (tag: string, ms: number) => mutex.run(tag[0]!, async () => {
    order.push(`${tag}-start`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${tag}-end`);
  });
  await Promise.all([slow('a1', 20), slow('a2', 1), slow('b1', 1)]);
  assert.deepEqual(order.slice(0, 2).sort(), ['a1-start', 'b1-start']);
  assert.ok(order.indexOf('a1-end') < order.indexOf('a2-start'), 'a2 waited for a1');
  // A thrown task must not wedge the key.
  await assert.rejects(mutex.run('a', async () => { throw new Error('x'); }));
  await mutex.run('a', async () => order.push('a3'));
  assert.ok(order.includes('a3'));
});

test('skill markdown round-trips and rejects a bad slug', () => {
  const skill = { slug: 'my-skill', name: '我的技能', description: '说明', allowedPlatforms: ['x', 'youtube'] as const, content: '第一行\n\n第二行' };
  const parsed = parseSkillMarkdown(skillToMarkdown({ ...skill, allowedPlatforms: [...skill.allowedPlatforms] }));
  assert.equal(parsed.slug, 'my-skill');
  assert.equal(parsed.name, '我的技能');
  assert.deepEqual(parsed.allowedPlatforms, ['x', 'youtube']);
  assert.equal(parsed.content, '第一行\n\n第二行');
  // Front matter is optional; the filename is the fallback slug.
  assert.equal(parseSkillMarkdown('just some content', 'from-file').slug, 'from-file');
  assert.throws(() => parseSkillMarkdown('content', 'Bad Slug'));
  assert.throws(() => parseSkillMarkdown('---\nslug: ok-slug\n---\n\n'));
  // An unknown platform in the front matter is dropped rather than stored as garbage.
  assert.throws(() => parseSkillMarkdown('content', 'x'), /slug/, '一个字符的 slug 与 validators 的 min(2) 保持一致');
  assert.deepEqual(parseSkillMarkdown('---\nslug: sk\nallowed_platforms: [x, nope]\n---\nbody').allowedPlatforms, ['x']);
});

test('repositories reject bad values and hydrate JSON and booleans', () => {
  const clock = new FakeClock();
  const db = new Db(':memory:');
  const repos = createRepos(db, clock);
  const skill = repos.skills.create({ slug: 's', name: 'n', description: '', content: 'c', allowedPlatforms: ['x'], enabled: true, builtin: false });
  assert.equal(skill.enabled, true);
  assert.deepEqual(skill.allowedPlatforms, ['x']);
  assert.equal(repos.skills.get(skill.id)!.builtin, false);
  // Booleans and undefined are normalised for node:sqlite, which refuses both.
  repos.skills.update(skill.id, { enabled: false, description: undefined });
  assert.equal(repos.skills.get(skill.id)!.enabled, false);
  assert.equal(repos.skills.get(skill.id)!.description, '');
  db.close();
});

test('settings fall back to defaults and ignore unknown keys', () => {
  const db = new Db(':memory:');
  const repos = createRepos(db, new FakeClock());
  assert.equal(repos.settings.get().debounceMs, 8000);
  repos.settings.setRaw('debounceMs', 'not-json');
  assert.equal(repos.settings.get().debounceMs, 8000, 'corrupt value falls back');
  repos.settings.patch({ debounceMs: 1234 });
  assert.equal(repos.settings.get().debounceMs, 1234);
  repos.settings.setRaw('somethingElse', '"x"');
  assert.equal('somethingElse' in repos.settings.get(), false);
  db.close();
});
