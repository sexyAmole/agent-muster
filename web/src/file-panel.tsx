import { apiUrl } from './api-url';
import { lazy, Suspense, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { FileTreeIcon } from './file-tree-icon';
import type { ProjectFileDetail, ProjectFileEntry, ProjectGitChange, ProjectGitDiff, ProjectGitStatus } from '../../src/types';

const FileCodePreview = lazy(() => import('./file-code-preview').then(module => ({ default: module.FileCodePreview })));

type Resource<T> = { key: string; data?: T; error?: string };

function useFileResource<T>(url: string, revision: number) {
  const key = JSON.stringify([url, revision]);
  const [result, setResult] = useState<Resource<T> | null>(null);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    fetch(apiUrl(url), { signal: controller.signal }).then(async response => {
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
        <FileTreeIcon name={entry.name} directory={isDirectory} expanded={open} /><span>{entry.name}</span>
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

function GitDiffPreview({ title, content, showTitle = false, added = false }: { title: string; content: string; showTitle?: boolean; added?: boolean }) {
  let inHunk = false;
  const lines = content.replace(/\n$/, '').split('\n').flatMap(line => {
    if (added) return [`+${line}`];
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      return [];
    }
    if (line.startsWith('@@')) inHunk = true;
    return !inHunk && /^(index |--- |\+\+\+ )/.test(line) ? [] : [line];
  });
  return <section className="git-diff-section" aria-label={title}>
    {showTitle && <h3>{title}</h3>}
    <pre className="git-diff" tabIndex={0} aria-label={`${title}差异`}>{lines.map((line, index) => <span key={index} className={line.startsWith('+') ? 'git-diff-added' : line.startsWith('-') ? 'git-diff-removed' : line.startsWith('@@') ? 'git-diff-hunk' : undefined}>{line}</span>)}</pre>
  </section>;
}

const gitStatusNames: Record<string, string> = { M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', T: '类型变化', U: '冲突' };

function gitChangeLabel(change: ProjectGitChange): string {
  if (change.indexStatus === '?') return '未跟踪';
  if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(change.indexStatus + change.worktreeStatus)) return '冲突';
  return [change.indexStatus !== '.' ? `已暂存${gitStatusNames[change.indexStatus]}` : '', change.worktreeStatus !== '.' ? `未暂存${gitStatusNames[change.worktreeStatus]}` : ''].filter(Boolean).join('，');
}

function GitChangesTree({ changes, directory = '', selected, onSelect }: { changes: ProjectGitChange[]; directory?: string; selected: string | null; onSelect: (path: string) => void }) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const folders = new Map<string, ProjectGitChange[]>();
  const files: ProjectGitChange[] = [];
  for (const change of changes) {
    const path = change.path.slice(directory.length);
    const separator = path.indexOf('/');
    if (separator === -1) files.push(change);
    else {
      const name = path.slice(0, separator);
      const children = folders.get(name);
      if (children) children.push(change);
      else folders.set(name, [change]);
    }
  }
  return <ul className="file-tree-list">
    {[...folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, children]) => {
      const open = !collapsed.includes(name);
      const path = `${directory}${name}/`;
      return <li key={path}>
        <button type="button" className="file-tree-entry" title={path} aria-expanded={open} onClick={() => setCollapsed(current => open ? [...current, name] : current.filter(value => value !== name))}>
          <FileTreeIcon name={name} directory expanded={open} /><span>{name}</span>
        </button>
        {open && <GitChangesTree changes={children} directory={path} selected={selected} onSelect={onSelect} />}
      </li>;
    })}
    {files.sort((a, b) => a.path.localeCompare(b.path)).map(change => <li key={change.path}>
      <button type="button" className="file-tree-entry" title={change.path} aria-pressed={selected === change.path} onClick={() => onSelect(change.path)}>
        <FileTreeIcon name={change.path.split('/').at(-1)!} directory={false} expanded={false} /><span>{change.path.slice(directory.length)}</span>
      </button>
    </li>)}
  </ul>;
}

