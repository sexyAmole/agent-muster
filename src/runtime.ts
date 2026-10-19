import { AgentRegistry } from './agents/registry.js';
import { DingTalkRegistry } from './integrations/dingtalk/registry.js';
import { FeishuRegistry } from './integrations/feishu/registry.js';
import { WecomRegistry } from './integrations/wecom/registry.js';
import { ProjectRegistry } from './projects/registry.js';
import { SessionManager } from './sessions/manager.js';
import { DingTalkBridge } from './integrations/dingtalk/bridge.js';
import { FeishuBridge } from './integrations/feishu/bridge.js';
import { WecomBridge } from './integrations/wecom/bridge.js';
import { startServer } from './server/index.js';

export async function loadRuntime() {
  const registry = new AgentRegistry();
  await registry.scan();
  const sessions = new SessionManager();
  await sessions.load();
  const projects = new ProjectRegistry();
  await projects.load();
  const dingtalk = new DingTalkRegistry();
  await dingtalk.load();
  const feishu = new FeishuRegistry();
  await feishu.load();
  const wecom = new WecomRegistry();
  await wecom.load();

  return { registry, sessions, projects, dingtalk, feishu, wecom };
}

export async function startRuntime(context: Awaited<ReturnType<typeof loadRuntime>>, port: number, dev = false) {
  const { registry, sessions, projects, dingtalk, feishu, wecom } = context;
  for (const { sessionId, appId } of dingtalk.sessionBindings()) sessions.linkImSession(sessionId, { platform: 'dingtalk', appId });
  new DingTalkBridge(dingtalk, registry, sessions, projects);
  for (const { sessionId, appId } of feishu.sessionBindings()) sessions.linkImSession(sessionId, { platform: 'feishu', appId });
  new FeishuBridge(feishu, registry, sessions, projects);
  for (const { sessionId, appId } of wecom.sessionBindings()) sessions.linkImSession(sessionId, { platform: 'wecom', appId });
  new WecomBridge(wecom, registry, sessions, projects);
  const server = await startServer(port, registry, projects, sessions, dingtalk, feishu, wecom, dev);
  dingtalk.startSubscriptions();
  feishu.startSubscriptions();
  wecom.startSubscriptions();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取本地服务端口');
  return {
    url: `http://127.0.0.1:${address.port}`,
    shutdown: async () => {
      dingtalk.shutdown();
      feishu.shutdown();
      wecom.shutdown();
      const closed = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      await Promise.all([sessions.shutdown(), closed]);
    },
  };
}
