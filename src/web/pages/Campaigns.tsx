import { useState } from 'react';
import type { Campaign, GoalType, Meta, Mode, Persona, PlatformId, Provider, Skill } from '../../shared/types.ts';
import { AsyncButton, Check, Confirm, Empty, Field, Loading, Modal, PLATFORM_LABELS, api, useAsync, useToast } from '../ui.tsx';

const DEFAULT_CAMPAIGN_ID = 'camp_default';

interface Form {
  name: string;
  goalType: GoalType;
  goal: string;
  successCriteria: string;
  facts: string;
  /** One link per line; split on submit. */
  linksText: string;
  linkFallback: string;
  allowedPlatforms: PlatformId[];
  skillIds: string[];
  personaId: string;
  providerIds: string[];
  mode: Mode;
  maxDays: number;
  maxTurns: number;
  replyDelayMinS: number;
  replyDelayMaxS: number;
  followupEnabled: boolean;
  followupAfterH: number;
  followupMax: number;
  enabled: boolean;
}

function blankForm(): Form {
  return {
    name: '',
    goalType: 'rapport',
    goal: '',
    successCriteria: '',
    facts: '',
    linksText: '',
    linkFallback: '',
    allowedPlatforms: [],
    skillIds: [],
    personaId: '',
    providerIds: [],
    mode: 'copilot',
    maxDays: 14,
    maxTurns: 20,
    replyDelayMinS: 40,
    replyDelayMaxS: 180,
    followupEnabled: false,
    followupAfterH: 48,
    followupMax: 1,
    enabled: true,
  };
}

function formOf(c: Campaign): Form {
  return {
    name: c.name,
    goalType: c.goalType,
    goal: c.goal,
    successCriteria: c.successCriteria,
    facts: c.facts,
    linksText: c.allowedLinks.join('\n'),
    linkFallback: c.linkFallback,
    allowedPlatforms: [...c.allowedPlatforms],
    skillIds: [...c.skillIds],
    personaId: c.personaId ?? '',
    providerIds: [...c.providerIds],
    mode: c.mode,
    maxDays: c.maxDays,
    maxTurns: c.maxTurns,
    replyDelayMinS: c.replyDelayMinS,
    replyDelayMaxS: c.replyDelayMaxS,
    followupEnabled: c.followupEnabled,
    followupAfterH: c.followupAfterH,
    followupMax: c.followupMax,
    enabled: c.enabled,
  };
}

function bodyOf(f: Form) {
  return {
    name: f.name.trim(),
    goalType: f.goalType,
    goal: f.goal.trim(),
    successCriteria: f.successCriteria.trim(),
    facts: f.facts.trim(),
    allowedLinks: f.linksText
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    linkFallback: f.linkFallback.trim(),
    allowedPlatforms: f.allowedPlatforms,
    skillIds: f.skillIds,
    personaId: f.personaId === '' ? null : f.personaId,
    providerIds: f.providerIds,
    mode: f.mode,
    maxDays: f.maxDays,
    maxTurns: f.maxTurns,
    replyDelayMinS: f.replyDelayMinS,
    replyDelayMaxS: f.replyDelayMaxS,
    followupEnabled: f.followupEnabled,
    followupAfterH: f.followupAfterH,
    followupMax: f.followupMax,
    enabled: f.enabled,
  };
}

const clampInt = (raw: string, min: number, max: number) => {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
};

const toggle = <T,>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

const clampStyle = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' };

