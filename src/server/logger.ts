import type { Logger } from './util.ts';

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

// Structured-ish lines on stderr, so stdout stays free for anything a script wants to pipe.
export function createLogger(level: string): Logger {
  const threshold = LEVELS[level] ?? LEVELS.info!;
  const emit = (name: string, weight: number) => (obj: unknown, msg?: string) => {
    if (weight < threshold) return;
    const text = typeof obj === 'string' ? obj : msg ?? '';
    const fields = typeof obj === 'object' && obj !== null ? Object.entries(obj as Record<string, unknown>).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ') : '';
    process.stderr.write(`${new Date().toISOString()} ${name.padEnd(5)} ${text}${fields ? ` ${fields}` : ''}\n`);
  };
  return { debug: emit('debug', 10), info: emit('info', 20), warn: emit('warn', 30), error: emit('error', 40) };
}
