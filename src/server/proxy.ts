import { Agent, EnvHttpProxyAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import type { Settings } from '../shared/types.ts';

/** Local addresses and mainland-China services: straight out, so they keep working with the VPN off. */
export const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1,.aliyuncs.com,.qq.com,.deepseek.com,.moonshot.cn,.bigmodel.cn';

export type ProxySettings = Pick<Settings, 'proxyEnabled' | 'proxyUrl' | 'noProxy'>;

let installed: Dispatcher | null = null;

/**
 * Point every outbound request at the proxy, or straight out.
 *
 * Every connector and every model SDK ends up in Node's own fetch, and that fetch asks one global
 * dispatcher how to connect — so replacing the dispatcher is one switch that covers them all, and it
 * takes effect for the next request, no restart. Node's NODE_USE_ENV_PROXY is not used: it is read
 * once at startup, which is exactly what made a switch impossible. The browser is no guide here —
 * it follows the Windows system proxy, Node never does.
 */
export function applyProxy(s: ProxySettings): 'proxy' | 'direct' {
  const url = s.proxyUrl.trim();
  const next = s.proxyEnabled && url !== '' ? new EnvHttpProxyAgent({ httpProxy: url, httpsProxy: url, noProxy: s.noProxy }) : new Agent();
  const previous = installed;
  setGlobalDispatcher(next);
  installed = next;
  // Let requests already on the old one finish, then free its sockets.
  if (previous) void previous.close().catch(() => undefined);
  return next instanceof EnvHttpProxyAgent ? 'proxy' : 'direct';
}

/**
 * A proxy written in .env before this switch existed moves into settings once, the first time the
 * app starts with nothing stored. After that the settings page owns it and .env is not read again.
 */
export function importProxyFromEnv(current: ProxySettings, storedAlready: boolean, env: NodeJS.ProcessEnv): ProxySettings | null {
  if (storedAlready) return null;
  const url = (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '').trim();
  if (url === '') return null;
  return { proxyEnabled: true, proxyUrl: url, noProxy: (env.NO_PROXY || env.no_proxy || current.noProxy).trim() };
}

/**
 * Why a request never got an answer, in words that say what to do next; the raw code stays in
 * brackets for whoever debugs it. Reads as the second half of 「连不上，…」.
 */
export function explainNetworkError(err: unknown, s: ProxySettings): string {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : null;
  const code = cause && 'code' in cause && typeof cause.code === 'string' ? cause.code : err instanceof Error ? err.name : String(err);
  const on = s.proxyEnabled && s.proxyUrl.trim() !== '';
  // Platforms don't refuse connections on 443; with the switch on, a refusal is the proxy port itself.
  if (code === 'ECONNREFUSED' && on) return `代理没有应答——VPN 开着吗？代理地址和端口对吗？（${code}）`;
  if (code === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return on ? `没有回应（${code}）` : `没有回应——要开 VPN 才能访问的话，打开上面的代理开关（${code}）`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `找不到这个网址——网断了吗？（${code}）`;
  return `出错了（${code}）`;
}

/** For the startup banner: where the proxy points, without any username or password in the URL. */
export function describeProxy(s: ProxySettings): string {
  if (!s.proxyEnabled || s.proxyUrl.trim() === '') return '';
  try {
    const u = new URL(s.proxyUrl.trim());
    return `${u.protocol}//${u.host}`;
  } catch {
    return '（地址格式不对，去设置页改）';
  }
}
