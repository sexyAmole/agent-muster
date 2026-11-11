import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChatPaneContent } from './chat-pane-content';
import type { ChatPaneProps } from './types';

const FilePanel = lazy(() => import('../files/file-panel').then(module => ({ default: module.FilePanel })));

export function ChatPane(props: ChatPaneProps) {
  const { index, pane, panelProject, multi, active: focused, onFocus } = props;
  const [panelOpen, setPanelOpen] = useState(false);
  const [conversationRatio, setConversationRatio] = useState(0.5);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1100px)').matches);
  const drawerRef = useRef<HTMLDialogElement>(null);

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
  const canOpenPanel = !multi && Boolean(project && project === panelProject);
  const showPanel = canOpenPanel && panelOpen;

  useEffect(() => {
    const drawer = drawerRef.current;
    if (!drawer) return;
    if (showPanel && narrow) drawer.showModal();
    else drawer.close();
  }, [showPanel, narrow]);

  function closePanel() {
    drawerRef.current?.close();
    setPanelOpen(false);
    panelButton.current?.focus();
  }

  function resizeConversation(width: number) {
    const available = paneRef.current!.clientWidth - 8;
    setConversationRatio(Math.max(300, Math.min(available - 300, width)) / available);
  }

  const filePanel = showPanel && <Suspense fallback={<aside className="file-panel" role="status"><p className="file-panel-status">正在加载文件面板…</p></aside>}><FilePanel key={project} project={project} onClose={closePanel} /></Suspense>;

  return <div ref={paneRef} className={`pane-wrap ${focused && multi ? 'focused' : ''}${showPanel && !narrow ? ' files-open' : ''}`} style={showPanel && !narrow ? { gridTemplateColumns: `minmax(300px, ${conversationRatio}fr) 8px minmax(300px, ${1 - conversationRatio}fr)` } : undefined} onPointerDown={() => { if (!focused) onFocus(index); }} onFocusCapture={() => { if (!focused) onFocus(index); }}>
    <ChatPaneContent key={props.pane.revision} {...props} panelControls={canOpenPanel && <button ref={panelButton} type="button" className="file-panel-toggle" aria-label={showPanel ? '收起面板' : '展开面板'} aria-haspopup={narrow ? 'dialog' : undefined} aria-expanded={showPanel} onClick={() => setPanelOpen(open => !open)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></svg></button>} />
    {showPanel && !narrow && <div className="panel-resizer" role="separator" tabIndex={0} aria-label="调整会话与文件面板宽度" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(conversationRatio * 100)} onPointerDown={event => {
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
    {!narrow && filePanel}
    {createPortal(<dialog ref={drawerRef} className="file-panel-drawer" aria-label="项目面板" onCancel={event => { event.preventDefault(); closePanel(); }} onClose={() => setPanelOpen(false)} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closePanel();
    }}>
      {narrow && filePanel}
    </dialog>, document.body)}
  </div>;
}
