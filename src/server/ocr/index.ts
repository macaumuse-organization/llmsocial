import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OcrLine } from '../../shared/types.ts';
import type { Logger } from '../util.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SWIFT_SOURCE = path.join(here, 'vision-ocr.swift');
const PS_SCRIPT = path.join(here, 'windows-ocr.ps1');
const POWERSHELL = path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT];
/** windows-ocr.ps1 exits with this when Windows has no OCR language installed — a fixable setup problem, not a crash. */
const EXIT_NO_LANGUAGE = 3;
const NO_BACKEND = '本机 OCR 只有 macOS 和 Windows 有。这台机器上把聊天文字粘贴进来导入，一样能起草回复';

const MAGIC: [string, number[]][] = [
  ['png', [0x89, 0x50, 0x4e, 0x47]],
  ['jpg', [0xff, 0xd8, 0xff]],
  ['gif', [0x47, 0x49, 0x46, 0x38]],
  ['webp', [0x52, 0x49, 0x46, 0x46]],
  ['heic', []],
];

function sniff(buf: Buffer): string | null {
  for (const [ext, sig] of MAGIC) if (sig.length > 0 && sig.every((b, i) => buf[i] === b)) return ext;
  if (buf.subarray(4, 12).toString('latin1').startsWith('ftyp')) return 'heic';
  return null;
}

function run(cmd: string, args: string[], timeout: number): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // windowsHide keeps a console window from flashing up on every screenshot.
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === 'number' ? err.code : -1;
      resolve({ ok: err === null, code, stdout, stderr: String(stderr).slice(0, 300) });
    });
  });
}

/** What `prepare()` found: the command to run, and something short to show the operator. */
interface Prepared {
  cmd: string;
  detail: string;
}

/**
 * One per operating system. They differ only in how the helper is obtained — the image in / JSON
 * file out contract is identical, so `recognize()` below is shared.
 */
interface OcrBackend {
  label: string;
  /** Cheap and synchronous: existence checks only, no process starts. */
  supported: () => boolean;
  /** Run once and cached. null means unusable; the reason is already logged. */
  prepare: (binDir: string, log: Logger) => Promise<Prepared | null>;
  args: (image: string, out: string) => string[];
  /** What the operator has to do about it. */
  unavailable: string;
}

const VISION: OcrBackend = {
  label: 'macOS 自带的 Vision',
  supported: () => process.platform === 'darwin' && fs.existsSync('/usr/bin/swiftc'),
  unavailable: '需要 macOS 和 Xcode 命令行工具（xcode-select --install），装好后重启 llmsocial',
  args: (image, out) => [image, out],
  async prepare(binDir, log) {
    const hash = createHash('sha256').update(fs.readFileSync(SWIFT_SOURCE)).digest('hex').slice(0, 12);
    const target = path.join(binDir, `vision-ocr-${hash}`);
    if (fs.existsSync(target)) return { cmd: target, detail: 'Vision' };
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    const built = await run('/usr/bin/swiftc', ['-O', SWIFT_SOURCE, '-o', target], 180_000);
    if (!built.ok) {
      log.warn({ stderr: built.stderr }, 'could not compile the Vision OCR helper');
      return null;
    }
    return { cmd: target, detail: 'Vision' };
  },
};

const WINDOWS: OcrBackend = {
  label: 'Windows 自带的 OCR',
  supported: () => process.platform === 'win32' && fs.existsSync(POWERSHELL),
  unavailable:
    'Windows 上要装 OCR 语言包（设置 → 时间和语言 → 语言和区域 → 中文 → 语言选项 → 光学字符识别），或用管理员 PowerShell 跑 Add-WindowsCapability -Online -Name Language.OCR~~~zh-CN~0.0.1.0，装好后重启 llmsocial',
  args: (image, out) => [...PS_FLAGS, image, out],
  async prepare(_binDir, log) {
    // Nothing to compile, but a language pack still has to be installed, and only the engine knows.
    const probed = await run(POWERSHELL, [...PS_FLAGS, '--probe'], 30_000);
    if (!probed.ok) {
      log.warn({ code: probed.code, stderr: probed.stderr }, 'the Windows OCR helper is not usable');
      return null;
    }
    return { cmd: POWERSHELL, detail: probed.stdout.trim().split(/\r?\n/).join('、') };
  },
};

const BACKENDS: OcrBackend[] = [VISION, WINDOWS];

/**
 * Local OCR: macOS through Vision (a Swift helper compiled on demand and cached by source hash),
 * Windows through the system OCR engine (a bundled PowerShell script).
 * Everything stays on the machine: screenshots of private chats are not something to ship to a cloud OCR.
 */
export class Ocr {
  private binDir: string;
  private log: Logger;
  private ready: Promise<Prepared | null> | null = null;

  constructor(dataDir: string, log: Logger) {
    this.binDir = path.join(dataDir, 'bin');
    this.log = log;
  }

  private get backend(): OcrBackend | null {
    return BACKENDS.find((b) => b.supported()) ?? null;
  }

  get supported(): boolean {
    return this.backend !== null;
  }

  private prepare(): Promise<Prepared | null> {
    const backend = this.backend;
    return backend ? backend.prepare(this.binDir, this.log) : Promise.resolve(null);
  }

  async available(): Promise<boolean> {
    this.ready ??= this.prepare();
    return (await this.ready) !== null;
  }

  /** One line for the operator: what this machine recognises screenshots with, or what to install. */
  async describe(): Promise<string> {
    const backend = this.backend;
    if (!backend) return `本机 OCR 不可用：${NO_BACKEND}`;
    this.ready ??= this.prepare();
    const ready = await this.ready;
    return ready ? `截图在本机识别，用的是${backend.label}（${ready.detail}），不会上传到任何服务` : `本机 OCR 不可用：${backend.unavailable}`;
  }

  async recognize(image: Buffer): Promise<OcrLine[]> {
    const ext = sniff(image);
    if (!ext) throw new Error('不支持的图片格式（支持 PNG、JPEG、HEIC、WebP、GIF）');
    const backend = this.backend;
    this.ready ??= this.prepare();
    const ready = await this.ready;
    if (!backend || !ready) throw new Error(`本机 OCR 不可用：${backend ? backend.unavailable : NO_BACKEND}`);
    const stem = path.join(os.tmpdir(), `llmsocial-ocr-${randomBytes(8).toString('hex')}`);
    const tmp = `${stem}.${ext}`;
    const resultPath = `${stem}.json`;
    fs.writeFileSync(tmp, image, { mode: 0o600 });
    try {
      // The result comes back in a file: Vision logs framework diagnostics to stdout on some macOS
      // builds, and that noise used to end up inside the JSON.
      const out = await run(ready.cmd, backend.args(tmp, resultPath), 60_000);
      if (!out.ok) {
        throw new Error(out.code === EXIT_NO_LANGUAGE ? `本机 OCR 不可用：${backend.unavailable}` : `OCR 失败：${out.stderr || '未知错误'}`);
      }
      if (!fs.existsSync(resultPath)) throw new Error('OCR 没有返回结果');
      return JSON.parse(fs.readFileSync(resultPath, 'utf8')) as OcrLine[];
    } finally {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(resultPath, { force: true });
    }
  }
}
