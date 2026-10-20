import type { SessionEvent as Event, AgentSession as Session, SessionStatus as Status } from '../../../../src/types';

export function tokenCount(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

export const statusLabel: Record<Status, string> = {
  starting: '准备中', running: '运行中', waiting: '等待中', completed: '已完成', failed: '失败', stopped: '已停止',
};
export function conversationItems(session: Session): (Event | Event[])[] {
  const items: (Event | Event[])[] = [];
  for (const event of session.events) {
    if (event.type !== 'thinking' && event.type !== 'message' && event.type !== 'output' && event.type !== 'im_message' && event.type !== 'tool' && event.type !== 'file_change' && !(event.type === 'error' && session.status === 'failed')) continue;
    if (event.type === 'tool') {
      const previous = items.at(-1);
      if (Array.isArray(previous)) previous.push(event);
      else items.push([event]);
    } else {
      items.push(event);
    }
  }
  return items;
}

export type ExecutionRound = { id: number; message?: Event; events: Event[]; end?: Event; active: boolean };

export function executionRounds(session: Session): ExecutionRound[] {
  const rounds: ExecutionRound[] = [];
  for (const event of session.events) {
    if (event.type === 'message' || !rounds.length) {
      rounds.push({ id: event.id, ...(event.type === 'message' ? { message: event } : {}), events: [], active: false });
    }
    const round = rounds.at(-1)!;
    if (event.type !== 'message') round.events.push(event);
    if (event.type === 'status' && (event.text === 'completed' || event.text === 'failed' || event.text === 'stopped')) round.end = event;
  }
  const last = rounds.at(-1);
  if (last && !last.end) last.active = session.status === 'starting' || session.status === 'running';
  return rounds;
}
export function conversationText(session: Session): string {
  return conversationItems(session).flatMap(item => {
    if (Array.isArray(item) || (item.type !== 'message' && item.type !== 'output' && item.type !== 'im_message')) return [];
    return [`${item.type === 'message' ? '用户' : item.type === 'im_message' ? `应用（已发送到${item.im?.platform === 'feishu' ? '飞书' : item.im?.platform === 'wecom' ? '企业微信' : '钉钉'}）` : '助手'}：\n${item.text.trim()}`];
  }).join('\n\n');
}
