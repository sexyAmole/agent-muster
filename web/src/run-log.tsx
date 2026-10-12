import { memo, useEffect, useMemo, useRef, useState } from 'react';

type LogEvent = { id: number; type: string; text: string; detail?: string; timestamp: number };
type Props = {
  agent: string;
  events: LogEvent[];
  copied: boolean;
  hasMore: boolean;
  loading: boolean;
  onCopy: (text: string, target: 'run-log') => Promise<void>;
  onLoad: () => Promise<void>;
};
const timestampFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export const RunLog = memo(function RunLog({ agent, events, copied, hasMore, loading, onCopy, onLoad }: Props) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const logs = useMemo(() => events.filter(event => event.type === 'raw_stdout' || event.type === 'raw_stderr'), [events]);

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
    if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
  }}>
    <summary aria-label="运行日志" title="运行日志"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h8M8 12h8M8 17h5" /></svg></summary>
    {open && <div className="run-log-content" tabIndex={0}>
      <div className="run-log-toolbar"><button className="reply-push" disabled={!logs.length} onClick={() => void onCopy(logs.map(event => event.text).join('\n'), 'run-log')}>{copied ? '已复制' : '复制已加载日志'}</button>{hasMore && <button className="history-load" disabled={loading} onClick={() => void onLoad()}>{loading ? '加载中…' : '加载更早日志'}</button>}</div>
      {logs.map(event => <div key={event.id}><span>{timestampFormat.format(event.timestamp)} · {event.type === 'raw_stdout' ? 'stdout' : event.type === 'raw_stderr' ? 'stderr' : event.type}</span><pre>{event.text}{event.detail !== undefined && `\n${event.detail}`}</pre></div>)}
      {!logs.length && <p>{agent === 'pi' ? '暂无运行记录，新执行的内容将在这里记录。' : '暂无原始运行日志，新执行的内容将在这里记录。'}</p>}
    </div>}
  </details>;
});
