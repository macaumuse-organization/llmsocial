import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { WechatBridgeInstallResult, WechatBridgeStatus } from '../../shared/types.ts';
import { errMessage, type Logger } from '../util.ts';

export const BRIDGE_EXE = 'WeChatBridge.exe';

/** What `WeChatBridge.exe --status --json` prints. Only the fields this side reads. */
interface RawStatus {
  version?: string | null;
  registered?: boolean;
  externalLocationMatches?: boolean;
  registeredUpToDate?: boolean;
  certificateTrusted?: boolean | null;
  settings?: { configured?: boolean; baseUrl?: string; accountId?: string; autoDeliver?: boolean } | null;
  settingsError?: string | null;
}

export interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export type RunFn = (exe: string, args: string[], opts: { env?: Record<string, string>; timeout: number }) => Promise<RunResult>;
export type ExtractFn = (zip: string, dir: string) => Promise<void>;

export interface WechatBridgeOptions {
  /** Where the bridge lives (or will be unpacked). Registration binds to this path, so it must not move. */
  installDir: string;
  /** The release archive; its SHA-256 sidecar is expected at the same URL + ".sha256". */
  downloadUrl: string;
  /** What the bridge should post to: this machine's webhook port, never the public tunnel address. */
  webhookBaseUrl: string;
  log: Logger;
  fetch?: typeof fetch;
  run?: RunFn;
  extract?: ExtractFn;
  platform?: NodeJS.Platform;
}

function defaultRun(exe: string, args: string[], opts: { env?: Record<string, string>; timeout: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    // The bridge is a GUI exe that writes to the pipe it inherits; windowsHide keeps a console from flashing.
    execFile(exe, args, { timeout: opts.timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...opts.env } }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === 'number' ? err.code : -1;
      resolve({ ok: err === null, code, stdout: String(stdout), stderr: String(stderr).slice(0, 500) });
    });
  });
}

/** Windows 10 1803+ ships bsdtar in System32, which reads zip. Git's GNU tar (often first on PATH) does not. */
function defaultExtract(run: RunFn): ExtractFn {
  return async (zip, dir) => {
    const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    const out = await run(tar, ['-xf', zip, '-C', dir], { timeout: 5 * 60_000 });
    if (!out.ok) throw new Error(`解压失败：${lastLine(out) || `tar 退出码 ${out.code}`}`);
  };
}

