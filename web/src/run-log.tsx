import { memo, useEffect, useRef, useState } from 'react';
import { useErrorMessage } from './message';

type LogEvent = { id: number; type: string; text: string; detail?: string; timestamp: number };
type Props = {
  agent: string;
  sessionId: string;
  copied: boolean;
  onCopy: (text: string, target: 'run-log') => Promise<void>;
};
const timestampFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export const RunLog = memo(function RunLog({ sessionId, agent, copied, onCopy }: Props) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<LogEvent[]>([]);
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
      const response = await fetch(`/api/sessions/${sessionId}/logs?limit=50${before === undefined ? '' : `&before=${before}`}`, { signal: controller.signal });
      const page = await response.json() as { events: LogEvent[]; hasMore: boolean; error?: string };
      if (!response.ok) throw new Error(page.error || '读取日志失败');
      if (controller.signal.aborted) return;
      setLogs(previous => before === undefined ? page.events : [...page.events, ...previous]);
      setHasMore(page.hasMore);
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
    if (!open) return;
    function closeOutside(event: PointerEvent) {
      const element = detailsRef.current;
      if (element && event.target instanceof Node && !element.contains(event.target)) element.open = false;
    }
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  return <details ref={detailsRef} className="run-log" onToggle={event => setOpen(event.currentTarget.open)} onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
  }}>
    <summary aria-label="运行日志" title="运行日志"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 12h8M8 17h5" /></svg></summary>
    {open && <div className="run-log-content" tabIndex={0}>
      <div className="run-log-toolbar"><button className="reply-push" disabled={!logs.length} onClick={() => void onCopy(logs.map(event => event.text).join('\n'), 'run-log')}>{copied ? '已复制' : '复制已加载日志'}</button>{hasMore && <button className="history-load" disabled={loading} onClick={() => void loadLogs(logs[0]?.id)}>{loading ? '加载中…' : '加载更早日志'}</button>}</div>
      {logs.map(event => <div key={event.id}><span>{timestampFormat.format(event.timestamp)} · {event.type === 'raw_stdout' ? 'stdout' : event.type === 'raw_stderr' ? 'stderr' : event.type}</span><pre>{event.text}{event.detail !== undefined && `\n${event.detail}`}</pre></div>)}
      {loading && !logs.length && <p>加载中…</p>}
      {!loading && !logs.length && <p>{agent === 'pi' ? '暂无运行记录，新执行的内容将在这里记录。' : '暂无原始运行日志，新执行的内容将在这里记录。'}</p>}
    </div>}
  </details>;
});
