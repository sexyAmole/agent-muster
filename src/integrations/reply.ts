import type { SessionUsage } from '../types.js';

export function withContextUsage(text: string, usage: SessionUsage | undefined): string {
  const context = usage?.contextTokens === undefined ? 'Agent 未返回' : `${usage.contextTokens.toLocaleString('zh-CN')} Token`;
  return `${text}\n\n当前上下文：${context}`;
}
