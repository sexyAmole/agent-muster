import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { PreviewRequest, PreviewResponse } from './file-preview.worker';

const lineHeight = 18;
const padding = 12;
const overscan = 12;
const emptyOffsets = new Uint32Array();
type Preview = { path: string; content: string; lineStarts: Uint32Array; lines: string[]; loaded: number; error?: string };

function lowerBound(values: Uint32Array, target: number) {
  let start = 0;
  let end = values.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (values[middle] < target) start = middle + 1;
    else end = middle;
  }
  return start;
}

function markMatches(html: string, lineStarts: Uint32Array, offsets: Uint32Array, length: number) {
  if (!length || !offsets.length) return html;
  const document = new DOMParser().parseFromString(html, 'text/html');
  for (const line of document.querySelectorAll<HTMLElement>('[data-line]')) {
    let offset = lineStarts[Number(line.dataset.line) - 1];
    let matchIndex = lowerBound(offsets, Math.max(0, offset - length + 1));
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      const text = node.data;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      while (matchIndex < offsets.length && offsets[matchIndex] < offset + text.length) {
        const start = Math.max(0, offsets[matchIndex] - offset);
        const end = Math.min(text.length, offsets[matchIndex] + length - offset);
        fragment.append(text.slice(cursor, start));
        const mark = document.createElement('mark');
        mark.dataset.match = String(matchIndex);
        mark.textContent = text.slice(start, end);
        fragment.append(mark);
        cursor = end;
        if (offsets[matchIndex] + length > offset + text.length) break;
        matchIndex++;
      }
      fragment.append(text.slice(cursor));
      node.replaceWith(fragment);
      offset += text.length;
    }
  }
  return document.body.innerHTML;
}

