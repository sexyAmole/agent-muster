import express from 'express';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AgentRegistry } from '../agents/registry.js';
import { DingTalkRegistry } from '../integrations/dingtalk/registry.js';
import { FeishuRegistry } from '../integrations/feishu/registry.js';
import { ProjectRegistry } from '../projects/registry.js';
import { SessionManager } from '../sessions/manager.js';
import type { SessionEvent } from '../types.js';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const execFileAsync = promisify(execFile);

async function chooseProjectDirectory(): Promise<string | null> {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'osascript' : platform === 'win32' ? 'powershell.exe' : 'zenity';
  const args = platform === 'darwin'
    ? ['-e', 'try\nPOSIX path of (choose folder with prompt "选择项目目录")\non error number -128\nreturn ""\nend try']
    : platform === 'win32'
      ? ['-NoProfile', '-STA', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }']
      : ['--file-selection', '--directory', '--title=选择项目目录'];
  try {
    const { stdout } = await execFileAsync(command, args);
    return stdout.trim() || null;
  } catch (error) {
    if (platform === 'linux' && (error as { code?: number }).code === 1) return null;
    throw error;
  }
}

export async function startServer(port: number, registry: AgentRegistry, projects: ProjectRegistry, sessions: SessionManager, dingtalk: DingTalkRegistry, feishu: FeishuRegistry, dev = false) {
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    if (request.headers.host !== `127.0.0.1:${port}`) {
      response.status(403).json({ error: 'Invalid host' });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${port}`) {
        response.status(403).json({ error: 'Invalid origin' });
        return;
      }
    }
    next();
  });
  app.use('/api', express.json({ limit: '128kb' }));

  app.get('/api/agents', (_request, response) => response.json(registry.list()));
  app.get('/api/projects', (_request, response) => response.json(projects.list()));
  app.post('/api/projects', async (request, response) => {
    try {
      if (typeof request.body?.path !== 'string') throw new Error('Project directory is required');
      response.status(201).json({ path: await projects.add(request.body.path) });
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  app.post('/api/projects/pick', async (_request, response) => {
    try {
      const path = await chooseProjectDirectory();
      response.json({ path: path ? await projects.add(path) : null });
    } catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  app.delete('/api/projects', async (request, response) => {
    try {
      const path = request.body?.path;
      const projectSessions = typeof path === 'string' ? sessions.list().filter(item => item.cwd === path) : [];
      const registered = typeof path === 'string' && projects.list().includes(path);
      if (typeof path !== 'string' || (!registered && !projectSessions.length)) {
        response.status(404).json({ error: 'Project not found' }); return;
      }
      await dingtalk.unbindProject(path);
      await feishu.unbindProject(path);
      for (const session of projectSessions) {
        await dingtalk.unbindSession(session.id);
        await feishu.unbindSession(session.id);
        await sessions.remove(session.id);
      }
      if (registered) await projects.remove(path);
      response.json({ path });
    } catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  app.get('/api/dingtalk/apps', (_request, response) => response.json(dingtalk.list()));
  app.get('/api/dingtalk/apps/:id/icon', async (request, response) => {
    try {
      const icon = await dingtalk.getIcon(request.params.id);
      if (!icon) { response.status(404).end(); return; }
      response.type(icon.mime).send(icon.data);
    } catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  app.post('/api/dingtalk/apps/:id/sync', async (request, response) => {
    try { response.json(await dingtalk.syncMetadata(request.params.id)); }
    catch (error) { response.status(502).json({ error: (error as Error).message }); }
  });
  app.post('/api/dingtalk/registration', async (_request, response) => {
    try { response.status(201).json(await dingtalk.start()); }
    catch (error) { response.status(502).json({ error: (error as Error).message }); }
  });
  app.get('/api/dingtalk/registration/:id', async (request, response) => {
    try { response.json(await dingtalk.poll(request.params.id)); }
    catch (error) { response.status(502).json({ error: (error as Error).message }); }
  });
  app.patch('/api/dingtalk/apps/:id', async (request, response) => {
    try {
      const { project, agent } = request.body || {};
      if (project !== undefined && project !== null && typeof project !== 'string') throw new Error('项目无效');
      if (agent !== undefined && agent !== null && typeof agent !== 'string') throw new Error('Agent 无效');
      response.json(await dingtalk.bind(request.params.id, { project, agent }, projects.list(), registry.list().filter(item => item.installed).map(item => item.id)));
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  app.delete('/api/dingtalk/apps/:id', async (request, response) => {
    try {
      if (!dingtalk.getBinding(request.params.id)) { response.status(404).json({ error: '钉钉应用不存在' }); return; }
      await dingtalk.remove(request.params.id);
      response.json({ id: request.params.id });
    } catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  app.get('/api/feishu/apps', (_request, response) => response.json(feishu.list()));
  app.post('/api/feishu/apps/:id/sync', async (request, response) => {
    try { response.json(await feishu.syncMetadata(request.params.id)); }
    catch (error) { response.status(502).json({ error: (error as Error).message }); }
  });
  app.post('/api/feishu/registration', async (_request, response) => {
    try { response.status(201).json(await feishu.start()); }
    catch (error) { response.status(502).json({ error: (error as Error).message }); }
  });
  app.get('/api/feishu/registration/:id', async (request, response) => {
    try { response.json(await feishu.poll(request.params.id)); }
    catch (error) { response.status(502).json({ error: (error as Error).message }); }
  });
  app.patch('/api/feishu/apps/:id', async (request, response) => {
    try {
      const { project, agent } = request.body || {};
      if (project !== undefined && project !== null && typeof project !== 'string') throw new Error('项目无效');
      if (agent !== undefined && agent !== null && typeof agent !== 'string') throw new Error('Agent 无效');
      response.json(await feishu.bind(request.params.id, { project, agent }, projects.list(), registry.list().filter(item => item.installed).map(item => item.id)));
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  app.delete('/api/feishu/apps/:id', async (request, response) => {
    try {
      if (!feishu.getBinding(request.params.id)) { response.status(404).json({ error: '飞书应用不存在' }); return; }
      await feishu.remove(request.params.id);
      response.json({ id: request.params.id });
    } catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  app.delete('/api/feishu/registration/:id', async (request, response) => {
    await feishu.cancelRegistration(request.params.id);
    response.status(204).end();
  });
  app.get('/api/sessions', (_request, response) => response.json(sessions.list()));
  app.get('/api/sessions/:id', (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) { response.status(404).json({ error: 'Session not found' }); return; }
    response.json(session);
  });
  app.get('/api/directories', async (request, response) => {
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
  app.post('/api/sessions', async (request, response) => {
    try {
      const { agent, cwd, prompt, model } = request.body || {};
      if (typeof agent !== 'string' || !registry.get(agent)?.installed) throw new Error('Agent is not installed');
      if (typeof cwd !== 'string' || typeof prompt !== 'string') throw new Error('Project and prompt are required');
      if (model !== undefined && (typeof model !== 'string' || (model && !registry.get(agent)?.models.some(item => item.id === model)))) throw new Error('Invalid model');
      response.status(201).json(await sessions.create(agent, cwd, prompt, model || undefined));
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  app.post('/api/sessions/:id/messages', (request, response) => {
    try {
      const { content, model } = request.body || {};
      if (typeof content !== 'string') throw new Error('Message is required');
      const session = sessions.get(request.params.id);
      if (!session) throw new Error('Session not found');
      if (model !== undefined && (typeof model !== 'string' || (model && !registry.get(session.agent)?.models.some(item => item.id === model)))) throw new Error('Invalid model');
      response.json(sessions.send(request.params.id, content, model));
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  app.post('/api/sessions/:id/dingtalk/messages', async (request, response) => {
    try {
      const { eventId } = request.body || {};
      const session = sessions.get(request.params.id);
      if (!session) throw new Error('Session not found');
      if (!session.dingtalkAppId) throw new Error('此对话未关联钉钉应用');
      const event = session.events.find(item => item.id === eventId && item.type === 'output');
      if (!event?.text.trim()) throw new Error('助手结果不存在或内容为空');
      if (event.pushedToIm) throw new Error('此结果已推送到 IM');
      await dingtalk.sendToSession(session.dingtalkAppId, session.id, event.text.trim());
      response.json(sessions.markImPushed(session.id, event.id));
    } catch (error) {
      console.error(`DingTalk message sending failed for session ${request.params.id}:`, error);
      response.status(400).json({ error: (error as Error).message });
    }
  });
  app.post('/api/sessions/:id/feishu/messages', async (request, response) => {
    try {
      const { eventId } = request.body || {};
      const session = sessions.get(request.params.id);
      if (!session) throw new Error('会话不存在');
      if (!session.feishuAppId) throw new Error('此对话未关联飞书应用');
      const event = session.events.find(item => item.id === eventId && item.type === 'output');
      if (!event?.text.trim()) throw new Error('助手结果不存在或内容为空');
      if (event.pushedToIm) throw new Error('此结果已推送到 IM');
      await feishu.sendToSession(session.feishuAppId, session.id, event.text.trim());
      response.json(sessions.markImPushed(session.id, event.id));
    } catch (error) {
      console.error(`飞书会话 ${request.params.id} 消息发送失败：`, error);
      response.status(400).json({ error: (error as Error).message });
    }
  });
  app.post('/api/sessions/:id/stop', (request, response) => {
    try { response.json(sessions.stop(request.params.id)); }
    catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  app.delete('/api/sessions/:id', async (request, response) => {
    try {
      if (!sessions.get(request.params.id)) { response.status(404).json({ error: 'Session not found' }); return; }
      await dingtalk.unbindSession(request.params.id);
      await feishu.unbindSession(request.params.id);
      await sessions.remove(request.params.id);
      response.json({ id: request.params.id });
    } catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  app.get('/api/sessions/:id/events', (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) { response.status(404).json({ error: 'Session not found' }); return; }
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();
    const after = Math.max(Number(request.query.after || 0), Number(request.headers['last-event-id'] || 0));
    const send = (event: SessionEvent) => response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    for (const event of session.events) if (event.id > after) send(event);
    const listener = (event: SessionEvent) => send(event);
    sessions.on(session.id, listener);
    const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15000);
    request.on('close', () => { clearInterval(heartbeat); sessions.off(session.id, listener); });
  });

  const server = createServer(app);
  if (dev) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      configFile: resolve(webRoot, '../vite.config.ts'),
      root: resolve(webRoot, '..'),
      server: { middlewareMode: true, hmr: { server } },
    });
    app.use(vite.middlewares);
    server.once('close', () => { void vite.close(); });
  } else {
    app.use(express.static(webRoot));
    app.get('/{*path}', (_request, response) => response.sendFile(join(webRoot, 'index.html')));
  }
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', done);
  });
  return server;
}
