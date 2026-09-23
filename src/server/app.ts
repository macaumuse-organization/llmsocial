import { Pipeline } from './agent/pipeline.ts';
import { Simulator } from './agent/simulator.ts';
import { Auth } from './auth/index.ts';
import { Bus } from './bus.ts';
import type { Config } from './config.ts';
import { sandboxConnector, manualConnector, webhookConnector } from './connectors/local.ts';
import { ConnectorRegistry } from './connectors/registry.ts';
import { ConnectorError, type Connector } from './connectors/types.ts';
import { Db } from './db/index.ts';
import { createRepos, type Repos } from './db/repos.ts';
import { LlmRouter } from './llm/router.ts';
import type { LlmClientFactory } from './llm/types.ts';
import { Ocr } from './ocr/index.ts';
import { JobQueue, Worker, type Job } from './queue/jobs.ts';
import { SecretStore, type KeychainReader } from './secrets/store.ts';
import { seed } from './seed.ts';
import { DAY, HOUR, MINUTE, errMessage, systemClock, type Clock, type Logger } from './util.ts';

export interface AppOptions {
  config: Config;
  masterKey: Buffer;
  log: Logger;
  clock?: Clock;
  llmFactory?: LlmClientFactory;
  fetch?: typeof fetch;
  keychain?: KeychainReader;
  extraConnectors?: Connector[];
  rand?: () => number;
}

export interface App {
  config: Config;
  db: Db;
  repos: Repos;
  secrets: SecretStore;
  router: LlmRouter;
  connectors: ConnectorRegistry;
  queue: JobQueue;
  worker: Worker;
  pipeline: Pipeline;
  simulator: Simulator;
  auth: Auth;
  bus: Bus;
  ocr: Ocr;
  clock: Clock;
  log: Logger;
  ensurePolling(): void;
  start(): void;
  stop(): Promise<void>;
}

