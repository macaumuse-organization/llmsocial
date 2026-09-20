import { Children, cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PlatformId, StreamEvent } from '../shared/types.ts';
import { ApiError, api } from './api.ts';

// ---------------------------------------------------------------- toasts

interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'error' | 'info';
}
interface ToastApi {
  ok(text: string): void;
  error(err: unknown): void;
  info(text: string): void;
}

const ToastContext = createContext<ToastApi>({ ok() {}, error() {}, info() {} });
export const useToast = () => useContext(ToastContext);

let toastSeq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind']) => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 3500);
  }, []);
  const value = useMemo<ToastApi>(
    () => ({
      ok: (text) => push(text, 'ok'),
      info: (text) => push(text, 'info'),
      error: (err) => push(err instanceof ApiError || err instanceof Error ? err.message : String(err), 'error'),
    }),
    [push],
  );
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------- data loading

/** Loads once and on demand. `reload` returns a promise so callers can await a refresh. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): { data: T | null; error: string; loading: boolean; reload: () => Promise<void> } {
  const source = useMemo(() => ({}), deps);
  const [state, setState] = useState<{ source: object; data: T | null; error: string; loading: boolean }>({ source, data: null, error: '', loading: true });
  const latest = useRef(0);
  const run = useCallback(async () => {
    const ticket = ++latest.current;
    setState((prev) => ({ source, data: prev.source === source ? prev.data : null, error: '', loading: true }));
    try {
      const value = await loader();
      if (latest.current === ticket) {
        setState({ source, data: value, error: '', loading: false });
      }
    } catch (err) {
      if (latest.current === ticket) setState((prev) => ({ ...prev, error: err instanceof Error ? err.message : String(err), loading: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void run();
    return () => { latest.current++; };
  }, [run]);
  return { data: state.source === source ? state.data : null, error: state.source === source ? state.error : '', loading: state.source !== source || state.loading, reload: run };
}

/** Server-sent events from the local server. Reconnects on its own. */
export function useStream(onEvent: (event: StreamEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    const source = new EventSource('/api/stream');
    source.onmessage = (e) => {
      try {
        handler.current(JSON.parse(e.data) as StreamEvent);
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    };
    return () => source.close();
  }, []);
}

export function useTheme(): [string, (next: string) => void] {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('llmsocial.theme') ?? 'system'; } catch { return 'system'; }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('llmsocial.theme', theme);
    } catch {
      // Private window: the choice simply won't persist.
    }
  }, [theme]);
  return [theme, setTheme];
}

// ---------------------------------------------------------------- primitives

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  const controls = Children.map(children, (child) => {
    if (!isValidElement<{ id?: string; 'aria-describedby'?: string }>(child) || !['input', 'textarea', 'select'].includes(String(child.type))) return child;
    return cloneElement(child, { id, 'aria-describedby': hint ? `${id}-hint` : undefined });
  });
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {controls}
      {hint ? <div id={`${id}-hint`} className="hint">{hint}</div> : null}
    </div>
  );
}

export function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint ? <div className="hint">{hint}</div> : null}
      </span>
    </label>
  );
}

export function Modal({ title, children, onClose, footer, wide }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean }) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () => [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') ?? [])].filter((el) => el.getClientRects().length > 0);
    (focusable()[0] ?? dialog.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close.current(); }
      if (e.key === 'Tab') {
        const elements = focusable();
        const first = elements[0];
        const last = elements.at(-1);
        if (!first) { e.preventDefault(); return; }
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} tabIndex={-1} className="modal" style={wide ? { width: 'min(900px, 100%)' } : undefined} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2 className="grow">{title}</h2>
          <button className="ghost" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Confirm({ title, body, confirmLabel, onConfirm, onClose, danger }: { title: string; body: string; confirmLabel: string; onConfirm: () => void; onClose: () => void; danger?: boolean }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <button
            className={danger ? 'danger' : 'primary'}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="pre-wrap">{body}</p>
    </Modal>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading() {
  return <div className="empty">载入中…</div>;
}

/** A button whose async work disables it and surfaces failures as a toast. */
export function AsyncButton({ onClick, children, className, title, disabled }: { onClick: () => Promise<unknown>; children: ReactNode; className?: string; title?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <button
      className={className}
      title={title}
      disabled={busy || disabled}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } catch (err) {
          toast.error(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? '…' : children}
    </button>
  );
}

// ---------------------------------------------------------------- formatting

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export function clockTime(ts: number | null | undefined): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}

export const PLATFORM_LABELS: Record<PlatformId, string> = {
  wechat: '微信',
  xiaohongshu: '小红书',
  douyin: '抖音',
  x: 'X',
  instagram: 'Instagram',
  youtube: 'YouTube',
  sandbox: '沙盒',
  other: '其它',
};

export const STAGE_LABELS: Record<string, string> = {
  new: '新接触',
  engaged: '聊上了',
  interested: '有兴趣',
  offer_made: '已提议',
  converted: '已达成',
  declined: '已拒绝',
};

export const STATE_LABELS: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  handoff: '待人工',
  opted_out: '已退订',
  closed: '已结束',
};

export const STATUS_LABELS: Record<string, string> = {
  received: '已收到',
  pending_approval: '待审核',
  scheduled: '待发送',
  sending: '发送中',
  sent: '已发送',
  failed: '发送失败',
  rejected: '已否决',
  superseded: '已作废',
  cancelled: '已取消',
};

/** Reads a file as a base64 data URL, for the screenshot importer. */
export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

export { api };
