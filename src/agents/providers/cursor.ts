import { realpath, rm, readFile } from 'node:fs/promises';
import { delimiter, sep, join, basename, resolve } from 'node:path';
import { executablePath } from '../executable.js';
import { execFileAsync, object, string, detail, json } from './shared.js';
import { homedir } from 'node:os';
import { findJsonl } from '../jsonl.js';
import type { AgentProvider } from './shared.js';

const cursorDirectory = join(homedir(), '.local', 'share', 'cursor-agent');

export const cursor: AgentProvider = {
  id: 'cursor',
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
        const tools = Object.entries(calls || {}).map(([name, value]) => {
          const call = object(value);
          return { name, detail: detail(call) };
        });
        return { externalSessionId, tools };
      }
      if (event.type === 'result') return { externalSessionId, error: event.is_error ? string(event.result) || 'Cursor 执行失败' : undefined };
      return { externalSessionId };
    };
  },
};
