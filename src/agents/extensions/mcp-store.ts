import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';
import { execFileAsync } from '../providers/shared.js';
import { agentDirectory } from './directories.js';
import type { ExtensionAgent } from './types.js';

export type Config = Record<string, unknown>;
export type McpStore = {
  source: string;
  entries: Config;
  enabled?: Record<string, boolean>;
  write: (name: string, config: Config | null) => Promise<void>;
};

export function isConfig(value: unknown): value is Config {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function entriesFrom(value: unknown): Config {
  if (value === undefined) return {};
  if (!isConfig(value)) throw new Error('用户级 MCP 配置必须是对象');
  return value;
}

function configurationFile(file: string) {
  let path = file;
  try { path = realpathSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  function read(): string | null {
    try { return readFileSync(path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  const original = read();
  return { original, write(content: string) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.agent-muster-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
      if (read() !== original) throw new Error('用户配置已变化，请刷新列表后重试');
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  } };
}

let opencodeVersion: Promise<number> | undefined;

function opencodeMajor(): Promise<number> {
  opencodeVersion ??= execFileAsync('opencode', ['--version'], { timeout: 10000, shell: process.platform === 'win32' })
    .then(({ stdout }) => {
      const version = /^(\d+)\./m.exec(stdout.trim());
      if (!version) throw new Error('无法识别 OpenCode 版本，请检查 CLI 安装');
      return Number(version[1]);
    }).catch(error => { opencodeVersion = undefined; throw error; });
  return opencodeVersion;
}

async function jsonStore(agent: ExtensionAgent, source: string): Promise<McpStore> {
  const file = configurationFile(source);
  const text = file.original === null ? '{}' : file.original;
  const errors: ParseError[] = [];
  let settings: unknown;
  if (agent === 'opencode') settings = parse(text, errors, { allowTrailingComma: true });
  else {
    try { settings = JSON.parse(text); }
    catch { throw new Error(`用户配置不是有效的 JSON，请检查 ${source}`); }
  }
  if (errors.length || !isConfig(settings)) throw new Error(`用户配置格式有误，请检查 ${source}`);
  let keyPath = ['mcpServers'];
  if (agent === 'opencode') {
    const mcp = entriesFrom(settings.mcp);
    const nested = isConfig(mcp.servers) && Object.values(mcp.servers).every(isConfig);
    const legacy = Object.values(mcp).some(value => isConfig(value) && (value.type === 'local' || value.type === 'remote'));
    const version2 = nested || (!legacy && await opencodeMajor() >= 2);
    keyPath = version2 ? ['mcp', 'servers'] : ['mcp'];
  }
  let entries: unknown = settings;
  for (const key of keyPath) entries = entriesFrom(entries)[key];
  return { source, entries: entriesFrom(entries), async write(name, config) {
    const edits = modify(text, [...keyPath, name], config === null ? undefined : config, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
    });
    file.write(applyEdits(text, edits));
  } };
}

function dshStore(source: string): McpStore {
  const file = configurationFile(source);
  const document: Document = parseDocument(file.original === null ? '[]\n' : file.original);
  if (document.contents === null) document.contents = document.createNode([]);
  if (document.errors.length || !isSeq(document.contents)) throw new Error(`DSH 配置必须是 YAML 列表，请检查 ${source}`);
  const sequence = document.contents;
  const entries: Config = {};
  const enabled: Record<string, boolean> = {};
  const positions = new Map<string, number>();
  sequence.items.forEach((entry, index) => {
    if (!isMap(entry)) return;
    const plugin = entry.get('name', true);
    if (!isScalar(plugin) || plugin.value !== '@deepseek-ai/dsh-mcp-client') return;
    const configNode = entry.get('config', true);
    const config: unknown = isMap(configNode) ? configNode.toJSON() : undefined;
    if (!isConfig(config) || typeof config.serverName !== 'string') throw new Error(`DSH MCP 配置缺少 serverName，请检查 ${source}`);
    if (positions.has(config.serverName)) throw new Error(`DSH MCP serverName 重复，请检查 ${source}`);
    Object.defineProperty(entries, config.serverName, { value: config, enumerable: true, configurable: true });
    const disabled = entry.get('disabled', true);
    enabled[config.serverName] = !isScalar(disabled) || disabled.value !== true;
    positions.set(config.serverName, index);
  });
  function update(path: (string | number)[], previous: unknown, value: unknown) {
    if (JSON.stringify(previous) === JSON.stringify(value)) return;
    if (isConfig(previous) && isConfig(value)) {
      for (const key of Object.keys(previous)) if (!Object.hasOwn(value, key)) document.deleteIn([...path, key]);
      for (const [key, child] of Object.entries(value)) update([...path, key], previous[key], child);
    } else if (Array.isArray(previous) && Array.isArray(value)) {
      for (let index = previous.length - 1; index >= value.length; index--) document.deleteIn([...path, index]);
      value.forEach((child, index) => update([...path, index], previous[index], child));
    } else {
      document.setIn(path, value);
    }
  }
  return { source, entries, enabled, async write(name, config) {
    const index = positions.get(name);
    if (config === null) {
      if (index !== undefined) sequence.delete(index);
    } else if (index === undefined) {
      document.add({
        id: `mcp-${randomUUID()}`, name: '@deepseek-ai/dsh-mcp-client', config,
      });
    } else {
      update([index, 'config'], entries[name], config);
    }
    file.write(document.toString());
  } };
}

export async function fileMcpStores(agent: Exclude<ExtensionAgent, 'codex'>): Promise<McpStore[]> {
  const directory = agentDirectory(agent);
  if (agent === 'dsh') {
    const profile = join(directory, 'profiles', 'headless', 'cordis.patch.yml');
    const home = join(directory, 'cordis.patch.yml');
    return [...(existsSync(profile) ? [dshStore(profile)] : []), dshStore(home)];
  }
  if (agent === 'opencode') {
    const candidates = [
      join(directory, 'config.json'), join(directory, 'opencode.json'), join(directory, 'opencode.jsonc'),
      ...(process.env.OPENCODE_CONFIG ? [resolve(process.env.OPENCODE_CONFIG)] : []),
      ...(process.env.OPENCODE_CONFIG_DIR ? [
        join(resolve(process.env.OPENCODE_CONFIG_DIR), 'opencode.json'),
        join(resolve(process.env.OPENCODE_CONFIG_DIR), 'opencode.jsonc'),
      ] : []),
    ];
    const existing = new Map<string, string>();
    for (const path of candidates) if (existsSync(path)) existing.set(realpathSync(path), path);
    const paths = [...existing.values()];
    if (paths.length === 0) paths.push(process.env.OPENCODE_CONFIG ? resolve(process.env.OPENCODE_CONFIG) : join(directory, 'opencode.json'));
    return Promise.all(paths.map(path => jsonStore(agent, path)));
  }
  let path: string;
  switch (agent) {
    case 'claude': path = process.env.CLAUDE_CONFIG_DIR ? join(directory, '.claude.json') : join(homedir(), '.claude.json'); break;
    case 'gemini':
    case 'qodercn': path = join(directory, 'settings.json'); break;
    default: path = join(directory, 'mcp.json');
  }
  return [await jsonStore(agent, path)];
}
