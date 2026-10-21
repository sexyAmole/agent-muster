import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { findJsonl } from '../jsonl.js';
import { join, basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fullAutoMode, autoReviewMode, object, string, tokens, hasTokens, detail, json } from './shared.js';
import type { AdapterEvent, AgentProvider, ParsedResult } from './shared.js';

interface CodexModel {
  model: string;
  displayName: string;
}

function codexModels(): Promise<CodexModel[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = createInterface({ input: child.stdout });
    let finished = false;
    const finish = (error?: Error, models?: CodexModel[]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      if (error) reject(error);
      else if (models) resolve(models);
    };
    const timer = setTimeout(() => finish(new Error('Codex model query timed out')), 15000);
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('exit', () => finish(new Error('Codex exited before returning models')));
    lines.on('line', line => {
      try {
        const message = JSON.parse(line) as { id?: number; error?: { message: string }; result?: { data: CodexModel[] } };
        if (message.error) { finish(new Error(message.error.message)); return; }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'model/list', params: { limit: 100, includeHidden: true } })}\n`);
        }
        if (message.id === 2 && message.result) finish(undefined, message.result.data);
      } catch (error) { finish(error as Error); }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_muster', version: '0.1.0' } } })}\n`);
  });
}

export const codex: AgentProvider = {
  id: 'codex',
  sandboxSupported: true,
  permissionModes: [fullAutoMode, { id: 'read-only', name: '只读', description: '使用只读沙箱，禁止修改项目文件' }, { id: 'workspace-write', name: '项目内自动执行', description: '允许修改当前项目，越界操作直接拒绝' }, autoReviewMode],
  name: 'Codex',
  command: 'codex',
  installation: { kind: 'npm', packageName: '@openai/codex' },
  async models() {
    const models = await codexModels();
    const catalog = JSON.parse(await readFile(join(homedir(), '.codex', 'models_cache.json'), 'utf8')) as { models: { slug: string; context_window?: number }[] };
    return models.filter(model => model.model !== 'gpt-6.1-sol').map(model => ({ id: model.model, name: model.displayName, contextWindow: catalog.models.find(item => item.slug === model.model)?.context_window }));
  },
  async configuredModel() {
    const config = await readFile(join(homedir(), '.codex', 'config.toml'), 'utf8');
    return /^model\s*=\s*['"]([^'"]+)['"]/m.exec(config)?.[1];
  },
  async sessionLogFile(session) {
    const directory = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), '.codex');
    return findJsonl(join(directory, 'sessions'), file => basename(file).endsWith(`-${session.externalSessionId}.jsonl`));
  },
  launch(prompt, externalSessionId, model, images, { permissionMode = 'full-auto', sandboxEnabled = true } = {}) {
    const sandbox = permissionMode === 'read-only' || permissionMode === 'workspace-write' ? permissionMode
      : permissionMode === 'auto-review' || sandboxEnabled ? 'workspace-write' : 'danger-full-access';
    const executionArgs = ['-c', `sandbox_mode=${JSON.stringify(sandbox)}`, ...(permissionMode === 'auto-review' ? ['--approve-for-me'] : ['-c', 'approval_policy="never"'])];
    return {
      command: 'codex',
      args: [...executionArgs, 'app-server'],
      connect(child) {
        const read = codex.createReader();
        let threadId: string | undefined;
        let closed = false;
        const send = (message: object) => { if (!closed) child.stdin.write(`${JSON.stringify(message)}\n`); };
        const close = () => { if (!closed) { closed = true; child.stdin.end(); } };
        const fail = (error: string): ParsedResult => { close(); return { error, settled: true }; };
        child.stdin.on('error', error => { if (!closed) child.emit('error', error); });
        child.once('close', () => { closed = true; });
        send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_muster', version: '0.1.0' }, capabilities: { experimentalApi: true } } });
        return line => {
          const message = json(line);
          if (closed) return {};
          if (!message || message.type === 'plain') return fail('Codex App Server 返回了无效的 JSON 消息');
          const params = object(message.params);
          if (message.id !== undefined && typeof message.method === 'string') {
            if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
              send({ id: message.id, result: { decision: 'decline' } });
            } else if (message.method === 'item/permissions/requestApproval') {
              send({ id: message.id, result: { permissions: {}, scope: 'turn' } });
            } else if (message.method === 'item/tool/requestUserInput') {
              send({ id: message.id, result: { answers: {} } });
            } else if (message.method === 'mcpServer/elicitation/request') {
              send({ id: message.id, result: { action: 'decline', content: null, _meta: null } });
            } else {
              send({ id: message.id, error: { code: -32601, message: `不支持此交互请求：${message.method}` } });
            }
            return {};
          }
          if (message.error) return fail(string(object(message.error)?.message) || 'Codex App Server 请求失败');
          if (message.id === 1) {
            send({ method: 'initialized' });
            const configuration = {
              ...(model ? { model } : {}), sandbox,
              approvalPolicy: permissionMode === 'auto-review' ? 'on-request' : 'never',
              approvalsReviewer: permissionMode === 'auto-review' ? 'guardian_subagent' : 'user',
            };
            send({ id: 2, method: externalSessionId ? 'thread/resume' : 'thread/start', params: {
              ...configuration,
              ...(externalSessionId ? { threadId: externalSessionId, excludeTurns: true } : { historyMode: 'legacy' }),
            } });
          } else if (message.id === 2) {
            threadId = string(object(object(message.result)?.thread)?.id);
            if (!threadId) return fail('Codex App Server 未返回会话 ID');
            send({ id: 3, method: 'turn/start', params: { threadId, input: [
              { type: 'text', text: prompt },
              ...(images?.map(image => ({ type: 'localImage', path: image.path })) || []),
            ] } });
            return { externalSessionId: threadId };
          }
          if (params?.threadId !== undefined && params.threadId !== threadId) return {};
          const result = read(line);
          if (result.settled) close();
          return result;
        };
      },
    };
  },
  readStderr(line) {
    const log = json(line);
    if (log?.level === 'INFO' || log?.level === 'DEBUG' || log?.level === 'TRACE') return [];
    return [{ type: log?.level === 'WARN' || /^\S+\s+WARN\b/.test(line.trim()) ? 'warning' : 'error', text: string(object(log?.fields)?.message) || line }];
  },
  settlementError: 'Codex 进程退出前未返回 turn/completed，无法确认任务已完成。',
  createReader() {
    const items = new Map<string, AdapterEvent>();
    const summaries = new Map<string, string[]>();
    function readItem(item: Record<string, unknown>, streaming: boolean): AdapterEvent | undefined {
      const id = string(item.id);
      if (!id) return undefined;
      const position = { streamId: id, orderKey: id, streaming };
      if (item.type === 'agentMessage' || item.type === 'plan') return { type: 'output', text: string(item.text) || '', ...position };
      if (item.type === 'reasoning') {
        const summary = Array.isArray(item.summary) ? item.summary.filter((part): part is string => typeof part === 'string') : [];
        summaries.set(id, summary);
        return { type: 'thinking', text: summary.join('\n'), ...position };
      }
      if (item.type === 'commandExecution') return { type: 'tool', text: `$ ${string(item.command) || 'command'}`, detail: string(item.aggregatedOutput) ?? items.get(id)?.detail, ...position };
      if (item.type === 'mcpToolCall') return { type: 'tool', text: `${string(item.server) || 'MCP'} / ${string(item.tool) || 'tool'}`, detail: detail(item.error ?? item.result), ...position };
      return undefined;
    }
    return line => {
      const message = json(line);
      const params = object(message?.params);
      if (!params) return {};
      if (message?.method === 'turn/completed') {
        const turn = object(params.turn);
        return { settled: true, failed: turn?.status === 'failed', aborted: turn?.status === 'interrupted', error: string(object(turn?.error)?.message) };
      }
      if (message?.method === 'error') return { error: string(object(params.error)?.message), failed: params.willRetry !== true };
      if (message?.method === 'thread/tokenUsage/updated') {
        const tokenUsage = object(params.tokenUsage);
        const usage = object(tokenUsage?.total);
        const contextTokens = object(tokenUsage?.last)?.totalTokens;
        return {
          contextTokens: typeof contextTokens === 'number' && Number.isFinite(contextTokens) && contextTokens >= 0 ? contextTokens : undefined,
          usage: usage && hasTokens(usage, ['inputTokens', 'outputTokens']) ? {
            inputTokens: tokens(usage.inputTokens), outputTokens: tokens(usage.outputTokens),
            cacheReadTokens: typeof usage.cachedInputTokens === 'number' ? tokens(usage.cachedInputTokens) : undefined,
            cacheWriteTokens: typeof usage.cacheWriteInputTokens === 'number' ? tokens(usage.cacheWriteInputTokens) : undefined,
          } : undefined,
          usageIsTotal: true,
        };
      }
      if (message?.method === 'item/started' || message?.method === 'item/completed') {
        const item = object(params.item);
        const event = item && readItem(item, message.method === 'item/started');
        if (!event) return {};
        items.set(event.streamId!, event);
        return { events: event.text ? [event] : [] };
      }
      const id = string(params.itemId);
      const previous = id && items.get(id);
      const delta = string(params.delta);
      if (!id || !previous || delta === undefined || !previous.streaming) return {};
      let event: AdapterEvent;
      if (message?.method === 'item/agentMessage/delta' || message?.method === 'item/plan/delta') {
        event = { ...previous, text: previous.text + delta };
      } else if (message?.method === 'item/reasoning/summaryTextDelta') {
        if (typeof params.summaryIndex !== 'number' || !Number.isSafeInteger(params.summaryIndex) || params.summaryIndex < 0) return {};
        const summary = summaries.get(id)!;
        summary[params.summaryIndex] = (summary[params.summaryIndex] || '') + delta;
        event = { ...previous, text: summary.join('\n') };
      } else if (message?.method === 'item/commandExecution/outputDelta') {
        event = { ...previous, detail: (previous.detail || '') + delta };
      } else return {};
      items.set(id, event);
      return { events: [event] };
    };
  },
};
