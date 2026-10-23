import { codex } from './codex.js';
import { claude } from './claude.js';
import { pi } from './pi.js';
import { gemini } from './gemini.js';
import { opencode } from './opencode.js';
import { cursor } from './cursor.js';
import { workbuddy } from './workbuddy.js';
import { trae } from './trae.js';
import { qodercn } from './qodercn.js';
import { createAdapter } from './shared.js';
import type { Adapter } from './shared.js';

export type { AgentProvider, Adapter, AdapterEvent, AdapterResult, AgentEvent } from './shared.js';

export const providers = new Map([codex, claude, pi, gemini, opencode, cursor, workbuddy, trae, qodercn].map(provider => [provider.id, provider]));

export const adapters: Record<string, Adapter> = Object.fromEntries(
  [...providers.values()].map(protocol => [protocol.id, createAdapter(protocol)]),
);
