import { Router } from 'express';
import type { AgentRegistry } from '../../agents/registry.js';
import type { ProjectRegistry } from '../../projects/registry.js';
import type { FeishuRegistry } from '../../integrations/feishu/registry.js';

export function createFeishuRouter(feishu: FeishuRegistry, projects: ProjectRegistry, registry: AgentRegistry) {
  const router = Router();
  router.get('/feishu/apps', (_request, response) => response.json(feishu.list()));
  router.post('/feishu/apps/:id/sync', async (request, response) => {
    try { response.json(await feishu.syncMetadata(request.params.id)); }
    catch (error) { response.status(502).json({ error: (error as Error).message }); }
  });
  router.post('/feishu/registration', async (_request, response) => {
    try { response.status(201).json(await feishu.start()); }
    catch (error) { response.status(502).json({ error: (error as Error).message }); }
  });
  router.get('/feishu/registration/:id', async (request, response) => {
    try { response.json(await feishu.poll(request.params.id)); }
    catch (error) { response.status(502).json({ error: (error as Error).message }); }
  });
  router.patch('/feishu/apps/:id', async (request, response) => {
    try {
      const { project, agent, permissionMode } = request.body || {};
      if (project !== undefined && project !== null && typeof project !== 'string') throw new Error('项目无效');
      if (agent !== undefined && agent !== null && typeof agent !== 'string') throw new Error('Agent 无效');
      if (permissionMode !== undefined && typeof permissionMode !== 'string') throw new Error('权限模式无效');
      response.json(await feishu.bind(request.params.id, { project, agent, permissionMode }, projects.list(), registry.list().filter(item => item.installed).map(item => item.id)));
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  router.delete('/feishu/apps/:id', async (request, response) => {
    try {
      if (!feishu.getBinding(request.params.id)) { response.status(404).json({ error: '飞书应用不存在' }); return; }
      await feishu.remove(request.params.id);
      response.json({ id: request.params.id });
    } catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  router.delete('/feishu/registration/:id', async (request, response) => {
    await feishu.cancelRegistration(request.params.id);
    response.status(204).end();
  });
  return router;
}
