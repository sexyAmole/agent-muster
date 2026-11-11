import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ExtensionAgent } from './types.js';

export function agentDirectory(agent: ExtensionAgent): string {
  switch (agent) {
    case 'codex': return process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), '.codex');
    case 'claude': return process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude');
    case 'pi': return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent');
    case 'gemini': return join(homedir(), '.gemini');
    case 'opencode': return join(process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : join(homedir(), '.config'), 'opencode');
    case 'cursor': return process.env.CURSOR_CONFIG_DIR ? resolve(process.env.CURSOR_CONFIG_DIR)
      : process.env.XDG_CONFIG_HOME && process.platform !== 'darwin' && process.platform !== 'win32'
        ? join(resolve(process.env.XDG_CONFIG_HOME), 'cursor') : join(homedir(), '.cursor');
    case 'kimi': return process.env.KIMI_CODE_HOME ? resolve(process.env.KIMI_CODE_HOME) : join(homedir(), '.kimi-code');
    case 'dsh': return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh');
    case 'qodercn': return process.env.QODERCN_CONFIG_DIR ? resolve(process.env.QODERCN_CONFIG_DIR) : join(homedir(), '.qoder-cn');
    case 'workbuddy': return join(homedir(), '.workbuddy');
  }
}

export function skillRoots(agent: ExtensionAgent): string[] {
  const own = join(agentDirectory(agent), 'skills');
  const shared = join(homedir(), '.agents', 'skills');
  switch (agent) {
    case 'codex': return [shared, own];
    case 'pi':
    case 'gemini':
    case 'kimi': return [own, shared];
    case 'dsh': return [own, process.env.DSH_AGENTS_HOME ? join(resolve(process.env.DSH_AGENTS_HOME), 'skills') : shared];
    case 'opencode': return [...new Set([
      ...(process.env.OPENCODE_CONFIG_DIR ? [join(resolve(process.env.OPENCODE_CONFIG_DIR), 'skills')] : []),
      own, join(homedir(), '.claude', 'skills'), shared,
    ])];
    case 'cursor': return [...new Set([own, shared, join(homedir(), '.claude', 'skills'), join(homedir(), '.codex', 'skills')])];
    default: return [own];
  }
}
