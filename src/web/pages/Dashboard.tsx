import type { AccountStatus, EventRow, FunnelRow, Stats } from '../../shared/types.ts';
import { STAGES } from '../../shared/types.ts';
import { AsyncButton, Empty, Loading, PLATFORM_LABELS, STAGE_LABELS, api, clockTime, duration, useAsync } from '../ui.tsx';

/** Human wording for the event types the engine writes. Unknown types fall back to the raw name. */
const EVENT_LABELS: Record<string, string> = {
  opt_out: '对方要求停止联系',
  handoff: '转人工',
  guard_blocked: '回复被安全检查拦下',
  send_failed: '发送失败',
  draft_created: '生成草稿',
  material_shared: '分享了素材',
  draft_approved: '草稿已批准',
  account_needs_auth: '账号需要重新授权',
  llm_failed: '模型调用失败',
  settings_autopilot: '自动发送开关变更',
  autopilot_paused_operator_reply: '你手动回复后已转为起草模式',
  send_interrupted: '发送中断',
  webhook_failed: '回调处理失败',
  inbound_stale: '收到过期消息（未回复）',
  followup_scan: '跟进扫描',
  ai_wait: 'AI 判断无需回复',
  generate_skipped: '跳过生成',
  autopilot_paused_external_reply: '你在平台上回复后已转为起草模式',
  account_poll_failing: '账号拉取持续失败',
};

const ACCOUNT_STATUS: Record<AccountStatus, { label: string; cls: string }> = {
  active: { label: '正常', cls: 'badge accent' },
  paused: { label: '已暂停', cls: 'badge' },
  error: { label: '出错', cls: 'badge danger' },
  needs_auth: { label: '需重新授权', cls: 'badge warn' },
};

const pct = (value: number, total: number) => (total > 0 ? `${Math.round((value / total) * 100)}%` : '0%');

