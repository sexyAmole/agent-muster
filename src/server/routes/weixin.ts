import { Router } from 'express';
import type { AgentRegistry } from '../../agents/registry.js';
import type { ProjectRegistry } from '../../projects/registry.js';
import type { WeixinRegistry } from '../../integrations/weixin/registry.js';

export function createWeixinRouter(weixin: WeixinRegistry, projects: ProjectRegistry, registry: AgentRegistry) {
  const router = Router();
  router.get('/weixin/apps', (_request, response) => response.json(weixin.list()));
  router.post('/weixin/registration', async (_request, response) => {
    try { response.status(201).json(await weixin.start()); }
    catch (error) { response.status(502).json({ error: (error as Error).message }); }
  });
  router.get('/weixin/registration/:id', async (request, response) => {
    try { response.json(await weixin.poll(request.params.id)); }
    catch (error) { response.status(502).json({ error: (error as Error).message }); }
  });
  router.post('/weixin/registration/:id/verify', async (request, response) => {
    try {
      const code = request.body?.code;
      if (typeof code !== 'string' || !/^\d{4,8}$/.test(code)) throw new Error('请输入手机显示的 4–8 位验证码');
      response.json(await weixin.poll(request.params.id, code));
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  router.patch('/weixin/apps/:id', async (request, response) => {
    try {
      const { project, agent, model, permissionMode } = request.body || {};
      if (project !== undefined && project !== null && typeof project !== 'string') throw new Error('项目无效');
      if (agent !== undefined && agent !== null && typeof agent !== 'string') throw new Error('Agent 无效');
      if (permissionMode !== undefined && typeof permissionMode !== 'string') throw new Error('权限模式无效');
      if (model !== undefined) {
        if (typeof model !== 'string') throw new Error('模型无效');
        const agentId = agent !== undefined ? agent : weixin.getBinding(request.params.id)?.agent;
        if (!agentId) throw new Error('请先选择 Agent');
        const details = await registry.loadModels(agentId);
        if (!details.installed) throw new Error('Agent 不可用');
        if (model && !details.models.some(item => item.id === model)) throw new Error('模型不存在');
      }
      response.json(await weixin.bind(request.params.id, { project, agent, model, permissionMode }, projects.list(), registry.list().filter(item => item.installed).map(item => item.id)));
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  router.delete('/weixin/apps/:id', async (request, response) => {
    try {
      if (!weixin.getBinding(request.params.id)) { response.status(404).json({ error: '微信应用不存在' }); return; }
      await weixin.remove(request.params.id);
      response.json({ id: request.params.id });
    } catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  router.delete('/weixin/registration/:id', async (request, response) => {
    await weixin.cancelRegistration(request.params.id);
    response.status(204).end();
  });
  return router;
}
