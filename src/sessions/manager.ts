import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { adapters, type AdapterResult } from '../agents/adapters.js';
import { SessionStore } from './store.js';
import { mergeSessionEvents } from './events.js';
import type { AgentImage, AgentSession, DingTalkConversation, FeishuConversation, SessionEvent, SessionStatus, TokenUsage } from '../types.js';

function isWarning(text: string): boolean {
  return text.trim().split(/\r?\n/).every(line => /^\S+\s+WARN\b/.test(line));
}

function fileDiff(cwd: string, path: string): string | undefined {
  const file = resolve(cwd, path);
  const localPath = relative(cwd, file);
  if (localPath.startsWith('..') || isAbsolute(localPath)) return undefined;
  const repository = spawnSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', timeout: 2000 });
  if (repository.status !== 0 || repository.stdout.trim() !== 'true') return undefined;
  const tracked = spawnSync('git', ['-C', cwd, 'ls-files', '--error-unmatch', '--', localPath], { encoding: 'utf8', timeout: 2000 });
  const args = tracked.status === 0
    ? ['-C', cwd, 'diff', '--no-ext-diff', 'HEAD', '--', localPath]
    : ['-C', cwd, 'diff', '--no-ext-diff', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', file];
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 2000, maxBuffer: 1_000_000 });
  return result.error ? undefined : result.stdout?.trim() || undefined;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, AgentSession>();
  private processes = new Map<string, ChildProcessWithoutNullStreams>();
  private store: SessionStore;

  constructor(directory?: string) {
    super();
    this.store = new SessionStore(directory);
  }

  async load(): Promise<void> {
    for (const session of await this.store.load()) {
      if (session.status === 'running' || session.status === 'starting') {
        session.status = 'stopped';
        session.pid = undefined;
        this.store.save(session);
      }
      this.sessions.set(session.id, session);
    }
  }

  async uploadImage(data: Buffer, mimeType: string): Promise<string> {
    return this.store.saveImage(data, mimeType);
  }

  async readImages(ids: unknown, agent: string): Promise<AgentImage[]> {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) throw new Error('图片列表无效');
    if (ids.length && (agent === 'kimi' || agent === 'cursor')) throw new Error('当前 Agent 接入不支持图片附件');
    return this.store.readImages(ids);
  }

  history(id: string, limit?: number, before?: number) {
    if (!this.sessions.has(id)) throw new Error('会话不存在');
    const page = this.store.history(id, limit, before);
    if (limit !== 0 && before === undefined) page.events = mergeSessionEvents([...page.events, ...this.sessions.get(id)!.events.filter(event => event.streaming)]);
    return page;
  }

  getEvent(id: string, eventId: number): SessionEvent | undefined {
    return this.store.getEvent(id, eventId);
  }

  *eventsAfter(id: string, after: number): Generator<SessionEvent> {
    yield* this.store.eventsAfter(id, after);
    for (const event of this.sessions.get(id)?.events || []) {
      if (event.streaming) yield event;
    }
  }

  list(): AgentSession[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  linkDingTalkSession(id: string, appId: string): void {
    const session = this.sessions.get(id);
    if (!session || session.dingtalkAppId === appId) return;
    session.dingtalkAppId = appId;
    this.save(session);
  }

  linkFeishuSession(id: string, appId: string): void {
    const session = this.sessions.get(id);
    if (!session || session.feishuAppId === appId) return;
    session.feishuAppId = appId;
    this.save(session);
  }

  isRunning(id: string): boolean {
    return this.processes.has(id);
  }

  private save(session: AgentSession, event?: SessionEvent, update = false): void {
    try { this.store.save(session, event, update); }
    catch (error) { console.error('保存会话失败：', error); }
  }

  private append(session: AgentSession, type: SessionEvent['type'], text: string, detail?: string, kind?: string, comparison?: string, dingtalkConversation?: DingTalkConversation, feishuConversation?: FeishuConversation, images?: AgentImage[], attributes: Pick<SessionEvent, 'rawRecordId' | 'streamId' | 'order' | 'contentIndex' | 'streaming' | 'clearStreamIds'> = {}): SessionEvent {
    const event: SessionEvent = {
      id: Math.max(0, ...session.events.map(event => event.id)) + 1,
      ...attributes,
      type,
      text: type === 'raw_stdout' || type === 'raw_stderr' || type === 'system' || attributes.streamId ? text : text.slice(0, 50000),
      ...(detail === undefined ? {} : { detail: type === 'system' || type === 'tool' ? detail : detail.slice(0, 50000) }),
      ...(kind === undefined ? {} : { kind }),
      ...(comparison === undefined ? {} : { comparison }),
      timestamp: Date.now(),
      ...(dingtalkConversation ? { dingtalkConversation } : {}),
      ...(feishuConversation ? { feishuConversation } : {}),
      ...(images?.length ? { images: images.map(({ path, mimeType }) => ({ path, mimeType })) } : {}),
    };
    const index = event.streamId ? session.events.findIndex(item => item.streamId === event.streamId) : -1;
    if (index !== -1) session.events.splice(index, 1);
    session.events.push(event);
    if (session.events.length > 50) session.events = session.events.filter((event, index) => event.streaming || index >= session.events.length - 50);
    session.updatedAt = event.timestamp;
    if (!event.streaming) this.save(session, event);
    this.emit(session.id, event);
    return event;
  }

  private status(session: AgentSession, status: SessionStatus): void {
    session.status = status;
    this.append(session, 'status', status);
  }

  private addUsage(session: AgentSession, usage: TokenUsage, total = false, rawRecordId?: number): void {
    session.usage = total ? usage : {
      inputTokens: (session.usage?.inputTokens || 0) + usage.inputTokens,
      outputTokens: (session.usage?.outputTokens || 0) + usage.outputTokens,
    };
    this.append(session, 'usage', JSON.stringify(session.usage), undefined, undefined, undefined, undefined, undefined, undefined, { rawRecordId });
  }

  async create(agent: string, cwd: string, prompt: string, model?: string, dingtalkAppId?: string, dingtalkConversation?: DingTalkConversation, images?: AgentImage[], feishu?: { appId: string; conversation: FeishuConversation }): Promise<AgentSession> {
    if (!adapters[agent]) throw new Error('Unsupported agent');
    if (!prompt.trim()) throw new Error('Prompt is required');
    if (!isAbsolute(cwd) || !(await stat(cwd).then(value => value.isDirectory()).catch(() => false))) {
      throw new Error('Project directory must be an existing absolute path');
    }
    const now = Date.now();
    const session: AgentSession = {
      id: `ses_${randomUUID()}`,
      agent,
      ...(dingtalkAppId ? { dingtalkAppId } : {}),
      ...(feishu ? { feishuAppId: feishu.appId, feishuConversation: feishu.conversation } : {}),
      ...(dingtalkConversation ? { dingtalkConversation } : {}),
      model,
      cwd: resolve(cwd),
      prompt: prompt.trim(),
      status: 'starting',
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    this.sessions.set(session.id, session);
    this.append(session, 'message', session.prompt, undefined, undefined, undefined, dingtalkConversation, feishu?.conversation, images);
    this.start(session, session.prompt, images);
    return session;
  }

  send(id: string, message: string, model?: string, dingtalkConversation?: DingTalkConversation, images?: AgentImage[], feishuConversation?: FeishuConversation): AgentSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');
    if (!message.trim()) throw new Error('Message is required');
    if (this.processes.has(id)) throw new Error('Wait for the current task to finish or stop it');
    if (!session.externalSessionId) throw new Error('This agent did not create a resumable session');
    if (model !== undefined) session.model = model || undefined;
    if (dingtalkConversation) session.dingtalkConversation = dingtalkConversation;
    if (feishuConversation) session.feishuConversation = feishuConversation;
    this.append(session, 'message', message.trim(), undefined, undefined, undefined, dingtalkConversation, feishuConversation, images);
    this.start(session, message.trim(), images);
    return session;
  }

  recordDingTalkMessage(id: string, content: string): AgentSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');
    this.append(session, 'dingtalk_message', content);
    return session;
  }

  recordFeishuMessage(id: string, content: string): AgentSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error('会话不存在');
    this.append(session, 'feishu_message', content);
    return session;
  }

  markImPushed(id: string, eventId: number): AgentSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error('会话不存在');
    const event = this.store.getEvent(id, eventId);
    if (!event || event.type !== 'output') throw new Error('助手结果不存在');
    event.pushedToIm = true;
    const cached = session.events.find(item => item.id === eventId);
    if (cached) cached.pushedToIm = true;
    this.save(session, event, true);
    this.emit(session.id, event);
    return session;
  }

  stop(id: string): AgentSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');
    const child = this.processes.get(id);
    if (!child) throw new Error('Session is not running');
    this.status(session, 'stopped');
    if (process.platform === 'win32') child.kill('SIGTERM');
    else if (child.pid) process.kill(-child.pid, 'SIGTERM');
    return session;
  }

  async remove(id: string): Promise<void> {
    if (!this.sessions.has(id)) throw new Error('Session not found');
    const child = this.processes.get(id);
    if (child) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
      this.stop(id);
      await closed;
    }
    this.store.remove(id);
    this.sessions.delete(id);
  }

  shutdown(): void {
    for (const id of this.processes.keys()) this.stop(id);
  }

  private start(session: AgentSession, prompt: string, images?: AgentImage[]): void {
    const adapter = adapters[session.agent];
    const launch = adapter.launch(prompt, session.externalSessionId, session.model, images);
    const read = adapter.createReader?.() || adapter.read;
    const child = spawn(launch.command, launch.args, {
      cwd: session.cwd,
      stdio: 'pipe',
      detached: process.platform !== 'win32',
      env: session.agent === 'opencode' ? { ...process.env, PWD: session.cwd } : process.env,
    });
    this.processes.set(session.id, child);
    session.pid = child.pid;
    this.status(session, 'running');
    child.stdin.end(launch.prompt === undefined ? undefined : `${launch.prompt}\n`);

    let pending = '';
    let stderrPending = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let failed = false;
    let settled = false;
    let aborted = false;
    const runId = randomUUID();
    const orders = new Map<string, number>();
    const streamId = (id: string) => `${runId}:${id}`;
    const savePending = () => {
      try { this.store.savePending(session.id, session.events.filter(event => event.streaming)); }
      catch (error) { console.error('保存未完成内容失败：', error); }
    };
    const recordResult = (result: AdapterResult, rawRecordId: number) => {
      const append = (type: SessionEvent['type'], text: string, detail?: string, kind?: string, comparison?: string, attributes: Pick<SessionEvent, 'streamId' | 'order' | 'contentIndex' | 'streaming' | 'clearStreamIds'> = {}) =>
        this.append(session, type, text, detail, kind, comparison, undefined, undefined, undefined, { rawRecordId, ...attributes });
      if (result.settled) { settled = true; aborted = result.aborted === true; failed = result.failed === true; }
      if (result.externalSessionId) {
        session.externalSessionId = result.externalSessionId;
        this.save(session);
      }
      if (result.clearStreamIds?.length) {
        const clearStreamIds = result.clearStreamIds.map(streamId);
        session.events = session.events.filter(event => !event.streaming || !clearStreamIds.includes(event.streamId!));
        append('status', session.status, undefined, undefined, undefined, { clearStreamIds });
      }
      if (result.system) append('system', result.system.text, result.system.detail);
      if (result.thinking) append('thinking', result.thinking);
      if (result.text) append('output', result.text);
      if (result.usage) this.addUsage(session, result.usage, result.usageIsTotal, rawRecordId);
      for (const event of result.events || []) {
        const id = event.streamId ? streamId(event.streamId) : undefined;
        const previous = id ? session.events.find(item => item.streamId === id) : undefined;
        if (event.streaming && previous?.text === event.text && previous.detail === event.detail && previous.contentIndex === event.contentIndex) continue;
        if (event.orderKey && !orders.has(event.orderKey)) orders.set(event.orderKey, rawRecordId);
        append(event.type, event.text, event.detail, undefined, undefined, {
          streamId: id, order: event.orderKey ? orders.get(event.orderKey) : undefined,
          contentIndex: event.contentIndex, streaming: event.streaming,
        });
      }
      for (const tool of result.tools || []) append('tool', tool.name, tool.detail);
      for (const change of result.changes || []) {
        const diff = change.diff || fileDiff(session.cwd, change.path);
        append('file_change', change.path, diff, change.kind, change.diff || !diff ? undefined : 'HEAD');
      }
      if (result.error) { failed = result.failed ?? true; append('error', result.error); }
      if (result.events?.some(event => !event.streaming) || result.clearStreamIds?.length) savePending();
    };
    const recordStdout = (line: string) => {
      const raw = this.append(session, 'raw_stdout', line);
      recordResult(read(line.trim()), raw.id);
    };
    const checkpoint = setInterval(savePending, 1000);
    const recordStderr = (line: string) => {
      const raw = this.append(session, 'raw_stderr', line);
      if (!line.trim()) return;
      const error = adapter.readError?.(line);
      if (error) failed = true;
      this.append(session, isWarning(line) ? 'warning' : 'error', error || line, undefined, undefined, undefined, undefined, undefined, undefined, { rawRecordId: raw.id });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      pending += stdoutDecoder.write(chunk);
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) recordStdout(line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrPending += stderrDecoder.write(chunk);
      const lines = stderrPending.split('\n');
      stderrPending = lines.pop() || '';
      for (const line of lines) recordStderr(line);
    });
    child.on('error', error => {
      clearInterval(checkpoint);
      this.append(session, 'error', error.message);
      this.processes.delete(session.id);
      session.pid = undefined;
      if (session.status !== 'stopped') this.status(session, 'failed');
      this.emit(`${session.id}:idle`);
    });
    child.on('close', code => {
      pending += stdoutDecoder.end();
      stderrPending += stderrDecoder.end();
      if (stderrPending.length) recordStderr(stderrPending);
      if (pending.length) recordStdout(pending);
      clearInterval(checkpoint);
      for (const event of session.events.filter(event => event.streaming)) {
        this.append(session, event.type, event.text, event.detail, event.kind, event.comparison, undefined, undefined, undefined, {
          rawRecordId: event.rawRecordId, streamId: event.streamId, order: event.order, contentIndex: event.contentIndex, streaming: false,
        });
      }
      savePending();
      this.processes.delete(session.id);
      session.pid = undefined;
      if (session.status !== 'stopped' && session.status !== 'failed') {
        if (adapter.settlementError && !settled && code === 0 && !failed) {
          failed = true;
          this.append(session, 'error', adapter.settlementError);
        }
        this.status(session, aborted ? 'stopped' : code === 0 && !failed ? 'completed' : 'failed');
      }
      this.emit(`${session.id}:idle`);
    });
  }
}
