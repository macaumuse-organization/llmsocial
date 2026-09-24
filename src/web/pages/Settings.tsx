import { useEffect, useState } from 'react';
import type { NetworkTestResult, Settings } from '../../shared/types.ts';
import { AsyncButton, Check, Field, Loading, api, useAsync, useToast } from '../ui.tsx';

const OCR_ENGINES: { value: Settings['ocrEngine']; label: string }[] = [
  { value: 'auto', label: 'auto —— 系统自带（macOS Vision / Windows OCR），能用就用' },
  { value: 'vision', label: 'vision —— 强制使用，不可用时直接报错' },
  { value: 'off', label: 'off —— 关掉截图识别，只手动粘贴文字' },
];

export function SettingsPage() {
  const toast = useToast();
  const settings = useAsync(() => api.settings(), []);
  const meta = useAsync(() => api.meta(), []);
  const [form, setForm] = useState<Settings | null>(null);
  const [netResult, setNetResult] = useState<NetworkTestResult[] | null>(null);

  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  const dirty = form !== null && settings.data !== null && JSON.stringify(form) !== JSON.stringify(settings.data);

  return (
    <>
      <div className="topbar">
        <h1>设置</h1>
        <div className="spacer" />
        {dirty ? (
          <button className="ghost" onClick={() => setForm(settings.data)}>
            撤销改动
          </button>
        ) : null}
        <AsyncButton
          className="primary"
          disabled={!dirty}
          onClick={async () => {
            if (!form) return;
            await api.saveSettings(form);
            await settings.reload();
            toast.ok('设置已保存，立刻生效');
          }}
        >
          保存
        </AsyncButton>
      </div>
      <div className="page">
        <div className="stack page-narrow">
          {settings.error ? <div className="notice danger">{settings.error}</div> : null}
          {!form ? (
            settings.error ? null : (
              <Loading />
            )
          ) : (
            <>
              <div className="card">
                <div className="card-head">
                  <h2 className="grow">自动发送</h2>
                </div>
                <div className="stack card-pad">
                  <Check
                    checked={form.autopilotPaused}
                    onChange={(v) => set('autopilotPaused', v)}
                    label="暂停全部自动发送"
                    hint="打开之后 AI 照常读消息、照常起草，但任何一条都要你点过确认才发得出去。这是总开关，出事先按这个，不用去一个个任务里翻。"
                  />
                  {form.autopilotPaused ? <div className="notice warn">现在所有自动回复都停着，只出草稿。记得处理完再关掉，不然对方一直等不到回音。</div> : null}
                  <hr className="divider" />
                  <Check
                    checked={form.pauseOnOperatorReply}
                    onChange={(v) => set('pauseOnOperatorReply', v)}
                    label="你插话后，这段对话转回起草模式"
                    hint="你自己手动回了一条，说明这段对话你要亲自谈，AI 就不再自动接管，之后只给草稿等你确认。关掉的话 AI 会在你回完之后继续自动跟聊。"
                  />
                  <Check
                    checked={form.optOutAck}
                    onChange={(v) => set('optOutAck', v)}
                    label="对方退订时回一句确认再停"
                    hint="对方说别再联系，自动回一句「好的，不打扰了」，然后彻底闭嘴。关掉就一个字都不回，对方那边看着像被无视。退订是永久的，会跨所有账号屏蔽这个人。"
                  />
                  <div className="field-row">
                    <Field label="回复前等待（毫秒）" hint="对方一口气连发好几条时，等最后一条落地之后再过这么久才动笔，免得对着半句话作答。太短会抢话，太长显得反应慢。默认 8000。">
                      <input type="number" min={0} step={500} value={form.debounceMs} onChange={(e) => set('debounceMs', Number(e.target.value))} />
                    </Field>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <h2 className="grow">模型调用</h2>
                </div>
                <div className="stack card-pad">
                  <div className="field-row">
                    <Field label="带上最近多少条消息" hint="每次生成回复时塞给模型的对话条数。给多了更懂来龙去脉，但每次调用都更贵、更慢。">
                      <input type="number" min={1} value={form.maxContextMessages} onChange={(e) => set('maxContextMessages', Number(e.target.value))} />
                    </Field>
                    <Field label="每多少条压缩一次记忆" hint="聊到一定长度，让模型把更早的内容压成一段长期记忆，接着往下聊不至于失忆。填 0 关闭，长对话就只剩上面那个条数窗口。">
                      <input type="number" min={0} value={form.summarizeEvery} onChange={(e) => set('summarizeEvery', Number(e.target.value))} />
                    </Field>
                    <Field label="每天最多调用模型次数" hint="24 小时内的调用上限，防止哪个环节抽风把额度烧光。撞到上限后新的对话一律转人工，不再生成。">
                      <input type="number" min={0} value={form.dailyLlmCallLimit} onChange={(e) => set('dailyLlmCallLimit', Number(e.target.value))} />
                    </Field>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <h2 className="grow">网络代理</h2>
                  <span className={form.proxyEnabled ? 'badge accent' : 'badge'}>{settings.data?.proxyEnabled ? '现在：走代理' : '现在：直连'}</span>
                </div>
                <div className="stack card-pad">
                  <Check
                    checked={form.proxyEnabled}
                    onChange={(v) => set('proxyEnabled', v)}
                    label="对外请求走代理"
                    hint="要开 VPN 才能上 Google、X、Instagram 时打开。保存后立刻生效，不用重启。浏览器能打开 Google 不代表程序能连上：浏览器自动走 Windows 系统代理，程序只认这里。"
                  />
                  <Field label="代理地址" hint="Windows「设置 → 网络和 Internet → 代理」里手动代理的地址和端口，写成 http://地址:端口。">
                    <input value={form.proxyUrl} onChange={(e) => set('proxyUrl', e.target.value)} placeholder="http://127.0.0.1:18081" style={{ maxWidth: 360 }} />
                  </Field>
                  <Field label="不走代理的地址" hint="逗号分隔。本机和国内服务放在这里，VPN 关掉时它们照样能用。前面带点表示整个域名，比如 .aliyuncs.com。">
                    <input value={form.noProxy} onChange={(e) => set('noProxy', e.target.value)} />
                  </Field>
                  {form.proxyEnabled && form.proxyUrl.trim() === '' ? <div className="notice warn">打开代理之前先填代理地址，不然保存不了。</div> : null}
                  <div className="row-tight">
                    <AsyncButton disabled={dirty} title={dirty ? '测的是已保存的设置，先点右上角保存' : '看看现在能不能连上海外和国内的服务'} onClick={async () => setNetResult(await api.networkTest())}>
                      测试网络
                    </AsyncButton>
                    {dirty ? <span className="small muted">改动保存后才能测</span> : null}
                  </div>
                  {netResult ? (
                    <div className="stack" style={{ gap: 4 }}>
                      {netResult.map((r) => (
                        <div key={r.name} className="small">
                          {r.ok ? `✓ ${r.name}：连得上（${r.ms} ms）` : `✗ ${r.name}：连不上，${r.error}`}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <h2 className="grow">留存与截图识别</h2>
                </div>
                <div className="stack card-pad">
                  <Field
                    label="记录保留天数"
                    hint="超过这个天数的已结束对话、事件和模型调用记录会被自动删掉。填 0 就永久保留。注意：模型调用记录里存着完整的提示词和对方说过的原话，是这套系统里最敏感的数据，留得越久风险越大。"
                  >
                    <input type="number" min={0} value={form.retentionDays} onChange={(e) => set('retentionDays', Number(e.target.value))} style={{ maxWidth: 220 }} />
                  </Field>
                  <hr className="divider" />
                  <Field
                    label="截图识别引擎"
                    hint="从聊天截图导入记录时用的识别方式。macOS 走自带的 Vision 框架，Windows 走系统自带的 OCR；两种都只在本机识别，图片不会传给任何模型或服务器。"
                  >
                    <select value={form.ocrEngine} onChange={(e) => set('ocrEngine', e.target.value as Settings['ocrEngine'])} style={{ maxWidth: 360 }}>
                      {OCR_ENGINES.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {meta.error ? <div className="notice warn">读不到本机能力信息（{meta.error}），暂时判断不了截图识别可不可用。</div> : null}
                  {meta.data && !meta.data.ocrAvailable ? <div className="notice warn">{meta.data.ocrHint}</div> : null}
                  {meta.data && meta.data.ocrAvailable ? <div className="small muted">{meta.data.ocrHint}</div> : null}
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <h2 className="grow">数据与安全</h2>
                </div>
                <div className="stack card-pad small muted">
                  <p>
                    所有对话、联系人和模型调用记录都写在本机的 <span className="mono">data/llmsocial.db</span> 里，没有云端副本，删掉文件就等于销毁。
                  </p>
                  <p>API 密钥用 AES-256-GCM 加密后才落盘；主密钥优先放 macOS 钥匙串，钥匙串不可用时才退回本地密钥文件。数据库本身没有密钥明文。</p>
                  <p>管理界面只监听回环地址，同一局域网里的其它机器连不上，要远程用请自己套 SSH 隧道，别直接把端口暴露出去。</p>
                  <p>
                    平台回调地址：
                    {meta.data ? (
                      meta.data.webhookBaseUrl ? (
                        <span className="mono">{meta.data.webhookBaseUrl}</span>
                      ) : (
                        <span className="faint">未配置，需要回调的连接方式暂时收不到消息</span>
                      )
                    ) : meta.error ? (
                      <span className="faint">读不到</span>
                    ) : (
                      <span className="faint">读取中…</span>
                    )}
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
