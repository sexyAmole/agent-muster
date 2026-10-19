import { apiUrl } from './api-url';
import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { AppIcon } from './app-icon';
import { Select } from './select';
import { Tabs } from './tabs';
import { useErrorMessage } from './message';
import type { AgentInfo, AgentSession } from '../../src/types';

export type Application = { id: string; clientId: string; name: string | null; icon: string | null; project: string | null; agent: string | null; permissionMode?: string; connectionStatus?: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' };
type SessionSummary = Omit<AgentSession, 'events'>;
type Agent = Pick<AgentInfo, 'id' | 'name' | 'installed' | 'permissionModes'>;
type Registration = { id: string; userCode?: string; verificationUrl: string; qrCode: string; expiresAt: number; interval: number };
type PollResult = { status: 'WAITING' | 'SUCCESS' | 'FAIL' | 'EXPIRED'; reason?: string };
type Props = { active: boolean; sessions: SessionSummary[]; onOpenSession: (session: SessionSummary) => void; feishuApps: Application[]; onFeishuAppsChange: Dispatch<SetStateAction<Application[]>>; projects: string[]; agents: Agent[]; projectLabel: (path: string) => string };

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result as T;
}

export function ImPrototype(props: Props) {
  const [provider, setProvider] = useState<'dingtalk' | 'feishu' | 'wecom'>('dingtalk');
  return <div className="im-prototype"><Tabs value={provider} onChange={setProvider} aria-label="IM 平台" items={[{ value: 'dingtalk', label: '钉钉' }, { value: 'feishu', label: '飞书' }, { value: 'wecom', label: '企业微信' }]}>
    <ImIntegration key={provider} {...props} provider={provider} />
  </Tabs></div>;
}

function ImActionMenu({ label, appName, children }: { label: string; appName: string; children: ReactNode }) {
  return <details className="im-action-menu" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
    <summary aria-label={`${appName} ${label}`}>{label}<span className="im-action-chevron" aria-hidden="true" /></summary>
    <div className="im-action-popover">{children}</div>
  </details>;
}

