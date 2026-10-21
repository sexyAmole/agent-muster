import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { findJsonl } from '../jsonl.js';
import { join, basename, resolve } from 'node:path';
import { fullAutoMode, readOnlyMode, execFileAsync, object, string, tokens, hasTokens, detail, json } from './shared.js';
import type { AgentProvider, ProtocolReader, ParsedResult, AdapterEvent } from './shared.js';

function contextWindow(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([KM])?$/.exec(value);
  return match ? Math.round(Number(match[1]) * (match[2] === 'M' ? 1_000_000 : match[2] === 'K' ? 1_000 : 1)) : undefined;
}

function readPiResult(line: string): ParsedResult {
  const event = json(line);
  if (!event || event.type === 'plain') return {};
  const result: ParsedResult = {};
  if (event.type === 'session') return { ...result, externalSessionId: string(event.id) };
  if (event.type === 'agent_settled') return { ...result, settled: true, aborted: event.aborted === true };
  if (event.type === 'tool_execution_end') return { ...result, tools: [{
    name: string(event.toolName) || 'tool',
    detail: detail({ result: event.result, isError: event.isError, durationMs: event.durationMs }),
  }] };
  if (event.type === 'message_end') {
    const message = object(event.message);
    if (message?.role !== 'assistant') return result;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content.map(part => {
      const block = object(part);
      return block?.type === 'text' ? string(block.text) : undefined;
    }).filter(Boolean).join('\n');
    const thinking = content.map(part => {
      const block = object(part);
      return block?.type === 'thinking' ? string(block.thinking) : undefined;
    }).filter(Boolean).join('\n');
    const usage = object(message.usage);
    const contextTokens = usage?.totalTokens;
    return { ...result, contextTokens: typeof contextTokens === 'number' && Number.isFinite(contextTokens) && contextTokens >= 0 ? contextTokens : undefined, thinking: thinking || undefined, text: text || undefined, error: string(message.errorMessage), usage: usage && hasTokens(usage, ['input', 'cacheRead', 'cacheWrite', 'output']) ? {
      inputTokens: tokens(usage.input) + tokens(usage.cacheRead) + tokens(usage.cacheWrite),
      outputTokens: tokens(usage.output),
      cacheReadTokens: typeof usage.cacheRead === 'number' ? tokens(usage.cacheRead) : undefined,
      cacheWriteTokens: typeof usage.cacheWrite === 'number' ? tokens(usage.cacheWrite) : undefined,
    } : undefined };
  }
  return result;
}

