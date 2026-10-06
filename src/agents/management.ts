import { execFile } from 'node:child_process';
import { realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { AgentRegistry, executablePath } from './registry.js';
import type { AgentAction, ManagedAgent } from '../types.js';

const execute = promisify(execFile);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packages: Record<string, string> = {
  codex: '@openai/codex',
  claude: '@anthropic-ai/claude-code',
  pi: '@earendil-works/pi-coding-agent',
  kimi: '@moonshot-ai/kimi-code',
  gemini: '@google/gemini-cli',
  opencode: 'opencode-ai',
};
const cursorDirectory = join(homedir(), '.local', 'share', 'cursor-agent');

export class AgentManagement {
  private busy = false;

  constructor(private registry: AgentRegistry) {}

  get operating(): boolean { return this.busy; }

  async list(): Promise<ManagedAgent[]> {
    const { stdout } = await execute(npmCommand, ['root', '--global'], { shell: process.platform === 'win32', timeout: 10000 });
    const root = resolve(stdout.trim());
    return Promise.all(this.registry.list().map(async agent => {
      const path = await executablePath(agent.command);
      if (!path) {
        const supported = agent.id !== 'cursor' || process.platform === 'darwin' || process.platform === 'linux';
        return { ...agent, management: supported ? agent.id === 'cursor' ? 'cursor' as const : 'npm' as const : undefined, managementError: supported ? undefined : 'Cursor CLI 仅支持 macOS、Linux 和 WSL' };
      }
      const target = await realpath(path);
      if (agent.id === 'cursor' && target.startsWith(cursorDirectory + sep) && path === join(homedir(), '.local', 'bin', 'cursor-agent')) {
        return { ...agent, path, management: 'cursor' as const };
      }
      const packageName = packages[agent.id];
      if (packageName && target.startsWith(join(root, packageName) + sep)) return { ...agent, path, management: 'npm' as const };
      return { ...agent, path, managementError: '当前安装不由本面板支持的安装器管理，请使用原安装方式更新或卸载' };
    }));
  }

  async refresh(): Promise<ManagedAgent[]> {
    if (this.busy) throw new Error('正在执行 Agent 操作，请稍后重试');
    this.busy = true;
    try {
      await this.registry.scan();
      return await this.list();
    } finally { this.busy = false; }
  }

  async run(id: string, action: AgentAction): Promise<{ agents: ManagedAgent[]; output: string }> {
    if (this.busy) throw new Error('正在执行 Agent 操作，请稍后重试');
    this.busy = true;
    try {
      const agent = (await this.list()).find(item => item.id === id);
      if (!agent) throw new Error('Agent 不存在');
      if (!agent.management) throw new Error(agent.managementError);
      if (action === 'install' && agent.installed) throw new Error('Agent 已安装');
      if (action !== 'install' && !agent.installed) throw new Error('Agent 尚未安装');
      let output: string;
      if (agent.management === 'npm') {
        const args = action === 'uninstall' ? ['uninstall', '--global', packages[id]] : ['install', '--global', `${packages[id]}@latest`];
        const result = await execute(npmCommand, args, { shell: process.platform === 'win32', timeout: 300000, maxBuffer: 5_000_000 });
        output = result.stdout + result.stderr;
      } else if (action === 'uninstall') {
        const bin = join(homedir(), '.local', 'bin');
        const alias = await executablePath('agent');
        if (alias === join(bin, 'agent') && (await realpath(alias)).startsWith(cursorDirectory + sep)) await rm(alias);
        await rm(join(bin, 'cursor-agent'));
        await rm(cursorDirectory, { recursive: true });
        output = 'Cursor CLI 已卸载';
      } else if (action === 'update') {
        const result = await execute(agent.path!, ['update'], { timeout: 300000, maxBuffer: 5_000_000 });
        output = result.stdout + result.stderr;
      } else {
        if (!process.env.PATH?.split(delimiter).includes(join(homedir(), '.local', 'bin'))) throw new Error('请先将 ~/.local/bin 加入 PATH 并重新启动 Agent Muster');
        const result = await execute('bash', ['-o', 'pipefail', '-c', 'curl -fsSL https://cursor.com/install | bash'], { timeout: 300000, maxBuffer: 5_000_000 });
        output = result.stdout + result.stderr;
      }
      await this.registry.scan();
      const agents = await this.list();
      const updated = agents.find(item => item.id === id)!;
      if (updated.installed !== (action !== 'uninstall')) throw new Error(action === 'uninstall' ? '卸载后仍检测到 Agent，请检查 PATH 中的其他安装' : '安装后未检测到 Agent，请检查安装输出和 PATH');
      return { agents, output: output.replace(/\u001b\[[0-9;]*m/g, '').trim() };
    } catch (error) {
      await this.registry.scan();
      const failure = error as Error & { stderr?: string };
      throw new Error(failure.stderr?.trim() || failure.message);
    } finally { this.busy = false; }
  }
}
