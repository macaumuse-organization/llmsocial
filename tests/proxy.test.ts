import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { applyProxy, DEFAULT_NO_PROXY, describeProxy, explainNetworkError, importProxyFromEnv } from '../src/server/proxy.ts';

async function listen(server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

function shut(server: http.Server): void {
  // Keep-alive sockets from the agents would otherwise hold close() open until they time out.
  server.closeAllConnections();
  server.close();
}

test('开关打开时请求真的经过代理，关掉就直连，直连名单里的地址不经过代理——都不用重启', async () => {
  const target = http.createServer((_req, res) => res.end('target'));
  const targetPort = await listen(target);
  const seen: string[] = [];
  const tunnels = new Set<net.Socket>();
  // A minimal tunnelling proxy, like the VPN's: undici always opens a CONNECT tunnel, even to http targets.
  const proxy = http.createServer((_req, res) => {
    res.writeHead(502).end('expected CONNECT');
  });
  proxy.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    seen.push(req.url ?? '');
    const [host, port] = (req.url ?? '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    tunnels.add(client).add(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  const url = `http://127.0.0.1:${targetPort}/hello`;

  try {
    assert.equal(applyProxy({ proxyEnabled: true, proxyUrl, noProxy: '' }), 'proxy');
    assert.equal(await (await fetch(url)).text(), 'target');
    assert.deepEqual(seen, [`127.0.0.1:${targetPort}`], '打开之后应该经过代理');

    assert.equal(applyProxy({ proxyEnabled: false, proxyUrl, noProxy: '' }), 'direct');
    assert.equal(await (await fetch(url)).text(), 'target');
    assert.equal(seen.length, 1, '关掉之后不该再经过代理');

    applyProxy({ proxyEnabled: true, proxyUrl, noProxy: '127.0.0.1' });
    assert.equal(await (await fetch(url)).text(), 'target');
    assert.equal(seen.length, 1, '直连名单里的地址不该经过代理');

    // Enabled but no address is direct, not a broken proxy.
    assert.equal(applyProxy({ proxyEnabled: true, proxyUrl: '  ', noProxy: '' }), 'direct');
  } finally {
    applyProxy({ proxyEnabled: false, proxyUrl: '', noProxy: '' });
    for (const s of tunnels) s.destroy();
    shut(target);
    shut(proxy);
  }
});

test('.env 里原来写的代理，第一次启动时搬进设置，之后设置页说了算', () => {
  const current = { proxyEnabled: false, proxyUrl: '', noProxy: DEFAULT_NO_PROXY };
  assert.deepEqual(importProxyFromEnv(current, false, { HTTPS_PROXY: 'http://127.0.0.1:18081' }), { proxyEnabled: true, proxyUrl: 'http://127.0.0.1:18081', noProxy: DEFAULT_NO_PROXY });
  assert.deepEqual(importProxyFromEnv(current, false, { HTTPS_PROXY: 'http://127.0.0.1:18081', NO_PROXY: '.qq.com' })?.noProxy, '.qq.com');
  // 已经在设置页存过（哪怕存的是关），就不再从 .env 覆盖
  assert.equal(importProxyFromEnv(current, true, { HTTPS_PROXY: 'http://127.0.0.1:18081' }), null);
  assert.equal(importProxyFromEnv(current, false, {}), null);
});

test('启动提示里的代理地址不带用户名密码', () => {
  assert.equal(describeProxy({ proxyEnabled: true, proxyUrl: 'http://user:secret@127.0.0.1:18081', noProxy: '' }), 'http://127.0.0.1:18081');
  assert.equal(describeProxy({ proxyEnabled: false, proxyUrl: 'http://127.0.0.1:18081', noProxy: '' }), '');
});

test('测试网络连不上时说人话：VPN 没开、没开代理开关、网断了', async () => {
  // A port nobody listens on stands in for the VPN being off while the switch is on.
  const closed = http.createServer();
  const port = await listen(closed);
  closed.close();
  const vpnOff = { proxyEnabled: true, proxyUrl: `http://127.0.0.1:${port}`, noProxy: '' };
  applyProxy(vpnOff);
  let refused: unknown;
  try {
    await fetch('http://example.invalid/');
  } catch (err) {
    refused = err;
  } finally {
    applyProxy({ proxyEnabled: false, proxyUrl: '', noProxy: '' });
  }
  assert.match(explainNetworkError(refused, vpnOff), /^代理没有应答——VPN 开着吗？.*（ECONNREFUSED）$/);

  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const off = { proxyEnabled: false, proxyUrl: 'http://127.0.0.1:18081', noProxy: '' };
  assert.match(explainNetworkError(timeout, off), /打开上面的代理开关（TimeoutError）$/);
  assert.equal(explainNetworkError(timeout, { ...off, proxyEnabled: true }), '没有回应（TimeoutError）');

  const dns = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }) });
  assert.match(explainNetworkError(dns, off), /^找不到这个网址.*（ENOTFOUND）$/);
  assert.equal(explainNetworkError(new Error('boom'), off), '出错了（Error）');
});
