import { spawn } from 'node:child_process';
import type { AgentRegistry } from '../agents/registry.js';
import type { DingTalkRegistry } from '../integrations/dingtalk/registry.js';
import type { FeishuRegistry } from '../integrations/feishu/registry.js';
import type { WecomRegistry } from '../integrations/wecom/registry.js';
import type { WeixinRegistry } from '../integrations/weixin/registry.js';
import type { ProjectRegistry } from '../projects/registry.js';
import type { SessionManager } from '../sessions/manager.js';
import { startRuntime } from '../runtime.js';
import type { CliOptions } from './options.js';
import { checkForUpdates } from './updates.js';

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
}

export async function startWeb(options: CliOptions, registry: AgentRegistry, sessions: SessionManager, projects: ProjectRegistry, dingtalk: DingTalkRegistry, feishu: FeishuRegistry, wecom: WecomRegistry, weixin: WeixinRegistry): Promise<void> {
  const { url, shutdown } = await startRuntime({ registry, sessions, projects, dingtalk, feishu, wecom, weixin }, options.port, options.dev);
  console.log(`Agent Muster started\n\nWeb: ${url}\n\nDetected Agents:`);
  for (const agent of registry.list()) console.log(`${agent.installed ? '✓' : '✗'} ${agent.name}`);
  console.log('\nPress Ctrl+C to stop');
  if (options.open) openBrowser(url);
  const stop = () => { void shutdown().catch(error => { console.error('关闭服务失败：', error); process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  void checkForUpdates().catch(() => console.warn('无法检查更新，请稍后运行 agent-muster update 重试。'));
}
