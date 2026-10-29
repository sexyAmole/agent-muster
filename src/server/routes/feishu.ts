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
      const { project, agent, model, permissionMode } = request.body || {};
      if (project !== undefined && project !== null && typeof project !== 'string') throw new Error('项目无效');
      if (agent !== undefined && agent !== null && typeof agent !== 'string') throw new Error('Agent 无效');
      if (permissionMode !== undefined && typeof permissionMode !== 'string') throw new Error('权限模式无效');
      if (model !== undefined) {
        if (typeof model !== 'string') throw new Error('模型无效');
        const agentId = agent !== undefined ? agent : feishu.getBinding(request.params.id)?.agent;
        if (!agentId) throw new Error('请先选择 Agent');
        const details = await registry.loadModels(agentId);
        if (!details.installed) throw new Error('Agent 不可用');
        if (model && !details.models.some(item => item.id === model)) throw new Error('模型不存在');
      }
      response.json(await feishu.bind(request.params.id, { project, agent, model, permissionMode }, projects.list(), registry.available().map(item => item.id)));
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