function ImIntegration({ active, sessions, onOpenSession, feishuApps, onFeishuAppsChange, projects, agents, projectLabel, provider }: Props & { provider: 'dingtalk' | 'feishu' | 'wecom' }) {
  const platform = provider === 'feishu' ? '飞书' : provider === 'wecom' ? '企业微信' : '钉钉';
  const [localApps, setLocalApps] = useState<Application[]>([]);
  const apps = provider === 'feishu' ? feishuApps : localApps;
  const setApps = provider === 'feishu' ? onFeishuAppsChange : setLocalApps;
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  useErrorMessage(error, setError);
  const registrationAttempt = useRef(0);
  const [scanError, setScanError] = useState('');
  const scanDialog = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    scanDialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { previousFocus?.focus(); };
  }, [open]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: number | undefined;
    let pending = false;
    async function refresh() {
      if (pending || controller.signal.aborted || document.hidden) return;
      pending = true;
      try {
        const result = await request<Application[]>(`/api/${provider}/apps`, { signal: controller.signal });
        if (!controller.signal.aborted) setApps(current => JSON.stringify(current) === JSON.stringify(result) ? current : result);
      } catch (reason) {
        if (!controller.signal.aborted) setError((reason as Error).message);
      } finally {
        pending = false;
        if (provider !== 'dingtalk' && !controller.signal.aborted && !document.hidden) timer = window.setTimeout(refresh, 5000);
      }
    }
    function visibilityChanged() {
      window.clearTimeout(timer);
      if (!document.hidden) void refresh();
    }
    void refresh();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [active, projects, provider, setApps]);

  useEffect(() => () => { registrationAttempt.current++; }, []);

  useEffect(() => {
    if (!open || !registration) return;
    let active = true;
    let timer: number;
    async function poll() {
      try {
        const result = await request<PollResult>(`/api/${provider}/registration/${registration!.id}`);
        if (!active) return;
        if (result.status === 'SUCCESS') {
          setApps(await request<Application[]>(`/api/${provider}/apps`));
          setOpen(false);
          setRegistration(null);
        } else if (result.status === 'WAITING') {
          timer = window.setTimeout(poll, registration!.interval * 1000);
        } else {
          setScanError(result.status === 'EXPIRED' ? '二维码已过期，请重新发起扫码。' : result.reason || '授权失败，请重试。');
          setRegistration(null);
        }
      } catch (reason) {
        if (active) { setScanError((reason as Error).message); setRegistration(null); }
      }
    }
    timer = window.setTimeout(poll, registration.interval * 1000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [open, registration, provider]);

  useEffect(() => {
    if (provider === 'dingtalk' || !registration) return;
    return () => { void fetch(apiUrl(`/api/${provider}/registration/${registration.id}`), { method: 'DELETE' }); };
  }, [provider, registration]);

  function closeRegistration() { registrationAttempt.current++; setOpen(false); setRegistration(null); }

  async function startRegistration() {
    setOpen(true); setBusy(true); setScanError(''); setRegistration(null);
    const attempt = ++registrationAttempt.current;
    try {
      const result = await request<Registration>(`/api/${provider}/registration`, { method: 'POST' });
      if (attempt === registrationAttempt.current) setRegistration(result);
      else if (provider !== 'dingtalk') await fetch(apiUrl(`/api/${provider}/registration/${result.id}`), { method: 'DELETE' });
    } catch (reason) { if (attempt === registrationAttempt.current) setScanError((reason as Error).message); }
    finally { if (attempt === registrationAttempt.current) setBusy(false); }
  }

  async function bind(id: string, binding: { project?: string | null; agent?: string | null; permissionMode?: string }) {
    try {
      const updated = await request<Application>(`/api/${provider}/apps/${id}`, { method: 'PATCH', body: JSON.stringify(binding) });
      setApps(current => current.map(app => app.id === id ? updated : app));
    } catch (reason) { setError((reason as Error).message); }
  }

  async function deleteApp(app: Application) {
    if (!window.confirm(`删除“${app.name || app.clientId}”的 IM 接入？删除后将停止接收该应用的消息，已有对话记录会保留。${platform}中的应用不会删除。`)) return;
    setError('');
    setDeletingId(app.id);
    try {
      await request<{ id: string }>(`/api/${provider}/apps/${app.id}`, { method: 'DELETE' });
      setApps(current => current.filter(item => item.id !== app.id));
    } catch (reason) { setError((reason as Error).message); }
    finally { setDeletingId(null); }
  }

  async function syncApp(id: string) {
    setError('');
    setSyncingId(id);
    try {
      const updated = await request<Application>(`/api/${provider}/apps/${id}/sync`, { method: 'POST' });
      setApps(current => current.map(app => app.id === id ? updated : app));
    } catch (reason) { setError((reason as Error).message); }
    finally { setSyncingId(null); }
  }

  return <div>
    <div className="im-intro"><h1>{platform}接入</h1><button className="im-primary-button" onClick={() => void startRegistration()}>扫码创建应用</button></div>
    <div className="im-robot-list">
      {apps.length ? apps.map(app => {
        const agentInfo = agents.find(agent => agent.id === app.agent);
        const conversations = sessions.filter(session => session.im?.some(binding => binding.platform === provider && binding.appId === app.id))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return <div className="im-robot-entry" key={app.id}>
        <div className="im-robot-row"><div className="im-robot-mark"><AppIcon src={app.icon} platform={platform} /></div><div className="im-app-info"><strong>{app.name || app.clientId}</strong>{app.connectionStatus && <small className="im-connection-status">{{ idle: '未连接', connecting: '连接中', connected: '消息监听已连接', reconnecting: '重新连接中', failed: '消息监听连接失败' }[app.connectionStatus]}</small>}</div>
          <div className="im-row-actions">
            <ImActionMenu label="Agent 操作" appName={app.name || app.clientId}>
              <label className="im-binding">项目<Select aria-label={`绑定 ${app.name || app.clientId} 的项目`} value={app.project || ''} onChange={value => void bind(app.id, { project: value || null })}><option value="">未绑定</option>{projects.map(path => <option key={path} value={path}>{projectLabel(path)}</option>)}</Select></label>
              <label className="im-binding">Agent<Select aria-label={`选择 ${app.name || app.clientId} 的 Agent`} value={app.agent || ''} onChange={value => void bind(app.id, { agent: value || null })}><option value="">未选择</option>{agents.map(agent => <option key={agent.id} value={agent.id} disabled={!agent.installed}>{agent.name}{agent.installed ? '' : '（未安装）'}</option>)}</Select></label>
              <label className="im-binding">权限<Select aria-label={`设置 ${app.name || app.clientId} 的权限模式`} value={app.permissionMode || 'full-auto'} disabled={!agentInfo?.installed} title={agentInfo?.permissionModes.find(mode => mode.id === (app.permissionMode || 'full-auto'))?.description} onChange={value => void bind(app.id, { permissionMode: value })}>{agentInfo?.permissionModes.map(mode => <option key={mode.id} value={mode.id}>{mode.name}</option>)}</Select></label>
            </ImActionMenu>
            <ImActionMenu label="应用操作" appName={app.name || app.clientId}>
              {provider !== 'wecom' && <button className="im-sync-button" disabled={syncingId !== null} aria-label={`同步 ${app.name || app.clientId} 的名称和图标`} onClick={() => void syncApp(app.id)}>{syncingId === app.id ? '同步中…' : '一键同步'}</button>}
              <button className="im-delete-button" disabled={deletingId !== null} aria-label={`删除 ${app.name || app.clientId} 的 IM 接入`} onClick={() => void deleteApp(app)}>{deletingId === app.id ? '删除中…' : '删除'}</button>
            </ImActionMenu>
          </div>
        </div>
        <div className="im-conversations">
          <h2>关联对话</h2>
          {conversations.length ? <ul>{conversations.map(session => <li key={session.id}>
            <button className="im-conversation" onClick={() => onOpenSession(session)}>
              <span className="im-conversation-info"><strong title={session.title ?? session.prompt}>{session.title ?? session.prompt}</strong><small title={session.cwd}>{projectLabel(session.cwd)} · {agents.find(agent => agent.id === session.agent)?.name || session.agent}</small></span>
              <time dateTime={new Date(session.updatedAt).toISOString()}>{new Date(session.updatedAt).toLocaleString('zh-CN')}</time>
            </button>
          </li>)}</ul> : <p className="im-conversations-empty">暂无关联对话</p>}
        </div>
      </div>; }) : <div className="im-empty">暂无{platform}应用</div>}
    </div>
    {open && <div className="im-scan-layer" role="presentation"><button className="im-scan-backdrop" aria-label="关闭扫码窗口" onClick={closeRegistration} /><section ref={scanDialog} className="im-scan-dialog" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); closeRegistration(); }
      if (event.key !== 'Tab') return;
      const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]');
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }} role="dialog" aria-modal="true" aria-labelledby="im-scan-title"><button className="im-scan-close" aria-label="关闭" onClick={closeRegistration}>×</button><h2 id="im-scan-title">使用{platform}扫码创建应用</h2>
      {busy && <p className="im-scan-message">正在获取授权二维码…</p>}
      {registration && <><img className="im-qr-image" src={registration.qrCode} alt={`${platform}应用授权二维码`} />{registration.userCode && <p className="im-user-code">授权码 <strong>{registration.userCode}</strong></p>}<p>请使用{platform}扫描二维码并完成授权</p><a className="im-open-link" href={registration.verificationUrl} target="_blank" rel="noopener noreferrer">在浏览器中打开授权页面</a></>}
      {scanError && <><p className="im-scan-error" role="alert">{scanError}</p><button className="im-primary-button" onClick={() => void startRegistration()}>重新获取二维码</button></>}
    </section></div>}
  </div>;
}
