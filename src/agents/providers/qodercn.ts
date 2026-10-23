import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { claude } from './claude.js';
import { findJsonl } from '../jsonl.js';
import { fullAutoMode, planMode, autoReviewMode, execFileAsync, json, string } from './shared.js';
import type { AdapterEvent, AgentProvider } from './shared.js';

function configDirectory(): string {
  return process.env.QODERCN_CONFIG_DIR ? resolve(process.env.QODERCN_CONFIG_DIR) : join(homedir(), '.qoder-cn');
}

export const qodercn: AgentProvider = {
  id: 'qodercn',
  name: 'Qoder CLI CN',
  command: 'qodercn',
  sandboxSupported: false,
  permissionModes: [fullAutoMode, planMode, { id: 'accept-edits', name: '自动接受编辑', description: '自动批准工作区内的安全编辑；其他需要人工审批的操作会被拒绝' }, autoReviewMode],
  installation: { kind: 'external', message: '请通过官方脚本安装 Qoder CLI CN，运行 qodercn login 登录，使用 qodercn update 更新' },
  async models() {
    const { stdout } = await execFileAsync('qodercn', ['--list-models'], { shell: process.platform === 'win32', timeout: 15000 });
    return stdout.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).flatMap(line => {
      const name = line.trim();
      if (!name || name === 'MODEL') return [];
      const custom = /^(.*) \(([^()]+)\)$/.exec(name);
      if (custom?.[2].endsWith('…')) return [];
      return [{ id: custom ? custom[2] : name === 'Auto' ? 'auto' : name, name: custom ? custom[1] : name }];
    });
  },
  async configuredModel() {
    if (process.env.QODERCN_MODEL) return process.env.QODERCN_MODEL;
    const config = JSON.parse(await readFile(join(configDirectory(), 'settings.json'), 'utf8')) as { model?: { name?: string } };
    return config.model?.name;
  },
  async sessionLogFile(session) {
    return findJsonl(join(configDirectory(), 'projects'), file => basename(file) === `${session.externalSessionId}.jsonl`);
  },
  launch(prompt, externalSessionId, model, images, { permissionMode = 'full-auto' } = {}) {
    const permission = ({ 'full-auto': 'bypass_permissions', plan: 'plan', 'accept-edits': 'accept_edits', 'auto-review': 'auto' } as Record<string, string>)[permissionMode];
    return {
      command: 'qodercn',
      args: ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--permission-mode', permission,
        ...(externalSessionId ? ['--resume', externalSessionId] : []), ...(model ? ['--model', model] : []),
        ...(images?.flatMap(image => ['--attachment', image.path]) || [])],
      prompt,
    };
  },
  createReader() {
    const read = claude.createReader();
    const streamed = new Map<string, AdapterEvent>();
    return line => {
      const event = json(line);
      const parsed = read(line);
      if (event?.type === 'stream_event') {
        for (const block of parsed.events || []) {
          if (block.streamId) streamed.set(block.streamId, block);
        }
      }
      if (event?.type === 'assistant') {
        parsed.events = parsed.events?.filter(block => block.type === 'tool' || ![...streamed.values()].some(value => value.orderKey === block.orderKey && value.type === block.type && value.text === block.text));
        if (event.error === 'authentication_failed') parsed.error = 'Qoder CLI CN 尚未登录，请先在终端运行 qodercn login';
      }
      if (event?.type === 'result') {
        parsed.settled = true;
        if (event.is_error) {
          parsed.error = (Array.isArray(event.errors) ? event.errors.filter((value): value is string => typeof value === 'string').join('\n') : undefined) || string(event.result) || 'Qoder CLI CN 执行失败';
        }
      }
      return parsed;
    };
  },
  settlementError: 'Qoder CLI CN 进程退出前未返回执行结果，无法确认任务已完成。',
};
