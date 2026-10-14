import { object, string, tokens, hasTokens, detail, json } from './shared.js';
import type { ProtocolAdapter } from './shared.js';

export const kimi: ProtocolAdapter = {
  id: 'kimi',
  launch(prompt, externalSessionId, model) {
    return {
      command: 'kimi',
      args: ['--output-format', 'stream-json', ...(externalSessionId ? ['--session', externalSessionId] : []), ...(model ? ['--model', model] : []), '-p', prompt],
    };
  },
  createReader() {
    return line => {
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
    };
  },
};
