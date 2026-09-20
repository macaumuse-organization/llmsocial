import { useEffect, useState } from 'react';
import type { Campaign, JudgeReport, Message, Provider, SimPersona, SimRun } from '../../shared/types.ts';
import { AsyncButton, Empty, Field, Loading, STATUS_LABELS, api, clockTime, timeAgo, useAsync, useStream, useToast } from '../ui.tsx';

const CUSTOM = '__custom__';

const LANGUAGES: { value: string; label: string }[] = [
  { value: 'zh-Hans', label: '简体中文' },
  { value: 'zh-Hant', label: '繁体中文' },
  { value: 'yue', label: '粤语' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
];

const STATUS_BADGE: Record<SimRun['status'], { label: string; cls: string }> = {
  running: { label: '进行中', cls: 'badge warn' },
  done: { label: '已完成', cls: 'badge accent' },
  failed: { label: '失败', cls: 'badge danger' },
};

/** Messages the pipeline threw away before sending. */
const DEAD: string[] = ['superseded', 'rejected', 'cancelled'];

interface SimForm {
  campaignId: string;
  personaKey: string;
  name: string;
  description: string;
  language: string;
  agentProviderId: string;
  contactProviderId: string;
  maxTurns: number;
}

const EMPTY_FORM: SimForm = {
  campaignId: '',
  personaKey: '',
  name: '',
  description: '',
  language: 'zh-Hans',
  agentProviderId: '',
  contactProviderId: '',
  maxTurns: 8,
};

export function SandboxPage() {
  const runs = useAsync(() => api.simRuns(), []);
  const campaigns = useAsync(() => api.campaigns(), []);
  const providers = useAsync(() => api.providers(), []);
  const meta = useAsync(() => api.meta(), []);
  const [selected, setSelected] = useState('');

  const error = runs.error || campaigns.error || providers.error || meta.error;
  const ready = runs.data && campaigns.data && providers.data && meta.data;

  // Land on the newest run so the page isn't blank on arrival.
  useEffect(() => {
    if (!selected && runs.data && runs.data.length > 0) setSelected(runs.data[0]!.id);
  }, [runs.data, selected]);

  return (
    <>
      <div className="topbar">
        <h1>沙盒演练</h1>
        <div className="spacer" />
        <AsyncButton onClick={() => runs.reload()}>刷新</AsyncButton>
      </div>
      <div className="page">
        <div className="stack">
          <div className="notice info">
            沙盒里的对话只在本机进行，不会发给任何真人，也不占用任何平台账号，所以可以放心试探边界：问价格、要微信、说难听话都行。
            想验证退订逻辑，先用「想结束对话的人」这个角色跑一遍——对方说「别再发了」之后，助理应该立刻停下来，不再找补。
          </div>

          {error ? <div className="notice danger">{error}</div> : null}

          {!ready && !error ? (
            <Loading />
          ) : ready ? (
            <div className="sandbox-layout">
              <NewRunCard
                campaigns={campaigns.data!}
                providers={providers.data!}
                simPersonas={meta.data!.simPersonas}
                onCreated={async (run) => {
                  await runs.reload();
                  setSelected(run.id);
                }}
              />
              <div className="stack">
                <RunList runs={runs.data!} campaigns={campaigns.data!} selected={selected} onSelect={setSelected} />
                {selected ? <RunDetail runId={selected} campaigns={campaigns.data!} onRunChanged={() => runs.reload()} /> : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- new run

function NewRunCard({
  campaigns,
  providers,
  simPersonas,
  onCreated,
}: {
  campaigns: Campaign[];
  providers: Provider[];
  simPersonas: SimPersona[];
  onCreated: (run: SimRun) => Promise<void>;
}) {
  const toast = useToast();
  const [form, setForm] = useState<SimForm>(EMPTY_FORM);
  const set = (patch: Partial<SimForm>) => setForm((f) => ({ ...f, ...patch }));

  // Fill in sensible defaults once the lists arrive.
  useEffect(() => {
    setForm((f) => {
      if (f.campaignId || f.personaKey) return f;
      const first = simPersonas[0];
      return {
        ...f,
        campaignId: campaigns[0]?.id ?? '',
        personaKey: first?.name ?? CUSTOM,
        name: first?.name ?? '',
        description: first?.description ?? '',
        language: first?.language ?? 'zh-Hans',
      };
    });
  }, [campaigns, simPersonas]);

  const pickPersona = (key: string) => {
    if (key === CUSTOM) {
      set({ personaKey: CUSTOM, name: '', description: '' });
      return;
    }
    const p = simPersonas.find((x) => x.name === key);
    if (p) set({ personaKey: key, name: p.name, description: p.description, language: p.language });
  };

  const languages = LANGUAGES.some((l) => l.value === form.language) ? LANGUAGES : [...LANGUAGES, { value: form.language, label: form.language }];
  const canSubmit = form.campaignId !== '' && form.name.trim() !== '';

  if (campaigns.length === 0) {
    return (
      <div className="card card-pad">
        <div className="notice warn">还没有聊天任务。演练是照着任务里的目标、可用事实和技能跑的，先去「任务」页建一个再回来。</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2 className="grow">新建演练</h2>
      </div>
      <div className="card-pad stack">
        <Field label="聊天任务" hint="助理用这个任务的目标、可用事实、技能和模型链来应对。">
          <select value={form.campaignId} onChange={(e) => set({ campaignId: e.target.value })}>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.enabled ? '' : '（已停用）'}
              </option>
            ))}
          </select>
        </Field>

        <Field label="扮演角色" hint="另一个模型照这段描述扮演陌生人。挑一个改两句，比从零写一段快。">
          <select value={form.personaKey} onChange={(e) => pickPersona(e.target.value)}>
            {simPersonas.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
            <option value={CUSTOM}>自定义</option>
          </select>
        </Field>

        {form.personaKey === CUSTOM ? (
          <Field label="角色名称" hint="只用来在列表里认出这次演练。">
            <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="比如：问完价格就消失的人" />
          </Field>
        ) : null}

        <Field label="角色设定" hint="写清楚他的身份、说话习惯和真实顾虑，越具体，对练出来的问题越接近真人。">
          <textarea value={form.description} onChange={(e) => set({ description: e.target.value })} rows={5} />
        </Field>

        <Field label="角色语言" hint="他会用这个语言开口，顺便看助理会不会跟着切换。">
          <select value={form.language} onChange={(e) => set({ language: e.target.value })}>
            {languages.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="助理用的模型" hint="留空就按任务里配好的模型链走。想对比两个模型谁更会聊，就在这里换。">
          <select value={form.agentProviderId} onChange={(e) => set({ agentProviderId: e.target.value })}>
            <option value="">按任务配置</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.enabled ? '' : '（已停用）'}
              </option>
            ))}
          </select>
        </Field>

        <Field label="扮演者用的模型" hint="演对手戏的模型。用便宜的就够，它只负责像个真人一样难缠。">
          <select value={form.contactProviderId} onChange={(e) => set({ contactProviderId: e.target.value })}>
            <option value="">按任务配置</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.enabled ? '' : '（已停用）'}
              </option>
            ))}
          </select>
        </Field>

        <Field label="最多轮数" hint="一来一回算一轮。8 轮够看出开场和推进的毛病，调到 20 以上主要是烧 token。">
          <input
            type="number"
            min={1}
            max={30}
            value={form.maxTurns}
            onChange={(e) => set({ maxTurns: Math.max(1, Math.min(30, Number(e.target.value) || 1)) })}
          />
        </Field>

        <AsyncButton
          className="primary"
          disabled={!canSubmit}
          onClick={async () => {
            const run = await api.startSim({
              campaignId: form.campaignId,
              agentProviderId: form.agentProviderId || null,
              contactProviderId: form.contactProviderId || null,
              persona: { name: form.name.trim(), description: form.description, language: form.language },
              maxTurns: form.maxTurns,
            });
            await onCreated(run);
            toast.ok('演练开跑了，整场聊完才会出评分');
          }}
        >
          开始演练
        </AsyncButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- run list

