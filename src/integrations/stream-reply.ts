import type { SessionManager } from '../sessions/manager.js';
import type { AgentSession, SessionEvent } from '../types.js';

export class StreamReply {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private content = '';
  private closed = false;

  constructor(private write: (content: string, finish: boolean) => Promise<void>) {}

  update(content: string): void {
    if (this.closed || !content.trim() || content === this.content) return;
    this.content = content;
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.timer || this.pending) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const content = this.content;
      this.pending = this.write(content, false)
        .catch(error => { console.error('IM 流式消息更新失败：', error); })
        .finally(() => {
          this.pending = undefined;
          if (this.content !== content) this.schedule();
        });
    }, 1000);
  }

  async finish(content: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    await this.pending;
    await this.write(content, true);
  }
}

export function watchStreamOutput(sessions: SessionManager, session: AgentSession, after: number, reply: StreamReply): () => void {
  const onEvent = (event: SessionEvent) => {
    if (event.id > after && event.type === 'output') reply.update(event.text);
  };
  sessions.on(session.id, onEvent);
  for (const event of sessions.eventsAfter(session.id, after)) onEvent(event);
  return () => { sessions.off(session.id, onEvent); };
}

export function splitStreamContent(content: string): [string, string] {
  let bytes = 0;
  let offset = 0;
  for (const character of content) {
    bytes += Buffer.byteLength(character);
    if (bytes > 18000) break;
    offset += character.length;
  }
  return [content.slice(0, offset), content.slice(offset)];
}
