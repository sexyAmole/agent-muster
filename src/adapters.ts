import type { AgentImage, TokenUsage } from './types.js';

interface Launch {
  command: string;
  args: string[];
  prompt?: string;
}

export interface Adapter {
  id: string;
  launch(prompt: string, externalSessionId?: string, model?: string, images?: AgentImage[]): Launch;
  read(line: string): { text?: string; externalSessionId?: string; error?: string; tools?: ToolCall[]; changes?: FileChange[]; usage?: TokenUsage; usageIsTotal?: boolean };
}

interface ToolCall {
  name: string;
  detail?: string;
}

interface FileChange {
  path: string;
  kind: string;
  diff?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function hasTokens(usage: Record<string, unknown>, keys: string[]): boolean {
  return keys.some(key => typeof usage[key] === 'number');
}

function detail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function json(line: string): Record<string, unknown> | undefined {
  try { return object(JSON.parse(line)); } catch { return { type: 'plain', text: line }; }
}

const codex: Adapter = {
  id: 'codex',
  launch(prompt, externalSessionId, model, images) {
    const imageArgs = images?.flatMap(image => ['--image', image.path]) || [];
    return {
      command: 'codex',
      args: externalSessionId
        ? ['exec', 'resume', ...imageArgs, '--json', '--skip-git-repo-check', ...(model ? ['--model', model] : []), externalSessionId, '-']
        : ['exec', ...imageArgs, '--json', '--skip-git-repo-check', ...(model ? ['--model', model] : []), '-'],
      prompt,
    };
  },
  read(line) {
    const event = json(line);
    if (!event) return {};
    if (event.type === 'thread.started') return { externalSessionId: string(event.thread_id) };
    if (event.type === 'turn.completed') {
      const usage = object(event.usage);
      if (usage && hasTokens(usage, ['input_tokens', 'output_tokens'])) return { usage: { inputTokens: tokens(usage.input_tokens), outputTokens: tokens(usage.output_tokens) }, usageIsTotal: true };
    }
    if (event.type === 'item.completed') {
      const item = object(event.item);
      if (item?.type === 'agent_message') return { text: string(item.text) };
      if (item?.type === 'command_execution') return { tools: [{ name: `$ ${string(item.command) || 'command'}`, detail: string(item.aggregated_output) }] };
      if (item?.type === 'mcp_tool_call') return { tools: [{ name: `${string(item.server) || 'MCP'} / ${string(item.tool) || 'tool'}`, detail: detail(item.result) }] };
      if (item?.type === 'file_change') {
        const changes = item.changes;
        if (Array.isArray(changes)) return { changes: changes.flatMap(value => {
          const change = object(value);
          const path = string(change?.path);
          return path ? [{ path, kind: string(change?.kind) || 'update', diff: string(change?.unified_diff) }] : [];
        }) };
        const entries = object(changes);
        if (entries) return { changes: Object.entries(entries).map(([path, value]) => {
          const change = object(value);
          return { path, kind: string(change?.type) || 'update', diff: string(change?.unified_diff) };
        }) };
      }
    }
    if (event.type === 'error') return { error: string(event.message) || 'Codex error' };
    if (event.type === 'plain') return { text: string(event.text) };
    return {};
  },
};

const claude: Adapter = {
  id: 'claude',
  launch(prompt, externalSessionId, model, images) {
    return {
      command: 'claude',
      args: ['-p', '--verbose', '--output-format', 'stream-json', ...(images?.length ? ['--input-format', 'stream-json'] : []), ...(externalSessionId ? ['--resume', externalSessionId] : []), ...(model ? ['--model', model] : [])],
      prompt: images?.length ? JSON.stringify({
        type: 'user', message: { role: 'user', content: [
          { type: 'text', text: prompt },
          ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } })),
        ] },
      }) : prompt,
    };
  },
  read(line) {
    const event = json(line);
    if (!event) return {};
    const externalSessionId = string(event.session_id);
    if (event.type === 'assistant') {
      const message = object(event.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      const text = content.map(part => {
        const block = object(part);
        if (block?.type === 'text') return string(block.text);
        return undefined;
      }).filter(Boolean).join('\n');
      const tools = content.flatMap(part => {
        const block = object(part);
        return block?.type === 'tool_use' ? [{ name: string(block.name) || 'tool', detail: detail(block.input) }] : [];
      });
      const usage = object(message?.usage);
      return { externalSessionId, text: text || undefined, tools, usage: usage && hasTokens(usage, ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) ? {
        inputTokens: tokens(usage.input_tokens) + tokens(usage.cache_creation_input_tokens) + tokens(usage.cache_read_input_tokens),
        outputTokens: tokens(usage.output_tokens),
      } : undefined };
    }
    if (event.type === 'result') {
      return { externalSessionId, error: event.is_error ? string(event.result) || 'Claude error' : undefined };
    }
    if (event.type === 'plain') return { text: string(event.text) };
    return { externalSessionId };
  },
};

const pi: Adapter = {
  id: 'pi',
  launch(prompt, externalSessionId, model, images) {
    return {
      command: 'pi',
      args: ['--mode', 'json', ...(externalSessionId ? ['--session', externalSessionId] : []), ...(model ? ['--model', model] : []), ...(images?.map(image => `@${image.path}`) || [])],
      prompt,
    };
  },
  read(line) {
    const event = json(line);
    if (!event) return {};
    if (event.type === 'session') return { externalSessionId: string(event.id) };
    if (event.type === 'tool_execution_start') return { tools: [{ name: string(event.toolName) || 'tool', detail: detail(event.args) }] };
    if (event.type === 'message_end') {
      const message = object(event.message);
      if (message?.role !== 'assistant') return {};
      const content = Array.isArray(message.content) ? message.content : [];
      const text = content.map(part => {
        const block = object(part);
        return block?.type === 'text' ? string(block.text) : undefined;
      }).filter(Boolean).join('\n');
      const usage = object(message.usage);
      return { text: text || undefined, error: string(message.errorMessage), usage: usage && hasTokens(usage, ['input', 'cacheRead', 'cacheWrite', 'output']) ? {
        inputTokens: tokens(usage.input) + tokens(usage.cacheRead) + tokens(usage.cacheWrite),
        outputTokens: tokens(usage.output),
      } : undefined };
    }
    return {};
  },
};

const kimi: Adapter = {
  id: 'kimi',
  launch(prompt, externalSessionId, model) {
    return {
      command: 'kimi',
      args: ['--output-format', 'stream-json', ...(externalSessionId ? ['--session', externalSessionId] : []), ...(model ? ['--model', model] : []), '-p', prompt],
    };
  },
  read(line) {
    const event = json(line);
    if (!event) return {};
    if (event.role === 'meta' && event.type === 'session.resume_hint') return { externalSessionId: string(event.session_id) };
    if (event.role === 'assistant') {
      const calls = Array.isArray(event.tool_calls) ? event.tool_calls : [];
      const tools = calls.map(call => {
        const invocation = object(object(call)?.function);
        return { name: string(invocation?.name) || 'tool', detail: detail(invocation?.arguments) };
      });
      const usage = object(event.usage);
      return { text: string(event.content), tools, usage: usage && hasTokens(usage, ['prompt_tokens', 'completion_tokens']) ? {
        inputTokens: tokens(usage.prompt_tokens),
        outputTokens: tokens(usage.completion_tokens),
      } : undefined };
    }
    return {};
  },
};

export const adapters: Record<string, Adapter> = { codex, claude, pi, kimi };
