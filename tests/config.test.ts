import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { PROJECT_ROOT, loadConfig } from '../src/server/config.ts';

test('配置：回调端口默认听所有网卡，可以改成只听本机', () => {
  assert.equal(loadConfig({}).webhookHost, '0.0.0.0');
  assert.equal(loadConfig({ LLMSOCIAL_WEBHOOK_HOST: '127.0.0.1' }).webhookHost, '127.0.0.1');
});

test('配置：.env 里留空的项按默认值算，不会变成项目根目录或所有网卡', () => {
  const config = loadConfig({ LLMSOCIAL_DATA_DIR: '', LLMSOCIAL_HOST: '', LLMSOCIAL_WEBHOOK_HOST: '' });
  assert.equal(config.dataDir, path.join(PROJECT_ROOT, 'data'));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.webhookHost, '0.0.0.0');
});

test('配置：数据目录写绝对路径就用绝对路径', () => {
  const abs = path.resolve('/tmp/llmsocial-somewhere');
  assert.equal(loadConfig({ LLMSOCIAL_DATA_DIR: abs }).dataDir, abs);
});
