import { parseJson, type Db } from '../db/index.ts';
import { errMessage, newId, type Clock, type Logger } from '../util.ts';

export type JobType = 'generate_reply' | 'send_message' | 'poll_account' | 'followup_scan' | 'summarize' | 'retention' | 'sim_run';

export interface Job<P = Record<string, unknown>> {
  id: string;
  type: JobType;
  payload: P;
  dedupeKey: string | null;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  runAt: number;
  attempts: number;
  maxAttempts: number;
  lastError: string;
}

/** Thrown by a handler to say "not now": the job is rescheduled without burning an attempt. */
export class RetryLater extends Error {
  runAt: number;
  constructor(runAt: number, reason: string) {
    super(reason);
    this.name = 'RetryLater';
    this.runAt = runAt;
  }
}

export interface EnqueueOptions {
  runAt?: number;
  dedupeKey?: string;
  maxAttempts?: number;
  /** When a pending job with the same key exists, move it to the new runAt (used for debouncing). */
  reschedule?: boolean;
}

export type JobHandler = (job: Job) => Promise<void>;

interface JobRowRaw extends Omit<Job, 'payload'> {
  payload: string;
}

const hydrate = (r: JobRowRaw): Job => ({ ...r, payload: parseJson<Record<string, unknown>>(r.payload, {}) });

// A SQLite-backed queue. Work survives a restart, and one process is the only consumer, so
// claiming is a plain UPDATE guarded by status rather than a lease protocol.
export class JobQueue {
  private db: Db;
  private clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  enqueue(type: JobType, payload: Record<string, unknown>, opts: EnqueueOptions = {}): void {
    const now = this.clock.now();
    const runAt = opts.runAt ?? now;
    this.db.tx(() => {
      if (opts.dedupeKey) {
        const existing = this.db.get<JobRowRaw>("SELECT * FROM jobs WHERE dedupeKey = ? AND status IN ('pending', 'running')", opts.dedupeKey);
        if (existing?.status === 'pending') {
          if (opts.reschedule) this.db.run('UPDATE jobs SET runAt = ?, payload = ?, updatedAt = ? WHERE id = ?', runAt, JSON.stringify(payload), now, existing.id);
          return;
        }
        if (existing?.status === 'running') {
          // The running job may already be past the point where it would notice new work.
          // Leave a marker; complete() turns it into a fresh pending run.
          const merged = { ...parseJson<Record<string, unknown>>(existing.payload, {}), __rerunAt: runAt, __rerunPayload: payload };
          this.db.run('UPDATE jobs SET payload = ?, updatedAt = ? WHERE id = ?', JSON.stringify(merged), now, existing.id);
          return;
        }
      }
      this.db.insert('jobs', { id: newId('job'), type, payload: JSON.stringify(payload), dedupeKey: opts.dedupeKey ?? null, status: 'pending', runAt, maxAttempts: opts.maxAttempts ?? 3, createdAt: now, updatedAt: now });
    });
  }

  claimDue(limit: number): Job[] {
    const now = this.clock.now();
    return this.db.tx(() => {
      const rows = this.db.all<JobRowRaw>("SELECT * FROM jobs WHERE status = 'pending' AND runAt <= ? ORDER BY runAt, rowid LIMIT ?", now, limit);
      for (const r of rows) this.db.run("UPDATE jobs SET status = 'running', lockedAt = ?, updatedAt = ? WHERE id = ?", now, now, r.id);
      return rows.map(hydrate);
    });
  }

  complete(id: string): void {
    const now = this.clock.now();
    this.db.tx(() => {
      const row = this.db.get<JobRowRaw>('SELECT * FROM jobs WHERE id = ?', id);
      if (!row) return;
      const payload = parseJson<Record<string, unknown>>(row.payload, {});
      if (typeof payload.__rerunAt === 'number') {
        const next = (payload.__rerunPayload as Record<string, unknown> | undefined) ?? {};
        this.db.run("UPDATE jobs SET status = 'pending', runAt = ?, payload = ?, attempts = 0, lockedAt = NULL, updatedAt = ? WHERE id = ?", payload.__rerunAt, JSON.stringify(next), now, id);
      } else {
        this.db.run("UPDATE jobs SET status = 'done', lockedAt = NULL, updatedAt = ? WHERE id = ?", now, id);
      }
    });
  }

