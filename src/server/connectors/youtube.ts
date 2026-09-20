import { accessTokenFor } from './oauth.ts';
import { ConnectorError, type Connector, type ConnectorContext, type InboundMessage } from './types.ts';

const API = 'https://www.googleapis.com/youtube/v3';
/** Politeness cap: a backlog is drained over several polls instead of one long walk. */
const MAX_PAGES = 3;
const FIRST_POLL_WINDOW_MS = 24 * 60 * 60 * 1000;

interface YtChannel {
  id?: string;
  snippet?: { title?: string };
}

interface YtCommentSnippet {
  textOriginal?: string;
  authorDisplayName?: string;
  authorProfileImageUrl?: string;
  authorChannelId?: { value?: string };
  publishedAt?: string;
  videoId?: string;
}

interface YtComment {
  id?: string;
  snippet?: YtCommentSnippet;
}

interface YtThread {
  id?: string;
  snippet?: { videoId?: string; topLevelComment?: YtComment };
  replies?: { comments?: YtComment[] };
}

interface YtListResponse<T> {
  items?: T[];
  nextPageToken?: string;
}

const PACIFIC_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Daily quota resets at midnight Pacific. DST days are 23 or 25 hours, which only skews a retry by an hour twice a year. */
function msUntilPacificMidnight(now: number): number {
  const parts = PACIFIC_CLOCK.formatToParts(new Date(now));
  const field = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const elapsed = field('hour') * 3_600_000 + field('minute') * 60_000 + field('second') * 1000;
  return Math.max(60_000, 86_400_000 - elapsed) + 60_000;
}

/** Google puts the machine-readable cause in error.errors[].reason; everything else in the body is prose. */
function errorReason(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { errors?: { reason?: unknown }[]; status?: unknown } };
    const reason = parsed.error?.errors?.[0]?.reason;
    if (typeof reason === 'string') return reason;
    return typeof parsed.error?.status === 'string' ? parsed.error.status : '';
  } catch {
    return '';
  }
}

function mapError(ctx: ConnectorContext, res: Response, body: string): ConnectorError {
  const reason = errorReason(body);
  // Only status + reason travel outwards: the raw body is never logged, and never carries the token.
  const detail = `${res.status}${reason ? ` ${reason}` : ''}`;
  if (res.status === 401) return new ConnectorError('auth', `${detail}：访问令牌失效，请重新授权`);
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    return new ConnectorError('rate_limited', detail, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000);
  }
  if (res.status >= 500) return new ConnectorError('transient', detail);
  if (res.status === 403) {
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      return new ConnectorError('rate_limited', `${detail}：当日配额已用尽`, msUntilPacificMidnight(ctx.now()));
    }
    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') return new ConnectorError('rate_limited', detail, 60_000);
    if (reason === 'authorizationRequired' || reason === 'insufficientPermissions') return new ConnectorError('auth', `${detail}：授权范围不足`);
    return new ConnectorError('blocked', detail);
  }
  if (res.status === 404) return new ConnectorError('blocked', `${detail}：目标评论已不存在`);
  if (res.status === 400) {
    if (reason === 'processingFailure') return new ConnectorError('transient', detail);
    // operationNotSupported / parentCommentIsPrivate: the thread itself refuses replies, not our request.
    if (reason === 'operationNotSupported' || reason === 'parentCommentIsPrivate') return new ConnectorError('blocked', `${detail}：该评论不允许回复`);
  }
  return new ConnectorError('invalid', detail);
}

/**
 * apiJson flattens every 403 to `blocked`, but YouTube signals quota exhaustion with one, and that has to
 * become rate_limited with a reset time — so the error envelope is inspected here instead.
 */
async function ytRequest<T>(ctx: ConnectorContext, url: string, opts: { token: string; method?: string; body?: unknown }): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.token}`, accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ConnectorError('transient', `network: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  if (!res.ok) throw mapError(ctx, res, text);
  try {
    return (text === '' ? {} : JSON.parse(text)) as T;
  } catch {
    throw new ConnectorError('transient', 'YouTube 返回了非 JSON 响应');
  }
}

