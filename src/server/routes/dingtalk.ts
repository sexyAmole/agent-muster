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
      const { project, agent, model, permissionMode } = request.body || {};
      if (project !== undefined && project !== null && typeof project !== 'string') throw new Error('项目无效');
      if (agent !== undefined && agent !== null && typeof agent !== 'string') throw new Error('Agent 无效');
      if (permissionMode !== undefined && typeof permissionMode !== 'string') throw new Error('权限模式无效');
      if (model !== undefined) {
        if (typeof model !== 'string') throw new Error('模型无效');
        const agentId = agent !== undefined ? agent : dingtalk.getBinding(request.params.id)?.agent;
        if (!agentId) throw new Error('请先选择 Agent');
        const details = await registry.loadModels(agentId);
        if (!details.installed) throw new Error('Agent 不可用');
        if (model && !details.models.some(item => item.id === model)) throw new Error('模型不存在');
      }
      response.json(await dingtalk.bind(request.params.id, { project, agent, model, permissionMode }, projects.list(), registry.available().map(item => item.id)));
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
