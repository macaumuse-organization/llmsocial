import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { PROJECT_ROOT } from '../src/server/config.ts';

const LOCAL_ONLY = 'localhost,127.0.0.1,::1';

/**
 * The environment the server process starts with.
 *
 * Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is set — curl, git and pip all
 * honour it, Node alone does not — and it decides once, at startup. A proxy that the server loads
 * from .env itself (loadConfig) arrives too late, and so does NODE_USE_ENV_PROXY read through
 * --env-file; both were measured. So the launcher reads .env and hands the server a finished
 * environment. The real environment wins over .env, the same rule loadConfig uses; setting
 * NODE_USE_ENV_PROXY=0 opts out. Node older than 24.5 ignores the variable and simply connects
 * directly, as before.
 */
export function buildServerEnv(processEnv: NodeJS.ProcessEnv, envFileText: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parseEnv(envFileText), ...processEnv };
  env.NODE_USE_ENV_PROXY ??= '1';
  const proxied = [env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy].some((v) => v !== undefined && v !== '');
  // With a proxy and no exception list, a model server on this machine would be sent to the proxy too.
  if (proxied && env.NO_PROXY === undefined && env.no_proxy === undefined) env.NO_PROXY = LOCAL_ONLY;
  return env;
}

export function serverEnv(): NodeJS.ProcessEnv {
  const file = path.join(PROJECT_ROOT, '.env');
  return buildServerEnv(process.env, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
}
