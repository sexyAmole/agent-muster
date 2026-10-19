import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguages, type BundledLanguage } from 'shiki/langs';

const highlighter = createHighlighterCore({
  themes: [import('shiki/themes/github-light.mjs')],
  langs: [],
  engine: createJavaScriptRegexEngine(),
});
const fileLanguages = new Map<string, BundledLanguage>([
  ['h', 'c'], ['cc', 'cpp'], ['cxx', 'cpp'], ['hpp', 'cpp'], ['hxx', 'cpp'],
  ['htm', 'html'], ['bashrc', 'shellscript'], ['zshrc', 'shellscript'], ['env', 'dotenv'],
]);

function fileLanguage(path: string): BundledLanguage | 'text' {
  const name = path.split(/[\\/]/).at(-1)!.toLowerCase();
  if (name === '.env' || name.startsWith('.env.')) return 'dotenv';
  const parts = name.split('.');
  for (let index = 0; index < parts.length; index++) {
    const suffix = parts.slice(index).join('.');
    const language = fileLanguages.get(suffix) ?? suffix;
    if (Object.hasOwn(bundledLanguages, language)) return language as BundledLanguage;
  }
  return 'text';
}

type Preview = { path: string; content: string; html?: string; error?: string };

function findMatches(html: string, query: string) {
  if (!query) return { html, count: 0 };
  const document = new DOMParser().parseFromString(html, 'text/html');
  const code = document.querySelector('code')!;
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const matches = Array.from(code.textContent.matchAll(pattern));
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  let offset = 0;
  let matchIndex = 0;
  for (const node of nodes) {
    const text = node.data;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    while (matchIndex < matches.length && matches[matchIndex].index < offset + text.length) {
      const match = matches[matchIndex];
      const start = Math.max(0, match.index - offset);
      const end = Math.min(text.length, match.index + match[0].length - offset);
      fragment.append(text.slice(cursor, start));
      const mark = document.createElement('mark');
      mark.dataset.match = String(matchIndex);
      mark.textContent = text.slice(start, end);
      fragment.append(mark);
      cursor = end;
      if (match.index + match[0].length > offset + text.length) break;
      matchIndex++;
    }
    fragment.append(text.slice(cursor));
    node.replaceWith(fragment);
    offset += text.length;
  }
  return { html: document.body.innerHTML, count: matches.length };
}

export function FileCodePreview({ path, content }: { path: string; content: string }) {
  const root = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [activeMatch, setActiveMatch] = useState(0);
  const [result, setResult] = useState<Preview | null>(null);
  const current = result?.path === path && result.content === content ? result : null;
  const found = useMemo(() => findMatches(current?.html ?? '', current?.html ? query : ''), [current?.html, query]);
  const selectedMatch = found.count ? activeMatch % found.count : 0;

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

  useEffect(() => { setActiveMatch(0); }, [path, content, query]);

  useEffect(() => {
    const marks = container.current?.querySelectorAll<HTMLElement>('mark[data-match]');
    marks?.forEach(mark => mark.classList.toggle('file-match-active', Number(mark.dataset.match) === selectedMatch));
    container.current?.querySelector(`[data-match="${selectedMatch}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [found.html, selectedMatch]);

  function moveMatch(direction: number) {
    if (found.count) setActiveMatch((selectedMatch + direction + found.count) % found.count);
  }

  useEffect(() => {
    let active = true;
    container.current?.scrollTo(0, 0);
    async function highlight() {
      try {
        const instance = await highlighter;
        const language = fileLanguage(path);
        if (language !== 'text') await instance.loadLanguage(bundledLanguages[language]);
        if (!active) return;
        const html = instance.codeToHtml(content, {
          lang: language,
          theme: 'github-light',
          transformers: [{
            pre(node) { node.properties.tabIndex = 0; node.properties['aria-label'] = '文件内容'; },
            line(node, line) { node.properties['data-line'] = line; },
          }],
        });
        if (active) setResult({ path, content, html });
      } catch (reason) {
        if (active) setResult({ path, content, error: `语法高亮加载失败：${(reason as Error).message}。请刷新页面重试。` });
      }
    }
    void highlight();
    return () => { active = false; };
  }, [path, content]);

  const style = { '--file-line-digits': `${String(content.split(/\r\n?|\n/).length).length}ch` } as CSSProperties;
  return <div ref={root} className="file-code-view">
    <div className="file-find-bar">
      <input ref={searchInput} type="search" aria-label="查找当前文件内容" aria-keyshortcuts="Meta+f Control+f" placeholder="查找关键字" value={query} onChange={event => { setQuery(event.target.value); setActiveMatch(0); }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setQuery(''); }
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); }
      }} />
      <span className="file-find-count" role="status">{query ? found.count ? `${selectedMatch + 1} / ${found.count}` : '无匹配' : ''}</span>
      <button type="button" aria-label="上一个匹配" disabled={!found.count} onClick={() => moveMatch(-1)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg></button>
      <button type="button" aria-label="下一个匹配" disabled={!found.count} onClick={() => moveMatch(1)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button>
    </div>
    <div ref={container} className="file-preview" style={style} aria-busy={!current}>
    {!current ? <p className="file-panel-status" role="status">正在加载语法高亮…</p>
      : current.error ? <p className="file-panel-status file-panel-error" role="alert">{current.error}</p>
        : <div dangerouslySetInnerHTML={{ __html: found.html }} />}
    </div>
  </div>;
}
