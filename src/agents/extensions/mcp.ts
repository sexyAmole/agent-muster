import { createHash } from 'node:crypto';
import { withCodexConfig } from './codex-config.js';
import { entriesFrom, fileMcpStores, isConfig, type Config, type McpStore } from './mcp-store.js';
import { extensionTransports, type ExtensionAgent, type McpServer, type McpServerConfig, type McpTransport } from './types.js';

const activeWrites = new Set<ExtensionAgent>();

function withStores<T>(agent: ExtensionAgent, operation: (stores: McpStore[]) => Promise<T>): Promise<T> {
  if (agent !== 'codex') return fileMcpStores(agent).then(operation);
  return withCodexConfig(async request => {
    const result = await request('config/read', { includeLayers: true }) as {
      layers?: { name: { type: string; profile?: string | null; file?: string }; config: Config; version: string }[];
    };
    const layer = result.layers?.find(item => item.name.type === 'user' && !item.name.profile);
    if (!layer?.name.file) throw new Error('Codex 未返回用户级配置，请检查 CLI 版本');
    return operation([{
      source: layer.name.file,
      entries: entriesFrom(layer.config.mcp_servers),
      async write(name, config) {
        await request('config/value/write', {
          keyPath: `mcp_servers.${name}`, value: config, mergeStrategy: 'replace',
          filePath: layer.name.file, expectedVersion: layer.version,
        });
      },
    }]);
  });
}

function revision(value: unknown): string {
  const normalized = JSON.stringify(value, (_key, entry: unknown) => isConfig(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]))
    : entry);
  return createHash('sha256').update(normalized).digest('hex');
}

function transportOf(agent: ExtensionAgent, value: Config): string {
  if (agent === 'codex') return typeof value.command === 'string' ? 'stdio' : typeof value.url === 'string' ? 'http' : 'unknown';
  if (agent === 'opencode') return value.type === 'local' ? 'stdio' : value.type === 'remote' ? 'http' : 'unknown';
  if (agent === 'gemini') return typeof value.command === 'string' ? 'stdio' : typeof value.httpUrl === 'string' ? 'http' : typeof value.url === 'string' ? 'sse' : 'unknown';
  const type = agent === 'kimi' || agent === 'dsh' ? value.transport : value.type;
  if (typeof type === 'string') return type === 'streamable-http' ? 'http' : type;
  if (typeof value.command === 'string') return 'stdio';
  if (typeof value.url === 'string' && agent !== 'claude') return 'http';
  return 'unknown';
}

function summarize(agent: ExtensionAgent, stores: McpStore[]): McpServer[] {
  return stores.flatMap(store => Object.entries(store.entries).map(([name, value]) => ({
    name, source: store.source, transport: isConfig(value) ? transportOf(agent, value) : 'unknown',
    enabled: store.enabled?.[name] ?? (['codex', 'pi', 'opencode', 'kimi'].includes(agent) && isConfig(value) ? value.enabled !== false : undefined),
    revision: revision(value),
  }))).sort((a, b) => a.name.localeCompare(b.name));
}

function selectStore(stores: McpStore[], name: string, source?: string, create = false): McpStore {
  const store = source === undefined
    ? (create ? stores.at(-1) : stores.filter(item => Object.hasOwn(item.entries, name)).at(-1))
    : stores.find(item => item.source === source);
  if (!store) throw new Error('MCP 配置来源不存在，请刷新列表');
  return store;
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

function validateConfig(agent: ExtensionAgent, value: unknown, name: string, previous: unknown): asserts value is Config {
  if (!isConfig(value)) throw new Error('MCP 配置必须是 JSON 对象');
  if (agent === 'opencode' && Object.keys(value).length === 1 && typeof value.enabled === 'boolean') return;
  if (agent === 'dsh' && (value.serverName !== name || name.length > 32)) throw new Error('DSH 的 serverName 必须与服务名称一致，且不超过 32 个字符');
  const transport = transportOf(agent, value);
  if (!extensionTransports[agent].includes(transport as McpTransport)) throw new Error('此 Agent 不支持所选 MCP 传输方式');
  if (transport === 'stdio') {
    const validCommand = agent === 'opencode'
      ? Array.isArray(value.command) && value.command.length > 0 && value.command.every(validText)
      : validText(value.command);
    if (!validCommand || value.url !== undefined || value.httpUrl !== undefined) throw new Error('stdio 配置需要有效的启动命令');
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) {
      throw new Error('args 必须是字符串数组');
    }
  } else {
    const field = agent === 'gemini' && transport === 'http' ? 'httpUrl' : 'url';
    const endpoint = value[field];
    if (!validText(endpoint) || value.command !== undefined) throw new Error('远程服务配置需要有效的服务地址');
    const protocols = transport === 'ws' ? ['ws:', 'wss:'] : ['http:', 'https:'];
    const templated = agent !== 'codex' && /\$\{[^}]+\}|\{env:[^}]+\}/.test(endpoint);
    const expression = agent === 'dsh' && isConfig(previous) && previous[field] === endpoint;
    if (!templated && !expression && !protocols.includes(URL.parse(endpoint)?.protocol ?? '')) throw new Error('请输入传输方式对应的有效服务地址');
  }
  for (const field of ['env', 'environment', 'headers', 'http_headers', 'env_http_headers']) {
    const values = value[field];
    if (values !== undefined && (!isConfig(values) || Object.values(values).some(item => typeof item !== 'string'))) {
      throw new Error(`${field} 必须是字符串键值对象`);
    }
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
}

export function listMcpServers(agent: ExtensionAgent): Promise<McpServer[]> {
  return withStores(agent, async stores => summarize(agent, stores));
}

export function getMcpServer(agent: ExtensionAgent, name: string, source?: string): Promise<McpServerConfig> {
  return withStores(agent, async stores => {
    const { entries } = selectStore(stores, name, source);
    if (!Object.hasOwn(entries, name)) throw new Error('MCP 服务不存在，请刷新列表');
    const config = entries[name];
    if (!isConfig(config)) throw new Error('此服务的配置必须是 JSON 对象，请检查用户配置');
    return { config, revision: revision(config) };
  });
}

export async function changeMcpServer(agent: ExtensionAgent, name: string, value: unknown, expectedRevision?: string, source?: string): Promise<McpServer[]> {
  if ((agent === 'codex' || expectedRevision === undefined) && !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('服务名称只能包含字母、数字、连字符和下划线');
  if (activeWrites.has(agent)) throw new Error('正在保存此 Agent 的 MCP 配置，请稍后重试');
  activeWrites.add(agent);
  try {
    return await withStores(agent, async stores => {
      const store = selectStore(stores, name, source, expectedRevision === undefined);
      const exists = Object.hasOwn(store.entries, name);
      if (expectedRevision === undefined && stores.some(item => Object.hasOwn(item.entries, name))) throw new Error('已存在同名 MCP 服务');
      if (expectedRevision !== undefined && (!exists || expectedRevision !== revision(store.entries[name]))) {
        throw new Error('MCP 服务配置已变化，请刷新列表后重试');
      }
      if (value !== null) validateConfig(agent, value, name, store.entries[name]);
      await store.write(name, value as Config | null);
      if (value === null) {
        delete store.entries[name];
        if (store.enabled) delete store.enabled[name];
      } else {
        Object.defineProperty(store.entries, name, { value, enumerable: true, configurable: true });
        if (store.enabled && !Object.hasOwn(store.enabled, name)) store.enabled[name] = true;
      }
      return summarize(agent, stores);
    });
  } finally {
    activeWrites.delete(agent);
  }
}
