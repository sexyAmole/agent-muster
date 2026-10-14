import { useEffect, useState } from 'react';
import { useErrorMessage } from './message';
import { AgentIcon } from './agent-icon';
import type { AgentAction, AgentInfo, ManagedAgent } from '../../src/types';

type Props = { active: boolean; onChange: (agents: AgentInfo[]) => void };
const actionLabels: Record<AgentAction, string> = { install: '安装', update: '更新', uninstall: '卸载' };

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result as T;
}

export function AgentPanel({ active, onChange }: Props) {
  const [agents, setAgents] = useState<ManagedAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState<{ id: string; action: AgentAction } | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  useErrorMessage(error, setError);
  const [message, setMessage] = useState('');
  const [output, setOutput] = useState('');

  useEffect(() => {
    if (!active) return;
    let current = true;
    setLoading(true);
    request<ManagedAgent[]>('/api/agents/management').then(result => {
      if (current) setAgents(result);
    }).catch(reason => { if (current) setError((reason as Error).message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [active]);

  async function refresh() {
    setLoading(true); setError('');
    try {
      const result = await request<ManagedAgent[]>('/api/agents/refresh', { method: 'POST' });
      setAgents(result); onChange(result);
    } catch (reason) { setError((reason as Error).message); }
    finally { setLoading(false); }
  }

  async function run(agent: ManagedAgent, action: AgentAction) {
    if (operation || loading) return;
    if (action === 'uninstall' && !window.confirm(`卸载 ${agent.name}？将移除本机 CLI，保留配置和对话记录。`)) return;
    setOperation({ id: agent.id, action }); setError(''); setMessage(''); setOutput('');
    try {
      const result = await request<{ agents: ManagedAgent[]; output: string }>(`/api/agents/${agent.id}/actions`, { method: 'POST', body: JSON.stringify({ action }) });
      setAgents(result.agents); onChange(result.agents);
      setMessage(`${agent.name} ${actionLabels[action]}完成`); setOutput(result.output);
    } catch (reason) {
      setError((reason as Error).message);
      try {
        const result = await request<ManagedAgent[]>('/api/agents/management');
        setAgents(result); onChange(result);
      } catch (refreshError) { setError(`${(reason as Error).message}\n刷新失败：${(refreshError as Error).message}`); }
    } finally { setOperation(null); }
  }

  async function saveSandbox(agent: ManagedAgent, sandboxEnabled: boolean) {
    setSavingId(agent.id); setError('');
    try {
      const result = await request<AgentInfo[]>(`/api/agents/${agent.id}/settings`, { method: 'PATCH', body: JSON.stringify({ sandboxEnabled }) });
      setAgents(current => current.map(item => ({ ...item, ...result.find(updated => updated.id === item.id) })));
      onChange(result);
    } catch (reason) { setError((reason as Error).message); }
    finally { setSavingId(null); }
  }

  return <section className="agent-panel" aria-label="Agent 管理">
    <div className="im-intro"><div><h1>Agent 管理</h1><p className="agent-intro">管理本机 CLI 和内置沙箱设置。</p></div><button className="im-sync-button" disabled={loading || Boolean(savingId) || Boolean(operation)} onClick={() => void refresh()}>{loading ? '刷新中…' : '刷新状态'}</button></div>
    <div className="agent-feedback" role="status" aria-live="polite">{operation ? `正在${actionLabels[operation.action]} ${agents.find(agent => agent.id === operation.id)?.name}，请等待完成…` : message}</div>
    {loading && !agents.length && <p className="im-empty">正在读取 Agent 信息…</p>}
    <div className="agent-list">{agents.map(agent => <article className="agent-entry" key={agent.id}>
      <div className="agent-entry-row">
        <details className="agent-entry-info">
          <summary className="agent-entry-heading"><span className="agent-entry-name"><span className="agent-chevron" aria-hidden="true" /><AgentIcon agent={agent.id} /><strong>{agent.name}</strong></span><span className={`agent-install-status ${agent.installed ? 'installed' : ''}`}>{agent.installed ? '已安装' : '未安装'}</span></summary>
          <dl className="agent-details"><div><dt>版本</dt><dd title={agent.versionError}>{agent.installed ? agent.version || '读取失败' : '—'}</dd></div><div><dt>命令</dt><dd><code>{agent.command}</code></dd></div>{agent.path && <div><dt>路径</dt><dd className="agent-path" title={agent.path}>{agent.path}</dd></div>}</dl>
        </details>
        <details className="agent-action-menu" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
          <summary aria-label={`${agent.name} 操作`}>操作<span className="agent-chevron" aria-hidden="true" /></summary>
          <div className="agent-action-popover">
            {agent.sandboxSupported && <div className="agent-sandbox"><span>内置沙箱</span><button type="button" role="switch" className="agent-sandbox-switch" aria-label={`${agent.name} 内置沙箱`} aria-checked={agent.sandboxEnabled} disabled={!agent.installed || loading || Boolean(operation) || Boolean(savingId)} onClick={() => void saveSandbox(agent, !agent.sandboxEnabled)}><span className="agent-sandbox-track" aria-hidden="true" />{agent.sandboxEnabled ? '已开启' : '已关闭'}</button></div>}
            {agent.sandboxSupported && savingId === agent.id && <p className="agent-sandbox-note">正在保存…</p>}
            <div className="agent-entry-actions">{agent.installed ? <><button className="im-sync-button" disabled={loading || Boolean(savingId) || Boolean(operation) || !agent.management} onClick={() => void run(agent, 'update')}>{operation?.id === agent.id && operation.action === 'update' ? '更新中…' : '更新至最新版'}</button><button className="im-delete-button" disabled={loading || Boolean(savingId) || Boolean(operation) || !agent.management} onClick={() => void run(agent, 'uninstall')}>{operation?.id === agent.id && operation.action === 'uninstall' ? '卸载中…' : '卸载'}</button></> : <button className="im-primary-button" disabled={loading || Boolean(savingId) || Boolean(operation) || !agent.management} onClick={() => void run(agent, 'install')}>{operation?.id === agent.id && operation.action === 'install' ? '安装中…' : '安装'}</button>}</div>
          </div>
        </details>
      </div>
      {agent.versionError && <p className="agent-entry-error">版本读取失败：{agent.versionError}</p>}
      {agent.managementError && <p className="agent-entry-error">{agent.managementError}</p>}
    </article>)}</div>
    {output && <details className="agent-operation-output"><summary>操作输出</summary><pre>{output}</pre></details>}
  </section>;
}
