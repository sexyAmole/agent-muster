import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { claude } from './claude.js';
import { findJsonl } from '../jsonl.js';
import { fullAutoMode, planMode, execFileAsync, json, object, string, tokens, hasTokens } from './shared.js';
import type { AgentProvider } from './shared.js';
import type { ModelInfo } from '../../types.js';

let cliPath: string | undefined;
const configDirectory = join(homedir(), '.workbuddy');

function cli(): string {
  if (!cliPath) throw new Error('未找到 WorkBuddy 内置 CLI，请先安装 WorkBuddy 桌面应用并刷新 Agent 列表');
  return cliPath;
}

function environment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DISABLE_AUTOUPDATER: '1',
    CODEBUDDY_CONFIG_DIR: configDirectory,
    WORKBUDDY_CONFIG_DIR: configDirectory,
    ACC_PRODUCT_CONFIG_PATH: join(dirname(dirname(cli())), 'product.json'),
  };
}

interface ModelConfiguration {
  models?: (ModelInfo & { disabled?: boolean; maxInputTokens?: number })[];
  availableModels?: string[];
  agents?: { name: string; models?: string[] }[];
}

export const workbuddy: AgentProvider = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  command: 'codebuddy',
  sandboxSupported: true,
  permissionModes: [fullAutoMode, planMode, { id: 'accept-edits', name: '自动接受编辑', description: '自动批准文件编辑；其他需要人工审批的操作会被拒绝' }],
  installation: { kind: 'external', message: '请通过 WorkBuddy 桌面应用安装、更新或卸载' },
  async resolveExecutable() {
    cliPath = undefined;
    const directories = process.platform === 'darwin'
      ? ['/Applications/WorkBuddy.app/Contents/Resources', join(homedir(), 'Applications/WorkBuddy.app/Contents/Resources')]
      : process.platform === 'win32'
        ? [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs/WorkBuddy/resources'), process.env.ProgramFiles && join(process.env.ProgramFiles, 'WorkBuddy/resources')].filter((path): path is string => Boolean(path))
        : [];
    for (const directory of directories) {
      const path = join(directory, 'app.asar.unpacked/cli/bin/codebuddy');
      try {
        await access(path, constants.R_OK);
        cliPath = path;
        return path;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return undefined;
  },
  async version() {
    const { stdout } = await execFileAsync(process.execPath, [cli(), '--version'], { env: environment(), timeout: 10000 });
    const version = stdout.trim();
    if (!version) throw new Error('WorkBuddy 未返回版本信息');
    return version;
  },
  async models() {
    const product = JSON.parse(await readFile(join(dirname(dirname(cli())), 'product.json'), 'utf8')) as ModelConfiguration;
    let custom: ModelConfiguration = {};
    try {
      custom = JSON.parse(await readFile(join(configDirectory, 'models.json'), 'utf8')) as ModelConfiguration;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const models = new Map([...product.models || [], ...custom.models || []].map(model => [model.id, model]));
    const available = custom.availableModels ?? [...product.agents?.find(agent => agent.name === 'cli')?.models || [], ...custom.models?.map(model => model.id) || []];
    return [...new Set(available)].flatMap(id => {
      const model = models.get(id);
      return model && !model.disabled ? [{ id, name: model.name || id, contextWindow: model.maxInputTokens }] : [];
    });
  },
  async configuredModel() {
    const settings = JSON.parse(await readFile(join(configDirectory, 'settings.json'), 'utf8')) as { model?: string };
    return settings.model;
  },
  async sessionLogFile(session) {
    return findJsonl(join(configDirectory, 'projects'), file => basename(file) === `${session.externalSessionId}.jsonl`);
  },
  launch(prompt, externalSessionId, model, images, { permissionMode = 'full-auto', sandboxEnabled = true } = {}) {
    const permission = ({ 'full-auto': 'bypassPermissions', plan: 'plan', 'accept-edits': 'acceptEdits' } as Record<string, string>)[permissionMode];
    return {
      command: process.execPath,
      args: [cli(), '-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--permission-mode', permission,
        '--settings', JSON.stringify({ sandbox: { enabled: sandboxEnabled, ...(sandboxEnabled ? { allowUnsandboxedCommands: false, failIfUnavailable: true } : {}) } }),
        ...(images?.length ? ['--input-format', 'stream-json'] : []), ...(externalSessionId ? ['--resume', externalSessionId] : []), ...(model ? ['--model', model] : [])],
      env: environment(),
      prompt: images?.length ? JSON.stringify({ type: 'user', message: { role: 'user', content: [
        { type: 'text', text: prompt },
        ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } })),
      ] } }) : prompt,
    };
  },
  createReader() {
    const read = claude.createReader();
    let messageId: string | undefined;
    let streaming = false;
    const blocks = new Map<number, string>();
    return line => {
      const event = json(line);
      if (event?.type === 'stream_event') {
        const update = object(event.event);
        if (update?.type === 'message_start') {
          messageId = string(object(update.message)?.id);
          streaming = true;
          blocks.clear();
        }
        if (update?.type === 'message_stop') streaming = false;
        if (update?.type === 'content_block_start' && typeof update.index === 'number') {
          if (blocks.has(update.index)) return { externalSessionId: string(event.session_id) };
          const type = string(object(update.content_block)?.type);
          if (type) blocks.set(update.index, type);
        }
      }
      if (event?.type === 'assistant' && messageId && !event.parent_tool_use_id) {
        const message = object(event.message);
        const content = Array.isArray(message?.content) ? message.content : [];
        const parsed = read(JSON.stringify({ ...event, message: { ...message, content: content.filter(part => {
          const block = object(part);
          return block?.type !== 'text' && block?.type !== 'thinking';
        }) } }));
        if (!streaming) {
          parsed.events!.push(...content.flatMap(part => {
            const block = object(part);
            const position = [...blocks].reverse().find(([, type]) => type === block?.type);
            if (!block || !position || (block.type !== 'text' && block.type !== 'thinking')) return [];
            const index = position[0];
            return [{ type: block.type === 'text' ? 'output' as const : 'thinking' as const, text: string(block[block.type]) || '', streamId: `${messageId}:${index}`, orderKey: messageId, contentIndex: index, streaming: false }];
          }));
        }
        const usage = object(message?.usage);
        parsed.contextTokens = usage && hasTokens(usage, ['input_tokens', 'output_tokens']) && tokens(usage.input_tokens) > 0 ? tokens(usage.input_tokens) + tokens(usage.output_tokens) : undefined;
        return parsed;
      }
      if (event?.type !== 'result') return read(line);
      const result = read(line);
      const usage = object(event.usage);
      if (usage && hasTokens(usage, ['input_tokens', 'output_tokens'])) {
        result.usage = {
          inputTokens: tokens(usage.input_tokens), outputTokens: tokens(usage.output_tokens),
          cacheReadTokens: tokens(usage.cache_read_input_tokens), cacheWriteTokens: tokens(usage.cache_creation_input_tokens),
        };
      }
      if (event.is_error) result.error = Array.isArray(event.errors) ? event.errors.filter((error): error is string => typeof error === 'string').join('\n') || 'WorkBuddy 执行失败' : string(event.result) || 'WorkBuddy 执行失败';
      return result;
    };
  },
};
