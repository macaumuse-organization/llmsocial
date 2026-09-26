import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
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
  /** Where the Windows WeChat bridge is (or gets) installed; registration binds to this path. */
  wechatBridgeDir: string;
  /** The bridge release archive, with a .sha256 sidecar next to it. */
  wechatBridgeUrl: string;
}

export const DEFAULT_WECHAT_BRIDGE_URL = 'https://github.com/HeLanGouSheng/wechatbridge-win/releases/latest/download/WeChatBridge-win-x64.zip';

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
    wechatBridgeDir: env.LLMSOCIAL_WECHAT_BRIDGE_DIR || path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'WeChatBridge'),
    wechatBridgeUrl: env.LLMSOCIAL_WECHAT_BRIDGE_URL || DEFAULT_WECHAT_BRIDGE_URL,
  };
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
