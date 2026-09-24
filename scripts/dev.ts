import { spawn } from 'node:child_process';
import { PROJECT_ROOT } from '../src/server/config.ts';
import { serverEnv } from './server-env.ts';
import { viteBin } from './vite-bin.ts';

// Server on 8787, Vite on 5173 proxying /api and /oauth to it. Open the Vite URL while developing.
// process.execPath 而不是 'node'：保证子进程和父进程是同一个 Node，PATH 里有别的版本也不会串。
const children = [
  spawn(process.execPath, ['--watch-path=src/server', '--watch-path=src/shared', 'src/server/index.ts'], { cwd: PROJECT_ROOT, stdio: 'inherit', env: serverEnv() }),
  spawn(process.execPath, [viteBin()], { cwd: PROJECT_ROOT, stdio: 'inherit', env: process.env }),
];

let stopping = false;
const stop = (code: number) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
};

for (const child of children) child.on('exit', (code) => stop(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop(0));