  retryLater(id: string, runAt: number, reason: string): void {
    this.db.run("UPDATE jobs SET status = 'pending', runAt = ?, lastError = ?, lockedAt = NULL, updatedAt = ? WHERE id = ?", runAt, reason.slice(0, 500), this.clock.now(), id);
  }

  /** Returns true when the job will run again. */
  fail(job: Job, err: unknown): boolean {
    const now = this.clock.now();
    const attempts = job.attempts + 1;
    const message = errMessage(err).slice(0, 500);
    if (attempts < job.maxAttempts) {
      const backoff = Math.min(15 * 60_000, 30_000 * 2 ** (attempts - 1));
      this.db.run("UPDATE jobs SET status = 'pending', attempts = ?, runAt = ?, lastError = ?, lockedAt = NULL, updatedAt = ? WHERE id = ?", attempts, now + backoff, message, now, job.id);
      return true;
    }
    this.db.run("UPDATE jobs SET status = 'failed', attempts = ?, lastError = ?, lockedAt = NULL, updatedAt = ? WHERE id = ?", attempts, message, now, job.id);
    return false;
  }

  cancelByKey(dedupeKey: string): void {
    this.db.run("UPDATE jobs SET status = 'cancelled', updatedAt = ? WHERE dedupeKey = ? AND status = 'pending'", this.clock.now(), dedupeKey);
  }

  /** Jobs left in `running` by a crash. Returned so the caller can decide per type what is safe. */
  takeInterrupted(): Job[] {
    return this.db.all<JobRowRaw>("SELECT * FROM jobs WHERE status = 'running'").map(hydrate);
  }

  requeue(id: string): void {
    this.db.run("UPDATE jobs SET status = 'pending', lockedAt = NULL, updatedAt = ? WHERE id = ?", this.clock.now(), id);
  }

  abandon(id: string, reason: string): void {
    this.db.run("UPDATE jobs SET status = 'failed', lastError = ?, lockedAt = NULL, updatedAt = ? WHERE id = ?", reason, this.clock.now(), id);
  }

  prune(olderThan: number): void {
    this.db.run("DELETE FROM jobs WHERE status IN ('done', 'cancelled', 'failed') AND updatedAt < ?", olderThan);
  }

  pendingCount(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending', 'running')")?.n ?? 0;
  }
}

export class Worker {
  private queue: JobQueue;
  private handlers: Partial<Record<JobType, JobHandler>>;
  private log: Logger;
  private concurrency: number;
  private inFlight = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  /** Called when a job has used its last attempt. */
  onExhausted: (job: Job, err: unknown) => void = () => {};

  constructor(queue: JobQueue, handlers: Partial<Record<JobType, JobHandler>>, log: Logger, concurrency = 4) {
    this.queue = queue;
    this.handlers = handlers;
    this.log = log;
    this.concurrency = concurrency;
  }

  private async execute(job: Job): Promise<void> {
    const handler = this.handlers[job.type];
    if (!handler) {
      this.queue.abandon(job.id, `no handler for ${job.type}`);
      return;
    }
    try {
      await handler(job);
      this.queue.complete(job.id);
    } catch (err) {
      if (err instanceof RetryLater) {
        this.queue.retryLater(job.id, err.runAt, err.message);
        return;
      }
      this.log.warn({ job: job.type, id: job.id, err: errMessage(err) }, 'job failed');
      if (!this.queue.fail(job, err)) this.onExhausted(job, err);
    }
  }

  private tick(): void {
    if (this.stopping) return;
    const free = this.concurrency - this.inFlight.size;
    if (free <= 0) return;
    for (const job of this.queue.claimDue(free)) {
      const p = this.execute(job).finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    }
  }

  start(intervalMs = 500): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        this.log.error({ err: errMessage(err) }, 'worker tick failed');
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.inFlight]);
  }

  /** Test helper: run everything that is due right now, one job at a time, until nothing is due. */
  async drain(max = 200): Promise<number> {
    let ran = 0;
    while (ran < max) {
      const [job] = this.queue.claimDue(1);
      if (!job) break;
      await this.execute(job);
      ran++;
    }
    return ran;
  }
}
