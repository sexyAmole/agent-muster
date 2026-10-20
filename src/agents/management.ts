import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { AgentRegistry } from './registry.js';
import { providers } from './providers/index.js';
import type { AgentAction, ManagedAgent } from '../types.js';

const execute = promisify(execFile);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export class AgentManagement {
  private busy = false;

  constructor(private registry: AgentRegistry) {}

  get operating(): boolean { return this.busy; }

  async list(): Promise<ManagedAgent[]> {
    await Promise.all(this.registry.list().map(agent => this.registry.loadVersion(agent.id)));
    const { stdout } = await execute(npmCommand, ['root', '--global'], { shell: process.platform === 'win32', timeout: 10000 });
    const root = resolve(stdout.trim());
    return Promise.all(this.registry.list().map(async agent => {
      const installation = providers.get(agent.id)!.installation;
      const path = agent.path;
      if (!path) {
        const supported = installation.kind === 'npm' || installation.supported;
        return { ...agent, management: supported ? installation.kind : undefined, managementError: installation.kind === 'cursor' && !installation.supported ? installation.unsupportedMessage : undefined };
      }
      const target = await realpath(path);
      if (installation.kind === 'cursor' && installation.owns(path, target)) {
        return { ...agent, path, management: 'cursor' as const };
      }
      if (installation.kind === 'npm' && target.startsWith(join(root, installation.packageName) + sep)) return { ...agent, path, management: 'npm' as const };
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
      const installation = providers.get(id)!.installation;
      let output: string;
      if (installation.kind === 'npm') {
        const args = action === 'uninstall' ? ['uninstall', '--global', installation.packageName] : ['install', '--global', `${installation.packageName}@latest`];
        const result = await execute(npmCommand, args, { shell: process.platform === 'win32', timeout: 300000, maxBuffer: 5_000_000 });
        output = result.stdout + result.stderr;
      } else {
        output = await installation.run(action, agent.path);
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
