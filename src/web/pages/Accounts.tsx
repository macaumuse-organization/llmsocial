import { useState } from 'react';
import type { Account, AccountStatus, ConnectorKind, ConnectorMeta, PlatformId } from '../../shared/types.ts';
import { AsyncButton, Confirm, Empty, Field, Loading, Modal, PLATFORM_LABELS, api, timeAgo, useAsync, useStream, useToast } from '../ui.tsx';

const STATUS_BADGE: Record<AccountStatus, { label: string; className: string }> = {
  active: { label: '进行中', className: 'badge accent' },
  paused: { label: '已暂停', className: 'badge' },
  error: { label: '出错', className: 'badge danger' },
  needs_auth: { label: '待授权', className: 'badge warn' },
};

interface FormState {
  /** null = creating. */
  id: string | null;
  name: string;
  platform: PlatformId;
  connector: ConnectorKind;
  config: Record<string, string>;
  /** Only values typed just now; blanks are dropped so stored keys survive an edit. */
  secrets: Record<string, string>;
  secretsSet: Record<string, boolean>;
  personaId: string;
  defaultCampaignId: string;
  status: 'active' | 'paused';
  quietStart: string;
  quietEnd: string;
  timezone: string;
  maxPerHour: number;
  maxPerDay: number;
  maxPerContactDay: number;
  pollIntervalS: number;
}

function blankForm(platform: PlatformId, connector: ConnectorKind): FormState {
  return {
    id: null,
    name: '',
    platform,
    connector,
    config: {},
    secrets: {},
    secretsSet: {},
    personaId: '',
    defaultCampaignId: '',
    status: 'active',
    quietStart: '23:00',
    quietEnd: '08:00',
    timezone: 'Asia/Shanghai',
    maxPerHour: 30,
    maxPerDay: 200,
    maxPerContactDay: 20,
    pollIntervalS: 120,
  };
}

function formOf(account: Account): FormState {
  return {
    id: account.id,
    name: account.name,
    platform: account.platform,
    connector: account.connector,
    config: { ...account.config },
    secrets: {},
    secretsSet: { ...account.secretsSet },
    personaId: account.personaId ?? '',
    defaultCampaignId: account.defaultCampaignId ?? '',
    status: account.status === 'paused' ? 'paused' : 'active',
    quietStart: account.quietStart,
    quietEnd: account.quietEnd,
    timezone: account.timezone,
    maxPerHour: account.maxPerHour,
    maxPerDay: account.maxPerDay,
    maxPerContactDay: account.maxPerContactDay,
    pollIntervalS: account.pollIntervalS,
  };
}

