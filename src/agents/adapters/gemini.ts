import { object, string, tokens, hasTokens, detail, json } from './shared.js';
import type { ProtocolAdapter, ParsedResult, FileChange } from './shared.js';

function readGeminiResult(line: string): ParsedResult {
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
}

export const gemini: ProtocolAdapter = {
  id: 'gemini',
  launch(prompt, externalSessionId, model, images) {
    return {
      command: 'gemini',
      args: ['--output-format', 'stream-json', '--approval-mode', 'auto_edit', '--skip-trust', ...(externalSessionId ? ['--resume', externalSessionId] : []), ...(model ? ['--model', model] : []), '-p', [prompt, ...(images?.map(image => `@${image.path}`) || [])].join('\n')],
    };
  },

  createReader() {
    let text = '';
    const edits = new Map<string, FileChange>();
    return line => {
      const event = json(line);
      const result = readGeminiResult(line);
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
