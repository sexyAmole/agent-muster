import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentInfo as Agent, AgentSession as Session } from '../../../../src/types';
import { useErrorMessage } from '../../shared/components/message';
import { Select } from '../../shared/components/select';
import { AgentIcon } from '../agents/agent-icon';
import { FileMentionTextarea } from './file-mention-textarea';
import { api } from '../../shared/lib/api';
import { projectLabel, ProjectNamesContext } from '../projects/project-label';
import { tokenCount } from './session-utils';
import type { PaneProps, SessionSummary } from './types';

type ComposerImage = { file: File; url: string; id?: string };
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
  const [details, setDetails] = useState<Agent>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useErrorMessage(error, setError);
  const models = details?.models || agentInfo?.models || [];
  const defaultModel = details?.defaultModel || agentInfo?.defaultModel;

  async function loadModels() {
    if (loading || !agentInfo?.installed) return;
    setLoading(true);
    try { setDetails(await api<Agent>(`/api/agents/${composerAgent}/models`)); }
    catch (reason) { setError((reason as Error).message); }
    finally { setLoading(false); }
  }
  return <><label className="model-select"><Select aria-label={`窗口 ${index + 1} 选择模型`} value={model} disabled={!composerAgent || busy || running} onOpen={() => void loadModels()} onChange={onModelChange}><option value="">{defaultModel ? `默认 · ${defaultModel}` : 'Agent 默认'}</option>{model && !models.some(item => item.id === model) && <option value={model} disabled={composerAgent === 'codex' && model === 'gpt-6.1-sol'}>{model}</option>}{loading && <option value="loading" disabled>加载模型中…</option>}{models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>{agentInfo && <label className="permission-select"><Select aria-label={`窗口 ${index + 1} 权限模式`} title={agentInfo.permissionModes.find(item => item.id === permissionMode)?.description} value={permissionMode} disabled={busy || disabled || !agentInfo.installed} onChange={onPermissionModeChange}>{agentInfo.permissionModes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>}</>;
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

export function ChatComposer({ index, pane, agents, projects, sessions, onProjectChange, onSessionCreated, onSessionUpdate, focused, selected, setSelected, setError }: ChatComposerProps) {
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
      <div className="composer-footer"><div className="composer-actions"><button type="button" className="composer-attach" aria-label={`窗口 ${index + 1} 添加图片`} title={supportsImages ? '添加图片，也可粘贴截图' : '当前 Agent 接入不支持图片附件'} disabled={busy || composerDisabled || !supportsImages} onClick={() => imageInputRef.current?.click()}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m21 16-5-5L5 21" /></svg></button>{busy && images.length > 0 && <span className="composer-upload-status" role="status">发送图片中…</span>}<ComposerSettings key={composerAgent} index={index} composerAgent={composerAgent} agentInfo={agentInfo} model={model} permissionMode={permissionMode} busy={busy} running={Boolean(running)} disabled={composerDisabled} onModelChange={setModel} onPermissionModeChange={setPermissionMode} /></div><button className="composer-send" aria-label={running ? '停止生成' : selected ? '发送消息' : '创建对话并发送'} disabled={running ? busy : !canSend} onClick={running ? stop : send}>{running ? <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect width="12" height="12" rx="1" /></svg> : '↑'}</button></div>
    </div>
    {selected && <TokenUsageStatus usage={selected.usage} />}
  </div>;
}
