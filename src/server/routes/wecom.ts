import { Router } from 'express';
import type { AgentRegistry } from '../../agents/registry.js';
import type { ProjectRegistry } from '../../projects/registry.js';
import type { WecomRegistry } from '../../integrations/wecom/registry.js';

export function createWecomRouter(wecom: WecomRegistry, projects: ProjectRegistry, registry: AgentRegistry) {
  const router = Router();
  router.get('/wecom/apps', (_request, response) => response.json(wecom.list()));
  router.post('/wecom/registration', async (_request, response) => {
    try { response.status(201).json(await wecom.start()); }
    catch (error) { response.status(502).json({ error: (error as Error).message }); }
  });
  router.get('/wecom/registration/:id', async (request, response) => {
    try { response.json(await wecom.poll(request.params.id)); }
    catch (error) { response.status(502).json({ error: (error as Error).message }); }
  });
  router.patch('/wecom/apps/:id', async (request, response) => {
    try {
      const { project, agent, permissionMode } = request.body || {};
      if (project !== undefined && project !== null && typeof project !== 'string') throw new Error('项目无效');
      if (agent !== undefined && agent !== null && typeof agent !== 'string') throw new Error('Agent 无效');
      if (permissionMode !== undefined && typeof permissionMode !== 'string') throw new Error('权限模式无效');
      response.json(await wecom.bind(request.params.id, { project, agent, permissionMode }, projects.list(), registry.list().filter(item => item.installed).map(item => item.id)));
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  router.delete('/wecom/apps/:id', async (request, response) => {
    try {
      if (!wecom.getBinding(request.params.id)) { response.status(404).json({ error: '企业微信应用不存在' }); return; }
      await wecom.remove(request.params.id);
      response.json({ id: request.params.id });
    } catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  router.delete('/wecom/registration/:id', async (request, response) => {
    await wecom.cancelRegistration(request.params.id);
    response.status(204).end();
  });
  return router;
}
