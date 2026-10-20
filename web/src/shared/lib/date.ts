

export function time(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value);
}

export function shortDate(date: Date): string {
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const sameMonth = sameYear && date.getMonth() === now.getMonth();
  const sameDay = sameMonth && date.getDate() === now.getDate();
  return `${sameYear ? '' : `${date.getFullYear()}年`}${sameMonth ? '' : `${date.getMonth() + 1}月`}${sameDay ? '' : `${date.getDate()}日`}`;
}
