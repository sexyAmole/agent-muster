import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { AgentRegistry } from './agents/registry.js';
import { DingTalkBridge } from './integrations/dingtalk/bridge.js';
import { DingTalkRegistry } from './integrations/dingtalk/registry.js';
import { FeishuRegistry } from './integrations/feishu/registry.js';
import { FeishuBridge } from './integrations/feishu/bridge.js';
import { ProjectRegistry } from './projects/registry.js';
import { SessionManager } from './sessions/manager.js';
import { startServer } from './server/index.js';
import { checkForUpdates, updatePackage } from './updates.js';

function printHelp(): void {
  console.log(`用法：agent-muster [命令] [选项]

命令：
  web          启动 Web 界面（默认命令）
  agents       列出 Agent 及安装状态
  sessions     列出已保存的对话
  update       检查并更新全局安装到最新版本
  help         显示帮助

通用选项：
  -h, --help       显示帮助
  -v, --version    显示当前版本

Web 选项：
  -p, --port <端口>  指定监听端口（默认 17321）
  --no-open         不自动打开浏览器
  --dev             启用开发模式（需要源码及开发依赖）

示例：
  agent-muster
  agent-muster --no-open
  agent-muster web -p 18000 --no-open
  agent-muster agents
  agent-muster sessions
  agent-muster update`);
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    console.log(version);
    return;
  }
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    printHelp();
    return;
  }
  const command = args[0] && !args[0].startsWith('-') ? args[0] : 'web';
  const options = command === args[0] ? args.slice(1) : args;
  if (!['web', 'agents', 'sessions', 'update'].includes(command)) {
    throw new Error(`未知命令：${command}。运行 agent-muster --help 查看帮助。`);
  }
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (command === 'web') {
      if (option === '--no-open' || option === '--dev') continue;
      if (option === '--port' || option === '-p') {
        const value = options[++index];
        if (!value || !/^\d+$/.test(value)) throw new Error(`${option} 需要指定 1–65535 之间的整数端口。`);
        continue;
      }
    }
    throw new Error(`未知参数：${option}。运行 agent-muster --help 查看帮助。`);
  }
  const portIndex = options.findIndex(option => option === '--port' || option === '-p');
  const port = portIndex >= 0 ? Number(options[portIndex + 1]) : 17321;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535 之间的整数。');
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
  const feishu = new FeishuRegistry();
  await feishu.load();

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
  for (const { sessionId, appId } of dingtalk.sessionBindings()) sessions.linkDingTalkSession(sessionId, appId);
  new DingTalkBridge(dingtalk, registry, sessions, projects);
  for (const { sessionId, appId } of feishu.sessionBindings()) sessions.linkFeishuSession(sessionId, appId);
  new FeishuBridge(feishu, registry, sessions, projects);
  const server = await startServer(port, registry, projects, sessions, dingtalk, feishu, options.includes('--dev'));
  dingtalk.startSubscriptions();
  feishu.startSubscriptions();
  const url = `http://127.0.0.1:${port}`;
  console.log(`Agent Muster started\n\nWeb: ${url}\n\nDetected Agents:`);
  for (const agent of registry.list()) console.log(`${agent.installed ? '✓' : '✗'} ${agent.name}`);
  console.log('\nPress Ctrl+C to stop');
  if (!options.includes('--no-open')) openBrowser(url);
  const shutdown = () => { dingtalk.shutdown(); feishu.shutdown(); sessions.shutdown(); server.close(); server.closeAllConnections(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  void checkForUpdates().catch(() => console.warn('无法检查更新，请稍后运行 agent-muster update 重试。'));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
