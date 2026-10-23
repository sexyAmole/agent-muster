import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { codex } from './codex.js';
import { findJsonl } from '../jsonl.js';
import { fullAutoMode, autoReviewMode, json, object, string } from './shared.js';
import type { AgentProvider, ParsedResult } from './shared.js';
import type { ModelInfo } from '../../types.js';

function homeDirectory(): string {
  return process.env.TRAE_HOME ? resolve(process.env.TRAE_HOME) : join(homedir(), '.trae');
}

function queryModels(): Promise<ModelInfo[]> {
  return new Promise((resolveModels, reject) => {
    const child = spawn('traecli', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = createInterface({ input: child.stdout });
    let finished = false;
    const finish = (error?: Error, models?: ModelInfo[]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      if (error) reject(error);
      else if (models) resolveModels(models);
    };
    const timer = setTimeout(() => finish(new Error('TRAE CLI 模型查询超时')), 15000);
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('exit', () => finish(new Error('TRAE CLI 在返回模型前退出')));
    lines.on('line', line => {
      try {
        const message = JSON.parse(line) as { id?: number; error?: { message: string }; result?: { data: { model: string; displayName: string; contextWindow?: number | null }[] } };
        if (message.error) { finish(new Error(message.error.message)); return; }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'model/list', params: { limit: 100 } })}\n`);
        }
        if (message.id === 2 && message.result) finish(undefined, message.result.data.map(model => ({ id: model.model, name: model.displayName, contextWindow: model.contextWindow ?? undefined })));
      } catch (error) { finish(error as Error); }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_muster', version: '0.1.0' } } })}\n`);
  });
}

export const trae: AgentProvider = {
  id: 'trae',
  name: 'TRAE CLI',
  command: 'traecli',
  sandboxSupported: true,
  permissionModes: [fullAutoMode, { id: 'read-only', name: '只读', description: '使用只读沙箱，禁止修改项目文件' }, { id: 'workspace-write', name: '项目内自动执行', description: '允许修改当前项目，越界操作直接拒绝' }, autoReviewMode],
  installation: { kind: 'external', message: '请通过官方脚本安装 TRAE CLI 2.0，运行 traecli login 登录，使用 traecli update 更新' },
  models: queryModels,
  async configuredModel() {
    const config = await readFile(join(homeDirectory(), 'traecli.toml'), 'utf8');
    return /^model\s*=\s*['"]([^'"]+)['"]/m.exec(config)?.[1];
  },
  async sessionLogFile(session) {
    return findJsonl(join(homeDirectory(), 'sessions'), file => basename(file).endsWith(`-${session.externalSessionId}.jsonl`));
  },
  launch(prompt, externalSessionId, model, images, { permissionMode = 'full-auto', sandboxEnabled = true } = {}) {
    const sandbox = permissionMode === 'read-only' || permissionMode === 'workspace-write' ? permissionMode
      : permissionMode === 'auto-review' || sandboxEnabled ? 'workspace-write' : 'danger-full-access';
    const approvalPolicy = permissionMode === 'auto-review' ? 'on-request' : 'never';
    const approvalsReviewer = permissionMode === 'auto-review' ? 'auto_review' : 'user';
    return {
      command: 'traecli',
      args: ['-c', `sandbox_mode=${JSON.stringify(sandbox)}`, '-c', `approval_policy=${JSON.stringify(approvalPolicy)}`, '-c', `approvals_reviewer=${JSON.stringify(approvalsReviewer)}`, 'app-server', '--listen', 'stdio://'],
      connect(child) {
        const read = trae.createReader();
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
          if (!message || message.type === 'plain') return fail('TRAE CLI 返回了无效的 JSON 消息');
          const params = object(message.params);
          if (message.id !== undefined && typeof message.method === 'string') {
            if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') send({ id: message.id, result: { decision: 'decline' } });
            else if (message.method === 'item/permissions/requestApproval') send({ id: message.id, result: { permissions: {}, scope: 'turn' } });
            else if (message.method === 'item/tool/requestUserInput') send({ id: message.id, result: { answers: {} } });
            else if (message.method === 'mcpServer/elicitation/request') send({ id: message.id, result: { action: 'decline', content: null, _meta: null } });
            else send({ id: message.id, error: { code: -32601, message: `不支持此交互请求：${message.method}` } });
            return {};
          }
          if (message.error) {
            const error = string(object(message.error)?.message);
            return fail(error === 'No Trae auth token available for Trae model fetch' ? 'TRAE CLI 尚未登录，请先在终端运行 traecli login' : error || 'TRAE CLI 请求失败');
          }
          if (message.id === 1) {
            send({ method: 'initialized' });
            send({ id: 2, method: externalSessionId ? 'thread/resume' : 'thread/start', params: {
              ...(model ? { model } : {}), sandbox, approvalPolicy, approvalsReviewer,
              ...(externalSessionId ? { threadId: externalSessionId } : {}),
            } });
          } else if (message.id === 2) {
            threadId = string(object(object(message.result)?.thread)?.id);
            if (!threadId) return fail('TRAE CLI 未返回会话 ID');
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
  createReader: codex.createReader,
  readStderr: codex.readStderr,
  settlementError: 'TRAE CLI 进程退出前未返回 turn/completed，无法确认任务已完成。',
};
