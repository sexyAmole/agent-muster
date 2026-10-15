import { useEffect, useState } from 'react';
import type { ProjectFileDetail, ProjectFileEntry } from '../../src/types';

type Resource<T> = { key: string; data?: T; error?: string };

function useFileResource<T>(url: string, revision: number) {
  const key = JSON.stringify([url, revision]);
  const [result, setResult] = useState<Resource<T> | null>(null);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (!controller.signal.aborted) setResult({ key, data: data as T });
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ key, error: `读取失败：${(error as Error).message}。请点击刷新重试。` });
    });
    return () => controller.abort();
  }, [url, key]);
  return result?.key === key ? result : null;
}

function DirectoryEntries({ project, directory, revision, selected, onSelect }: {
  project: string; directory: string; revision: number; selected: string | null; onSelect: (path: string) => void;
}) {
  const result = useFileResource<ProjectFileEntry[]>(`/api/projects/tree?${new URLSearchParams({ path: project, directory })}`, revision);
  const [expanded, setExpanded] = useState<string[]>([]);
  if (!result) return <p className="file-panel-status" role="status">加载中…</p>;
  if (result.error) return <p className="file-panel-status file-panel-error" role="alert">{result.error}</p>;
  if (!result.data?.length) return <p className="file-panel-status">空目录</p>;
  return <ul className="file-tree-list">{result.data.map(entry => {
    const isDirectory = entry.type === 'directory';
    const open = expanded.includes(entry.path);
    return <li key={entry.path}>
      <button type="button" className="file-tree-entry" title={`${entry.path}${entry.type === 'symlink' ? '（符号链接）' : ''}`} aria-expanded={isDirectory ? open : undefined} aria-pressed={!isDirectory ? selected === entry.path : undefined}
        onClick={() => isDirectory ? setExpanded(current => open ? current.filter(path => path !== entry.path) : [...current, entry.path]) : onSelect(entry.path)}>
        <span className="file-tree-marker" aria-hidden="true">{isDirectory ? open ? '▾' : '▸' : entry.type === 'symlink' ? '↗' : '·'}</span><span>{entry.name}</span>
      </button>
      {isDirectory && open && <DirectoryEntries project={project} directory={entry.path} revision={revision} selected={selected} onSelect={onSelect} />}
    </li>;
  })}</ul>;
}

const previewMessages: Record<Exclude<ProjectFileDetail['preview'], 'text'>, string> = {
  binary: '二进制文件，仅展示基本信息。',
  'too-large': '文件超过 1 MiB，仅展示基本信息。',
  unsupported: '文件不是支持的 UTF-8 编码，仅展示基本信息。',
};

export function FilePanel({ project, onClose }: { project: string; onClose: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const result = useFileResource<ProjectFileDetail>(selected === null ? '' : `/api/projects/file?${new URLSearchParams({ path: project, file: selected })}`, revision);
  const file = result?.data;
  return <aside className="file-panel" aria-label="项目文件面板">
    <header className="file-panel-header"><strong>文件</strong><div><button type="button" onClick={() => setRevision(value => value + 1)} aria-label="刷新文件"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 6.1A8 8 0 0 1 19.7 10M4.3 14A8 8 0 0 0 17.9 17.9" /></svg></button><button type="button" onClick={onClose} aria-label="关闭文件面板"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div></header>
    <div className="file-panel-body">
      <section className="file-detail" aria-label="文件详情" aria-busy={selected !== null && !result}>
        {selected === null ? <p className="file-panel-status">从右侧文件树选择文件</p> : !result ? <p className="file-panel-status" role="status">正在读取文件…</p> : result.error ? <p className="file-panel-status file-panel-error" role="alert">{result.error}</p> : file && <>
          <dl className="file-metadata"><div><dt>路径</dt><dd>{file.path}</dd></div><div><dt>类型</dt><dd>{file.type}</dd></div><div><dt>大小</dt><dd>{file.size.toLocaleString()} 字节</dd></div><div><dt>修改时间</dt><dd>{new Date(file.modifiedAt).toLocaleString('zh-CN')}</dd></div></dl>
          {file.preview === 'text' ? file.content ? <pre className="file-preview" tabIndex={0} aria-label="文件内容">{file.content}</pre> : <p className="file-panel-status">空文件</p> : <p className="file-panel-status">{previewMessages[file.preview]}</p>}
        </>}
      </section>
      <nav className="file-tree" aria-label="项目文件树"><div className="file-tree-project" title={project}>{project.split(/[\\/]/).filter(Boolean).at(-1)}</div><DirectoryEntries project={project} directory="" revision={revision} selected={selected} onSelect={setSelected} /></nav>
    </div>
  </aside>;
}
