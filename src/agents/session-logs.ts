import { providers } from './providers/index.js';
import { jsonlLines } from './jsonl.js';
import type { AgentSession, SessionLog, SessionLogPage } from '../types.js';

export async function readSessionLogs(session: AgentSession, limit: number, before?: number): Promise<SessionLogPage> {
  const provider = providers.get(session.agent);
  if (!provider?.sessionLogFile) return { supported: false, events: [], hasMore: false };
  if (!session.externalSessionId) return { supported: true, events: [], hasMore: false };
  const file = await provider.sessionLogFile(session);
  if (!file) return { supported: true, events: [], hasMore: false };
  const events: SessionLog[] = [];
  let id = 0;
  for await (const line of jsonlLines(file)) {
    id++;
    if (before !== undefined && id >= before) break;
    if (!line.trim()) continue;
    const record = JSON.parse(line) as { type?: string; role?: string; timestamp?: string | number; startTime?: string };
    const value = record.timestamp ?? record.startTime;
    const timestamp = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : undefined;
    events.push({ id, text: line, type: record.type ?? record.role, ...(timestamp !== undefined && Number.isFinite(timestamp) ? { timestamp } : {}) });
    if (events.length > limit + 1) events.shift();
  }
  return { supported: true, events: events.slice(-limit), hasMore: events.length > limit };
}
