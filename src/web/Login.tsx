import { useState } from 'react';
import { api, Field, useToast } from './ui.tsx';

export function Login({ setupRequired, onDone }: { setupRequired: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (setupRequired && password !== confirm) return toast.error(new Error('两次输入的密码不一样'));
    setBusy(true);
    try {
      await (setupRequired ? api.setup(password) : api.login(password));
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-page login-page">
      <form className="card card-pad center-card stack login-card" onSubmit={submit}>
        <div>
          <div className="login-brand">llmsocial</div>
          <h1>{setupRequired ? '建立你的社媒工作台' : '回到你的工作台'}</h1>
          <p className="muted small">{setupRequired ? '第一次使用，给本机的管理界面设一个密码。' : '请输入管理密码。'}</p>
        </div>
        <Field label="密码" hint={setupRequired ? '至少 10 个字符，用于保护本机的账号与聊天记录。' : undefined}>
          <input type="password" autoFocus required minLength={setupRequired ? 10 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setupRequired ? 'new-password' : 'current-password'} />
        </Field>
        {setupRequired ? (
          <Field label="再输一次">
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </Field>
        ) : null}
        <button className="primary" type="submit" disabled={busy || password.length === 0}>
          {busy ? '…' : setupRequired ? '设置密码并进入' : '进入'}
        </button>
      </form>
    </div>
  );
}
