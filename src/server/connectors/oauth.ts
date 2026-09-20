import { createHash, randomBytes } from 'node:crypto';
import { ConnectorError, type ConnectorContext } from './types.ts';

/**
 * OAuth 2.0 authorization code + PKCE for the two platforms that need it:
 * Google (YouTube comments) and X. Shared config fields: clientId (config), clientSecret (secret).
 */

export type OAuthKind = 'google' | 'x';

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const X_AUTH_URL = 'https://x.com/i/oauth2/authorize';
const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const X_SCOPE = 'tweet.read tweet.write users.read dm.read dm.write offline.access';

/** Refresh this long before the platform's stated expiry. */
const REFRESH_SKEW_MS = 120_000;

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function buildAuthUrl(kind: OAuthKind, p: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
  const url = new URL(kind === 'google' ? GOOGLE_AUTH_URL : X_AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('scope', kind === 'google' ? GOOGLE_SCOPE : X_SCOPE);
  url.searchParams.set('state', p.state);
  url.searchParams.set('code_challenge', p.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (kind === 'google') {
    // Without both of these Google returns a refresh token only on the very first consent.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
  }
  return url.toString();
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/** Only the error code and description travel out of here; never the body, which can echo credentials. */
function describeError(status: number, parsed: TokenResponse | null): string {
  const code = typeof parsed?.error === 'string' ? parsed.error : '';
  const desc = typeof parsed?.error_description === 'string' ? parsed.error_description.slice(0, 200) : '';
  return `${status}${code ? ` ${code}` : ''}${desc ? `: ${desc}` : ''}`;
}

async function postToken(
  kind: OAuthKind,
  p: { clientId: string; clientSecret: string | null; fetch: typeof fetch; now: number; form: Record<string, string>; previousRefreshToken?: string | null },
): Promise<TokenSet> {
  const url = kind === 'google' ? GOOGLE_TOKEN_URL : X_TOKEN_URL;
  const form = new URLSearchParams(p.form);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (kind === 'google') {
    form.set('client_id', p.clientId);
    if (p.clientSecret) form.set('client_secret', p.clientSecret);
  } else {
    // X wants client_id in the form for both client types, plus Basic auth when the app is confidential.
    form.set('client_id', p.clientId);
    if (p.clientSecret) headers.authorization = `Basic ${Buffer.from(`${p.clientId}:${p.clientSecret}`).toString('base64')}`;
  }

  let res: Response;
  try {
    res = await p.fetch(url, { method: 'POST', headers, body: form.toString(), signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new ConnectorError('transient', `token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let parsed: TokenResponse | null = null;
  try {
    parsed = text === '' ? {} : (JSON.parse(text) as TokenResponse);
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const detail = describeError(res.status, parsed);
    if (res.status === 400 || res.status === 401) throw new ConnectorError('auth', `授权失败 ${detail}`);
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new ConnectorError('rate_limited', `token endpoint ${detail}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null);
    }
    if (res.status === 403) throw new ConnectorError('blocked', `token endpoint ${detail}`);
    if (res.status >= 500) throw new ConnectorError('transient', `token endpoint ${detail}`);
    throw new ConnectorError('invalid', `token endpoint ${detail}`);
  }
  if (parsed === null || typeof parsed.access_token !== 'string' || parsed.access_token === '') {
    throw new ConnectorError('auth', 'token endpoint returned no access_token');
  }
  const expiresIn = typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : 3600;
  const rotated = typeof parsed.refresh_token === 'string' && parsed.refresh_token !== '' ? parsed.refresh_token : null;
  return {
    accessToken: parsed.access_token,
    // X rotates on every refresh; Google usually omits it, so the stored one stays valid.
    refreshToken: rotated ?? p.previousRefreshToken ?? null,
    expiresAt: p.now + expiresIn * 1000,
  };
}

export function exchangeCode(
  kind: OAuthKind,
  p: { clientId: string; clientSecret: string | null; redirectUri: string; code: string; codeVerifier: string; fetch: typeof fetch; now: number },
): Promise<TokenSet> {
  return postToken(kind, {
    clientId: p.clientId,
    clientSecret: p.clientSecret,
    fetch: p.fetch,
    now: p.now,
    form: { grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier },
  });
}

export function refreshTokens(
  kind: OAuthKind,
  p: { clientId: string; clientSecret: string | null; refreshToken: string; fetch: typeof fetch; now: number },
): Promise<TokenSet> {
  return postToken(kind, {
    clientId: p.clientId,
    clientSecret: p.clientSecret,
    fetch: p.fetch,
    now: p.now,
    form: { grant_type: 'refresh_token', refresh_token: p.refreshToken },
    previousRefreshToken: p.refreshToken,
  });
}

export function storeTokens(ctx: ConnectorContext, t: TokenSet): void {
  ctx.setSecret('accessToken', t.accessToken);
  if (t.refreshToken) ctx.setSecret('refreshToken', t.refreshToken);
  ctx.setCursor({ ...ctx.getCursor(), tokenExpiresAt: t.expiresAt });
}

function storedExpiry(ctx: ConnectorContext): number {
  const value = ctx.getCursor().tokenExpiresAt;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * One refresh at a time per account: X invalidates the old refresh token the moment it issues a new
 * one, so two concurrent refreshes would leave the loser holding a dead token.
 */
const refreshChains = new Map<string, Promise<string>>();

async function refreshOnce(ctx: ConnectorContext, kind: OAuthKind): Promise<string> {
  // Another waiter on this chain may have just refreshed.
  const fresh = await ctx.getSecret('accessToken');
  if (fresh && storedExpiry(ctx) - ctx.now() > REFRESH_SKEW_MS) return fresh;

  const refreshToken = await ctx.getSecret('refreshToken');
  if (!refreshToken) throw new ConnectorError('auth', '缺少 refresh token，请重新授权该账号');
  const clientId = ctx.config.clientId;
  if (!clientId) throw new ConnectorError('auth', '未配置 clientId');
  const clientSecret = await ctx.getSecret('clientSecret');

  const tokens = await refreshTokens(kind, { clientId, clientSecret, refreshToken, fetch: ctx.fetch, now: ctx.now() });
  storeTokens(ctx, tokens);
  return tokens.accessToken;
}

export async function accessTokenFor(ctx: ConnectorContext, kind: OAuthKind): Promise<string> {
  const access = await ctx.getSecret('accessToken');
  if (access && storedExpiry(ctx) - ctx.now() > REFRESH_SKEW_MS) return access;

  const key = ctx.account.id;
  const previous = refreshChains.get(key) ?? Promise.resolve('');
  const next = previous.then(
    () => refreshOnce(ctx, kind),
    () => refreshOnce(ctx, kind),
  );
  refreshChains.set(key, next);
  try {
    return await next;
  } finally {
    if (refreshChains.get(key) === next) refreshChains.delete(key);
  }
}
