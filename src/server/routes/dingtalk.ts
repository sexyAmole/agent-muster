import { Router } from 'express';
import type { AgentRegistry } from '../../agents/registry.js';
import type { ProjectRegistry } from '../../projects/registry.js';
import type { DingTalkRegistry } from '../../integrations/dingtalk/registry.js';

export function createDingTalkRouter(dingtalk: DingTalkRegistry, projects: ProjectRegistry, registry: AgentRegistry) {
  const router = Router();
  router.get('/dingtalk/apps', (_request, response) => response.json(dingtalk.list()));
  router.get('/dingtalk/apps/:id/icon', async (request, response) => {
    try {
      const icon = await dingtalk.getIcon(request.params.id);
      if (!icon) { response.status(404).end(); return; }
      response.type(icon.mime).send(icon.data);
    } catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  router.post('/dingtalk/apps/:id/sync', async (request, response) => {
    try { response.json(await dingtalk.syncMetadata(request.params.id)); }
    catch (error) { response.status(502).json({ error: (error as Error).message }); }
  });
  router.post('/dingtalk/registration', async (_request, response) => {
    try { response.status(201).json(await dingtalk.start()); }
    catch (error) { response.status(502).json({ error: (error as Error).message }); }
  });
  router.get('/dingtalk/registration/:id', async (request, response) => {
    try { response.json(await dingtalk.poll(request.params.id)); }
    catch (error) { response.status(502).json({ error: (error as Error).message }); }
  });
  router.patch('/dingtalk/apps/:id', async (request, response) => {
    try {
      const { project, agent } = request.body || {};
      if (project !== undefined && project !== null && typeof project !== 'string') throw new Error('项目无效');
      if (agent !== undefined && agent !== null && typeof agent !== 'string') throw new Error('Agent 无效');
      response.json(await dingtalk.bind(request.params.id, { project, agent }, projects.list(), registry.list().filter(item => item.installed).map(item => item.id)));
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  router.delete('/dingtalk/apps/:id', async (request, response) => {
    try {
      if (!dingtalk.getBinding(request.params.id)) { response.status(404).json({ error: '钉钉应用不存在' }); return; }
      await dingtalk.remove(request.params.id);
      response.json({ id: request.params.id });
    } catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  return router;
}
