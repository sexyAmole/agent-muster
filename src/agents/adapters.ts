import { codex } from './adapters/codex.js';
import { claude } from './adapters/claude.js';
import { pi } from './adapters/pi.js';
import { kimi } from './adapters/kimi.js';
import { gemini } from './adapters/gemini.js';
import { opencode } from './adapters/opencode.js';
import { cursor } from './adapters/cursor.js';
import { createAdapter } from './adapters/shared.js';
import type { Adapter } from './adapters/shared.js';

export type { Adapter, AdapterEvent, AdapterResult, AgentEvent } from './adapters/shared.js';

export const adapters: Record<string, Adapter> = Object.fromEntries(
  [codex, claude, pi, kimi, gemini, opencode, cursor].map(protocol => [protocol.id, createAdapter(protocol)]),
);
