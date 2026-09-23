import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from '../src/server/config.ts';
import { viteBin } from './vite-bin.ts';

// `npm start` should just work on a fresh clone rather than serving a blank page.
const index = path.join(PROJECT_ROOT, 'dist/web/index.html');
if (!fs.existsSync(index)) {
  process.stdout.write('界面还没有构建，正在构建…\n');
  const build = spawnSync(process.execPath, [viteBin(), 'build'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
  if (build.status !== 0) {
    process.stderr.write('构建失败。先运行 npm install，再运行 npm run build。\n');
    process.exit(1);
  }
}
