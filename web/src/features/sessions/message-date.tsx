
import { shortDate } from '../../shared/lib/date';

export function MessageDate({ timestamp }: { timestamp: number }) {
  const date = new Date(timestamp);
  const prefix = shortDate(date);
  const clock = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return <time className="message-date" dateTime={date.toISOString()} aria-label={date.toLocaleString('zh-CN', { hour12: false })} tabIndex={0}>{prefix && `${prefix} `}{clock}</time>;
}