function FileTreeResizer({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const drag = useRef({ x: 0, width: 0 });
  function resize(element: HTMLDivElement, value: number) {
    onResize(Math.max(140, Math.min(element.parentElement!.clientWidth - 105, value)));
  }
  return <div className="file-tree-resizer" role="separator" tabIndex={0} aria-label="调整目录树宽度" aria-orientation="vertical" aria-valuenow={width} aria-valuemin={140}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      drag.current = { x: event.clientX, width: event.currentTarget.nextElementSibling!.getBoundingClientRect().width };
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.currentTarget, drag.current.width + drag.current.x - event.clientX);
    }} onPointerUp={event => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = event.currentTarget.nextElementSibling!.getBoundingClientRect().width;
      resize(event.currentTarget, event.key === 'Home' ? 140 : event.key === 'End' ? event.currentTarget.parentElement!.clientWidth - 105 : current + (event.key === 'ArrowLeft' ? 20 : -20));
    }} />;
}

function GitPanel({ project, revision, showTree, treeId, resizer, onBranchSwitched }: { project: string; revision: number; showTree: boolean; treeId: string; resizer: ReactNode; onBranchSwitched: () => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const branchesMenu = useRef<HTMLDetailsElement>(null);
  const restoreBranchFocus = useRef(false);
  const selectedHeading = useRef<HTMLButtonElement>(null);
  const status = useFileResource<ProjectGitStatus>(`/api/projects/git?${new URLSearchParams({ path: project })}`, revision);
  const current = status?.data;
  const selectedChange = current?.changes.find(change => change.path === selected);
  const result = useFileResource<ProjectGitDiff>(selectedChange ? `/api/projects/git-diff?${new URLSearchParams({ path: project, file: selectedChange.path })}` : '', revision);
  const diff = result?.data;
  const untracked = diff?.untracked;
  useEffect(() => {
    selectedHeading.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedChange?.path]);
  useEffect(() => {
    if (current && restoreBranchFocus.current) {
      branchesMenu.current?.querySelector('summary')?.focus();
      restoreBranchFocus.current = false;
    }
  }, [current]);
  async function switchBranch(name: string, remote: boolean) {
    if (switching) return;
    setSwitching(true);
    setSwitchError(null);
    try {
      const response = await fetch(apiUrl('/api/projects/git-branch'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: project, name, remote }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setSelected(null);
      if (branchesMenu.current) {
        branchesMenu.current.open = false;
      }
      restoreBranchFocus.current = true;
      onBranchSwitched();
    } catch (reason) {
      setSwitchError((reason as Error).message);
    } finally {
      setSwitching(false);
    }
  }
  return <div className="git-panel">
    {current?.repository && <div className="git-toolbar">
      <details ref={branchesMenu} className="git-branches" onKeyDown={event => {
        if (event.key === 'Escape') {
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }
      }}>
        <summary><span>分支</span><strong title={current.branch ?? current.commit ?? undefined}>{current.branch ?? `分离 HEAD · ${current.commit?.slice(0, 7)}`}</strong><svg className="git-branch-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></summary>
        <div className="git-branches-menu">
          {switching && <p role="status">正在切换分支…</p>}
          {switchError && <p className="file-panel-error" role="alert">{switchError}</p>}
          {[false, true].map(remote => <section key={String(remote)} aria-label={remote ? '远程分支' : '本地分支'}>
            <h3>{remote ? '远程分支' : '本地分支'}</h3>
            {current.branches.some(branch => branch.remote === remote) ? <ul>{current.branches.filter(branch => branch.remote === remote).map(branch => <li key={branch.name}>
              <button type="button" disabled={switching || (!remote && branch.name === current.branch)} aria-label={`切换到${remote ? '远程' : '本地'}分支 ${branch.name}`} onClick={() => void switchBranch(branch.name, remote)}>
                <span className="git-branch-name" title={branch.name}>{branch.name}</span>
                {!remote && branch.name === current.branch && <span className="git-branch-current">当前</span>}
              </button>
            </li>)}</ul> : <p>{remote ? '没有远程跟踪分支' : '没有本地分支'}</p>}
          </section>)}
        </div>
      </details>
    </div>}
    <div className="file-panel-body">
      <section className="file-detail git-changes" aria-label="Git 变更详情">
        {!status ? <p className="file-panel-status" role="status">正在读取 Git 状态…</p> : status.error ? <p className="file-panel-status file-panel-error" role="alert">{status.error}</p> : current && (!current.repository ? <p className="file-panel-status">当前项目不是 Git 仓库</p> : !current.changes.length ? <p className="file-panel-status">工作区干净，没有变更文件</p> : current.changes.map(change => <div className="git-file" key={change.path}>
          <button ref={selectedChange?.path === change.path ? selectedHeading : undefined} type="button" className="git-file-heading" aria-expanded={selectedChange?.path === change.path} aria-controls={selectedChange?.path === change.path ? `${treeId}-diff` : undefined} title={change.originalPath ? `${change.originalPath} → ${change.path}` : change.path} onClick={() => setSelected(selected === change.path ? null : change.path)}>
            <FileTreeIcon name={change.path.split('/').at(-1)!} directory={false} expanded={false} />
            <span className="git-file-path">{change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}</span>
            <span className="git-file-status">{gitChangeLabel(change)}</span>
          </button>
          {selectedChange?.path === change.path && <div id={`${treeId}-diff`} className="git-file-diff" aria-busy={!result}>
            {!result ? <p className="file-panel-status" role="status">正在读取差异…</p> : result.error ? <p className="file-panel-status file-panel-error" role="alert">{result.error}</p> : diff && <>
              {diff.staged && <GitDiffPreview title="已暂存" content={diff.staged} showTitle={Boolean(diff.unstaged)} />}
              {diff.unstaged && <GitDiffPreview title="未暂存" content={diff.unstaged} showTitle={Boolean(diff.staged)} />}
              {untracked && (untracked.preview === 'text' ? untracked.content ? <GitDiffPreview title="未跟踪文件" content={untracked.content} added /> : <p className="file-panel-status">未跟踪的空文件</p> : <p className="file-panel-status">{previewMessages[untracked.preview]}</p>)}
              {!untracked && !diff.staged && !diff.unstaged && <p className="file-panel-status">没有可显示的文本差异，文件可能仅有子模块状态变化</p>}
            </>}
          </div>}
        </div>))}
      </section>
      {resizer}
      <nav className="file-tree" id={treeId} aria-label="Git 变更文件" hidden={!showTree}>
        {current?.repository && <div className="file-tree-content"><GitChangesTree changes={current.changes} selected={selected} onSelect={setSelected} /></div>}
      </nav>
    </div>
  </div>;
}

export function FilePanel({ project, onClose }: { project: string; onClose: () => void }) {
  const [showGit, setShowGit] = useState(false);
  const [showTree, setShowTree] = useState(true);
  const [treeWidth, setTreeWidth] = useState(200);
  const tabsId = useId();
  const tabsRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [includeContent, setIncludeContent] = useState(false);
  const [revision, setRevision] = useState(0);
  const [copyResult, setCopyResult] = useState<{ path: string; error?: string } | null>(null);
  const result = useFileResource<ProjectFileDetail>(selected === null ? '' : `/api/projects/file?${new URLSearchParams({ path: project, file: selected })}`, revision);
  const query = search.trim();
  const searchResult = useFileResource<string[]>(query ? `/api/projects/files?${new URLSearchParams({ path: project, query, content: String(includeContent) })}` : '', revision);
  const file = result?.data;
  const copied = copyResult?.path === file?.path && !copyResult?.error;
  useEffect(() => {
    if (!copyResult || copyResult.error) return;
    const timer = window.setTimeout(() => setCopyResult(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copyResult]);
  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      setCopyResult({ path });
    } catch (reason) {
      setCopyResult({ path, error: `复制路径失败：${(reason as Error).message}` });
    }
  }
  return <aside className={`file-panel${showTree ? '' : ' tree-hidden'}`} aria-label="项目文件面板" style={{ '--file-tree-width': `${treeWidth}px` } as CSSProperties}>
    <header className="file-panel-header">
      <div ref={tabsRef} className="tabs-list" role="tablist" aria-label="面板视图">
        {['文件', 'Git'].map((label, index) => <button key={label} id={`${tabsId}-tab-${index}`} type="button" className="tabs-trigger" role="tab" aria-selected={showGit === (index === 1)} aria-controls={`${tabsId}-panel-${index}`} tabIndex={showGit === (index === 1) ? 0 : -1}
          onClick={() => setShowGit(index === 1)} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
            setShowGit(next === 1);
            tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next].focus();
          }}>{label}</button>)}
      </div>
      <div className="file-panel-actions"><button type="button" onClick={() => setShowTree(value => !value)} aria-label={showTree ? '隐藏目录树' : '显示目录树'} aria-expanded={showTree} aria-controls={`${tabsId}-tree-${showGit ? 1 : 0}`}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /><path d={showTree ? 'm7 9 3 3-3 3' : 'm10 9-3 3 3 3'} /></svg></button><button type="button" onClick={() => setRevision(value => value + 1)} aria-label={showGit ? '刷新 Git 状态' : '刷新文件'}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 6.1A8 8 0 0 1 19.7 10M4.3 14A8 8 0 0 0 17.9 17.9" /></svg></button><button type="button" onClick={onClose} aria-label="关闭文件面板"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div></header>
    <div className="file-panel-tabpanel" id={`${tabsId}-panel-1`} role="tabpanel" aria-labelledby={`${tabsId}-tab-1`} hidden={!showGit}>
      {showGit && <GitPanel project={project} revision={revision} showTree={showTree} treeId={`${tabsId}-tree-1`} resizer={showTree && <FileTreeResizer width={treeWidth} onResize={setTreeWidth} />} onBranchSwitched={() => setRevision(value => value + 1)} />}
    </div>
    <div className="file-panel-body" id={`${tabsId}-panel-0`} role="tabpanel" aria-labelledby={`${tabsId}-tab-0`} hidden={showGit}>
      <section className="file-detail" aria-label="文件详情" aria-busy={selected !== null && !result}>
        {selected === null ? <p className="file-panel-status">从右侧文件树选择文件</p> : !result ? <p className="file-panel-status" role="status">正在读取文件…</p> : result.error ? <p className="file-panel-status file-panel-error" role="alert">{result.error}</p> : file && <>
          <div className="file-metadata"><span className="file-size-tag">{file.size.toLocaleString()} 字节</span><span className="file-path" title={file.path}>{file.path}</span><button type="button" className="copy-button" aria-label={copied ? '已复制路径' : '复制文件路径'} onClick={() => void copyPath(file.path)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{copied ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" /></>}</svg></button></div>
          {copyResult?.path === file.path && copyResult.error && <p className="file-panel-status file-panel-error" role="alert">{copyResult.error}</p>}
          {file.preview === 'text' ? file.content ? <Suspense fallback={<p className="file-panel-status" role="status">正在加载代码预览…</p>}><FileCodePreview path={file.path} content={file.content} /></Suspense> : <p className="file-panel-status">空文件</p> : <p className="file-panel-status">{previewMessages[file.preview]}</p>}
        </>}
      </section>
      {showTree && <FileTreeResizer width={treeWidth} onResize={setTreeWidth} />}
      <nav className="file-tree" id={`${tabsId}-tree-0`} aria-label="项目文件树" hidden={!showTree}>
        <div className="file-tree-search">
          <div className="file-tree-search-row">
            <input type="search" aria-label="搜索项目文件" placeholder={includeContent ? '搜索文件名、路径或内容' : '搜索文件名或路径'} value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setSearch(''); }} />
            <button type="button" className="file-tree-search-toggle" aria-label="搜索文件内容" aria-pressed={includeContent} onClick={() => setIncludeContent(value => !value)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h7M14 2v6h6M14 2l6 6v3M8 12h4M8 16h3" /><circle cx="17" cy="16" r="3" /><path d="m19.2 18.2 2.8 2.8" /></svg></button>
          </div>
          {includeContent && <p className="file-tree-search-hint">内容搜索支持 1 MiB 以内的 UTF-8 文本文件</p>}
        </div>
        <div className="file-tree-content" hidden={Boolean(query)}><DirectoryEntries project={project} directory="" revision={revision} selected={selected} onSelect={setSelected} /></div>
        {query && <div className="file-tree-content" aria-label="文件搜索结果" aria-busy={!searchResult}>
          {!searchResult ? <p className="file-panel-status" role="status">搜索中…</p> : searchResult.error ? <p className="file-panel-status file-panel-error" role="alert">{searchResult.error}</p> : !searchResult.data?.length ? <p className="file-panel-status" role="status">没有匹配文件，请修改搜索词</p> : <>
            <ul className="file-tree-list">{searchResult.data.map(path => <li key={path}><button type="button" className="file-tree-entry" title={path} aria-pressed={selected === path} onClick={() => setSelected(path)}><FileTreeIcon name={path.split('/').at(-1)!} directory={false} expanded={false} /><span>{path}</span></button></li>)}</ul>
            {searchResult.data.length === 50 && <p className="file-panel-status">最多显示 50 个文件，可输入更完整的路径缩小范围</p>}
          </>}
        </div>}
      </nav>
    </div>
  </aside>;
}
