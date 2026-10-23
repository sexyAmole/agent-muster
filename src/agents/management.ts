import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gt, valid } from 'semver';
import { AgentRegistry } from './registry.js';
import { providers } from './providers/index.js';
import type { AgentAction, AgentInfo, ManagedAgent } from '../types.js';

const execute = promisify(execFile);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export class AgentManagement {
  private busy = false;
  private rootQuery?: Promise<string>;
  private detailQueries = new Map<string, { agent: AgentInfo; query: Promise<ManagedAgent> }>();

  constructor(private registry: AgentRegistry) {}

  get operating(): boolean { return this.busy; }

  list(): ManagedAgent[] {
    return this.registry.list().map(agent => {
      if (agent.installed) return agent;
      const installation = providers.get(agent.id)!.installation;
      if (installation.kind === 'external') return { ...agent, managementError: installation.message };
      const supported = installation.kind === 'npm' || installation.supported;
      return { ...agent, management: supported ? installation.kind : undefined, managementError: installation.kind === 'cursor' && !installation.supported ? installation.unsupportedMessage : undefined };
    });
  }

  private npmRoot(): Promise<string> {
    if (!this.rootQuery) {
      this.rootQuery = execute(npmCommand, ['root', '--global'], { shell: process.platform === 'win32', timeout: 10000 })
        .then(({ stdout }) => resolve(stdout.trim()))
        .catch(error => { this.rootQuery = undefined; throw error; });
    }
    return this.rootQuery;
  }

  private async installation(agent: AgentInfo): Promise<Pick<ManagedAgent, 'management' | 'managementError'>> {
    const installation = providers.get(agent.id)!.installation;
    if (installation.kind === 'external') return { managementError: installation.message };
    if (!agent.path) {
      const supported = installation.kind === 'npm' || installation.supported;
      return { management: supported ? installation.kind : undefined, managementError: installation.kind === 'cursor' && !installation.supported ? installation.unsupportedMessage : undefined };
    }
    const [target, root] = await Promise.all([realpath(agent.path), installation.kind === 'npm' ? this.npmRoot() : undefined]);
    if (installation.kind === 'cursor' && installation.owns(agent.path, target)) return { management: 'cursor' };
    if (installation.kind === 'npm' && target.startsWith(join(root!, installation.packageName) + sep)) return { management: 'npm' };
    return { managementError: '当前安装不由本面板支持的安装器管理，请使用原安装方式更新或卸载' };
  }

  private async latestVersion(id: string): Promise<string> {
    const installation = providers.get(id)!.installation;
    if (installation.kind === 'external') throw new Error(installation.message);
    if (installation.kind === 'npm') {
      const { stdout } = await execute(npmCommand, ['view', `${installation.packageName}@latest`, 'version', '--json', '--fetch-timeout=5000', '--fetch-retries=0'], { shell: process.platform === 'win32', timeout: 10000 });
      const version: unknown = JSON.parse(stdout);
      if (typeof version !== 'string' || !valid(version)) throw new Error('安装源未返回有效版本号');
      return version;
    }
    const response = await fetch('https://cursor.com/install', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Cursor 版本查询失败（${response.status}）`);
    const script = await response.text();
    const version = /https:\/\/downloads\.cursor\.com\/lab\/([\w.-]+)\//.exec(script)?.[1];
    if (!version) throw new Error('Cursor 安装源未返回版本号');
    return version;
  }

  async details(id: string, refresh = false): Promise<ManagedAgent> {
    const agent = this.registry.get(id);
    if (!agent) throw new Error('Agent 不存在');
    if (!agent.installed) return { ...agent, ...await this.installation(agent) };
    const cached = this.detailQueries.get(id);
    if (!refresh && cached?.agent === agent) return cached.query;
    const query = (async (): Promise<ManagedAgent> => {
      const [, installation, latest] = await Promise.all([
        this.registry.loadVersion(id, refresh),
        this.installation(agent).catch(error => ({ managementError: (error as Error).message })),
        providers.get(id)!.installation.kind === 'external' ? Promise.resolve({}) : this.latestVersion(id).then(latestVersion => ({ latestVersion })).catch(error => ({ latestVersionError: (error as Error).message })),
      ]);
      const result: ManagedAgent = { ...agent, ...installation, ...latest };
      if (result.version && result.latestVersion) {
        if (id === 'cursor') {
          const current = /\d{4}\.\d{2}\.\d{2}-[\w.-]+/.exec(result.version)?.[0];
          if (current === result.latestVersion) result.updateAvailable = false;
          else if (current && current.slice(0, 10) !== result.latestVersion.slice(0, 10)) result.updateAvailable = result.latestVersion.slice(0, 10) > current.slice(0, 10);
        } else {
          const current = /\b\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?/.exec(result.version)?.[0];
          if (current && valid(current)) result.updateAvailable = gt(result.latestVersion, current);
        }
      }
      return result;
    })();
    this.detailQueries.set(id, { agent, query });
    return query;
  }

  async refresh(): Promise<ManagedAgent[]> {
    if (this.busy) throw new Error('正在执行 Agent 操作，请稍后重试');
    this.busy = true;
    try {
      this.detailQueries.clear();
      this.rootQuery = undefined;
      await this.registry.scan();
      return await this.list();
    } finally { this.busy = false; }
  }

  async run(id: string, action: AgentAction): Promise<{ agents: ManagedAgent[]; output: string }> {
    if (this.busy) throw new Error('正在执行 Agent 操作，请稍后重试');
    this.busy = true;
    try {
      const info = this.registry.get(id);
      if (!info) throw new Error('Agent 不存在');
      const agent = { ...info, ...await this.installation(info) };
      if (!agent.management) throw new Error(agent.managementError);
      if (action === 'install' && agent.installed) throw new Error('Agent 已安装');
      if (action !== 'install' && !agent.installed) throw new Error('Agent 尚未安装');
      const installation = providers.get(id)!.installation;
      let output: string;
      if (installation.kind === 'npm') {
        const args = action === 'uninstall' ? ['uninstall', '--global', installation.packageName] : ['install', '--global', `${installation.packageName}@latest`];
        const result = await execute(npmCommand, args, { shell: process.platform === 'win32', timeout: 300000, maxBuffer: 5_000_000 });
        output = result.stdout + result.stderr;
      } else if (installation.kind === 'cursor') {
        output = await installation.run(action, agent.path);
      } else {
        throw new Error(installation.message);
      }
      this.detailQueries.clear();
      this.rootQuery = undefined;
      await this.registry.scan();
      const agents = await this.list();
      const updated = agents.find(item => item.id === id)!;
      if (updated.installed !== (action !== 'uninstall')) throw new Error(action === 'uninstall' ? '卸载后仍检测到 Agent，请检查 PATH 中的其他安装' : '安装后未检测到 Agent，请检查安装输出和 PATH');
      return { agents, output: output.replace(/\u001b\[[0-9;]*m/g, '').trim() };
    } catch (error) {
      this.detailQueries.clear();
      this.rootQuery = undefined;
      await this.registry.scan();
      const failure = error as Error & { stderr?: string };
      throw new Error(failure.stderr?.trim() || failure.message);
    } finally { this.busy = false; }
  }
}
