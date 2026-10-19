import { apiUrl } from './api-url';
import { memo, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useErrorMessage } from './message';

import type { SessionLog, SessionLogPage } from '../../src/types';
type Props = {
  sessionId: string;
  copied: boolean;
  onCopy: (text: string, target: 'run-log') => Promise<void>;
};
const timestampFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function LogEntry({ event }: { event: SessionLog }) {
  const [expanded, setExpanded] = useState(false);

  return <details onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{event.timestamp !== undefined && `${timestampFormat.format(event.timestamp)} · `}{event.type}</summary>
    {expanded && <pre>{event.text}</pre>}
  </details>;
}

export const RunLog = memo(function RunLog({ sessionId, copied, onCopy }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<SessionLog[]>([]);
  const [supported, setSupported] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useErrorMessage(error, setError);
  const controllerRef = useRef<AbortController | null>(null);

  async function loadLogs(before?: number) {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const response = await fetch(apiUrl(`/api/sessions/${sessionId}/logs?limit=50${before === undefined ? '' : `&before=${before}`}`), { signal: controller.signal });
      const page = await response.json() as SessionLogPage & { error?: string };
      if (!response.ok) throw new Error(page.error || '读取日志失败');
      if (controller.signal.aborted) return;
      setLogs(previous => before === undefined ? page.events : [...page.events, ...previous]);
      setHasMore(page.hasMore);
      setSupported(page.supported);
    } catch (reason) {
      if (!controller.signal.aborted) setError((reason as Error).message);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    void loadLogs();
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [open, sessionId]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) dialog.showModal();
    else dialog.close();
  }, [open]);

  return <div className="run-log">
    <button className="copy-button" aria-label="运行日志" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 12h8M8 17h5" /></svg></button>
    {createPortal(<dialog ref={dialogRef} className="run-log-drawer" aria-labelledby={titleId} onCancel={() => setOpen(false)} onClose={() => setOpen(false)} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setOpen(false);
    }}>
      <div className="run-log-header"><h2 id={titleId}>运行日志</h2><button className="copy-button" aria-label="关闭运行日志" onClick={() => setOpen(false)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></button></div>
      {open && <div className="run-log-content" tabIndex={0}>
      <div className="run-log-toolbar"><button className="reply-push" disabled={!logs.length} onClick={() => void onCopy(logs.map(event => event.text).join('\n'), 'run-log')}>{copied ? '已复制' : '复制已加载日志'}</button>{hasMore && <button className="history-load" disabled={loading} onClick={() => void loadLogs(logs[0]?.id)}>{loading ? '加载中…' : '加载更早日志'}</button>}</div>
      {logs.map(event => <LogEntry key={event.id} event={event} />)}
      {loading && !logs.length && <p>加载中…</p>}
      {!loading && !logs.length && <p>{supported ? '尚未找到 Agent 本地会话记录。' : '此 Agent 不支持读取本地 JSONL 会话记录。'}</p>}
      </div>}
    </dialog>, document.body)}
  </div>;
});
