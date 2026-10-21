import type { AgentSession, SessionEvent, SessionUsage } from '../types.js';

export type SessionMetadata = Omit<AgentSession, 'events' | 'pid'>;
export type MetadataChanges = { [Key in keyof SessionMetadata]?: SessionMetadata[Key] | null };
export type SessionHeader = SessionMetadata & { type: 'session'; formatVersion: 2 };
export interface MetadataRecord {
  type: 'session_update';
  timestamp: number;
  changes: MetadataChanges;
}

type StoredEventBase = Omit<SessionEvent, 'text' | 'type' | 'streaming' | 'pushedToIm'>;
export type StoredEvent = StoredEventBase & (
  | { type: 'usage'; usage: SessionUsage }
  | { type: Exclude<SessionEvent['type'], 'usage'>; text: string }
);
export type SessionRecord = SessionHeader | MetadataRecord | StoredEvent | { type: 'im_pushed'; eventId: number };

export function sessionMetadata({ events, pid, ...metadata }: AgentSession): SessionMetadata {
  return metadata;
}

export function metadataChanges(previous: SessionMetadata, next: SessionMetadata, event?: SessionEvent): MetadataChanges {
  const changes: MetadataChanges = {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof SessionMetadata>) {
    if (key === 'updatedAt' || (key === 'status' && event?.type === 'status') || (key === 'usage' && event?.type === 'usage')) continue;
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) Object.assign(changes, { [key]: next[key] ?? null });
  }
  return changes;
}

export function applyMetadataChanges(metadata: SessionMetadata, changes: MetadataChanges): void {
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete metadata[key as keyof SessionMetadata];
    else Object.assign(metadata, { [key]: value });
  }
}

export function storedEvent({ streaming, pushedToIm, ...event }: SessionEvent): StoredEvent {
  if (event.type === 'usage') {
    const { text, ...rest } = event;
    return { ...rest, type: 'usage', usage: JSON.parse(text) as SessionUsage };
  }
  return event as StoredEvent;
}

export function sessionEvent(record: StoredEvent): SessionEvent {
  if (record.type === 'usage') {
    const { usage, ...rest } = record;
    return { ...rest, text: JSON.stringify(usage) };
  }
  return { ...record, ...(record.streamId ? { streaming: false } : {}) };
}

export function applyEventMetadata(metadata: SessionMetadata, event: SessionEvent): void {
  metadata.updatedAt = Math.max(metadata.updatedAt, event.timestamp);
  if (event.type === 'status') metadata.status = event.text as AgentSession['status'];
  if (event.type === 'usage') metadata.usage = JSON.parse(event.text) as SessionUsage;
}
