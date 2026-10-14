import { codex } from './codex.js';
import { claude } from './claude.js';
import { pi } from './pi.js';
import { kimi } from './kimi.js';
import { gemini } from './gemini.js';
import { opencode } from './opencode.js';
import { cursor } from './cursor.js';
import { createAdapter } from './shared.js';
import type { Adapter } from './shared.js';

export type { AgentProvider, Adapter, AdapterEvent, AdapterResult, AgentEvent } from './shared.js';

export const providers = new Map([codex, claude, pi, kimi, gemini, opencode, cursor].map(provider => [provider.id, provider]));

export const adapters: Record<string, Adapter> = Object.fromEntries(
  [...providers.values()].map(protocol => [protocol.id, createAdapter(protocol)]),
);
