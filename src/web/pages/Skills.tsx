import { useState, type ReactNode } from 'react';
import type { Persona, PlatformId, Skill } from '../../shared/types.ts';
import { AsyncButton, Check, Confirm, Empty, Field, Loading, Modal, PLATFORM_LABELS, api, useAsync, useToast } from '../ui.tsx';

const PLATFORMS = Object.keys(PLATFORM_LABELS) as PlatformId[];

const CLAMP_2 = { display: '-webkit-box', WebkitBoxOrient: 'vertical' as const, WebkitLineClamp: 2, overflow: 'hidden' };

export function SkillsPage() {
  const [tab, setTab] = useState<'skills' | 'personas'>('skills');
  const tabs = (
    <div className="row-tight">
      <button className={tab === 'skills' ? 'primary' : ''} onClick={() => setTab('skills')}>
        技能
      </button>
      <button className={tab === 'personas' ? 'primary' : ''} onClick={() => setTab('personas')}>
        人设
      </button>
    </div>
  );
  return tab === 'skills' ? <SkillsTab tabs={tabs} /> : <PersonasTab tabs={tabs} />;
}

// ---------------------------------------------------------------- skills

function SkillsTab({ tabs }: { tabs: ReactNode }) {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => api.skills(), []);
  const [editing, setEditing] = useState<Skill | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<Skill | null>(null);

  const toggle = async (skill: Skill, enabled: boolean) => {
    try {
      await api.updateSkill(skill.id, { enabled });
      await reload();
    } catch (err) {
      toast.error(err);
    }
  };

  const remove = async (skill: Skill) => {
    try {
      await api.deleteSkill(skill.id);
      await reload();
      toast.ok(`已删除「${skill.name}」`);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <>
      <div className="topbar">
        <h1>技能与人设</h1>
        {tabs}
        <div className="spacer" />
        <button onClick={() => setImporting(true)}>导入 Markdown</button>
        <button className="primary" onClick={() => setEditing('new')}>
          新建技能
        </button>
      </div>
      <div className="page">
        <div className="stack page-narrow">
          <div className="notice info">技能是拼进提示词里的行为准则，比如怎么开场、怎么处理砍价。一条技能只有被任务挂上、并且当前平台在它的限定范围内，才会生效。</div>

          {loading && !data ? <Loading /> : null}
          {error ? <div className="notice danger">{error}</div> : null}
          {data && data.length === 0 ? <Empty>还没有技能。可以新建一条，或者把手头的技能 Markdown 导进来。</Empty> : null}

          {data && data.length > 0 ? (
            <div className="card table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>slug</th>
                    <th>说明</th>
                    <th>限定平台</th>
                    <th style={{ width: 64 }}>启用</th>
                    <th style={{ width: 64 }}>来源</th>
                    <th style={{ width: 170 }} />
                  </tr>
                </thead>
                <tbody>
                  {data.map((skill) => (
                    <tr key={skill.id}>
                      <td style={{ fontWeight: 550 }}>{skill.name}</td>
                      <td className="mono">{skill.slug}</td>
                      <td className="muted small" style={{ maxWidth: 260 }}>
                        {skill.description || <span className="faint">—</span>}
                      </td>
                      <td>
                        {skill.allowedPlatforms.length === 0 ? (
                          <span className="faint small">全部</span>
                        ) : (
                          <div className="row-tight" style={{ flexWrap: 'wrap' }}>
                            {skill.allowedPlatforms.map((p) => (
                              <span key={p} className="badge">
                                {PLATFORM_LABELS[p]}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>
                        <input type="checkbox" checked={skill.enabled} onChange={(e) => void toggle(skill, e.target.checked)} aria-label={`启用 ${skill.name}`} />
                      </td>
                      <td>{skill.builtin ? <span className="badge info">内置</span> : <span className="faint small">自建</span>}</td>
                      <td>
                        <div className="row-tight">
                          <button className="sm" onClick={() => setEditing(skill)}>
                            编辑
                          </button>
                          <a className="btn sm" href={api.exportSkillUrl(skill.id)}>
                            导出
                          </a>
                          <button className="sm danger" onClick={() => setRemoving(skill)}>
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>

      {editing ? <SkillEditor skill={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={reload} /> : null}
      {importing ? <SkillImporter onClose={() => setImporting(false)} onSaved={reload} /> : null}
      {removing ? (
        <Confirm
          danger
          title="删除技能"
          body={`「${removing.name}」会被删掉，正在引用它的任务会少一条准则。这一步没法撤销。`}
          confirmLabel="删除"
          onConfirm={() => void remove(removing)}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </>
  );
}

interface SkillDraft {
  slug: string;
  name: string;
  description: string;
  content: string;
  allowedPlatforms: PlatformId[];
}

function SkillEditor({ skill, onClose, onSaved }: { skill: Skill | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [form, setForm] = useState<SkillDraft>(() => ({
    slug: skill?.slug ?? '',
    name: skill?.name ?? '',
    description: skill?.description ?? '',
    content: skill?.content ?? '',
    allowedPlatforms: skill?.allowedPlatforms ?? [],
  }));
  const set = <K extends keyof SkillDraft>(key: K, value: SkillDraft[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    const body = { ...form, slug: form.slug.trim(), name: form.name.trim() };
    if (skill) await api.updateSkill(skill.id, body);
    else await api.createSkill({ ...body, enabled: true });
    await onSaved();
    toast.ok(skill ? '技能已保存' : '技能已创建');
    onClose();
  };

  return (
    <Modal
      wide
      title={skill ? `编辑：${skill.name}` : '新建技能'}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <AsyncButton className="primary" disabled={form.name.trim() === '' || form.slug.trim() === ''} onClick={save}>
            保存
          </AsyncButton>
        </>
      }
    >
      <div className="field-row">
        <Field label="名称" hint="列表和任务里显示的名字，写得一眼能认出来。">
          <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="比如：价格异议处理" />
        </Field>
        <Field label="slug" hint={skill ? '任务和导出的文件都按 slug 认这条技能，改完得把引用它的地方一起看一遍。' : '小写字母、数字和连字符，建好之后尽量别再改。'}>
          <input className="mono" value={form.slug} onChange={(e) => set('slug', e.target.value)} placeholder="price-objection" />
        </Field>
      </div>

      <Field label="说明" hint="给自己看的一句话，方便以后在一堆技能里挑出这条。不会进提示词。">
        <input value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="对方嫌贵时怎么接" />
      </Field>

      <Field label="限定平台" hint="一个都不选就是所有平台都能用。选了之后，只有这些平台的账号会加载它——语气差别大的场子适合分开写。">
        <div className="field-row">
          {PLATFORMS.map((p) => (
            <Check
              key={p}
              label={PLATFORM_LABELS[p]}
              checked={form.allowedPlatforms.includes(p)}
              onChange={(on) => set('allowedPlatforms', on ? [...form.allowedPlatforms, p] : form.allowedPlatforms.filter((x) => x !== p))}
            />
          ))}
        </div>
      </Field>

      <Field label="内容" hint="这段会原样拼进提示词。写成给人看的行为准则——什么时候说什么、哪些话不能说、举两个例句，别写成代码或配置。">
        <textarea style={{ minHeight: 320 }} value={form.content} onChange={(e) => set('content', e.target.value)} placeholder={'对方问价格时：\n- 先确认他关心的是预算还是值不值\n- 只报任务素材里写过的价格，没写的就说要确认'} />
      </Field>
    </Modal>
  );
}

function SkillImporter({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [markdown, setMarkdown] = useState('');

  const run = async () => {
    const skill = await api.importSkill(markdown);
    await onSaved();
    toast.ok(`已导入「${skill.name}」`);
    onClose();
  };

  return (
    <Modal
      wide
      title="导入技能 Markdown"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <AsyncButton className="primary" disabled={markdown.trim() === ''} onClick={run}>
            导入
          </AsyncButton>
        </>
      }
    >
      <Field label="Markdown" hint="把一整份技能文件贴进来，名称、slug 和正文由服务端从里面读。解析不了会直接报错，现有技能不受影响。">
        <textarea className="mono" style={{ minHeight: 320 }} value={markdown} onChange={(e) => setMarkdown(e.target.value)} placeholder="粘贴技能文件的全部内容" />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- personas

function PersonasTab({ tabs }: { tabs: ReactNode }) {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => api.personas(), []);
  const [editing, setEditing] = useState<Persona | 'new' | null>(null);
  const [removing, setRemoving] = useState<Persona | null>(null);

  const remove = async (persona: Persona) => {
    try {
      await api.deletePersona(persona.id);
      await reload();
      toast.ok(`已删除「${persona.name}」`);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <>
      <div className="topbar">
        <h1>技能与人设</h1>
        {tabs}
        <div className="spacer" />
        <button className="primary" onClick={() => setEditing('new')}>
          新建人设
        </button>
      </div>
      <div className="page">
        <div className="stack page-narrow">
          <div className="notice info">人设决定 AI 用谁的身份、什么语气说话。账号挂上人设之后，自动回复发出的第一条消息会先亮明 AI 身份。</div>

          {loading && !data ? <Loading /> : null}
          {error ? <div className="notice danger">{error}</div> : null}
          {data && data.length === 0 ? <Empty>还没有人设。至少留一个，不然自动回复只能用系统默认的口吻。</Empty> : null}

          {data?.map((persona) => (
            <div className="card card-pad stack" key={persona.id}>
              <div className="row">
                <h2 className="grow">{persona.name}</h2>
                <button className="sm" onClick={() => setEditing(persona)}>
                  编辑
                </button>
                <button className="sm danger" onClick={() => setRemoving(persona)}>
                  删除
                </button>
              </div>
              <div className="small muted pre-wrap" style={CLAMP_2}>
                {persona.identity || '没写身份设定'}
              </div>
              <div className="field">
                <label>身份说明</label>
                <div className="small pre-wrap">{persona.disclosure || <span className="faint">没写，自动回复会用系统默认的那句。</span>}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {editing ? <PersonaEditor persona={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={reload} /> : null}
      {removing ? (
        <Confirm
          danger
          title="删除人设"
          body={`「${removing.name}」会被删掉，还挂着它的账号会退回系统默认口吻。这一步没法撤销。`}
          confirmLabel="删除"
          onConfirm={() => void remove(removing)}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </>
  );
}

interface PersonaDraft {
  name: string;
  identity: string;
  style: string;
  disclosure: string;
  commentSignature: string;
}

function PersonaEditor({ persona, onClose, onSaved }: { persona: Persona | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [form, setForm] = useState<PersonaDraft>(() => ({
    name: persona?.name ?? '',
    identity: persona?.identity ?? '',
    style: persona?.style ?? '',
    disclosure: persona?.disclosure ?? '',
    commentSignature: persona?.commentSignature ?? '',
  }));
  const set = <K extends keyof PersonaDraft>(key: K, value: PersonaDraft[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    const body = { ...form, name: form.name.trim() };
    if (persona) await api.updatePersona(persona.id, body);
    else await api.createPersona(body);
    await onSaved();
    toast.ok(persona ? '人设已保存' : '人设已创建');
    onClose();
  };

  return (
    <Modal
      wide
      title={persona ? `编辑：${persona.name}` : '新建人设'}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <AsyncButton className="primary" disabled={form.name.trim() === ''} onClick={save}>
            保存
          </AsyncButton>
        </>
      }
    >
      <Field label="名称" hint="给账号挑人设时看的名字。">
        <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="比如：小柯 · 技术向客服" />
      </Field>

      <Field label="身份" hint="AI 扮演谁、替哪家公司说话、能代表到什么程度。写清楚它不该冒充真人员工。">
        <textarea value={form.identity} onChange={(e) => set('identity', e.target.value)} placeholder="我是某某团队的 AI 助手，负责回答产品和订阅相关的问题。" />
      </Field>

      <Field label="说话风格" hint="句子长短、称呼、能不能用表情和网络梗。越具体，生成出来的语气越稳。">
        <textarea value={form.style} onChange={(e) => set('style', e.target.value)} placeholder="短句，口语，别用敬语堆砌；一次只问一个问题；不用感叹号刷热情。" />
      </Field>

      <Field label="身份说明（disclosure）" hint="自动回复模式下，每段对话的第一条消息会先发这句。它必须说明这是 AI，否则系统会用默认的那句替换掉。">
        <textarea value={form.disclosure} onChange={(e) => set('disclosure', e.target.value)} placeholder="先说一句：这边是 AI 助手在回你，需要真人随时说一声。" />
      </Field>

      <Field label="评论签名（commentSignature）" hint="自动发出的公开评论会在末尾附上这句，让围观的人也看得出是 AI 在回。留空就只用上面那句身份说明。">
        <input value={form.commentSignature} onChange={(e) => set('commentSignature', e.target.value)} placeholder="（AI 助手回复）" />
      </Field>
    </Modal>
  );
}
