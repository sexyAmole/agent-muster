import express from 'express';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRegistry } from '../agents/registry.js';
import { AgentManagement } from '../agents/management.js';
import type { DingTalkRegistry } from '../integrations/dingtalk/registry.js';
import type { FeishuRegistry } from '../integrations/feishu/registry.js';
import type { ProjectRegistry } from '../projects/registry.js';
import type { SessionManager } from '../sessions/manager.js';
import { createAgentRouter } from './routes/agents.js';
import { createProjectRouter } from './routes/projects.js';
import { createSessionRouter } from './routes/sessions.js';
import { createDingTalkRouter } from './routes/dingtalk.js';
import { createFeishuRouter } from './routes/feishu.js';
import { createImageRouter } from './routes/images.js';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');

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
  app.use('/api/images', createImageRouter(sessions));
  app.use('/api', express.json({ limit: '128kb' }));

  const agentManagement = new AgentManagement(registry);
  app.use('/api', createAgentRouter(registry, agentManagement, sessions));
  app.use('/api', createProjectRouter(projects, sessions, dingtalk, feishu));
  app.use('/api', createDingTalkRouter(dingtalk, projects, registry));
  app.use('/api', createFeishuRouter(feishu, projects, registry));
  app.use('/api', createSessionRouter(sessions, registry, agentManagement, dingtalk, feishu));

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