export function FileCodePreview({ path, content }: { path: string; content: string }) {
  const root = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const worker = useRef<Worker | null>(null);
  const openedPath = useRef<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeMatch, setActiveMatch] = useState(0);
  const [result, setResult] = useState<Preview | null>(null);
  const [matches, setMatches] = useState<{ path: string; content: string; query: string; offsets: Uint32Array } | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const current = result?.path === path ? result : null;
  const searchReady = matches?.path === path && matches.content === content && matches.query === query;
  const found = query && searchReady ? matches.offsets : emptyOffsets;
  const searching = Boolean(query && !searchReady);
  const selectedMatch = found.length ? activeMatch % found.length : 0;
  const count = current?.lineStarts.length ?? 0;
  const totalHeight = count * lineHeight + padding * 2;
  // 极多短行时压缩滚动轨道，避免超过浏览器的元素高度限制。
  const scrollHeight = Math.min(totalHeight, 8_000_000);
  const scale = totalHeight > scrollHeight && scrollHeight > viewport.height ? (totalHeight - viewport.height) / (scrollHeight - viewport.height) : 1;
  const logicalTop = viewport.top * scale;
  const start = Math.max(0, Math.floor((logicalTop - padding) / lineHeight) - overscan);
  const end = Math.min(count, Math.ceil((logicalTop + viewport.height - padding) / lineHeight) + overscan);
  const loaded = Math.min(current?.loaded ?? 0, end);
  const html = useMemo(() => {
    if (!current) return '';
    const lines: string[] = [];
    for (let index = start; index < end; index++) {
      lines.push(`<span class="line" data-line="${index + 1}">${current.lines[index] ?? '<span class="file-line-loading">加载中…</span>'}</span>`);
    }
    return markMatches(lines.join('\n'), current.lineStarts, found, query.length);
  }, [path, content, current?.lineStarts, loaded, start, end, found, query]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const panel = root.current?.closest('.file-panel');
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'f' || !root.current?.getClientRects().length) return;
      if (!panel?.contains(document.activeElement) && !panel?.matches(':hover')) return;
      event.preventDefault();
      searchInput.current?.focus();
      searchInput.current?.select();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const element = container.current!;
    const update = () => setViewport({ top: element.scrollTop, height: element.clientHeight });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const instance = new Worker(new URL('./file-preview.worker.ts', import.meta.url), { type: 'module' });
    worker.current = instance;
    const lines: string[] = [];
    let lineStarts: Uint32Array = emptyOffsets;
    let loaded = 0;
    const fail = (message: string) => setResult({ path, content, lineStarts, lines, loaded, error: `语法高亮加载失败：${message}。请刷新页面重试。` });
    instance.onmessage = (event: MessageEvent<PreviewResponse>) => {
      const message = event.data;
      if (message.type === 'ready') {
        lineStarts = message.lineStarts;
        setResult({ path, content, lineStarts, lines, loaded });
      } else if (message.type === 'chunk') {
        message.lines.forEach((html, index) => { lines[message.start + index] = html; });
        loaded = message.start + message.lines.length;
        setResult({ path, content, lineStarts, lines, loaded });
      } else if (message.type === 'matches') {
        setMatches({ path, content, query: message.query, offsets: message.offsets });
      } else fail(message.message);
    };
    instance.onerror = event => { event.preventDefault(); fail(event.message); };
    instance.postMessage({ type: 'open', path, content } satisfies PreviewRequest);
    if (openedPath.current !== path) container.current?.scrollTo(0, 0);
    openedPath.current = path;
    return () => { worker.current = null; instance.terminate(); };
  }, [path, content]);

  useEffect(() => {
    const timer = window.setTimeout(() => worker.current?.postMessage({ type: 'search', query } satisfies PreviewRequest), 150);
    return () => window.clearTimeout(timer);
  }, [path, content, query]);

  useEffect(() => { setActiveMatch(0); }, [path, content, query]);

  useEffect(() => {
    if (!found.length || !current) return;
    const line = Math.max(0, lowerBound(current.lineStarts, found[selectedMatch] + 1) - 1);
    const element = container.current!;
    const top = padding + line * lineHeight;
    const visibleTop = element.scrollTop * scale;
    if (top < visibleTop || top + lineHeight > visibleTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - (element.clientHeight - lineHeight) / 2) / scale;
    }
  }, [found, selectedMatch, current?.lineStarts, scale]);

  useEffect(() => {
    const marks = container.current?.querySelectorAll<HTMLElement>('mark[data-match]');
    marks?.forEach(mark => mark.classList.toggle('file-match-active', Number(mark.dataset.match) === selectedMatch));
    const selected = container.current?.querySelector<HTMLElement>(`[data-match="${selectedMatch}"]`);
    if (selected && container.current) {
      const bounds = selected.getBoundingClientRect();
      const visible = container.current.getBoundingClientRect();
      if (bounds.left < visible.left || bounds.right > visible.right) container.current.scrollLeft += bounds.left - visible.left - 80;
    }
  }, [html, selectedMatch]);

  function moveMatch(direction: number) {
    if (found.length) setActiveMatch((selectedMatch + direction + found.length) % found.length);
  }

  const style = { '--file-line-digits': `${String(count).length}ch` } as CSSProperties;
  return <div ref={root} className="file-code-view">
    <div className="file-find-bar">
      <input ref={searchInput} type="search" aria-label="查找当前文件内容" aria-keyshortcuts="Meta+f Control+f" placeholder="查找关键字" value={query} onChange={event => { setQuery(event.target.value); setActiveMatch(0); }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setQuery(''); }
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); }
      }} />
      <span className="file-find-count" role="status">{query ? searching ? '查找中…' : found.length ? `${selectedMatch + 1} / ${found.length}` : '无匹配' : ''}</span>
      <button type="button" aria-label="上一个匹配" disabled={!found.length || searching} onClick={() => moveMatch(-1)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button>
      <button type="button" aria-label="下一个匹配" disabled={!found.length || searching} onClick={() => moveMatch(1)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button>
    </div>
    <div ref={container} className="file-preview" style={style} aria-busy={!current || current.content !== content || (!current.error && loaded < end)} onScroll={event => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
      {!current ? <p className="file-panel-status" role="status">正在加载语法高亮…</p>
        : current.error ? <p className="file-panel-status file-panel-error" role="alert">{current.error}</p>
          : <pre className="shiki" tabIndex={0} aria-label="文件内容" style={{ height: scrollHeight }}><code style={{ top: padding + start * lineHeight - viewport.top * (scale - 1) }} dangerouslySetInnerHTML={{ __html: html }} /></pre>}
    </div>
  </div>;
}