export function createApp(opts: AppOptions): App {
  const { config, log } = opts;
  const clock = opts.clock ?? systemClock;
  const db = new Db(config.dbPath);
  const repos = createRepos(db, clock);
  const secrets = new SecretStore(db, opts.masterKey, { keychain: opts.keychain });
  const bus = new Bus();
  const queue = new JobQueue(db, clock);
  const router = new LlmRouter({ db, repos, secrets, clock, log, factory: opts.llmFactory });
  const connectors = new ConnectorRegistry({ repos, secrets, clock, log, fetch: opts.fetch });
  for (const c of [sandboxConnector, manualConnector, webhookConnector, ...(opts.extraConnectors ?? [])]) connectors.register(c);
  const pipeline = new Pipeline({ db, repos, router, connectors, queue, bus, clock, log, rand: opts.rand });
  const simulator = new Simulator({ repos, router, pipeline, bus, clock });
  const auth = new Auth(db, repos, clock);
  const ocr = new Ocr(config.dataDir, log);

  seed(repos, config.skillsDir);

  async function pollAccount(job: Job): Promise<void> {
    const accountId = (job.payload as { accountId: string }).accountId;
    const manual = job.payload.manual === true;
    const account = repos.accounts.get(accountId);
    const connector = account && connectors.get(account.connector);
    if (!account || !connector?.poll || account.status === 'paused' || account.status === 'needs_auth' || (!manual && account.pollIntervalS <= 0)) return;
    const now = clock.now();
    let nextIn = account.pollIntervalS * 1000;
    try {
      const messages = await connector.poll(connectors.context(account));
      // Oldest first, so a burst lands in the thread in the order it was written.
      for (const m of messages.sort((a, b) => a.timestamp - b.timestamp)) pipeline.ingest(account.id, m);
      repos.accounts.update(account.id, { lastPolledAt: now, failures: 0, ...(account.status === 'error' ? { status: 'active' as const, statusDetail: '' } : {}) });
    } catch (err) {
      const e = err instanceof ConnectorError ? err : new ConnectorError('transient', errMessage(err));
      const failures = account.failures + 1;
      if (e.code === 'auth') {
        repos.accounts.update(account.id, { status: 'needs_auth', statusDetail: e.message.slice(0, 200), failures });
        repos.events.add('account_needs_auth', { error: e.message.slice(0, 200) }, { accountId: account.id, level: 'error' });
        bus.emit({ type: 'account', accountId: account.id });
        return;
      }
      // Back off instead of hammering a platform that is already unhappy with us.
      nextIn = Math.min(HOUR, Math.max(e.retryAfterMs ?? 0, nextIn * 2 ** Math.min(failures, 6)));
      repos.accounts.update(account.id, { failures, lastPolledAt: now, ...(failures >= 5 ? { status: 'error' as const, statusDetail: `${e.code}: ${e.message}`.slice(0, 200) } : {}) });
      if (failures === 5) repos.events.add('account_poll_failing', { code: e.code, error: e.message.slice(0, 200) }, { accountId: account.id, level: 'error' });
    }
    bus.emit({ type: 'account', accountId: account.id });
    if (account.pollIntervalS > 0) queue.enqueue('poll_account', { accountId: account.id }, { runAt: clock.now() + nextIn, dedupeKey: `poll:${account.id}` });
  }

  /**
   * Same shape as pollAccount, on its own schedule: lead endpoints are metered far more tightly
   * than message ones, and turning message polling off should not silently stop lead collection.
   */
  async function pollSignals(job: Job): Promise<void> {
    const accountId = (job.payload as { accountId: string }).accountId;
    const manual = job.payload.manual === true;
    const account = repos.accounts.get(accountId);
    const connector = account && connectors.get(account.connector);
    if (!account || !connector?.pollSignals || account.status === 'paused' || account.status === 'needs_auth' || (!manual && account.signalIntervalS <= 0)) return;
    let nextIn = account.signalIntervalS * 1000;
    try {
      const signals = await connector.pollSignals(connectors.context(account));
      for (const signal of signals) pipeline.ingestSignal(account.id, signal);
    } catch (err) {
      const e = err instanceof ConnectorError ? err : new ConnectorError('transient', errMessage(err));
      if (e.code === 'auth') {
        repos.accounts.update(account.id, { status: 'needs_auth', statusDetail: e.message.slice(0, 200) });
        repos.events.add('account_needs_auth', { error: e.message.slice(0, 200), source: 'signals' }, { accountId: account.id, level: 'error' });
        bus.emit({ type: 'account', accountId: account.id });
        return;
      }
      // Leads are not urgent; back off quietly rather than marking the whole account broken.
      nextIn = Math.min(6 * HOUR, Math.max(e.retryAfterMs ?? 0, nextIn * 2));
      repos.events.add('signal_poll_failed', { code: e.code, error: e.message.slice(0, 200) }, { accountId: account.id, level: 'warn' });
    }
    if (account.signalIntervalS > 0) queue.enqueue('poll_signals', { accountId: account.id }, { runAt: clock.now() + nextIn, dedupeKey: `sigpoll:${account.id}` });
  }

  const worker = new Worker(
    queue,
    {
      generate_reply: (job) => pipeline.handleGenerateJob(job),
      send_message: (job) => pipeline.handleSendJob(job),
      poll_account: pollAccount,
      poll_signals: pollSignals,
      summarize: (job) => pipeline.summarize((job.payload as { conversationId: string }).conversationId),
      sim_run: (job) => simulator.run((job.payload as { runId: string }).runId),
    },
    log,
  );

  function ensurePolling(): void {
    for (const account of repos.accounts.list()) {
      const live = account.status === 'active' || account.status === 'error';
      if (live && account.pollIntervalS > 0 && connectors.get(account.connector)?.poll) {
        queue.enqueue('poll_account', { accountId: account.id }, { dedupeKey: `poll:${account.id}` });
      }
      // A different dedupe prefix: ux_jobs_dedupe is global, so `poll:<id>` would swallow one of the two.
      if (live && account.signalIntervalS > 0 && connectors.get(account.connector)?.pollSignals) {
        queue.enqueue('poll_signals', { accountId: account.id }, { dedupeKey: `sigpoll:${account.id}` });
      }
    }
  }

  function retention(): void {
    const days = repos.settings.get().retentionDays;
    const now = clock.now();
    queue.prune(now - 3 * DAY);
    db.run('DELETE FROM auth_sessions WHERE expiresAt < ?', now);
    if (days > 0) {
      // Prompts and raw model output hold the most personal text in the system; they go first.
      db.run('DELETE FROM llm_calls WHERE createdAt < ?', now - days * DAY);
      db.run('DELETE FROM events WHERE ts < ?', now - days * DAY);
      db.run("DELETE FROM conversations WHERE state IN ('closed', 'opted_out') AND COALESCE(lastMessageAt, createdAt) < ?", now - days * DAY);
    }
  }

  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => void) => {
    const t = setInterval(() => {
      try {
        fn();
      } catch (err) {
        log.error({ err: errMessage(err) }, 'maintenance task failed');
      }
    }, ms);
    t.unref();
    timers.push(t);
  };

  return {
    config,
    db,
    repos,
    secrets,
    router,
    connectors,
    queue,
    worker,
    pipeline,
    simulator,
    auth,
    bus,
    ocr,
    clock,
    log,
    ensurePolling,
    start() {
      pipeline.recoverInterrupted();
      ensurePolling();
      retention();
      worker.start();
      every(MINUTE, ensurePolling);
      every(10 * MINUTE, () => pipeline.scanFollowups());
      every(6 * HOUR, retention);
      every(25_000, () => bus.emit({ type: 'ping' }));
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      await worker.stop();
      db.close();
    },
  };
}
