import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { debugEnabled } from '../../debug.js';
import type { AgentAction, AgentImage, AgentSession, ModelInfo, PermissionMode, TokenUsage, ImageGeneration } from '../../types.js';

export const execFileAsync = promisify(execFile);

export interface Launch {
  command: string;
  args: string[];
  prompt?: string;
  env?: NodeJS.ProcessEnv;
  connect?: (child: ChildProcessWithoutNullStreams, cwd: string) => ProtocolReader;
}

export interface ExecutionOptions {
  permissionMode?: string;
  sandboxEnabled?: boolean;
}

export const fullAutoMode: PermissionMode = { id: 'full-auto', name: '全自动', description: '无需人工审批，仍受沙箱和明确的拒绝规则约束' };
export const readOnlyMode: PermissionMode = { id: 'read-only', name: '只读', description: '仅使用读取和搜索工具，不执行命令或修改文件' };
export const autoReviewMode: PermissionMode = { id: 'auto-review', name: '自动审核', description: '由 Agent 自动审核操作；无法批准的操作会被拒绝，当前不支持人工审批' };
export const planMode: PermissionMode = { id: 'plan', name: '只读规划', description: '使用 Agent 原生规划模式分析任务' };

export type GeneratedImage = { data: string } | { path: string };

export interface AdapterEvent {
  type: 'output' | 'thinking' | 'tool';
  imageGeneration?: ImageGeneration;
  generatedImage?: GeneratedImage;
  text: string;
  detail?: string;
  streamId?: string;
  orderKey?: string;
  contentIndex?: number;
  streaming?: boolean;
}

export interface ParsedResult {
  text?: string;
  thinking?: string;
  externalSessionId?: string;
  error?: string;
  tools?: ToolCall[];
  usage?: TokenUsage;
  usageIsTotal?: boolean;
  contextTokens?: number;
  settled?: boolean;
  aborted?: boolean;
  failed?: boolean;
  events?: AdapterEvent[];
  clearStreamIds?: string[];
}

export type ProtocolReader = (line: string) => ParsedResult;

export interface ProtocolAdapter {
  id: string;
  launch(prompt: string, externalSessionId?: string, model?: string, images?: AgentImage[], options?: ExecutionOptions): Launch;
  createReader(): ProtocolReader;
  createRawReader?(): (chunk: string, channel: 'stdout' | 'stderr') => ParsedResult;
  readStderr?(line: string): AgentEvent[];
  readError?(line: string): string | undefined;
  settlementError?: string;
}

export type AgentInstallation =
  | { kind: 'external'; message: string }
  | { kind: 'npm'; packageName: string }
  | {
    kind: 'cursor';
    supported: boolean;
    unsupportedMessage: string;
    owns(path: string, target: string): boolean;
    run(action: AgentAction, path?: string): Promise<string>;
  };

export interface AgentProvider extends ProtocolAdapter {
  resolveExecutable?(): Promise<string | undefined>;
  version?(): Promise<string>;
  sandboxSupported: boolean;
  permissionModes: PermissionMode[];
  name: string;
  command: string;
  installation: AgentInstallation;
  models(): Promise<ModelInfo[]>;
  configuredModel(): Promise<string | undefined>;
  sessionLogFile?(session: AgentSession): Promise<string | undefined>;
}

export type AgentEvent =
  | (Omit<AdapterEvent, 'type'> & { type: 'output' | 'thinking' | 'tool' | 'error' | 'warning' })
  | { type: 'usage'; usage: TokenUsage; total?: boolean };

export interface AdapterResult {
  events: AgentEvent[];
  contextTokens?: number;
  externalSessionId?: string;
  settled?: boolean;
  aborted?: boolean;
  failed?: boolean;
  clearStreamIds?: string[];
}

export interface Adapter {
  id: string;
  launch: ProtocolAdapter['launch'];
  createReader(reader?: ProtocolReader): (line: string, channel: 'stdout' | 'stderr') => AdapterResult;
  createRawReader?(): (chunk: string, channel: 'stdout' | 'stderr') => AdapterResult;
  settlementError?: string;
}

function normalizeResult(result: ParsedResult): AdapterResult {
  const events: AgentEvent[] = [];
  if (result.thinking) events.push({ type: 'thinking', text: result.thinking });
  if (result.text) events.push({ type: 'output', text: result.text });
  if (result.usage) events.push({ type: 'usage', usage: result.usage, total: result.usageIsTotal });
  events.push(...result.events || []);
  for (const tool of result.tools || []) events.push({ type: 'tool', text: tool.name, detail: tool.detail });
  if (result.error) events.push({ type: 'error', text: result.error });
  return {
    events, contextTokens: result.contextTokens, externalSessionId: result.externalSessionId, settled: result.settled, aborted: result.aborted,
    failed: result.error ? result.failed ?? true : result.settled ? result.failed : undefined, clearStreamIds: result.clearStreamIds,
  };
}

export function createAdapter(protocol: ProtocolAdapter): Adapter {
  return {
    id: protocol.id,
    launch: protocol.launch,
    settlementError: protocol.settlementError,
    ...(protocol.createRawReader ? {
      createRawReader() {
        const read = protocol.createRawReader!();
        return (chunk: string, channel: 'stdout' | 'stderr') => normalizeResult(read(chunk, channel));
      },
    } : {}),
    createReader(reader) {
      const read = reader ?? protocol.createReader();
      return (line, channel) => {
        // if (debugEnabled) console.log(`[调试][${protocol.id}][${channel}]`, line);
        if (channel === 'stdout') return normalizeResult(read(line.trim()));
        if (!line.trim()) return { events: [] };
        if (protocol.readStderr) return { events: protocol.readStderr(line) };
        const error = protocol.readError?.(line);
        const warning = line.trim().split(/\r?\n/).every(value => /^\S+\s+WARN\b/.test(value));
        return { events: [{ type: warning ? 'warning' : 'error', text: error || line }], failed: error ? true : undefined };
      };
    },
  };
}

interface ToolCall {
  name: string;
  detail?: string;
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function hasTokens(usage: Record<string, unknown>, keys: string[]): boolean {
  return keys.some(key => typeof usage[key] === 'number');
}

export function detail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export function toolText(name: string, input: unknown): string {
  const args = object(input);
  const target = string(args?.command) || string(args?.file_path) || string(args?.path) || string(args?.pattern);
  if (target) return `${name} ${target}`;
  return args && Object.keys(args).length ? `${name} ${JSON.stringify(args)}` : name;
}

export function json(line: string): Record<string, unknown> | undefined {
  try { return object(JSON.parse(line)); } catch { return { type: 'plain', text: line }; }
}

