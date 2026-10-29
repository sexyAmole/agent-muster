import type { SessionUsage } from '../types.js';

export function withContextUsage(text: string, usage: SessionUsage | undefined): string {
  const tokens = usage?.contextTokens;
  const count = tokens === undefined ? undefined : tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  const context = count === undefined ? 'Agent 未返回' : `${count} Token`;
  return `${text}\n\n当前上下文：${context}`;
}
