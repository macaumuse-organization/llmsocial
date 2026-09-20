import { useState } from 'react';
import type { Provider, ProviderKind, ProviderPreset } from '../../shared/types.ts';
import { AsyncButton, Check, Confirm, Empty, Field, Loading, Modal, api, useAsync, useToast } from '../ui.tsx';

const KIND_LABELS: Record<ProviderKind, string> = {
  anthropic: 'Anthropic',
  openai_compat: 'OpenAI 兼容',
  gemini: 'Gemini',
  mock: 'Mock',
};

const KIND_HINTS: Record<ProviderKind, string> = {
  anthropic: 'Claude 官方接口，地址固定，不用填。',
  openai_compat: '走 /chat/completions 那套接口：OpenAI、DeepSeek、通义、Kimi、智谱、OpenRouter、本机 Ollama 都算。',
  gemini: 'Google 的 generativeLanguage 接口。',
  mock: '不联网的假模型，用来跑通流程、看界面，不花钱也不会真发请求。',
};

interface Form {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: string;
  maxTokens: string;
  effort: '' | 'low' | 'medium' | 'high';
  jsonMode: boolean;
  timeoutMs: string;
  priceIn: string;
  priceOut: string;
  dailyTokenLimit: string;
  enabled: boolean;
  priority: string;
}

const BLANK: Form = {
  name: '',
  kind: 'openai_compat',
  baseUrl: '',
  model: '',
  apiKey: '',
  temperature: '',
  maxTokens: '4000',
  effort: '',
  jsonMode: true,
  timeoutMs: '90000',
  priceIn: '',
  priceOut: '',
  dailyTokenLimit: '',
  enabled: true,
  priority: '100',
};

const str = (v: number | null) => (v === null ? '' : String(v));

function toForm(p: Provider): Form {
  return {
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKey: '',
    temperature: str(p.temperature),
    maxTokens: String(p.maxTokens),
    effort: p.effort ?? '',
    jsonMode: p.jsonMode,
    timeoutMs: String(p.timeoutMs),
    priceIn: str(p.priceIn),
    priceOut: str(p.priceOut),
    dailyTokenLimit: str(p.dailyTokenLimit),
    enabled: p.enabled,
    priority: String(p.priority),
  };
}

/** Empty or unparseable stays empty: the server treats null as "not set". */
function optNum(v: string): number | null {
  const n = Number(v.trim());
  return v.trim() === '' || !Number.isFinite(n) ? null : n;
}

function intOr(v: string, fallback: number): number {
  const n = optNum(v);
  return n === null ? fallback : Math.round(n);
}

interface Editing {
  provider: Provider | null;
  form: Form;
  /** Carried over from the preset the operator picked, shown next to the key field. */
  keyHint: string;
}

