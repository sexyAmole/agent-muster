import { object, string, tokens, hasTokens, detail, json } from './shared.js';
import type { ProtocolAdapter, FileChange } from './shared.js';

export const opencode: ProtocolAdapter = {
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
  createReader() {
    return line => {
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
    };
  },
};
