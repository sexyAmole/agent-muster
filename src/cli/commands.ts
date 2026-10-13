import { readFile } from 'node:fs/promises';
import type { AgentRegistry } from '../agents/registry.js';
import type { SessionManager } from '../sessions/manager.js';

export function printHelp(): void {
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

export async function printVersion(): Promise<void> {
  const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  console.log(version);
}

export function printAgents(registry: AgentRegistry): void {
  console.log('Installed Agents\n');
  for (const agent of registry.list()) console.log(`${agent.name}\nCommand: ${agent.command}\nStatus: ${agent.installed ? 'Available' : 'Unavailable'}\n`);
}

export function printSessions(sessions: SessionManager): void {
  console.log('ID                                         Agent    Project                Status');
  for (const session of sessions.list()) {
    console.log(`${session.id.padEnd(43)}${session.agent.padEnd(9)}${(session.cwd.split(/[\\/]/).at(-1) || '').padEnd(23)}${session.status}`);
  }
}
