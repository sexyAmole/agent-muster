import { spawn } from 'node:child_process';
import type { AgentRegistry } from '../agents/registry.js';
import { DingTalkBridge } from '../integrations/dingtalk/bridge.js';
import type { DingTalkRegistry } from '../integrations/dingtalk/registry.js';
import { FeishuBridge } from '../integrations/feishu/bridge.js';
import type { FeishuRegistry } from '../integrations/feishu/registry.js';
import type { ProjectRegistry } from '../projects/registry.js';
import type { SessionManager } from '../sessions/manager.js';
import { startServer } from '../server/index.js';
import type { CliOptions } from './options.js';
import { checkForUpdates } from './updates.js';

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
}

export async function startWeb(options: CliOptions, registry: AgentRegistry, sessions: SessionManager, projects: ProjectRegistry, dingtalk: DingTalkRegistry, feishu: FeishuRegistry): Promise<void> {
  for (const { sessionId, appId } of dingtalk.sessionBindings()) sessions.linkImSession(sessionId, { platform: 'dingtalk', appId });
  new DingTalkBridge(dingtalk, registry, sessions, projects);
  for (const { sessionId, appId } of feishu.sessionBindings()) sessions.linkImSession(sessionId, { platform: 'feishu', appId });
  new FeishuBridge(feishu, registry, sessions, projects);
  const server = await startServer(options.port, registry, projects, sessions, dingtalk, feishu, options.dev);
  dingtalk.startSubscriptions();
  feishu.startSubscriptions();
  const url = `http://127.0.0.1:${options.port}`;
  console.log(`Agent Muster started\n\nWeb: ${url}\n\nDetected Agents:`);
  for (const agent of registry.list()) console.log(`${agent.installed ? '✓' : '✗'} ${agent.name}`);
  console.log('\nPress Ctrl+C to stop');
  if (options.open) openBrowser(url);
  const shutdown = () => { dingtalk.shutdown(); feishu.shutdown(); sessions.shutdown(); server.close(); server.closeAllConnections(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  void checkForUpdates().catch(() => console.warn('无法检查更新，请稍后运行 agent-muster update 重试。'));
}
