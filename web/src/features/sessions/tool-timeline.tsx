import type { SessionEvent as Event } from '../../../../src/types';

function toolLabel(command: string): string {
  const normalized = command.replace(/^\$\s*(?:\/bin\/(?:zsh|bash|sh)\s+-lc\s+)?/, '');
  const quote = normalized[0] === '"' || normalized[0] === "'" ? normalized[0] : '';
  const firstLine = normalized.slice(quote ? 1 : 0).split('\n')[0];
  return quote && firstLine.endsWith(quote) ? firstLine.slice(0, -1) : firstLine;
}

function isDiff(value: string): boolean {
  return /^diff --git /m.test(value) || /^@@ -\d/m.test(value);
}

function Diff({ text }: { text: string }) {
  return <pre className="diff-content">{text.split('\n').map((line, index) => {
    const tone = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('@@')
      ? 'meta' : line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : '';
    return <span className={`diff-line ${tone}`} key={index}>{line || ' '}{'\n'}</span>;
  })}</pre>;
}
function fileLabel(path: string, cwd: string): string {
  const prefix = cwd.replace(/[\\/]+$/, '');
  return path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}\\`) ? path.slice(prefix.length + 1) : path;
}

type PiToolDetails = {
  args?: { command?: string; path?: string };
  result?: { content?: { type: string; text?: string }[] };
  isError?: boolean;
};

function piToolDetails(detail: string | undefined): PiToolDetails | undefined {
  if (!detail?.startsWith('{')) return undefined;
  try { return JSON.parse(detail) as PiToolDetails; }
  // 已截断的历史记录只展示原文，不提取结构化摘要。
  catch { return undefined; }
}

function ToolCall({ event, accordionName, agent }: { event: Event; accordionName: string; agent: string }) {
  const data = agent === 'pi' ? piToolDetails(event.detail) : undefined;
  const target = data?.args?.command || data?.args?.path;
  const label = target ? `${event.text} ${data?.args?.command ? toolLabel(target) : target}` : toolLabel(event.text);
  const output = data?.result?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n');
  const detail = data ? output : event.detail;
  const lines = output?.trimEnd() ? output.trimEnd().split('\n').length : undefined;
  return <details className="tool-call" name={accordionName}><summary>
    <span className={`tool-call-status${event.streaming ? ' running' : ''}${data?.isError ? ' error' : ''}`} aria-label={event.streaming ? '工具执行中' : data?.isError ? '工具执行失败' : '工具执行记录'} />
    <strong title={target ? `${event.text} ${target}` : label}>{label}</strong>
    {event.streaming && <span className="tool-output-lines">执行中</span>}
    {lines !== undefined && <span className="tool-output-lines">{lines} 行</span>}
    {detail && <span className="tool-call-chevron" />}
  </summary>{detail && <div className="tool-detail-card">{isDiff(detail) ? <Diff text={detail} /> : <pre>{detail}</pre>}</div>}</details>;
}

export function ToolTimeline({ events, accordionName, agent }: { events: Event[]; accordionName: string; agent: string }) {
  return <ol className="tool-timeline" aria-label="工具调用时间线">{events.map(event => <li key={event.streamId || event.id}><ToolCall event={event} accordionName={accordionName} agent={agent} /></li>)}</ol>;
}

export function FileChange({ event, cwd }: { event: Event; cwd: string }) {
  const kind = event.kind === 'add' ? '新增' : event.kind === 'delete' ? '删除' : event.kind === 'move' ? '移动' : '修改';
  const content = <><span className={`change-kind ${event.kind || 'update'}`}>{kind}</span><strong title={event.text}>{fileLabel(event.text, cwd)}</strong>{event.comparison && <small className="change-baseline">对比 {event.comparison}</small>}{event.detail && <span className="tool-call-chevron" />}</>;
  return event.detail
    ? <details className="file-change"><summary>{content}</summary><Diff text={event.detail} /></details>
    : <div className="file-change file-change-summary">{content}</div>;
}
