import React, { useEffect, useRef, useState } from 'react';
import { Select } from './select';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ImPrototype } from './im-prototype';
import { AppIcon } from './app-icon';
import { AgentPanel } from './agent-panel';
import type { AgentInfo as Agent } from '../../src/types';
import './style.css';

type Status = 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';
type FeishuApp = { id: string; icon: string | null };
type TokenUsage = { inputTokens: number; outputTokens: number };
type DingTalkConversation = { type: 'single' | 'group'; groupName?: string; senderName: string; senderStaffId: string };
type Event = { id: number; type: 'output' | 'status' | 'error' | 'warning' | 'message' | 'dingtalk_message' | 'feishu_message' | 'tool' | 'file_change' | 'usage'; text: string; detail?: string; kind?: string; comparison?: string; timestamp: number; pushedToIm?: boolean; feishuConversation?: { type: 'single' | 'group'; senderId: string }; dingtalkConversation?: DingTalkConversation };
type Session = {
  id: string; agent: string; dingtalkAppId?: string; feishuAppId?: string; cwd: string; prompt: string; model?: string; usage?: TokenUsage; externalSessionId?: string;
  feishuConversation?: { type: 'single' | 'group'; senderId: string }; dingtalkConversation?: DingTalkConversation;
  status: Status; createdAt: number; updatedAt: number; events: Event[];
};
type Directory = { path: string };
type Layout = 'single' | 'double' | 'quad';
type PaneState = { sessionId: string | null; cwd: string; revision: number };
function ActionIcon({ type }: { type: 'add' | 'edit' | 'delete' }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {type === 'add' ? <path d="M12 5v14M5 12h14" /> : type === 'edit' ? <path d="m16 3 5 5M4 16 16 4a3.5 3.5 0 0 1 5 5L9 21H4v-5Z" /> : <><path d="M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M5 6l1 14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-14M10 10v7M14 10v7" /></>}
  </svg>;
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result as T;
}

function shortPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function projectLabel(path: string, projects: string[]): string {
  const name = shortPath(path);
  return projects.filter(project => shortPath(project) === name).length > 1
    ? path.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
    : name;
}

function time(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value);
}

