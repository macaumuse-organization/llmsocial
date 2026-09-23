import { useState } from 'react';
import type { Account, SignalListItem, SignalStatus } from '../../shared/types.ts';
import { SIGNAL_KIND_LABELS } from '../../shared/types.ts';
import { navigate } from '../route.ts';
import { AsyncButton, Empty, Field, Loading, Modal, PLATFORM_LABELS, api, timeAgo, useAsync, useStream, useToast } from '../ui.tsx';

const FILTERS: { key: SignalStatus | 'all'; label: string }[] = [
  { key: 'new', label: '待处理' },
  { key: 'contacted', label: '已联系' },
  { key: 'ignored', label: '已忽略' },
  { key: 'all', label: '全部' },
];

/**
 * What happens if the operator opens this lead. The platforms decide this, not us, and saying so
 * up front beats letting someone draft a reply the platform will refuse to deliver.
 */
function reach(item: SignalListItem): string {
  if (item.platform === 'youtube') return 'YouTube 没有私信，只能在评论区回。开聊能起草，但发不出去。';
  if (item.connector === 'manual') return '这个平台没有 API：AI 起草，你复制到 App 里发。';
  if (item.platform === 'instagram') return 'Instagram 要求对方 24 小时内先发过消息，否则私信发不出去。';
  if (item.platform === 'wechat') return '微信侧有窗口期：关注只开很短的窗口，48 小时窗口要对方先发消息。';
  return '';
}

export function LeadsPage() {
  const [filter, setFilter] = useState<SignalStatus | 'all'>('new');
  const [accountId, setAccountId] = useState('');
  const [adding, setAdding] = useState(false);
  const toast = useToast();

  const accounts = useAsync(() => api.accounts(), []);
  const signals = useAsync(() => api.signals({ status: filter === 'all' ? undefined : filter, accountId: accountId || undefined }), [filter, accountId]);
  useStream((event) => {
    if (event.type === 'signal') void signals.reload();
  });

  const manual = (accounts.data ?? []).filter((a) => a.connector === 'manual' || a.connector === 'sandbox');

  const open = async (item: SignalListItem) => {
    const detail = await api.openSignal(item.id);
    await signals.reload();
    navigate('inbox', detail.conversation.id);
  };

  const setStatus = async (item: SignalListItem, status: 'new' | 'ignored') => {
    await api.updateSignal(item.id, status);
    await signals.reload();
  };

  return (
    <>
      <div className="topbar">
        <h1>潜在联系人</h1>
        <div className="grow" />
        {manual.length > 0 ? <button onClick={() => setAdding(true)}>+ 手动添加</button> : null}
      </div>

      <div className="stack">
        <div className="notice info">
          这里只收对方先做过的动作：关注、订阅、提到你、打开聊天窗口。系统不会自己去联系任何人——你点「开聊」才建对话，而且开场白永远是待审核草稿，要你过目才发得出去。
        </div>

        <div className="row-tight">
          {FILTERS.map((f) => (
            <button key={f.key} className={filter === f.key ? 'sm primary' : 'sm'} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="">全部账号</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {PLATFORM_LABELS[a.platform]}
              </option>
            ))}
          </select>
        </div>

        {signals.loading ? <Loading /> : null}
        {signals.error ? <div className="notice danger">{signals.error}</div> : null}
        {signals.data && signals.data.length === 0 ? (
          <Empty>这里还没有线索。开了信号收集的账号会自动把关注、订阅这类动作收进来；没有 API 的平台可以手动添加。</Empty>
        ) : null}

        {signals.data && signals.data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>是谁</th>
                <th>做了什么</th>
                <th>账号</th>
                <th>时间</th>
                <th style={{ width: 170 }} />
              </tr>
            </thead>
            <tbody>
              {signals.data.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div>{item.displayName || item.handle || item.platformUserId}</div>
                    {item.text ? <div className="small muted">{item.text.slice(0, 60)}</div> : null}
                    {item.status === 'new' && reach(item) ? <div className="small faint">{reach(item)}</div> : null}
                  </td>
                  <td>{SIGNAL_KIND_LABELS[item.kind]}</td>
                  <td className="muted">
                    {item.accountName} · {PLATFORM_LABELS[item.platform]}
                  </td>
                  <td className="muted">{timeAgo(item.ts)}</td>
                  <td>
                    <div className="row-tight">
                      {item.status === 'contacted' && item.conversationId !== null ? (
                        <button className="sm" onClick={() => navigate('inbox', item.conversationId ?? '')}>
                          看对话
                        </button>
                      ) : (
                        <AsyncButton className="sm primary" onClick={() => open(item)}>
                          开聊
                        </AsyncButton>
                      )}
                      {item.status === 'ignored' ? (
                        <button className="ghost sm" onClick={() => void setStatus(item, 'new').catch(toast.error)}>
                          恢复
                        </button>
                      ) : item.status === 'new' ? (
                        <button className="ghost sm" onClick={() => void setStatus(item, 'ignored').catch(toast.error)}>
                          忽略
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      {adding ? (
        <AddLead
          accounts={manual}
          onClose={() => setAdding(false)}
          onDone={async () => {
            setAdding(false);
            setFilter('new');
            await signals.reload();
          }}
        />
      ) : null}
    </>
  );
}

function AddLead({ accounts, onClose, onDone }: { accounts: Account[]; onClose: () => void; onDone: () => Promise<void> }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [userId, setUserId] = useState('');
  const [name, setName] = useState('');
  const [text, setText] = useState('');

  const submit = async () => {
    if (!accountId || userId.trim() === '') throw new Error('账号和对方标识都要填');
    await api.createSignal({ accountId, platformUserId: userId.trim(), displayName: name.trim(), text: text.trim() });
    await onDone();
  };

  return (
    <Modal
      title="手动添加线索"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <AsyncButton className="primary" onClick={submit}>
            添加
          </AsyncButton>
        </>
      }
    >
      <div className="notice info">给没有 API 的平台用：你在 App 里看到谁关注了你、谁来问过，把他记在这儿，回头一起处理。</div>
      <Field label="哪个账号" hint="只能选人工桥接或沙盒账号。">
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {PLATFORM_LABELS[a.platform]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="对方标识" hint="平台上的号码或用户名，用来和以后的对话对上。">
        <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="例如 xiaohongshu_123" />
      </Field>
      <Field label="对方称呼">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 小王" />
      </Field>
      <Field label="备注" hint="他做了什么、在哪看到的。会作为背景给到 AI。">
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="在露营那条视频下点了关注" />
      </Field>
    </Modal>
  );
}