export function AccountsPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(async () => {
    const [accounts, meta, campaigns, personas, stats] = await Promise.all([api.accounts(), api.meta(), api.campaigns(), api.personas(), api.stats()]);
    return { accounts, meta, campaigns, personas, stats };
  }, []);

  const [form, setForm] = useState<FormState | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);
  /** Redirect URI handed back by the last oauthStart, per account. */
  const [redirectUris, setRedirectUris] = useState<Record<string, string>>({});
  useStream((event) => { if (event.type === 'account') void reload(); });

  const set = (patch: Partial<FormState>) => setForm((f) => (f ? { ...f, ...patch } : f));

  async function copy(text: string, what: string) {
    await navigator.clipboard.writeText(text);
    toast.ok(`${what}已复制`);
  }

  if (loading && !data) {
    return (
      <>
        <div className="topbar">
          <h1>账号</h1>
        </div>
        <div className="page">
          <Loading />
        </div>
      </>
    );
  }
  if (error || !data) {
    return (
      <>
        <div className="topbar">
          <h1>账号</h1>
        </div>
        <div className="page">
          <div className="stack page-narrow">
            <div className="notice danger">{error || '没读到账号数据'}</div>
          </div>
        </div>
      </>
    );
  }

  const { accounts, meta, campaigns, personas, stats } = data;
  const connectorOf = (kind: ConnectorKind): ConnectorMeta | undefined => meta.connectors.find((c) => c.kind === kind);
  const formConnector = form ? connectorOf(form.connector) : undefined;
  const platformConnectors = form ? meta.connectors.filter((c) => c.platforms.includes(form.platform)) : [];

  function openNew() {
    const platform = meta.platforms[0]?.id ?? 'sandbox';
    const connector = meta.connectors.find((c) => c.platforms.includes(platform))?.kind ?? 'manual';
    setForm(blankForm(platform, connector));
  }

  function changePlatform(platform: PlatformId) {
    const connector = meta.connectors.find((c) => c.platforms.includes(platform))?.kind;
    // Fields belong to the connector, so switching platforms starts them over.
    set({ platform, connector: connector ?? 'manual', config: {}, secrets: {} });
  }

  async function save() {
    if (!form) return;
    const spec = connectorOf(form.connector);
    const name = form.name.trim();
    if (name === '') throw new Error('先给账号起个名字');

    const config: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const field of spec?.fields ?? []) {
      const raw = (field.secret ? form.secrets[field.key] : form.config[field.key]) ?? '';
      const value = raw.trim();
      // An empty secret box means "don't touch what's stored", so it is left out entirely.
      if (field.secret) {
        if (value !== '') secrets[field.key] = value;
      } else {
        config[field.key] = value;
      }
      if (field.required) {
        const filled = field.secret ? value !== '' || form.secretsSet[field.key] === true : value !== '';
        if (!filled) throw new Error(`还差「${field.label}」没填`);
      }
    }

    const body = {
      name,
      config,
      secrets,
      personaId: form.personaId === '' ? null : form.personaId,
      defaultCampaignId: form.defaultCampaignId === '' ? null : form.defaultCampaignId,
      status: form.status,
      quietStart: form.quietStart,
      quietEnd: form.quietEnd,
      timezone: form.timezone.trim(),
      maxPerHour: form.maxPerHour,
      maxPerDay: form.maxPerDay,
      maxPerContactDay: form.maxPerContactDay,
      pollIntervalS: spec?.canPoll ? form.pollIntervalS : 0,
    };

    if (form.id) await api.updateAccount(form.id, body);
    else await api.createAccount({ ...body, platform: form.platform, connector: form.connector });
    await reload();
    setForm(null);
    toast.ok(form.id ? '账号已更新' : '账号建好了，建议先测一下连接');
  }

  return (
    <>
      <div className="topbar">
        <h1>账号</h1>
        <div className="spacer" />
        <button className="primary" onClick={openNew}>
          新建账号
        </button>
      </div>

      <div className="page">
        <div className="stack page-narrow">
          {accounts.length === 0 ? (
            <Empty>还没有账号。先建一个试试——沙盒连接方式不碰任何真实平台，拿来跑通流程正合适。</Empty>
          ) : null}

          {accounts.map((account) => {
            const connector = connectorOf(account.connector);
            const badge = STATUS_BADGE[account.status];
            const sentToday = stats.accounts.find((a) => a.id === account.id)?.sentToday ?? 0;
            const campaignName = campaigns.find((c) => c.id === account.defaultCampaignId)?.name;
            const personaName = personas.find((p) => p.id === account.personaId)?.name;
            const webhookUrl = `${meta.webhookBaseUrl}/webhooks/${account.id}`;
            const redirectUri = redirectUris[account.id];

            return (
              <div className="card" key={account.id}>
                <div className="card-head">
                  <div className="grow">
                    <div className="row-tight">
                      <strong>{account.name}</strong>
                      <span className={badge.className}>{badge.label}</span>
                      {account.connector === 'sandbox' ? <span className="badge">本地演练</span> : account.connector === 'manual' ? <span className="badge">手动收发</span> : connector?.untestedLive ? <span className="badge warn">需验证实际收发</span> : null}
                    </div>
                    <div className="small muted">
                      {PLATFORM_LABELS[account.platform]} · {connector?.label ?? account.connector}
                    </div>
                  </div>
                  <button className="sm" onClick={() => setForm(formOf(account))}>
                    编辑
                  </button>
                  <button className="sm danger" onClick={() => setDeleting(account)}>
                    删除
                  </button>
                </div>

                <div className="card-pad stack">
                  {account.statusDetail ? <div className="small muted pre-wrap">{account.statusDetail}</div> : null}

                  <div className="row small muted">
                    <span>
                      今日已发 <strong>{sentToday}</strong> / {account.maxPerDay || '不限'}
                    </span>
                    <span className="faint">·</span>
                    <span>上次拉取 {timeAgo(account.lastPolledAt)}</span>
                    {campaignName ? (
                      <>
                        <span className="faint">·</span>
                        <span>默认任务 {campaignName}</span>
                      </>
                    ) : null}
                    {personaName ? (
                      <>
                        <span className="faint">·</span>
                        <span>人设 {personaName}</span>
                      </>
                    ) : null}
                  </div>

                  {connector?.usesWebhook ? (
                    <>
                      <div className="row">
                        <span className="mono grow">{webhookUrl}</span>
                        <AsyncButton className="sm" onClick={() => copy(webhookUrl, '回调地址')}>
                          复制
                        </AsyncButton>
                      </div>
                      <div className="notice info">平台得能访问到这个地址才推得进消息。本地端口默认只在这台机器上听，先用 ngrok、cloudflared 之类的隧道把它暴露成公网地址，再把公网那版填到平台后台。</div>
                    </>
                  ) : null}

                  {redirectUri ? (
                    <div className="notice info">
                      <div>授权页已在新标签打开。平台后台的应用设置里要先把下面这个回调地址加进白名单，否则授权会被直接拒掉。</div>
                      <div className="row" style={{ marginTop: 6 }}>
                        <span className="mono grow">{redirectUri}</span>
                        <AsyncButton className="sm" onClick={() => copy(redirectUri, '回调地址')}>
                          复制
                        </AsyncButton>
                      </div>
                    </div>
                  ) : null}

                  <hr className="divider" />

                  <div className="row">
                    <AsyncButton
                      className="sm"
                      onClick={async () => {
                        const result = await api.testAccount(account.id);
                        if (result.ok) toast.ok(result.detail || '连得上');
                        else toast.error(result.detail || '连不上');
                        await reload();
                      }}
                    >
                      测试连接
                    </AsyncButton>

                    {connector?.canPoll ? (
                      <AsyncButton
                        className="sm"
                        onClick={async () => {
                          await api.pollAccount(account.id);
                          toast.ok('已排进拉取队列，拉到的消息会自己出现在收件箱');
                        }}
                      >
                        立即拉取
                      </AsyncButton>
                    ) : null}

                    {connector?.oauth ? (
                      <AsyncButton
                        className="sm"
                        onClick={async () => {
                          const popup = window.open('about:blank', '_blank');
                          if (!popup) throw new Error('浏览器拦住了授权窗口，请允许本站弹出窗口后重试');
                          popup.opener = null;
                          try {
                            const { url, redirectUri: uri } = await api.oauthStart(account.id);
                            setRedirectUris((m) => ({ ...m, [account.id]: uri }));
                            popup.location.href = url;
                          } catch (err) { popup.close(); throw err; }
                        }}
                      >
                        去授权
                      </AsyncButton>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {form ? (
        <Modal
          title={form.id ? '编辑账号' : '新建账号'}
          onClose={() => setForm(null)}
          footer={
            <>
              <button onClick={() => setForm(null)}>取消</button>
              <AsyncButton className="primary" onClick={save}>
                保存
              </AsyncButton>
            </>
          }
        >
          <div className="field-row">
            <Field label="平台" hint={form.id ? '建好之后不能换：换了平台，已有的会话和令牌就对不上了。要换就新建一个账号。' : undefined}>
              <select value={form.platform} disabled={form.id !== null} onChange={(e) => changePlatform(e.target.value as PlatformId)}>
                {meta.platforms.map((p) => (
                  <option key={p.id} value={p.id}>
                    {PLATFORM_LABELS[p.id]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="连接方式" hint={form.id ? '同样不能改。' : formConnector?.description}>
              <select value={form.connector} disabled={form.id !== null} onChange={(e) => set({ connector: e.target.value as ConnectorKind, config: {}, secrets: {} })}>
                {platformConnectors.map((c) => (
                  <option key={c.kind} value={c.kind}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {formConnector?.untestedLive ? <div className="notice warn">这个连接方式没有在真实账号上验证过，先用「测试连接」确认一遍再开自动回复。</div> : null}

          {formConnector && !formConnector.canSend ? (
            <div className="notice info">这个连接方式发不出消息，得由人工去平台上粘贴。所以走它的对话会自动降级成起草模式：AI 只写草稿，不会自动发。</div>
          ) : null}

          {formConnector?.setupNotes ? <div className="notice info pre-wrap">{formConnector.setupNotes}</div> : null}

          {(formConnector?.fields ?? []).map((field) => (
            <Field key={field.key} label={field.label} hint={field.help}>
              {field.secret ? (
                <input
                  type="password"
                  autoComplete="new-password"
                  value={form.secrets[field.key] ?? ''}
                  placeholder={form.secretsSet[field.key] ? '已设置（留空则不变）' : field.placeholder}
                  onChange={(e) => set({ secrets: { ...form.secrets, [field.key]: e.target.value } })}
                />
              ) : (
                <input value={form.config[field.key] ?? ''} placeholder={field.placeholder} onChange={(e) => set({ config: { ...form.config, [field.key]: e.target.value } })} />
              )}
            </Field>
          ))}

          <hr className="divider" />

          <Field label="名称" hint="只在这个界面里用来认人，写成你一眼能分清的样子，比如「小红书·主号」。">
            <input value={form.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>

          <div className="field-row">
            <Field label="默认聊天任务" hint="新对话使用这个任务；留空时使用系统默认的友好回复任务。">
              <select value={form.defaultCampaignId} onChange={(e) => set({ defaultCampaignId: e.target.value })}>
                <option value="">不指定</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="人设" hint="AI 用谁的口吻说话。留空就用任务里带的那个人设。">
              <select value={form.personaId} onChange={(e) => set({ personaId: e.target.value })}>
                <option value="">跟任务走</option>
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="状态" hint="暂停后这个账号既不拉新消息，也不发自动消息；已有的对话还在，你仍然可以手动回。">
            <select value={form.status} onChange={(e) => set({ status: e.target.value as 'active' | 'paused' })}>
              <option value="active">进行中</option>
              <option value="paused">已暂停</option>
            </select>
          </Field>

          <div className="field-row">
            <Field label="免打扰开始" hint="这段时间内要发的自动消息会攒着，等免打扰结束再发出去；你自己手动发不受影响。">
              <input type="time" value={form.quietStart} onChange={(e) => set({ quietStart: e.target.value })} />
            </Field>
            <Field label="免打扰结束" hint="两头填成一样就是不设免打扰。">
              <input type="time" value={form.quietEnd} onChange={(e) => set({ quietEnd: e.target.value })} />
            </Field>
            <Field label="时区" hint="免打扰时段按这个时区算。填 IANA 名字，比如 Asia/Shanghai、Australia/Sydney。">
              <input value={form.timezone} onChange={(e) => set({ timezone: e.target.value })} />
            </Field>
          </div>

          <div className="field-row">
            <Field label="每小时上限" hint="最近 1 小时的发送上限，超出后自动消息排队等待。0 表示不限。">
              <input type="number" min={0} value={form.maxPerHour} onChange={(e) => set({ maxPerHour: Number(e.target.value) || 0 })} />
            </Field>
            <Field label="每天上限" hint="最近 24 小时的发送上限。0 表示不限。">
              <input type="number" min={0} value={form.maxPerDay} onChange={(e) => set({ maxPerDay: Number(e.target.value) || 0 })} />
            </Field>
            <Field label="对同一个人每天上限" hint="同一段对话最近 24 小时的发送上限。0 表示不限。">
              <input type="number" min={0} value={form.maxPerContactDay} onChange={(e) => set({ maxPerContactDay: Number(e.target.value) || 0 })} />
            </Field>
          </div>

          {formConnector?.canPoll ? (
            <Field label="拉取间隔（秒）" hint="隔多久去平台捞一次新消息。填 0 就不自动拉，只能在账号卡片上点「立即拉取」。">
              <input type="number" min={0} value={form.pollIntervalS} onChange={(e) => set({ pollIntervalS: Number(e.target.value) || 0 })} />
            </Field>
          ) : null}

          <div className="notice info">上面这些上限只管自动消息。你在收件箱里手动发的，一律照发不误。</div>
        </Modal>
      ) : null}

      {deleting ? (
        <Confirm
          title={`删除账号「${deleting.name}」？`}
          body={'这个账号下的所有对话、联系人和消息记录会一起删掉，删了找不回来。\n\n只是想临时停一停的话，把状态改成「已暂停」就够了。'}
          confirmLabel="删除"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const id = deleting.id;
            void (async () => {
              try {
                await api.deleteAccount(id);
                await reload();
                toast.ok('账号已删除');
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
