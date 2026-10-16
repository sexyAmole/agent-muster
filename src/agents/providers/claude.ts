import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { findJsonl } from '../jsonl.js';
import { join, basename, resolve } from 'node:path';
import { fullAutoMode, autoReviewMode, planMode, object, string, tokens, detail, json } from './shared.js';
import type { AdapterEvent, AgentProvider, ParsedResult } from './shared.js';
import type { TokenUsage } from '../../types.js';

export const claude: AgentProvider = {
  id: 'claude',
  sandboxSupported: true,
  permissionModes: [fullAutoMode, planMode, { id: 'accept-edits', name: '自动接受编辑', description: '自动批准项目文件编辑；其他需要人工审批的操作会被拒绝' }, autoReviewMode],
  name: 'Claude Code',
  command: 'claude',
  installation: { kind: 'npm', packageName: '@anthropic-ai/claude-code' },
  async models() {
    return ['sonnet', 'opus', 'haiku', 'fable'].map(id => ({ id, name: id }));
  },
  async configuredModel() {
    const config = JSON.parse(await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8')) as { model?: string };
    return config.model;
  },
  async sessionLogFile(session) {
    const directory = process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude');
    return findJsonl(join(directory, 'projects'), file => basename(file) === `${session.externalSessionId}.jsonl`);
  },
  launch(prompt, externalSessionId, model, images, { permissionMode = 'full-auto', sandboxEnabled = true } = {}) {
    const permission = ({ plan: 'plan', 'accept-edits': 'acceptEdits', 'auto-review': 'auto', 'full-auto': 'bypassPermissions' } as Record<string, string>)[permissionMode];
    const settings = { sandbox: { enabled: sandboxEnabled, ...(sandboxEnabled ? { allowUnsandboxedCommands: false, failIfUnavailable: true } : {}) } };
    return {
      command: 'claude',
      args: ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--permission-mode', permission, '--permission-prompts', 'none', '--settings', JSON.stringify(settings), ...(images?.length ? ['--input-format', 'stream-json'] : []), ...(externalSessionId ? ['--resume', externalSessionId] : []), ...(model ? ['--model', model] : [])],
      prompt: images?.length ? JSON.stringify({
        type: 'user', message: { role: 'user', content: [
          { type: 'text', text: prompt },
          ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } })),
        ] },
      }) : prompt,
    };
  },
  createReader() {
    let messageKey: string | undefined;
    let messageNumber = 0;
    let activeIndex = 0;
    const blocks = new Map<number, AdapterEvent>();
    const nextIndices = new Map<string, number>();
    const tools = new Map<string, AdapterEvent>();
    function readBlock(block: Record<string, unknown>, key: string, index: number, streaming: boolean): AdapterEvent | undefined {
      const position = { orderKey: key, contentIndex: index };
      if (block.type === 'text' || block.type === 'thinking') {
        return { type: block.type === 'text' ? 'output' : 'thinking', text: string(block[block.type]) || '', streamId: `${key}:${index}`, streaming, ...position };
      }
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        const input = object(block.input);
        const target = string(input?.command) || string(input?.file_path) || string(input?.pattern);
        const name = string(block.name) || 'tool';
        const text = target ? `${name} ${target}` : input && Object.keys(input).length ? `${name} ${JSON.stringify(input)}` : name;
        const event: AdapterEvent = { type: 'tool', text, streamId: `tool:${block.id}`, streaming: true, ...position };
        tools.set(block.id, event);
        return event;
      }
      return undefined;
    }
    function readDelta(update: Record<string, unknown>): AdapterEvent | undefined {
      const previous = blocks.get(activeIndex);
      const delta = object(update.delta);
      if (!previous || !delta) return undefined;
      const block = { ...previous };
      if (delta.type === 'text_delta') block.text += string(delta.text) || '';
      else if (delta.type === 'thinking_delta') block.text += string(delta.thinking) || '';
      else return undefined;
      blocks.set(activeIndex, block);
      return block;
    }

    function readStreamEvent(event: Record<string, unknown>, externalSessionId: string | undefined): ParsedResult {
      const update = object(event.event);
      if (update?.type === 'message_start') {
        messageKey = string(object(update.message)?.id);
        blocks.clear();
      }
      if (!messageKey || !update) return { externalSessionId };
      if (typeof update.index === 'number') activeIndex = update.index;
      if (update.type === 'content_block_start') {
        const content = object(update.content_block);
        const block = content && readBlock(content, messageKey, activeIndex, true);
        if (!block) return { externalSessionId };
        blocks.set(activeIndex, block);
        return { externalSessionId, events: block.text ? [block] : [] };
      }
      if (update.type === 'content_block_delta') {
        const block = readDelta(update);
        return block ? { externalSessionId, events: [block] } : { externalSessionId };
      }
      if (update.type === 'content_block_stop') {
        const block = blocks.get(activeIndex);
        if (block?.streaming && block.type !== 'tool') {
          const completed = { ...block, streaming: false };
          blocks.set(activeIndex, completed);
          return { externalSessionId, events: completed.text ? [completed] : [] };
        }
      }
      return { externalSessionId };
    }

    function readAssistantMessage(event: Record<string, unknown>, externalSessionId: string | undefined): ParsedResult {
      const message = object(event.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      const key = string(message?.id) || string(event.uuid) || `message:${++messageNumber}`;
      const events = content.flatMap((part, index) => {
        const block = object(part);
        if (!block) return [];
        const contentIndex = key === messageKey && content.length === 1 ? activeIndex : (nextIndices.get(key) || 0) + index;
        const parsed = readBlock(block, key, contentIndex, false);
        if (key === messageKey && parsed) blocks.set(contentIndex, parsed);
        return parsed?.text ? [parsed] : [];
      });
      nextIndices.set(key, (nextIndices.get(key) || 0) + content.length);
      return { externalSessionId, events };
    }

    function readToolResults(event: Record<string, unknown>, externalSessionId: string | undefined): ParsedResult {
      const content = object(event.message)?.content;
      const events = (Array.isArray(content) ? content : []).flatMap(part => {
        const block = object(part);
        const id = string(block?.tool_use_id);
        const tool = id && tools.get(id);
        if (block?.type !== 'tool_result' || !tool) return [];
        tools.delete(id);
        return [{ ...tool, detail: detail(block.content), streaming: false }];
      });
      return { externalSessionId, events };
    }

    return line => {
      const event = json(line);
      if (!event) return {};
      const externalSessionId = string(event.session_id);
      if (event.type === 'stream_event') return readStreamEvent(event, externalSessionId);
      if (event.type === 'assistant') return readAssistantMessage(event, externalSessionId);
      if (event.type === 'user') return readToolResults(event, externalSessionId);
      if (event.type === 'result') {
        const modelUsage = object(event.modelUsage);
        const models = modelUsage ? Object.values(modelUsage).map(object) : [];
        const fields = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
        const usage = models.length && models.every(model => model && fields.every(field => typeof model[field] === 'number'))
          ? models.reduce<TokenUsage>((total, model) => ({
            inputTokens: total.inputTokens + tokens(model!.inputTokens) + tokens(model!.cacheReadInputTokens) + tokens(model!.cacheCreationInputTokens),
            outputTokens: total.outputTokens + tokens(model!.outputTokens),
            cacheReadTokens: tokens(total.cacheReadTokens) + tokens(model!.cacheReadInputTokens),
            cacheWriteTokens: tokens(total.cacheWriteTokens) + tokens(model!.cacheCreationInputTokens),
          }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }) : undefined;
        return { externalSessionId, usage, usageIsTotal: true, error: event.is_error ? string(event.result) || 'Claude error' : undefined };
      }
      if (event.type === 'plain') return { text: string(event.text) };
      return { externalSessionId };
    };
  },
};
