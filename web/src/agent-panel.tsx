import { useEffect, useState } from 'react';
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
  const [error, setError] = useState('');
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

  return <section className="agent-panel" aria-label="Agent 管理">
    <div className="im-intro"><div><h1>Agent 管理</h1><p className="agent-intro">查看本机 CLI 版本，安装、更新或卸载 Agent。</p></div><button className="im-sync-button" disabled={loading || Boolean(operation)} onClick={() => void refresh()}>{loading ? '刷新中…' : '刷新状态'}</button></div>
    {error && <div className="im-error" role="alert"><span>{error}</span><button onClick={() => setError('')}>关闭</button></div>}
    <div className="agent-feedback" role="status" aria-live="polite">{operation ? `正在${actionLabels[operation.action]} ${agents.find(agent => agent.id === operation.id)?.name}，请等待完成…` : message}</div>
    {loading && !agents.length && <p className="im-empty">正在读取 Agent 信息…</p>}
    <div className="agent-list">{agents.map(agent => <article className="agent-entry" key={agent.id}>
      <div className="agent-entry-heading"><strong>{agent.name}</strong><span className={`agent-install-status ${agent.installed ? 'installed' : ''}`}>{agent.installed ? '已安装' : '未安装'}</span></div>
      <dl className="agent-details"><div><dt>版本</dt><dd title={agent.versionError}>{agent.installed ? agent.version || '读取失败' : '—'}</dd></div><div><dt>命令</dt><dd><code>{agent.command}</code></dd></div>{agent.path && <div><dt>路径</dt><dd className="agent-path" title={agent.path}>{agent.path}</dd></div>}</dl>
      {agent.versionError && <p className="agent-entry-error">版本读取失败：{agent.versionError}</p>}
      {agent.managementError && <p className="agent-entry-error">{agent.managementError}</p>}
      <div className="agent-entry-actions">{agent.installed ? <><button className="im-sync-button" disabled={loading || Boolean(operation) || !agent.management} onClick={() => void run(agent, 'update')}>{operation?.id === agent.id && operation.action === 'update' ? '更新中…' : '更新至最新版'}</button><button className="im-delete-button" disabled={loading || Boolean(operation) || !agent.management} onClick={() => void run(agent, 'uninstall')}>{operation?.id === agent.id && operation.action === 'uninstall' ? '卸载中…' : '卸载'}</button></> : <button className="im-primary-button" disabled={loading || Boolean(operation) || !agent.management} onClick={() => void run(agent, 'install')}>{operation?.id === agent.id && operation.action === 'install' ? '安装中…' : '安装'}</button>}</div>
    </article>)}</div>
    {output && <details className="agent-operation-output"><summary>操作输出</summary><pre>{output}</pre></details>}
  </section>;
}
