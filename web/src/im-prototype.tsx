import { useEffect, useState } from 'react';

type Application = { id: string; clientId: string; name: string | null; icon: string | null; project: string | null; agent: string | null };
type Agent = { id: string; name: string; installed: boolean };
type Registration = { id: string; userCode: string; verificationUrl: string; qrCode: string; expiresAt: number; interval: number };
type PollResult = { status: 'WAITING' | 'SUCCESS' | 'FAIL' | 'EXPIRED'; reason?: string };
type Props = { projects: string[]; agents: Agent[]; projectLabel: (path: string) => string };

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result as T;
}

export function ImPrototype({ projects, agents, projectLabel }: Props) {
  const [apps, setApps] = useState<Application[]>([]);
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [scanError, setScanError] = useState('');

  useEffect(() => {
    request<Application[]>('/api/dingtalk/apps').then(setApps).catch(reason => setError((reason as Error).message));
  }, [projects]);

  useEffect(() => {
    if (!open || !registration) return;
    let active = true;
    let timer: number;
    async function poll() {
      try {
        const result = await request<PollResult>(`/api/dingtalk/registration/${registration!.id}`);
        if (!active) return;
        if (result.status === 'SUCCESS') {
          setApps(await request<Application[]>('/api/dingtalk/apps'));
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
  }, [open, registration]);

  async function startRegistration() {
    setOpen(true); setBusy(true); setScanError(''); setRegistration(null);
    try { setRegistration(await request<Registration>('/api/dingtalk/registration', { method: 'POST' })); }
    catch (reason) { setScanError((reason as Error).message); }
    finally { setBusy(false); }
  }

  async function bind(id: string, binding: { project?: string | null; agent?: string | null }) {
    try {
      const updated = await request<Application>(`/api/dingtalk/apps/${id}`, { method: 'PATCH', body: JSON.stringify(binding) });
      setApps(current => current.map(app => app.id === id ? updated : app));
    } catch (reason) { setError((reason as Error).message); }
  }

  async function deleteApp(app: Application) {
    if (!window.confirm(`删除“${app.name || app.clientId}”的 IM 接入？删除后将停止接收该应用的消息，已有对话记录会保留。钉钉中的应用不会删除。`)) return;
    setError('');
    setDeletingId(app.id);
    try {
      await request<{ id: string }>(`/api/dingtalk/apps/${app.id}`, { method: 'DELETE' });
      setApps(current => current.filter(item => item.id !== app.id));
    } catch (reason) { setError((reason as Error).message); }
    finally { setDeletingId(null); }
  }

  async function syncApp(id: string) {
    setError('');
    setSyncingId(id);
    try {
      const updated = await request<Application>(`/api/dingtalk/apps/${id}/sync`, { method: 'POST' });
      setApps(current => current.map(app => app.id === id ? updated : app));
    } catch (reason) { setError((reason as Error).message); }
    finally { setSyncingId(null); }
  }

  return <div className="im-prototype">
    <div className="im-intro"><h1>钉钉接入</h1><button className="im-primary-button" onClick={() => void startRegistration()}>扫码创建应用</button></div>
    {error && <div className="im-error" role="alert">{error}<button onClick={() => setError('')} aria-label="关闭错误">×</button></div>}
    <div className="im-robot-list">
      {apps.length ? apps.map(app => <div className="im-robot-entry" key={app.id}>
        <div className="im-robot-row"><div className="im-robot-mark">{app.icon ? <img src={app.icon} alt="" /> : '钉'}</div><div className="im-app-info"><strong>{app.name || app.clientId}</strong></div>
          <label className="im-binding">项目<select aria-label={`绑定 ${app.name || app.clientId} 的项目`} value={app.project || ''} onChange={event => void bind(app.id, { project: event.target.value || null })}><option value="">未绑定</option>{projects.map(path => <option key={path} value={path}>{projectLabel(path)}</option>)}</select></label>
          <label className="im-binding">Agent<select aria-label={`选择 ${app.name || app.clientId} 的 Agent`} value={app.agent || ''} onChange={event => void bind(app.id, { agent: event.target.value || null })}><option value="">未选择</option>{agents.map(agent => <option key={agent.id} value={agent.id} disabled={!agent.installed}>{agent.name}{agent.installed ? '' : '（未安装）'}</option>)}</select></label>
          <button className="im-sync-button" disabled={syncingId !== null} aria-label={`同步 ${app.name || app.clientId} 的名称和图标`} onClick={() => void syncApp(app.id)}>{syncingId === app.id ? '同步中…' : '一键同步'}</button>
          <button className="im-delete-button" disabled={deletingId !== null} aria-label={`删除 ${app.name || app.clientId} 的 IM 接入`} onClick={() => void deleteApp(app)}>{deletingId === app.id ? '删除中…' : '删除'}</button>
        </div>
      </div>) : <div className="im-empty">暂无钉钉应用</div>}
    </div>
    {open && <div className="im-scan-layer" role="presentation"><button className="im-scan-backdrop" aria-label="关闭扫码窗口" onClick={() => setOpen(false)} /><section className="im-scan-dialog" role="dialog" aria-modal="true" aria-labelledby="im-scan-title"><button className="im-scan-close" aria-label="关闭" onClick={() => setOpen(false)}>×</button><h2 id="im-scan-title">使用钉钉扫码创建应用</h2>
      {busy && <p className="im-scan-message">正在获取授权二维码…</p>}
      {registration && <><img className="im-qr-image" src={registration.qrCode} alt="钉钉应用授权二维码" /><p className="im-user-code">授权码 <strong>{registration.userCode}</strong></p><p>请使用钉钉扫描二维码并完成授权</p><a className="im-open-link" href={registration.verificationUrl} target="_blank" rel="noopener noreferrer">在浏览器中打开授权页面</a></>}
      {scanError && <><p className="im-scan-error" role="alert">{scanError}</p><button className="im-primary-button" onClick={() => void startRegistration()}>重新获取二维码</button></>}
    </section></div>}
  </div>;
}
