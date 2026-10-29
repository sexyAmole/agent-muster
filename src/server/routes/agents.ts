import { Router } from 'express';
import type { AgentRegistry } from '../../agents/registry.js';
import type { AgentManagement } from '../../agents/management.js';
import type { SessionManager } from '../../sessions/manager.js';

export function createAgentRouter(registry: AgentRegistry, agentManagement: AgentManagement, sessions: SessionManager) {
  const router = Router();
  router.get('/agents', (_request, response) => response.json(registry.list()));
  router.get('/agents/available', (_request, response) => {
    const agents = registry.available();
    const counts = new Map(agents.map(agent => [agent.id, 0]));
    for (const session of sessions.list()) {
      if (counts.has(session.agent)) counts.set(session.agent, counts.get(session.agent)! + 1);
    }
    response.json(agents.sort((a, b) => counts.get(b.id)! - counts.get(a.id)!));
  });
  router.get('/agents/:id/models', async (request, response) => {
    try { response.json(await registry.loadModels(request.params.id)); }
    catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  router.get('/agents/management', async (_request, response) => {
    try { response.json(await agentManagement.list()); }
    catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  router.post('/agents/refresh', async (_request, response) => {
    try { response.json(await agentManagement.refresh()); }
    catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  router.get('/agents/:id/details', async (request, response) => {
    try {
      response.json(await agentManagement.details(request.params.id, request.query.refresh === 'true'));
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
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
