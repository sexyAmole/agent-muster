import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type DateRange = { start: string; end: string };

export function localDate(value: number | Date): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function presetRanges(today: Date) {
  const year = today.getFullYear();
  const month = today.getMonth();
  const day = today.getDate();
  const end = localDate(today);
  return [
    { label: '今天', start: end, end },
    { label: '昨天', start: localDate(new Date(year, month, day - 1)), end: localDate(new Date(year, month, day - 1)) },
    { label: '近 7 天', start: localDate(new Date(year, month, day - 6)), end },
    { label: '近 30 天', start: localDate(new Date(year, month, day - 29)), end },
    { label: '本月', start: localDate(new Date(year, month, 1)), end },
    { label: '上月', start: localDate(new Date(year, month - 1, 1)), end: localDate(new Date(year, month, 0)) },
  ];
}

export function DateRangePicker({ value, onChange }: { value: DateRange | null; onChange: (value: DateRange | null) => void }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => new Date());
  const [start, setStart] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const today = new Date();
  const todayKey = localDate(today);
  const presets = presetRanges(today);
  const selectedPreset = !custom && value ? presets.find(item => item.start === value.start && item.end === value.end)?.label : undefined;
  const preview = start ? { start: [start, hovered ?? start].sort()[0], end: [start, hovered ?? start].sort()[1] } : value;

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  function choose(day: string) {
    setCustom(true);
    if (!start) { setStart(day); setHovered(day); return; }
    const [from, to] = [start, day].sort();
    onChange({ start: from, end: to });
    close();
  }

  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const bounds = panel.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - bounds.width - 8)),
      top: rect.bottom + bounds.height + 6 <= window.innerHeight - 8 ? rect.bottom + 6 : Math.max(8, window.innerHeight - bounds.height - 8),
    });
    panel.current.querySelector<HTMLButtonElement>('button')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false);
    }
    function layoutChanged(event: Event) {
      if (event.target instanceof Node && panel.current?.contains(event.target)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', layoutChanged);
    window.addEventListener('scroll', layoutChanged, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', layoutChanged);
      window.removeEventListener('scroll', layoutChanged, true);
    };
  }, [open]);

  return <>
    <button ref={trigger} className={`date-range-trigger ${value || open ? 'active' : ''}`} type="button" aria-label="按日期筛选会话" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} data-tooltip="按日期筛选会话" onClick={() => {
      if (open) { close(); return; }
      const end = value ? new Date(`${value.end}T00:00:00`) : today;
      setMonth(new Date(end.getFullYear(), end.getMonth() - 1, 1));
      setStart(null); setHovered(null); setCustom(false); setOpen(true);
    }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18M8 15h2M14 15h2" /></svg></button>
    {open && createPortal(<div ref={panel} id={id} className="date-range-picker" role="dialog" aria-label="筛选会话创建日期" style={position} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
      if (event.key === 'Tab') {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const first = buttons[0]; const last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="date-range-presets">
        {presets.map(({ label, ...range }) => <button type="button" key={label} aria-pressed={selectedPreset === label} onClick={() => { onChange(range); close(); }}><span>{label}</span>{selectedPreset === label && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>}</button>)}
        <button type="button" aria-pressed={custom || Boolean(value && !selectedPreset)} onClick={() => { setCustom(true); setStart(null); setHovered(null); }}>自定义</button>
      </div>
      <div className="date-range-main">
        <div className="date-range-months">
          {[0, 1].map(offset => {
            const date = new Date(month.getFullYear(), month.getMonth() + offset, 1);
            const year = date.getFullYear(); const monthIndex = date.getMonth();
            const days = new Date(year, monthIndex + 1, 0).getDate();
            return <section className="date-range-month" key={offset} aria-label={`${year}年${monthIndex + 1}月`}>
              <div className="date-range-month-title">
                {offset === 0 && <button type="button" aria-label="上个月" onClick={() => setMonth(new Date(year, monthIndex - 1, 1))}>‹</button>}
                <strong>{year}年{monthIndex + 1}月</strong>
                {offset === 1 && <button type="button" aria-label="下个月" disabled={localDate(new Date(year, monthIndex + 1, 1)) > todayKey} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>}
              </div>
              <div className="date-range-days">
                {['日', '一', '二', '三', '四', '五', '六'].map(day => <span className="date-range-weekday" key={day}>{day}</span>)}
                {Array.from({ length: date.getDay() }, (_, index) => <span key={`empty-${index}`} />)}
                {Array.from({ length: days }, (_, index) => {
                  const day = index + 1;
                  const key = localDate(new Date(year, monthIndex, day));
                  const endpoint = preview && (preview.start === key || preview.end === key);
                  const within = preview && key >= preview.start && key <= preview.end;
                  return <button type="button" key={key} className={`${within ? 'in-range' : ''} ${endpoint ? 'range-end' : ''}`} disabled={key > todayKey} aria-label={key} aria-pressed={Boolean(within)} aria-current={key === todayKey ? 'date' : undefined} onPointerEnter={() => { if (start) setHovered(key); }} onFocus={() => { if (start) setHovered(key); }} onClick={() => choose(key)}>{day}</button>;
                })}
              </div>
            </section>;
          })}
        </div>
        <div className="date-range-footer"><span aria-live="polite">{start ? '请选择结束日期' : custom ? '请选择开始日期' : value ? `${value.start} 至 ${value.end}` : '按会话创建日期筛选'}</span><button type="button" disabled={!value} onClick={() => { onChange(null); close(); }}>清除筛选</button><button type="button" onClick={close}>关闭</button></div>
      </div>
    </div>, document.body)}
  </>;
}
