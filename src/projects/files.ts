import { open, readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ProjectFileDetail, ProjectFileEntry } from '../types.js';

const excludedDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);

async function resolveProjectPath(project: string, path: string): Promise<string> {
  if (isAbsolute(path)) throw new Error('需要项目内的相对路径');
  const root = await realpath(project);
  const target = resolve(root, path);
  const withinProject = (value: string) => {
    const result = relative(root, value);
    return result !== '..' && !result.startsWith(`..${sep}`) && !isAbsolute(result);
  };
  if (!withinProject(target)) throw new Error('不能访问项目目录之外的路径');
  const actual = await realpath(target);
  if (!withinProject(actual)) throw new Error('不能访问指向项目目录之外的符号链接');
  return actual;
}

export async function listProjectDirectory(project: string, directory: string): Promise<ProjectFileEntry[]> {
  const target = await resolveProjectPath(project, directory);
  if (!(await stat(target)).isDirectory()) throw new Error('目标不是目录');
  const entries = await readdir(target, { withFileTypes: true });
  return entries.map((entry): ProjectFileEntry => ({
    name: entry.name,
    path: relative(resolve(project), resolve(project, directory, entry.name)).split(sep).join('/'),
    type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
  })).sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
}

export async function readProjectFile(project: string, file: string): Promise<ProjectFileDetail> {
  const path = await resolveProjectPath(project, file);
  if (!(await stat(path)).isFile()) throw new Error('目标不是普通文件');
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('目标不是普通文件');
    const detail: ProjectFileDetail = {
      path, type: extname(path) || '无扩展名', size: info.size, modifiedAt: info.mtimeMs, preview: 'text',
    };
    const limit = 10 * 1024 * 1024;
    if (info.size > limit) return { ...detail, preview: 'too-large' };
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) return { ...detail, preview: 'too-large' };
    const bytes = buffer.subarray(0, length);
    if (bytes.some(byte => byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13))) {
      return { ...detail, preview: 'binary' };
    }
    try {
      return { ...detail, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      return { ...detail, preview: 'unsupported' };
    }
  } finally { await handle.close(); }
}

export async function searchProjectFiles(project: string, query: string, includeContent = false): Promise<string[]> {
  const files: string[] = [];
  const keyword = query.toLowerCase();
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(join(project, directory), { withFileTypes: true });
    entries.sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= 50) return;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !excludedDirectories.has(entry.name)) await visit(path);
      else if (entry.isFile()) {
        if (path.toLowerCase().includes(keyword)) files.push(path);
        else if (includeContent) {
          const file = await readProjectFile(project, path);
          if (file.preview === 'text' && file.content?.toLowerCase().includes(keyword)) files.push(path);
        }
      }
    }
  }
  await visit('');
  return files;
}
