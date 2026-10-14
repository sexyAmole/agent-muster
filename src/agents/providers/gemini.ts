import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { findJsonl } from '../jsonl.js';
import { join, basename } from 'node:path';
import { object, string, tokens, hasTokens, detail, json } from './shared.js';
import type { AgentProvider, ParsedResult } from './shared.js';

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

export const gemini: AgentProvider = {
  id: 'gemini',
  name: 'Gemini CLI',
  command: 'gemini',
  installation: { kind: 'npm', packageName: '@google/gemini-cli' },
  async models() {
    return ['auto-gemini-3', 'auto-gemini-2.5', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'].map(id => ({ id, name: id }));
  },
  async configuredModel() {
    if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
    const config = JSON.parse(await readFile(join(homedir(), '.gemini', 'settings.json'), 'utf8')) as { model?: { name?: string } };
    return config.model?.name;
  },
  async sessionLogFile(session) {
    return findJsonl(join(homedir(), '.gemini', 'tmp'), file => basename(file).startsWith('session-') && basename(file).includes(session.externalSessionId!.slice(0, 8)), session.externalSessionId);
  },
  launch(prompt, externalSessionId, model, images) {
    return {
      command: 'gemini',
      args: ['--output-format', 'stream-json', '--approval-mode', 'auto_edit', '--skip-trust', ...(externalSessionId ? ['--resume', externalSessionId] : []), ...(model ? ['--model', model] : []), '-p', [prompt, ...(images?.map(image => `@${image.path}`) || [])].join('\n')],
    };
  },

  createReader() {
    let text = '';
    return line => {
      const event = json(line);
      const result = readGeminiResult(line);
      if (event?.type === 'message' && event.role === 'assistant') {
        text += result.text || '';
        return {};
      }
      if (event?.type === 'tool_use' || event?.type === 'result' || (event?.type === 'error' && event.severity === 'error')) {
        result.text = text || undefined;
        text = '';
      }
      return result;
    };
  },
};
