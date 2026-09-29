import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { zipDirectory } from '../scripts/zip-writer.ts';

interface Read {
  name: string;
  flags: number;
  method: number;
  data: Buffer;
}

/** Walks the central directory and follows every entry to its local header, the way an extractor does. */
function readZip(file: string): Read[] {
  const buf = fs.readFileSync(file);
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50, 'end of central directory where a comment-less zip has it');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out: Read[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    assert.equal(buf.readUInt32LE(local), 0x04034b50, `${name}: local header`);
    assert.equal(buf.readUInt16LE(local + 6), flags, `${name}: same flags in both headers`);
    const localNameLen = buf.readUInt16LE(local + 26);
    const localExtra = buf.readUInt16LE(local + 28);
    assert.equal(buf.subarray(local + 30, local + 30 + localNameLen).toString('utf8'), name);
    const start = local + 30 + localNameLen + localExtra;
    const stored = buf.subarray(start, start + packed);
    const data = method === 8 ? zlib.inflateRawSync(stored) : Buffer.from(stored);
    assert.equal(data.length, size, `${name}: size`);
    assert.equal(zlib.crc32(data) >>> 0, crc, `${name}: crc`);
    out.push({ name, flags, method, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmsocial-zip-'));
  fs.writeFileSync(path.join(dir, '一键启动.bat'), '@echo off\r\necho hi\r\n');
  fs.mkdirSync(path.join(dir, 'app', 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'docs', '平台接入.md'), '微信个人号可以装聊天桥。\n'.repeat(200));
  // The name that crashes Windows' bsdtar under a GBK code page.
  fs.mkdirSync(path.join(dir, 'snow ☃'));
  fs.writeFileSync(path.join(dir, 'snow ☃', 'x.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'empty.txt'), '');
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'random.dat'), randomBytes(64 * 1024));
  fs.mkdirSync(path.join(dir, 'emptydir'));
  return dir;
}

test('zip：UTF-8 文件名带标记位，内容和 CRC 都对，压缩不划算的就原样存', () => {
  const src = fixture();
  const out = path.join(src, '..', `${path.basename(src)}.zip`);
  const result = zipDirectory(src, 'llmsocial', out);
  const read = readZip(out);

  assert.deepEqual(
    read.map((e) => e.name),
    [
      'llmsocial/',
      'llmsocial/app/',
      'llmsocial/app/docs/',
      'llmsocial/app/docs/平台接入.md',
      'llmsocial/bin/',
      'llmsocial/bin/random.dat',
      'llmsocial/empty.txt',
      'llmsocial/emptydir/',
      'llmsocial/snow ☃/',
      'llmsocial/snow ☃/x.txt',
      'llmsocial/一键启动.bat',
    ],
  );
  assert.ok(read.every((e) => (e.flags & 0x0800) !== 0), 'every name is marked UTF-8');
  const byName = new Map(read.map((e) => [e.name, e]));
  assert.equal(byName.get('llmsocial/app/docs/平台接入.md')!.method, 8, 'text is deflated');
  assert.equal(byName.get('llmsocial/bin/random.dat')!.method, 0, 'random bytes are stored');
  for (const e of read.filter((x) => !x.name.endsWith('/'))) {
    const rel = e.name.slice('llmsocial/'.length);
    assert.deepEqual(e.data, fs.readFileSync(path.join(src, ...rel.split('/'))), `${e.name}: content`);
  }
  assert.equal(result.entries.length, read.length);
  assert.equal(result.bytesOut, fs.statSync(out).size);
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(out, { force: true });
});

test('zip：同一棵树打两次字节完全一样', () => {
  const src = fixture();
  const a = path.join(src, '..', `${path.basename(src)}-a.zip`);
  const b = path.join(src, '..', `${path.basename(src)}-b.zip`);
  zipDirectory(src, 'x', a);
  zipDirectory(src, 'x', b);
  assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)));
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(a, { force: true });
  fs.rmSync(b, { force: true });
});
