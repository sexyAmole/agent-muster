import { useEffect, useRef, useState } from 'react';
import { AppIcon } from './app-icon';
import { Select } from './select';
import { Tabs } from './tabs';
import { useErrorMessage } from './message';

type Application = { id: string; clientId: string; name: string | null; icon: string | null; project: string | null; agent: string | null; connectionStatus?: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' };
type Agent = { id: string; name: string; installed: boolean };
type Registration = { id: string; userCode?: string; verificationUrl: string; qrCode: string; expiresAt: number; interval: number };
type PollResult = { status: 'WAITING' | 'SUCCESS' | 'FAIL' | 'EXPIRED'; reason?: string };
type Props = { projects: string[]; agents: Agent[]; projectLabel: (path: string) => string };

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result as T;
}

export function ImPrototype(props: Props) {
  const [provider, setProvider] = useState<'dingtalk' | 'feishu'>('dingtalk');
  return <div className="im-prototype"><Tabs value={provider} onChange={setProvider} aria-label="IM 平台" items={[{ value: 'dingtalk', label: '钉钉' }, { value: 'feishu', label: '飞书' }]}>
    <ImIntegration key={provider} {...props} provider={provider} />
  </Tabs></div>;
}

function ImIntegration({ projects, agents, projectLabel, provider }: Props & { provider: 'dingtalk' | 'feishu' }) {
  const platform = provider === 'feishu' ? '飞书' : '钉钉';
  const [apps, setApps] = useState<Application[]>([]);
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  useErrorMessage(error, setError);
  const registrationAttempt = useRef(0);
  const [scanError, setScanError] = useState('');

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void request<Application[]>(`/api/${provider}/apps`).then(result => { if (active) setApps(result); })
        .catch(reason => { if (active) setError((reason as Error).message); });
    };
    refresh();
    const timer = provider === 'feishu' ? window.setInterval(refresh, 5000) : undefined;
    return () => { active = false; window.clearInterval(timer); };
  }, [projects, provider]);

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
    if (provider !== 'feishu' || !registration) return;
    return () => { void fetch(`/api/feishu/registration/${registration.id}`, { method: 'DELETE' }); };
  }, [provider, registration]);

  function closeRegistration() { registrationAttempt.current++; setOpen(false); setRegistration(null); }

  async function startRegistration() {
    setOpen(true); setBusy(true); setScanError(''); setRegistration(null);
    const attempt = ++registrationAttempt.current;
    try {
      const result = await request<Registration>(`/api/${provider}/registration`, { method: 'POST' });
      if (attempt === registrationAttempt.current) setRegistration(result);
      else if (provider === 'feishu') await fetch(`/api/feishu/registration/${result.id}`, { method: 'DELETE' });
    } catch (reason) { if (attempt === registrationAttempt.current) setScanError((reason as Error).message); }
    finally { if (attempt === registrationAttempt.current) setBusy(false); }
  }

  async function bind(id: string, binding: { project?: string | null; agent?: string | null }) {
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
      {apps.length ? apps.map(app => <div className="im-robot-entry" key={app.id}>
        <div className="im-robot-row"><div className="im-robot-mark"><AppIcon src={app.icon} platform={platform} /></div><div className="im-app-info"><strong>{app.name || app.clientId}</strong>{app.connectionStatus && <small className="im-connection-status">{{ idle: '未连接', connecting: '连接中', connected: '消息监听已连接', reconnecting: '重新连接中', failed: '消息监听连接失败' }[app.connectionStatus]}</small>}</div>
          <label className="im-binding">项目<Select aria-label={`绑定 ${app.name || app.clientId} 的项目`} value={app.project || ''} onChange={value => void bind(app.id, { project: value || null })}><option value="">未绑定</option>{projects.map(path => <option key={path} value={path}>{projectLabel(path)}</option>)}</Select></label>
          <label className="im-binding">Agent<Select aria-label={`选择 ${app.name || app.clientId} 的 Agent`} value={app.agent || ''} onChange={value => void bind(app.id, { agent: value || null })}><option value="">未选择</option>{agents.map(agent => <option key={agent.id} value={agent.id} disabled={!agent.installed}>{agent.name}{agent.installed ? '' : '（未安装）'}</option>)}</Select></label>
          <button className="im-sync-button" disabled={syncingId !== null} aria-label={`同步 ${app.name || app.clientId} 的名称和图标`} onClick={() => void syncApp(app.id)}>{syncingId === app.id ? '同步中…' : '一键同步'}</button>
          <button className="im-delete-button" disabled={deletingId !== null} aria-label={`删除 ${app.name || app.clientId} 的 IM 接入`} onClick={() => void deleteApp(app)}>{deletingId === app.id ? '删除中…' : '删除'}</button>
        </div>
      </div>) : <div className="im-empty">暂无{platform}应用</div>}
    </div>
    {open && <div className="im-scan-layer" role="presentation"><button className="im-scan-backdrop" aria-label="关闭扫码窗口" onClick={closeRegistration} /><section className="im-scan-dialog" role="dialog" aria-modal="true" aria-labelledby="im-scan-title"><button className="im-scan-close" aria-label="关闭" onClick={closeRegistration}>×</button><h2 id="im-scan-title">使用{platform}扫码创建应用</h2>
      {busy && <p className="im-scan-message">正在获取授权二维码…</p>}
      {registration && <><img className="im-qr-image" src={registration.qrCode} alt={`${platform}应用授权二维码`} />{registration.userCode && <p className="im-user-code">授权码 <strong>{registration.userCode}</strong></p>}<p>请使用{platform}扫描二维码并完成授权</p><a className="im-open-link" href={registration.verificationUrl} target="_blank" rel="noopener noreferrer">在浏览器中打开授权页面</a></>}
      {scanError && <><p className="im-scan-error" role="alert">{scanError}</p><button className="im-primary-button" onClick={() => void startRegistration()}>重新获取二维码</button></>}
    </section></div>}
  </div>;
}