export const pi: AgentProvider & { createResultReader(): ProtocolReader } = {
  id: 'pi',
  sandboxSupported: false,
  permissionModes: [fullAutoMode, readOnlyMode],
  name: 'Pi',
  command: 'pi',
  installation: { kind: 'npm', packageName: '@earendil-works/pi-coding-agent' },
  async models() {
    const { stdout } = await execFileAsync('pi', ['--list-models'], { timeout: 5000 });
    return stdout.trim().split(/\r?\n/).slice(1).flatMap(line => {
      const [provider, model, limit] = line.trim().split(/\s+/);
      if (!provider || !model) return [];
      return [{ id: `${provider}/${model}`, name: `${provider}/${model}`, contextWindow: contextWindow(limit) }];
    });
  },
  async configuredModel() {
    const config = JSON.parse(await readFile(join(homedir(), '.pi', 'agent', 'settings.json'), 'utf8')) as { defaultProvider?: string; defaultModel?: string };
    return config.defaultProvider && config.defaultModel ? `${config.defaultProvider}/${config.defaultModel}` : undefined;
  },
  async sessionLogFile(session) {
    const agentDir = process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent');
    const project = `--${resolve(session.cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    return findJsonl(join(agentDir, 'sessions', project), file => basename(file).endsWith(`_${session.externalSessionId}.jsonl`));
  },
  launch(prompt, externalSessionId, model, images, { permissionMode = 'full-auto' } = {}) {
    return {
      command: 'pi',
      args: ['--mode', 'json', ...(permissionMode === 'read-only' ? ['--no-extensions', '--no-mcp', '--tools', 'read,grep,find,ls'] : []), ...(externalSessionId ? ['--session', externalSessionId] : []), ...(model ? ['--model', model] : []), ...(images?.map(image => `@${image.path}`) || [])],
      prompt,
    };
  },

  createResultReader() {
    const messages = new Set<string>();
    const completedTools = new Set<string>();
    const toolArgs = new Map<string, unknown>();
    let failed = false;
    return line => {
      const event = json(line);
      if (event?.type === 'message_end') {
        const message = object(event.message);
        if (message?.role === 'assistant' && typeof message.timestamp === 'number') {
          const key = `${message.role}:${message.timestamp}`;
          if (messages.has(key)) return {};
          messages.add(key);
        }
      }
      const id = string(event?.toolCallId);
      if (id && event?.type === 'tool_execution_start') toolArgs.set(id, event.args);
      if (id && event?.type === 'tool_execution_end') {
        if (completedTools.has(id)) return {};
        completedTools.add(id);
        const result = readPiResult(line);
        const args = event.args === undefined ? toolArgs.get(id) : event.args;
        toolArgs.delete(id);
        return { ...result, tools: [{
          name: string(event.toolName) || 'tool',
          detail: detail({ args, result: event.result, isError: event.isError, durationMs: event.durationMs }),
        }] };
      }
      const result = readPiResult(line);
      if (event?.type === 'message_end') {
        const message = object(event.message);
        if (message?.role === 'assistant') failed = message.stopReason === 'error' || Boolean(result.error);
      }
      return result.settled ? { ...result, failed } : result;
    };
  },
  settlementError: 'Pi 进程退出前未返回 agent_settled，无法确认任务已完成。',
  createReader() {
    const read = pi.createResultReader();
    let messageKey: string | undefined;
    let messageNumber = 0;
    const content: Record<string, unknown>[] = [];
    const streams = new Set<string>();
    const positions = new Map<string, { orderKey: string; contentIndex: number }>();
    const toolArgs = new Map<string, unknown>();
    const completedMessages = new Set<string>();
    const blocks = (values: unknown[], streaming: boolean): AdapterEvent[] => values.flatMap((value, contentIndex) => {
      const block = object(value);
      if (block?.type === 'toolCall' && typeof block.id === 'string' && messageKey) {
        positions.set(block.id, { orderKey: messageKey, contentIndex });
        return [];
      }
      if (block?.type !== 'text' && block?.type !== 'thinking') return [];
      const type = block.type === 'text' ? 'output' : 'thinking';
      const text = string(block[block.type]);
      if (!text) return [];
      const streamId = `${messageKey}:${type}:${contentIndex}`;
      streams.add(streamId);
      return [{ type, text, streamId, orderKey: messageKey, contentIndex, streaming }];
    });
    function readMessageUpdate(event: Record<string, unknown>): ParsedResult {
      if (!messageKey) return {};
      const update = object(event.assistantMessageEvent)!;
      const index = update.contentIndex as number;
      if (update.type === 'text_start' || update.type === 'thinking_start') {
        const type = update.type === 'text_start' ? 'text' : 'thinking';
        content[index] = { type, [type]: '' };
      } else if (update.type === 'text_delta' || update.type === 'thinking_delta') {
        const type = update.type === 'text_delta' ? 'text' : 'thinking';
        content[index][type] = (content[index][type] as string) + update.delta;
      } else if (update.type === 'text_end' || update.type === 'thinking_end') {
        const type = update.type === 'text_end' ? 'text' : 'thinking';
        content[index] = { type, [type]: update.content };
      } else if (update.type === 'toolcall_end') content[index] = object(update.toolCall)!;
      else if (update.type === 'toolcall_start') content[index] = { type: 'toolCall', id: update.id, name: update.toolName, partialArguments: '' };
      else if (update.type === 'toolcall_delta') content[index].partialArguments = (content[index].partialArguments as string) + update.delta;
      return { events: blocks(content, true) };
    }

    function readCompletedMessage(event: Record<string, unknown>, result: ParsedResult): ParsedResult {
      const message = object(event.message)!;
      const key = typeof message.timestamp === 'number' ? `assistant:${message.timestamp}` : undefined;
      if (key && completedMessages.has(key)) return {};
      if (key) completedMessages.add(key);
      messageKey ??= `message:${++messageNumber}`;
      const previous = [...streams];
      const events = blocks(Array.isArray(message.content) ? message.content : [], false);
      const confirmed = new Set(events.map(item => item.streamId));
      messageKey = undefined;
      content.length = 0;
      streams.clear();
      return { ...result, text: undefined, thinking: undefined, events, clearStreamIds: previous.filter(id => !confirmed.has(id)), failed: false };
    }

    function readToolEvent(event: Record<string, unknown>, result: ParsedResult): ParsedResult {
      const id = string(event.toolCallId);
      if (event.type === 'tool_execution_start' && id) {
        toolArgs.set(id, event.args);
        return { events: [{ type: 'tool', text: string(event.toolName) || 'tool', detail: JSON.stringify({ args: event.args }), streamId: `tool:${id}`, orderKey: `tool:${id}`, streaming: true, ...positions.get(id) }] };
      }
      if (event.type === 'tool_execution_update' && id) {
        return { events: [{ type: 'tool', text: string(event.toolName) || 'tool',
          detail: detail({ args: toolArgs.get(id), result: event.partialResult }),
          streamId: `tool:${id}`, orderKey: `tool:${id}`, streaming: true, ...positions.get(id) }] };
      }
      if (event.type === 'tool_execution_end' && id && result.tools?.length) {
        const args = event.args === undefined ? toolArgs.get(id) : event.args;
        toolArgs.delete(id);
        return { ...result, tools: undefined, events: [{ type: 'tool', text: result.tools[0].name,
          detail: detail({ args, result: event.result, isError: event.isError, durationMs: event.durationMs }),
          streamId: `tool:${id}`, orderKey: `tool:${id}`, streaming: false, ...positions.get(id) }] };
      }
      return result;
    }

    return line => {
      const event = json(line);
      if (!event || event.type === 'plain') return {};
      if (event.type === 'message_start' && object(event.message)?.role === 'assistant') {
        messageKey = `message:${++messageNumber}`;
        content.length = 0;
        streams.clear();
        return { events: [] };
      }
      if (event.type === 'message_update') return readMessageUpdate(event);
      const result = read(line);
      if (event.type === 'message_end' && object(event.message)?.role === 'assistant') {
        return readCompletedMessage(event, result);
      }
      return readToolEvent(event, result);
    };
  },
};
