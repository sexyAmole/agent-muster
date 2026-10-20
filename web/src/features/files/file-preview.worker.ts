import { createHighlighterCore, hastToHtml, type GrammarState } from 'shiki/core';
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

export type PreviewRequest = { type: 'open'; path: string; content: string } | { type: 'search'; query: string };
export type PreviewResponse =
  | { type: 'ready'; lineStarts: Uint32Array }
  | { type: 'chunk'; start: number; lines: string[] }
  | { type: 'matches'; query: string; offsets: Uint32Array }
  | { type: 'error'; message: string };

let source = '';

function send(message: PreviewResponse, transfer: Transferable[] = []) {
  postMessage(message, { transfer });
}

async function openFile(path: string, content: string) {
  source = content;
  const lines = content.split(/\r\n?|\n/);
  const starts = [0];
  for (const match of content.matchAll(/\r\n?|\n/g)) starts.push(match.index + match[0].length);
  const lineStarts = new Uint32Array(starts);
  send({ type: 'ready', lineStarts }, [lineStarts.buffer]);
  const instance = await highlighter;
  const language = fileLanguage(path);
  if (language !== 'text') await instance.loadLanguage(bundledLanguages[language]);
  // 延续语法状态，保留跨批次的注释和字符串高亮。
  let grammarState: GrammarState | undefined;
  for (let start = 0; start < lines.length;) {
    let end = start;
    let length = 0;
    do { length += lines[end++].length + 1; }
    while (end < lines.length && end - start < 256 && length < 64 * 1024);
    const tree = instance.codeToHast(lines.slice(start, end).join('\n'), {
      lang: language,
      theme: 'github-light',
      grammarState,
    });
    grammarState = instance.getLastGrammarState(tree);
    const pre = tree.children.find(node => node.type === 'element')!;
    const code = pre.children.find(node => node.type === 'element')!;
    const highlighted = code.children.filter(node => node.type === 'element').map(node => node.children.map(child => hastToHtml(child)).join(''));
    send({ type: 'chunk', start, lines: highlighted });
    start = end;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

self.onmessage = (event: MessageEvent<PreviewRequest>) => {
  const message = event.data;
  if (message.type === 'open') {
    void openFile(message.path, message.content).catch(reason => send({ type: 'error', message: (reason as Error).message }));
  } else {
    const pattern = new RegExp(message.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const positions = new Uint32Array(message.query ? Math.floor(source.length / message.query.length) : 0);
    let count = 0;
    if (message.query) {
      for (const match of source.matchAll(pattern)) positions[count++] = match.index;
    }
    const offsets = positions.slice(0, count);
    send({ type: 'matches', query: message.query, offsets }, [offsets.buffer]);
  }
};
