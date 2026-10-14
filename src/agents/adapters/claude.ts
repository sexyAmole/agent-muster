import { object, string, tokens, hasTokens, detail, json } from './shared.js';
import type { ProtocolAdapter } from './shared.js';

export const claude: ProtocolAdapter = {
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
  createReader() {
    return line => {
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
    };
  },
};
