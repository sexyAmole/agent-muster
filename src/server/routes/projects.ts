import { Router } from 'express';
import { execFile } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectRegistry } from '../../projects/registry.js';
import { listProjectDirectory, readProjectFile, searchProjectFiles } from '../../projects/files.js';
import { readProjectGitDiff, readProjectGitDirectories, readProjectGitStatus, switchProjectGitBranch } from '../../projects/git.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { DingTalkRegistry } from '../../integrations/dingtalk/registry.js';
import type { FeishuRegistry } from '../../integrations/feishu/registry.js';
import type { WecomRegistry } from '../../integrations/wecom/registry.js';
import type { WeixinRegistry } from '../../integrations/weixin/registry.js';

const execFileAsync = promisify(execFile);

async function chooseDirectory(prompt: string): Promise<string | null> {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'osascript' : platform === 'win32' ? 'powershell.exe' : 'zenity';
  const args = platform === 'darwin'
    ? ['-e', `try\nPOSIX path of (choose folder with prompt ${JSON.stringify(prompt)})\non error number -128\nreturn ""\nend try`]
    : platform === 'win32'
      ? ['-NoProfile', '-STA', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }']
      : ['--file-selection', '--directory', `--title=${prompt}`];
  try {
    const { stdout } = await execFileAsync(command, args);
    return stdout.trim() || null;
  } catch (error) {
    if (platform === 'linux' && (error as { code?: number }).code === 1) return null;
    throw error;
  }
}

