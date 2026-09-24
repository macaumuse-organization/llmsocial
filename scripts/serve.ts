import { spawn } from 'node:child_process';
import { PROJECT_ROOT } from '../src/server/config.ts';
import { serverEnv } from './server-env.ts';

// `npm start` goes through here instead of running the server directly, so the proxy settings in
// .env are in place when the server process starts (see server-env.ts for why that matters).
const child = spawn(process.execPath, ['src/server/index.ts'], { cwd: PROJECT_ROOT, stdio: 'inherit', env: serverEnv() });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

// Ctrl+C reaches the server too (same console, same process group) and it shuts down cleanly on its
// own; the launcher only waits for it. Forwarding would be worse on Windows, where kill() is a hard stop.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => child.kill('SIGTERM'));
