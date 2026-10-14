import { realpath, rm, readFile } from 'node:fs/promises';
import { delimiter, sep, join, basename, resolve } from 'node:path';
import { executablePath } from '../executable.js';
import { fullAutoMode, autoReviewMode, planMode, execFileAsync, object, string, detail, json, toolText } from './shared.js';
import { homedir } from 'node:os';
import { findJsonl } from '../jsonl.js';
import type { AdapterEvent, AgentProvider } from './shared.js';

const cursorDirectory = join(homedir(), '.local', 'share', 'cursor-agent');

export const cursor: AgentProvider = {
  id: 'cursor',
  sandboxSupported: true,
  permissionModes: [fullAutoMode, { id: 'ask', name: '只读问答', description: '使用 Agent 原生只读问答模式' }, planMode, autoReviewMode],
  name: 'Cursor',
  command: 'cursor-agent',
  installation: {
    kind: 'cursor',
    supported: process.platform === 'darwin' || process.platform === 'linux',
    unsupportedMessage: 'Cursor CLI 仅支持 macOS、Linux 和 WSL',
    owns(path, target) {
      return target.startsWith(cursorDirectory + sep) && path === join(homedir(), '.local', 'bin', 'cursor-agent');
    },
    async run(action, path) {
      if (action === 'uninstall') {
        const bin = join(homedir(), '.local', 'bin');
        const alias = await executablePath('agent');
        if (alias === join(bin, 'agent') && (await realpath(alias)).startsWith(cursorDirectory + sep)) await rm(alias);
        await rm(join(bin, 'cursor-agent'));
        await rm(cursorDirectory, { recursive: true });
        return 'Cursor CLI 已卸载';
      }
      if (action === 'update') {
        const result = await execFileAsync(path!, ['update'], { timeout: 300000, maxBuffer: 5_000_000 });
        return result.stdout + result.stderr;
      }
      if (!process.env.PATH?.split(delimiter).includes(join(homedir(), '.local', 'bin'))) throw new Error('请先将 ~/.local/bin 加入 PATH 并重新启动 Agent Muster');
      const result = await execFileAsync('bash', ['-o', 'pipefail', '-c', 'curl -fsSL https://cursor.com/install | bash'], { timeout: 300000, maxBuffer: 5_000_000 });
      return result.stdout + result.stderr;
    },
  },
  async models() {
    const { stdout } = await execFileAsync('cursor-agent', ['--list-models'], { timeout: 10000 });
    return stdout.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).flatMap(line => {
      const match = /^\s*([\w.-]+)\s+-\s+(.+?)(?:\s+\((?:current|default)\))?\s*$/.exec(line);
      return match ? [{ id: match[1], name: match[2] }] : [];
    });
  },
  async configuredModel() {
    const directory = process.env.CURSOR_CONFIG_DIR || (process.env.XDG_CONFIG_HOME && process.platform !== 'darwin' && process.platform !== 'win32' ? join(process.env.XDG_CONFIG_HOME, 'cursor') : join(homedir(), '.cursor'));
    const config = JSON.parse(await readFile(join(directory, 'cli-config.json'), 'utf8')) as { model?: { displayModelId?: string } };
    return config.model?.displayModelId;
  },
  async sessionLogFile(session) {
    const directory = process.env.CURSOR_CONFIG_DIR ? resolve(process.env.CURSOR_CONFIG_DIR) : join(homedir(), '.cursor');
    return findJsonl(join(directory, 'projects'), file => basename(file) === `${session.externalSessionId}.jsonl`);
  },
  launch(prompt, externalSessionId, model, images, { permissionMode = 'full-auto', sandboxEnabled = true } = {}) {
    if (images?.length) throw new Error('当前 Cursor CLI 接入不支持图片附件输入');
    const permissionArgs = permissionMode === 'ask' || permissionMode === 'plan' ? ['--mode', permissionMode]
      : [permissionMode === 'auto-review' ? '--auto-review' : '--force'];
    return {
      command: 'cursor-agent',
      args: ['--print', '--trust', '--sandbox', sandboxEnabled ? 'enabled' : 'disabled', ...permissionArgs, '--output-format', 'stream-json', '--stream-partial-output', ...(externalSessionId ? ['--resume', externalSessionId] : []), ...(model ? ['--model', model] : []), '--', prompt],
    };
  },
  createReader() {
    let output: AdapterEvent | undefined;
    let messageNumber = 0;
    function finishText(): AdapterEvent[] {
      if (!output) return [];
      const completed = { ...output, streaming: false };
      output = undefined;
      return [completed];
    }
    return line => {
      const event = json(line);
      if (!event) return {};
      const externalSessionId = string(event.session_id);
      if (event.type === 'assistant') {
        if (event.model_call_id || typeof event.timestamp_ms !== 'number') return { externalSessionId, events: finishText() };
        const message = object(event.message);
        const content = Array.isArray(message?.content) ? message.content : [];
        const text = content.flatMap(value => {
          const block = object(value);
          return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
        }).join('');
        if (!text) return { externalSessionId };
        const key = output?.streamId || `message:${++messageNumber}`;
        output = { type: 'output', text: (output?.text || '') + text, streamId: key, orderKey: key, streaming: true };
        return { externalSessionId, events: [output] };
      }
      if (event.type === 'tool_call' && (event.subtype === 'started' || event.subtype === 'completed')) {
        const calls = object(event.tool_call);
        const id = string(event.call_id);
        const events = event.subtype === 'started' ? finishText() : [];
        if (!id) return { externalSessionId, events };
        const tools: AdapterEvent[] = Object.entries(calls || {}).map(([name, value]) => {
          const call = object(value);
          return { type: 'tool', text: toolText(name, call?.args), detail: detail(call?.result), streamId: `tool:${id}:${name}`, orderKey: `tool:${id}:${name}`, streaming: event.subtype === 'started' };
        });
        return { externalSessionId, events: [...events, ...tools] };
      }
      if (event.type === 'result') return { externalSessionId, events: finishText(), error: event.is_error ? string(event.result) || 'Cursor 执行失败' : undefined };
      return { externalSessionId };
    };
  },
};
