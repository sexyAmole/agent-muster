import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Select } from './select';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ImPrototype, type Application } from './im-prototype';
import { AppIcon } from './app-icon';
import { AgentIcon } from './agent-icon';
import { AgentPanel } from './agent-panel';
import { MessageProvider, useErrorMessage } from './message';
import { MessageImages } from './message-images';
import { FileMentionTextarea } from './file-mention-textarea';
import { RunLog } from './run-log';
import { StreamText } from './stream-text';
import { mergeSessionEvents } from '../../src/sessions/events';
import type { AgentInfo as Agent, AgentImage, AgentSession as Session, SessionEvent as Event, SessionStatus as Status, ImBinding } from '../../src/types';
import './style.css';

type FeishuApp = Pick<Application, 'id' | 'icon'>;
type SessionSummary = Omit<Session, 'events'>;
type SessionPage = { events: Event[]; hasMore: boolean };
type Directory = { path: string };
type Layout = 'single' | 'double' | 'quad';
type PaneState = { sessionId: string | null; cwd: string; revision: number };
type ComposerImage = { file: File; url: string; id?: string };
function LayoutSwitch({ layout, onChange }: { layout: Layout; onChange: (layout: Layout) => void }) {
  return <div className="layout-switch">
    <Select aria-label="窗口布局" title={`窗口布局：${layout === 'single' ? '单窗' : layout === 'double' ? '双栏' : '四宫格'}`} value={layout} onChange={value => onChange(value as Layout)} triggerLabel={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" />{layout !== 'single' && <path d="M12 3v18" />}{layout === 'quad' && <path d="M3 12h18" />}</svg>}>
      <option value="single">单窗</option>
      <option value="double">双栏</option>
      <option value="quad">四宫格</option>
    </Select>
  </div>;
}
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

function conversationItems(session: Session): (Event | Event[])[] {
  const items: (Event | Event[])[] = [];
  for (const event of session.events) {
    if (event.type !== 'thinking' && event.type !== 'message' && event.type !== 'output' && event.type !== 'im_message' && event.type !== 'tool' && event.type !== 'file_change' && !(event.type === 'error' && session.status === 'failed')) continue;
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

type ExecutionRound = { id: number; message?: Event; events: Event[]; end?: Event; active: boolean };

function executionRounds(session: Session): ExecutionRound[] {
  const rounds: ExecutionRound[] = [];
  for (const event of session.events) {
    if (event.type === 'message' || !rounds.length) {
      rounds.push({ id: event.id, ...(event.type === 'message' ? { message: event } : {}), events: [], active: false });
    }
    const round = rounds.at(-1)!;
    if (event.type !== 'message') round.events.push(event);
    if (event.type === 'status' && (event.text === 'completed' || event.text === 'failed' || event.text === 'stopped')) round.end = event;
  }
  const last = rounds.at(-1);
  if (last && !last.end) last.active = session.status === 'starting' || session.status === 'running';
  return rounds;
}

function ExecutionSteps({ round, stepCount, commandCount, children }: { round: ExecutionRound; stepCount: number; commandCount: number; children: React.ReactNode }) {
  const [now, setNow] = useState(Date.now());
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = round.active;
    if (!round.active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [round.active]);
  const seconds = round.message && (round.end || round.active)
    ? Math.max(0, Math.floor(((round.end?.timestamp ?? now) - round.message.timestamp) / 1000)) : undefined;
  const duration = seconds === undefined || seconds === 0 ? '' : seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分${seconds % 60 ? ` ${seconds % 60} 秒` : ''}`;
  const state = round.end && round.end.text !== 'completed' ? statusLabel[round.end.text as Status] : '';
  const summary = <><span>执行过程{stepCount > 0 && ` · ${stepCount} 步`}</span>{commandCount > 0 && <span className="execution-meta">· {commandCount} 个命令</span>}{duration && <span className="execution-meta">· {duration}</span>}{state && <span className="execution-meta">· {state}</span>}<span className="tool-call-chevron" aria-hidden="true" /></>;
  const content = <div className="execution-content">{children}{round.active && <div className="thinking-step" role="status"><span className="thinking-label">思考中…</span></div>}</div>;
  return <details ref={detailsRef} className="execution-steps" open={round.active}><summary>{summary}</summary>{content}</details>;
}

function conversationText(session: Session): string {
  return conversationItems(session).flatMap(item => {
    if (Array.isArray(item) || (item.type !== 'message' && item.type !== 'output' && item.type !== 'im_message')) return [];
    return [`${item.type === 'message' ? '用户' : item.type === 'im_message' ? `应用（已发送到${item.im?.platform === 'feishu' ? '飞书' : '钉钉'}）` : '助手'}：\n${item.text.trim()}`];
  }).join('\n\n');
}

function fileLabel(path: string, cwd: string): string {
  const prefix = cwd.replace(/[\\/]+$/, '');
  return path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}\\`) ? path.slice(prefix.length + 1) : path;
}

type PiToolDetails = {
  args?: { command?: string; path?: string };
  result?: { content?: { type: string; text?: string }[] };
  isError?: boolean;
};

function piToolDetails(detail: string | undefined): PiToolDetails | undefined {
  if (!detail?.startsWith('{')) return undefined;
  try { return JSON.parse(detail) as PiToolDetails; }
  // 已截断的历史记录只展示原文，不提取结构化摘要。
  catch { return undefined; }
}

function ToolCall({ event, accordionName, agent }: { event: Event; accordionName: string; agent: string }) {
  const data = agent === 'pi' ? piToolDetails(event.detail) : undefined;
  const target = data?.args?.command || data?.args?.path;
  const label = target ? `${event.text} ${data?.args?.command ? toolLabel(target) : target}` : toolLabel(event.text);
  const output = data?.result?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n');
  const detail = data ? output : event.detail;
  const lines = output?.trimEnd() ? output.trimEnd().split('\n').length : undefined;
  return <details className="tool-call" name={accordionName}><summary>
    <span className={`tool-call-status${event.streaming ? ' running' : ''}${data?.isError ? ' error' : ''}`} aria-label={event.streaming ? '工具执行中' : data?.isError ? '工具执行失败' : '工具执行记录'} />
    <strong title={target ? `${event.text} ${target}` : label}>{label}</strong>
    {event.streaming && <span className="tool-output-lines">执行中</span>}
    {lines !== undefined && <span className="tool-output-lines">{lines} 行</span>}
    {detail && <span className="tool-call-chevron" />}
  </summary>{detail && <div className="tool-detail-card">{isDiff(detail) ? <Diff text={detail} /> : <pre>{detail}</pre>}</div>}</details>;
}

function ToolTimeline({ events, accordionName, agent }: { events: Event[]; accordionName: string; agent: string }) {
  return <ol className="tool-timeline" aria-label="工具调用时间线">{events.map(event => <li key={event.streamId || event.id}><ToolCall event={event} accordionName={accordionName} agent={agent} /></li>)}</ol>;
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
  sessions: SessionSummary[];
  feishuApps: FeishuApp[];
  onFocus: (index: number) => void;
  onProjectChange: (index: number, path: string) => void;
  onSessionCreated: (index: number, session: SessionSummary) => void;
  onSessionUpdate: (session: Pick<Session, 'id' | 'status' | 'updatedAt'> & Partial<Pick<Session, 'externalSessionId'>>) => void;
};

function ChatPane({ index, pane, multi, active: focused, agents, projects, sessions, feishuApps, onFocus, onProjectChange, onSessionCreated, onSessionUpdate, layoutControls }: PaneProps & { layoutControls?: React.ReactNode }) {
  const selectedId = pane.sessionId;
  const [selected, setSelected] = useState<Session | null>(() => {
    const summary = sessions.find(session => session.id === selectedId);
    return summary ? { ...summary, events: [] } : null;
  });
  const [agent, setAgent] = useState(agents.find(item => item.installed)?.id || '');
  const [permissionMode, setPermissionMode] = useState(sessions.find(session => session.id === selectedId)?.permissionMode || 'full-auto');
  const [model, setModel] = useState(sessions.find(session => session.id === selectedId)?.model || '');
  const [message, setMessage] = useState('');
  const [images, setImages] = useState<ComposerImage[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageUrls = useRef(new Set<string>());
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const historyController = useRef<AbortController | null>(null);
  const historyScroll = useRef<{ height: number; top: number } | null>(null);
  const [pushingId, setPushingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useErrorMessage(error, setError);
  const [copiedTarget, setCopiedTarget] = useState<'conversation' | 'run-log' | number | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const runningSessionRef = useRef<string | null>(null);
  const followConversation = useRef(true);

  useEffect(() => () => {
    for (const url of imageUrls.current) URL.revokeObjectURL(url);
    imageUrls.current.clear();
  }, []);

  useEffect(() => {
    if (!agents.some(item => item.id === agent && item.installed)) setAgent(agents.find(item => item.installed)?.id || '');
  }, [agents, agent]);

  useEffect(() => { setModel(selected?.model || ''); }, [selected?.id, selected?.model]);
  useEffect(() => { setPermissionMode(selected?.permissionMode || 'full-auto'); }, [selected?.id, selected?.agent, selected?.permissionMode, agent]);

  useEffect(() => {
    if (!selectedId) { setSelected(null); return; }
    let current = true;
    let source: EventSource | undefined;
    setHasMoreHistory(false);
    Promise.all([api<SessionSummary>(`/api/sessions/${selectedId}`), api<SessionPage>(`/api/sessions/${selectedId}/messages?limit=10`)]).then(([metadata, { hasMore, events }]) => {
      const session = { ...metadata, events };
      if (!current) return;
      setSelected(session);
      setHasMoreHistory(hasMore);
      onSessionUpdate(session);
      source = new EventSource(`/api/sessions/${selectedId}/events?after=${Math.max(0, ...session.events.map(event => event.id))}`);
      source.onmessage = messageEvent => {
        const event = JSON.parse(messageEvent.data) as Event;
        setSelected(previous => {
          if (!previous || previous.id !== selectedId) return previous;
          if (event.clearStreamIds) previous = { ...previous, events: previous.events.filter(item => !item.streaming || !event.clearStreamIds!.includes(item.streamId!)) };
          if (event.streamId) {
            return { ...previous, updatedAt: Math.max(previous.updatedAt, event.timestamp), events: mergeSessionEvents([...previous.events, event]) };
          }
          if (previous.events.some(item => item.id === event.id)) {
            return event.pushedToIm ? { ...previous, events: previous.events.map(item => item.id === event.id ? { ...item, pushedToIm: true } : item) } : previous;
          }
          if (!event.streaming && event.id <= Math.max(0, ...previous.events.map(item => item.id))) return previous;
          const updated = { ...previous, ...(event.im ? { im: previous.im?.map(binding => binding.platform === event.im?.platform ? { ...binding, ...event.im } as ImBinding : binding) } : {}), status: event.type === 'status' ? event.text as Status : previous.status, usage: event.type === 'usage' ? JSON.parse(event.text) as Session['usage'] : previous.usage, updatedAt: event.timestamp, events: previous.agent === 'pi' ? mergeSessionEvents([...previous.events, event]) : [...previous.events, event] };
          return updated;
        });
        if (event.type === 'status') {
          onSessionUpdate({ id: selectedId, status: event.text as Status, updatedAt: event.timestamp });
          api<SessionSummary>(`/api/sessions/${selectedId}`).then(latest => {
            if (!current) return;
            setSelected(previous => {
              if (!previous || previous.id !== selectedId) return previous;
              return previous.updatedAt > latest.updatedAt
                ? { ...previous, externalSessionId: latest.externalSessionId }
                : { ...previous, ...latest };
            });
            onSessionUpdate(latest);
          }).catch(reason => { if (current) setError((reason as Error).message); });
        }
      };
    }).catch(reason => { if (current) setError((reason as Error).message); });
    return () => { current = false; source?.close(); historyController.current?.abort(); };
  }, [selectedId]);

  useEffect(() => {
    followConversation.current = true;
    if (conversationRef.current) conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
  }, [selected?.id]);

  useLayoutEffect(() => {
    const scroll = historyScroll.current;
    const element = conversationRef.current;
    if (!scroll || !element) return;
    element.scrollTop = scroll.top + element.scrollHeight - scroll.height;
    historyScroll.current = null;
  }, [selected?.events, hasMoreHistory]);

  useEffect(() => {
    if (followConversation.current && conversationRef.current) conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
  }, [selected?.events]);

  useEffect(() => {
    if (copiedTarget === null) return;
    const timer = window.setTimeout(() => setCopiedTarget(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedTarget]);

  const copyText = useCallback(async (text: string, target: 'conversation' | 'run-log' | number) => {
    setError('');
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTarget(target);
    } catch (reason) { setError(`复制失败：${(reason as Error).message}`); }
  }, []);

  const loadHistory = useCallback(async () => {
    const before = selected?.events[0]?.id;
    if (!selected || before === undefined || !hasMoreHistory || historyController.current) return;
    const controller = new AbortController();
    historyController.current = controller;
    setLoadingHistory(true);
    try {
      const page = await api<SessionPage>(`/api/sessions/${selected.id}/messages?limit=10&before=${before}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const element = conversationRef.current;
      if (element) historyScroll.current = { height: element.scrollHeight, top: element.scrollTop };
      followConversation.current = false;
      setSelected(current => current?.id === selected.id
        ? { ...current, events: current.agent === 'pi' ? mergeSessionEvents([...page.events, ...current.events]) : [...page.events.filter(event => !current.events.some(item => item.id === event.id)), ...current.events] }
        : current);
      setHasMoreHistory(page.hasMore);
    } catch (reason) {
      if (!controller.signal.aborted) setError((reason as Error).message);
    } finally {
      historyController.current = null;
      if (!controller.signal.aborted) setLoadingHistory(false);
    }
  }, [selected, hasMoreHistory]);

  async function copyConversation() {
    if (!selected) return;
    try {
      const { events } = await api<SessionPage>(`/api/sessions/${selected.id}/messages`);
      await copyText(conversationText({ ...selected, events }), 'conversation');
    } catch (reason) { setError(`复制失败：${(reason as Error).message}`); }
  }

  function addImages(files: File[]) {
    if (busy || composerDisabled) return;
    if (!supportsImages) { setError('当前 Agent 接入不支持图片附件'); return; }
    if (files.some(file => !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type))) {
      setError('仅支持 PNG、JPEG、GIF 和 WebP 图片'); return;
    }
    if (files.some(file => file.size > 10 * 1024 * 1024)) { setError('单张图片不能超过 10 MB'); return; }
    const added = files.map(file => {
      const url = URL.createObjectURL(file);
      imageUrls.current.add(url);
      return { file, url };
    });
    setImages(current => [...current, ...added]);
    setError('');
  }

  function removeImage(url: string) {
    URL.revokeObjectURL(url);
    imageUrls.current.delete(url);
    setImages(current => current.filter(image => image.url !== url));
  }

  async function send() {
    const content = message.trim() || '请查看这张图片。';
    if (!canSend) return;
    setError(''); setBusy(true);
    try {
      const uploaded = await Promise.all(images.map(async image => {
        const { id } = image.id ? { id: image.id } : await api<{ id: string }>('/api/images', { method: 'POST', headers: { 'Content-Type': image.file.type }, body: image.file });
        return { ...image, id };
      }));
      setImages(uploaded);
      const imageIds = uploaded.map(image => image.id);
      if (selected) {
        const session = await api<SessionSummary>(`/api/sessions/${selected.id}/messages`, { method: 'POST', body: JSON.stringify({ content, model, imageIds, permissionMode }) });
        onSessionUpdate(session);
        setSelected(current => current?.id === session.id ? { ...current, ...session } : current);
      } else {
        const session = await api<SessionSummary>('/api/sessions', { method: 'POST', body: JSON.stringify({ agent, cwd: pane.cwd, prompt: content, model, imageIds, permissionMode }) });
        onSessionCreated(index, session);
      }
      setMessage('');
      setImages([]);
      for (const url of imageUrls.current) URL.revokeObjectURL(url);
      imageUrls.current.clear();
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  async function pushToIm(event: Event) {
    if (!selected || !selected.im?.length || event.type !== 'output' || !event.text.trim() || pushingId !== null || event.pushedToIm) return;
    setError(''); setPushingId(event.id);
    try {
      const session = await api<SessionSummary>(`/api/sessions/${selected.id}/${selected.im.some(binding => binding.platform === 'feishu') ? 'feishu' : 'dingtalk'}/messages`, { method: 'POST', body: JSON.stringify({ eventId: event.id }) });
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
  const dingtalkBinding = selected?.im?.find(binding => binding.platform === 'dingtalk');
  const feishuBinding = selected?.im?.find(binding => binding.platform === 'feishu');
  const imPlatform = feishuBinding ? '飞书' : '钉钉';
  const composerProject = selected?.cwd || (projects.includes(pane.cwd) ? pane.cwd : '');
  const composerAgent = selected?.agent || agent;
  const agentInfo = agents.find(item => item.id === composerAgent);
  const models = agentInfo?.models || [];
  const contextWindow = models.find(item => item.id === (model || agentInfo?.defaultModel))?.contextWindow;
  const usedTokens = selected?.usage ? selected.usage.inputTokens + selected.usage.outputTokens : undefined;
  const composerDisabled = Boolean(running || (selected && !selected.externalSessionId));
  const supportsImages = Boolean(agentInfo?.installed && composerAgent !== 'kimi' && composerAgent !== 'cursor');
  const canSend = Boolean((message.trim() || images.length) && (!images.length || supportsImages) && !busy && !composerDisabled && agentInfo?.installed && (selected ? selected.externalSessionId : composerProject && agent));
  const agentName = (id: string) => agents.find(item => item.id === id)?.name || id;
  const feishuIcon = feishuApps.find(app => app.id === feishuBinding?.appId)?.icon;

  useEffect(() => {
    if (running) {
      runningSessionRef.current = selected?.id || null;
      return;
    }
    if (runningSessionRef.current !== selected?.id || selectedId !== selected?.id) {
      runningSessionRef.current = null;
      return;
    }
    if (busy || composerDisabled) return;
    runningSessionRef.current = null;
    const textarea = composerRef.current?.querySelector('textarea');
    if (focused && textarea?.getClientRects().length) textarea.focus({ preventScroll: true });
  }, [running, selected?.id, selectedId, busy, composerDisabled, focused]);

  const followStream = useCallback(() => {
    if (followConversation.current && conversationRef.current) conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
  }, []);

  const conversation = useMemo(() => {
    if (!selected) return null;
    const renderItem = (item: Event | Event[], showActions = false) => selected && (Array.isArray(item)
              ? <ToolTimeline key={item[0].streamId || item[0].id} events={item} accordionName={`tools-${index}-${selected.id}-${item[0].streamId || item[0].id}`} agent={selected.agent} />
              : item.type === 'thinking'
                ? <details key={item.streamId || item.id} className="thinking-step"><summary className="thinking-label"><span>{item.streaming ? '思考中…' : '思考内容'}<span> · {Array.from(item.text).length} 字</span></span><span className="tool-call-chevron" aria-hidden="true" /></summary><div className="thinking-content"><StreamText text={item.text} streaming={item.streaming} onProgress={followStream} /></div></details>
                : item.type === 'message'
                ? <div key={item.streamId || item.id} className="chat-turn user-turn"><div className="user-bubble">{item.text}{item.images && item.images.length > 0 && <MessageImages key={selected.id} sessionId={selected.id} eventId={item.id} count={item.images.length} />}</div></div>
                : item.type === 'file_change'
                  ? <FileChange key={item.streamId || item.id} event={item} cwd={selected.cwd} />
                : item.type === 'error'
                  ? <div key={item.streamId || item.id} className="chat-notice">{item.text}</div>
                  : <div key={item.streamId || item.id} className="chat-turn assistant-turn">{item.type === 'im_message' && <div className="dingtalk-sent-label">应用 · 已发送到{item.im?.platform === 'feishu' ? '飞书' : '钉钉'}</div>}<div className="assistant-copy">{item.type === 'im_message' ? <div className="dingtalk-sent-content">{item.text}</div> : <StreamText text={item.text} streaming={item.streaming} onProgress={followStream}>{text => <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>}</StreamText>}</div>{showActions && <div className="reply-actions"><button className="reply-copy" aria-label={copiedTarget === item.id ? '已复制这条回复' : '复制这条回复'} onClick={() => void copyText(item.text, item.id)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{copiedTarget === item.id ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" /></>}</svg></button>{item.type === 'output' && Boolean(selected.im?.length) && item.text.trim() && <button className="reply-push" disabled={pushingId !== null || item.pushedToIm} onClick={() => void pushToIm(item)}>{pushingId === item.id ? '推送中…' : item.pushedToIm ? '已推送' : `推送给${imPlatform}`}</button>}</div>}</div>);

    return executionRounds(selected).map(round => {
      const items = conversationItems({ ...selected, events: round.events, status: round.end ? round.end.text as Status : selected.status });
      const finalOutput = round.end ? [...round.events].reverse().find(event => event.type === 'output') : undefined;
      const steps = items.filter(item => Array.isArray(item) || (item !== finalOutput && item.type !== 'im_message' && item.type !== 'error'));
      const stepEvents = steps.flatMap(item => Array.isArray(item) ? item : [item]);
      const results = items.filter(item => !Array.isArray(item) && (item === finalOutput || item.type === 'im_message' || item.type === 'error'));
      return <React.Fragment key={round.id}>
        {round.message && renderItem(round.message)}
        <div className="execution-response">
          <ExecutionSteps round={round} stepCount={stepEvents.length} commandCount={stepEvents.filter(event => event.type === 'tool').length}>{steps.map(item => renderItem(item, !Array.isArray(item) && !item.streaming && item === finalOutput))}</ExecutionSteps>
          {results.map(item => renderItem(item, !Array.isArray(item) && !item.streaming && item === finalOutput))}
        </div>
      </React.Fragment>;
    });
  }, [selected, index, agents, copiedTarget, pushingId, onSessionUpdate, followStream]);

  return <div className={`pane-wrap ${focused && multi ? 'focused' : ''}`} onPointerDown={() => { if (!focused) onFocus(index); }} onFocusCapture={() => { if (!focused) onFocus(index); }}>
    <section className="output-panel" aria-label={`对话窗口 ${index + 1}`}>
      <div className="chat-header">
        {dingtalkBinding && <AppIcon className="chat-app-icon" fallbackClassName="feishu-app-mark" src={`/api/dingtalk/apps/${dingtalkBinding.appId}/icon`} platform="钉钉" />}
        {feishuBinding && <AppIcon className="chat-app-icon" fallbackClassName="feishu-app-mark" src={feishuIcon} platform="飞书" />}
        <div className="chat-heading">{selected
          ? multi
            ? <><strong title={selected.prompt}>{selected.prompt}</strong><p>{projectLabel(selected.cwd, projects)} · {agentName(selected.agent)} · {statusLabel[selected.status]}</p></>
            : <p>{agentName(selected.agent)} · {statusLabel[selected.status]}</p>
          : <><strong>新对话</strong>{multi && <p>窗口 {index + 1} · 从侧边栏选择对话</p>}</>}{dingtalkBinding?.conversation && <p className="chat-source">{dingtalkBinding.conversation.type === 'group' ? '群聊' : '单聊'}{dingtalkBinding.conversation.type === 'group' && dingtalkBinding.conversation.groupName && ` · 群名称：${dingtalkBinding.conversation.groupName}`} · 提问人：<span title={dingtalkBinding.conversation.senderStaffId}>{dingtalkBinding.conversation.senderName}</span></p>}{feishuBinding?.conversation && <p className="chat-source">飞书 · {feishuBinding.conversation.type === 'group' ? '群聊' : '单聊'} · 提问人：{feishuBinding.conversation.senderId}</p>}</div>
        <div className="output-actions">
          {selected && <button className="copy-button" onClick={() => void copyConversation()} aria-label={copiedTarget === 'conversation' ? '已复制对话' : '复制对话'} title={copiedTarget === 'conversation' ? '已复制对话' : '复制对话'}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{copiedTarget === 'conversation' ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" /></>}</svg></button>}
          {selected && <RunLog key={selected.id} sessionId={selected.id} copied={copiedTarget === 'run-log'} onCopy={copyText} />}
          {layoutControls && <div className="pane-layout-switch">{layoutControls}</div>}
        </div>
      </div>
      <div className="conversation-scroll" key={selected?.id} ref={conversationRef} role="log" aria-label={`窗口 ${index + 1} 对话记录`} onScroll={event => {
        const element = event.currentTarget;
        followConversation.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        if (element.scrollTop <= 1) void loadHistory();
      }}>
        {selected ? <div className="chat-thread">
          {hasMoreHistory && <button className="history-load" disabled={loadingHistory} onClick={() => void loadHistory()}>{loadingHistory ? '加载中…' : '加载更早消息'}</button>}
          {conversation}
        </div> : <div className="chat-empty"><strong>描述你想完成的任务</strong></div>}
      </div>
      <div className="chat-compose-wrap">
        {!selected && <div className="composer-project-row">
          <span className="project-select">
            <Select aria-label={`窗口 ${index + 1} 选择项目`} value={composerProject} renderIcon={() => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8V6a2 2 0 0 1 2-2h5l2 4h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" /><path d="M3 8h9" /></svg>} disabled={busy} onChange={value => onProjectChange(index, value)}>
              {!composerProject && <option value="">选择项目</option>}
              {projects.map(path => <option key={path} value={path}>{projectLabel(path, projects)}</option>)}
            </Select>
          </span>
          <span className="agent-select"><Select aria-label={`窗口 ${index + 1} 选择 Agent`} value={composerAgent} renderIcon={value => value ? <AgentIcon agent={value} /> : null} disabled={busy} onChange={value => { setAgent(value); setModel(''); }}>{!composerAgent && <option value="">选择 Agent</option>}{agents.map(item => <option key={item.id} value={item.id} disabled={!item.installed}>{item.name}{item.installed ? '' : '（未安装）'}</option>)}</Select></span>
        </div>}
        <div className="chat-composer" ref={composerRef}>
          {images.length > 0 && <div className="composer-images" aria-label="待发送图片" aria-busy={busy}>{images.map(image => <div key={image.url} className="composer-image"><a href={image.url} target="_blank" rel="noreferrer" aria-label={`预览图片 ${image.file.name}`}><img src={image.url} alt={image.file.name} /></a><button type="button" aria-label={`移除图片 ${image.file.name}`} disabled={busy} onClick={() => removeImage(image.url)}>×</button></div>)}</div>}
          <FileMentionTextarea project={composerProject} aria-label={`窗口 ${index + 1} 消息`} value={message} onChange={setMessage} onPaste={event => { const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); addImages(files); } }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={running ? '等待 Agent 完成当前任务…' : selected ? '继续输入任务要求，@ 搜索文件' : '描述要完成的任务，@ 搜索文件'} disabled={busy || composerDisabled} rows={2} />
          <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden aria-label={`窗口 ${index + 1} 选择图片`} onChange={event => { addImages(Array.from(event.target.files || [])); event.target.value = ''; }} />
          <div className="composer-footer"><div className="composer-actions"><button type="button" className="composer-attach" aria-label={`窗口 ${index + 1} 添加图片`} title={supportsImages ? '添加图片，也可粘贴截图' : '当前 Agent 接入不支持图片附件'} disabled={busy || composerDisabled || !supportsImages} onClick={() => imageInputRef.current?.click()}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m21 16-5-5L5 21" /></svg></button>{busy && images.length > 0 && <span className="composer-upload-status" role="status">发送图片中…</span>}<label className="model-select"><Select aria-label={`窗口 ${index + 1} 选择模型`} value={model} disabled={!composerAgent || busy || Boolean(running)} onChange={value => setModel(value)}><option value="">{agentInfo?.defaultModel ? `默认 · ${agentInfo.defaultModel}` : 'Agent 默认'}</option>{model && !models.some(item => item.id === model) && <option value={model} disabled={composerAgent === 'codex' && model === 'gpt-6.1-sol'}>{model}</option>}{models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>{agentInfo && <label className="permission-select"><Select aria-label={`窗口 ${index + 1} 权限模式`} title={agentInfo.permissionModes.find(item => item.id === permissionMode)?.description} value={permissionMode} disabled={busy || composerDisabled || !agentInfo.installed} onChange={setPermissionMode}>{agentInfo.permissionModes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>}</div><button className="composer-send" aria-label={running ? '停止生成' : selected ? '发送消息' : '创建对话并发送'} disabled={running ? busy : !canSend} onClick={running ? stop : send}>{running ? <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect width="12" height="12" rx="1" /></svg> : '↑'}</button></div>
        </div>
        {selected && <div className="context-status" title={selected.usage ? `累计输入 ${selected.usage.inputTokens.toLocaleString()} Token，累计输出 ${selected.usage.outputTokens.toLocaleString()} Token` : 'Agent 尚未返回 Token 用量'}>{usedTokens === undefined && !contextWindow ? '上下文数据未提供' : `累计消耗 ${usedTokens === undefined ? '暂无用量' : `${tokenCount(usedTokens)} Token`} · 单次窗口 ${contextWindow ? `${tokenCount(contextWindow)} Token` : '未提供'}`}</div>}
      </div>
    </section>
  </div>;
}

function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [feishuApps, setFeishuApps] = useState<Application[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [panes, setPanes] = useState<PaneState[]>(Array.from({ length: 4 }, () => ({ sessionId: null, cwd: '', revision: 0 })));
  const [activePane, setActivePane] = useState(0);
  const [layout, setLayout] = useState<Layout>('single');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  useErrorMessage(error, setError);
  const [imOpen, setImOpen] = useState(() => new URLSearchParams(window.location.search).get('im-view') === 'robots');
  const [agentsOpen, setAgentsOpen] = useState(false);
  const paneCount = layout === 'single' ? 1 : layout === 'double' ? 2 : 4;
  const currentPane = panes[activePane];

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let pending = true;
    const options = { signal: controller.signal };

    function schedule() {
      if (!controller.signal.aborted && !document.hidden) timer = window.setTimeout(refresh, 5000);
    }

    async function refresh() {
      if (pending || controller.signal.aborted || document.hidden) return;
      pending = true;
      try {
        const history = await api<SessionSummary[]>('/api/sessions', options);
        if (!controller.signal.aborted) setSessions(current => JSON.stringify(current) === JSON.stringify(history) ? current : history);
      } catch (reason) {
        if (!controller.signal.aborted) setError((reason as Error).message);
      } finally {
        pending = false;
        schedule();
      }
    }

    function visibilityChanged() {
      window.clearTimeout(timer);
      if (!document.hidden) void refresh();
    }

    Promise.all([api<Agent[]>('/api/agents', options), api<SessionSummary[]>('/api/sessions', options), api<string[]>('/api/projects', options), api<Directory>('/api/directories', options), api<Application[]>('/api/feishu/apps', options)])
      .then(([available, history, savedProjects, directory, apps]) => {
        if (controller.signal.aborted) return;
        const paths = [...new Set([...savedProjects, ...history.map(session => session.cwd)])];
        const firstProject = history[0]?.cwd || savedProjects[0] || directory.path;
        setAgents(available); setSessions(history); setProjects(paths); setExpandedProject(firstProject);
        setFeishuApps(apps);
        setPanes(current => current.map((pane, index) => index === 0 ? { sessionId: history[0]?.id || null, cwd: firstProject, revision: pane.revision + 1 } : pane));
      }).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message); })
      .finally(() => { pending = false; schedule(); });
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
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

  function openConversation(session: SessionSummary) {
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

  async function deleteSession(session: SessionSummary) {
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

  const updateSession = useCallback((session: Pick<Session, 'id' | 'status' | 'updatedAt'> & Partial<Pick<Session, 'externalSessionId'>>) => {
    setSessions(current => current.map(item => item.id === session.id ? { ...item, status: session.status, updatedAt: session.updatedAt, externalSessionId: session.externalSessionId ?? item.externalSessionId } : item));
  }, []);

  function sessionCreated(index: number, session: SessionSummary) {
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
              <button className="project-item" onClick={() => {
                setImOpen(false);
                setAgentsOpen(false);
                if (expanded) setExpandedProject(null);
                else setExpandedProject(path);
              }} title={path} aria-expanded={expanded}>
                <span className="project-folder" /><span className="project-name">{projectLabel(path, projects)}</span><span className="project-count">{projectSessions.length}</span>
              </button>
              <button className="project-new" onClick={() => newConversation(path)} aria-label={`在 ${projectLabel(path, projects)} 中新建对话`} title="新建对话"><ActionIcon type="edit" /></button>
              <button className="sidebar-delete" onClick={() => void deleteProject(path)} aria-label={`删除项目 ${projectLabel(path, projects)}`} title="删除项目"><ActionIcon type="delete" /></button>
            </div>
            {expanded && <div className="project-conversations">
              {projectSessions.length ? projectSessions.map(session => {
                const openIndex = panes.slice(0, paneCount).findIndex(pane => pane.sessionId === session.id);
                const dingtalkBinding = session.im?.find(binding => binding.platform === 'dingtalk');
                const feishuBinding = session.im?.find(binding => binding.platform === 'feishu');
                const feishuIcon = feishuApps.find(app => app.id === feishuBinding?.appId)?.icon;
                return <div className="conversation-row" key={session.id}><button className={`conversation-item ${activeSessionId === session.id ? 'selected' : ''}`} onClick={() => openConversation(session)} title={session.prompt}>
                  <span className="conversation-icon">{dingtalkBinding && <AppIcon className="conversation-app-icon" fallbackClassName="feishu-app-mark" src={`/api/dingtalk/apps/${dingtalkBinding.appId}/icon`} platform="钉钉" />}{feishuBinding && <AppIcon className="conversation-app-icon" fallbackClassName="feishu-app-mark" src={feishuIcon} platform="飞书" />}<AgentIcon agent={session.agent} className={dingtalkBinding || feishuBinding ? 'conversation-agent-badge' : undefined} /></span><span className="conversation-text"><strong>{session.prompt}</strong><small>{agentName(session.agent)} · {time(session.createdAt)}</small></span>{(session.status === 'starting' || session.status === 'running') && <span className="conversation-loading" role="status" aria-label={statusLabel[session.status]} />}{paneCount > 1 && openIndex >= 0 && <span className="pane-marker" aria-label={`窗口 ${openIndex + 1}`}>{openIndex + 1}</span>}
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
        {!imOpen && !agentsOpen && <LayoutSwitch layout={layout} onChange={changeLayout} />}
      </header>
      <div className="content chat-content">
        <div className={`workspace-grid ${layout}`} style={{ display: imOpen || agentsOpen ? 'none' : undefined }}>
          {panes.slice(0, paneCount).map((pane, index) => <ChatPane key={`${index}-${pane.revision}`} index={index} pane={pane} multi={paneCount > 1} active={activePane === index} agents={agents} projects={projects} sessions={sessions} feishuApps={feishuApps} onFocus={setActivePane} onProjectChange={(position, path) => { setPanes(current => current.map((item, i) => i === position ? { ...item, cwd: path } : item)); setExpandedProject(path); }} onSessionCreated={sessionCreated} onSessionUpdate={updateSession} layoutControls={index === (paneCount === 1 ? 0 : 1) ? <LayoutSwitch layout={layout} onChange={changeLayout} /> : undefined} />)}
        </div>
        <div hidden={!agentsOpen}><AgentPanel active={agentsOpen} onChange={setAgents} /></div>
        <div hidden={!imOpen}><ImPrototype active={imOpen} feishuApps={feishuApps} onFeishuAppsChange={setFeishuApps} projects={projects} agents={agents} projectLabel={path => projectLabel(path, projects)} /></div>
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<MessageProvider><App /></MessageProvider>);
