import { useCallback, useEffect, useState } from 'react';
import type { Settings } from '../shared/types.ts';
import { api, useAsync, useStream, useTheme, useToast, Loading } from './ui.tsx';
import { Login } from './Login.tsx';
import { navigate, useRoute } from './route.ts';
import { InboxPage } from './pages/Inbox.tsx';
import { LeadsPage } from './pages/Leads.tsx';
import { AccountsPage } from './pages/Accounts.tsx';
import { CampaignsPage } from './pages/Campaigns.tsx';
import { SkillsPage } from './pages/Skills.tsx';
import { ModelsPage } from './pages/Models.tsx';
import { SandboxPage } from './pages/Sandbox.tsx';
import { DashboardPage } from './pages/Dashboard.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { Icon, type IconName } from './Icon.tsx';

const NAV: { page: string; label: string; icon: IconName }[] = [
  { page: 'inbox', label: '收件箱', icon: 'inbox' },
  { page: 'dashboard', label: '概况', icon: 'dashboard' },
  { page: 'leads', label: '潜在联系人', icon: 'message' },
  { page: 'accounts', label: '账号', icon: 'accounts' },
  { page: 'campaigns', label: '聊天任务', icon: 'campaigns' },
  { page: 'skills', label: '技能与人设', icon: 'skills' },
  { page: 'models', label: '模型', icon: 'models' },
  { page: 'sandbox', label: '沙盒演练', icon: 'sandbox' },
  { page: 'settings', label: '设置', icon: 'settings' },
];

function Shell() {
  const route = useRoute();
  const [theme, setTheme] = useTheme();
  const toast = useToast();
  const [needsAction, setNeedsAction] = useState(0);
  const [newLeads, setNewLeads] = useState(0);
  const settings = useAsync<Settings>(() => api.settings(), []);

  const refreshBadge = useCallback(async () => {
    try {
      setNeedsAction((await api.conversations({ needsAction: true, state: undefined })).length);
      setNewLeads((await api.signals({ status: 'new' })).length);
    } catch {
      // The badge is decoration; a failure here should not interrupt anything.
    }
  }, []);

  useEffect(() => {
    void refreshBadge();
  }, [refreshBadge, route.page]);

  useStream((event) => {
    if (event.type === 'conversation' || event.type === 'account' || event.type === 'signal') void refreshBadge();
    if (event.type === 'settings') void settings.reload();
  });

  const paused = settings.data?.autopilotPaused ?? false;

  const togglePause = async () => {
    try {
      await api.saveSettings({ autopilotPaused: !paused });
      await settings.reload();
      toast.ok(paused ? '已恢复自动发送' : '已暂停全部自动发送');
    } catch (err) {
      toast.error(err);
    }
  };

  const Page =
    { inbox: InboxPage, leads: LeadsPage, dashboard: DashboardPage, accounts: AccountsPage, campaigns: CampaignsPage, skills: SkillsPage, models: ModelsPage, sandbox: SandboxPage, settings: SettingsPage }[route.page] ?? InboxPage;

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="主导航">
        <div className="brand">
          <span className="brand-full">llmsocial</span><span className="brand-short" aria-hidden="true">ls</span>
        </div>
        {NAV.map((item) => (
          <button key={item.page} className="navlink" aria-label={item.label} title={item.label} aria-current={route.page === item.page ? 'page' : undefined} onClick={() => navigate(item.page)}>
            <span>
              <Icon name={item.icon} /> <span className="label">{item.label}</span>
            </span>
            {item.page === 'inbox' && needsAction > 0 ? <span className="badge accent">{needsAction}</span> : null}
            {item.page === 'leads' && newLeads > 0 ? <span className="badge">{newLeads}</span> : null}
          </button>
        ))}
        <div className="sidebar-foot">
          <button className="navlink" onClick={togglePause} disabled={!settings.data} aria-label={paused ? '恢复自动发送' : '暂停自动发送'} title={paused ? '恢复自动发送' : '暂停自动发送'}>
            <span>
              <Icon name={paused ? 'pause' : 'play'} /> <span className="label">{paused ? '自动发送已暂停' : '允许自动发送'}</span>
            </span>
          </button>
          <button className="navlink" aria-label="切换主题" title="切换主题" onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')}>
            <span>
              <Icon name="theme" /> <span className="label">{theme === 'dark' ? '深色' : theme === 'light' ? '浅色' : '跟随系统'}</span>
            </span>
          </button>
          <button
            className="navlink"
            aria-label="退出登录"
            title="退出登录"
            onClick={async () => {
              try { await api.logout(); window.location.reload(); } catch (err) { toast.error(err); }
            }}
          >
            <span>
              <Icon name="logout" /> <span className="label">退出登录</span>
            </span>
          </button>
        </div>
      </nav>
      <main className="main">
        {paused ? <div className="notice warn" style={{ borderRadius: 0, borderBottom: '1px solid var(--border)' }}>全局自动发送已暂停：AI 会继续起草，但所有消息都要你手动确认才会发出。</div> : null}
        <Page />
      </main>
    </div>
  );
}

export function App() {
  const auth = useAsync(() => api.authState(), []);
  if (auth.loading) return <Loading />;
  if (auth.error) return <div className="center-page"><div className="notice danger">{auth.error}</div></div>;
  if (!auth.data?.authenticated) return <Login setupRequired={auth.data?.setupRequired ?? false} onDone={() => window.location.reload()} />;
  return <Shell />;
}
