import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fullAutoMode, planMode, execFileAsync, json, object, string, detail, tokens } from './shared.js';
import type { AgentProvider, AdapterEvent, ParsedResult } from './shared.js';

export const kimi: AgentProvider = {
  id: 'kimi',
  name: 'Kimi Code CLI',
  command: 'kimi',
  sandboxSupported: false,
  permissionModes: [fullAutoMode, planMode],
  installation: { kind: 'npm', packageName: '@moonshot-ai/kimi-code' },
  async models() {
    const { stdout } = await execFileAsync('kimi', ['provider', 'list', '--json'], { shell: process.platform === 'win32', timeout: 15000 });
    const config = JSON.parse(stdout) as { models: Record<string, { model: string; maxContextSize?: number }> };
    return Object.entries(config.models).map(([id, model]) => ({ id, name: model.model, contextWindow: model.maxContextSize }));
  },
  async configuredModel() {
    const directory = process.env.KIMI_CODE_HOME ? resolve(process.env.KIMI_CODE_HOME) : join(homedir(), '.kimi-code');
    const config = await readFile(join(directory, 'config.toml'), 'utf8');
    return /^default_model\s*=\s*['"]([^'"]+)['"]/m.exec(config)?.[1];
  },
  launch(prompt, externalSessionId, model, images, { permissionMode = 'full-auto' } = {}) {
    return {
      command: 'kimi',
      args: ['acp'],
      connect(child, cwd) {
        const read = kimi.createReader();
        let sessionId = externalSessionId;
        let prompting = false;
        let closed = false;
        const send = (message: object) => { if (!closed) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); };
        const close = () => { if (!closed) { closed = true; child.stdin.end(); } };
        const fail = (error: string): ParsedResult => { close(); return { error, settled: true }; };
        child.stdin.on('error', error => { if (!closed) child.emit('error', error); });
        child.once('close', () => { closed = true; });
        send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agent-muster', version: '0.1.0' } } });
        return line => {
          const message = json(line);
          if (closed) return {};
          if (!message || message.type === 'plain') return fail('Kimi Code CLI 返回了无效的 JSON 消息');
          const params = object(message.params);
          if (message.id !== undefined && typeof message.method === 'string') {
            if (message.method === 'session/request_permission') send({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
            else send({ id: message.id, error: { code: -32601, message: `不支持此交互请求：${message.method}` } });
            return {};
          }
          if (message.error) {
            const error = object(message.error);
            return fail(error?.code === -32000 ? 'Kimi Code CLI 尚未登录，请先运行 kimi login' : string(error?.message) || 'Kimi Code CLI 请求失败');
          }
          if (message.id === 1) {
            send({ id: 2, method: externalSessionId ? 'session/load' : 'session/new', params: { cwd, mcpServers: [], ...(externalSessionId ? { sessionId: externalSessionId } : {}) } });
          } else if (message.id === 2) {
            sessionId = externalSessionId || string(object(message.result)?.sessionId);
            if (!sessionId) return fail('Kimi Code CLI 未返回会话 ID');
            send({ id: 3, method: 'session/set_mode', params: { sessionId, modeId: permissionMode === 'plan' ? 'plan' : 'auto' } });
            return { externalSessionId: sessionId };
          } else if (message.id === 3) {
            if (model) send({ id: 4, method: 'session/set_model', params: { sessionId, modelId: model } });
            else startPrompt();
          } else if (message.id === 4) startPrompt();
          else if (message.id === 5) {
            close();
            const reason = string(object(message.result)?.stopReason);
            if (reason === 'end_turn') return { settled: true };
            if (reason === 'cancelled') return { settled: true, aborted: true };
            return { settled: true, error: `Kimi Code CLI 未完成任务：${reason}` };
          }
          if (!prompting || params?.sessionId !== sessionId) return {};
          return read(line);
        };
        function startPrompt() {
          prompting = true;
          send({ id: 5, method: 'session/prompt', params: { sessionId, prompt: [
            { type: 'text', text: prompt },
            ...(images?.map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType })) || []),
          ] } });
        }
      },
    };
  },
  createReader() {
    let index = 0;
    let block: AdapterEvent | undefined;
    const tools = new Map<string, AdapterEvent>();
    return line => {
      const message = json(line);
      if (message?.method !== 'session/update') return {};
      const update = object(object(message.params)?.update);
      const kind = update?.sessionUpdate;
      if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
        const content = object(update?.content);
        if (content?.type !== 'text') return {};
        const type = kind === 'agent_message_chunk' ? 'output' : 'thinking';
        if (!block || block.type !== type) block = { type, text: '', streamId: `kimi:${++index}` };
        block.text += string(content.text) || '';
        return { events: [{ ...block }] };
      }
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        block = undefined;
        const id = string(update?.toolCallId);
        if (!id) return {};
        const previous = tools.get(id);
        const event: AdapterEvent = { type: 'tool', streamId: `kimi:tool:${id}`, text: string(update?.title) || previous?.text || id,
          detail: detail({ input: update?.rawInput, output: update?.rawOutput, content: update?.content, status: update?.status }) };
        tools.set(id, event);
        return { events: [event] };
      }
      if (kind === 'usage_update') return { contextTokens: tokens(update?.used) };
      return {};
    };
  },
  settlementError: 'Kimi Code CLI 进程退出前未返回执行结果，无法确认任务已完成。',
};
