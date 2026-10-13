import { Router } from 'express';
import type { AgentRegistry } from '../../agents/registry.js';
import type { AgentManagement } from '../../agents/management.js';
import type { SessionManager } from '../../sessions/manager.js';

export function createAgentRouter(registry: AgentRegistry, agentManagement: AgentManagement, sessions: SessionManager) {
  const router = Router();
  router.get('/agents', (_request, response) => response.json(registry.list()));
  router.get('/agents/management', async (_request, response) => {
    try { response.json(await agentManagement.list()); }
    catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  router.post('/agents/refresh', async (_request, response) => {
    try { response.json(await agentManagement.refresh()); }
    catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  router.post('/agents/:id/actions', async (request, response) => {
    try {
      const { action } = request.body || {};
      if (action !== 'install' && action !== 'update' && action !== 'uninstall') throw new Error('Agent 操作无效');
      if (sessions.list().some(session => session.agent === request.params.id && (session.status === 'starting' || session.status === 'running'))) throw new Error('此 Agent 有正在运行的会话，请先停止会话');
      response.json(await agentManagement.run(request.params.id, action));
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  return router;
}
