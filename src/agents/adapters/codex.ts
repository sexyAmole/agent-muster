import { object, string, tokens, hasTokens, detail, json } from './shared.js';
import type { ProtocolAdapter, ParsedResult } from './shared.js';

export const codex: ProtocolAdapter = {
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
  createReader() {
    const handlers = new Map<string, (event: Record<string, unknown>) => ParsedResult>([
      ['thread.started', event => ({ externalSessionId: string(event.thread_id) })],
      ['turn.completed', event => {
        const usage = object(event.usage);
        if (usage && hasTokens(usage, ['input_tokens', 'output_tokens'])) return { usage: { inputTokens: tokens(usage.input_tokens), outputTokens: tokens(usage.output_tokens) }, usageIsTotal: true };
        return {};
      }],
      ['item.completed', event => {
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
        return {};
      }],
      ['error', event => ({ error: string(event.message) || 'Codex error' })],
      ['plain', event => ({ text: string(event.text) })],
    ]);
    return line => {
      const event = json(line);
      if (!event || typeof event.type !== 'string') return {};
      const handle = handlers.get(event.type);
      return handle ? handle(event) : {};
    };
  },
};
