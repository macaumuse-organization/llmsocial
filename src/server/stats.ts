import type { AccountStatus, FunnelRow, PlatformId, Stage, Stats } from '../shared/types.ts';
import { STAGES } from '../shared/types.ts';
import { parseJson, type Db } from './db/index.ts';
import type { Repos } from './db/repos.ts';
import { DAY, type Clock } from './util.ts';

function emptyStages(): Record<Stage, number> {
  return Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
}

export function buildStats(db: Db, repos: Repos, clock: Clock, days = 14): Stats {
  const now = clock.now();
  const since = now - days * DAY;

  const counts = db.get<{ total: number; active: number; handoff: number; optedOut: number }>(
    `SELECT COUNT(*) AS total,
       SUM(state = 'active') AS active,
       SUM(state = 'handoff') AS handoff,
       SUM(state = 'opted_out') AS optedOut
     FROM conversations`,
  ) ?? { total: 0, active: 0, handoff: 0, optedOut: 0 };

  const needsAction =
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM conversations c
       WHERE c.state = 'handoff' OR c.unread > 0
         OR EXISTS (SELECT 1 FROM messages m WHERE m.conversationId = c.id AND m.status IN ('pending_approval', 'failed'))`,
    )?.n ?? 0;

  // Local calendar days, so the chart lines up with what the operator sees on their own clock.
  const messages = db.all<{ day: string; inbound: number; outbound: number }>(
    `SELECT date(COALESCE(sentAt, createdAt) / 1000, 'unixepoch', 'localtime') AS day,
       SUM(direction = 'in') AS inbound,
       SUM(direction = 'out' AND status = 'sent') AS outbound
     FROM messages WHERE COALESCE(sentAt, createdAt) > ? GROUP BY day ORDER BY day`,
    since,
  );

  const funnelRows = db.all<{ campaignId: string | null; campaignName: string | null; stage: Stage; state: string; n: number }>(
    `SELECT c.campaignId, cp.name AS campaignName, c.stage, c.state, COUNT(*) AS n
     FROM conversations c LEFT JOIN campaigns cp ON cp.id = c.campaignId
     GROUP BY c.campaignId, c.stage, c.state`,
  );
  const funnelMap = new Map<string, FunnelRow>();
  for (const row of funnelRows) {
    const key = row.campaignId ?? '';
    let entry = funnelMap.get(key);
    if (!entry) {
      entry = { campaignId: row.campaignId, campaignName: row.campaignName ?? '（未指定任务）', total: 0, byStage: emptyStages(), optedOut: 0, handoff: 0 };
      funnelMap.set(key, entry);
    }
    entry.total += row.n;
    if (row.stage in entry.byStage) entry.byStage[row.stage] += row.n;
    if (row.state === 'opted_out') entry.optedOut += row.n;
    if (row.state === 'handoff') entry.handoff += row.n;
  }

  const llm = db.all<{ providerName: string; model: string; calls: number; failures: number; inputTokens: number; outputTokens: number; costUsd: number | null; avgLatencyMs: number }>(
    `SELECT providerName, model, COUNT(*) AS calls, SUM(ok = 0) AS failures,
       SUM(inputTokens) AS inputTokens, SUM(outputTokens) AS outputTokens,
       SUM(costUsd) AS costUsd, AVG(latencyMs) AS avgLatencyMs
     FROM llm_calls WHERE createdAt > ? GROUP BY providerName, model ORDER BY calls DESC`,
    since,
  );

  // Median, not mean: one conversation answered three days late would otherwise dominate.
  const gaps = db.all<{ gap: number }>(
    `SELECT (out.sentAt - inb.sentAt) AS gap FROM messages out
     JOIN messages inb ON inb.id = (
       SELECT id FROM messages m WHERE m.conversationId = out.conversationId AND m.direction = 'in' AND m.rowid < out.rowid ORDER BY m.rowid DESC LIMIT 1)
     WHERE out.direction = 'out' AND out.status = 'sent' AND out.sentAt IS NOT NULL AND inb.sentAt IS NOT NULL
       AND out.sentAt > ? AND out.sentAt >= inb.sentAt
     ORDER BY gap`,
    since,
  );
  const medianReplySeconds = gaps.length === 0 ? null : Math.round(gaps[Math.floor(gaps.length / 2)]!.gap / 1000);

  // Derived rather than stored: the message table already knows, and a column would be one more
  // write on every ingest and every send.
  const lastInbound = new Map(db.all<{ accountId: string; t: number }>("SELECT accountId, MAX(createdAt) AS t FROM messages WHERE direction = 'in' GROUP BY accountId").map((r) => [r.accountId, r.t]));
  const lastSent = new Map(db.all<{ accountId: string; t: number }>("SELECT accountId, MAX(sentAt) AS t FROM messages WHERE direction = 'out' AND status = 'sent' GROUP BY accountId").map((r) => [r.accountId, r.t]));

  const sentToday = new Map(
    db
      .all<{ accountId: string; n: number }>("SELECT accountId, COUNT(*) AS n FROM messages WHERE direction = 'out' AND status = 'sent' AND sentAt > ? GROUP BY accountId", now - DAY)
      .map((r) => [r.accountId, r.n]),
  );

  const shareCounts = new Map<string, Stats['materials'][number]>();
  for (const row of db.all<{ data: string }>("SELECT data FROM events WHERE type = 'material_shared' AND ts > ?", since)) {
    const d = parseJson<{ materialId?: string; title?: string; campaignId?: string }>(row.data, {});
    if (!d.materialId || !d.campaignId) continue;
    const key = `${d.campaignId}/${d.materialId}`;
    let entry = shareCounts.get(key);
    if (!entry) {
      const campaign = repos.campaigns.get(d.campaignId);
      // The campaign's current title wins, so renaming an item does not split it into two rows.
      entry = { campaignId: d.campaignId, campaignName: campaign?.name ?? '（已删除的任务）', materialId: d.materialId, title: campaign?.materials.find((m) => m.id === d.materialId)?.title ?? d.title ?? d.materialId, shares: 0 };
      shareCounts.set(key, entry);
    }
    entry.shares++;
  }

  return {
    conversations: { total: counts.total, active: counts.active ?? 0, handoff: counts.handoff ?? 0, optedOut: counts.optedOut ?? 0, needsAction },
    materials: [...shareCounts.values()].sort((a, b) => b.shares - a.shares),
    messages,
    funnel: [...funnelMap.values()].sort((a, b) => b.total - a.total),
    llm: llm.map((r) => ({ ...r, costUsd: r.costUsd ?? 0, avgLatencyMs: Math.round(r.avgLatencyMs) })),
    llmCallsToday: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM llm_calls WHERE createdAt > ? AND purpose != 'test'", now - DAY)?.n ?? 0,
    medianReplySeconds,
    accounts: repos.accounts.list().map((a) => ({
      id: a.id,
      name: a.name,
      platform: a.platform as PlatformId,
      status: a.status as AccountStatus,
      statusDetail: a.statusDetail,
      sentToday: sentToday.get(a.id) ?? 0,
      maxPerDay: a.maxPerDay,
      lastInboundAt: lastInbound.get(a.id) ?? null,
      lastSentAt: lastSent.get(a.id) ?? null,
    })),
  };
}
