import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AgentInfo, AgentSession } from '../../../../src/types';
import { AppIcon } from '../../shared/components/app-icon';
import { useErrorMessage } from '../../shared/components/message';
import { Select } from '../../shared/components/select';
import { Tabs } from '../../shared/components/tabs';
import { apiUrl } from '../../shared/lib/api-url';

export type Application = { id: string; clientId: string; name: string | null; icon: string | null; project: string | null; agent: string | null; model?: string; permissionMode?: string; createdAt?: number; connectionError?: string; connectionStatus?: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' };
type SessionSummary = Omit<AgentSession, 'events'>;
type Agent = Pick<AgentInfo, 'id' | 'name' | 'installed' | 'permissionModes'>;
type Registration = { id: string; userCode?: string; verificationUrl?: string; qrCode: string; expiresAt: number; interval: number };
type PollResult = { status: 'WAITING' | 'VERIFY' | 'SUCCESS' | 'FAIL' | 'EXPIRED'; reason?: string };
type Props = { active: boolean; sessions: SessionSummary[]; onOpenSession: (session: SessionSummary) => void; feishuApps: Application[]; onFeishuAppsChange: Dispatch<SetStateAction<Application[]>>; projects: string[]; agents: Agent[]; projectLabel: (path: string) => string };

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result as T;
}

export function ImPanel(props: Props) {
  const [provider, setProvider] = useState<'dingtalk' | 'feishu' | 'wecom' | 'weixin'>('dingtalk');
  return <div className="im-prototype"><Tabs value={provider} onChange={setProvider} aria-label="IM 平台" items={[{ value: 'dingtalk', label: '钉钉' }, { value: 'feishu', label: '飞书' }, { value: 'wecom', label: '企业微信' }, { value: 'weixin', label: '微信' }]}>
    <ImIntegration key={provider} {...props} provider={provider} />
  </Tabs></div>;
}

