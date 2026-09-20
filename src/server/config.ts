import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '../..');

export interface Config {
  host: string;
  port: number;
  webhookPort: number;
  publicWebhookUrl: string;
  dataDir: string;
  dbPath: string;
  webDir: string;
  skillsDir: string;
  logLevel: string;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const envFile = path.join(PROJECT_ROOT, '.env');
  if (env === process.env && fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const dataDir = path.resolve(PROJECT_ROOT, env.LLMSOCIAL_DATA_DIR ?? 'data');
  return {
    host: env.LLMSOCIAL_HOST ?? '127.0.0.1',
    port: int(env.LLMSOCIAL_PORT, 8787),
    webhookPort: int(env.LLMSOCIAL_WEBHOOK_PORT, 8788),
    publicWebhookUrl: (env.LLMSOCIAL_PUBLIC_WEBHOOK_URL ?? '').replace(/\/+$/, ''),
    dataDir,
    dbPath: path.join(dataDir, 'llmsocial.db'),
    webDir: path.join(PROJECT_ROOT, 'dist/web'),
    skillsDir: path.join(PROJECT_ROOT, 'skills'),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