export function CampaignsPage() {
  const campaigns = useAsync(() => api.campaigns(), []);
  const skills = useAsync(() => api.skills(), []);
  const personas = useAsync(() => api.personas(), []);
  const providers = useAsync(() => api.providers(), []);
  const meta = useAsync(() => api.meta(), []);
  const toast = useToast();

  // null = closed; { campaign: null } = creating.
  const [editing, setEditing] = useState<{ campaign: Campaign | null; form: Form } | null>(null);
  const [removing, setRemoving] = useState<Campaign | null>(null);

  const error = campaigns.error || skills.error || personas.error || providers.error || meta.error;
  const ready = campaigns.data && skills.data && personas.data && providers.data && meta.data;

  const goalLabel = (id: GoalType) => meta.data?.goalTypes.find((g) => g.id === id)?.label ?? id;

  return (
    <>
      <div className="topbar">
        <h1>聊天任务</h1>
        <div className="spacer" />
        <button className="primary" disabled={!ready} onClick={() => setEditing({ campaign: null, form: blankForm() })}>
          新建任务
        </button>
      </div>
      <div className="page">
        <div className="stack page-narrow">
          <div className="notice info">
            一个任务规定了 AI 在对话里想达成什么、能说哪些事实、能发哪些链接，以及是先出草稿还是直接回复。账号挂上任务后才会按这套规则聊天。
          </div>

          {error ? <div className="notice danger">{error}</div> : null}
          {!ready && !error ? <Loading /> : null}

          {ready && campaigns.data!.length === 0 ? <Empty>还没有任务。先建一个，写清楚目标和能引用的事实，再把账号挂上去。</Empty> : null}

          {ready
            ? campaigns.data!.map((c) => (
                <div className="card card-pad stack" key={c.id}>
                  <div className="row">
                    <h2 className="grow">{c.name}</h2>
                    <span className="badge">{goalLabel(c.goalType)}</span>
                    {c.mode === 'autopilot' ? <span className="badge warn">自动回复</span> : <span className="badge info">AI 起草</span>}
                    {c.enabled ? <span className="badge accent">已启用</span> : <span className="badge">已停用</span>}
                  </div>

                  {c.goal.trim() === '' ? (
                    <div className="small faint">还没写目标，AI 不知道这轮对话要聊成什么样。</div>
                  ) : (
                    <div className="small muted pre-wrap" style={clampStyle}>
                      {c.goal}
                    </div>
                  )}

                  <div className="row small faint">
                    <span>{c.skillIds.length > 0 ? `${c.skillIds.length} 个技能` : '未挂技能'}</span>
                    <span>·</span>
                    <span>
                      {c.maxDays} 天 / {c.maxTurns} 轮内结束
                    </span>
                    {c.allowedPlatforms.length > 0 ? (
                      <>
                        <span>·</span>
                        <span>限 {c.allowedPlatforms.map((p) => PLATFORM_LABELS[p]).join('、')}</span>
                      </>
                    ) : null}
                  </div>

                  <div className="row">
                    <button className="sm" onClick={() => setEditing({ campaign: c, form: formOf(c) })}>
                      编辑
                    </button>
                    <AsyncButton
                      className="sm"
                      title="按同样的设置新建一个任务，改完再启用"
                      onClick={async () => {
                        await api.createCampaign({ ...bodyOf(formOf(c)), name: `${c.name}（副本）` });
                        await campaigns.reload();
                        toast.ok('已复制一份');
                      }}
                    >
                      复制一份
                    </AsyncButton>
                    <AsyncButton
                      className="sm"
                      onClick={async () => {
                        await api.updateCampaign(c.id, { enabled: !c.enabled });
                        await campaigns.reload();
                        toast.ok(c.enabled ? '已停用，挂着它的账号不再按这个任务聊天' : '已启用');
                      }}
                    >
                      {c.enabled ? '停用' : '启用'}
                    </AsyncButton>
                    <div className="grow" />
                    {c.id === DEFAULT_CAMPAIGN_ID ? (
                      <span className="small faint">默认任务不能删</span>
                    ) : (
                      <button className="sm danger" onClick={() => setRemoving(c)}>
                        删除
                      </button>
                    )}
                  </div>
                </div>
              ))
            : null}
        </div>
      </div>

      {editing && ready ? (
        <CampaignForm
          campaign={editing.campaign}
          form={editing.form}
          skills={skills.data!}
          personas={personas.data!}
          providers={providers.data!}
          meta={meta.data!}
          onChange={(form) => setEditing((prev) => (prev ? { ...prev, form } : prev))}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await campaigns.reload();
            setEditing(null);
          }}
        />
      ) : null}

      {removing ? (
        <Confirm
          title="删除任务"
          body={`删除「${removing.name}」后，挂着它的账号会回到没有任务的状态，已有对话也不再按这套规则续聊。历史消息不受影响。`}
          confirmLabel="删除"
          danger
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing;
            void (async () => {
              try {
                await api.deleteCampaign(target.id);
                await campaigns.reload();
                toast.ok('已删除');
              } catch (err) {
                toast.error(err);
              }
            })();
          }}
        />
      ) : null}
    </>
  );
}

