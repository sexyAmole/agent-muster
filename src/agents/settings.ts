import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { providers } from './providers/index.js';

const settingsFile = join(homedir(), '.agent-muster', 'agent-settings.json');
const settings: Record<string, { sandboxEnabled?: boolean }> = existsSync(settingsFile)
  ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};

export function getSandboxEnabled(id: string): boolean {
  return settings[id]?.sandboxEnabled ?? true;
}

export function setSandbox(id: string, enabled: unknown): void {
  if (!providers.get(id)?.sandboxSupported) throw new Error('此 Agent 不支持内置沙箱');
  if (typeof enabled !== 'boolean') throw new Error('沙箱设置无效');
  const next = { ...settings, [id]: { sandboxEnabled: enabled } };
  mkdirSync(join(homedir(), '.agent-muster'), { recursive: true, mode: 0o700 });
  const temporary = `${settingsFile}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
  renameSync(temporary, settingsFile);
  Object.assign(settings, next);
}

export function validatePermissionMode(agent: string, value: unknown): asserts value is string | null | undefined {
  if (value !== undefined && value !== null && (typeof value !== 'string' || !providers.get(agent)?.permissionModes.some(item => item.id === value))) {
    throw new Error('此 Agent 不支持所选权限模式');
  }
}