function RunList({ runs, campaigns, selected, onSelect }: { runs: SimRun[]; campaigns: Campaign[]; selected: string; onSelect: (id: string) => void }) {
  const nameOf = (id: string) => campaigns.find((c) => c.id === id)?.name ?? '已删除的任务';
  const sorted = [...runs].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="card">
      <div className="card-head">
        <h2 className="grow">演练记录</h2>
        <span className="faint small">{runs.length} 场</span>
      </div>
      {sorted.length === 0 ? (
        <Empty>还没有跑过演练。左边选个任务和角色，先跑一场看看助理是怎么开口的。</Empty>
      ) : (
        <div style={{ maxHeight: 260, overflowY: 'auto' }}>
          {sorted.map((run) => (
            <button key={run.id} className="conv" aria-current={run.id === selected} onClick={() => onSelect(run.id)}>
              <div className="line">
                <span className="name grow">{run.persona.name}</span>
                <span className={STATUS_BADGE[run.status].cls}>{STATUS_BADGE[run.status].label}</span>
                <span className="time">{timeAgo(run.createdAt)}</span>
              </div>
              <div className="line">
                <span className="snippet grow">{nameOf(run.campaignId)}</span>
                {run.report ? <span className="small muted">{run.report.score} 分</span> : null}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- detail

function RunDetail({ runId, campaigns, onRunChanged }: { runId: string; campaigns: Campaign[]; onRunChanged: () => Promise<void> }) {
  const detail = useAsync(() => api.simRun(runId), [runId]);
  const run = detail.data?.run ?? null;

  // A running simulation pushes a sim event after every turn.
  useStream((event) => {
    if (event.type !== 'sim' || event.runId !== runId) return;
    void detail.reload();
    void onRunChanged();
  });

  if (detail.error) return <div className="notice danger">{detail.error}</div>;
  if (!run) return <Loading />;

  const badge = STATUS_BADGE[run.status];
  const campaignName = campaigns.find((c) => c.id === run.campaignId)?.name ?? '已删除的任务';

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2 className="grow">{run.persona.name}</h2>
          <span className={badge.cls}>{badge.label}</span>
        </div>
        <div className="card-pad stack">
          <div className="row small muted">
            <span>任务：{campaignName}</span>
            <span>语言：{run.persona.language}</span>
            <span>最多 {run.maxTurns} 轮</span>
            <span>{clockTime(run.createdAt)}</span>
          </div>
          {run.persona.description ? <div className="small pre-wrap muted">{run.persona.description}</div> : null}
          {run.status === 'failed' ? <div className="notice danger pre-wrap">{run.error || '演练中断了，没有更多信息。'}</div> : null}
          {run.status === 'running' ? <div className="notice info">正在对练，页面会自己刷新。整场聊完才会出评分。</div> : null}
        </div>
      </div>

      {run.report ? <ReportCard report={run.report} /> : null}

      <div className="card">
        <div className="card-head">
          <h2 className="grow">对话回放</h2>
          <span className="faint small">{detail.data!.messages.length} 条</span>
        </div>
        {detail.data!.messages.length === 0 ? (
          <Empty>还没有产生对话。</Empty>
        ) : (
          <div className="card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[...detail.data!.messages].sort((a, b) => a.seq - b.seq).map((m) => (
              <Bubble key={m.id} message={m} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Bubble({ message }: { message: Message }) {
  const dead = DEAD.includes(message.status);
  const cls = `msg${message.direction === 'out' ? ' out' : ''}${dead ? ' dead' : ''}`;
  return (
    <div className={cls}>
      <div className="bubble" title={clockTime(message.createdAt)}>
        {message.text}
      </div>
      {message.kind === 'disclosure' ? <div className="meta">AI 身份说明</div> : null}
      {dead ? <div className="meta">{STATUS_LABELS[message.status] ?? message.status}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------- judge report

function ReportCard({ report }: { report: JudgeReport }) {
  return (
    <div className="card">
      <div className="card-head">
        <h2 className="grow">打分</h2>
        <span className={report.goalAchieved ? 'badge accent' : 'badge'}>{report.goalAchieved ? '达成目标' : '没达成目标'}</span>
      </div>
      <div className="card-pad stack">
        <div className="field">
          <label>总分 {report.score} / 100</label>
          <div className="bar">
            <i style={{ width: `${Math.max(0, Math.min(100, report.score))}%` }} />
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label>自然度 {report.naturalness} / 10</label>
            <div className="hint">像不像真人在打字，还是一股客服模板味。</div>
          </div>
          <div className="field">
            <label>推销感 {report.pushiness} / 10</label>
            <div className="hint">越低越好。分数高说明太急着把话题拐到产品上。</div>
          </div>
        </div>

        <hr className="divider" />

        {report.honestyViolations.length > 0 ? (
          <div className="stack" style={{ gap: 8 }}>
            <h3>诚实性问题</h3>
            {report.honestyViolations.map((v, i) => (
              <div key={i} className="notice danger pre-wrap">
                {v}
              </div>
            ))}
          </div>
        ) : (
          <div className="notice accent">没有发现假装真人、编造事实或无视拒绝的情况。</div>
        )}

        {report.summary ? (
          <div className="field">
            <label>这场聊得怎么样</label>
            <div className="pre-wrap small">{report.summary}</div>
          </div>
        ) : null}

        {report.suggestions.length > 0 ? (
          <div className="field">
            <label>可以改的地方</label>
            <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>
              {report.suggestions.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
