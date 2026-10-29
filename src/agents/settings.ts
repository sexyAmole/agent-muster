import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { providers } from './providers/index.js';

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

