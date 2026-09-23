import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Ocr } from '../src/server/ocr/index.ts';
import { parseChatScreenshot } from '../src/server/ocr/parseChat.ts';
import { silentLogger } from '../src/server/util.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures/chat-zh.png');
const dataDir = path.join(os.tmpdir(), 'llmsocial-ocr-test');
const ocr = new Ocr(dataDir, silentLogger);
const SKIP_REASON = '需要 macOS（swiftc）或 Windows（PowerShell 和 OCR 语言包）';

test('a non-image is refused before anything is executed', async () => {
  await assert.rejects(ocr.recognize(Buffer.from('not an image at all')), /不支持的图片格式/);
});

// On macOS the helper is compiled on demand, so the first run of this file takes ~20s.
test('a real screenshot is read locally and split into the two sides of the chat', { skip: !ocr.supported && SKIP_REASON }, async (t) => {
  t.diagnostic(await ocr.describe());
  const lines = await ocr.recognize(fs.readFileSync(fixture));
  // Regression: Vision writes framework diagnostics to stdout on some macOS builds. When the helper
  // returned its JSON on stdout too, that noise landed inside the payload and every import failed.
  assert.ok(lines.length >= 3, JSON.stringify(lines));
  for (const line of lines) {
    assert.equal(typeof line.text, 'string');
    for (const k of ['x', 'y', 'w', 'h'] as const) assert.ok(line[k] >= 0 && line[k] <= 1, `${k}=${line[k]}`);
  }
  const text = lines.map((l) => l.text).join('');
  for (const expected of ['在吗', '有什么可以帮你', '收费']) assert.ok(text.includes(expected), `OCR 没读到「${expected}」：${text}`);
  // The Windows engine makes every CJK character its own word; joining them on spaces would give
  // 「你 好 ， 在 吗」 and every downstream match would miss.
  for (const line of lines) assert.ok(!/[一-鿿] [一-鿿]/.test(line.text), `汉字之间混进了空格：${line.text}`);

  const messages = parseChatScreenshot(lines);
  assert.deepEqual(
    messages.map((m) => m.side),
    ['contact', 'me', 'contact'],
    `左右分栏判断错了：${JSON.stringify(messages)}`,
  );
});

test('the helper is prepared once and leaves no scratch files behind', { skip: !ocr.supported && SKIP_REASON }, async () => {
  assert.equal(await ocr.available(), true);
  const binDir = path.join(dataDir, 'bin');
  const before = fs.existsSync(binDir) ? fs.readdirSync(binDir) : [];
  // Only the macOS backend compiles anything; the Windows script runs in place.
  assert.equal(before.length, process.platform === 'darwin' ? 1 : 0);
  await ocr.recognize(fs.readFileSync(fixture));
  assert.deepEqual(fs.existsSync(binDir) ? fs.readdirSync(binDir) : [], before);
  // And no scratch files are left behind in the temp directory.
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('llmsocial-ocr-') && !f.includes('test')), []);
});