function tokenCount(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

const statusLabel: Record<Status, string> = {
  starting: '准备中', running: '运行中', waiting: '等待中', completed: '已完成', failed: '失败', stopped: '已停止',
};

function toolLabel(command: string): string {
  const normalized = command.replace(/^\$\s*(?:\/bin\/(?:zsh|bash|sh)\s+-lc\s+)?/, '');
  const quote = normalized[0] === '"' || normalized[0] === "'" ? normalized[0] : '';
  const firstLine = normalized.slice(quote ? 1 : 0).split('\n')[0];
  return quote && firstLine.endsWith(quote) ? firstLine.slice(0, -1) : firstLine;
}

function isDiff(value: string): boolean {
  return /^diff --git /m.test(value) || /^@@ -\d/m.test(value);
}

function Diff({ text }: { text: string }) {
  return <pre className="diff-content">{text.split('\n').map((line, index) => {
    const tone = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('@@')
      ? 'meta' : line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : '';
    return <span className={`diff-line ${tone}`} key={index}>{line || ' '}{'\n'}</span>;
  })}</pre>;
}

function conversationEvents(session: Session): Event[] {
  if (session.agent !== 'codex') return session.events;
  const events: Event[] = [];
  for (let index = 0; index < session.events.length; index++) {
    const event = session.events[index];
    if (event.type !== 'output' || !event.text.startsWith('$ ')) {
      events.push(event);
      continue;
    }
    const commands: Event[] = [];
    while (session.events[index]?.type === 'output' && session.events[index].text.startsWith('$ ')) {
      commands.push(session.events[index++]);
    }
    const outputs: Event[] = [];
    // Legacy command output usually follows its command marker immediately; later replies stay separate.
    while (outputs.length < commands.length) {
      const next = session.events[index];
      if (next?.type !== 'output' || next.text.startsWith('$ ') || next.timestamp - commands.at(-1)!.timestamp > 1000) break;
      outputs.push(next);
      index++;
    }
    commands.forEach((command, position) => events.push({ ...command, type: 'tool', detail: outputs[position]?.text }));
    index--;
  }
  return events;
}

function conversationItems(session: Session): (Event | Event[])[] {
  const items: (Event | Event[])[] = [];
  for (const event of conversationEvents(session)) {
    if (event.type !== 'message' && event.type !== 'output' && event.type !== 'dingtalk_message' && event.type !== 'feishu_message' && event.type !== 'tool' && event.type !== 'file_change' && !(event.type === 'error' && session.status === 'failed')) continue;
    if (event.type === 'tool') {
      const previous = items.at(-1);
      if (Array.isArray(previous)) previous.push(event);
      else items.push([event]);
    } else {
      items.push(event);
    }
  }
  return items;
}

function conversationText(session: Session): string {
  return conversationItems(session).flatMap(item => {
    if (Array.isArray(item) || (item.type !== 'message' && item.type !== 'output' && item.type !== 'dingtalk_message' && item.type !== 'feishu_message')) return [];
    return [`${item.type === 'message' ? '用户' : item.type === 'feishu_message' ? '应用（已发送到飞书）' : item.type === 'dingtalk_message' ? '应用（已发送到钉钉）' : '助手'}：\n${item.text.trim()}`];
  }).join('\n\n');
}

function fileLabel(path: string, cwd: string): string {
  const prefix = cwd.replace(/[\\/]+$/, '');
  return path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}\\`) ? path.slice(prefix.length + 1) : path;
}

function ToolCall({ event }: { event: Event }) {
  const label = toolLabel(event.text);
  return <details className="tool-call"><summary><span className="tool-call-label">工具</span><strong title={event.text}>{label}</strong>{event.detail && <span className="tool-call-chevron" />}</summary>{event.detail && (isDiff(event.detail) ? <Diff text={event.detail} /> : <pre>{event.detail}</pre>)}</details>;
}

function FileChange({ event, cwd }: { event: Event; cwd: string }) {
  const kind = event.kind === 'add' ? '新增' : event.kind === 'delete' ? '删除' : event.kind === 'move' ? '移动' : '修改';
  const content = <><span className={`change-kind ${event.kind || 'update'}`}>{kind}</span><strong title={event.text}>{fileLabel(event.text, cwd)}</strong>{event.comparison && <small className="change-baseline">对比 {event.comparison}</small>}{event.detail && <span className="tool-call-chevron" />}</>;
  return event.detail
    ? <details className="file-change"><summary>{content}</summary><Diff text={event.detail} /></details>
    : <div className="file-change file-change-summary">{content}</div>;
}

type PaneProps = {
  index: number;
  pane: PaneState;
  multi: boolean;
  active: boolean;
  agents: Agent[];
  projects: string[];
  sessions: Session[];
  feishuApps: FeishuApp[];
  onFocus: (index: number) => void;
  onProjectChange: (index: number, path: string) => void;
  onSessionCreated: (index: number, session: Session) => void;
  onSessionUpdate: (session: Pick<Session, 'id' | 'status' | 'updatedAt'> & Partial<Pick<Session, 'externalSessionId'>>) => void;
};

function ChatPane({ index, pane, multi, active: focused, agents, projects, sessions, feishuApps, onFocus, onProjectChange, onSessionCreated, onSessionUpdate }: PaneProps) {
  const selectedId = pane.sessionId;
  const [selected, setSelected] = useState<Session | null>(sessions.find(session => session.id === selectedId) || null);
  const [agent, setAgent] = useState(agents.find(item => item.installed)?.id || '');
  const [model, setModel] = useState(sessions.find(session => session.id === selectedId)?.model || '');
  const [message, setMessage] = useState('');
  const [pushingId, setPushingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copiedTarget, setCopiedTarget] = useState<'conversation' | number | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const runLogRef = useRef<HTMLDetailsElement>(null);
  const followConversation = useRef(true);

  useEffect(() => {
    function closeRunLog(event: PointerEvent) {
      const runLog = runLogRef.current;
      if (runLog?.open && event.target instanceof Node && !runLog.contains(event.target)) runLog.open = false;
    }
    document.addEventListener('pointerdown', closeRunLog);
    return () => document.removeEventListener('pointerdown', closeRunLog);
  }, []);

  useEffect(() => {
    if (!agents.some(item => item.id === agent && item.installed)) setAgent(agents.find(item => item.installed)?.id || '');
  }, [agents, agent]);

  useEffect(() => { setModel(selected?.model || ''); }, [selected?.id, selected?.model]);

  useEffect(() => {
    if (!selectedId) { setSelected(null); return; }
    let current = true;
    let source: EventSource | undefined;
    api<Session>(`/api/sessions/${selectedId}`).then(session => {
      if (!current) return;
      setSelected(session);
      onSessionUpdate(session);
      source = new EventSource(`/api/sessions/${selectedId}/events?after=${session.events.at(-1)?.id || 0}`);
      source.onmessage = messageEvent => {
        const event = JSON.parse(messageEvent.data) as Event;
        setSelected(previous => {
          if (!previous || previous.id !== selectedId) return previous;
          if (previous.events.some(item => item.id === event.id)) {
            return event.pushedToIm ? { ...previous, events: previous.events.map(item => item.id === event.id ? { ...item, pushedToIm: true } : item) } : previous;
          }
          const updated = { ...previous, ...(event.feishuConversation ? { feishuConversation: event.feishuConversation } : {}), ...(event.dingtalkConversation ? { dingtalkConversation: event.dingtalkConversation } : {}), status: event.type === 'status' ? event.text as Status : previous.status, usage: event.type === 'usage' ? JSON.parse(event.text) as TokenUsage : previous.usage, updatedAt: event.timestamp, events: [...previous.events, event].slice(-500) };
          return updated;
        });
        if (event.type === 'status') {
          onSessionUpdate({ id: selectedId, status: event.text as Status, updatedAt: event.timestamp });
          api<Session>(`/api/sessions/${selectedId}`).then(latest => {
            if (current) setSelected(previous => previous && (previous.events.at(-1)?.id || 0) > (latest.events.at(-1)?.id || 0)
              ? { ...previous, externalSessionId: latest.externalSessionId }
              : latest);
            if (current) onSessionUpdate(latest);
          });
        }
      };
    }).catch(reason => { if (current) setError((reason as Error).message); });
    return () => { current = false; source?.close(); };
  }, [selectedId]);

  useEffect(() => {
    followConversation.current = true;
    if (conversationRef.current) conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
  }, [selected?.id]);

  useEffect(() => {
    if (followConversation.current && conversationRef.current) conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
  }, [selected?.events.length]);

  useEffect(() => {
    if (copiedTarget === null) return;
    const timer = window.setTimeout(() => setCopiedTarget(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedTarget]);

  async function copyText(text: string, target: 'conversation' | number) {
    setError('');
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTarget(target);
    } catch (reason) { setError(`复制失败：${(reason as Error).message}`); }
  }

  async function send() {
    const content = message.trim();
    if (!canSend) return;
    setError(''); setBusy(true);
    try {
      if (selected) {
        const session = await api<Session>(`/api/sessions/${selected.id}/messages`, { method: 'POST', body: JSON.stringify({ content, model }) });
        onSessionUpdate(session);
      } else {
        const session = await api<Session>('/api/sessions', { method: 'POST', body: JSON.stringify({ agent, cwd: pane.cwd, prompt: content, model }) });
        onSessionCreated(index, session);
      }
      setMessage('');
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  async function pushToIm(event: Event) {
    if (!selected || (!selected.dingtalkAppId && !selected.feishuAppId) || event.type !== 'output' || !event.text.trim() || pushingId !== null || event.pushedToIm) return;
    setError(''); setPushingId(event.id);
    try {
      const session = await api<Session>(`/api/sessions/${selected.id}/${selected.feishuAppId ? 'feishu' : 'dingtalk'}/messages`, { method: 'POST', body: JSON.stringify({ eventId: event.id }) });
      onSessionUpdate(session);
      setSelected(current => current?.id === session.id ? { ...current, events: current.events.map(item => item.id === event.id ? { ...item, pushedToIm: true } : item) } : current);
    } catch (reason) { setError((reason as Error).message); }
    finally { setPushingId(null); }
  }

  async function stop() {
    if (!selected) return;
    setError(''); setBusy(true);
    try { await api(`/api/sessions/${selected.id}/stop`, { method: 'POST' }); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  const running = selected?.status === 'running' || selected?.status === 'starting';
  const imPlatform = selected?.feishuAppId ? '飞书' : '钉钉';
  const composerProject = selected?.cwd || (projects.includes(pane.cwd) ? pane.cwd : '');
  const composerAgent = selected?.agent || agent;
  const agentInfo = agents.find(item => item.id === composerAgent);
  const models = agentInfo?.models || [];
  const contextWindow = models.find(item => item.id === (model || agentInfo?.defaultModel))?.contextWindow;
  const usedTokens = selected?.usage ? selected.usage.inputTokens + selected.usage.outputTokens : undefined;
  const composerDisabled = Boolean(running || (selected && !selected.externalSessionId));
  const canSend = Boolean(message.trim() && !busy && !composerDisabled && agentInfo?.installed && (selected ? selected.externalSessionId : composerProject && agent));
  const agentName = (id: string) => agents.find(item => item.id === id)?.name || id;
  const feishuIcon = feishuApps.find(app => app.id === selected?.feishuAppId)?.icon;

  return <div className={`pane-wrap ${focused && multi ? 'focused' : ''}`} onPointerDown={() => onFocus(index)} onFocusCapture={() => onFocus(index)}>
    <section className="output-panel" aria-label={`对话窗口 ${index + 1}`}>
      <div className="chat-header">
        {selected?.dingtalkAppId && <AppIcon className="chat-app-icon" fallbackClassName="feishu-app-mark" src={`/api/dingtalk/apps/${selected.dingtalkAppId}/icon`} platform="钉钉" />}
        {selected?.feishuAppId && <AppIcon className="chat-app-icon" fallbackClassName="feishu-app-mark" src={feishuIcon} platform="飞书" />}
        <div className="chat-heading">{selected
          ? multi
            ? <><strong title={selected.prompt}>{selected.prompt}</strong><p>{projectLabel(selected.cwd, projects)} · {agentName(selected.agent)} · {statusLabel[selected.status]}</p></>
            : <p>{agentName(selected.agent)} · {statusLabel[selected.status]}</p>
          : <><strong>新对话</strong>{multi && <p>窗口 {index + 1} · 从侧边栏选择对话</p>}</>}{selected?.dingtalkConversation && <p className="chat-source">{selected.dingtalkConversation.type === 'group' ? '群聊' : '单聊'}{selected.dingtalkConversation.type === 'group' && selected.dingtalkConversation.groupName && ` · 群名称：${selected.dingtalkConversation.groupName}`} · 提问人：<span title={selected.dingtalkConversation.senderStaffId}>{selected.dingtalkConversation.senderName}</span></p>}{selected?.feishuConversation && <p className="chat-source">飞书 · {selected.feishuConversation.type === 'group' ? '群聊' : '单聊'} · 提问人：{selected.feishuConversation.senderId}</p>}</div>
        <div className="output-actions">
          {selected && <button className="copy-button" onClick={() => void copyText(conversationText(selected), 'conversation')} aria-label={copiedTarget === 'conversation' ? '已复制对话' : '复制对话'}>{copiedTarget === 'conversation' ? '已复制' : '复制对话'}</button>}
          {selected && <details ref={runLogRef} className="run-log" onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
          }}><summary>运行日志</summary><div className="run-log-content" tabIndex={0}>{selected.events.map(event => <div key={event.id}><span>{time(event.timestamp)} · {event.type}</span><pre>{event.text}</pre>{event.detail && <pre>{event.detail}</pre>}</div>)}</div></details>}
          {running && <button className="stop-button" disabled={busy} onClick={stop}>停止</button>}
        </div>
      </div>
      {error && <div className="global-error" role="alert"><span>{error}</span><button onClick={() => setError('')}>关闭</button></div>}
      <div className="conversation-scroll" key={selected?.id} ref={conversationRef} role="log" aria-label={`窗口 ${index + 1} 对话记录`} onScroll={event => {
        const element = event.currentTarget;
        followConversation.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}>
        {selected ? <div className="chat-thread">
          {conversationItems(selected).map(item => Array.isArray(item)
            ? item.length === 1
              ? <ToolCall key={item[0].id} event={item[0]} />
              : <details key={item[0].id} className="tool-group"><summary className="tool-group-heading">工具调用 · {item.length} 次<span className="tool-call-chevron" /></summary><div className="tool-group-content">{item.map(event => <ToolCall key={event.id} event={event} />)}</div></details>
            : item.type === 'message'
              ? <div key={item.id} className="chat-turn user-turn"><div className="user-bubble">{item.text}</div></div>
              : item.type === 'file_change'
                ? <FileChange key={item.id} event={item} cwd={selected.cwd} />
              : item.type === 'error'
                ? <div key={item.id} className="chat-notice">{item.text}</div>
                : <div key={item.id} className="chat-turn assistant-turn">{(item.type === 'dingtalk_message' || item.type === 'feishu_message') && <div className="dingtalk-sent-label">应用 · 已发送到{item.type === 'feishu_message' ? '飞书' : '钉钉'}</div>}<div className="assistant-copy">{(item.type === 'dingtalk_message' || item.type === 'feishu_message') ? <div className="dingtalk-sent-content">{item.text}</div> : <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>}</div><div className="reply-actions"><button className="reply-copy" aria-label={copiedTarget === item.id ? '已复制这条回复' : '复制这条回复'} onClick={() => void copyText(item.text, item.id)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{copiedTarget === item.id ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" /></>}</svg></button>{item.type === 'output' && (selected.dingtalkAppId || selected.feishuAppId) && item.text.trim() && <button className="reply-push" disabled={pushingId !== null || item.pushedToIm} onClick={() => void pushToIm(item)}>{pushingId === item.id ? '推送中…' : item.pushedToIm ? '已推送' : `推送给${imPlatform}`}</button>}</div></div>)}
          {running && <div className="chat-progress"><span />{agentName(selected.agent)} 正在处理…</div>}
        </div> : <div className="chat-empty"><strong>描述你想完成的任务</strong></div>}
      </div>
      <div className="chat-compose-wrap">
        {!selected && <div className="composer-project-row">
          <span className="project-select">
            <span className="project-folder" aria-hidden="true" />
            <Select aria-label={`窗口 ${index + 1} 选择项目`} value={composerProject} disabled={busy} onChange={value => onProjectChange(index, value)}>
              {!composerProject && <option value="">选择项目</option>}
              {projects.map(path => <option key={path} value={path}>{projectLabel(path, projects)}</option>)}
            </Select>
          </span>
          <span className="agent-select"><Select aria-label={`窗口 ${index + 1} 选择 Agent`} value={composerAgent} disabled={busy} onChange={value => { setAgent(value); setModel(''); }}>{!composerAgent && <option value="">选择 Agent</option>}{agents.map(item => <option key={item.id} value={item.id} disabled={!item.installed}>{item.name}{item.installed ? '' : '（未安装）'}</option>)}</Select></span>
        </div>}
        <div className="chat-composer">
          <textarea ref={composerRef} aria-label={`窗口 ${index + 1} 消息`} value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={running ? '等待 Agent 完成当前任务…' : selected ? '继续输入任务要求' : '描述要完成的任务'} disabled={busy || composerDisabled} rows={2} />
          <div className="composer-footer"><div className="composer-actions"><label className="model-select"><Select aria-label={`窗口 ${index + 1} 选择模型`} value={model} disabled={!composerAgent || busy || Boolean(running)} onChange={value => setModel(value)}><option value="">{agentInfo?.defaultModel ? `默认 · ${agentInfo.defaultModel}` : 'Agent 默认'}</option>{model && !models.some(item => item.id === model) && <option value={model} disabled={composerAgent === 'codex' && model === 'gpt-6.1-sol'}>{model}</option>}{models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label></div><button className="composer-send" aria-label={selected ? '发送消息' : '创建对话并发送'} disabled={!canSend} onClick={send}>↑</button></div>
        </div>
        {selected && <div className="context-status" title={selected.usage ? `累计输入 ${selected.usage.inputTokens.toLocaleString()} Token，累计输出 ${selected.usage.outputTokens.toLocaleString()} Token` : 'Agent 尚未返回 Token 用量'}>{usedTokens === undefined && !contextWindow ? '上下文数据未提供' : `累计消耗 ${usedTokens === undefined ? '暂无用量' : `${tokenCount(usedTokens)} Token`} · 单次窗口 ${contextWindow ? `${tokenCount(contextWindow)} Token` : '未提供'}`}</div>}
      </div>
    </section>
  </div>;
}

function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [feishuApps, setFeishuApps] = useState<FeishuApp[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [panes, setPanes] = useState<PaneState[]>(Array.from({ length: 4 }, () => ({ sessionId: null, cwd: '', revision: 0 })));
  const [activePane, setActivePane] = useState(0);
  const [layout, setLayout] = useState<Layout>('single');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [imOpen, setImOpen] = useState(() => new URLSearchParams(window.location.search).get('im-view') === 'robots');
  const [agentsOpen, setAgentsOpen] = useState(false);
  const paneCount = layout === 'single' ? 1 : layout === 'double' ? 2 : 4;
  const currentPane = panes[activePane];

  useEffect(() => {
    Promise.all([api<Agent[]>('/api/agents'), api<Session[]>('/api/sessions'), api<string[]>('/api/projects'), api<Directory>('/api/directories'), api<FeishuApp[]>('/api/feishu/apps')])
      .then(([available, history, savedProjects, directory, apps]) => {
        const paths = [...new Set([...savedProjects, ...history.map(session => session.cwd)])];
        const firstProject = history[0]?.cwd || savedProjects[0] || directory.path;
        setAgents(available); setSessions(history); setProjects(paths); setExpandedProject(firstProject);
        setFeishuApps(apps);
        setPanes(current => current.map((pane, index) => index === 0 ? { sessionId: history[0]?.id || null, cwd: firstProject, revision: pane.revision + 1 } : pane));
      }).catch(reason => setError((reason as Error).message));
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void api<Session[]>('/api/sessions').then(setSessions).catch(reason => setError((reason as Error).message));
      void api<FeishuApp[]>('/api/feishu/apps').then(setFeishuApps).catch(reason => setError((reason as Error).message));
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileMenuOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [mobileMenuOpen]);

  function setPane(index: number, sessionId: string | null, cwd: string) {
    setPanes(current => current.map((pane, position) => position === index ? { sessionId, cwd, revision: pane.revision + 1 } : pane));
    setActivePane(index);
  }

  function newConversation(path: string, index = activePane) {
    setImOpen(false);
    setAgentsOpen(false);
    setMobileMenuOpen(false);
    setExpandedProject(path || null);
    setPane(index, null, path);
  }

  function openConversation(session: Session) {
    setImOpen(false);
    setAgentsOpen(false);
    setMobileMenuOpen(false);
    setExpandedProject(session.cwd);
    setPane(activePane, session.id, session.cwd);
  }

  async function pickProject(index = activePane) {
    if (picking) return;
    setError(''); setPicking(true);
    try {
      const result = await api<{ path: string | null }>('/api/projects/pick', { method: 'POST' });
      if (!result.path) return;
      const path = result.path;
      setProjects(current => current.includes(path) ? current : [...current, path]);
      newConversation(path, index);
    } catch (reason) { setError((reason as Error).message); }
    finally { setPicking(false); }
  }

  async function deleteProject(path: string) {
    const count = sessions.filter(session => session.cwd === path).length;
    if (!window.confirm(`删除项目“${projectLabel(path, projects)}”及其 ${count} 个对话记录？本地项目文件不会删除。`)) return;
    setError('');
    try {
      await api('/api/projects', { method: 'DELETE', body: JSON.stringify({ path }) });
      const remaining = projects.filter(project => project !== path);
      setProjects(remaining);
      setSessions(current => current.filter(session => session.cwd !== path));
      setExpandedProject(current => current === path ? remaining[0] || null : current);
      setPanes(current => current.map(pane => pane.cwd === path ? { sessionId: null, cwd: remaining[0] || '', revision: pane.revision + 1 } : pane));
    } catch (reason) { setError((reason as Error).message); }
  }

  async function deleteSession(session: Session) {
    if (!window.confirm(`删除对话“${session.prompt}”？此操作会删除对话记录。`)) return;
    setError('');
    try {
      await api(`/api/sessions/${session.id}`, { method: 'DELETE' });
      setSessions(current => current.filter(item => item.id !== session.id));
      setPanes(current => current.map(pane => pane.sessionId === session.id ? { ...pane, sessionId: null, revision: pane.revision + 1 } : pane));
    } catch (reason) { setError((reason as Error).message); }
  }

  function changeLayout(next: Layout) {
    const count = next === 'single' ? 1 : next === 'double' ? 2 : 4;
    setActivePane(current => Math.min(current, count - 1));
    setLayout(next);
  }

  function updateSession(session: Pick<Session, 'id' | 'status' | 'updatedAt'> & Partial<Pick<Session, 'externalSessionId'>>) {
    setSessions(current => current.map(item => item.id === session.id ? { ...item, status: session.status, updatedAt: session.updatedAt, externalSessionId: session.externalSessionId ?? item.externalSessionId } : item));
  }

  function sessionCreated(index: number, session: Session) {
    setSessions(current => [session, ...current]);
    setExpandedProject(session.cwd);
    setPane(index, session.id, session.cwd);
  }

  const agentName = (id: string) => agents.find(item => item.id === id)?.name || id;
  const activeSessionId = currentPane.sessionId;

  return <div className="app-shell">
    <button className={`mobile-menu-backdrop ${mobileMenuOpen ? 'open' : ''}`} aria-label="关闭菜单" onClick={() => setMobileMenuOpen(false)} />
    <aside className={`sidebar ${mobileMenuOpen ? 'open' : ''}`} id="project-menu">
      <div className="brand"><div className="brand-symbol"><span /><span /><span /></div><strong>Agent Muster</strong><button className="menu-close" aria-label="关闭菜单" onClick={() => setMobileMenuOpen(false)}>×</button></div>
      <nav className="sidebar-menu" aria-label="快捷菜单">
        <button className="sidebar-create" disabled={picking} onClick={() => void pickProject()}><ActionIcon type="add" /><span>创建项目</span></button>
        {!imOpen && !agentsOpen && <div className="layout-switch">
          <Select aria-label="窗口模式" triggerLabel={<><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M12 3v18M12 12h9" /></svg><span>窗口模式</span></>} value={layout} onChange={value => changeLayout(value as Layout)}>
            <option value="single">单窗</option>
            <option value="double">1×2</option>
            <option value="quad">2×2</option>
          </Select>
        </div>}
        <button className={`im-sidebar-link ${imOpen ? 'active' : ''}`} onClick={() => { setImOpen(true); setAgentsOpen(false); setMobileMenuOpen(false); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" /></svg><span>IM 集成</span></button>
        <button className={`im-sidebar-link ${agentsOpen ? 'active' : ''}`} onClick={() => { setAgentsOpen(true); setImOpen(false); setMobileMenuOpen(false); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="6" width="16" height="14" rx="3" /><path d="M12 6V3M8 11h.01M16 11h.01M8 16h8M1 11v4M23 11v4" /></svg><span>Agent 管理</span></button>
      </nav>
      <nav className="sidebar-projects" aria-label="项目和对话">
        <div className="section-title"><span>项目 <span className="count">{projects.length}</span></span><button className="add-project" disabled={picking} onClick={() => void pickProject()} aria-label="添加项目" title="添加项目"><ActionIcon type="add" /></button></div>
        {projects.map(path => {
          const projectSessions = sessions.filter(session => session.cwd === path);
          const expanded = expandedProject === path;
          return <div className="project-group" key={path}>
            <div className="project-row">
              <button className={`project-item ${currentPane.cwd === path ? 'active' : ''}`} onClick={() => {
                setImOpen(false);
                setAgentsOpen(false);
                if (expanded) setExpandedProject(null);
                else { setExpandedProject(path); setPane(activePane, projectSessions[0]?.id || null, path); }
              }} title={path} aria-expanded={expanded}>
                <span className="project-folder" /><span className="project-name">{projectLabel(path, projects)}</span><span className="project-count">{projectSessions.length}</span>
              </button>
              <button className="project-new" onClick={() => newConversation(path)} aria-label={`在 ${projectLabel(path, projects)} 中新建对话`} title="新建对话"><ActionIcon type="edit" /></button>
              <button className="sidebar-delete" onClick={() => void deleteProject(path)} aria-label={`删除项目 ${projectLabel(path, projects)}`} title="删除项目"><ActionIcon type="delete" /></button>
            </div>
            {expanded && <div className="project-conversations">
              {projectSessions.length ? projectSessions.map(session => {
                const openIndex = panes.slice(0, paneCount).findIndex(pane => pane.sessionId === session.id);
                const feishuIcon = feishuApps.find(app => app.id === session.feishuAppId)?.icon;
                return <div className="conversation-row" key={session.id}><button className={`conversation-item ${activeSessionId === session.id ? 'selected' : ''}`} onClick={() => openConversation(session)} title={session.prompt}>
                  <span className={`status-dot ${session.status}`} />{session.dingtalkAppId && <AppIcon className="conversation-app-icon" fallbackClassName="feishu-app-mark" src={`/api/dingtalk/apps/${session.dingtalkAppId}/icon`} platform="钉钉" />}{session.feishuAppId && <AppIcon className="conversation-app-icon" fallbackClassName="feishu-app-mark" src={feishuIcon} platform="飞书" />}<span className="conversation-text"><strong>{session.prompt}</strong><small>{agentName(session.agent)} · {time(session.createdAt)}</small></span>{paneCount > 1 && openIndex >= 0 && <span className="pane-marker" aria-label={`窗口 ${openIndex + 1}`}>{openIndex + 1}</span>}
                </button><button className="sidebar-delete conversation-delete" onClick={() => void deleteSession(session)} aria-label={`删除对话 ${session.prompt}`} title="删除对话"><ActionIcon type="delete" /></button></div>;
              }) : <p className="project-empty">还没有对话</p>}
            </div>}
          </div>;
        })}
        {!projects.length && <p className="project-empty">暂无项目。点击右侧加号选择本地目录。</p>}
      </nav>

    </aside>

    <main className="main-area">
      <header className="topbar">
        <div className="topbar-left"><button className="menu-toggle" aria-label={mobileMenuOpen ? '关闭菜单' : '打开菜单'} aria-expanded={mobileMenuOpen} aria-controls="project-menu" onClick={() => setMobileMenuOpen(open => !open)}><span /><span /><span /></button></div>
      </header>
      <div className="content chat-content">
        {error && <div className="global-error" role="alert"><span>{error}</span><button onClick={() => setError('')}>关闭</button></div>}
        <div className={`workspace-grid ${layout}`} style={{ display: imOpen || agentsOpen ? 'none' : undefined }}>
          {panes.slice(0, paneCount).map((pane, index) => <ChatPane key={`${index}-${pane.revision}`} index={index} pane={pane} multi={paneCount > 1} active={activePane === index} agents={agents} projects={projects} sessions={sessions} feishuApps={feishuApps} onFocus={setActivePane} onProjectChange={(position, path) => { setPanes(current => current.map((item, i) => i === position ? { ...item, cwd: path } : item)); setExpandedProject(path); }} onSessionCreated={sessionCreated} onSessionUpdate={updateSession} />)}
        </div>
        <div hidden={!agentsOpen}><AgentPanel active={agentsOpen} onChange={setAgents} /></div>
        <div hidden={!imOpen}><ImPrototype projects={projects} agents={agents} projectLabel={path => projectLabel(path, projects)} /></div>
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
