import express, { type NextFunction, type Request, type Response } from 'express';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AgentRegistry } from '../agents/registry.js';
import { AgentManagement } from '../agents/management.js';
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
  app.post('/api/images', express.raw({ type: '*/*', limit: '10mb' }), async (request, response) => {
    try {
      if (!Buffer.isBuffer(request.body)) throw new Error('图片内容无效');
      const mimeType = request.get('Content-Type')?.split(';')[0].trim().toLowerCase();
      if (!mimeType) throw new Error('缺少图片类型');
      response.status(201).json({ id: await sessions.uploadImage(request.body, mimeType) });
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  app.use('/api/images', (error: Error & { status?: number }, _request: Request, response: Response, _next: NextFunction) => {
    response.status(error.status === 413 ? 413 : 400).json({ error: error.status === 413 ? '单张图片不能超过 10 MB' : '图片上传失败' });
  });
  app.use('/api', express.json({ limit: '128kb' }));

  app.get('/api/agents', (_request, response) => response.json(registry.list()));
  const agentManagement = new AgentManagement(registry);
  app.get('/api/agents/management', async (_request, response) => {
    try { response.json(await agentManagement.list()); }
    catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  app.post('/api/agents/refresh', async (_request, response) => {
    try { response.json(await agentManagement.refresh()); }
    catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  app.post('/api/agents/:id/actions', async (request, response) => {
    try {
      const { action } = request.body || {};
      if (action !== 'install' && action !== 'update' && action !== 'uninstall') throw new Error('Agent 操作无效');
      if (sessions.list().some(session => session.agent === request.params.id && (session.status === 'starting' || session.status === 'running'))) throw new Error('此 Agent 有正在运行的会话，请先停止会话');
      response.json(await agentManagement.run(request.params.id, action));
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
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
  app.get('/api/sessions', (_request, response) => response.json(sessions.list().map(({ events, ...session }) => session)));
  app.get('/api/sessions/:id', (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) { response.status(404).json({ error: 'Session not found' }); return; }
    if (request.query.limit === undefined) { response.json({ ...session, ...sessions.history(session.id) }); return; }
    const limit = Number(request.query.limit);
    const before = request.query.before === undefined ? undefined : Number(request.query.before);
    if (!Number.isInteger(limit) || limit < 0 || limit > 100 || (before !== undefined && (!Number.isSafeInteger(before) || before <= 0))) {
      response.status(400).json({ error: '历史消息分页参数无效' }); return;
    }
    response.json({ ...session, ...sessions.history(session.id, limit, before) });
  });
  app.get('/api/sessions/:id/messages/:eventId/images/:index', (request, response) => {
    if (!sessions.get(request.params.id)) { response.status(404).json({ error: '会话不存在' }); return; }
    const eventId = Number(request.params.eventId);
    const index = Number(request.params.index);
    if (!Number.isSafeInteger(eventId) || eventId <= 0 || !Number.isSafeInteger(index) || index < 0) {
      response.status(400).json({ error: '图片参数无效' }); return;
    }
    const event = sessions.getEvent(request.params.id, eventId);
    const image = event?.type === 'message' ? event.images?.[index] : undefined;
    if (!image) { response.status(404).json({ error: '消息图片不存在' }); return; }
    response.type(image.mimeType).sendFile(basename(image.path), { root: dirname(image.path) });
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
      const { agent, cwd, prompt, model, imageIds } = request.body || {};
      if (agentManagement.operating) throw new Error('正在执行 Agent 操作，请完成后再创建会话');
      if (typeof agent !== 'string' || !registry.get(agent)?.installed) throw new Error('Agent is not installed');
      if (typeof cwd !== 'string' || typeof prompt !== 'string') throw new Error('Project and prompt are required');
      if (model !== undefined && (typeof model !== 'string' || (model && !registry.get(agent)?.models.some(item => item.id === model)))) throw new Error('Invalid model');
      const images = await sessions.readImages(imageIds, agent);
      response.status(201).json(await sessions.create(agent, cwd, prompt, model || undefined, undefined, undefined, images));
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  app.post('/api/sessions/:id/messages', async (request, response) => {
    try {
      const { content, model, imageIds } = request.body || {};
      if (agentManagement.operating) throw new Error('正在执行 Agent 操作，请完成后再发送消息');
      if (typeof content !== 'string') throw new Error('Message is required');
      const session = sessions.get(request.params.id);
      if (!session) throw new Error('Session not found');
      if (!registry.get(session.agent)?.installed) throw new Error('此 Agent 已卸载，请先重新安装');
      if (model !== undefined && (typeof model !== 'string' || (model && !registry.get(session.agent)?.models.some(item => item.id === model)))) throw new Error('Invalid model');
      const images = await sessions.readImages(imageIds, session.agent);
      response.json(sessions.send(request.params.id, content, model, undefined, images));
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  app.post('/api/sessions/:id/dingtalk/messages', async (request, response) => {
    try {
      const { eventId } = request.body || {};
      if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new Error('消息 ID 无效');
      const session = sessions.get(request.params.id);
      if (!session) throw new Error('Session not found');
      if (!session.dingtalkAppId) throw new Error('此对话未关联钉钉应用');
      const event = sessions.getEvent(session.id, eventId);
      if (event?.type !== 'output' || !event.text.trim()) throw new Error('助手结果不存在或内容为空');
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
      if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new Error('消息 ID 无效');
      const session = sessions.get(request.params.id);
      if (!session) throw new Error('会话不存在');
      if (!session.feishuAppId) throw new Error('此对话未关联飞书应用');
      const event = sessions.getEvent(session.id, eventId);
      if (event?.type !== 'output' || !event.text.trim()) throw new Error('助手结果不存在或内容为空');
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
    let lastEventId = after;
    const send = (event: SessionEvent) => {
      lastEventId = Math.max(lastEventId, event.id);
      response.write(`id: ${lastEventId}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    for (const event of sessions.eventsAfter(session.id, after)) send(event);
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
    app.get('/{*path}', (_request, response) => response.sendFile('index.html', { root: webRoot }));
  }
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', done);
  });
  return server;
}
