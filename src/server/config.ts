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
  /**
   * Where the webhook port listens. 0.0.0.0 by default so a bridge on another machine can post in; the
   * Windows 免安装版 launcher sets 127.0.0.1, which keeps Windows Firewall from asking about node.exe
   * (a tunnel on this machine and the WeChat bridge both connect over loopback anyway).
   */
  webhookHost: string;
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
  /** owner/name of the GitHub repository whose published releases 检查更新 compares against. */
  releasesRepo: string;
  /** Running from the Windows 免安装版: node\node.exe and VERSION.txt sit next to the app folder. */
  portable: boolean;
}

function readVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** From package.json, so a release is numbered in exactly one place. */
export const APP_VERSION = readVersion();

/** Where 检查更新 looks. A fork points LLMSOCIAL_RELEASES_REPO at its own repository. */
export const RELEASES_REPO = 'macaumuse-organization/llmsocial';

/**
 * The bridge release this llmsocial installs. Pinned, not "latest": a newer bridge may change the
 * --status --json / --configure contract, so bumping it is a deliberate change here plus a run of the
 * install test, never something that happens to an old install by itself.
 */
export const WECHAT_BRIDGE_RELEASE = 'v0.1.0';
export const DEFAULT_WECHAT_BRIDGE_URL = `https://github.com/HeLanGouSheng/wechatbridge-win/releases/download/${WECHAT_BRIDGE_RELEASE}/WeChatBridge-win-x64.zip`;

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const envFile = path.join(PROJECT_ROOT, '.env');
  if (env === process.env && fs.existsSync(envFile)) process.loadEnvFile(envFile);
  // `||`, not `??`: an empty line in .env must mean the default, not the project root (data dir) or every interface (host).
  const dataDir = path.resolve(PROJECT_ROOT, env.LLMSOCIAL_DATA_DIR || 'data');
  return {
    host: env.LLMSOCIAL_HOST || '127.0.0.1',
    port: int(env.LLMSOCIAL_PORT, 8787),
    webhookPort: int(env.LLMSOCIAL_WEBHOOK_PORT, 8788),
    webhookHost: env.LLMSOCIAL_WEBHOOK_HOST || '0.0.0.0',
    publicWebhookUrl: (env.LLMSOCIAL_PUBLIC_WEBHOOK_URL ?? '').replace(/\/+$/, ''),
    dataDir,
    dbPath: path.join(dataDir, 'llmsocial.db'),
    webDir: path.join(PROJECT_ROOT, 'dist/web'),
    skillsDir: path.join(PROJECT_ROOT, 'skills'),
    logLevel: env.LOG_LEVEL ?? 'info',
    wechatBridgeDir: env.LLMSOCIAL_WECHAT_BRIDGE_DIR || path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'WeChatBridge'),
    wechatBridgeUrl: env.LLMSOCIAL_WECHAT_BRIDGE_URL || DEFAULT_WECHAT_BRIDGE_URL,
    releasesRepo: env.LLMSOCIAL_RELEASES_REPO || RELEASES_REPO,
    portable: fs.existsSync(path.join(PROJECT_ROOT, '..', 'node', 'node.exe')) && fs.existsSync(path.join(PROJECT_ROOT, '..', 'VERSION.txt')),
  };
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
