import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { findJsonl } from '../jsonl.js';
import { join, basename } from 'node:path';
import { fullAutoMode, object, string, tokens, hasTokens, detail, json, toolText } from './shared.js';
import type { AdapterEvent, AgentProvider, ParsedResult } from './shared.js';

function readGeminiResult(event: Record<string, unknown>): ParsedResult {
  if (event.type === 'init') return { externalSessionId: string(event.session_id) };
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
  sandboxSupported: true,
  permissionModes: [fullAutoMode, { id: 'auto-edit', name: '自动编辑', description: '自动批准编辑工具；其他需要人工审批的操作会被拒绝' }],
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
  launch(prompt, externalSessionId, model, images, { permissionMode = 'full-auto', sandboxEnabled = true } = {}) {
    return {
      command: 'gemini',
      args: ['--output-format', 'stream-json', '--approval-mode', permissionMode === 'auto-edit' ? 'auto_edit' : 'yolo', `--sandbox=${sandboxEnabled}`, '--skip-trust', ...(externalSessionId ? ['--resume', externalSessionId] : []), ...(model ? ['--model', model] : []), '-p', [prompt, ...(images?.map(image => `@${image.path}`) || [])].join('\n')],
    };
  },

  createReader() {
    let output: AdapterEvent | undefined;
    let messageNumber = 0;
    const tools = new Map<string, AdapterEvent>();
    function finishText(): AdapterEvent[] {
      if (!output) return [];
      const completed = { ...output, streaming: false };
      output = undefined;
      return [completed];
    }
    return line => {
      const event = json(line);
      if (!event) return {};
      if (event.type === 'message' && event.role === 'assistant') {
        const text = string(event.content);
        if (!text) return {};
        const key = output?.streamId || `message:${++messageNumber}`;
        output = { type: 'output', text: event.delta === true ? (output?.text || '') + text : text, streamId: key, orderKey: key, streaming: event.delta === true };
        return { events: event.delta === true ? [output] : finishText() };
      }
      if (event.type === 'tool_use') {
        const events = finishText();
        const id = string(event.tool_id);
        if (!id) return { events };
        const tool: AdapterEvent = { type: 'tool', text: toolText(string(event.tool_name) || 'tool', event.parameters), streamId: `tool:${id}`, orderKey: `tool:${id}`, streaming: true };
        tools.set(id, tool);
        return { events: [...events, tool] };
      }
      if (event.type === 'tool_result') {
        const id = string(event.tool_id);
        const tool = id && tools.get(id);
        if (!tool) return {};
        tools.delete(id);
        return { events: [{ ...tool, detail: detail(event.status === 'error' ? { output: event.output, error: event.error } : event.output), streaming: false }] };
      }
      const result = readGeminiResult(event);
      if (event.type === 'result' || (event.type === 'error' && event.severity === 'error')) return { ...result, events: finishText() };
      return result;
    };
  },
};
