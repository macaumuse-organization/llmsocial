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

function run(cmd: string, args: string[], timeout: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr: String(stderr).slice(0, 300) }));
  });
}

/**
 * macOS Vision OCR, compiled once into the data directory and cached by source hash.
 * Everything stays on the machine: screenshots of private chats are not something to ship to a cloud OCR.
 */
export class Ocr {
  private binDir: string;
  private log: Logger;
  private binary: Promise<string | null> | null = null;

  constructor(dataDir: string, log: Logger) {
    this.binDir = path.join(dataDir, 'bin');
    this.log = log;
  }

  get supported(): boolean {
    return process.platform === 'darwin' && fs.existsSync('/usr/bin/swiftc');
  }

  private async build(): Promise<string | null> {
    if (!this.supported) return null;
    const hash = createHash('sha256').update(fs.readFileSync(SWIFT_SOURCE)).digest('hex').slice(0, 12);
    const target = path.join(this.binDir, `vision-ocr-${hash}`);
    if (fs.existsSync(target)) return target;
    fs.mkdirSync(this.binDir, { recursive: true, mode: 0o700 });
    const built = await run('/usr/bin/swiftc', ['-O', SWIFT_SOURCE, '-o', target], 180_000);
    if (!built.ok) {
      this.log.warn({ stderr: built.stderr }, 'could not compile the Vision OCR helper');
      return null;
    }
    return target;
  }

  async available(): Promise<boolean> {
    this.binary ??= this.build();
    return (await this.binary) !== null;
  }

  async recognize(image: Buffer): Promise<OcrLine[]> {
    const ext = sniff(image);
    if (!ext) throw new Error('不支持的图片格式（支持 PNG、JPEG、HEIC、WebP、GIF）');
    this.binary ??= this.build();
    const binary = await this.binary;
    if (!binary) throw new Error('本机 OCR 不可用：需要 macOS 和 Xcode 命令行工具（xcode-select --install）');
    const stem = path.join(os.tmpdir(), `llmsocial-ocr-${randomBytes(8).toString('hex')}`);
    const tmp = `${stem}.${ext}`;
    const resultPath = `${stem}.json`;
    fs.writeFileSync(tmp, image, { mode: 0o600 });
    try {
      // The result comes back in a file: Vision logs framework diagnostics to stdout on some macOS
      // builds, and that noise used to end up inside the JSON.
      const out = await run(binary, [tmp, resultPath], 60_000);
      if (!out.ok) throw new Error(`OCR 失败：${out.stderr || '未知错误'}`);
      if (!fs.existsSync(resultPath)) throw new Error('OCR 没有返回结果');
      return JSON.parse(fs.readFileSync(resultPath, 'utf8')) as OcrLine[];
    } finally {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(resultPath, { force: true });
    }
  }
}
