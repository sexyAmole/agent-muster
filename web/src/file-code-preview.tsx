import { useEffect, useRef, useState, type CSSProperties } from 'react';
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

export function FileCodePreview({ path, content }: { path: string; content: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<Preview | null>(null);
  const current = result?.path === path && result.content === content ? result : null;

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
  return <div ref={container} className="file-preview" style={style} aria-busy={!current}>
    {!current ? <p className="file-panel-status" role="status">正在加载语法高亮…</p>
      : current.error ? <p className="file-panel-status file-panel-error" role="alert">{current.error}</p>
        : <div dangerouslySetInnerHTML={{ __html: current.html! }} />}
  </div>;
}