function CampaignForm({
  campaign,
  form,
  skills,
  personas,
  providers,
  meta,
  onChange,
  onClose,
  onSaved,
}: {
  campaign: Campaign | null;
  form: Form;
  skills: Skill[];
  personas: Persona[];
  providers: Provider[];
  meta: Meta;
  onChange: (form: Form) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const set = <K extends keyof Form>(key: K, value: Form[K]) => onChange({ ...form, [key]: value });

  const goalHint = meta.goalTypes.find((g) => g.id === form.goalType)?.hint ?? '';
  const chosenProviders = form.providerIds.map((id) => providers.find((p) => p.id === id) ?? null);
  const restProviders = providers.filter((p) => !form.providerIds.includes(p.id));
  const invalid = form.name.trim() === '' || form.goal.trim() === '';

  const moveProvider = (index: number, delta: number) => {
    const next = [...form.providerIds];
    const to = index + delta;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    set('providerIds', next);
  };

  return (
    <Modal
      title={campaign ? `编辑 ${campaign.name}` : '新建任务'}
      wide
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <AsyncButton
            className="primary"
            disabled={invalid}
            title={invalid ? '名称和目标都要填' : undefined}
            onClick={async () => {
              const body = bodyOf(form);
              if (campaign) await api.updateCampaign(campaign.id, body);
              else await api.createCampaign(body);
              await onSaved();
              toast.ok('已保存');
            }}
          >
            保存
          </AsyncButton>
        </>
      }
    >
      <div className="field-row">
        <Field label="任务名称" hint="只给你自己看，账号列表里靠它认人。">
          <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="例如：VPN 新用户答疑" />
        </Field>
        <Field label="任务类型" hint={goalHint}>
          <select value={form.goalType} onChange={(e) => set('goalType', e.target.value as GoalType)}>
            {meta.goalTypes.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="目标" hint="用一两句话说清楚这轮对话要聊成什么样，AI 会照着它决定往哪带。">
        <textarea value={form.goal} onChange={(e) => set('goal', e.target.value)} rows={3} placeholder="让对方弄明白免费版和付费版的差别，愿意的话引导去官网自己下单。" />
      </Field>

      <Field label="算作达成" hint="满足哪些条件就算这单成了。写具体点，后面统计转化和模拟评分都看它。">
        <textarea value={form.successCriteria} onChange={(e) => set('successCriteria', e.target.value)} rows={2} placeholder="对方说要去试用，或者问到了怎么付款。" />
      </Field>

      <Field
        label="只能引用的事实"
        hint="AI 只会陈述这里写的内容。这里没写的价格、功能、效果，它会回答「需要确认」而不是编一个。一行一条，写全一点。"
      >
        <textarea value={form.facts} onChange={(e) => set('facts', e.target.value)} rows={6} placeholder={'月付 39 元，年付 299 元。\n支持 5 台设备同时在线。\n新用户有 3 天试用，不用先绑卡。\n节点覆盖日本、新加坡、美国西岸。\n不承诺任何具体网速。\n退款按官网条款走，7 天内可申请。'} />
      </Field>

      <div className="field-row">
        <Field label="允许发送的链接" hint="一行一个。只有这里列出来的链接会被发出去，AI 临时编的或者从别处抄来的链接会被拦下来。">
          <textarea value={form.linksText} onChange={(e) => set('linksText', e.target.value)} rows={3} placeholder={'https://example.com/\nhttps://example.com/pricing'} />
        </Field>
        <Field label="平台屏蔽链接时的替代说法" hint="小红书、微信这类地方发链接会被限流或吞掉，这时候改说这句。">
          <input value={form.linkFallback} onChange={(e) => set('linkFallback', e.target.value)} placeholder="主页有官网地址，或者私信我发你" />
        </Field>
      </div>

      <Field label="允许运行的平台" hint="全不勾就是不限平台。勾了之后，其它平台的账号挂上这个任务也不会动。比如 VPN 相关的任务只勾 X / Instagram / YouTube，别让它跑到国内平台上去。">
        <div className="row">
          {meta.platforms.map((p) => (
            <label className="check" key={p.id} style={{ minWidth: 120 }}>
              <input type="checkbox" checked={form.allowedPlatforms.includes(p.id)} onChange={() => set('allowedPlatforms', toggle(form.allowedPlatforms, p.id))} />
              <span>{PLATFORM_LABELS[p.id] ?? p.label}</span>
            </label>
          ))}
        </div>
      </Field>

      <Field label="技能" hint="技能是一段写死的应对套路，AI 会按需取用。挂得越多提示词越长，只挂用得上的。">
        {skills.length === 0 ? (
          <div className="small faint">还没有技能，去「技能」页建一个。</div>
        ) : (
          <div className="card card-pad stack" style={{ gap: 10, maxHeight: 240, overflowY: 'auto' }}>
            {skills.map((s) => (
              <div key={s.id} className={s.enabled ? undefined : 'faint'}>
                <Check
                  checked={form.skillIds.includes(s.id)}
                  onChange={() => set('skillIds', toggle(form.skillIds, s.id))}
                  label={s.enabled ? s.name : `${s.name}（已停用）`}
                  hint={s.enabled ? s.description : `${s.description}　停用中，挂上也不会生效。`}
                />
              </div>
            ))}
          </div>
        )}
      </Field>

      <div className="field-row">
        <Field label="人设" hint="留空就用账号自己配的人设，一般不用在这里覆盖。">
          <select value={form.personaId} onChange={(e) => set('personaId', e.target.value)}>
            <option value="">跟随账号</option>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="模式" hint={form.mode === 'autopilot' ? '自动回复：不用你点，AI 自己发。' : 'AI 起草：草稿进收件箱等你过目，点了才发。'}>
          <select value={form.mode} onChange={(e) => set('mode', e.target.value as Mode)}>
            <option value="copilot">AI 起草，人工确认后发送</option>
            <option value="autopilot">自动回复，AI 直接发送</option>
          </select>
        </Field>
      </div>

      {form.mode === 'autopilot' ? (
        <div className="notice warn">
          开了自动回复，AI 会自己把消息发出去，你事后才看到。每段对话的第一条自动消息会先说明「我是 AI」，这个去不掉。碰到付款、验证码、证件、合同这类内容仍然会停下来转人工；不能直接发送的连接方式（要你手动搬运的那种）上，它会自动退回成起草模式。
        </div>
      ) : null}

      <Field label="模型优先级" hint="按这个顺序调用，前一个失败或超额了自动换下一个。留空表示用全部启用的模型，按它们自己的优先级排。">
        <div className="stack" style={{ gap: 8 }}>
          {form.providerIds.length === 0 ? <div className="small faint">没指定，用全部启用的模型。</div> : null}
          {chosenProviders.map((p, i) => (
            <div className="row-tight" key={form.providerIds[i]}>
              <span className="badge">{i + 1}</span>
              <span className="grow small">
                {p ? p.name : form.providerIds[i]}
                {p && !p.enabled ? <span className="faint">（已停用）</span> : null}
                {!p ? <span className="faint">（模型已不存在）</span> : null}
              </span>
              <button className="sm ghost" title="上移" disabled={i === 0} onClick={() => moveProvider(i, -1)}>
                ↑
              </button>
              <button className="sm ghost" title="下移" disabled={i === form.providerIds.length - 1} onClick={() => moveProvider(i, 1)}>
                ↓
              </button>
              <button className="sm ghost" title="移出" onClick={() => set('providerIds', form.providerIds.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
          {restProviders.length > 0 ? (
            <select
              value=""
              onChange={(e) => {
                if (e.target.value !== '') set('providerIds', [...form.providerIds, e.target.value]);
              }}
            >
              <option value="">添加一个模型…</option>
              {restProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.enabled ? '' : '（已停用）'}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </Field>

      <div className="field-row">
        <Field label="最长天数" hint="超过就收尾，不再主动接话。">
          <input type="number" min={1} max={365} value={form.maxDays} onChange={(e) => set('maxDays', clampInt(e.target.value, 1, 365))} />
        </Field>
        <Field label="最多来回轮数" hint="聊到这个数还没结果，多半也聊不出来了。">
          <input type="number" min={1} max={200} value={form.maxTurns} onChange={(e) => set('maxTurns', clampInt(e.target.value, 1, 200))} />
        </Field>
      </div>

      <div className="field-row">
        <Field label="回复延迟下限（秒）" hint="模拟真人读消息和打字的时间，避免秒回。">
          <input type="number" min={0} max={7200} value={form.replyDelayMinS} onChange={(e) => set('replyDelayMinS', clampInt(e.target.value, 0, 7200))} />
        </Field>
        <Field label="回复延迟上限（秒）" hint={form.replyDelayMaxS < form.replyDelayMinS ? '上限比下限还小，改一下。' : '每条在下限和上限之间随机取，拉开一点更像人。'}>
          <input type="number" min={0} max={7200} value={form.replyDelayMaxS} onChange={(e) => set('replyDelayMaxS', clampInt(e.target.value, 0, 7200))} />
        </Field>
      </div>

      <Field label="跟进">
        <Check
          checked={form.followupEnabled}
          onChange={(v) => set('followupEnabled', v)}
          label="对方不回话时主动跟进一次"
          hint="只有对方回过话、并且最后一条是我方发的，才会跟进。对方拒绝过或者退订了就不再跟进。"
        />
      </Field>

      {form.followupEnabled ? (
        <div className="field-row">
          <Field label="隔多久跟进（小时）" hint="从我方最后一条消息算起。太短会像催债。">
            <input type="number" min={1} max={720} value={form.followupAfterH} onChange={(e) => set('followupAfterH', clampInt(e.target.value, 1, 720))} />
          </Field>
          <Field label="最多跟进几次" hint="最多 3 次。发到第三次还没动静，这人就是不想聊了。">
            <input type="number" min={1} max={3} value={form.followupMax} onChange={(e) => set('followupMax', clampInt(e.target.value, 1, 3))} />
          </Field>
        </div>
      ) : null}

      <hr className="divider" />

      <Check checked={form.enabled} onChange={(v) => set('enabled', v)} label="启用这个任务" hint="停用后，挂着它的账号收到消息也不会起草或回复。" />

      {invalid ? <div className="notice danger">名称和目标都要填，AI 得知道这轮对话要干什么。</div> : null}
    </Modal>
  );
}
