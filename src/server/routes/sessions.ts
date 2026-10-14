import { Router } from 'express';
import { basename, dirname } from 'node:path';
import type { AgentRegistry } from '../../agents/registry.js';
import type { AgentManagement } from '../../agents/management.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { DingTalkRegistry } from '../../integrations/dingtalk/registry.js';
import type { FeishuRegistry } from '../../integrations/feishu/registry.js';
import type { AgentSession, SessionEvent } from '../../types.js';

function sessionMetadata({ events, ...session }: AgentSession): Omit<AgentSession, 'events'> {
  return session;
}

export function createSessionRouter(sessions: SessionManager, registry: AgentRegistry, agentManagement: AgentManagement, dingtalk: DingTalkRegistry, feishu: FeishuRegistry) {
  const router = Router();
  router.get('/sessions', (_request, response) => response.json(sessions.list().map(sessionMetadata)));
  router.get('/sessions/:id', (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) { response.status(404).json({ error: 'Session not found' }); return; }
    response.json(sessionMetadata(session));
  });
  router.get('/sessions/:id/messages', (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) { response.status(404).json({ error: '会话不存在' }); return; }
    if (request.query.limit === undefined) { response.json(sessions.history(session.id)); return; }
    const limit = Number(request.query.limit);
    const before = request.query.before === undefined ? undefined : Number(request.query.before);
    if (!Number.isInteger(limit) || limit < 0 || limit > 100 || (before !== undefined && (!Number.isSafeInteger(before) || before <= 0))) {
      response.status(400).json({ error: '历史消息分页参数无效' }); return;
    }
    response.json(sessions.history(session.id, limit, before));
  });
  router.get('/sessions/:id/logs', async (request, response) => {
    if (!sessions.get(request.params.id)) { response.status(404).json({ error: '会话不存在' }); return; }
    const limit = Number(request.query.limit);
    const before = request.query.before === undefined ? undefined : Number(request.query.before);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 100 || (before !== undefined && (!Number.isSafeInteger(before) || before <= 0))) {
      response.status(400).json({ error: '日志分页参数无效' }); return;
    }
    try { response.json(await sessions.logs(request.params.id, limit, before)); }
    catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  router.get('/sessions/:id/messages/:eventId/images/:index', (request, response) => {
    if (!sessions.get(request.params.id)) { response.status(404).json({ error: '会话不存在' }); return; }
    const eventId = Number(request.params.eventId);
    const index = Number(request.params.index);
    if (!Number.isSafeInteger(eventId) || eventId <= 0 || !Number.isSafeInteger(index) || index < 0) {
      response.status(400).json({ error: '图片参数无效' }); return;
    }
    const event = sessions.getEvent(request.params.id, eventId);
    const image = event?.type === 'message' ? event.images?.[index] : undefined;
    if (!image) { response.status(404).json({ error: '消息图片不存在' }); return; }
    response.type(image.mimeType).sendFile(basename(image.path), { root: dirname(image.path) });
  });
  router.post('/sessions', async (request, response) => {
    try {
      const { agent, cwd, prompt, model, imageIds } = request.body || {};
      if (agentManagement.operating) throw new Error('正在执行 Agent 操作，请完成后再创建会话');
      if (typeof agent !== 'string' || !registry.get(agent)?.installed) throw new Error('Agent is not installed');
      if (typeof cwd !== 'string' || typeof prompt !== 'string') throw new Error('Project and prompt are required');
      if (model !== undefined && (typeof model !== 'string' || (model && !registry.get(agent)?.models.some(item => item.id === model)))) throw new Error('Invalid model');
      const images = await sessions.readImages(imageIds, agent);
      response.status(201).json(sessionMetadata(await sessions.create(agent, cwd, prompt, model || undefined, undefined, images)));
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  router.post('/sessions/:id/messages', async (request, response) => {
    try {
      const { content, model, imageIds } = request.body || {};
      if (agentManagement.operating) throw new Error('正在执行 Agent 操作，请完成后再发送消息');
      if (typeof content !== 'string') throw new Error('Message is required');
      const session = sessions.get(request.params.id);
      if (!session) throw new Error('Session not found');
      if (!registry.get(session.agent)?.installed) throw new Error('此 Agent 已卸载，请先重新安装');
      if (model !== undefined && (typeof model !== 'string' || (model && !registry.get(session.agent)?.models.some(item => item.id === model)))) throw new Error('Invalid model');
      const images = await sessions.readImages(imageIds, session.agent);
      response.json(sessionMetadata(sessions.send(request.params.id, content, model, undefined, images)));
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  router.post('/sessions/:id/dingtalk/messages', async (request, response) => {
    try {
      const { eventId } = request.body || {};
      if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new Error('消息 ID 无效');
      const session = sessions.get(request.params.id);
      if (!session) throw new Error('Session not found');
      const binding = session.im?.find(item => item.platform === 'dingtalk');
      if (!binding) throw new Error('此对话未关联钉钉应用');
      const event = sessions.getEvent(session.id, eventId);
      if (event?.type !== 'output' || !event.text.trim()) throw new Error('助手结果不存在或内容为空');
      if (event.pushedToIm) throw new Error('此结果已推送到 IM');
      await dingtalk.sendToSession(binding.appId, session.id, event.text.trim());
      response.json(sessionMetadata(sessions.markImPushed(session.id, event.id)));
    } catch (error) {
      console.error(`DingTalk message sending failed for session ${request.params.id}:`, error);
      response.status(400).json({ error: (error as Error).message });
    }
  });
  router.post('/sessions/:id/feishu/messages', async (request, response) => {
    try {
      const { eventId } = request.body || {};
      if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new Error('消息 ID 无效');
      const session = sessions.get(request.params.id);
      if (!session) throw new Error('会话不存在');
      const binding = session.im?.find(item => item.platform === 'feishu');
      if (!binding) throw new Error('此对话未关联飞书应用');
      const event = sessions.getEvent(session.id, eventId);
      if (event?.type !== 'output' || !event.text.trim()) throw new Error('助手结果不存在或内容为空');
      if (event.pushedToIm) throw new Error('此结果已推送到 IM');
      await feishu.sendToSession(binding.appId, session.id, event.text.trim());
      response.json(sessionMetadata(sessions.markImPushed(session.id, event.id)));
    } catch (error) {
      console.error(`飞书会话 ${request.params.id} 消息发送失败：`, error);
      response.status(400).json({ error: (error as Error).message });
    }
  });
  router.post('/sessions/:id/stop', (request, response) => {
    try { response.json(sessionMetadata(sessions.stop(request.params.id))); }
    catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  router.delete('/sessions/:id', async (request, response) => {
    try {
      if (!sessions.get(request.params.id)) { response.status(404).json({ error: 'Session not found' }); return; }
      await dingtalk.unbindSession(request.params.id);
      await feishu.unbindSession(request.params.id);
      await sessions.remove(request.params.id);
      response.json({ id: request.params.id });
    } catch (error) { response.status(500).json({ error: (error as Error).message }); }
  });
  router.get('/sessions/:id/events', (request, response) => {
    const session = sessions.get(request.params.id);
    if (!session) { response.status(404).json({ error: 'Session not found' }); return; }
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();
    const after = Math.max(Number(request.query.after || 0), Number(request.headers['last-event-id'] || 0));
    let lastEventId = after;
    const send = (event: SessionEvent) => {
      if (event.type === 'raw_stdout' || event.type === 'raw_stderr') return;
      lastEventId = Math.max(lastEventId, event.id);
      response.write(`id: ${lastEventId}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    for (const event of sessions.eventsAfter(session.id, after)) send(event);
    const listener = (event: SessionEvent) => send(event);
    sessions.on(session.id, listener);
    const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15000);
    request.on('close', () => { clearInterval(heartbeat); sessions.off(session.id, listener); });
  });
  return router;
}
