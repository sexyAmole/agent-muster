import type { SessionEvent } from './types.js';

export function compareSessionEvents(a: Pick<SessionEvent, 'id' | 'order' | 'contentIndex'>, b: Pick<SessionEvent, 'id' | 'order' | 'contentIndex'>): number {
  return (a.order ?? a.id) - (b.order ?? b.id) || (a.contentIndex ?? 0) - (b.contentIndex ?? 0) || a.id - b.id;
}

export function mergeSessionEvents<T extends Pick<SessionEvent, 'id' | 'order' | 'contentIndex' | 'streamId'>>(events: T[]): T[] {
  const merged = new Map<string, T>();
  for (const event of events) merged.set(event.streamId ? `stream:${event.streamId}` : `event:${event.id}`, event);
  return [...merged.values()].sort(compareSessionEvents);
}
