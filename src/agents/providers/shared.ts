import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentAction, AgentImage, AgentSession, ModelInfo, TokenUsage } from '../../types.js';

export const execFileAsync = promisify(execFile);

export interface Launch {
  command: string;
  args: string[];
  prompt?: string;
}

export interface AdapterEvent {
  type: 'output' | 'thinking' | 'tool';
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
  settled?: boolean;
  aborted?: boolean;
  failed?: boolean;
  events?: AdapterEvent[];
  clearStreamIds?: string[];
}

export type ProtocolReader = (line: string) => ParsedResult;

export interface ProtocolAdapter {
  id: string;
  launch(prompt: string, externalSessionId?: string, model?: string, images?: AgentImage[]): Launch;
  createReader(): ProtocolReader;
  createRawReader?(): (chunk: string, channel: 'stdout' | 'stderr') => ParsedResult;
  readError?(line: string): string | undefined;
  settlementError?: string;
}

export type AgentInstallation =
  | { kind: 'npm'; packageName: string }
  | {
    kind: 'cursor';
    supported: boolean;
    unsupportedMessage: string;
    owns(path: string, target: string): boolean;
    run(action: AgentAction, path?: string): Promise<string>;
  };

export interface AgentProvider extends ProtocolAdapter {
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
  externalSessionId?: string;
  settled?: boolean;
  aborted?: boolean;
  failed?: boolean;
  clearStreamIds?: string[];
}

export interface Adapter {
  id: string;
  launch: ProtocolAdapter['launch'];
  createReader(): (line: string, channel: 'stdout' | 'stderr') => AdapterResult;
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
    events, externalSessionId: result.externalSessionId, settled: result.settled, aborted: result.aborted,
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
    createReader() {
      const read = protocol.createReader();
      return (line, channel) => {
        if (channel === 'stdout') return normalizeResult(read(line.trim()));
        if (!line.trim()) return { events: [] };
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

export function json(line: string): Record<string, unknown> | undefined {
  try { return object(JSON.parse(line)); } catch { return { type: 'plain', text: line }; }
}

