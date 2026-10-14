import { homedir } from 'node:os';
import { findJsonl } from '../jsonl.js';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileAsync, object, string, tokens, hasTokens, detail, json } from './shared.js';
import type { AgentProvider } from './shared.js';

export const kimi: AgentProvider = {
  id: 'kimi',
  name: 'Kimi',
  command: 'kimi',
  installation: { kind: 'npm', packageName: '@moonshot-ai/kimi-code' },
  async models() {
    const { stdout } = await execFileAsync('kimi', ['provider', 'list', '--json'], { timeout: 5000 });
    const catalog = JSON.parse(stdout) as { models: Record<string, { displayName?: string; maxContextSize?: number }> };
    return Object.entries(catalog.models).map(([id, model]) => ({ id, name: model.displayName || id, contextWindow: model.maxContextSize }));
  },
  async configuredModel() {
    const { stdout } = await execFileAsync('kimi', ['provider', 'list'], { timeout: 5000 });
    return /^Default model:\s*(\S+)/m.exec(stdout)?.[1];
  },
  async sessionLogFile(session) {
    const directory = process.env.KIMI_CODE_HOME ? resolve(process.env.KIMI_CODE_HOME) : join(homedir(), '.kimi-code');
    return findJsonl(join(directory, 'sessions'), file => {
      const agent = dirname(file);
      const id = basename(dirname(dirname(agent)));
      return basename(file) === 'wire.jsonl' && basename(agent) === 'main' && (id === session.externalSessionId || id === `session_${session.externalSessionId}`);
    });
  },
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
