import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectGitDiff, ProjectGitStatus } from '../types.js';
import { readProjectFile } from './files.js';

const execFileAsync = promisify(execFile);

async function git(project: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '-C', project, ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 10000 });
    return stdout;
  } catch (reason) {
    const error = reason as Error & { code?: string; stderr?: string; killed?: boolean };
    if (error.code === 'ENOENT') throw new Error('未找到 Git，请安装 Git 后刷新');
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('Git 输出超过 8 MiB，无法展示');
    if (error.killed) throw new Error('读取 Git 信息超时，请刷新重试');
    throw error;
  }
}

export async function readProjectGitStatus(project: string): Promise<ProjectGitStatus> {
  let root: string;
  try {
    root = (await git(project, ['rev-parse', '--show-toplevel'])).trimEnd();
  } catch (reason) {
    if ((reason as { stderr?: string }).stderr?.includes('not a git repository')) {
      return { repository: false, branch: null, commit: null, branches: [], changes: [] };
    }
    throw reason;
  }
  const [output, refs] = await Promise.all([
    git(project, ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', '.']),
    git(project, ['for-each-ref', '--sort=refname', '--format=%(refname)%00%(symref)', 'refs/heads/', 'refs/remotes/']),
  ]);
  const branches = refs.split('\n').filter(Boolean).flatMap(record => {
    const [ref, symbolicRef] = record.split('\0');
    if (symbolicRef) return [];
    const remote = ref!.startsWith('refs/remotes/');
    return [{ name: ref!.slice(remote ? 13 : 11), remote }];
  });
  const result: ProjectGitStatus = { repository: true, branch: null, commit: null, branches, changes: [] };
  const projectRoot = await realpath(project);
  const projectPath = (path: string) => relative(projectRoot, join(root, path)).split(sep).join('/');
  const records = output.split('\0');
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.startsWith('# branch.head ')) {
      const branch = record.slice(14);
      result.branch = branch === '(detached)' ? null : branch;
    } else if (record.startsWith('# branch.oid ')) {
      const commit = record.slice(13);
      result.commit = commit === '(initial)' ? null : commit;
    } else if (record.startsWith('? ')) {
      result.changes.push({ path: projectPath(record.slice(2)), indexStatus: '?', worktreeStatus: '?' });
    } else if (/^[12u] /.test(record)) {
      const fields = record.split(' ');
      const path = projectPath(fields.slice(record[0] === '1' ? 8 : record[0] === '2' ? 9 : 10).join(' '));
      const originalPath = record[0] === '2' ? projectPath(records[++index]!) : undefined;
      result.changes.push({ path, originalPath, indexStatus: fields[1]![0]!, worktreeStatus: fields[1]![1]! });
    }
  }
  return result;
}

export async function readProjectGitDiff(project: string, path: string): Promise<ProjectGitDiff> {
  const status = await readProjectGitStatus(project);
  const change = status.changes.find(change => change.path === path);
  if (!change) throw new Error('该文件已不在变更列表中，请刷新后重新选择');
  if (change.indexStatus === '?') return { staged: '', unstaged: '', untracked: await readProjectFile(project, path) };
  const paths = change.originalPath ? [change.path, change.originalPath] : [change.path];
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color'];
  const [staged, unstaged] = await Promise.all([
    git(project, [...args, '--cached', '--', ...paths]),
    git(project, [...args, '--', ...paths]),
  ]);
  return { staged, unstaged, untracked: null };
}

export async function switchProjectGitBranch(project: string, name: string, remote: boolean): Promise<void> {
  const status = await readProjectGitStatus(project);
  if (!status.branches.some(branch => branch.name === name && branch.remote === remote)) {
    throw new Error('分支已不存在，请刷新后重新选择');
  }
  try {
    if (!remote) {
      await git(project, ['switch', '--no-guess', '--', name]);
      return;
    }
    const localName = name.slice(name.indexOf('/') + 1);
    const remoteRef = `refs/remotes/${name}`;
    if (status.branches.some(branch => !branch.remote && branch.name === localName)) {
      const upstream = (await git(project, ['for-each-ref', '--format=%(upstream)', `refs/heads/${localName}`])).trimEnd();
      if (upstream !== remoteRef) throw new Error(`本地分支 ${localName} 已存在且未跟踪 ${name}，请从本地分支列表选择，或先在终端配置跟踪关系`);
      await git(project, ['switch', '--no-guess', '--', localName]);
    } else {
      await git(project, ['switch', '--track', '-c', localName, remoteRef]);
    }
  } catch (reason) {
    const error = reason as Error & { stderr?: string };
    throw new Error(`切换分支失败：${error.stderr?.trim() || error.message}`);
  }
}
