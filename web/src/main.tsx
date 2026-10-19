import React, { createContext, lazy, Suspense, useContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Select } from './select';
import { DateRangePicker, localDate, type DateRange } from './date-range-picker';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ImPrototype, type Application } from './im-prototype';
import { AppIcon } from './app-icon';
import { AgentIcon } from './agent-icon';
import { AgentPanel } from './agent-panel';
import { DesktopWindowControls } from './desktop-window-controls';
import { MessageProvider, useErrorMessage } from './message';
import { MessageImages } from './message-images';
import { FileMentionTextarea } from './file-mention-textarea';
import { RunLog } from './run-log';
import { StreamText } from './stream-text';
import { mergeSessionEvents } from '../../src/sessions/events';
import type { AgentInfo as Agent, AgentImage, AgentSession as Session, SessionEvent as Event, SessionStatus as Status, ImBinding } from '../../src/types';
import './style.css';

const FilePanel = lazy(() => import('./file-panel').then(module => ({ default: module.FilePanel })));

type FeishuApp = Pick<Application, 'id' | 'icon'>;
type SessionSummary = Omit<Session, 'events'>;
const lastSessionKey = 'agent-muster:last-session';
type SessionPage = { events: Event[]; hasMore: boolean };
type Directory = { path: string };
type Layout = 'single' | 'double' | 'quad';
type PaneState = { sessionId: string | null; cwd: string; revision: number };
type ComposerImage = { file: File; url: string; id?: string };
function LayoutSwitch({ layout, onChange }: { layout: Layout; onChange: (layout: Layout) => void }) {
  return <div className="layout-switch">
    <Select aria-label="窗口布局" value={layout} onChange={value => onChange(value as Layout)} triggerLabel={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" />{layout !== 'single' && <path d="M12 3v18" />}{layout === 'quad' && <path d="M3 12h18" />}</svg>}>
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

function ProjectFolderIcon({ open }: { open: boolean }) {
  return <svg className="project-folder" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-state={open ? 'open' : 'closed'}>
    {open ? <><path d="M3 10V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2" /><path d="M3 10h19l-3 10H6L3 10Z" /></> : <path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z" />}
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

const ProjectNamesContext = createContext<Record<string, string>>({});

function projectLabel(path: string, projects: string[], names: Record<string, string>): string {
  if (names[path]) return names[path];
  const name = shortPath(path);
  return projects.filter(project => shortPath(project) === name).length > 1
    ? path.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
    : name;
}

function time(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value);
}

function shortDate(date: Date): string {
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const sameMonth = sameYear && date.getMonth() === now.getMonth();
  const sameDay = sameMonth && date.getDate() === now.getDate();
  return `${sameYear ? '' : `${date.getFullYear()}年`}${sameMonth ? '' : `${date.getMonth() + 1}月`}${sameDay ? '' : `${date.getDate()}日`}`;
}

function MessageDate({ timestamp }: { timestamp: number }) {
  const date = new Date(timestamp);
  const prefix = shortDate(date);
  const clock = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return <time className="message-date" dateTime={date.toISOString()} aria-label={date.toLocaleString('zh-CN', { hour12: false })} tabIndex={0}>{prefix && `${prefix} `}{clock}</time>;
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
    return [`${item.type === 'message' ? '用户' : item.type === 'im_message' ? `应用（已发送到${item.im?.platform === 'feishu' ? '飞书' : item.im?.platform === 'wecom' ? '企业微信' : '钉钉'}）` : '助手'}：\n${item.text.trim()}`];
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
  panelProject: string | null;
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

type ChatHeaderProps = Pick<PaneProps, 'index' | 'multi' | 'agents' | 'projects' | 'feishuApps'> & {
  selected: Session | null;
  copiedTarget: 'conversation' | 'run-log' | number | null;
  copyConversation: () => Promise<void>;
  copyText: (text: string, target: 'conversation' | 'run-log' | number) => Promise<void>;
  layoutControls?: React.ReactNode;
  panelControls?: React.ReactNode;
};

function ChatHeader({ index, multi, agents, projects, feishuApps, selected, copiedTarget, copyConversation, copyText, layoutControls, panelControls }: ChatHeaderProps) {
  const projectNames = useContext(ProjectNamesContext);
  const dingtalkBinding = selected?.im?.find(binding => binding.platform === 'dingtalk');
  const feishuBinding = selected?.im?.find(binding => binding.platform === 'feishu');
  const wecomBinding = selected?.im?.find(binding => binding.platform === 'wecom');
  const agentName = (id: string) => agents.find(item => item.id === id)?.name || id;
  const feishuIcon = feishuApps.find(app => app.id === feishuBinding?.appId)?.icon;

  return <div className="chat-header">
    {dingtalkBinding && <AppIcon className="chat-app-icon" fallbackClassName="feishu-app-mark" src={`/api/dingtalk/apps/${dingtalkBinding.appId}/icon`} platform="钉钉" />}
    {wecomBinding && <AppIcon className="chat-app-icon" fallbackClassName="feishu-app-mark" platform="企业微信" />}
    {feishuBinding && <AppIcon className="chat-app-icon" fallbackClassName="feishu-app-mark" src={feishuIcon} platform="飞书" />}
    <div className="chat-heading">{selected
      ? multi
        ? <><strong title={selected.title ?? selected.prompt}>{selected.title ?? selected.prompt}</strong><p>{projectLabel(selected.cwd, projects, projectNames)} · {agentName(selected.agent)} · {statusLabel[selected.status]}</p></>
        : <p>{agentName(selected.agent)} · {statusLabel[selected.status]}</p>
      : <><strong>新对话</strong>{multi && <p>窗口 {index + 1} · 从侧边栏选择对话</p>}</>}{dingtalkBinding?.conversation && <p className="chat-source">{dingtalkBinding.conversation.type === 'group' ? '群聊' : '单聊'}{dingtalkBinding.conversation.type === 'group' && dingtalkBinding.conversation.groupName && ` · 群名称：${dingtalkBinding.conversation.groupName}`} · 提问人：<span title={dingtalkBinding.conversation.senderStaffId}>{dingtalkBinding.conversation.senderName}</span></p>}{wecomBinding?.conversation && <p className="chat-source">企业微信 · {wecomBinding.conversation.type === 'group' ? '群聊' : '单聊'} · 提问人：{wecomBinding.conversation.senderId}</p>}{feishuBinding?.conversation && <p className="chat-source">飞书 · {feishuBinding.conversation.type === 'group' ? '群聊' : '单聊'} · 提问人：{feishuBinding.conversation.senderId}</p>}</div>
    <div className="output-actions">
      {selected && <button className="copy-button" onClick={() => void copyConversation()} aria-label={copiedTarget === 'conversation' ? '已复制对话' : '复制对话'}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{copiedTarget === 'conversation' ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" /></>}</svg></button>}
      {selected && <RunLog key={selected.id} sessionId={selected.id} copied={copiedTarget === 'run-log'} onCopy={copyText} />}
      {layoutControls && <div className="pane-layout-switch">{layoutControls}</div>}
      {panelControls}
    </div>
  </div>;
}

type ComposerSettingsProps = {
  index: number;
  composerAgent: string;
  agentInfo: Agent | undefined;
  model: string;
  permissionMode: string;
  busy: boolean;
  running: boolean;
  disabled: boolean;
  onModelChange: (model: string) => void;
  onPermissionModeChange: (mode: string) => void;
};

function ComposerSettings({ index, composerAgent, agentInfo, model, permissionMode, busy, running, disabled, onModelChange, onPermissionModeChange }: ComposerSettingsProps) {
  const models = agentInfo?.models || [];
  return <><label className="model-select"><Select aria-label={`窗口 ${index + 1} 选择模型`} value={model} disabled={!composerAgent || busy || running} onChange={onModelChange}><option value="">{agentInfo?.defaultModel ? `默认 · ${agentInfo.defaultModel}` : 'Agent 默认'}</option>{model && !models.some(item => item.id === model) && <option value={model} disabled={composerAgent === 'codex' && model === 'gpt-6.1-sol'}>{model}</option>}{models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>{agentInfo && <label className="permission-select"><Select aria-label={`窗口 ${index + 1} 权限模式`} title={agentInfo.permissionModes.find(item => item.id === permissionMode)?.description} value={permissionMode} disabled={busy || disabled || !agentInfo.installed} onChange={onPermissionModeChange}>{agentInfo.permissionModes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>}</>;
}

function TokenUsageStatus({ usage }: { usage: Session['usage'] }) {
  const usedTokens = usage ? usage.inputTokens + usage.outputTokens : undefined;
  return <div className="token-usage-status">
    <span title={usage ? `累计输入 ${usage.inputTokens.toLocaleString()} Token，累计输出 ${usage.outputTokens.toLocaleString()} Token` : 'Agent 尚未返回 Token 用量'}>累计 {usedTokens === undefined ? '暂无用量' : `${tokenCount(usedTokens)} Token`}</span>
    <span>输入 {usage ? tokenCount(usage.inputTokens) : '—'}</span>
    <span title="缓存命中属于输入的一部分，不会重复计入累计 Token">缓存命中 {usage?.cacheReadTokens === undefined ? '—' : tokenCount(usage.cacheReadTokens)}</span>
    <span>输出 {usage ? tokenCount(usage.outputTokens) : '—'}</span>
  </div>;
}

type ChatComposerProps = Pick<PaneProps, 'index' | 'pane' | 'agents' | 'projects' | 'sessions' | 'onProjectChange' | 'onSessionCreated' | 'onSessionUpdate'> & {
  focused: boolean;
  selected: Session | null;
  setSelected: React.Dispatch<React.SetStateAction<Session | null>>;
  setError: React.Dispatch<React.SetStateAction<string>>;
};

type ComposerStateProps = Pick<ChatComposerProps, 'selected' | 'agents' | 'projects' | 'pane'> & {
  agent: string;
  message: string;
  images: ComposerImage[];
  busy: boolean;
};

function getComposerState({ selected, agents, projects, pane, agent, message, images, busy }: ComposerStateProps) {
  const running = selected?.status === 'running' || selected?.status === 'starting';
  const composerProject = selected?.cwd || (projects.includes(pane.cwd) ? pane.cwd : '');
  const composerAgent = selected?.agent || agent;
  const agentInfo = agents.find(item => item.id === composerAgent);
  const composerDisabled = Boolean(running || (selected && !selected.externalSessionId));
  const supportsImages = Boolean(agentInfo?.installed && composerAgent !== 'kimi' && composerAgent !== 'cursor');
  const canSend = Boolean((message.trim() || images.length) && (!images.length || supportsImages) && !busy && !composerDisabled && agentInfo?.installed && (selected ? selected.externalSessionId : composerProject && agent));

  return { running, composerProject, composerAgent, agentInfo, composerDisabled, supportsImages, canSend };
}

function ChatComposer({ index, pane, agents, projects, sessions, onProjectChange, onSessionCreated, onSessionUpdate, focused, selected, setSelected, setError }: ChatComposerProps) {
  const projectNames = useContext(ProjectNamesContext);
  const selectedId = pane.sessionId;
  const sortedAgents = useMemo(() => {
    const counts = new Map(agents.map(item => [item.id, 0]));
    for (const session of sessions) {
      if (counts.has(session.agent)) counts.set(session.agent, counts.get(session.agent)! + 1);
    }
    return [...agents].sort((a, b) => counts.get(b.id)! - counts.get(a.id)!);
  }, [agents, sessions]);
  const [agent, setAgent] = useState(sortedAgents.find(item => item.installed)?.id || '');
  const [permissionMode, setPermissionMode] = useState(sessions.find(session => session.id === selectedId)?.permissionMode || 'full-auto');
  const [model, setModel] = useState(sessions.find(session => session.id === selectedId)?.model || '');
  const [message, setMessage] = useState('');
  const [images, setImages] = useState<ComposerImage[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageUrls = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const runningSessionRef = useRef<string | null>(null);

  useEffect(() => () => {
    for (const url of imageUrls.current) URL.revokeObjectURL(url);
    imageUrls.current.clear();
  }, []);

  useEffect(() => {
    if (!sortedAgents.some(item => item.id === agent && item.installed)) setAgent(sortedAgents.find(item => item.installed)?.id || '');
  }, [sortedAgents, agent]);

  useEffect(() => { setModel(selected?.model || ''); }, [selected?.id, selected?.model]);
  useEffect(() => { setPermissionMode(selected?.permissionMode || 'full-auto'); }, [selected?.id, selected?.agent, selected?.permissionMode, agent]);

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

  async function stop() {
    if (!selected || busy) return;
    setError(''); setBusy(true);
    try {
      const session = await api<SessionSummary>(`/api/sessions/${selected.id}/stop`, { method: 'POST' });
      onSessionUpdate(session);
      setSelected(current => current?.id === session.id ? { ...current, ...session } : current);
      if (!message && !images.length) {
        const lastMessage = [...selected.events].reverse().find(event => event.type === 'message');
        if (lastMessage) {
          setMessage(lastMessage.text);
          setImages((lastMessage.images || []).map((image, index) => {
            const id = shortPath(image.path);
            return { id, file: new File([], id, { type: image.mimeType }), url: `/api/sessions/${selected.id}/messages/${lastMessage.id}/images/${index}` };
          }));
        }
      }
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  const { running, composerProject, composerAgent, agentInfo, composerDisabled, supportsImages, canSend } = getComposerState({ selected, agents, projects, pane, agent, message, images, busy });

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

  return <div className="chat-compose-wrap">
    {!selected && <div className="composer-project-row">
      <span className="project-select">
        <Select aria-label={`窗口 ${index + 1} 选择项目`} value={composerProject} renderIcon={() => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8V6a2 2 0 0 1 2-2h5l2 4h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" /><path d="M3 8h9" /></svg>} disabled={busy} onChange={value => onProjectChange(index, value)}>
          {!composerProject && <option value="">选择项目</option>}
          {projects.map(path => <option key={path} value={path}>{projectLabel(path, projects, projectNames)}</option>)}
        </Select>
      </span>
      <span className="agent-select"><Select aria-label={`窗口 ${index + 1} 选择 Agent`} value={composerAgent} renderIcon={value => value ? <AgentIcon agent={value} /> : null} disabled={busy} onChange={value => { setAgent(value); setModel(''); }}>{!composerAgent && <option value="">选择 Agent</option>}{sortedAgents.map(item => <option key={item.id} value={item.id} disabled={!item.installed}>{item.name}{item.installed ? '' : '（未安装）'}</option>)}</Select></span>
    </div>}
    <div className="chat-composer" ref={composerRef}>
      {images.length > 0 && <div className="composer-images" aria-label="待发送图片" aria-busy={busy}>{images.map(image => <div key={image.url} className="composer-image"><a href={image.url} target="_blank" rel="noreferrer" aria-label={`预览图片 ${image.file.name}`}><img src={image.url} alt={image.file.name} /></a><button type="button" aria-label={`移除图片 ${image.file.name}`} disabled={busy} onClick={() => removeImage(image.url)}>×</button></div>)}</div>}
      <FileMentionTextarea project={composerProject} aria-label={`窗口 ${index + 1} 消息`} value={message} onChange={setMessage} onPaste={event => { const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); addImages(files); } }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={running ? '等待 Agent 完成当前任务…' : selected ? '继续输入任务要求，@ 搜索文件' : '描述要完成的任务，@ 搜索文件'} disabled={busy || composerDisabled} rows={2} />
      <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden aria-label={`窗口 ${index + 1} 选择图片`} onChange={event => { addImages(Array.from(event.target.files || [])); event.target.value = ''; }} />
      <div className="composer-footer"><div className="composer-actions"><button type="button" className="composer-attach" aria-label={`窗口 ${index + 1} 添加图片`} title={supportsImages ? '添加图片，也可粘贴截图' : '当前 Agent 接入不支持图片附件'} disabled={busy || composerDisabled || !supportsImages} onClick={() => imageInputRef.current?.click()}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m21 16-5-5L5 21" /></svg></button>{busy && images.length > 0 && <span className="composer-upload-status" role="status">发送图片中…</span>}<ComposerSettings index={index} composerAgent={composerAgent} agentInfo={agentInfo} model={model} permissionMode={permissionMode} busy={busy} running={Boolean(running)} disabled={composerDisabled} onModelChange={setModel} onPermissionModeChange={setPermissionMode} /></div><button className="composer-send" aria-label={running ? '停止生成' : selected ? '发送消息' : '创建对话并发送'} disabled={running ? busy : !canSend} onClick={running ? stop : send}>{running ? <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect width="12" height="12" rx="1" /></svg> : '↑'}</button></div>
    </div>
    {selected && <TokenUsageStatus usage={selected.usage} />}
  </div>;
}

type ChatPaneProps = PaneProps & { layoutControls?: React.ReactNode };

function ChatPane(props: ChatPaneProps) {
  const { index, pane, panelProject, multi, active: focused, onFocus } = props;
  const [panelOpen, setPanelOpen] = useState(false);
  const [conversationRatio, setConversationRatio] = useState(0.5);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1100px)').matches);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)');
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    update();
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => { setPanelOpen(false); }, [props.panelProject, props.multi, narrow]);

  const paneRef = useRef<HTMLDivElement>(null);
  const panelDrag = useRef({ x: 0, width: 0 });
  const panelButton = useRef<HTMLButtonElement>(null);
  const project = pane.cwd;
  const canOpenPanel = !multi && !narrow && Boolean(project && project === panelProject);
  const showPanel = canOpenPanel && panelOpen;

  function resizeConversation(width: number) {
    const available = paneRef.current!.clientWidth - 8;
    setConversationRatio(Math.max(300, Math.min(available - 300, width)) / available);
  }

  return <div ref={paneRef} className={`pane-wrap ${focused && multi ? 'focused' : ''}${showPanel ? ' files-open' : ''}`} style={showPanel ? { gridTemplateColumns: `minmax(300px, ${conversationRatio}fr) 8px minmax(300px, ${1 - conversationRatio}fr)` } : undefined} onPointerDown={() => { if (!focused) onFocus(index); }} onFocusCapture={() => { if (!focused) onFocus(index); }}>
    <ChatPaneContent key={props.pane.revision} {...props} panelControls={canOpenPanel && <button ref={panelButton} type="button" className="file-panel-toggle" aria-label={showPanel ? '收起面板' : '展开面板'} aria-expanded={showPanel} onClick={() => setPanelOpen(open => !open)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></svg></button>} />
    {showPanel && <div className="panel-resizer" role="separator" tabIndex={0} aria-label="调整会话与文件面板宽度" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(conversationRatio * 100)} onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      panelDrag.current = { x: event.clientX, width: paneRef.current!.querySelector<HTMLElement>('.output-panel')!.offsetWidth };
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeConversation(panelDrag.current.width + event.clientX - panelDrag.current.x);
    }} onPointerUp={event => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const width = paneRef.current!.querySelector<HTMLElement>('.output-panel')!.offsetWidth;
      resizeConversation(event.key === 'Home' ? 300 : event.key === 'End' ? paneRef.current!.clientWidth - 308 : width + (event.key === 'ArrowLeft' ? -20 : 20));
    }} />}
    {showPanel && <Suspense fallback={<aside className="file-panel" role="status"><p className="file-panel-status">正在加载文件面板…</p></aside>}><FilePanel key={project} project={project} onClose={() => { setPanelOpen(false); panelButton.current?.focus(); }} /></Suspense>}
  </div>;
}

type ConversationItemProps = {
  item: Event | Event[];
  index: number;
  session: Session;
  showActions: boolean;
  copiedTarget: 'conversation' | 'run-log' | number | null;
  pushingId: number | null;
  imPlatform: string;
  copyText: (text: string, target: 'conversation' | 'run-log' | number) => Promise<void>;
  pushToIm: (event: Event) => Promise<void>;
  followStream: () => void;
};

function AssistantReply({ event, session, showActions, copiedTarget, pushingId, imPlatform, copyText, pushToIm, followStream }: Omit<ConversationItemProps, 'item' | 'index'> & { event: Event }) {
  return <div className="chat-turn assistant-turn">{event.type === 'im_message' && <div className="dingtalk-sent-label">应用 · 已发送到{event.im?.platform === 'feishu' ? '飞书' : event.im?.platform === 'wecom' ? '企业微信' : '钉钉'}</div>}<div className="assistant-copy">{event.type === 'im_message' ? <div className="dingtalk-sent-content">{event.text}</div> : <StreamText text={event.text} streaming={event.streaming} onProgress={followStream}>{text => <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>}</StreamText>}</div><div className="reply-actions">{showActions && <button className="reply-copy" aria-label={copiedTarget === event.id ? '已复制这条回复' : '复制这条回复'} onClick={() => void copyText(event.text, event.id)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{copiedTarget === event.id ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" /></>}</svg></button>}<MessageDate timestamp={event.timestamp} />{showActions && event.type === 'output' && Boolean(session.im?.length) && event.text.trim() && <button className="reply-push" disabled={pushingId !== null || event.pushedToIm} onClick={() => void pushToIm(event)}>{pushingId === event.id ? '推送中…' : event.pushedToIm ? '已推送' : `推送给${imPlatform}`}</button>}</div></div>;
}

function ConversationItem({ item, index, ...reply }: ConversationItemProps) {
  const { session, followStream } = reply;
  if (Array.isArray(item)) return <ToolTimeline events={item} accordionName={`tools-${index}-${session.id}-${item[0].streamId || item[0].id}`} agent={session.agent} />;
  switch (item.type) {
    case 'thinking':
      return <details className="thinking-step"><summary className="thinking-label"><span>{item.streaming ? '思考中…' : '思考内容'}<span> · {Array.from(item.text).length} 字</span></span><span className="tool-call-chevron" aria-hidden="true" /></summary><div className="thinking-content"><StreamText text={item.text} streaming={item.streaming} onProgress={followStream} /></div></details>;
    case 'message':
      return <div className="chat-turn user-turn"><div className="user-bubble">{item.text}{item.images && item.images.length > 0 && <MessageImages key={session.id} sessionId={session.id} eventId={item.id} count={item.images.length} />}</div><MessageDate timestamp={item.timestamp} /></div>;
    case 'file_change':
      return <FileChange event={item} cwd={session.cwd} />;
    case 'error':
      return <div className="chat-notice">{item.text}</div>;
    default:
      return <AssistantReply {...reply} event={item} />;
  }
}

function ChatPaneContent({ index, pane, multi, active: focused, agents, projects, sessions, feishuApps, onProjectChange, onSessionCreated, onSessionUpdate, layoutControls, panelControls }: ChatPaneProps & {
  panelControls: React.ReactNode;
}) {
  const selectedId = pane.sessionId;
  const [selected, setSelected] = useState<Session | null>(() => {
    const summary = sessions.find(session => session.id === selectedId);
    return summary ? { ...summary, events: [] } : null;
  });
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const historyController = useRef<AbortController | null>(null);
  const historyScroll = useRef<{ height: number; top: number } | null>(null);
  const [pushingId, setPushingId] = useState<number | null>(null);
  const [error, setError] = useState('');
  useErrorMessage(error, setError);
  const [copiedTarget, setCopiedTarget] = useState<'conversation' | 'run-log' | number | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const followConversation = useRef(true);

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

  async function pushToIm(event: Event) {
    if (!selected || !selected.im?.length || event.type !== 'output' || !event.text.trim() || pushingId !== null || event.pushedToIm) return;
    setError(''); setPushingId(event.id);
    try {
      const session = await api<SessionSummary>(`/api/sessions/${selected.id}/${selected.im.some(binding => binding.platform === 'feishu') ? 'feishu' : selected.im.some(binding => binding.platform === 'wecom') ? 'wecom' : 'dingtalk'}/messages`, { method: 'POST', body: JSON.stringify({ eventId: event.id }) });
      onSessionUpdate(session);
      setSelected(current => current?.id === session.id ? { ...current, events: current.events.map(item => item.id === event.id ? { ...item, pushedToIm: true } : item) } : current);
    } catch (reason) { setError((reason as Error).message); }
    finally { setPushingId(null); }
  }

  const imPlatform = selected?.im?.some(binding => binding.platform === 'feishu') ? '飞书' : selected?.im?.some(binding => binding.platform === 'wecom') ? '企业微信' : '钉钉';

  const followStream = useCallback(() => {
    if (followConversation.current && conversationRef.current) conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
  }, []);

  const conversation = useMemo(() => {
    if (!selected) return null;
    const renderItem = (item: Event | Event[], showActions = false) => {
      const event = Array.isArray(item) ? item[0] : item;
      return <ConversationItem key={event.streamId || event.id} item={item} index={index} session={selected} showActions={showActions} copiedTarget={copiedTarget} pushingId={pushingId} imPlatform={imPlatform} copyText={copyText} pushToIm={pushToIm} followStream={followStream} />;
    };

    let previousDay: string | undefined;
    const renderDatedItem = (item: Event | Event[], showActions = false) => {
      const event = Array.isArray(item) ? item[0] : item;
      const date = new Date(event.timestamp);
      const day = date.toDateString();
      const showDate = day !== previousDay;
      previousDay = day;
      return <React.Fragment key={event.streamId || event.id}>
        {showDate && <div className="date-divider" role="separator" aria-label={date.toLocaleString('zh-CN', { hour12: false })}><time dateTime={date.toISOString()}>{shortDate(date) || '今天'} {date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</time></div>}
        {renderItem(item, showActions)}
      </React.Fragment>;
    };

    return executionRounds(selected).map(round => {
      const items = conversationItems({ ...selected, events: round.events, status: round.end ? round.end.text as Status : selected.status });
      const finalOutput = round.end ? [...round.events].reverse().find(event => event.type === 'output') : undefined;
      const steps = items.filter(item => Array.isArray(item) || (item !== finalOutput && item.type !== 'im_message' && item.type !== 'error'));
      const stepEvents = steps.flatMap(item => Array.isArray(item) ? item : [item]);
      const results = items.filter(item => !Array.isArray(item) && (item === finalOutput || item.type === 'im_message' || item.type === 'error'));
      return <React.Fragment key={round.id}>
        {round.message && renderDatedItem(round.message)}
        <div className="execution-response">
          <ExecutionSteps round={round} stepCount={stepEvents.length} commandCount={stepEvents.filter(event => event.type === 'tool').length}>{steps.map(item => renderItem(item, !Array.isArray(item) && !item.streaming && item === finalOutput))}</ExecutionSteps>
          {results.map(item => renderDatedItem(item, !Array.isArray(item) && !item.streaming && item === finalOutput))}
        </div>
      </React.Fragment>;
    });
  }, [selected, index, agents, copiedTarget, pushingId, onSessionUpdate, followStream]);

  return <section className="output-panel" aria-label={`对话窗口 ${index + 1}`}>
    <ChatHeader index={index} multi={multi} agents={agents} projects={projects} feishuApps={feishuApps} selected={selected ? { ...selected, title: sessions.find(session => session.id === selected.id)?.title } : null} copiedTarget={copiedTarget} copyConversation={copyConversation} copyText={copyText} layoutControls={layoutControls} panelControls={panelControls} />
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
    <ChatComposer index={index} pane={pane} agents={agents} projects={projects} sessions={sessions} onProjectChange={onProjectChange} onSessionCreated={onSessionCreated} onSessionUpdate={onSessionUpdate} focused={focused} selected={selected} setSelected={setSelected} setError={setError} />
  </section>;
}

function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [feishuApps, setFeishuApps] = useState<Application[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  const [sessionDateRange, setSessionDateRange] = useState<DateRange | null>(null);
  const [renamingSession, setRenamingSession] = useState<SessionSummary | null>(null);
  const [sessionTitle, setSessionTitle] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);
  const sessionRenameButton = useRef<HTMLButtonElement | null>(null);
  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [sorting, setSorting] = useState(false);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<{ path: string; left: number; top: number; width: number } | null>(null);
  const projectDrag = useRef<{ path: string; target: string; startX: number; startY: number; left: number; top: number; width: number; moved: boolean } | null>(null);
  const renameButton = useRef<HTMLButtonElement | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ path: string; left: number; top: number } | null>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const skipProjectClick = useRef(false);
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

    Promise.all([api<Agent[]>('/api/agents', options), api<SessionSummary[]>('/api/sessions', options), api<string[]>('/api/projects', options), api<Directory>('/api/directories', options), api<Application[]>('/api/feishu/apps', options), api<Record<string, string>>('/api/projects/names', options)])
      .then(([available, history, savedProjects, directory, apps, names]) => {
        if (controller.signal.aborted) return;
        const paths = [...new Set([...savedProjects, ...history.map(session => session.cwd)])];
        const lastSessionId = localStorage.getItem(lastSessionKey);
        const initialSession = history.find(session => session.id === lastSessionId) ?? history[0];
        const firstProject = initialSession?.cwd || savedProjects[0] || directory.path;
        setAgents(available); setSessions(history); setProjects(paths); setExpandedProject(firstProject); setExpandedProjects([firstProject]); setProjectNames(names);
        setFeishuApps(apps);
        setPanes(current => current.map((pane, index) => index === 0 ? { sessionId: initialSession?.id || null, cwd: firstProject, revision: pane.revision + 1 } : pane));
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
    if (currentPane.sessionId) localStorage.setItem(lastSessionKey, currentPane.sessionId);
  }, [currentPane.sessionId]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileMenuOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [mobileMenuOpen]);

  useEffect(() => {
    if (!projectMenu) return;
    projectMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !projectMenuRef.current?.contains(event.target) && !renameButton.current?.contains(event.target)) setProjectMenu(null);
    }
    function closeOnLayoutChange() { setProjectMenu(null); }
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('resize', closeOnLayoutChange);
    window.addEventListener('scroll', closeOnLayoutChange, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('resize', closeOnLayoutChange);
      window.removeEventListener('scroll', closeOnLayoutChange, true);
    };
  }, [projectMenu]);

  function setPane(index: number, sessionId: string | null, cwd: string) {
    setPanes(current => current.map((pane, position) => position === index ? { sessionId, cwd, revision: pane.revision + 1 } : pane));
    setActivePane(index);
  }

  function expandProject(path: string) {
    setExpandedProject(path || null);
    if (path) setExpandedProjects(current => current.includes(path) ? current : [...current, path]);
  }

  async function reorderProjects(path: string, target: string) {
    if (sorting || path === target) return;
    const next = [...projects];
    const from = next.indexOf(path);
    const to = next.indexOf(target);
    if (from < 0 || to < 0) return;
    next.splice(from, 1);
    next.splice(to, 0, path);
    setSorting(true);
    setProjects(next);
    try { await api('/api/projects/order', { method: 'PUT', body: JSON.stringify({ paths: next }) }); }
    catch (reason) { setProjects(projects); setError((reason as Error).message); }
    finally { setSorting(false); }
  }

  function closeRename() {
    setRenamingProject(null);
    renameButton.current?.focus();
  }

  async function renameProject(event: React.FormEvent) {
    event.preventDefault();
    if (!renamingProject || savingName || !projectName.trim()) return;
    setSavingName(true);
    try {
      const { name } = await api<{ name: string }>('/api/projects/name', { method: 'PATCH', body: JSON.stringify({ path: renamingProject, name: projectName }) });
      setProjectNames(current => ({ ...current, [renamingProject]: name }));
      closeRename();
    } catch (reason) { setError((reason as Error).message); }
    finally { setSavingName(false); }
  }

  function closeSessionRename() {
    setRenamingSession(null);
    sessionRenameButton.current?.focus();
  }

  async function renameSession(event: React.FormEvent) {
    event.preventDefault();
    if (!renamingSession || savingTitle || !sessionTitle.trim()) return;
    setSavingTitle(true);
    try {
      const renamed = await api<SessionSummary>(`/api/sessions/${renamingSession.id}`, { method: 'PATCH', body: JSON.stringify({ title: sessionTitle }) });
      setSessions(current => current.map(session => session.id === renamed.id ? { ...session, title: renamed.title } : session));
      closeSessionRename();
    } catch (reason) { setError((reason as Error).message); }
    finally { setSavingTitle(false); }
  }

  function newConversation(path: string, index = activePane) {
    setImOpen(false);
    setAgentsOpen(false);
    setMobileMenuOpen(false);
    expandProject(path);
    setPane(index, null, path);
  }

  function openConversation(session: SessionSummary) {
    setImOpen(false);
    setAgentsOpen(false);
    setMobileMenuOpen(false);
    expandProject(session.cwd);
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
    if (!window.confirm(`删除项目“${projectLabel(path, projects, projectNames)}”及其 ${count} 个对话记录？本地项目文件不会删除。`)) return;
    setError('');
    try {
      await api('/api/projects', { method: 'DELETE', body: JSON.stringify({ path }) });
      const remaining = projects.filter(project => project !== path);
      setProjects(remaining);
      setExpandedProjects(current => current.filter(project => project !== path));
      setProjectNames(current => Object.fromEntries(Object.entries(current).filter(([project]) => project !== path)));
      if (sessions.some(session => session.cwd === path && session.id === localStorage.getItem(lastSessionKey))) localStorage.removeItem(lastSessionKey);
      setSessions(current => current.filter(session => session.cwd !== path));
      setExpandedProject(current => current === path ? remaining[0] || null : current);
      setPanes(current => current.map(pane => pane.cwd === path ? { sessionId: null, cwd: remaining[0] || '', revision: pane.revision + 1 } : pane));
    } catch (reason) { setError((reason as Error).message); }
  }

  async function deleteSession(session: SessionSummary) {
    if (!window.confirm(`删除对话“${session.title ?? session.prompt}”？此操作会删除对话记录。`)) return;
    setError('');
    try {
      await api(`/api/sessions/${session.id}`, { method: 'DELETE' });
      if (localStorage.getItem(lastSessionKey) === session.id) localStorage.removeItem(lastSessionKey);
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
    expandProject(session.cwd);
    setPane(index, session.id, session.cwd);
  }

  const visibleSessions = sessionDateRange ? sessions.filter(session => {
    const date = localDate(session.createdAt);
    return date >= sessionDateRange.start && date <= sessionDateRange.end;
  }) : sessions;
  const visibleProjects = sessionDateRange ? projects.filter(path => visibleSessions.some(session => session.cwd === path)) : projects;
  const agentName = (id: string) => agents.find(item => item.id === id)?.name || id;
  const activeSessionId = currentPane.sessionId;

  return <ProjectNamesContext.Provider value={projectNames}><div className={`app-shell${window.desktopWindow ? ' desktop-macos' : ''}`}>
    <button className={`mobile-menu-backdrop ${mobileMenuOpen ? 'open' : ''}`} aria-label="关闭菜单" onClick={() => setMobileMenuOpen(false)} />
    <aside className={`sidebar ${mobileMenuOpen ? 'open' : ''}`} id="project-menu">
      <DesktopWindowControls />
      <div className="brand"><div className="brand-symbol"><span /><span /><span /></div><strong>Agent Muster</strong><button className="menu-close" aria-label="关闭菜单" onClick={() => setMobileMenuOpen(false)}>×</button></div>
      <nav className="sidebar-menu" aria-label="快捷菜单">
        <button className="sidebar-create" disabled={picking} onClick={() => void pickProject()}><ActionIcon type="add" /><span>创建项目</span></button>
        <button className={`im-sidebar-link ${imOpen ? 'active' : ''}`} onClick={() => { setImOpen(true); setAgentsOpen(false); setMobileMenuOpen(false); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" /></svg><span>IM 集成</span></button>
        <button className={`im-sidebar-link ${agentsOpen ? 'active' : ''}`} onClick={() => { setAgentsOpen(true); setImOpen(false); setMobileMenuOpen(false); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="6" width="16" height="14" rx="3" /><path d="M12 6V3M8 11h.01M16 11h.01M8 16h8M1 11v4M23 11v4" /></svg><span>Agent 管理</span></button>
      </nav>
      <nav className="sidebar-projects" aria-label="项目和对话">
        <div className="section-title"><span>项目</span><div className="project-section-actions"><button className="add-project" disabled={picking} onClick={() => void pickProject()} aria-label="添加项目" title="添加项目"><ActionIcon type="add" /></button><DateRangePicker value={sessionDateRange} onChange={setSessionDateRange} /></div></div>
        {sessionDateRange && <div className="project-range-summary"><span>{sessionDateRange.start} 至 {sessionDateRange.end}</span><button type="button" aria-label="清除日期筛选" onClick={() => setSessionDateRange(null)}>×</button></div>}
        {visibleProjects.map(path => {
          const projectSessions = visibleSessions.filter(session => session.cwd === path);
          const expanded = expandedProjects.includes(path);
          return <div className={`project-group ${dragPreview?.path === path ? 'project-dragging' : ''}`} key={path}>
            <div className={`project-row ${dragTarget === path ? 'project-drop-target' : ''}`} data-project-path={path}
              onPointerDown={event => {
                skipProjectClick.current = false;
                if (sorting || event.button !== 0 || !(event.target instanceof Element) || event.target.closest('.project-new, .project-actions')) return;
                const rect = event.currentTarget.getBoundingClientRect();
                projectDrag.current = { path, target: path, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top, width: rect.width, moved: false };
              }} onPointerMove={event => {
                const drag = projectDrag.current;
                if (!drag || drag.path !== path) return;
                if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 5) {
                  drag.moved = true;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setProjectMenu(null);
                }
                if (!drag.moved) return;
                setDragPreview({ path, width: drag.width, left: Math.max(0, Math.min(drag.left + event.clientX - drag.startX, window.innerWidth - drag.width)), top: Math.max(0, Math.min(drag.top + event.clientY - drag.startY, window.innerHeight - 34)) });
                const group = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.project-group');
                const row = group?.querySelector<HTMLElement>('[data-project-path]');
                if (row?.dataset.projectPath) { drag.target = row.dataset.projectPath; setDragTarget(drag.target); }
              }} onPointerUp={() => {
                const drag = projectDrag.current;
                projectDrag.current = null;
                setDragTarget(null);
                setDragPreview(null);
                if (drag?.moved) { skipProjectClick.current = true; void reorderProjects(drag.path, drag.target); }
              }} onPointerCancel={() => { projectDrag.current = null; setDragTarget(null); setDragPreview(null); }}
              onLostPointerCapture={event => { if (event.target === event.currentTarget) { projectDrag.current = null; setDragTarget(null); setDragPreview(null); } }}
              onClickCapture={event => {
                if (skipProjectClick.current) { event.preventDefault(); event.stopPropagation(); skipProjectClick.current = false; }
              }}>
              <button className="project-item" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" onKeyDown={event => {
                if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
                event.preventDefault();
                const target = visibleProjects[visibleProjects.indexOf(path) + (event.key === 'ArrowUp' ? -1 : 1)];
                if (target) void reorderProjects(path, target);
              }} onClick={() => {
                setImOpen(false);
                setAgentsOpen(false);
                setExpandedProjects(current => expanded ? current.filter(project => project !== path) : [...current, path]);
                setExpandedProject(expanded ? null : path);
              }} title={path} aria-expanded={expanded}>
                <ProjectFolderIcon open={expanded} /><span className="project-name">{projectLabel(path, projects, projectNames)}</span>
              </button>
              <button className="project-new" onClick={() => newConversation(path)} aria-label={`在 ${projectLabel(path, projects, projectNames)} 中新建对话`} title="新建对话"><ActionIcon type="edit" /></button>
              <button className={`project-actions ${projectMenu?.path === path ? 'open' : ''}`} aria-label={`项目操作 ${projectLabel(path, projects, projectNames)}`} aria-haspopup="menu" aria-expanded={projectMenu?.path === path} aria-controls={projectMenu?.path === path ? 'project-actions-menu' : undefined} data-tooltip="项目操作" onClick={event => {
                renameButton.current = event.currentTarget;
                if (projectMenu?.path === path) { setProjectMenu(null); return; }
                const rect = event.currentTarget.getBoundingClientRect();
                setProjectMenu({ path, left: Math.max(8, Math.min(rect.right - 148, window.innerWidth - 156)), top: rect.bottom + 88 < window.innerHeight ? rect.bottom + 4 : rect.top - 84 });
              }}><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg></button>
            </div>
            {expanded && <div className="project-conversations">
              {projectSessions.length ? projectSessions.map(session => {
                const openIndex = panes.slice(0, paneCount).findIndex(pane => pane.sessionId === session.id);
                const dingtalkBinding = session.im?.find(binding => binding.platform === 'dingtalk');
                const feishuBinding = session.im?.find(binding => binding.platform === 'feishu');
                const wecomBinding = session.im?.find(binding => binding.platform === 'wecom');
                const feishuIcon = feishuApps.find(app => app.id === feishuBinding?.appId)?.icon;
                return <div className="conversation-row" key={session.id}><button className={`conversation-item ${activeSessionId === session.id ? 'selected' : ''}`} onClick={() => openConversation(session)} title={session.title ?? session.prompt}>
                  <span className="conversation-icon">{wecomBinding && <AppIcon className="conversation-app-icon" fallbackClassName="feishu-app-mark" platform="企业微信" />}{dingtalkBinding && <AppIcon className="conversation-app-icon" fallbackClassName="feishu-app-mark" src={`/api/dingtalk/apps/${dingtalkBinding.appId}/icon`} platform="钉钉" />}{feishuBinding && <AppIcon className="conversation-app-icon" fallbackClassName="feishu-app-mark" src={feishuIcon} platform="飞书" />}<AgentIcon agent={session.agent} className={dingtalkBinding || feishuBinding || wecomBinding ? 'conversation-agent-badge' : undefined} /></span><span className="conversation-text"><strong>{session.title ?? session.prompt}</strong><small>{agentName(session.agent)} · {time(session.createdAt)}</small></span>{(session.status === 'starting' || session.status === 'running') && <span className="conversation-loading" role="status" aria-label={statusLabel[session.status]} />}{paneCount > 1 && openIndex >= 0 && <span className="pane-marker" aria-label={`窗口 ${openIndex + 1}`}>{openIndex + 1}</span>}
                </button><button className="conversation-rename" aria-label="重命名会话" data-tooltip="重命名会话" onClick={event => {
                  sessionRenameButton.current = event.currentTarget;
                  setSessionTitle(session.title ?? session.prompt);
                  setRenamingSession(session);
                }}><ActionIcon type="edit" /></button><button className="sidebar-delete conversation-delete" onClick={() => void deleteSession(session)} aria-label={`删除对话 ${session.title ?? session.prompt}`} title="删除对话"><ActionIcon type="delete" /></button></div>;
              }) : <p className="project-empty">还没有对话</p>}
            </div>}
          </div>;
        })}
        {!visibleProjects.length && <p className="project-empty">{sessionDateRange ? '所选日期范围内没有会话' : '暂无项目。点击右侧加号选择本地目录。'}</p>}
      </nav>

    </aside>

    <main className="main-area">
      <header className="topbar">
        <div className="topbar-left"><button className="menu-toggle" aria-label={mobileMenuOpen ? '关闭菜单' : '打开菜单'} aria-expanded={mobileMenuOpen} aria-controls="project-menu" onClick={() => setMobileMenuOpen(open => !open)}><span /><span /><span /></button></div>
        {!imOpen && !agentsOpen && <LayoutSwitch layout={layout} onChange={changeLayout} />}
      </header>
      <div className="content chat-content">
        <div className={`workspace-grid ${layout}`} style={{ display: imOpen || agentsOpen ? 'none' : undefined }}>
          {panes.slice(0, paneCount).map((pane, index) => <ChatPane key={`${index}-${pane.cwd}`} index={index} pane={pane} panelProject={imOpen || agentsOpen ? null : expandedProject} multi={paneCount > 1} active={activePane === index} agents={agents} projects={projects} sessions={sessions} feishuApps={feishuApps} onFocus={setActivePane} onProjectChange={(position, path) => { setPanes(current => current.map((item, i) => i === position ? { ...item, cwd: path } : item)); expandProject(path); }} onSessionCreated={sessionCreated} onSessionUpdate={updateSession} layoutControls={index === (paneCount === 1 ? 0 : 1) ? <LayoutSwitch layout={layout} onChange={changeLayout} /> : undefined} />)}
        </div>
        <div className="management-page" hidden={!agentsOpen}><AgentPanel active={agentsOpen} onChange={setAgents} /></div>
        <div className="management-page" hidden={!imOpen}><ImPrototype active={imOpen} sessions={sessions} onOpenSession={openConversation} feishuApps={feishuApps} onFeishuAppsChange={setFeishuApps} projects={projects} agents={agents} projectLabel={path => projectLabel(path, projects, projectNames)} /></div>
      </div>
    </main>
    {dragPreview && createPortal(<div className="project-item project-drag-preview" aria-hidden="true" style={{ left: dragPreview.left, top: dragPreview.top, width: dragPreview.width }}>
      <ProjectFolderIcon open={expandedProjects.includes(dragPreview.path)} /><span className="project-name">{projectLabel(dragPreview.path, projects, projectNames)}</span>
    </div>, document.body)}
    {projectMenu && createPortal(<div ref={projectMenuRef} id="project-actions-menu" className="project-actions-menu" role="menu" aria-label="项目操作" style={{ left: projectMenu.left, top: projectMenu.top }} onBlur={event => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setProjectMenu(null);
    }} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); setProjectMenu(null); renameButton.current?.focus(); }
      if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }
    }}>
      <button role="menuitem" onClick={() => {
        setProjectName(projectLabel(projectMenu.path, projects, projectNames));
        setRenamingProject(projectMenu.path);
        setProjectMenu(null);
      }}>重命名</button>
      <button role="menuitem" className="project-menu-delete" onClick={() => { void deleteProject(projectMenu.path); setProjectMenu(null); renameButton.current?.focus(); }}>删除项目</button>
    </div>, document.body)}
    {renamingSession && <div className="project-dialog-backdrop" onKeyDown={event => { if (event.key === 'Escape' && !savingTitle) { event.stopPropagation(); closeSessionRename(); } }}>
      <form className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="session-rename-title" onSubmit={event => void renameSession(event)} onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)')];
        const next = controls[(controls.indexOf(document.activeElement as HTMLElement) + (event.shiftKey ? controls.length - 1 : 1)) % controls.length];
        event.preventDefault(); next?.focus();
      }}>
        <h2 id="session-rename-title">重命名会话</h2>
        <label htmlFor="session-title">会话名称</label>
        <input id="session-title" autoFocus value={sessionTitle} maxLength={100} disabled={savingTitle} onFocus={event => event.currentTarget.select()} onChange={event => setSessionTitle(event.target.value)} />
        <div className="project-dialog-actions"><button type="button" disabled={savingTitle} onClick={closeSessionRename}>取消</button><button type="submit" disabled={savingTitle || !sessionTitle.trim()}>{savingTitle ? '保存中…' : '保存名称'}</button></div>
      </form>
    </div>}
    {renamingProject && <div className="project-dialog-backdrop" onKeyDown={event => { if (event.key === 'Escape' && !savingName) { event.stopPropagation(); closeRename(); } }}>
      <form className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-rename-title" onSubmit={event => void renameProject(event)} onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)')];
        const next = controls[(controls.indexOf(document.activeElement as HTMLElement) + (event.shiftKey ? controls.length - 1 : 1)) % controls.length];
        event.preventDefault(); next?.focus();
      }}>
        <h2 id="project-rename-title">重命名项目</h2>
        <label htmlFor="project-name">项目名称</label>
        <input id="project-name" autoFocus value={projectName} maxLength={100} disabled={savingName} onFocus={event => event.currentTarget.select()} onChange={event => setProjectName(event.target.value)} />
        <div className="project-dialog-actions"><button type="button" disabled={savingName} onClick={closeRename}>取消</button><button type="submit" disabled={savingName || !projectName.trim()}>{savingName ? '保存中…' : '保存名称'}</button></div>
      </form>
    </div>}
  </div></ProjectNamesContext.Provider>;
}

createRoot(document.getElementById('root')!).render(<MessageProvider><App /></MessageProvider>);