function formatCreatedAt(timestamp?: number): string {
  if (!timestamp) return '未知';
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatConversationTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

type ImRobotEntryProps = {
  app: Application;
  platform: '钉钉' | '飞书' | '企业微信' | '微信';
  provider: 'dingtalk' | 'feishu' | 'wecom' | 'weixin';
  agents: Agent[];
  projects: string[];
  projectLabel: (path: string) => string;
  conversations: SessionSummary[];
  syncing: boolean;
  deleting: boolean;
  onBind: (id: string, binding: { project?: string | null; agent?: string | null; model?: string; permissionMode?: string }) => void;
  onSync: (id: string) => void;
  onReconnect: () => void;
  onDelete: (app: Application) => void;
  onOpenSession: (session: SessionSummary) => void;
};

function ImRobotEntry({ app, platform, provider, agents, projects, projectLabel, conversations, syncing, deleting, onBind, onSync, onReconnect, onDelete, onOpenSession }: ImRobotEntryProps) {
  const agentInfo = agents.find(agent => agent.id === app.agent);
  const selectedPermission = agentInfo?.permissionModes.find(mode => mode.id === (app.permissionMode || 'full-auto'));
  const [modelDetails, setModelDetails] = useState<AgentInfo | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState('');
  useErrorMessage(modelError, setModelError);

  useEffect(() => {
    setModelDetails(null);
    if (!agentInfo?.installed) { setLoadingModels(false); return; }
    const controller = new AbortController();
    setLoadingModels(true);
    request<AgentInfo>(`/api/agents/${agentInfo.id}/models`, { signal: controller.signal })
      .then(details => { if (!controller.signal.aborted) setModelDetails(details); })
      .catch(reason => { if (!controller.signal.aborted) setModelError((reason as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setLoadingModels(false); });
    return () => controller.abort();
  }, [agentInfo?.id, agentInfo?.installed]);

  const models = modelDetails?.id === app.agent ? modelDetails.models : [];


  return <div className="im-robot-entry">
    <div className="im-robot-header">
      <div className="im-robot-meta">
        <span className="im-robot-mark"><AppIcon src={app.icon} platform={platform} className="im-robot-app-icon" fallbackClassName="im-robot-app-icon-fallback" /></span>
        <div className="im-robot-titles">
          <div className="im-robot-title-row">
            <strong>{app.name || app.clientId}</strong>
            <span className={`im-bound-badge${provider === 'weixin' && app.connectionStatus !== 'connected' ? ' im-connection-pending' : ''}`}>{provider === 'weixin' ? ({ idle: '未连接', connecting: '连接中', connected: '已连接', reconnecting: '重连中', failed: '登录已过期' } as const)[app.connectionStatus || 'idle'] : '已关联'}</span>
          </div>
          <small>{platform}应用 · 创建时间 {formatCreatedAt(app.createdAt)}</small>
        </div>
      </div>
      <div className="im-header-actions">
        {provider === 'weixin' && <button className="im-sync-button" onClick={onReconnect}>重新扫码</button>}
        {provider !== 'wecom' && provider !== 'weixin' && <button className="im-sync-button" disabled={syncing} aria-label={`同步 ${app.name || app.clientId} 的名称和图标`} onClick={() => onSync(app.id)}>{syncing ? '同步中…' : '一键同步'}</button>}
        <button className="im-delete-button" disabled={deleting} aria-label={`删除 ${app.name || app.clientId} 的 IM 接入`} onClick={() => onDelete(app)}>{deleting ? '删除中…' : '删除'}</button>
      </div>
    </div>
    {provider === 'weixin' && app.connectionError && <p className="im-connection-error" role="status">{app.connectionError}</p>}
    <div className="im-conversations">
      <div className="im-conversations-header">
        <h2>关联配置</h2>
      </div>
      <div className="im-binding-row">
        <label className="im-binding-cell">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2Z" /></svg>
          <Select aria-label={`绑定 ${app.name || app.clientId} 的项目`} value={app.project || ''} onChange={value => onBind(app.id, { project: value || null })} variant="ghost" triggerLabel={app.project ? projectLabel(app.project) : '选择项目'}>
            <option value="">选择项目</option>
            {projects.map(path => <option key={path} value={path}>{projectLabel(path)}</option>)}
          </Select>
        </label>
        <span className="im-binding-divider" />
        <label className="im-binding-cell">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="6" width="16" height="14" rx="3" /><path d="M12 6V3M8 11h.01M16 11h.01M8 16h8M1 11v4M23 11v4" /></svg>
          <Select aria-label={`选择 ${app.name || app.clientId} 的 Agent`} value={app.agent || ''} onChange={value => onBind(app.id, { agent: value || null })} variant="ghost" triggerLabel={app.agent ? (agents.find(agent => agent.id === app.agent)?.name || app.agent) : '选择 Agent'}>
            <option value="">选择 Agent</option>
            {agents.map(agent => <option key={agent.id} value={agent.id} disabled={!agent.installed}>{agent.name}{agent.installed ? '' : '（未安装）'}</option>)}
          </Select>
        </label>
        <span className="im-binding-divider" />
        <label className="im-binding-cell">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 9h6v6H9zM9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" /></svg>
          <Select aria-label={`选择 ${app.name || app.clientId} 的模型`} value={app.model || ''} disabled={!agentInfo?.installed || loadingModels} title={!agentInfo?.installed ? '请先选择可用的 Agent' : app.model || modelDetails?.defaultModel} onChange={value => onBind(app.id, { model: value })} variant="ghost">
            <option value="">{loadingModels ? '加载模型中…' : modelDetails?.defaultModel ? `默认 · ${modelDetails.defaultModel}` : 'Agent 默认'}</option>
            {app.model && !models.some(model => model.id === app.model) && <option value={app.model}>{app.model}</option>}
            {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
          </Select>
        </label>
        <span className="im-binding-divider" />
        <label className="im-binding-cell">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
          <Select aria-label={`设置 ${app.name || app.clientId} 的权限模式`} value={app.permissionMode || 'full-auto'} disabled={!agentInfo?.installed} title={selectedPermission?.description} onChange={value => onBind(app.id, { permissionMode: value })} variant="ghost" triggerLabel={selectedPermission?.name || '选择权限'}>
            {agentInfo?.permissionModes.map(mode => <option key={mode.id} value={mode.id}>{mode.name}</option>)}
          </Select>
        </label>
      </div>
    </div>
    <div className="im-conversations">
      <div className="im-conversations-header">
        <h2>关联对话 ({conversations.length})</h2>
      </div>
      {conversations.length ? <ul>{conversations.map(session => <li key={session.id}>
        <button className="im-conversation" onClick={() => onOpenSession(session)}>
          <span className="im-conversation-main">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" /></svg>
            <span className="im-conversation-info"><strong title={session.title ?? session.prompt}>{session.title ?? session.prompt}</strong><small title={session.cwd}>{projectLabel(session.cwd)} · {agents.find(agent => agent.id === session.agent)?.name || session.agent}</small></span>
          </span>
          <span className="im-conversation-time"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg><time dateTime={new Date(session.updatedAt).toISOString()}>{formatConversationTime(session.updatedAt)}</time></span>
        </button>
      </li>)}</ul> : <p className="im-conversations-empty">暂无关联对话</p>}
    </div>
  </div>;
}

function ImIntegration({ active, sessions, onOpenSession, feishuApps, onFeishuAppsChange, projects, agents, projectLabel, provider }: Props & { provider: 'dingtalk' | 'feishu' | 'wecom' | 'weixin' }) {
  const platform: '钉钉' | '飞书' | '企业微信' | '微信' = provider === 'feishu' ? '飞书' : provider === 'wecom' ? '企业微信' : provider === 'weixin' ? '微信' : '钉钉';
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
  const [verificationRequired, setVerificationRequired] = useState(false);
  const [verifyCode, setVerifyCode] = useState('');
  const [verifying, setVerifying] = useState(false);
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
    if (!open || !registration || verificationRequired) return;
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
        } else if (result.status === 'VERIFY') {
          setVerificationRequired(true);
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
  }, [open, registration, provider, verificationRequired]);

  useEffect(() => {
    if (provider === 'dingtalk' || !registration) return;
    return () => { void fetch(apiUrl(`/api/${provider}/registration/${registration.id}`), { method: 'DELETE' }); };
  }, [provider, registration]);

  function closeRegistration() { registrationAttempt.current++; setOpen(false); setRegistration(null); }

  async function startRegistration() {
    setOpen(true); setBusy(true); setScanError(''); setRegistration(null); setVerificationRequired(false); setVerifyCode(''); setVerifying(false);
    const attempt = ++registrationAttempt.current;
    try {
      const result = await request<Registration>(`/api/${provider}/registration`, { method: 'POST' });
      if (attempt === registrationAttempt.current) setRegistration(result);
      else if (provider !== 'dingtalk') await fetch(apiUrl(`/api/${provider}/registration/${result.id}`), { method: 'DELETE' });
    } catch (reason) { if (attempt === registrationAttempt.current) setScanError((reason as Error).message); }
    finally { if (attempt === registrationAttempt.current) setBusy(false); }
  }

  async function submitVerification() {
    if (!registration || verifying) return;
    const attempt = registrationAttempt.current;
    setVerifying(true); setScanError('');
    try {
      const result = await request<PollResult>(`/api/${provider}/registration/${registration.id}/verify`, { method: 'POST', body: JSON.stringify({ code: verifyCode }) });
      if (attempt !== registrationAttempt.current) return;
      if (result.status === 'SUCCESS') {
        const apps = await request<Application[]>(`/api/${provider}/apps`);
        if (attempt !== registrationAttempt.current) return;
        setApps(apps); setOpen(false); setRegistration(null);
      } else if (result.status === 'WAITING') {
        setVerifyCode(''); setVerificationRequired(false);
      } else if (result.status === 'VERIFY') setScanError('验证码未通过，请检查手机上显示的验证码。');
      else {
        setScanError(result.reason || '二维码已过期，请重新扫码。');
        setVerificationRequired(false); setRegistration(null);
      }
    } catch (reason) { if (attempt === registrationAttempt.current) setScanError((reason as Error).message); }
    finally { if (attempt === registrationAttempt.current) setVerifying(false); }
  }

  async function bind(id: string, binding: { project?: string | null; agent?: string | null; model?: string; permissionMode?: string }) {
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
    <div className="im-intro"><div><h1>IM 集成</h1><p className="im-intro-desc">{provider === 'weixin' ? '微信 Bot 支持单聊，可发送文字、图片和带转写文字的语音。' : '管理钉钉、飞书、企业微信和微信应用，绑定项目与 Agent。'}</p></div><button className="im-primary-button" onClick={() => void startRegistration()}>扫码创建应用</button></div>
    <div className="im-robot-list">
      {apps.length ? apps.map(app => {
        const conversations = sessions.filter(session => session.im?.some(binding => binding.platform === provider && binding.appId === app.id))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return <ImRobotEntry
          key={app.id}
          app={app}
          platform={platform}
          provider={provider}
          agents={agents}
          projects={projects}
          projectLabel={projectLabel}
          conversations={conversations}
          syncing={syncingId === app.id}
          deleting={deletingId === app.id}
          onBind={(id, binding) => void bind(id, binding)}
          onSync={(id) => void syncApp(id)}
          onReconnect={() => void startRegistration()}
          onDelete={(app) => void deleteApp(app)}
          onOpenSession={onOpenSession}
        />;
      }) : <div className="im-empty">暂无{platform}应用</div>}
    </div>
    {open && <div className="im-scan-layer" role="presentation"><button className="im-scan-backdrop" aria-label="关闭扫码窗口" onClick={closeRegistration} /><section ref={scanDialog} className="im-scan-dialog" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); closeRegistration(); }
      if (event.key !== 'Tab') return;
      const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]');
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }} role="dialog" aria-modal="true" aria-labelledby="im-scan-title"><button className="im-scan-close" aria-label="关闭" onClick={closeRegistration}>×</button><h2 id="im-scan-title">使用{platform}扫码创建应用</h2>
      {busy && <p className="im-scan-message">正在获取授权二维码…</p>}
      {registration && <><img className="im-qr-image" src={registration.qrCode} alt={`${platform}应用授权二维码`} />{registration.userCode && <p className="im-user-code">授权码 <strong>{registration.userCode}</strong></p>}<p>请使用{platform}扫描二维码并完成授权</p>{registration.verificationUrl && <a className="im-open-link" href={registration.verificationUrl} target="_blank" rel="noopener noreferrer">在浏览器中打开授权页面</a>}</>}
      {verificationRequired && <form className="im-verify-form" onSubmit={event => { event.preventDefault(); void submitVerification(); }}>
        <label htmlFor="im-verify-code">输入微信手机端显示的验证码</label>
        <input id="im-verify-code" value={verifyCode} onChange={event => setVerifyCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{4,8}" maxLength={8} required disabled={verifying} />
        <button className="im-primary-button" disabled={verifying}>{verifying ? '验证中…' : '提交验证码'}</button>
      </form>}
      {scanError && <><p className="im-scan-error" role="alert">{scanError}</p>{!registration && <button className="im-primary-button" onClick={() => void startRegistration()}>重新获取二维码</button>}</>}
    </section></div>}
  </div>;
}
