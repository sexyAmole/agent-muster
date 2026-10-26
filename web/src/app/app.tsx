import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentInfo as Agent, AgentSession as Session } from '../../../src/types';
import { AgentIcon } from '../features/agents/agent-icon';
import { AgentPanel } from '../features/agents/agent-panel';
import { DesktopUpdateButton } from '../features/desktop/desktop-update-button';
import { DesktopWindowControls } from '../features/desktop/desktop-window-controls';
import { ImPanel, type Application } from '../features/integrations/im-panel';
import { AppIcon } from '../shared/components/app-icon';
import { DateRangePicker, localDate, type DateRange } from '../shared/components/date-range-picker';
import { useErrorMessage } from '../shared/components/message';
import { ProjectFolderIcon } from '../features/projects/project-icons';
import { projectLabel, ProjectNamesContext } from '../features/projects/project-label';
import { ChatPane } from '../features/sessions/chat-pane';
import { statusLabel } from '../features/sessions/session-utils';
import type { PaneState, SessionSummary } from '../features/sessions/types';
import { ActionIcon } from '../shared/components/action-icon';
import { api } from '../shared/lib/api';
import { time } from '../shared/lib/date';
import { LayoutSwitch, type Layout } from './layout-switch';

const lastSessionKey = 'agent-muster:last-session';
type Directory = { path: string };

export function App() {
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

  async function pickProject(index = activePane, createConversation = true) {
    if (picking) return;
    setError(''); setPicking(true);
    try {
      const result = await api<{ path: string | null }>('/api/projects/pick', { method: 'POST' });
      if (!result.path) return;
      const path = result.path;
      setProjects(current => current.includes(path) ? current : [...current, path]);
      if (createConversation) newConversation(path, index);
      else {
        setPanes(current => current.map((pane, position) => position === index ? { ...pane, cwd: path } : pane));
        expandProject(path);
      }
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
    setImOpen(false);
    setAgentsOpen(false);
    setMobileMenuOpen(false);
  }

  const updateSession = useCallback((session: Pick<Session, 'id' | 'status' | 'updatedAt'> & Partial<Pick<Session, 'externalSessionId' | 'permissionMode' | 'sandboxEnabled'>>) => {
    setSessions(current => current.map(item => item.id === session.id ? { ...item, status: session.status, updatedAt: session.updatedAt, externalSessionId: session.externalSessionId ?? item.externalSessionId, permissionMode: session.permissionMode ?? item.permissionMode, sandboxEnabled: session.sandboxEnabled ?? item.sandboxEnabled } : item));
  }, []);

  function sessionCreated(index: number, session: SessionSummary) {
    setSessions(current => [session, ...current]);
    expandProject(session.cwd);
    setPane(index, session.id, session.cwd);
  }

  const visibleSessions = sessionDateRange ? sessions.filter(session => {
    const date = localDate(session.updatedAt);
    return date >= sessionDateRange.start && date <= sessionDateRange.end;
  }) : sessions;
  const visibleProjects = sessionDateRange ? projects.filter(path => visibleSessions.some(session => session.cwd === path)) : projects;
  const activeSessionId = currentPane.sessionId;

  return <ProjectNamesContext.Provider value={projectNames}><div className={`app-shell${window.desktopWindow ? ' desktop-macos' : ''}`}>
    <button className={`mobile-menu-backdrop ${mobileMenuOpen ? 'open' : ''}`} aria-label="关闭菜单" onClick={() => setMobileMenuOpen(false)} />
    <aside className={`sidebar ${mobileMenuOpen ? 'open' : ''}`} id="project-menu">
      <DesktopWindowControls />
      <div className="brand"><div className="brand-symbol"><span /><span /><span /></div><strong>Agent Muster</strong><DesktopUpdateButton /><button className="menu-close" aria-label="关闭菜单" onClick={() => setMobileMenuOpen(false)}>×</button></div>
      <nav className="sidebar-menu" aria-label="快捷菜单">
        <div className="sidebar-create-row"><button className="sidebar-create" disabled={picking} onClick={() => newConversation(currentPane.cwd)}><ActionIcon type="add" /><span>创建会话</span></button><LayoutSwitch layout={layout} onChange={changeLayout} disabled={picking} /></div>
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
                const weixinBinding = session.im?.find(binding => binding.platform === 'weixin');
                const feishuIcon = feishuApps.find(app => app.id === feishuBinding?.appId)?.icon;
                return <div className="conversation-row" key={session.id}><button className={`conversation-item ${activeSessionId === session.id ? 'selected' : ''}`} onClick={() => openConversation(session)} title={session.title ?? session.prompt}>
                  <span className="conversation-icon">{weixinBinding && <AppIcon className="conversation-app-icon" fallbackClassName="feishu-app-mark" platform="微信" />}{wecomBinding && <AppIcon className="conversation-app-icon" fallbackClassName="feishu-app-mark" platform="企业微信" />}{dingtalkBinding && <AppIcon className="conversation-app-icon" fallbackClassName="feishu-app-mark" src={`/api/dingtalk/apps/${dingtalkBinding.appId}/icon`} platform="钉钉" />}{feishuBinding && <AppIcon className="conversation-app-icon" fallbackClassName="feishu-app-mark" src={feishuIcon} platform="飞书" />}<AgentIcon agent={session.agent} className={dingtalkBinding || feishuBinding || wecomBinding || weixinBinding ? 'conversation-agent-badge' : undefined} /></span><span className="conversation-text"><strong>{session.title ?? session.prompt}</strong><small>{time(session.updatedAt)}</small></span>{(session.status === 'starting' || session.status === 'running') && <span className="conversation-loading" role="status" aria-label={statusLabel[session.status]} />}{paneCount > 1 && openIndex >= 0 && <span className="pane-marker" aria-label={`窗口 ${openIndex + 1}`}>{openIndex + 1}</span>}
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
      </header>
      <div className="content chat-content">
        <div className={`workspace-grid ${layout}`} style={{ display: imOpen || agentsOpen ? 'none' : undefined }}>
          {panes.slice(0, paneCount).map((pane, index) => <ChatPane key={index} index={index} pane={pane} panelProject={imOpen || agentsOpen ? null : expandedProject} multi={paneCount > 1} active={activePane === index} agents={agents} projects={projects} sessions={sessions} feishuApps={feishuApps} onFocus={setActivePane} pickingProject={picking} onAddProject={index => pickProject(index, false)} onProjectChange={(position, path) => { setPanes(current => current.map((item, i) => i === position ? { ...item, cwd: path } : item)); expandProject(path); }} onSessionCreated={sessionCreated} onSessionUpdate={updateSession} />)}
        </div>
        <div className="management-page" hidden={!agentsOpen}><AgentPanel agents={agents} active={agentsOpen} onChange={setAgents} /></div>
        <div className="management-page" hidden={!imOpen}><ImPanel active={imOpen} sessions={sessions} onOpenSession={openConversation} feishuApps={feishuApps} onFeishuAppsChange={setFeishuApps} projects={projects} agents={agents} projectLabel={path => projectLabel(path, projects, projectNames)} /></div>
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