function mergeCursor(ctx: ConnectorContext, patch: Record<string, unknown>): void {
  ctx.setCursor({ ...ctx.getCursor(), ...patch });
}

function parseTs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

async function ownChannel(ctx: ConnectorContext, token: string): Promise<YtChannel | null> {
  const data = await ytRequest<YtListResponse<YtChannel>>(ctx, `${API}/channels?part=snippet&mine=true`, { token });
  return data.items?.[0] ?? null;
}

async function channelId(ctx: ConnectorContext, token: string): Promise<string> {
  const cached = ctx.getCursor().channelId;
  if (typeof cached === 'string' && cached !== '') return cached;
  const channel = await ownChannel(ctx, token);
  if (!channel?.id) throw new ConnectorError('invalid', '这个 Google 账号名下没有 YouTube 频道');
  mergeCursor(ctx, { channelId: channel.id });
  return channel.id;
}

function toMessage(comment: YtComment, threadId: string, threadTitle: string, selfChannelId: string, since: number): InboundMessage | null {
  const snippet = comment.snippet;
  if (typeof comment.id !== 'string' || comment.id === '' || !snippet) return null;
  const timestamp = parseTs(snippet.publishedAt);
  if (timestamp === null || timestamp <= since) return null;
  const text = typeof snippet.textOriginal === 'string' ? snippet.textOriginal : '';
  if (text === '') return null;
  const authorId = typeof snippet.authorChannelId?.value === 'string' ? snippet.authorChannelId.value : '';
  return {
    platformMsgId: comment.id,
    kind: 'comment',
    threadRef: threadId,
    threadTitle,
    contact: {
      platformUserId: authorId === '' ? comment.id : authorId,
      displayName: typeof snippet.authorDisplayName === 'string' ? snippet.authorDisplayName.slice(0, 100) : undefined,
      avatarUrl: typeof snippet.authorProfileImageUrl === 'string' ? snippet.authorProfileImageUrl : undefined,
    },
    text: text.slice(0, 8000),
    timestamp,
    fromSelf: authorId !== '' && authorId === selfChannelId,
    // Replies hang off the top-level comment, so every reply in a thread shares one parent id.
    replyToRef: threadId,
  };
}

