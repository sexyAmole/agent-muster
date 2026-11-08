import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { providers } from './providers/index.js';
import { imSystemPromptMaxLength } from '../types.js';

const settingsFile = join(homedir(), '.agent-muster', 'agent-settings.json');
const settings: Record<string, { sandboxEnabled?: boolean }> = existsSync(settingsFile)
  ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};

export function getSandboxEnabled(id: string): boolean {
  return settings[id]?.sandboxEnabled ?? true;
}

export function sessionSandboxEnabled(agent: string, permissionMode: string, value: unknown): boolean {
  const supported = Boolean(providers.get(agent)?.sandboxSupported);
  if (value !== undefined && typeof value !== 'boolean') throw new Error('沙箱设置无效');
  if (value === true && !supported) throw new Error('此 Agent 不支持内置沙箱');
  if (['codex', 'trae'].includes(agent) && ['read-only', 'workspace-write', 'auto-review'].includes(permissionMode)) {
    if (value === false) throw new Error('所选权限模式必须开启沙箱');
    return true;
  }
  return value === undefined ? supported : value;
}

export function validatePermissionMode(agent: string, value: unknown): asserts value is string | null | undefined {
  if (value !== undefined && value !== null && (typeof value !== 'string' || !providers.get(agent)?.permissionModes.some(item => item.id === value))) {
    throw new Error('此 Agent 不支持所选权限模式');
  }
}

export function normalizeImSystemPrompt(agent: string | null, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('系统提示词必须是有效文本');
  if (value.length > imSystemPromptMaxLength) throw new Error(`系统提示词最多 ${imSystemPromptMaxLength} 个字符`);
  const prompt = value.trim();
  if (prompt && (!agent || !providers.get(agent)?.systemPromptSupported)) throw new Error('所选 Agent 不支持系统提示词');
  return prompt;
}

