import type { AgentImage, TokenUsage } from '../types.js';

interface Launch {
  command: string;
  args: string[];
  prompt?: string;
}

export interface Adapter {
  id: string;
  launch(prompt: string, externalSessionId?: string, model?: string, images?: AgentImage[]): Launch;
  read(line: string): { text?: string; externalSessionId?: string; error?: string; tools?: ToolCall[]; changes?: FileChange[]; usage?: TokenUsage; usageIsTotal?: boolean };
  createReader?(): Adapter['read'];
  readError?(line: string): string | undefined;
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
      args: ['-p', '--verbose', '--output-format', 'stream-json','--permission-mode','auto', ...(images?.length ? ['--input-format', 'stream-json'] : []), ...(externalSessionId ? ['--resume', externalSessionId] : []), ...(model ? ['--model', model] : [])],
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

const gemini: Adapter = {
  id: 'gemini',
  launch(prompt, externalSessionId, model, images) {
    return {
      command: 'gemini',
      args: ['--output-format', 'stream-json', '--approval-mode', 'auto_edit', '--skip-trust', ...(externalSessionId ? ['--resume', externalSessionId] : []), ...(model ? ['--model', model] : []), '-p', [prompt, ...(images?.map(image => `@${image.path}`) || [])].join('\n')],
    };
  },
  read(line) {
    const event = json(line);
    if (!event) return {};
    if (event.type === 'init') return { externalSessionId: string(event.session_id) };
    if (event.type === 'message' && event.role === 'assistant') return { text: string(event.content) };
    if (event.type === 'tool_use') return { tools: [{ name: string(event.tool_name) || 'tool', detail: detail(event.parameters) }] };
    if (event.type === 'error' && event.severity === 'error') return { error: string(event.message) };
    if (event.type === 'result') {
      const stats = object(event.stats);
      return {
        error: event.status === 'error' ? string(object(event.error)?.message) || 'Gemini 执行失败' : undefined,
        usage: stats && hasTokens(stats, ['input_tokens', 'output_tokens']) ? {
          inputTokens: tokens(stats.input_tokens), outputTokens: tokens(stats.output_tokens),
        } : undefined,
      };
    }
    return {};
  },
  createReader() {
    let text = '';
    const edits = new Map<string, FileChange>();
    return line => {
      const event = json(line);
      const result = gemini.read(line);
      if (event?.type === 'message' && event.role === 'assistant') {
        text += result.text || '';
        return {};
      }
      if (event?.type === 'tool_use') {
        const path = string(object(event.parameters)?.file_path);
        const id = string(event.tool_id);
        if (path && id && (event.tool_name === 'write_file' || event.tool_name === 'replace')) {
          edits.set(id, { path, kind: 'update' });
        }
      }
      if (event?.type === 'tool_result') {
        const id = string(event.tool_id);
        const change = id ? edits.get(id) : undefined;
        if (id) edits.delete(id);
        if (change && event.status === 'success') result.changes = [change];
      }
      if (event?.type === 'tool_use' || event?.type === 'result' || (event?.type === 'error' && event.severity === 'error')) {
        result.text = text || undefined;
        text = '';
      }
      return result;
    };
  },
};

const opencode: Adapter = {
  id: 'opencode',
  launch(prompt, externalSessionId, model, images) {
    return {
      command: 'opencode',
      args: ['run', '--format', 'json', ...(externalSessionId ? ['--session', externalSessionId] : []), ...(model ? ['--model', model] : []), ...(images?.flatMap(image => ['--file', image.path]) || [])],
      prompt,
    };
  },
  readError(line) {
    if (/^ProviderModelNotFoundError:/.test(line.trim())) {
      return 'OpenCode 配置的模型不存在，请选择可用模型，或修改 OpenCode 的默认模型配置。';
    }
    if (/^\w*Error:/.test(line.trim())) return line;
  },
  read(line) {
    const event = json(line);
    if (!event) return {};
    const externalSessionId = string(event.sessionID);
    const part = object(event.part);
    if (event.type === 'text') return { externalSessionId, text: string(part?.text) };
    if (event.type === 'tool_use') {
      const state = object(part?.state);
      const input = object(state?.input);
      const path = string(input?.filePath);
      const metadata = object(state?.metadata);
      const filediff = object(metadata?.filediff);
      const changes: FileChange[] = [];
      if (state?.status === 'completed') {
        if (path && (part?.tool === 'write' || part?.tool === 'edit')) changes.push({ path, kind: 'update', diff: string(filediff?.diff) });
        if (part?.tool === 'apply_patch' && Array.isArray(metadata?.files)) {
          for (const value of metadata.files) {
            const file = object(value);
            const path = string(file?.filePath);
            if (path) changes.push({ path, kind: string(file?.type) || 'update', diff: string(file?.patch) });
          }
        }
      }
      return { externalSessionId, tools: [{ name: string(part?.tool) || 'tool', detail: detail(state) }], changes };
    }
    if (event.type === 'step_finish') {
      const usage = object(part?.tokens);
      const cache = object(usage?.cache);
      return { externalSessionId, usage: usage && hasTokens(usage, ['input', 'output']) ? {
        inputTokens: tokens(usage.input) + tokens(cache?.read) + tokens(cache?.write),
        outputTokens: tokens(usage.output) + tokens(usage.reasoning),
      } : undefined };
    }
    if (event.type === 'error') return { externalSessionId, error: string(object(object(event.error)?.data)?.message) || string(object(event.error)?.name) || 'OpenCode 执行失败' };
    return { externalSessionId };
  },
};

const cursor: Adapter = {
  id: 'cursor',
  launch(prompt, externalSessionId, model, images) {
    if (images?.length) throw new Error('当前 Cursor CLI 接入不支持图片附件输入');
    return {
      command: 'cursor-agent',
      args: ['--print', '--force', '--output-format', 'stream-json', ...(externalSessionId ? ['--resume', externalSessionId] : []), ...(model ? ['--model', model] : []), '--', prompt],
    };
  },
  read(line) {
    const event = json(line);
    if (!event) return {};
    const externalSessionId = string(event.session_id);
    if (event.type === 'assistant') {
      const message = object(event.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      const text = content.flatMap(value => {
        const block = object(value);
        return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
      }).join('');
      return { externalSessionId, text: text || undefined };
    }
    if (event.type === 'tool_call' && event.subtype === 'completed') {
      const calls = object(event.tool_call);
      const changes: FileChange[] = [];
      const tools = Object.entries(calls || {}).map(([name, value]) => {
        const call = object(value);
        const path = string(object(call?.args)?.path);
        if (path && name === 'writeToolCall' && object(object(call?.result)?.success)) changes.push({ path, kind: 'update' });
        return { name, detail: detail(call) };
      });
      return { externalSessionId, tools, changes };
    }
    if (event.type === 'result') return { externalSessionId, error: event.is_error ? string(event.result) || 'Cursor 执行失败' : undefined };
    return { externalSessionId };
  },
};

export const adapters: Record<string, Adapter> = { codex, claude, pi, kimi, gemini, opencode, cursor };