function eventText(row: EventRow): string {
  const json = JSON.stringify(row.data ?? {});
  if (json === '{}') return '';
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

export function DashboardPage() {
  const stats = useAsync(() => api.stats(), []);
  const events = useAsync(() => api.events({ limit: 60 }), []);

  return (
    <>
      <div className="topbar">
        <h1>总览</h1>
        <div className="spacer" />
        <AsyncButton
          onClick={async () => {
            await Promise.all([stats.reload(), events.reload()]);
          }}
        >
          刷新
        </AsyncButton>
      </div>
      <div className="page">
        <div className="stack page-narrow">
          {stats.error ? <div className="notice danger">{stats.error}</div> : null}
          {stats.loading && !stats.data ? <Loading /> : null}
          {stats.data ? <StatsBody stats={stats.data} /> : null}

          <div className="card">
            <div className="card-head">
              <h2 className="grow">最近事件</h2>
              <span className="faint small">最近 60 条</span>
            </div>
            {events.error ? (
              <div className="card-pad">
                <div className="notice danger">{events.error}</div>
              </div>
            ) : events.loading && !events.data ? (
              <Loading />
            ) : !events.data || events.data.length === 0 ? (
              <Empty>还没有任何动静。接上账号、跑一轮沙盒，这里就会记下每一次生成、发送和拦截。</Empty>
            ) : (
              <div className="stack card-pad" style={{ gap: 4 }}>
                {events.data.map((row) => (
                  <div key={row.id} className={row.level === 'error' ? 'notice danger' : row.level === 'warn' ? 'notice warn' : 'notice'}>
                    <div className="row-tight">
                      <span className="mono faint">{clockTime(row.ts)}</span>
                      <span className="grow">{EVENT_LABELS[row.type] ?? row.type}</span>
                    </div>
                    {eventText(row) ? <div className="mono small pre-wrap">{eventText(row)}</div> : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function StatsBody({ stats }: { stats: Stats }) {
  const c = stats.conversations;
  return (
    <>
      <div className="row">
        <button
          className="card card-pad"
          style={{ flex: '1 1 140px', flexDirection: 'column', alignItems: 'flex-start' }}
          onClick={() => {
            window.location.hash = '#/inbox';
          }}
          title="去收件箱处理"
        >
          <h1>{c.needsAction}</h1>
          <div className="muted small">待你处理</div>
        </button>
        <div className="card card-pad" style={{ flex: '1 1 140px' }}>
          <h1>{c.active}</h1>
          <div className="muted small">进行中对话</div>
        </div>
        <div className="card card-pad" style={{ flex: '1 1 140px' }}>
          <h1>{c.handoff}</h1>
          <div className="muted small">待人工</div>
        </div>
        <div className="card card-pad" style={{ flex: '1 1 140px' }}>
          <h1>{c.optedOut}</h1>
          <div className="muted small">已退订</div>
        </div>
      </div>

      <MessageChart rows={stats.messages} />

      <div className="card">
        <div className="card-head">
          <h2 className="grow">转化漏斗</h2>
          <span className="faint small">按任务分</span>
        </div>
        {stats.funnel.length === 0 ? (
          <Empty>还没有任务在跑。建一个任务并挂上账号，这里才会有进度。</Empty>
        ) : (
          <div className="stack card-pad">
            {stats.funnel.map((row, i) => (
              <Funnel key={row.campaignId ?? `none-${i}`} row={row} />
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2 className="grow">素材分享次数</h2>
          <span className="faint small">最近 14 天</span>
        </div>
        {stats.materials.length === 0 ? (
          <Empty>这段时间没有分享过素材。在任务里加几条素材、挂上「按兴趣分享素材」技能，这里才会有数。</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>任务</th>
                <th>素材</th>
                <th style={{ width: 90 }}>次数</th>
              </tr>
            </thead>
            <tbody>
              {stats.materials.map((m) => (
                <tr key={`${m.campaignId}/${m.materialId}`}>
                  <td className="muted">{m.campaignName}</td>
                  <td>{m.title}</td>
                  <td>{m.shares}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2 className="grow">模型用量</h2>
        </div>
        {stats.llm.length === 0 ? (
          <Empty>还没调用过模型。</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>供应商</th>
                  <th>模型</th>
                  <th>调用</th>
                  <th>失败</th>
                  <th>输入 token</th>
                  <th>输出 token</th>
                  <th>成本</th>
                  <th>平均延迟</th>
                </tr>
              </thead>
              <tbody>
                {stats.llm.map((row) => (
                  <tr key={`${row.providerName}/${row.model}`}>
                    <td>{row.providerName}</td>
                    <td className="mono">{row.model}</td>
                    <td>{row.calls}</td>
                    <td>{row.failures > 0 ? <span className="badge danger">{row.failures}</span> : <span className="faint">0</span>}</td>
                    <td className="mono">{row.inputTokens.toLocaleString('zh-CN')}</td>
                    <td className="mono">{row.outputTokens.toLocaleString('zh-CN')}</td>
                    <td className="mono">{row.costUsd === 0 ? '—' : `$${row.costUsd.toFixed(4)}`}</td>
                    <td className="mono">{Math.round(row.avgLatencyMs)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-pad muted small">
          今日已调用 {stats.llmCallsToday} 次；中位回复时间 {duration(stats.medianReplySeconds)}。
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2 className="grow">账号</h2>
        </div>
        {stats.accounts.length === 0 ? (
          <Empty>还没有账号。去「账号」页加一个，哪怕先用沙盒连接方式试水。</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>平台</th>
                  <th>状态</th>
                  <th style={{ width: 180 }}>今日已发 / 上限</th>
                </tr>
              </thead>
              <tbody>
                {stats.accounts.map((row) => {
                  const status = ACCOUNT_STATUS[row.status];
                  return (
                    <tr key={row.id}>
                      <td>{row.name}</td>
                      <td className="muted">{PLATFORM_LABELS[row.platform]}</td>
                      <td>
                        <span className={status.cls} title={row.statusDetail}>
                          {status.label}
                        </span>
                      </td>
                      <td>
                        <div className="small">
                          {row.sentToday} / {row.maxPerDay > 0 ? row.maxPerDay : '不限'}
                        </div>
                        {row.maxPerDay > 0 ? (
                          <div className="bar">
                            <i style={{ width: pct(Math.min(row.sentToday, row.maxPerDay), row.maxPerDay) }} />
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function MessageChart({ rows }: { rows: Stats['messages'] }) {
  const max = Math.max(1, ...rows.map((r) => Math.max(r.inbound, r.outbound)));
  return (
    <div className="card">
      <div className="card-head">
        <h2 className="grow">最近 14 天消息量</h2>
        <span className="row-tight faint small">
          <span className="badge">收到</span>
          <span className="badge accent">发出</span>
        </span>
      </div>
      {rows.length === 0 ? (
        <Empty>这段时间一条消息都没有。</Empty>
      ) : (
        <div className="card-pad stack" style={{ gap: 8 }}>
          <div className="spark">
            {rows.flatMap((r) => [
              <i key={`${r.day}-in`} className="alt" style={{ height: pct(r.inbound, max) }} title={`${r.day} 收到 ${r.inbound} 条`} />,
              <i key={`${r.day}-out`} style={{ height: pct(r.outbound, max), marginRight: 4 }} title={`${r.day} 发出 ${r.outbound} 条`} />,
            ])}
          </div>
          <div className="row faint small">
            <span>{rows[0].day}</span>
            <span className="grow" />
            <span>峰值 {max} 条/天</span>
            <span className="grow" />
            <span>{rows[rows.length - 1].day}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Funnel({ row }: { row: FunnelRow }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row-tight">
        <strong className="grow">{row.campaignName}</strong>
        <span className="muted small">{row.total} 个对话</span>
        {row.handoff > 0 ? <span className="badge warn">待人工 {row.handoff}</span> : null}
        {row.optedOut > 0 ? <span className="badge danger">已退订 {row.optedOut}</span> : null}
      </div>
      {STAGES.map((stage) => {
        const n = row.byStage[stage] ?? 0;
        return (
          <div key={stage} className="row-tight">
            <span className="muted small" style={{ width: 62, flex: 'none' }}>
              {STAGE_LABELS[stage]}
            </span>
            <div className="bar grow">
              <i style={{ width: pct(n, row.total) }} />
            </div>
            <span className="mono small" style={{ width: 34, flex: 'none', textAlign: 'right' }}>
              {n}
            </span>
          </div>
        );
      })}
    </div>
  );
}
