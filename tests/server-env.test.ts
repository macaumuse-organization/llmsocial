import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildServerEnv } from '../scripts/server-env.ts';

// The launcher's job is to have the proxy in the server's environment before the server starts,
// because Node decides whether fetch uses a proxy exactly once, at startup.

test('.env 里的代理带进服务进程，并默认打开 Node 的代理开关', () => {
  const env = buildServerEnv({}, 'HTTPS_PROXY=http://127.0.0.1:18081\n');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:18081');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
});

test('真实环境变量优先于 .env，和 loadConfig 同一条规则', () => {
  const env = buildServerEnv({ HTTPS_PROXY: 'http://10.0.0.1:1080' }, 'HTTPS_PROXY=http://127.0.0.1:18081\n');
  assert.equal(env.HTTPS_PROXY, 'http://10.0.0.1:1080');
});

test('设成 0 就是明确关掉，不被默认值盖回去', () => {
  assert.equal(buildServerEnv({}, 'NODE_USE_ENV_PROXY=0\nHTTPS_PROXY=http://127.0.0.1:18081\n').NODE_USE_ENV_PROXY, '0');
  assert.equal(buildServerEnv({ NODE_USE_ENV_PROXY: '0' }, '').NODE_USE_ENV_PROXY, '0');
});

test('有代理没写例外时，本机地址默认直连；写了就照写的来', () => {
  assert.equal(buildServerEnv({}, 'HTTPS_PROXY=http://127.0.0.1:18081\n').NO_PROXY, 'localhost,127.0.0.1,::1');
  assert.equal(buildServerEnv({}, 'HTTPS_PROXY=http://127.0.0.1:18081\nNO_PROXY=.aliyuncs.com\n').NO_PROXY, '.aliyuncs.com');
  // 小写写法同样算写了
  assert.equal(buildServerEnv({ no_proxy: '.qq.com' }, 'HTTPS_PROXY=http://127.0.0.1:18081\n').NO_PROXY, undefined);
});

test('没配代理时什么都不多加，开关打开也只是空转', () => {
  const env = buildServerEnv({ PATH: '/usr/bin' }, '# 只有注释\nLLMSOCIAL_PORT=8787\n');
  assert.equal(env.NO_PROXY, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.LLMSOCIAL_PORT, '8787');
  assert.equal(env.PATH, '/usr/bin');
});
