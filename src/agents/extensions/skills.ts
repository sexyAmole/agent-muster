import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { skillRoots } from './directories.js';
import type { ExtensionAgent, LocalSkill } from './types.js';

async function hasSkillFile(path: string): Promise<boolean> {
  try {
    return (await stat(join(path, 'SKILL.md'))).isFile();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

async function listRoot(root: string, allowFiles: boolean, recursive: boolean, ancestors: Set<string> = new Set()): Promise<LocalSkill[]> {
  try {
    const actual = await realpath(root);
    if (ancestors.has(actual)) return [];
    const visited = new Set([...ancestors, actual]);
    const entries = await readdir(root, { withFileTypes: true });
    const candidates = entries.filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules');
    const skills = await Promise.all(candidates.map(async entry => {
      const { name } = entry;
      const path = join(root, name);
      if (allowFiles && name.endsWith('.md') && name !== 'SKILL.md') {
        try {
          if ((await stat(path)).isFile()) return [{ name: name.slice(0, -3), path }];
        } catch (error) {
          if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
          throw error;
        }
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) return [];
      if (await hasSkillFile(path)) return [{ name, path }];
      return recursive ? listRoot(path, allowFiles, recursive, visited) : [];
    }));
    return skills.flat();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
    throw error;
  }
}

export async function listSkills(agent: ExtensionAgent): Promise<LocalSkill[]> {
  const groups = await Promise.all([...new Set(skillRoots(agent))].map(root => listRoot(root, ['pi', 'kimi', 'dsh'].includes(agent), agent !== 'dsh')));
  return groups.flat().sort((a, b) => a.name.localeCompare(b.name));
}

export async function importSkill(agent: ExtensionAgent, sourcePath: unknown): Promise<LocalSkill> {
  if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath)) throw new Error('请输入技能目录的绝对路径');
  const source = await realpath(sourcePath);
  if (!await hasSkillFile(source)) throw new Error('技能目录必须包含 SKILL.md 文件');
  const name = basename(resolve(sourcePath));
  if (!name || name.startsWith('.')) throw new Error('技能目录名称不能以点开头');
  const [root] = skillRoots(agent);
  await mkdir(root, { recursive: true });
  const actualRoot = await realpath(root);
  if (actualRoot === source || actualRoot.startsWith(source + sep)) throw new Error('技能目录不能包含安装目录');
  const path = join(root, name);
  async function requireUnusedPath() {
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    throw new Error(`已存在同名目录 ${name}`);
  }
  await requireUnusedPath();
  const staging = await mkdtemp(join(root, '.agent-muster-import-'));
  const copy = join(staging, name);
  try {
    await cp(source, copy, { recursive: true, filter: async file => {
      const info = await lstat(file);
      if (!info.isFile() && !info.isDirectory()) throw new Error('技能目录只能包含普通文件和子目录');
      return true;
    } });
    if (!await hasSkillFile(copy)) throw new Error('复制后的技能缺少 SKILL.md 文件');
    await requireUnusedPath();
    await rename(copy, path);
    return { name, path };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function removeSkill(agent: ExtensionAgent, path: unknown): Promise<void> {
  if (typeof path !== 'string' || !(await listSkills(agent)).some(skill => skill.path === path)) {
    throw new Error('此用户级技能不存在，请刷新列表');
  }
  await rm(path, { recursive: true });
}