export const youtubeConnector: Connector = {
  meta: {
    kind: 'youtube',
    label: 'YouTube',
    description: '用 YouTube Data API v3 读取自己频道视频下的评论和回复，并以频道身份回复。平台没有开放私信接口，所以只做评论。',
    platforms: ['youtube'],
    canSend: true,
    canPoll: true,
    usesWebhook: false,
    oauth: 'google',
    untestedLive: true,
    fields: [
      {
        key: 'clientId',
        label: 'OAuth 客户端 ID',
        required: true,
        placeholder: '123456789-xxxx.apps.googleusercontent.com',
        help: '在 Google Cloud 控制台「API 和服务 → 凭据」里创建的 Web 应用客户端 ID。',
      },
      { key: 'clientSecret', label: 'OAuth 客户端密钥', secret: true, required: true, help: '与客户端 ID 一起生成，只存在本机的加密凭据库里。' },
    ],
    setupNotes: [
      '1）在 Google Cloud 控制台建一个项目，启用「YouTube Data API v3」。',
      '2）配置 OAuth 同意屏幕（用户类型选「外部」），把要接入的 Google 账号加进测试用户；应用停留在「测试」状态时，refresh token 7 天就会失效，需要重新授权，长期使用请把应用发布为「正式版」。',
      '3）凭据类型选「Web 应用」，在「已获授权的重定向 URI」里填 http://127.0.0.1:<llmsocial 端口>/oauth/callback（授权时页面会显示确切地址，必须一字不差）。',
      '4）需要的权限范围只有一个：https://www.googleapis.com/auth/youtube.force-ssl，读评论和发回复都靠它。',
      '5）授权的 Google 账号必须已经有 YouTube 频道并完成账号合并，否则发回复会返回 403 ineligibleAccount。',
      '配额：默认每天 10000 单位。拉一页评论（commentThreads.list）1 单位，发一条回复（comments.insert）50 单位，也就是一天最多约 200 条回复。配额在太平洋时间午夜重置，用尽时返回 403 quotaExceeded，llmsocial 会自动等到下一个重置点。',
      '已知限制：只能读到自己频道视频下的评论，读不到别人频道；列表按顶层评论时间排序，老视频下新冒出来的回复不会重新排到最前，可能要下一轮才抓到；commentThreads 每个话题只带回一部分回复，超长回复串可能漏掉几条；某个账号第一次轮询只取最近 24 小时，更早的历史评论不会灌进来。',
      'YouTube 对评论回复没有时间窗限制，但视频关闭评论或评论被设为仅限审核后就无法回复。',
    ].join('\n'),
  },

  async test(ctx) {
    try {
      const token = await accessTokenFor(ctx, 'google');
      const channel = await ownChannel(ctx, token);
      if (!channel?.id) return { ok: false, detail: '授权成功，但这个 Google 账号名下没有 YouTube 频道' };
      mergeCursor(ctx, { channelId: channel.id });
      return { ok: true, detail: `已连接频道「${channel.snippet?.title ?? channel.id}」` };
    } catch (err) {
      return { ok: false, detail: err instanceof ConnectorError ? `连接失败（${err.code}）：${err.message}` : '连接失败' };
    }
  },

  async poll(ctx) {
    const token = await accessTokenFor(ctx, 'google');
    const selfChannelId = await channelId(ctx, token);
    const stored = ctx.getCursor().lastPublishedAt;
    const since = typeof stored === 'number' && Number.isFinite(stored) ? stored : ctx.now() - FIRST_POLL_WINDOW_MS;

    const messages: InboundMessage[] = [];
    let newest = since;
    let pageToken = '';

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(`${API}/commentThreads`);
      url.searchParams.set('part', 'snippet,replies');
      url.searchParams.set('allThreadsRelatedToChannelId', selfChannelId);
      url.searchParams.set('order', 'time');
      url.searchParams.set('maxResults', '50');
      if (pageToken !== '') url.searchParams.set('pageToken', pageToken);

      const data = await ytRequest<YtListResponse<YtThread>>(ctx, url.toString(), { token });
      let reachedCursor = false;

      for (const thread of data.items ?? []) {
        const top = thread.snippet?.topLevelComment;
        if (typeof thread.id !== 'string' || thread.id === '' || !top) continue;
        const videoId = thread.snippet?.videoId ?? top.snippet?.videoId;
        const threadTitle = typeof videoId === 'string' && videoId !== '' ? `视频 ${videoId}` : '频道留言';

        const topTs = parseTs(top.snippet?.publishedAt);
        if (topTs !== null && topTs <= since) reachedCursor = true;

        for (const comment of [top, ...(thread.replies?.comments ?? [])]) {
          const message = toMessage(comment, thread.id, threadTitle, selfChannelId, since);
          if (message === null) continue;
          messages.push(message);
          if (message.timestamp > newest) newest = message.timestamp;
        }
      }

      pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
      // Newest-first ordering: once a page starts on threads older than the cursor, the rest is history.
      if (pageToken === '' || reachedCursor) break;
    }

    if (newest > since) mergeCursor(ctx, { lastPublishedAt: newest });
    return messages;
  },

  async send(ctx, req) {
    if (req.kind !== 'comment') throw new ConnectorError('unsupported', 'YouTube 没有开放私信接口，这个账号只能回复评论');
    const parentId = req.replyToRef ?? req.threadRef;
    if (!parentId) throw new ConnectorError('invalid', '缺少要回复的顶层评论 id');
    if (req.text.trim() === '') throw new ConnectorError('invalid', '回复内容不能为空');

    const token = await accessTokenFor(ctx, 'google');
    const data = await ytRequest<{ id?: unknown }>(ctx, `${API}/comments?part=snippet`, {
      token,
      method: 'POST',
      body: { snippet: { parentId, textOriginal: req.text } },
    });
    return { platformMsgId: typeof data.id === 'string' ? data.id : undefined };
  },
};
