import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/server/config.ts';
import { viteBin } from './vite-bin.ts';
import { zipDirectory } from './zip-writer.ts';

/**
 * Builds the Windows 免安装版: one folder with its own Node runtime, the built web UI, production
 * dependencies and a double-click launcher, zipped as dist/llmsocial-win-x64.zip (+ .sha256).
 * The person who gets it needs nothing installed — no Node, no git, no npm.
 *
 * Steps: vite build → stage app files → npm ci --omit=dev in the stage → pinned Node zip (checksum
 * from SHASUMS256.txt) → launcher, 先看我.txt, VERSION.txt → zip → delete the stage → unpack the zip
 * through the Windows shell (the same code path as Explorer's "Extract All") into a folder whose path
 * has Chinese and a space → start that copy's launcher in a fresh console and check the admin API,
 * the webhook port (loopback only), and the UI → only then write the .sha256 and say 全过.
 * Deleting the stage first matters: otherwise a broken archive can pass by quietly using the stage.
 *
 * Usage: node scripts/build-portable.ts [--skip-web-build]
 * Env:   LLMSOCIAL_NODE_DIST=https://npmmirror.com/mirrors/node   (mirror when nodejs.org is slow)
 */

const NODE_VERSION = '24.19.0';
const NODE_DISTS = [process.env.LLMSOCIAL_NODE_DIST?.replace(/\/+$/, ''), 'https://nodejs.org/dist', 'https://npmmirror.com/mirrors/node'].filter((u): u is string => Boolean(u));
const NODE_ZIP = `node-v${NODE_VERSION}-win-x64.zip`;
const ARCHIVE = 'llmsocial-win-x64.zip';
const ROOT_NAME = 'llmsocial';
const SMOKE_PORT = 8797;
const SMOKE_WEBHOOK_PORT = 8796;

const args = new Set(process.argv.slice(2));
const dist = path.join(PROJECT_ROOT, 'dist');
const cache = path.join(dist, 'portable-cache');
const stage = path.join(dist, 'portable', ROOT_NAME);
const app = path.join(stage, 'app');
const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function step(msg: string): void {
  process.stdout.write(`\n== ${msg}\n`);
}

class BuildError extends Error {}

function fail(msg: string): never {
  throw new BuildError(msg);
}

