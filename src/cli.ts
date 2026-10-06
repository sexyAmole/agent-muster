import { spawn } from 'node:child_process';
import { AgentRegistry } from './agents.js';
import { DingTalkBridge } from './dingtalk-bridge.js';
import { DingTalkRegistry } from './dingtalk.js';
import { ProjectRegistry } from './projects.js';
import { SessionManager } from './sessions.js';
import { startServer } from './server.js';
import { checkForUpdates, updatePackage } from './updates.js';

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
}

async function main(): Promise<void> {
  const [command = 'web', ...options] = process.argv.slice(2);
  if (command === 'update') {
    await updatePackage();
    return;
  }
  const registry = new AgentRegistry();
  await registry.scan();
  const sessions = new SessionManager();
  await sessions.load();
  const projects = new ProjectRegistry();
  await projects.load();
  const dingtalk = new DingTalkRegistry();
  await dingtalk.load();

  if (command === 'agents') {
    console.log('Installed Agents\n');
    for (const agent of registry.list()) console.log(`${agent.name}\nCommand: ${agent.command}\nStatus: ${agent.installed ? 'Available' : 'Unavailable'}\n`);
    return;
  }
  if (command === 'sessions') {
    console.log('ID                                         Agent    Project                Status');
    for (const session of sessions.list()) {
      console.log(`${session.id.padEnd(43)}${session.agent.padEnd(9)}${(session.cwd.split(/[\\/]/).at(-1) || '').padEnd(23)}${session.status}`);
    }
    return;
  }
  if (command !== 'web') throw new Error(`Unknown command: ${command}`);
  for (const { sessionId, appId } of dingtalk.sessionBindings()) sessions.linkDingTalkSession(sessionId, appId);
  new DingTalkBridge(dingtalk, registry, sessions);
  const portIndex = options.indexOf('--port');
  const port = portIndex >= 0 ? Number(options[portIndex + 1]) : 17321;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535');
  const server = await startServer(port, registry, projects, sessions, dingtalk);
  dingtalk.startSubscriptions();
  const url = `http://127.0.0.1:${port}`;
  console.log(`Agent Muster started\n\nWeb: ${url}\n\nDetected Agents:`);
  for (const agent of registry.list()) console.log(`${agent.installed ? '✓' : '✗'} ${agent.name}`);
  console.log('\nPress Ctrl+C to stop');
  if (!options.includes('--no-open')) openBrowser(url);
  const shutdown = () => { dingtalk.shutdown(); sessions.shutdown(); server.close(); server.closeAllConnections(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  void checkForUpdates().catch(() => console.warn('无法检查更新，请稍后运行 agent-muster update 重试。'));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
