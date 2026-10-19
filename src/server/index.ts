import express from 'express';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRegistry } from '../agents/registry.js';
import { AgentManagement } from '../agents/management.js';
import type { DingTalkRegistry } from '../integrations/dingtalk/registry.js';
import type { FeishuRegistry } from '../integrations/feishu/registry.js';
import type { WecomRegistry } from '../integrations/wecom/registry.js';
import type { ProjectRegistry } from '../projects/registry.js';
import type { SessionManager } from '../sessions/manager.js';
import { createAgentRouter } from './routes/agents.js';
import { createProjectRouter } from './routes/projects.js';
import { createSessionRouter } from './routes/sessions.js';
import { createDingTalkRouter } from './routes/dingtalk.js';
import { createFeishuRouter } from './routes/feishu.js';
import { createWecomRouter } from './routes/wecom.js';
import { createImageRouter } from './routes/images.js';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');

export async function startServer(port: number, registry: AgentRegistry, projects: ProjectRegistry, sessions: SessionManager, dingtalk: DingTalkRegistry, feishu: FeishuRegistry, wecom: WecomRegistry, dev = false, desktopToken?: string) {
  let listeningPort = port;
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    if (request.headers.host !== `127.0.0.1:${listeningPort}`) {
      response.status(403).json({ error: 'Invalid host' });
      return;
    }
    if (desktopToken) {
      if (request.query.desktopToken !== desktopToken) {
        response.status(403).json({ error: 'Invalid desktop token' });
        return;
      }
      if (request.headers.origin && request.headers.origin !== 'null') {
        response.status(403).json({ error: 'Invalid origin' });
        return;
      }
      response.setHeader('Access-Control-Allow-Origin', 'null');
      response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
      response.setHeader('Referrer-Policy', 'no-referrer');
      if (request.method === 'OPTIONS') {
        response.sendStatus(204);
        return;
      }
    } else if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${listeningPort}`) {
        response.status(403).json({ error: 'Invalid origin' });
        return;
      }
    }
    next();
  });
  app.use('/api/images', createImageRouter(sessions));
  app.use('/api', express.json({ limit: '128kb' }));

  const agentManagement = new AgentManagement(registry);
  app.use('/api', createAgentRouter(registry, agentManagement, sessions));
  app.use('/api', createProjectRouter(projects, sessions, dingtalk, feishu, wecom));
  app.use('/api', createDingTalkRouter(dingtalk, projects, registry));
  app.use('/api', createFeishuRouter(feishu, projects, registry));
  app.use('/api', createWecomRouter(wecom, projects, registry));
  app.use('/api', createSessionRouter(sessions, registry, agentManagement, dingtalk, feishu, wecom));

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
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取本地服务端口');
  listeningPort = address.port;
  return server;
}
