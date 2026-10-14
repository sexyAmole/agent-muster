import { execFileAsync, object, string, tokens, hasTokens, detail, json, toolText } from './shared.js';
import type { AgentProvider } from './shared.js';

export const opencode: AgentProvider = {
  id: 'opencode',
  name: 'OpenCode',
  command: 'opencode',
  installation: { kind: 'npm', packageName: 'opencode-ai' },
  async models() {
    const { stdout } = await execFileAsync('opencode', ['models', '--verbose'], { timeout: 10000, maxBuffer: 5_000_000 });
    return stdout.trim().split(/\r?\n(?=[\w.-]+\/[^\s]+\r?$)/m).map(entry => {
      const end = entry.indexOf('\n');
      const id = entry.slice(0, end).trim();
      const model = JSON.parse(entry.slice(end + 1)) as { name: string; limit: { context: number } };
      return { id, name: `${model.name} (${id})`, contextWindow: model.limit.context };
    });
  },
  async configuredModel() {
    const { stdout } = await execFileAsync('opencode', ['debug', 'config'], { timeout: 10000 });
    return (JSON.parse(stdout) as { model?: string }).model;
  },
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
        const id = string(part?.callID);
        return { externalSessionId, events: [{
          type: 'tool', text: toolText(string(part?.tool) || 'tool', state?.input),
          detail: detail(state?.status === 'error' ? state.error : state?.output),
          streamId: id ? `tool:${id}` : undefined, orderKey: id ? `tool:${id}` : undefined,
          streaming: state?.status === 'pending' || state?.status === 'running',
        }] };
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
