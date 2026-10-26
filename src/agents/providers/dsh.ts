import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fullAutoMode, json, object, string, detail, tokens } from './shared.js';
import type { AgentProvider, AdapterEvent, ParsedResult } from './shared.js';

export const dsh: AgentProvider = {
  id: 'dsh',
  name: 'DeepSeek Harness',
  command: 'dsh',
  sandboxSupported: true,
  permissionModes: [fullAutoMode,
    { id: 'read-only', name: '只读', description: '使用只读沙箱，需要人工审批的操作直接拒绝' },
    { id: 'workspace-write', name: '项目内自动执行', description: '允许修改当前项目，需要人工审批的操作直接拒绝' },
  ],
  installation: { kind: 'npm', packageName: '@deepseek-ai/dsh' },
  async models() { return []; },
  async configuredModel() { return undefined; },
  launch(prompt, externalSessionId, model, images, { permissionMode = 'full-auto', sandboxEnabled = true } = {}) {
    if (images?.length) throw new Error('DeepSeek Harness headless 接入不支持图片附件输入');
    if (model) throw new Error('请在 DeepSeek Harness 的 headless 配置中选择模型');
    const mode = permissionMode === 'read-only' || permissionMode === 'workspace-write' ? permissionMode
      : sandboxEnabled ? 'workspace-write' : 'danger-full-access';
    const directory = mkdtempSync(join(tmpdir(), 'agent-muster-dsh-'));
    const patch = join(directory, 'permissions.yml');
    writeFileSync(patch, `- id: sandbox-policy\n  config:\n    mode: ${mode}\n    workspaceRoot: !!js process.cwd()\n- id: approval\n  config:\n    policy: never\n`, { mode: 0o600 });
    return {
      command: 'dsh',
      args: ['--profile', 'headless', '--patch', patch, '--json',
        ...(externalSessionId ? ['--session-id', externalSessionId] : []), '-'],
      connect(child) {
        child.once('close', () => rmSync(directory, { recursive: true, force: true }));
        child.stdin.end(`${prompt}\n`);
        return dsh.createReader();
      },
    };
  },
  createReader() {
    let index = 0;
    let output: AdapterEvent | undefined;
    let lastOutput: AdapterEvent | undefined;
    let turnReason: Record<string, unknown> | undefined;
    const tools = new Map<string, { name: string; input: unknown }>();
    return (line): ParsedResult => {
      const event = json(line);
      if (!event || event.type === 'plain') return {};
      if (event.type === 'session') return { externalSessionId: string(event.sessionId) };
      if (event.type === 'error') return { error: string(event.message) || 'DeepSeek Harness 执行失败', settled: true };
      if (event.type === 'status') {
        if (event.phase === 'turn_start') turnReason = undefined;
        if (event.phase === 'turn_end') turnReason = object(event.reason);
        if (event.phase === 'step_start') output = undefined;
        const usage = object(event.usage);
        if (event.phase === 'step_end' && usage) return { usage: {
          inputTokens: tokens(usage.inputTokens) + tokens(usage.cacheReadTokens) + tokens(usage.cacheWriteTokens), outputTokens: tokens(usage.outputTokens),
          cacheReadTokens: typeof usage.cacheReadTokens === 'number' ? tokens(usage.cacheReadTokens) : undefined,
          cacheWriteTokens: typeof usage.cacheWriteTokens === 'number' ? tokens(usage.cacheWriteTokens) : undefined,
        } };
      }
      if (event.type === 'text') {
        if (!output) output = { type: 'output', text: '', streamId: `dsh:output:${++index}` };
        output.text += string(event.text) || '';
        lastOutput = output;
        return { events: [{ ...output }] };
      }
      if (event.type === 'thinking') return { events: [{ type: 'thinking', text: string(event.text) || '', detail: event.truncated ? '思考内容被 DeepSeek Harness 截断' : undefined }] };
      if (event.type === 'tool_call' || event.type === 'tool_result') {
        const id = string(event.callId);
        if (!id) return {};
        if (event.type === 'tool_call') tools.set(id, { name: string(event.tool) || id, input: event.input });
        const tool = tools.get(id);
        return { events: [{ type: 'tool', streamId: `dsh:tool:${id}`, text: tool?.name || id,
          detail: detail({ input: tool?.input, result: event.result, status: event.status, error: event.error, truncated: event.truncated }),
        }] };
      }
      if (event.type === 'final') {
        const reason = turnReason;
        const error = object(reason?.error);
        return {
          externalSessionId: string(event.sessionId), settled: true,
          aborted: reason?.kind === 'aborted',
          error: reason?.kind === 'completed' || reason?.kind === 'aborted' ? undefined
            : string(error?.message) || string(reason?.message) || 'DeepSeek Harness 未正常完成任务',
          events: typeof event.text === 'string' && event.text ? [{ type: 'output', text: event.text,
            streamId: lastOutput?.streamId || `dsh:output:${++index}`,
          }] : undefined,
        };
      }
      return {};
    };
  },
  settlementError: 'DeepSeek Harness 进程退出前未返回最终结果，无法确认任务已完成。',
};
