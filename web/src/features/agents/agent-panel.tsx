import { useEffect, useState } from 'react';
import type { AgentAction, AgentInfo, ManagedAgent } from '../../../../src/types';
import { useErrorMessage } from '../../shared/components/message';
import { apiUrl } from '../../shared/lib/api-url';
import { AgentIcon } from './agent-icon';

type Props = { active: boolean; agents: AgentInfo[]; onChange: (agents: AgentInfo[]) => void };
type AgentOperation = { id: string; action: AgentAction };
const actionLabels: Record<AgentAction, string> = { install: '安装', update: '更新', uninstall: '卸载' };

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), { ...options, headers: { 'Content-Type': 'application/json' } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result as T;
}

async function copyToClipboard(text: string) {
  await navigator.clipboard.writeText(text);
}

type AgentEntryProps = {
  agent: ManagedAgent;
  active: boolean;
  revision: number;
  disabled: boolean;
  operation: AgentOperation | null;
  onRun: (agent: ManagedAgent, action: AgentAction) => Promise<void>;
};

function AgentEntry({ agent, active, revision, disabled, operation, onRun }: AgentEntryProps) {
  const [details, setDetails] = useState<ManagedAgent>();
  const [loading, setLoading] = useState(agent.installed);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState<'command' | 'path' | null>(null);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setDetails(undefined);
    request<ManagedAgent>(`/api/agents/${agent.id}/details${retry ? '?refresh=true' : ''}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setDetails(result); })
      .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, agent, revision, retry]);

  function handleCopy(field: 'command' | 'path', text: string) {
    void copyToClipboard(text).then(() => {
      setCopied(field);
      window.setTimeout(() => setCopied(null), 1200);
    });
  }

  const info = details || agent;
  const action = operation?.id === agent.id ? operation.action : undefined;
  const failed = Boolean(error || info.versionError || info.latestVersionError);
  const currentVersion = agent.installed ? (loading ? '' : info.version || '读取失败') : '未安装';
  const showUpdate = !loading && info.updateAvailable === true;
  const canManage = Boolean(info.management);

  return <article className="agent-entry" aria-label={agent.name}>
    <div className="agent-entry-heading">
      <span className="agent-entry-name"><AgentIcon agent={agent.id} /><strong>{agent.name}</strong></span>
      <div className="agent-entry-heading-actions">
        <span className={`agent-status-tag ${agent.installed ? 'installed' : ''}`}>{agent.installed ? '已安装' : '未安装'}</span>
        {showUpdate && <span className="agent-status-tag update">可更新</span>}
      </div>
    </div>
    <dl className="agent-details">
      <div className="agent-detail-row">
        <dt>当前版本</dt>
        <dd>{loading && agent.installed ? <span className="agent-version-loading" role="status"><span className="agent-loading-dot" aria-hidden="true" />读取中…</span> : currentVersion}</dd>
      </div>
      <div className="agent-detail-row">
        <dt>最新版本</dt>
        <dd>{info.latestVersion || (loading ? '—' : (info.latestVersionError ? '检查失败' : '—'))}</dd>
      </div>
      <div className="agent-detail-row">
        <dt>命令</dt>
        <dd className="agent-command-cell">
          <span className="agent-command"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4 17 6-6-6-6M12 19h8" /></svg><code>{agent.command}</code></span>
          <button type="button" className="agent-copy-button" aria-label={copied === 'command' ? '已复制' : '复制命令'} onClick={() => handleCopy('command', agent.command)}>
            {copied === 'command' ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>}
          </button>
        </dd>
      </div>
      {agent.path && <div className="agent-detail-row">
        <dt>安装路径</dt>
        <dd className="agent-command-cell">
          <span className="agent-path" title={agent.path}>{agent.path}</span>
          <button type="button" className="agent-copy-button" aria-label={copied === 'path' ? '已复制' : '复制安装路径'} onClick={() => handleCopy('path', agent.path!)}>
            {copied === 'path' ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>}
          </button>
        </dd>
      </div>}
    </dl>
    {error && <p className="agent-entry-error">{error}</p>}
    {info.versionError && <p className="agent-entry-error">版本读取失败：{info.versionError}</p>}
    {info.latestVersionError && <p className="agent-entry-error">最新版本检查失败：{info.latestVersionError}</p>}
    {info.managementError && <p className="agent-entry-error">{info.managementError}</p>}
    <div className="agent-entry-actions">
      {!agent.installed && <button type="button" className="agent-update-button" disabled={disabled || loading || !canManage} onClick={() => void onRun(info, 'install')}>{action === 'install' ? '安装中…' : `安装 ${agent.name}`}</button>}
      {agent.installed && (
        <>
          {showUpdate && <button type="button" className="agent-update-button" disabled={disabled || !canManage} aria-label={action === 'update' ? `正在更新 ${agent.name}` : `更新 ${agent.name}`} onClick={() => void onRun(info, 'update')}>{action === 'update' ? '更新中…' : '更新'}</button>}
          <button type="button" className="agent-heading-action danger" disabled={disabled || loading || !canManage} aria-label={`卸载 ${agent.name}`} onClick={() => void onRun(info, 'uninstall')}>{action === 'uninstall' ? '卸载中…' : '卸载'}</button>
        </>
      )}
      {!loading && (failed || (info.updateAvailable === undefined && agent.installed)) && <button className="im-sync-button" disabled={disabled} onClick={() => setRetry(value => value + 1)}>重新检查</button>}
    </div>
  </article>;
}

export function AgentPanel({ active, agents: availableAgents, onChange }: Props) {
  const [agents, setAgents] = useState<ManagedAgent[]>(availableAgents);
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState<AgentOperation | null>(null);
  const [error, setError] = useState('');
  useErrorMessage(error, setError);
  const [message, setMessage] = useState('');
  const [output, setOutput] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => { setAgents(availableAgents); }, [availableAgents]);

  async function refresh() {
    setLoading(true); setError('');
    try {
      const result = await request<ManagedAgent[]>('/api/agents/refresh', { method: 'POST' });
      setAgents(result); onChange(result); setRevision(value => value + 1);
    } catch (reason) { setError((reason as Error).message); }
    finally { setLoading(false); }
  }

  async function run(agent: ManagedAgent, action: AgentAction) {
    if (operation || loading) return;
    if (action === 'uninstall' && !window.confirm(`卸载 ${agent.name}？将移除本机 CLI，保留配置和对话记录。`)) return;
    setOperation({ id: agent.id, action }); setError(''); setMessage(''); setOutput('');
    try {
      const result = await request<{ agents: ManagedAgent[]; output: string }>(`/api/agents/${agent.id}/actions`, { method: 'POST', body: JSON.stringify({ action }) });
      setAgents(result.agents); onChange(result.agents); setRevision(value => value + 1);
      setMessage(`${agent.name} ${actionLabels[action]}完成`); setOutput(result.output);
    } catch (reason) {
      setError((reason as Error).message);
      try {
        const result = await request<ManagedAgent[]>('/api/agents/management');
        setAgents(result); onChange(result); setRevision(value => value + 1);
      } catch (refreshError) { setError(`${(reason as Error).message}\n刷新失败：${(refreshError as Error).message}`); }
    } finally { setOperation(null); }
  }

  return <section className="agent-panel" aria-label="Agent 管理">
    <div className="im-intro"><div><h1>Agent 管理</h1><p className="agent-intro">管理本机 CLI 的安装、版本和更新。</p></div></div>
    <div className="agent-feedback" role="status" aria-live="polite">{operation ? `正在${actionLabels[operation.action]} ${agents.find(agent => agent.id === operation.id)?.name}，请等待完成…` : message}</div>
    <div className="agent-list">{agents.map(agent => <AgentEntry key={agent.id} agent={agent} active={active} revision={revision} disabled={loading || Boolean(operation)} operation={operation} onRun={run} />)}</div>
    {output && <details className="agent-operation-output"><summary>操作输出</summary><pre>{output}</pre></details>}
  </section>;
}
