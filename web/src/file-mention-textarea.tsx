import { useEffect, useId, useRef, useState, type TextareaHTMLAttributes } from 'react';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  project: string;
  value: string;
  onChange: (value: string) => void;
};

export function FileMentionTextarea({ project, value, onChange, onKeyDown, disabled, ...props }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [cursor, setCursor] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [result, setResult] = useState<{ key: string; files: string[]; error?: string } | null>(null);
  const match = value.slice(0, cursor).match(/(?:^|\s)@([^\s@"]*)$/);
  const query = match?.[1];
  const start = query === undefined ? 0 : cursor - query.length - 1;
  const key = JSON.stringify([project, value, cursor]);
  const open = focused && !disabled && cursor >= 0 && Boolean(project) && query !== undefined && dismissed !== key;
  const searchKey = open ? JSON.stringify([project, query]) : '';
  const current = result?.key === searchKey ? result : null;
  const files = current?.files || [];

  useEffect(() => {
    setActiveIndex(0);
    if (!searchKey) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/projects/files?${new URLSearchParams({ path: project, query: query! })}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (!controller.signal.aborted) setResult({ key: searchKey, files: data as string[] });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key: searchKey, files: [], error: `搜索失败：${(error as Error).message}，请重新输入搜索词` });
      }
    }, 150);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [searchKey, project, query]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, current]);

  function choose(path: string) {
    const reference = /\s/.test(path) ? `@"${path}" ` : `@${path} `;
    const end = cursor + (value.slice(cursor).match(/^[^\s@"]*/)?.[0].length || 0);
    onChange(value.slice(0, start) + reference + value.slice(end));
    setDismissed(key);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(start + reference.length, start + reference.length);
    });
  }

  return <>
    {open && <div className="file-mention-menu">
      <div className="file-mention-heading">项目文件<span>↑↓ 选择 · Enter 插入 · Esc 关闭</span></div>
      <div ref={listRef} id={listId} role="listbox" aria-label="项目文件搜索结果" className="file-mention-list" aria-busy={!current}>
        {!current || current.error || !files.length ? <div className="file-mention-status" role="status">{!current ? '搜索中…' : current.error || '没有匹配文件，请修改搜索词'}</div> : files.map((path, index) => <button key={path} id={`${listId}-${index}`} type="button" role="option" aria-selected={index === activeIndex} tabIndex={-1} title={path} onPointerDown={event => event.preventDefault()} onClick={() => choose(path)}>{path}</button>)}
      </div>
    </div>}
    <textarea {...props} ref={textareaRef} value={value} disabled={disabled} aria-autocomplete="list" aria-controls={open ? listId : undefined} aria-activedescendant={open && files[activeIndex] ? `${listId}-${activeIndex}` : undefined}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onChange={event => { onChange(event.target.value); setCursor(event.target.selectionStart); }}
      onSelect={event => { const element = event.currentTarget; setCursor(element.selectionStart === element.selectionEnd ? element.selectionStart : -1); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (open) {
          if (event.key === 'Escape') { event.preventDefault(); setDismissed(key); return; }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (files.length) setActiveIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + files.length) % files.length);
            return;
          }
          if ((event.key === 'Enter' && !event.shiftKey) || (event.key === 'Tab' && files.length)) {
            event.preventDefault();
            if (files[activeIndex]) choose(files[activeIndex]);
            return;
          }
        }
        onKeyDown?.(event);
      }} />
  </>;
}