function lastLine(out: RunResult): string {
  const lines = `${out.stdout}\n${out.stderr}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

function outputLines(out: RunResult): string[] {
  return out.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

/** A path or file:// URL means "install from this archive on disk"; anything else is fetched. */
export function localArchivePath(urlOrPath: string): string | null {
  if (/^https?:\/\//i.test(urlOrPath)) return null;
  if (/^file:\/\//i.test(urlOrPath)) {
    try {
      return fileURLToPath(urlOrPath);
    } catch {
      return null;
    }
  }
  return path.isAbsolute(urlOrPath) ? urlOrPath : null;
}

function sameBase(a: string, b: string): boolean {
  return a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();
}

export const STEP_WECHAT = '微信里多选消息 → 转发 → 转发到其他应用 → 选择电脑中的应用 → 聊天桥';

/**
 * Installs and wires up the Windows bridge that turns WeChat's "转发到其他应用" into messages for this
 * account. Everything goes through the bridge's own command line: llmsocial downloads and unpacks the
 * release, then asks the exe to write its settings (the secret travels in the environment, not in the
 * arguments) and to register itself as a share target. Nothing here touches WeChat.
 */
export class WechatBridge {
  private installDir: string;
  private downloadUrl: string;
  private webhookBaseUrl: string;
  private log: Logger;
  private fetchFn: typeof fetch;
  private run: RunFn;
  private extract: ExtractFn;
  private platform: NodeJS.Platform;
  private busy = false;

  constructor(opts: WechatBridgeOptions) {
    this.installDir = opts.installDir;
    this.downloadUrl = opts.downloadUrl;
    this.webhookBaseUrl = opts.webhookBaseUrl;
    this.log = opts.log;
    // Bound late so the proxy switch (which swaps undici's global dispatcher) applies to the download too.
    this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.run = opts.run ?? defaultRun;
    this.extract = opts.extract ?? defaultExtract(this.run);
    this.platform = opts.platform ?? process.platform;
  }

  supported(): boolean {
    return this.platform === 'win32';
  }

  get exePath(): string {
    return path.join(this.installDir, BRIDGE_EXE);
  }

  installed(): boolean {
    return fs.existsSync(this.exePath);
  }

  async status(accountId: string): Promise<WechatBridgeStatus> {
    const base = { supported: this.supported(), installDir: this.installDir, version: '', registered: false, configured: false, autoDeliver: false, ready: false };
    if (!this.supported()) {
      return { ...base, installed: false, detail: '聊天桥只有 Windows 版：微信 Windows 版的「转发到其他应用」才有这条路。这台机器上这个账号只能按通用 Webhook 自己接。' };
    }
    if (!this.installed()) {
      return { ...base, installed: false, detail: '还没安装。点「安装聊天桥」：下载约 100 MB，第一次会弹一次管理员确认（把它的证书放进「受信任人」）。' };
    }
    let raw: RawStatus;
    try {
      raw = await this.rawStatus();
    } catch (err) {
      return { ...base, installed: true, detail: `聊天桥在 ${this.installDir}，但读不出它的状态：${errMessage(err)}。点「重新安装」。` };
    }
    const registered = raw.registeredUpToDate === true;
    const settings = raw.settings ?? null;
    const configured = settings?.configured === true && settings.accountId === accountId && sameBase(settings.baseUrl ?? '', this.webhookBaseUrl);
    const autoDeliver = settings?.autoDeliver === true;
    const version = raw.version ?? '';
    const ready = registered && configured;
    let detail: string;
    if (ready) {
      detail = `就绪：${STEP_WECHAT}，这段记录就进这个账号的收件箱。${autoDeliver ? '' : '它现在设置成先弹窗确认；要一键直达，在聊天桥的设置里勾「直接发送」。'}`;
    } else if (raw.settingsError) {
      detail = `聊天桥的设置文件有问题：${raw.settingsError}`;
    } else if (!registered && raw.registered) {
      detail = raw.externalLocationMatches ? '已安装，但注册到微信菜单的还是旧版本。点「重新安装」更新注册。' : '已安装，但微信菜单里注册的是另一个目录里的旧程序。点「重新安装」改过来。';
    } else if (!registered) {
      detail = '已安装，但还没注册到微信菜单。点「注册到微信菜单」（第一次会弹一次管理员确认）。';
    } else if (settings?.configured && settings.accountId !== accountId) {
      detail = `已安装并注册，但它现在连的是另一个账号（${settings.accountId}）。一台电脑上的聊天桥同时只能连一个账号；点「连到这个账号」就换过来。`;
    } else if (settings?.configured) {
      detail = `已安装并注册，但它连的是 ${settings.baseUrl}，不是这个 llmsocial（${this.webhookBaseUrl}）。点「连到这个账号」改过来。`;
    } else {
      detail = '已安装并注册，但还没连到 llmsocial。点「连到这个账号」。';
    }
    return { ...base, installed: true, version, registered, configured, autoDeliver, ready, detail };
  }

  /**
   * Download (when missing or forced) → write settings → register. Re-running is safe: the bridge
   * refuses nothing that is already done, and llmsocial de-duplicates messages by id anyway.
   */
  async install(accountId: string, secret: string, opts: { force?: boolean } = {}): Promise<WechatBridgeInstallResult> {
    if (!this.supported()) throw new Error('聊天桥只有 Windows 版，这台机器装不了。');
    if (this.busy) throw new Error('聊天桥正在安装，等它完成再点。');
    this.busy = true;
    const log: string[] = [];
    try {
      if (opts.force || !this.installed()) await this.download(log);
      else log.push(`已经装在 ${this.installDir}，跳过下载。`);

      log.push('把 llmsocial 的地址和这个账号写进聊天桥…');
      const conf = await this.run(this.exePath, ['--configure', '--base-url', this.webhookBaseUrl, '--account-id', accountId, '--auto', 'on', '--quiet'], { env: { CHATBRIDGE_SECRET: secret }, timeout: 60_000 });
      if (!conf.ok) throw new Error(`聊天桥写设置失败：${lastLine(conf) || `退出码 ${conf.code}`}`);
      log.push('设置已写入，收到转发会直接发到这个账号。');

      const before = await this.rawStatus();
      if (before.registeredUpToDate === true) {
        log.push('已经注册在微信菜单里，不用再注册。');
      } else {
        log.push('注册到微信菜单（第一次会弹管理员确认，点「是」）…');
        const reg = await this.run(this.exePath, ['--register', '--quiet'], { timeout: 4 * 60_000 });
        log.push(...outputLines(reg));
        if (!reg.ok) throw new Error(`注册失败：${lastLine(reg) || `退出码 ${reg.code}`}`);
        log.push('注册完成。微信要整个退出再打开一次，菜单里才会出现聊天桥。');
      }

      const status = await this.status(accountId);
      this.log.info({ accountId, installDir: this.installDir, ready: status.ready }, 'wechat bridge installed');
      return { log, status };
    } finally {
      this.busy = false;
    }
  }

  private async rawStatus(): Promise<RawStatus> {
    const out = await this.run(this.exePath, ['--status', '--json', '--quiet'], { timeout: 30_000 });
    if (!out.ok) throw new Error(lastLine(out) || `退出码 ${out.code}`);
    // The exe may print a blank line before the JSON when it attaches to a console.
    const start = out.stdout.indexOf('{');
    const end = out.stdout.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('没有返回状态');
    return JSON.parse(out.stdout.slice(start, end + 1)) as RawStatus;
  }

  private async download(log: string[]): Promise<void> {
    fs.mkdirSync(this.installDir, { recursive: true });
    const tmp = path.join(this.installDir, `download-${randomBytes(4).toString('hex')}.zip`);
    try {
      const local = localArchivePath(this.downloadUrl);
      let sidecar: string;
      if (local) {
        // An archive on disk (LLMSOCIAL_WECHAT_BRIDGE_URL as a path or file://): offline installs and dev builds.
        log.push(`从本地复制 ${local} …`);
        if (!fs.existsSync(local)) throw new Error(`找不到发布包 ${local}`);
        if (!fs.existsSync(`${local}.sha256`)) throw new Error(`找不到校验文件 ${local}.sha256（scripts\package-release.ps1 会生成）`);
        fs.copyFileSync(local, tmp);
        sidecar = fs.readFileSync(`${local}.sha256`, 'utf8');
      } else {
        log.push(`下载 ${this.downloadUrl} …`);
        const res = await this.fetchFn(this.downloadUrl, { signal: AbortSignal.timeout(15 * 60_000) });
        if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}（${this.downloadUrl}）。私有仓库的发布包下不了，要先把它设成公开。`);
        await pipeline(Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream), fs.createWriteStream(tmp));
        const sideRes = await this.fetchFn(`${this.downloadUrl}.sha256`, { signal: AbortSignal.timeout(60_000) });
        if (!sideRes.ok) throw new Error(`下载校验文件失败：HTTP ${sideRes.status}（${this.downloadUrl}.sha256）`);
        sidecar = await sideRes.text();
      }

      const expected = sidecar.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('校验文件的格式不对，应该是 sha256sum 的输出。');
      const actual = await sha256File(tmp);
      if (actual !== expected) throw new Error('下载下来的文件和校验值对不上，已经删掉。网络不稳的话稍后再试；一直对不上就别装。');
      const mb = Math.round(fs.statSync(tmp).size / 1e6);
      log.push(`已下载 ${mb} MB，校验通过。`);

      try {
        await this.extract(tmp, this.installDir);
      } catch (err) {
        throw new Error(`${errMessage(err)}${this.installed() ? '（聊天桥的窗口开着的话先关掉再试）' : ''}`);
      }
      if (!this.installed()) throw new Error(`解压完了，但 ${this.installDir} 里没有 ${BRIDGE_EXE}：下载的不是聊天桥的发布包。`);
      log.push(`已解压到 ${this.installDir}。`);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}
