import { object, string, detail, json } from './shared.js';
import type { ProtocolAdapter, FileChange } from './shared.js';

export const cursor: ProtocolAdapter = {
  id: 'cursor',
  launch(prompt, externalSessionId, model, images) {
    if (images?.length) throw new Error('当前 Cursor CLI 接入不支持图片附件输入');
    return {
      command: 'cursor-agent',
      args: ['--print', '--force', '--output-format', 'stream-json', ...(externalSessionId ? ['--resume', externalSessionId] : []), ...(model ? ['--model', model] : []), '--', prompt],
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
    };
  },
};
