import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Account, CompareCandidate, ConversationDetail, ConversationListItem, LlmCall, Message, ParsedChatMessage } from '../../shared/types.ts';
import type { LlmCallSummary } from '../api.ts';
import { navigate, useRoute } from '../route.ts';
import { Icon } from '../Icon.tsx';
import { AsyncButton, Check, Confirm, Empty, Field, Loading, Modal, PLATFORM_LABELS, STAGE_LABELS, STATE_LABELS, STATUS_LABELS, api, clockTime, readAsDataUrl, timeAgo, useAsync, useStream, useToast } from '../ui.tsx';

const FILTERS = [
  { key: 'action', label: '待处理' },
  { key: 'active', label: '进行中' },
  { key: 'handoff', label: '待人工' },
  { key: 'all', label: '全部' },
];

const RISK_LABELS: Record<string, string> = {
  payment: '付款转账',
  verification_code: '验证码',
  credentials: '账号密码',
  personal_id: '证件号码',
  contract: '合同',
  legal: '法律/报警',
  self_harm: '自残或轻生',
  minor: '疑似未成年',
  harassment: '指责骚扰',
};

const SENTIMENT: Record<string, string> = { positive: '积极', neutral: '中性', negative: '消极' };

function messageClass(m: Message): string {
  const parts = ['msg'];
  if (m.direction === 'out') parts.push('out');
  if (m.status === 'pending_approval') parts.push('draft');
  if (m.status === 'failed') parts.push('failed');
  if (['rejected', 'superseded', 'cancelled'].includes(m.status)) parts.push('dead');
  return parts.join(' ');
}

function authorLabel(m: Message): string {
  if (m.direction === 'in') return '';
  if (m.author === 'operator') return '你';
  if (m.author === 'external') return '你（在平台上）';
  return m.kind === 'disclosure' ? 'AI · 身份说明' : m.kind === 'optout_ack' ? 'AI · 退订确认' : 'AI';
}

// ---------------------------------------------------------------- conversation list

