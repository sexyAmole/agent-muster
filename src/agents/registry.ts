import { getSandboxEnabled } from './settings.js';
import { executablePath } from './executable.js';
import { providers } from './providers/index.js';
import { execFileAsync } from './providers/shared.js';
import type { AgentInfo } from '../types.js';

export { executablePath } from './executable.js';

export class AgentRegistry {
  private agents = new Map<string, AgentInfo>();

  async scan(): Promise<AgentInfo[]> {
    const agents = await Promise.all([...providers.values()].map(async definition => {
      const installed = Boolean(await executablePath(definition.command));
      let version: string | undefined;
      let versionError: string | undefined;
      if (installed) {
        try {
          const { stdout } = await execFileAsync(definition.command, ['--version'], { shell: process.platform === 'win32', timeout: 10000 });
          version = stdout.replace(/\u001b\[[0-9;]*m/g, '').trim();
          if (!version) versionError = '命令未返回版本信息';
        } catch (error) { versionError = (error as Error).message; }
      }
      const [models, defaultModel] = installed ? await Promise.all([
        definition.models().catch(() => []),
        definition.configuredModel().catch(() => undefined),
      ]) : [[], undefined];
      return { sandboxSupported: definition.sandboxSupported, sandboxEnabled: definition.sandboxSupported && getSandboxEnabled(definition.id), permissionModes: definition.permissionModes, id: definition.id, name: definition.name, command: definition.command, installed, version, versionError, models, defaultModel };
    }));
    this.agents = new Map(agents.map(agent => [agent.id, agent]));
    return agents;
  }

  list(): AgentInfo[] {
    return [...this.agents.values()].map(agent => ({ ...agent, sandboxEnabled: agent.sandboxSupported && getSandboxEnabled(agent.id) }));
  }

  get(id: string): AgentInfo | undefined {
    return this.agents.get(id);
  }
}
