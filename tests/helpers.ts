import os from 'node:os';
import path from 'node:path';
import { createApp, type App, type AppOptions } from '../src/server/app.ts';
import { PROJECT_ROOT, type Config } from '../src/server/config.ts';
import type { InboundMessage } from '../src/server/connectors/types.ts';
import { SANDBOX_ACCOUNT_ID } from '../src/server/agent/simulator.ts';
import { FakeClock, silentLogger } from '../src/server/util.ts';
import type { Campaign, Provider } from '../src/shared/types.ts';

export function testConfig(): Config {
  const dataDir = path.join(os.tmpdir(), `llmsocial-test-${process.pid}`);
  return { host: '127.0.0.1', port: 0, webhookPort: 0, publicWebhookUrl: '', dataDir, dbPath: ':memory:', webDir: path.join(PROJECT_ROOT, 'dist/web'), skillsDir: path.join(PROJECT_ROOT, 'skills'), logLevel: 'silent' };
}

export interface Harness {
  app: App;
  clock: FakeClock;
  /** Move time forward, then run every job that has become due. */
  tick(ms?: number): Promise<number>;
  /** Let multi-bubble sends finish: consecutive sends on one account are spaced a few seconds apart. */
  settle(): Promise<void>;
  inbound(text: string, over?: Partial<InboundMessage>, accountId?: string): string;
  campaign(over?: Partial<Campaign>): Campaign;
  provider(model: string, over?: Partial<Provider>): Provider;
}

let seq = 0;

export function harness(opts: Partial<AppOptions> = {}): Harness {
  const clock = new FakeClock();
  const app = createApp({ config: testConfig(), masterKey: Buffer.alloc(32, 7), log: silentLogger, clock, rand: () => 0.5, ...opts });
  return {
    app,
    clock,
    async tick(ms = 0) {
      clock.advance(ms);
      return app.worker.drain();
    },
    async settle() {
      for (let i = 0; i < 4; i++) {
        clock.advance(4000);
        await app.worker.drain();
      }
    },
    inbound(text, over = {}, accountId = SANDBOX_ACCOUNT_ID) {
      const stored = app.pipeline.ingest(accountId, { platformMsgId: `m${++seq}`, kind: 'dm', threadRef: 'u1', contact: { platformUserId: 'u1', displayName: '测试用户' }, text, timestamp: clock.now(), ...over });
      return stored?.conversationId ?? '';
    },
    campaign(over = {}) {
      const base = app.repos.campaigns.get('camp_default')!;
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = base;
      return app.repos.campaigns.create({ ...rest, name: `test-${++seq}`, ...over });
    },
    provider(model, over = {}) {
      return app.repos.providers.create({ name: model, kind: 'mock', baseUrl: '', model, apiKeyRef: '', temperature: null, maxTokens: 1000, effort: null, jsonMode: true, timeoutMs: 5000, priceIn: null, priceOut: null, dailyTokenLimit: null, enabled: true, priority: 10, ...over });
    },
  };
}

export const SANDBOX = SANDBOX_ACCOUNT_ID;
