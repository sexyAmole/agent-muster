import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import type { AgentInfo, ModelInfo } from '../types.js';

const execFileAsync = promisify(execFile);

const definitions = [
  { id: 'codex', name: 'Codex', command: 'codex' },
  { id: 'claude', name: 'Claude Code', command: 'claude' },
  { id: 'pi', name: 'Pi', command: 'pi' },
  { id: 'kimi', name: 'Kimi', command: 'kimi' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini' },
  { id: 'opencode', name: 'OpenCode', command: 'opencode' },
  { id: 'cursor', name: 'Cursor', command: 'cursor-agent' },
] as const;

async function executablePath(command: string): Promise<string | undefined> {
  const pathValue = process.env.PATH;
  if (!pathValue) return undefined;
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const path = join(directory, command + extension);
      try {
        await access(path, constants.X_OK);
        return path;
      } catch { /* Continue scanning PATH. */ }
    }
  }
}

function contextWindow(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([KM])?$/.exec(value);
  return match ? Math.round(Number(match[1]) * (match[2] === 'M' ? 1_000_000 : match[2] === 'K' ? 1_000 : 1)) : undefined;
}

interface CodexModel {
  model: string;
  displayName: string;
}

function codexModels(): Promise<CodexModel[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = createInterface({ input: child.stdout });
    let finished = false;
    const finish = (error?: Error, models?: CodexModel[]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      if (error) reject(error);
      else if (models) resolve(models);
    };
    const timer = setTimeout(() => finish(new Error('Codex model query timed out')), 15000);
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('exit', () => finish(new Error('Codex exited before returning models')));
    lines.on('line', line => {
      try {
        const message = JSON.parse(line) as { id?: number; error?: { message: string }; result?: { data: CodexModel[] } };
        if (message.error) { finish(new Error(message.error.message)); return; }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'model/list', params: { limit: 100, includeHidden: true } })}\n`);
        }
        if (message.id === 2 && message.result) finish(undefined, message.result.data);
      } catch (error) { finish(error as Error); }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_muster', version: '0.1.0' } } })}\n`);
  });
}

async function availableModels(agent: string): Promise<ModelInfo[]> {
  if (agent === 'claude') return ['sonnet', 'opus', 'haiku', 'fable'].map(id => ({ id, name: id }));
  if (agent === 'codex') {
    const models = await codexModels();
    const catalog = JSON.parse(await readFile(join(homedir(), '.codex', 'models_cache.json'), 'utf8')) as { models: { slug: string; context_window?: number }[] };
    return models.filter(model => model.model !== 'gpt-6.1-sol').map(model => ({ id: model.model, name: model.displayName, contextWindow: catalog.models.find(item => item.slug === model.model)?.context_window }));
  }
  if (agent === 'pi') {
    const { stdout } = await execFileAsync('pi', ['--list-models'], { timeout: 5000 });
    return stdout.trim().split(/\r?\n/).slice(1).flatMap(line => {
      const [provider, model, limit] = line.trim().split(/\s+/);
      if (!provider || !model) return [];
      return [{ id: `${provider}/${model}`, name: `${provider}/${model}`, contextWindow: contextWindow(limit) }];
    });
  }
  if (agent === 'kimi') {
    const { stdout } = await execFileAsync('kimi', ['provider', 'list', '--json'], { timeout: 5000 });
    const catalog = JSON.parse(stdout) as { models: Record<string, { displayName?: string; maxContextSize?: number }> };
    return Object.entries(catalog.models).map(([id, model]) => ({ id, name: model.displayName || id, contextWindow: model.maxContextSize }));
  }
  if (agent === 'gemini') {
    return ['auto-gemini-3', 'auto-gemini-2.5', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'].map(id => ({ id, name: id }));
  }
  if (agent === 'opencode') {
    const { stdout } = await execFileAsync('opencode', ['models', '--verbose'], { timeout: 10000, maxBuffer: 5_000_000 });
    return stdout.trim().split(/\r?\n(?=[\w.-]+\/[^\s]+\r?$)/m).map(entry => {
      const end = entry.indexOf('\n');
      const id = entry.slice(0, end).trim();
      const model = JSON.parse(entry.slice(end + 1)) as { name: string; limit: { context: number } };
      return { id, name: `${model.name} (${id})`, contextWindow: model.limit.context };
    });
  }
  if (agent === 'cursor') {
    const { stdout } = await execFileAsync('cursor-agent', ['--list-models'], { timeout: 10000 });
    return stdout.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).flatMap(line => {
      const match = /^\s*([\w.-]+)\s+-\s+(.+?)(?:\s+\((?:current|default)\))?\s*$/.exec(line);
      return match ? [{ id: match[1], name: match[2] }] : [];
    });
  }
  return [];
}

async function configuredModel(agent: string): Promise<string | undefined> {
  if (agent === 'codex') {
    const config = await readFile(join(homedir(), '.codex', 'config.toml'), 'utf8');
    return /^model\s*=\s*['"]([^'"]+)['"]/m.exec(config)?.[1];
  }
  if (agent === 'claude') {
    const config = JSON.parse(await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8')) as { model?: string };
    return config.model;
  }
  if (agent === 'pi') {
    const config = JSON.parse(await readFile(join(homedir(), '.pi', 'agent', 'settings.json'), 'utf8')) as { defaultProvider?: string; defaultModel?: string };
    return config.defaultProvider && config.defaultModel ? `${config.defaultProvider}/${config.defaultModel}` : undefined;
  }
  if (agent === 'kimi') {
    const { stdout } = await execFileAsync('kimi', ['provider', 'list'], { timeout: 5000 });
    return /^Default model:\s*(\S+)/m.exec(stdout)?.[1];
  }
  if (agent === 'gemini') {
    if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
    const config = JSON.parse(await readFile(join(homedir(), '.gemini', 'settings.json'), 'utf8')) as { model?: { name?: string } };
    return config.model?.name;
  }
  if (agent === 'opencode') {
    const { stdout } = await execFileAsync('opencode', ['debug', 'config'], { timeout: 10000 });
    return (JSON.parse(stdout) as { model?: string }).model;
  }
  if (agent === 'cursor') {
    const directory = process.env.CURSOR_CONFIG_DIR || (process.env.XDG_CONFIG_HOME && process.platform !== 'darwin' && process.platform !== 'win32' ? join(process.env.XDG_CONFIG_HOME, 'cursor') : join(homedir(), '.cursor'));
    const config = JSON.parse(await readFile(join(directory, 'cli-config.json'), 'utf8')) as { model?: { displayModelId?: string } };
    return config.model?.displayModelId;
  }
}

export class AgentRegistry {
  private agents = new Map<string, AgentInfo>();

  async scan(): Promise<AgentInfo[]> {
    const agents = await Promise.all(definitions.map(async definition => {
      const installed = Boolean(await executablePath(definition.command));
      const [models, defaultModel] = installed ? await Promise.all([
        availableModels(definition.id).catch(() => []),
        configuredModel(definition.id).catch(() => undefined),
      ]) : [[], undefined];
      return { ...definition, installed, models, defaultModel };
    }));
    this.agents = new Map(agents.map(agent => [agent.id, agent]));
    return agents;
  }

  list(): AgentInfo[] {
    return [...this.agents.values()];
  }

  get(id: string): AgentInfo | undefined {
    return this.agents.get(id);
  }
}