export function ModelsPage() {
  const toast = useToast();
  const providers = useAsync(() => api.providers(), []);
  const meta = useAsync(() => api.meta(), []);
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<Provider | null>(null);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setEditing((e) => (e ? { ...e, form: { ...e.form, [key]: value } } : e));

  const fromPreset = (preset: ProviderPreset) => {
    setPicking(false);
    setEditing({
      provider: null,
      keyHint: preset.keyHint,
      form: { ...BLANK, name: preset.label, kind: preset.kind, baseUrl: preset.baseUrl, model: preset.model },
    });
  };

  const save = async () => {
    if (!editing) return;
    const f = editing.form;
    if (f.name.trim() === '') throw new Error('给它起个名字，列表里要靠名字认');
    if (f.model.trim() === '') throw new Error('模型 ID 不能空');
    const keepsBaseUrl = f.kind === 'openai_compat' || f.kind === 'gemini';
    const limit = intOr(f.dailyTokenLimit, 0);
    const body: Record<string, unknown> = {
      name: f.name.trim(),
      kind: f.kind,
      baseUrl: keepsBaseUrl ? f.baseUrl.trim() : '',
      model: f.model.trim(),
      temperature: optNum(f.temperature),
      maxTokens: intOr(f.maxTokens, 4000),
      effort: f.kind === 'anthropic' && f.effort !== '' ? f.effort : null,
      jsonMode: f.jsonMode,
      timeoutMs: intOr(f.timeoutMs, 90_000),
      priceIn: optNum(f.priceIn),
      priceOut: optNum(f.priceOut),
      dailyTokenLimit: limit > 0 ? limit : null,
      enabled: f.enabled,
      priority: intOr(f.priority, 100),
    };
    // An empty key field means "leave it alone"; sending '' would wipe the stored reference.
    if (f.apiKey.trim() !== '') body.apiKey = f.apiKey.trim();
    if (editing.provider) await api.updateProvider(editing.provider.id, body);
    else await api.createProvider(body);
    setEditing(null);
    await providers.reload();
    toast.ok('已保存');
  };

  const list = providers.data ? [...providers.data].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, 'zh-Hans')) : [];
  const presets = meta.data?.providerPresets ?? [];

  return (
    <>
      <div className="topbar">
        <h1>模型</h1>
        <div className="spacer" />
        <button className="primary" onClick={() => setPicking(true)}>
          添加模型
        </button>
      </div>

      <div className="page">
        <div className="stack page-narrow">
          {providers.error ? <div className="notice danger">{providers.error}</div> : null}

          <div className="card">
            {providers.loading && !providers.data ? (
              <Loading />
            ) : list.length === 0 ? (
              <Empty>还没有配置模型。先加一个 Mock 就能把整套流程跑通，不花钱；要真发消息再换成正式的。</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>类型</th>
                      <th>模型</th>
                      <th>密钥</th>
                      <th>启用</th>
                      <th>优先级</th>
                      <th>每日 token 上限</th>
                      <th style={{ width: 170 }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <div>{p.name}</div>
                          {p.baseUrl ? <div className="faint mono">{p.baseUrl}</div> : null}
                        </td>
                        <td className="muted">{KIND_LABELS[p.kind]}</td>
                        <td className="mono">{p.model}</td>
                        <td>{p.hasApiKey ? <span className="badge accent">已配置</span> : <span className="badge">未配置</span>}</td>
                        <td>
                          <AsyncButton
                            className="sm"
                            title={p.enabled ? '点一下停用：停用后调度不会再选它' : '点一下启用'}
                            onClick={async () => {
                              await api.updateProvider(p.id, { enabled: !p.enabled });
                              await providers.reload();
                              toast.ok(p.enabled ? `已停用 ${p.name}` : `已启用 ${p.name}`);
                            }}
                          >
                            {p.enabled ? '已启用' : '已停用'}
                          </AsyncButton>
                        </td>
                        <td className="mono">{p.priority}</td>
                        <td className="muted">{p.dailyTokenLimit ? p.dailyTokenLimit.toLocaleString('en-US') : '不限'}</td>
                        <td>
                          <div className="row-tight">
                            <AsyncButton
                              className="sm"
                              title="发一次最短的试探请求，看看密钥和地址通不通"
                              onClick={async () => {
                                const res = await api.testProvider(p.id);
                                if (res.ok) toast.ok(res.detail || `${p.name} 通了`);
                                else toast.error(new Error(res.detail || `${p.name} 没通`));
                              }}
                            >
                              测试
                            </AsyncButton>
                            <button className="sm" onClick={() => setEditing({ provider: p, form: toForm(p), keyHint: '' })}>
                              编辑
                            </button>
                            <button className="sm danger" onClick={() => setRemoving(p)}>
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="notice info">
            按优先级依次尝试已启用的模型，也可以在聊天任务中指定模型和顺序。启用正式模型后，默认后备链不会使用离线 Mock。连续失败的模型会暂时跳过；每日调用上限包含重试与后备模型调用。
          </div>
        </div>
      </div>

      {picking ? (
        <Modal title="挑一个模型服务" onClose={() => setPicking(false)}>
          {meta.error ? <div className="notice danger">{meta.error}</div> : null}
          {meta.loading && !meta.data ? (
            <Loading />
          ) : (
            <>
              <div className="muted small">选好之后地址和模型 ID 会自动填上，你只要补密钥。</div>
              <div className="stack" style={{ gap: 6 }}>
                {presets.map((preset) => (
                  <button key={preset.label} className="row" style={{ justifyContent: 'flex-start' }} onClick={() => fromPreset(preset)}>
                    <span className="grow" style={{ textAlign: 'left' }}>
                      {preset.label}
                    </span>
                    <span className="mono faint">{preset.model}</span>
                  </button>
                ))}
              </div>
              <hr className="divider" />
              <button
                onClick={() => {
                  setPicking(false);
                  setEditing({ provider: null, form: { ...BLANK }, keyHint: '' });
                }}
              >
                自定义（自己填地址和模型）
              </button>
            </>
          )}
        </Modal>
      ) : null}

      {editing ? (
        <ModelEditor
          editing={editing}
          set={set}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      ) : null}

      {removing ? (
        <Confirm
          title="删除这个模型？"
          body={`删掉「${removing.name}」之后，指定用它的任务会落到下一个可用模型。存在本地的密钥也会一起删掉，改回来要重填。`}
          confirmLabel="删除"
          danger
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            void (async () => {
              try {
                await api.deleteProvider(removing.id);
                await providers.reload();
                toast.ok(`已删除 ${removing.name}`);
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

function ModelEditor({
  editing,
  set,
  onClose,
  onSave,
}: {
  editing: Editing;
  set: <K extends keyof Form>(key: K, value: Form[K]) => void;
  onClose: () => void;
  onSave: () => Promise<void>;
}) {
  const f = editing.form;
  const existing = editing.provider;
  const showsBaseUrl = f.kind === 'openai_compat' || f.kind === 'gemini';
  const keyHint =
    '三种写法：直接粘贴密钥（会用 AES-256-GCM 加密后存进本地数据库）、env:变量名（去环境变量里取）、keychain:服务名[:账号]（去 macOS 钥匙串取，密钥不进数据库）。留空而且从来没配过，就用环境变量里的默认凭据。' +
    (editing.keyHint ? ` 这家一般是：${editing.keyHint}` : '');

  return (
    <Modal
      title={existing ? `编辑 ${existing.name}` : '添加模型'}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <AsyncButton className="primary" onClick={onSave}>
            保存
          </AsyncButton>
        </>
      }
    >
      <div className="field-row">
        <Field label="名称" hint="只给你自己看，写清楚是哪家的哪个模型就行。">
          <input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="例如 DeepSeek 主力" />
        </Field>
        <Field label="类型" hint={KIND_HINTS[f.kind]}>
          <select value={f.kind} onChange={(e) => set('kind', e.target.value as ProviderKind)}>
            <option value="anthropic">Anthropic</option>
            <option value="openai_compat">OpenAI 兼容</option>
            <option value="gemini">Gemini</option>
            <option value="mock">Mock</option>
          </select>
        </Field>
      </div>

      {showsBaseUrl ? (
        <Field
          label="接口地址"
          hint={f.kind === 'gemini' ? '官方是 https://generativelanguage.googleapis.com，用自建中转才改。' : '要带到 /v1 这一层，比如 https://api.deepseek.com/v1；本机 Ollama 是 http://127.0.0.1:11434/v1。'}
        >
          <input value={f.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://" />
        </Field>
      ) : null}

      <Field label="模型" hint="服务商文档里那个准确的模型 ID，写错了调用直接报 404。">
        <input className="mono" value={f.model} onChange={(e) => set('model', e.target.value)} placeholder="claude-sonnet-5" />
      </Field>

      <Field label="API 密钥" hint={keyHint}>
        <input
          type="password"
          autoComplete="new-password"
          value={f.apiKey}
          onChange={(e) => set('apiKey', e.target.value)}
          placeholder={existing?.hasApiKey ? '已配置（留空则不变）' : 'sk-… 或 env:XXX_API_KEY'}
        />
      </Field>
      {existing?.hasApiKey && existing.apiKeyRef ? <div className="faint small mono">当前：{existing.apiKeyRef.startsWith('secret:') ? '已加密存在本地数据库' : existing.apiKeyRef}</div> : null}

      <div className="field-row">
        <Field label="temperature" hint="留空＝用模型自己的默认值。调低回答更稳更一致，调高更跳脱。">
          <input value={f.temperature} onChange={(e) => set('temperature', e.target.value)} placeholder="留空" inputMode="decimal" />
        </Field>
        <Field label="单次最多输出 token" hint="聊天回复本来就短，4000 绰绰有余。这只是上限，用多少算多少。">
          <input value={f.maxTokens} onChange={(e) => set('maxTokens', e.target.value)} inputMode="numeric" />
        </Field>
      </div>

      {f.kind === 'anthropic' ? (
        <Field label="思考投入（effort）" hint="Anthropic 专有。投入越高答得越细，也越慢越贵；日常回私信选 low 就够。">
          <select value={f.effort} onChange={(e) => set('effort', e.target.value as Form['effort'])}>
            <option value="">不设置（跟官方默认）</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </Field>
      ) : null}

      <Check checked={f.jsonMode} onChange={(v) => set('jsonMode', v)} label="JSON 模式" hint="让模型按 JSON 格式返回，解析更稳。少数中转代理不认这个参数，调用会直接报错，那就关掉，改靠提示词约束格式。" />

      <div className="field-row">
        <Field label="超时（毫秒）" hint="超过这么久还没回就算这次失败，自动换下一个模型。90000 就是 90 秒。">
          <input value={f.timeoutMs} onChange={(e) => set('timeoutMs', e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="优先级" hint="数字越小越先用。留空按 100 算。">
          <input value={f.priority} onChange={(e) => set('priority', e.target.value)} inputMode="numeric" />
        </Field>
      </div>

      <div className="field-row">
        <Field label="输入价格（美元／百万 token）" hint="照着服务商价目表填，只用来在界面上估个花费，不影响真实账单。留空就不估。">
          <input value={f.priceIn} onChange={(e) => set('priceIn', e.target.value)} placeholder="留空" inputMode="decimal" />
        </Field>
        <Field label="输出价格（美元／百万 token）" hint="同上，输出一般比输入贵好几倍。">
          <input value={f.priceOut} onChange={(e) => set('priceOut', e.target.value)} placeholder="留空" inputMode="decimal" />
        </Field>
      </div>

      <Field label="每日 token 上限" hint="按最近 24 小时累计。达到上限后跳过这个模型；正在进行的请求可能使总量超过上限。填 0 或留空表示不限。">
        <input value={f.dailyTokenLimit} onChange={(e) => set('dailyTokenLimit', e.target.value)} placeholder="不限" inputMode="numeric" />
      </Field>

      <Check checked={f.enabled} onChange={(v) => set('enabled', v)} label="启用" hint="关掉之后调度就不会再选它，配置和密钥都留着，随时能开回来。" />
    </Modal>
  );
}