function ConversationList({ items, selected, loading }: { items: ConversationListItem[]; selected: string; loading: boolean }) {
  if (loading && items.length === 0) return <Loading />;
  if (items.length === 0) return <Empty>这里还没有对话。收到消息、或者用「导入截图」把手机上的聊天记录导进来。</Empty>;
  return (
    <>
      {items.map((c) => {
        const needsYou = c.pendingDrafts > 0 || c.failedMessages > 0 || c.state === 'handoff';
        return (
          <button key={c.id} className="conv" aria-current={c.id === selected} onClick={() => navigate('inbox', c.id)}>
            <div className="line">
              {c.unread > 0 ? <span className="dot" /> : null}
              <span className="name">{c.contactName || c.contactHandle || '未知联系人'}</span>
              <span className="time">{timeAgo(c.lastMessageAt ?? c.createdAt)}</span>
            </div>
            <div className="snippet">
              {c.lastDirection === 'out' ? '我方：' : ''}
              {c.lastText || '（还没有消息）'}
            </div>
            <div className="line small">
              <span className="faint">{PLATFORM_LABELS[c.platform]} · {c.accountName}</span>
              {c.state !== 'active' ? <span className={`badge ${c.state === 'handoff' ? 'warn' : c.state === 'opted_out' ? 'danger' : ''}`}>{STATE_LABELS[c.state]}</span> : null}
              {needsYou && c.state !== 'handoff' ? <span className="badge accent">{c.failedMessages > 0 ? '发送失败' : '待审核'}</span> : null}
            </div>
          </button>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------- message + draft actions

function MessageRow({ m, detail, refresh }: { m: Message; detail: ConversationDetail; refresh: () => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null);
  const toast = useToast();
  const isDraft = m.status === 'pending_approval';
  const canSend = detail.canSend;

  return (
    <div className={messageClass(m)}>
      {isDraft && editing !== null ? (
        <div className="card card-pad" style={{ width: 'min(560px, 90%)' }}>
          <textarea value={editing} onChange={(e) => setEditing(e.target.value)} style={{ minHeight: 90 }} />
        </div>
      ) : (
        <div className="bubble">{m.text}</div>
      )}
      <div className="meta">
        {authorLabel(m)}
        {m.direction === 'out' && m.status !== 'sent' ? <span className={`badge ${m.status === 'failed' ? 'danger' : m.status === 'pending_approval' ? 'accent' : ''}`}>{STATUS_LABELS[m.status]}</span> : null}
        <span>{clockTime(m.sentAt ?? m.sendAt ?? m.createdAt)}</span>
        {m.reviewReason ? <span className="badge warn">{m.reviewReason}</span> : null}
      </div>
      {m.error && m.status === 'failed' ? <div className="meta" style={{ color: 'var(--danger)', maxWidth: 480, textAlign: 'right' }}>{m.error}</div> : null}
      {isDraft ? (
        <div className="draft-actions">
          {editing !== null ? (
            <button className="ghost sm" onClick={() => setEditing(null)}>
              取消编辑
            </button>
          ) : (
            <button className="sm" onClick={() => setEditing(m.text)}>
              编辑
            </button>
          )}
          {canSend ? (
            <AsyncButton
              className="primary sm"
              onClick={async () => {
                await api.approve(m.id, editing ?? undefined);
                setEditing(null);
                await refresh();
              }}
            >
              批准发送
            </AsyncButton>
          ) : (
            <>
              <AsyncButton className="primary sm" disabled={(editing ?? m.text).trim() === ''} onClick={async () => {
                await navigator.clipboard.writeText(editing ?? m.text);
                toast.ok('已复制，请到平台发送');
              }}>复制回复</AsyncButton>
              <AsyncButton className="sm" disabled={(editing ?? m.text).trim() === ''} title="在平台实际发送后再确认" onClick={async () => {
                await api.markSent(m.id, editing ?? undefined);
                setEditing(null);
                await refresh();
              }}>我已在平台发送</AsyncButton>
            </>
          )}
          <AsyncButton
            className="danger sm"
            onClick={async () => {
              await api.discard(m.id);
              await refresh();
            }}
          >
            丢弃
          </AsyncButton>
        </div>
      ) : null}
      {m.status === 'failed' ? (
        <div className="draft-actions">
          <AsyncButton
            className="sm"
            onClick={async () => {
              await api.retry(m.id);
              await refresh();
            }}
          >
            重试发送
          </AsyncButton>
          <AsyncButton
            className="ghost sm"
            onClick={async () => {
              await api.markSent(m.id);
              await refresh();
            }}
          >
            我已手动发过了
          </AsyncButton>
        </div>
      ) : null}
      {m.status === 'scheduled' && m.sendAt ? (
        <div className="draft-actions">
          <span className="meta">将在 {clockTime(m.sendAt)} 发出</span>
          <AsyncButton
            className="ghost sm"
            onClick={async () => {
              await api.discard(m.id);
              await refresh();
            }}
          >
            撤回
          </AsyncButton>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- side panel

function ContactPanel({ detail, refresh }: { detail: ConversationDetail; refresh: () => Promise<void> }) {
  const { conversation: c, contact } = detail;
  const [notes, setNotes] = useState(contact.notes);
  const [calls, setCalls] = useState<LlmCallSummary[]>([]);
  const [inspect, setInspect] = useState<LlmCall | null>(null);
  const toast = useToast();

  useEffect(() => setNotes(contact.notes), [contact.id, contact.notes]);
  useEffect(() => {
    api.llmCalls(c.id).then(setCalls).catch(() => setCalls([]));
  }, [c.id, c.updatedAt]);

  const analysis = c.lastAnalysis;

  return (
    <aside className="aside">
      <div>
        <h3>{contact.displayName || contact.handle || '未知联系人'}</h3>
        <div className="small muted">{contact.handle ? `${contact.handle} · ` : ''}{PLATFORM_LABELS[c.platform]}</div>
      </div>
      <dl className="kv">
        <dt>账号</dt>
        <dd>{c.accountName}</dd>
        <dt>任务</dt>
        <dd>{c.campaignName ?? '（未指定）'}</dd>
        <dt>阶段</dt>
        <dd>{STAGE_LABELS[c.stage] ?? c.stage}</dd>
        <dt>AI 轮数</dt>
        <dd>{c.aiTurns}</dd>
        <dt>语言</dt>
        <dd>{contact.language || '未知'}</dd>
        <dt>最后往来</dt>
        <dd>{timeAgo(c.lastMessageAt)}</dd>
      </dl>
      <div>
        <div className="small muted">目标进度 {c.goalProgress}%</div>
        <div className="bar">
          <i style={{ width: `${c.goalProgress}%` }} />
        </div>
      </div>

      {analysis ? (
        <div className="card card-pad stack" style={{ gap: 8 }}>
          <h3>AI 的判断</h3>
          <div className="small">{analysis.intent || '（无）'}</div>
          <div className="row-tight">
            <span className="badge">{SENTIMENT[analysis.sentiment] ?? analysis.sentiment}</span>
            {analysis.riskFlags.map((f) => (
              <span key={f} className="badge danger">
                {RISK_LABELS[f] ?? f}
              </span>
            ))}
          </div>
          {analysis.notes ? <div className="small muted pre-wrap">{analysis.notes}</div> : null}
        </div>
      ) : null}

      {contact.facts.length > 0 || contact.summary ? (
        <div className="card card-pad stack" style={{ gap: 8 }}>
          <h3>长期记忆</h3>
          {contact.summary ? <div className="small pre-wrap">{contact.summary}</div> : null}
          {contact.facts.map((f, i) => (
            <div key={i} className="small muted">
              · {f}
            </div>
          ))}
        </div>
      ) : null}

      <Field label="你的备注" hint="只有你看得到，也会作为背景给到 AI。">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={async () => {
            if (notes === contact.notes) return;
            try {
              await api.updateContact(contact.id, { notes });
              await refresh();
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      </Field>

      <div className="stack" style={{ gap: 6 }}>
        <h3>模型调用</h3>
        {calls.length === 0 ? <div className="small muted">还没有调用记录。</div> : null}
        {calls.slice(0, 8).map((call) => (
          <button
            key={call.id}
            className="ghost sm"
            style={{ justifyContent: 'space-between', width: '100%' }}
            onClick={async () => {
              try {
                setInspect(await api.llmCall(call.id));
              } catch (err) {
                toast.error(err);
              }
            }}
          >
            <span className={call.ok ? '' : 'badge danger'}>{call.ok ? call.providerName : '失败'}</span>
            <span className="faint small">
              {call.inputTokens + call.outputTokens} tok · {call.latencyMs} ms
            </span>
          </button>
        ))}
      </div>

      {inspect ? (
        <Modal title={`提示词 · ${inspect.providerName} / ${inspect.model}`} wide onClose={() => setInspect(null)}>
          {inspect.error ? <div className="notice danger">{inspect.error}</div> : null}
          <Field label="系统提示词">
            <div className="card card-pad mono pre-wrap" style={{ maxHeight: 280, overflow: 'auto' }}>
              {inspect.systemPrompt}
            </div>
          </Field>
          <Field label="用户消息">
            <div className="card card-pad mono pre-wrap" style={{ maxHeight: 200, overflow: 'auto' }}>
              {inspect.userPrompt}
            </div>
          </Field>
          <Field label="模型原始输出">
            <div className="card card-pad mono pre-wrap" style={{ maxHeight: 200, overflow: 'auto' }}>
              {inspect.rawResponse || '（空）'}
            </div>
          </Field>
        </Modal>
      ) : null}
    </aside>
  );
}

// ---------------------------------------------------------------- compare models

function CompareModal({ conversationId, onClose, refresh }: { conversationId: string; onClose: () => void; refresh: () => Promise<void> }) {
  const providers = useAsync(() => api.providers(), []);
  const [picked, setPicked] = useState<string[]>([]);
  const [hint, setHint] = useState('');
  const [results, setResults] = useState<CompareCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (providers.data && picked.length === 0) setPicked(providers.data.filter((p) => p.enabled).slice(0, 3).map((p) => p.id));
  }, [providers.data, picked.length]);

  const run = async () => {
    setBusy(true);
    try {
      setResults(await api.compare(conversationId, picked, hint));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="比较不同模型的回复"
      wide
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>关闭</button>
          <button className="primary" disabled={busy || picked.length === 0} onClick={run}>
            {busy ? '生成中…' : results ? '重新生成' : '生成'}
          </button>
        </>
      }
    >
      <div className="notice info">同一段对话、同一套技能，交给不同模型各写一稿。选中一稿会变成待审核的草稿，不会直接发出。</div>
      <Field label="参与比较的模型">
        <div className="row">
          {(providers.data ?? []).map((p) => (
            <Check
              key={p.id}
              checked={picked.includes(p.id)}
              onChange={(v) => setPicked((prev) => (v ? [...prev, p.id] : prev.filter((x) => x !== p.id)))}
              label={`${p.name}${p.enabled ? '' : '（已停用）'}`}
            />
          ))}
        </div>
      </Field>
      <Field label="给 AI 的额外提示（可选）" hint="例如「更短一点」「先别提产品」。只影响这一次生成。">
        <input value={hint} onChange={(e) => setHint(e.target.value)} />
      </Field>
      {results?.map((r) => (
        <div key={r.providerId} className="card card-pad stack" style={{ gap: 8 }}>
          <div className="row">
            <strong>{r.providerName}</strong>
            <span className="faint small">{r.model}</span>
            <div className="grow" />
            <span className="faint small">{r.latencyMs} ms</span>
          </div>
          {r.ok ? (
            <>
              {r.messages.map((text, i) => (
                <div key={i} className="bubble" style={{ maxWidth: '100%' }}>
                  {text}
                </div>
              ))}
              {r.analysis ? (
                <div className="small muted">
                  判断：{r.analysis.intent || '—'} · 阶段 {STAGE_LABELS[r.analysis.stage] ?? r.analysis.stage} · 进度 {r.analysis.goalProgress}%
                </div>
              ) : null}
              <div className="row">
                <AsyncButton
                  className="primary sm"
                  onClick={async () => {
                    await api.adopt(conversationId, r.messages, r.llmCallId);
                    await refresh();
                    onClose();
                  }}
                >
                  用这一稿
                </AsyncButton>
              </div>
            </>
          ) : (
            <div className="notice danger">{r.error}</div>
          )}
        </div>
      ))}
    </Modal>
  );
}

// ---------------------------------------------------------------- screenshot import

function ImportModal({ accounts, initial, onClose, onDone }: { accounts: Account[]; initial?: ConversationDetail | null; onClose: () => void; onDone: (conversationId: string) => void }) {
  const manual = accounts.filter((a) => a.connector === 'manual' || a.connector === 'sandbox');
  const existing = manual.some((a) => a.id === initial?.conversation.accountId) ? initial : null;
  const [accountId, setAccountId] = useState(existing?.conversation.accountId ?? manual[0]?.id ?? '');
  const [name, setName] = useState(existing?.contact.displayName ?? '');
  const [userId, setUserId] = useState(existing?.contact.platformUserId ?? '');
  const [rows, setRows] = useState<ParsedChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  // 截图识别只有 macOS 有。别让人选完文件才从报错里知道。
  const meta = useAsync(() => api.meta(), []);
  const ocrOff = meta.data ? !meta.data.ocrAvailable : false;

  const onFile = async (file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('请选择图片文件'); return; }
    if (file.size > 16 * 1024 * 1024) { toast.error('图片不能超过 16 MB，请缩小后再导入'); return; }
    setBusy(true);
    try {
      const parsed = await api.ocr(await readAsDataUrl(file));
      if (parsed.messages.length === 0) toast.info('没有识别到聊天内容，可以手动添加。');
      setRows((prev) => [...prev, ...parsed.messages]);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const messages = rows.filter((r) => r.text.trim() !== '');
    if (messages.length === 0) throw new Error('没有可导入的消息');
    if (!name.trim() && !userId.trim()) throw new Error('填写对方称呼或标识');
    if (messages.length > 100) throw new Error('每次最多导入 100 条消息，请分批导入');
    const sameThread = existing && existing.conversation.accountId === accountId && existing.contact.platformUserId === userId.trim();
    const detail = await api.importMessages({
      accountId,
      contact: { platformUserId: userId.trim() || `manual_${crypto.randomUUID()}`, displayName: name.trim() },
      ...(sameThread ? { threadRef: existing.conversation.threadRef, kind: existing.conversation.kind, title: existing.conversation.title } : {}),
      messages,
      generate: true,
    });
    onDone(detail.conversation.id);
  };

  return (
    <Modal
      title="导入聊天记录"
      wide
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <AsyncButton className="primary" disabled={busy || !accountId || rows.length === 0} onClick={submit}>
            导入并起草回复
          </AsyncButton>
        </>
      }
    >
      {ocrOff ? (
        <div className="notice warn">这台机器识别不了截图（本机 OCR 只有 macOS 有）。用下面的「手动添加一条」把聊天内容填进来，一样能起草回复。</div>
      ) : (
        <div className="notice info">截图只在本机用系统自带的 OCR 识别，不会上传到任何服务。识别结果可以逐条改，左右标错了点一下就能换边。</div>
      )}
      <div className="field-row">
        <Field label="导入到哪个账号" hint="只能选人工桥接或沙盒账号。">
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {manual.length === 0 ? <option value="">（先去账号页建一个人工桥接账号）</option> : null}
            {manual.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {PLATFORM_LABELS[a.platform]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="对方称呼">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 小王" />
        </Field>
        <Field label="对方标识（可选）" hint="相同账号下，填写相同标识可继续已有对话；留空会新建联系人。">
          <input value={userId} onChange={(e) => setUserId(e.target.value)} />
        </Field>
      </div>
      <Field label="截图" hint={ocrOff ? '本机识别不可用，这里选不了。' : '可以一次选多张，按聊天顺序从上到下。'}>
        <input type="file" accept="image/*" multiple disabled={busy || ocrOff} onChange={(e) => Array.from(e.target.files ?? []).reduce<Promise<void>>((p, f) => p.then(() => onFile(f)), Promise.resolve())} />
      </Field>
      {busy ? <div className="small muted">识别中…</div> : null}
      <div className="stack" style={{ gap: 6 }}>
        {rows.map((row, i) => (
          <div key={i} className="row-tight">
            <button className="sm" style={{ width: 62 }} onClick={() => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, side: r.side === 'me' ? 'contact' : 'me' } : r)))}>
              {row.side === 'me' ? '我方' : '对方'}
            </button>
            <input className="grow" value={row.text} onChange={(e) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, text: e.target.value } : r)))} />
            <button className="ghost sm" onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        <button className="sm" onClick={() => setRows((prev) => [...prev, { side: 'contact', text: '' }])}>
          + 手动添加一条
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- page

export function InboxPage() {
  const route = useRoute();
  const selected = route.param;
  const [filter, setFilter] = useState('action');
  const [accountId, setAccountId] = useState('');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [hint, setHint] = useState('');
  const [comparing, setComparing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [showContact, setShowContact] = useState(false);
  const [sending, setSending] = useState(false);
  const sendLock = useRef(false);
  const activeSelected = useRef(selected);
  activeSelected.current = selected;
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const bodyRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  const accounts = useAsync(() => api.accounts(), []);
  const campaigns = useAsync(() => api.campaigns(), []);

  const filters = useMemo(
    () => ({
      needsAction: filter === 'action',
      state: filter === 'active' || filter === 'handoff' ? filter : undefined,
      accountId: accountId || undefined,
      q: search || undefined,
    }),
    [filter, accountId, search],
  );

  const list = useAsync(() => api.conversations(filters), [filters]);
  const detail = useAsync(async () => (selected ? api.conversation(selected) : null), [selected]);

  const refresh = useCallback(async () => {
    await Promise.all([detail.reload(), list.reload()]);
  }, [detail, list]);

  useStream((event) => {
    if (event.type === 'conversation') {
      void list.reload();
      if (event.conversationId === selected) void detail.reload();
    }
  });

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail.data?.messages.length, selected]);

  useEffect(() => {
    setDraft('');
    setHint('');
    setComparing(false);
    setConfirmClose(false);
    setShowContact(false);
  }, [selected]);

  const d = detail.data?.conversation.id === selected ? detail.data : null;
  const c = d?.conversation;

  const send = async () => {
    const text = draft.trim();
    if (text === '' || !selected || sendLock.current || !d) return;
    sendLock.current = true;
    setSending(true);
    try {
      await api.sendMessage(selected, text);
      if (activeSelected.current === selected) {
        if (currentDraft.current === draft) setDraft('');
        await refresh();
      }
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  };

  return (
    <div className={`inbox ${d ? 'with-aside' : ''} ${selected ? '' : 'show-list'}`}>
      <div className="inbox-list">
        <div className="inbox-heading"><h1>收件箱</h1><span className="badge">{list.data?.length ?? 0}</span></div>
        <div className="inbox-filters">
          <div className="row-tight inbox-tabs">
            {FILTERS.map((f) => (
              <button key={f.key} className={filter === f.key ? 'primary sm' : 'sm'} onClick={() => setFilter(f.key)}>
                {f.label}
              </button>
            ))}
          </div>
          <input aria-label="搜索对话" type="search" maxLength={100} placeholder="搜索名字或帖子" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select aria-label="筛选账号" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">全部账号</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {PLATFORM_LABELS[a.platform]}
              </option>
            ))}
          </select>
          <button className="primary import-button" onClick={() => setImporting(true)}>
            导入截图 / 聊天记录
          </button>
        </div>
        <div className="inbox-scroll">
          {list.error ? <div className="notice danger" role="alert">{list.error}<button className="sm" onClick={() => void list.reload()}>重试</button></div> : null}
          <ConversationList items={list.data ?? []} selected={selected} loading={list.loading} />
        </div>
      </div>

      {!d || !c ? (
        <div className="thread">
          <div className="thread-empty">
            {detail.error ? <><h2>暂时无法打开对话</h2><p>{detail.error}</p><button onClick={() => void detail.reload()}>重试</button><button className="ghost" onClick={() => navigate('inbox')}>返回收件箱</button></> : selected ? <Loading /> : <><div className="empty-symbol"><Icon name="message" size={36} /></div><h2>选择一段对话</h2><p>查看消息、了解上下文，再准备合适的回复。</p><div className="row"><button className="primary" onClick={() => setImporting(true)}>导入聊天记录</button><button onClick={() => navigate('accounts')}>管理账号</button></div></>}
          </div>
        </div>
      ) : (
        <div className="thread">
          <div className="thread-head">
            <button className="ghost sm" aria-label="返回列表" onClick={() => navigate('inbox')} title="返回列表">
              ‹
            </button>
            <div className="grow thread-identity">
              <strong>{c.contactName || c.contactHandle || '未知联系人'}</strong>
              <div className="small faint">
                {PLATFORM_LABELS[c.platform]} · {c.accountName}
                {c.title ? ` · ${c.title}` : ''}
                {c.kind === 'comment' ? ' · 公开评论' : ''}
              </div>
            </div>
            <span className={`badge ${c.state === 'handoff' ? 'warn' : c.state === 'opted_out' ? 'danger' : 'info'}`}>{STATE_LABELS[c.state]}</span>
            <button className="sm contact-toggle" onClick={() => setShowContact(true)}>联系人资料</button>
            {!d.canSend ? <button className="sm" onClick={() => setImporting(true)}>补充聊天记录</button> : null}
            <div className="thread-controls">
            <select
              value={c.campaignId ?? ''}
              title="这段对话使用的聊天任务"
              style={{ width: 150 }}
              onChange={async (e) => {
                try {
                  await api.updateConversation(c.id, { campaignId: e.target.value || null });
                  await refresh();
                } catch (err) {
                  toast.error(err);
                }
              }}
            >
              <option value="">（不指定任务）</option>
              {(campaigns.data ?? []).map((cp) => (
                <option key={cp.id} value={cp.id}>
                  {cp.name}
                </option>
              ))}
            </select>
            <select
              value={c.modeOverride ?? ''}
              title="这段对话的回复模式"
              style={{ width: 132 }}
              onChange={async (e) => {
                try {
                  await api.updateConversation(c.id, { modeOverride: e.target.value === '' ? null : e.target.value });
                  await refresh();
                } catch (err) {
                  toast.error(err);
                }
              }}
            >
              <option value="">跟随任务（{c.effectiveMode === 'autopilot' ? '自动回复' : 'AI 起草'}）</option>
              <option value="copilot">只起草</option>
              <option value="autopilot" disabled={!d.canSend}>
                自动回复
              </option>
            </select>
            {c.state !== 'opted_out' ? (
              <button className="ghost sm" onClick={() => setConfirmClose(true)} title="结束这段对话">
                结束
              </button>
            ) : null}
            </div>
          </div>

          {c.stateReason ? <div className={`notice ${c.state === 'handoff' ? 'warn' : c.state === 'opted_out' ? 'danger' : 'info'}`} style={{ borderRadius: 0 }}>{c.stateReason}</div> : null}

          <div className="thread-body" ref={bodyRef}>
            {d.messages.length === 0 ? <Empty>还没有消息。可以直接写一条，或者让 AI 起草一条开场白。</Empty> : null}
            {d.messages.map((m) => (
              <MessageRow key={m.id} m={m} detail={d} refresh={refresh} />
            ))}
          </div>

          <div className="thread-foot">
            <div className="row-tight composer-tools">
              <input aria-label="给 AI 的提示" className="grow" placeholder="给 AI 的提示，例如：先了解对方的需求" value={hint} onChange={(e) => setHint(e.target.value)} />
              <AsyncButton
                className="sm"
                onClick={async () => {
                  await api.generate(c.id, { trigger: d.messages.length === 0 ? 'opener' : 'regenerate', operatorHint: hint });
                  setHint('');
                  await refresh();
                }}
              >
                让 AI 起草
              </AsyncButton>
              <button className="sm" onClick={() => setComparing(true)}>
                比较模型
              </button>
            </div>
            <div className="row-tight composer-send">
              <textarea
                aria-label="回复内容"
                className="grow"
                placeholder={d.canSend ? '自己写一条（发出后这段对话会转成起草模式）' : '自己写一条（这个账号不能自动发送，保存后请手动发到平台）'}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void send().catch(toast.error);
                }}
                style={{ minHeight: 56 }}
              />
              <AsyncButton className="primary" disabled={sending || draft.trim() === ''} onClick={send}>
                {sending ? '处理中…' : d.canSend ? '发送' : '保存待发送'}
              </AsyncButton>
            </div>
          </div>
        </div>
      )}

      {d && c ? <ContactPanel key={c.id} detail={d} refresh={refresh} /> : null}
      {showContact && d ? <Modal title="联系人资料" onClose={() => setShowContact(false)}><ContactPanel key={d.conversation.id} detail={d} refresh={refresh} /></Modal> : null}

      {comparing && selected ? <CompareModal conversationId={selected} onClose={() => setComparing(false)} refresh={refresh} /> : null}
      {importing ? (
        <ImportModal
          accounts={accounts.data ?? []}
          initial={d}
          onClose={() => setImporting(false)}
          onDone={(id) => {
            setImporting(false);
            navigate('inbox', id);
            void list.reload();
          }}
        />
      ) : null}
      {confirmClose && c ? (
        <Confirm
          title="结束这段对话"
          body="AI 不会再自动回复这段对话。对方如果再发消息，对话会重新变成进行中。"
          confirmLabel="结束"
          onClose={() => setConfirmClose(false)}
          onConfirm={async () => {
            try {
              await api.updateConversation(c.id, { state: 'closed', stateReason: '你手动结束了这段对话' });
              await refresh();
            } catch (err) {
              toast.error(err);
            }
          }}
        />
      ) : null}
    </div>
  );
}