function run(cmd: string, argv: string[], opts: { cwd?: string; shell?: boolean } = {}): void {
  const r = spawnSync(cmd, argv, { cwd: opts.cwd ?? PROJECT_ROOT, stdio: 'inherit', shell: opts.shell ?? false });
  if (r.status !== 0) fail(`${cmd} ${argv.join(' ')} 退出码 ${r.status ?? r.signal}`);
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Windows keeps a file busy for a moment after the process holding it was killed. */
async function removeDir(dir: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(500);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

async function download(url: string, to: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  fs.writeFileSync(to, Buffer.from(await res.arrayBuffer()));
}

/** Tries each dist mirror in turn; the checksum list must come from the same place as the zip. */
async function fetchNodeZip(): Promise<string> {
  const zip = path.join(cache, NODE_ZIP);
  const sums = path.join(cache, `SHASUMS256-${NODE_VERSION}.txt`);
  fs.mkdirSync(cache, { recursive: true });
  if (!fs.existsSync(sums)) {
    let ok = false;
    for (const base of NODE_DISTS) {
      try {
        await download(`${base}/v${NODE_VERSION}/SHASUMS256.txt`, sums);
        ok = true;
        break;
      } catch (err) {
        process.stdout.write(`  ${base}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    if (!ok) fail('下载不了 Node 的校验清单，检查网络或设 LLMSOCIAL_NODE_DIST');
  }
  const line = fs.readFileSync(sums, 'utf8').split(/\r?\n/).find((l) => l.endsWith(`  ${NODE_ZIP}`));
  const expected = line?.split(/\s+/)[0]?.toLowerCase();
  if (!expected) fail(`SHASUMS256.txt 里没有 ${NODE_ZIP}`);

  if (!fs.existsSync(zip) || sha256(zip) !== expected) {
    let ok = false;
    for (const base of NODE_DISTS) {
      process.stdout.write(`  下载 ${base}/v${NODE_VERSION}/${NODE_ZIP} …\n`);
      try {
        await download(`${base}/v${NODE_VERSION}/${NODE_ZIP}`, zip);
        ok = true;
        break;
      } catch (err) {
        process.stdout.write(`  ${base}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    if (!ok) fail('下载不了 Node 运行时');
  }
  const actual = sha256(zip);
  if (actual !== expected) {
    fs.rmSync(zip, { force: true });
    fail(`Node 运行时校验不符（${actual.slice(0, 12)}… ≠ ${expected.slice(0, 12)}…），已删掉，重跑一次`);
  }
  process.stdout.write(`  Node ${NODE_VERSION} 校验通过\n`);
  return zip;
}

/**
 * The launcher, as bytes: UTF-8 without BOM, CRLF (cmd loses goto labels in LF-only files). The first
 * section is ASCII only and re-runs the file under chcp 65001 in a nested cmd — a batch that switches
 * code page itself mis-splits later lines with Chinese in them. Chinese appears only in plain echo
 * lines after :main: never inside a ( ) block, an if, or a set.
 *
 * Settings, strongest first: environment variable → app\.env → the portable defaults (data in
 * %LOCALAPPDATA%\llmsocial\data so replacing the folder keeps it; webhook port on loopback only so
 * Windows Firewall has nothing to ask about).
 */
function launcher(): Buffer {
  const lines = [
    '@echo off',
    'rem llmsocial portable launcher. ASCII only above :main (see scripts/build-portable.ts).',
    'if "%LS_BAT_UTF8%"=="1" goto :main',
    'setlocal',
    'set "LS_BAT_UTF8=1"',
    'chcp 65001 >nul',
    'cmd /d /c ""%~f0" %*"',
    'exit /b %errorlevel%',
    '',
    ':main',
    'setlocal',
    'title llmsocial',
    'cd /d "%~dp0"',
    'set "NODE=%~dp0node\\node.exe"',
    'if not exist "%NODE%" goto :nonode',
    '',
    'set "PORT=8787"',
    'call :fromfile LLMSOCIAL_PORT PORT',
    'if defined LLMSOCIAL_PORT set "PORT=%LLMSOCIAL_PORT%"',
    'set "URL=http://127.0.0.1:%PORT%"',
    'if "%~1"=="--wait-and-open" goto :waitopen',
    '',
    'set "DATA_FROM_FILE="',
    'call :fromfile LLMSOCIAL_DATA_DIR DATA_FROM_FILE',
    'if not defined LLMSOCIAL_DATA_DIR if not defined DATA_FROM_FILE set "LLMSOCIAL_DATA_DIR=%LOCALAPPDATA%\\llmsocial\\data"',
    'set "HOST_FROM_FILE="',
    'call :fromfile LLMSOCIAL_WEBHOOK_HOST HOST_FROM_FILE',
    'if not defined LLMSOCIAL_WEBHOOK_HOST if not defined HOST_FROM_FILE set "LLMSOCIAL_WEBHOOK_HOST=127.0.0.1"',
    '',
    'curl.exe --noproxy "*" -s -o NUL -m 2 "%URL%/api/auth/state" >nul 2>nul',
    'if not errorlevel 1 goto :running',
    '',
    'if not defined LLMSOCIAL_NO_BROWSER start "" /min cmd /d /c ""%~f0" --wait-and-open"',
    'echo 正在启动 llmsocial，起来后浏览器会自动打开 %URL%',
    'if defined LLMSOCIAL_DATA_DIR goto :showdata',
    'echo 数据目录按 app\\.env 里的设置：%DATA_FROM_FILE%',
    'goto :datashown',
    ':showdata',
    'echo 数据保存在 %LLMSOCIAL_DATA_DIR%',
    ':datashown',
    'echo 这个窗口别关，关了服务就停。要停就关掉这个窗口。',
    'echo.',
    '"%NODE%" "%~dp0app\\src\\server\\index.ts"',
    'echo.',
    'echo llmsocial 已停止。',
    'pause',
    'exit /b',
    '',
    ':running',
    'echo llmsocial 已经在运行：%URL%',
    'if not defined LLMSOCIAL_NO_BROWSER start "" "%URL%"',
    'ping -n 4 127.0.0.1 >nul',
    'exit /b 0',
    '',
    ':nonode',
    'echo 找不到 node\\node.exe：压缩包没解压完整。把整个压缩包重新解压一次，再双击这个文件。',
    'pause',
    'exit /b 1',
    '',
    ':fromfile',
    'rem %1 = key in app\\.env, %2 = variable to set when that key has a non-empty value.',
    'for /f "tokens=1,* delims==" %%a in (\'findstr /b /c:"%~1=" app\\.env 2^>nul\') do if not "%%b"=="" set "%~2=%%b"',
    'exit /b 0',
    '',
    ':waitopen',
    'rem Helper window: poll until the server answers, then open the browser once.',
    'for /l %%i in (1,1,180) do (',
    '  curl.exe --noproxy "*" -s -o NUL -m 2 "%URL%/api/auth/state" >nul 2>nul',
    '  if not errorlevel 1 goto :opened',
    '  ping -n 2 127.0.0.1 >nul',
    ')',
    'exit /b 1',
    ':opened',
    'start "" "%URL%"',
    'exit /b 0',
    '',
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

function readme(version: string): string {
  return [
    `llmsocial ${version} 免安装版（Windows x64）`,
    '',
    '怎么用',
    '  1. 右键压缩包 → 全部解压缩，放到哪都行（桌面、D 盘都可以）。',
    '  2. 打开解压出来的 llmsocial 文件夹，双击「一键启动.bat」。',
    '     第一次可能弹「打开文件 - 安全警告」，点「运行」。',
    '  3. 浏览器会自己打开 http://127.0.0.1:8787 ，第一次让你设一个管理密码。',
    '  4. 黑窗口别关，关了服务就停。下次用还是双击「一键启动.bat」。',
    '',
    '数据在哪、怎么备份',
    '  账号、对话、密钥都在 %LOCALAPPDATA%\\llmsocial\\data，不在这个文件夹里。',
    '  界面「设置 → 备份与恢复」可以一键备份、下载备份、打开数据目录，里面也写了怎么恢复。',
    '  数据目录里的 master.key 是加密主密钥：换电脑时和备份一起拷走。',
    '',
    '升级',
    '  界面「设置 → 版本与更新」点「检查更新」看有没有新版（只有点的时候才联网）。',
    '  关掉黑窗口 → 删掉旧的 llmsocial 文件夹 → 解压新版 → 双击「一键启动.bat」。数据不受影响。',
    '',
    '卸载',
    '  删掉这个文件夹；数据也不要了的话，再删掉 %LOCALAPPDATA%\\llmsocial。',
    '  装过微信聊天桥的，先在 llmsocial 里删掉那个微信账号，再删 %LOCALAPPDATA%\\Programs\\WeChatBridge。',
    '',
    '微信聊天记录',
    '  账号 → 新建账号 → 平台选微信 → 保存。安装窗口会自己弹出来装聊天桥（第一次弹一次管理员确认，点「是」）。',
    '  装好后把微信整个退出再打开：微信里多选消息 → 转发 → 转发到其他应用 → 选择电脑中的应用 → 聊天桥。',
    '',
    '改端口、代理、数据目录',
    '  把 app\\.env.example 复制成 app\\.env 再改。代理也可以在界面「设置 → 网络代理」里开关。',
    '  启动时说「端口 8787 用不了」：在 app\\.env 里写一行 LLMSOCIAL_PORT=8797，再启动。',
    '',
    '不带任何遥测；除了你配置的平台和模型服务，不联网。',
    '',
  ].join('\r\n');
}

/** The copied .env.example tells the truth about this build's defaults instead of the source checkout's. */
function portableEnvExample(source: string): string {
  const replace = (text: string, pattern: RegExp, lines: string): string => {
    if (!pattern.test(text)) fail(`.env.example 里找不到 ${pattern}，打包脚本要跟着改`);
    return text.replace(pattern, lines);
  };
  let text = source;
  text = replace(
    text,
    /^LLMSOCIAL_DATA_DIR=.*$/m,
    '# 留空 = %LOCALAPPDATA%\\llmsocial\\data（换新版文件夹不丢数据）。写相对路径就会放在这个文件夹里，升级删文件夹时会一起删掉。\nLLMSOCIAL_DATA_DIR=',
  );
  text = replace(
    text,
    /^# Webhook 端口听在哪。.*\r?\nLLMSOCIAL_WEBHOOK_HOST=.*$/m,
    '# Webhook 端口听在哪。免安装版留空 = 127.0.0.1（只在这台电脑上，不弹防火墙询问）；要让别的电脑上的桥推进来就写 0.0.0.0。\nLLMSOCIAL_WEBHOOK_HOST=',
  );
  return text;
}

/** Relative file paths under `dir`, forward slashes, sorted. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

function listening(port: number): string[] {
  const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  return (r.stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter((cols) => cols[0] === 'TCP' && cols[1]?.endsWith(`:${port}`) && cols[3] === 'LISTENING')
    .map((cols) => cols[1]!);
}

async function get(url: string): Promise<{ status: number; text: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return { status: res.status, text: await res.text() };
  } catch {
    return null;
  }
}

/** Unpacks the archive the way a person with only Explorer would, somewhere else, and starts that copy. */
async function selfTest(archive: string, expectedFiles: string[]): Promise<void> {
  step('自检 1/2：用资源管理器同一套解压（zipfldr），解到带中文和空格的路径');
  const where = path.join(os.tmpdir(), `llmsocial 自检 ${randomBytes(3).toString('hex')}`);
  const dataDir = path.join(where, 'data');
  const unpacked = path.join(where, '解压');
  fs.mkdirSync(unpacked, { recursive: true });
  let child: ReturnType<typeof spawn> | null = null;
  let passed = false;
  try {
    const ps = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PROJECT_ROOT, 'scripts', 'explorer-unzip.ps1'), '-Zip', archive, '-Dest', unpacked, '-ExpectFiles', String(expectedFiles.length)],
      { encoding: 'utf8', windowsHide: true },
    );
    const got = fs.existsSync(unpacked) ? listFiles(unpacked) : [];
    const missing = expectedFiles.filter((f) => !got.includes(f));
    const extra = got.filter((f) => !expectedFiles.includes(f));
    if (ps.status !== 0 || missing.length > 0 || extra.length > 0) {
      fail(
        `解压结果不对（${(ps.stdout ?? '').trim() || `退出码 ${ps.status}`}）\n  缺：${missing.slice(0, 15).join('、') || '无'}\n  多：${extra.slice(0, 15).join('、') || '无'}`,
      );
    }
    process.stdout.write(`  ${got.length} 个文件，名字一个不差（含中文和非 GBK 字符）。\n`);

    step('自检 2/2：新开控制台双击启动器那样跑，查接口、回调端口、界面');
    const bat = path.join(unpacked, ROOT_NAME, '一键启动.bat');
    const env: NodeJS.ProcessEnv = { ...process.env, LLMSOCIAL_NO_BROWSER: '1', LLMSOCIAL_PORT: String(SMOKE_PORT), LLMSOCIAL_WEBHOOK_PORT: String(SMOKE_WEBHOOK_PORT), LLMSOCIAL_DATA_DIR: dataDir, LOG_LEVEL: 'warn' };
    // Nothing from this build's shell may leak in and make the launcher skip its own setup.
    for (const key of ['LS_BAT_UTF8', 'LLMSOCIAL_WEBHOOK_HOST', 'LLMSOCIAL_HOST']) delete env[key];
    let output = '';
    // windowsHide gives the child its own (hidden) console: a console that ran chcp before would hide code-page bugs.
    child = spawn('cmd.exe', ['/d', '/s', '/c', `""${bat}""`], { env, cwd: where, windowsVerbatimArguments: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (d: Buffer) => (output += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString('utf8')));

    let state: { setupRequired?: boolean } | null = null;
    for (let i = 0; i < 90 && !state; i++) {
      await sleep(500);
      if (child.exitCode !== null) break;
      const res = await get(`http://127.0.0.1:${SMOKE_PORT}/api/auth/state`);
      if (res?.status === 200) state = JSON.parse(res.text) as { setupRequired?: boolean };
    }
    if (!state) fail(`45 秒内接口没起来。启动器输出：\n${output.slice(-2000)}`);
    if (state.setupRequired !== true) fail(`全新数据目录应该要求设密码，返回的是 ${JSON.stringify(state)}`);
    const health = await get(`http://127.0.0.1:${SMOKE_WEBHOOK_PORT}/healthz`);
    if (health?.status !== 200) fail(`回调端口 ${SMOKE_WEBHOOK_PORT} 没起来`);
    const bound = listening(SMOKE_WEBHOOK_PORT);
    if (bound.length === 0 || bound.some((a) => !a.startsWith('127.0.0.1:'))) fail(`回调端口应该只听本机，实际听在 ${bound.join('、') || '（没找到）'}`);
    const page = await get(`http://127.0.0.1:${SMOKE_PORT}/`);
    if (page?.status !== 200 || !page.text.includes('<script')) fail('界面没打包进去（首页不是构建后的页面）');
    if (!fs.existsSync(path.join(dataDir, 'master.key'))) fail(`数据没写到指定目录 ${dataDir}`);

    // Log in the way the browser does, then check what only the packaged copy can prove: it knows it is
    // the 免安装版 (the settings page picks the upgrade instructions from that), and a backup works
    // with the bundled Node's SQLite.
    const api = `http://127.0.0.1:${SMOKE_PORT}/api`;
    const setup = await fetch(`${api}/auth/setup`, { method: 'POST', headers: { 'x-llmsocial': '1', 'content-type': 'application/json' }, body: JSON.stringify({ password: randomBytes(12).toString('hex') }) });
    const cookie = setup.headers.get('set-cookie')?.split(';')[0];
    if (!setup.ok || !cookie) fail(`设置管理密码失败：HTTP ${setup.status}`);
    const info = (await (await fetch(`${api}/maintenance`, { headers: { cookie } })).json()) as { portable?: boolean; dataDir?: string };
    if (info.portable !== true) fail('解压出来的副本没认出自己是免安装版，设置页的升级说明会给错');
    if (path.resolve(info.dataDir ?? '') !== path.resolve(dataDir)) fail(`数据目录不对：${info.dataDir}`);
    const backup = await fetch(`${api}/backups`, { method: 'POST', headers: { cookie, 'x-llmsocial': '1' } });
    const made = (await backup.json()) as { name?: string };
    if (!backup.ok || !made.name || !fs.existsSync(path.join(dataDir, 'backups', made.name))) fail(`备份没做成：HTTP ${backup.status}`);
    process.stdout.write(`  接口要求设密码、回调端口只听 ${bound.join('、')}、界面在、数据写进了指定目录、认出是免安装版、备份能做。\n`);
    passed = true;
  } finally {
    if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    for (let i = 0; i < 20 && listening(SMOKE_PORT).length > 0; i++) await sleep(500);
    if (passed) await removeDir(where);
    else process.stdout.write(`  解压出来的副本留在 ${where}，可以进去看。\n`);
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') fail('免安装版只打 Windows 的，请在 Windows 上运行');
  if (!fs.existsSync(tar)) fail(`找不到 ${tar}（Windows 10 1803 起自带，解 Node 运行时要用）`);
  for (const port of [SMOKE_PORT, SMOKE_WEBHOOK_PORT]) if (listening(port).length > 0) fail(`自检要用的端口 ${port} 被占着，先关掉占用它的程序`);
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string };
  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).stdout?.trim() !== '';
  const sha = git.status === 0 ? `${git.stdout.trim()}${dirty ? '+未提交的改动' : ''}` : 'unknown';
  if (dirty) process.stdout.write('注意：工作区有没提交的改动，VERSION.txt 会标出来。要发给别人的包，先提交再打。\n');

  if (!args.has('--skip-web-build')) {
    step('构建界面');
    run(process.execPath, [viteBin(), 'build']);
  }
  if (!fs.existsSync(path.join(dist, 'web', 'index.html'))) fail('dist/web 里没有界面，去掉 --skip-web-build 重跑');

  step('准备目录');
  await removeDir(path.dirname(stage));
  fs.mkdirSync(app, { recursive: true });
  for (const f of ['package.json', 'package-lock.json', 'README.md']) fs.copyFileSync(path.join(PROJECT_ROOT, f), path.join(app, f));
  fs.writeFileSync(path.join(app, '.env.example'), portableEnvExample(fs.readFileSync(path.join(PROJECT_ROOT, '.env.example'), 'utf8')));
  for (const d of ['src', 'skills', 'docs']) fs.cpSync(path.join(PROJECT_ROOT, d), path.join(app, d), { recursive: true });
  fs.cpSync(path.join(dist, 'web'), path.join(app, 'dist', 'web'), { recursive: true });

  step('安装运行时依赖（只装 dependencies）');
  // npm is npm.cmd on Windows and needs a shell; the command line is fixed text, nothing from outside goes in.
  run('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', [], { cwd: app, shell: true });

  step(`Node ${NODE_VERSION} 运行时`);
  const nodeZip = await fetchNodeZip();
  const unpackedNode = path.join(cache, `node-v${NODE_VERSION}-win-x64`);
  if (!fs.existsSync(path.join(unpackedNode, 'node.exe'))) {
    await removeDir(unpackedNode);
    run(tar, ['-xf', nodeZip, '-C', cache]);
  }
  fs.mkdirSync(path.join(stage, 'node'), { recursive: true });
  fs.copyFileSync(path.join(unpackedNode, 'node.exe'), path.join(stage, 'node', 'node.exe'));
  fs.copyFileSync(path.join(unpackedNode, 'LICENSE'), path.join(stage, 'node', 'LICENSE'));

  step('启动器和说明');
  fs.writeFileSync(path.join(stage, '一键启动.bat'), launcher());
  fs.writeFileSync(path.join(stage, '先看我.txt'), Buffer.from(`\uFEFF${readme(pkg.version)}`, 'utf8'));
  fs.writeFileSync(path.join(stage, 'VERSION.txt'), `llmsocial ${pkg.version}\r\ngit ${sha}\r\nnode ${NODE_VERSION}\r\nbuilt ${new Date().toISOString()}\r\n`);

  step('打包');
  const out = path.join(dist, ARCHIVE);
  fs.rmSync(out, { force: true });
  fs.rmSync(`${out}.sha256`, { force: true });
  const zipped = zipDirectory(stage, ROOT_NAME, out);
  const expectedFiles = zipped.entries.filter((e) => !e.dir).map((e) => e.name).sort();
  process.stdout.write(`  ${expectedFiles.length} 个文件，${Math.round(zipped.bytesIn / 1e6)} MB → ${Math.round(zipped.bytesOut / 1e6)} MB\n`);
  // From here on only the archive exists: the self-test cannot lean on the stage by accident.
  await removeDir(path.dirname(stage));

  try {
    await selfTest(out, expectedFiles);
  } catch (err) {
    fs.rmSync(out, { force: true });
    throw err;
  }

  const digest = sha256(out);
  fs.writeFileSync(`${out}.sha256`, `${digest}  ${ARCHIVE}\n`);
  process.stdout.write(`\n免安装版：${out}（${Math.round(fs.statSync(out).size / 1e6)} MB）\nSHA-256：${digest}\n版本：llmsocial ${pkg.version} @ ${sha}，Node ${NODE_VERSION}\n全过：可以发布\n`);
}

try {
  await main();
} catch (err) {
  process.stderr.write(`\n✖ ${err instanceof Error ? err.message : String(err)}\n没有生成可发布的包。\n`);
  process.exit(1);
}
