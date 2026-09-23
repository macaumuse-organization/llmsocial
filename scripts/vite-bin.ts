import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/server/config.ts';

/**
 * Windows 上 npx 是 npx.cmd，不带 shell 的 spawn 找不到它（ENOENT），dev 和 start 会在第一步就崩。
 * 用当前这个 Node 直接跑 vite 的入口脚本：三个平台同一条路，也不必为了拼命令行去开 shell。
 */
export function viteBin(): string {
  const bin = path.join(PROJECT_ROOT, 'node_modules/vite/bin/vite.js');
  if (!fs.existsSync(bin)) {
    process.stderr.write('找不到 vite，依赖还没装。先运行 npm install。\n');
    process.exit(1);
  }
  return bin;
}