export function createProjectRouter(projects: ProjectRegistry, sessions: SessionManager, dingtalk: DingTalkRegistry, feishu: FeishuRegistry, wecom: WecomRegistry, weixin: WeixinRegistry, closeTerminal: (path: string) => void) {
  const router = Router();
  const openedFolders = new Set<string>();
  router.get('/projects', (_request, response) => response.json(projects.list()));
  router.get('/projects/names', (_request, response) => response.json(projects.names()));
  router.get('/projects/watch', async (request, response) => {
    const watchers: FSWatcher[] = [];
    let pending: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      for (const watcher of watchers) watcher.close();
      clearTimeout(pending);
      clearInterval(heartbeat);
    };
    response.on('close', close);
    try {
      const path = request.query.path;
      if (typeof path !== 'string') throw new Error('需要项目路径');
      if (!openedFolders.has(path) && !projects.list().includes(path) && !sessions.list().some(session => session.cwd === path)) {
        response.status(404).json({ error: '项目不存在' }); return;
      }
      const root = await realpath(path);
      const gitDirectories = request.query.git === 'true' ? await readProjectGitDirectories(root) : [];
      if (response.destroyed) return;
      const roots = [root];
      for (const directory of gitDirectories) {
        if (!roots.some(parent => {
          const child = relative(parent, directory);
          return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
        })) roots.push(directory);
      }
      const changed = () => {
        if (pending) return;
        pending = setTimeout(() => {
          pending = undefined;
          response.write('data: {}\n\n');
        }, 250);
      };
      for (const directory of roots) {
        const watcher = watch(directory, { recursive: true }, (_event, filename) => {
          const parts = filename?.split(/[\\/]/);
          if (parts?.some(part => part === 'objects' || part.endsWith('.lock')) && (directory !== root || parts.includes('.git'))) return;
          changed();
        });
        watchers.push(watcher);
        watcher.on('error', () => { close(); response.end(); });
      }
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Connection', 'keep-alive');
      response.flushHeaders();
      response.write('data: {}\n\n');
      heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15000);
    } catch (error) {
      close();
      response.status(400).json({ error: (error as Error).message });
    }
  });
  router.put('/projects/order', async (request, response) => {
    try {
      const paths: unknown = request.body?.paths;
      const known = new Set([...projects.list(), ...sessions.list().map(session => session.cwd)]);
      if (!Array.isArray(paths) || paths.length !== known.size || new Set(paths).size !== paths.length || paths.some(path => typeof path !== 'string' || !known.has(path))) {
        response.status(400).json({ error: '项目列表已变化，请刷新后重新排序' }); return;
      }
      await projects.reorder(paths as string[]);
      response.json(projects.list());
    } catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  router.patch('/projects/name', async (request, response) => {
    try {
      const { path, name } = request.body ?? {};
      if (typeof path !== 'string' || (!projects.list().includes(path) && !sessions.list().some(session => session.cwd === path))) {
        response.status(404).json({ error: '项目不存在' }); return;
      }
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
        response.status(400).json({ error: '项目名称需要为 1–100 个字符' }); return;
      }
      await projects.rename(path, name.trim());
      response.json({ name: name.trim() });
    } catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  for (const kind of ['tree', 'file'] as const) {
    router.get(`/projects/${kind}`, async (request, response) => {
      try {
        const path = request.query.path;
        const target = request.query[kind === 'tree' ? 'directory' : 'file'];
        if (typeof path !== 'string' || typeof target !== 'string') throw new Error('需要项目路径和相对路径');
        if (!openedFolders.has(path) && !projects.list().includes(path) && !sessions.list().some(session => session.cwd === path)) {
          response.status(404).json({ error: '项目不存在' }); return;
        }
        response.json(kind === 'tree' ? await listProjectDirectory(path, target) : await readProjectFile(path, target));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const message = code === 'ENOENT' ? '文件或目录已不存在，请刷新'
          : code === 'EACCES' || code === 'EPERM' ? '没有权限读取该文件或目录'
          : (error as Error).message;
        response.status(400).json({ error: message });
      }
    });
  }
  router.get('/projects/files', async (request, response) => {
    try {
      const { path, query, content } = request.query;
      if (typeof path !== 'string' || typeof query !== 'string') throw new Error('需要项目路径和搜索词');
      if (!openedFolders.has(path) && !projects.list().includes(path) && !sessions.list().some(session => session.cwd === path)) {
        response.status(404).json({ error: '项目不存在' }); return;
      }
      response.json(await searchProjectFiles(path, query, content === 'true'));
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  router.post('/projects/files/pick', async (_request, response) => {
    try {
      const selected = await chooseDirectory('选择文件夹');
      if (!selected) { response.json({ path: null }); return; }
      const path = await realpath(selected);
      if (!(await stat(path)).isDirectory()) throw new Error('目标不是目录');
      openedFolders.add(path);
      response.json({ path });
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  for (const kind of ['git', 'git-diff'] as const) {
    router.get(`/projects/${kind}`, async (request, response) => {
      try {
        const { path, file } = request.query;
        if (typeof path !== 'string') throw new Error('需要项目路径');
        if (!projects.list().includes(path) && !sessions.list().some(session => session.cwd === path)) {
          response.status(404).json({ error: '项目不存在' }); return;
        }
        if (kind === 'git-diff' && typeof file !== 'string') throw new Error('需要变更文件路径');
        response.json(kind === 'git' ? await readProjectGitStatus(path) : await readProjectGitDiff(path, file as string));
      } catch (error) { response.status(400).json({ error: (error as Error).message }); }
    });
  }
  router.post('/projects/git-branch', async (request, response) => {
    try {
      const { path, name, remote } = request.body ?? {};
      if (typeof path !== 'string' || typeof name !== 'string' || typeof remote !== 'boolean') throw new Error('需要项目路径、分支名称和分支类型');
      if (!projects.list().includes(path) && !sessions.list().some(session => session.cwd === path)) {
        response.status(404).json({ error: '项目不存在' }); return;
      }
      await switchProjectGitBranch(path, name, remote);
      response.json({ success: true });
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  router.post('/projects', async (request, response) => {
    try {
      if (typeof request.body?.path !== 'string') throw new Error('Project directory is required');
      response.status(201).json({ path: await projects.add(request.body.path) });
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  router.post('/projects/pick', async (_request, response) => {
    try {
      const path = await chooseDirectory('选择项目目录');
      response.json({ path: path ? await projects.add(path) : null });
    } catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  router.delete('/projects', async (request, response) => {
    try {
      const path = request.body?.path;
      const projectSessions = typeof path === 'string' ? sessions.list().filter(item => item.cwd === path) : [];
      const registered = typeof path === 'string' && projects.list().includes(path);
      if (typeof path !== 'string' || (!registered && !projectSessions.length)) {
        response.status(404).json({ error: 'Project not found' }); return;
      }
      await dingtalk.unbindProject(path);
      await feishu.unbindProject(path);
      await wecom.unbindProject(path);
      await weixin.unbindProject(path);
      for (const session of projectSessions) {
        await dingtalk.unbindSession(session.id);
        await feishu.unbindSession(session.id);
        await wecom.unbindSession(session.id);
        await weixin.unbindSession(session.id);
        await sessions.remove(session.id);
      }
      if (registered) await projects.remove(path);
      closeTerminal(path);
      response.json({ path });
    } catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  router.get('/directories', async (request, response) => {
    try {
      const requested = typeof request.query.path === 'string' ? request.query.path : process.cwd();
      if (!isAbsolute(requested)) throw new Error('Absolute path required');
      const path = await realpath(requested);
      if (!(await stat(path)).isDirectory()) throw new Error('Directory required');
      const entries = await readdir(path, { withFileTypes: true });
      response.json({
        path,
        parent: dirname(path),
        home: homedir(),
        directories: entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
          .map(entry => entry.name).sort((a, b) => a.localeCompare(b)),
      });
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  return router;
}
