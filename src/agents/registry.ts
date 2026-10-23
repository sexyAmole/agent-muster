import { executablePath } from './executable.js';
import { providers } from './providers/index.js';
import { execFileAsync } from './providers/shared.js';
import type { AgentInfo } from '../types.js';

export { executablePath } from './executable.js';

export class AgentRegistry {
  private agents = new Map<string, AgentInfo>();

  private modelQueries = new Map<string, Promise<AgentInfo>>();
  private versionQueries = new Map<string, Promise<void>>();

  async scan(): Promise<AgentInfo[]> {
    const agents = await Promise.all([...providers.values()].map(async definition => {
      const path = definition.resolveExecutable ? await definition.resolveExecutable() : await executablePath(definition.command);
      const installed = Boolean(path);
      return { sandboxSupported: definition.sandboxSupported, permissionModes: definition.permissionModes, id: definition.id, name: definition.name, command: definition.command, installed, path, models: [] };
    }));
    this.modelQueries.clear();
    this.versionQueries.clear();
    this.agents = new Map(agents.map(agent => [agent.id, agent]));
    return agents;
  }

  async loadModels(id: string): Promise<AgentInfo> {
    const agent = this.agents.get(id);
    if (!agent) throw new Error('Agent 不存在');
    if (!agent.installed) return agent;
    let query = this.modelQueries.get(id);
    if (!query) {
      const definition = providers.get(id)!;
      query = Promise.all([
        definition.models().catch(() => []),
        definition.configuredModel().catch(() => undefined),
      ]).then(([models, defaultModel]) => {
        agent.models = models;
        agent.defaultModel = defaultModel;
        return agent;
      });
      this.modelQueries.set(id, query);
    }
    return query;
  }

  async loadVersion(id: string, refresh = false): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) throw new Error('Agent 不存在');
    if (!agent.installed) return;
    if (refresh) {
      this.versionQueries.delete(id);
      delete agent.version;
      delete agent.versionError;
    }
    let query = this.versionQueries.get(id);
    if (!query) {
      query = (async () => {
        try {
          const definition = providers.get(id)!;
          if (definition.version) {
            agent.version = await definition.version();
            return;
          }
          const { stdout } = await execFileAsync(agent.command, ['--version'], { shell: process.platform === 'win32', timeout: 10000 });
          agent.version = stdout.replace(/\u001b\[[0-9;]*m/g, '').trim();
          if (!agent.version) agent.versionError = '命令未返回版本信息';
        } catch (error) { agent.versionError = (error as Error).message; }
      })();
      this.versionQueries.set(id, query);
    }
    await query;
  }

  list(): AgentInfo[] {
    return [...this.agents.values()].map(agent => ({ ...agent }));
  }

  get(id: string): AgentInfo | undefined {
    return this.agents.get(id);
  }
}
