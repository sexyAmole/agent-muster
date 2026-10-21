import { getSandboxEnabled, validatePermissionMode } from '../agents/settings.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { adapters, type AdapterResult } from '../agents/providers/index.js';
import { SessionStore } from './store.js';
import { mergeSessionEvents } from './events.js';
import { readSessionLogs } from '../agents/session-logs.js';
import { createLineReader } from './line-reader.js';
import type { AgentImage, AgentSession, ImBinding, ImContext, SessionEvent, SessionStatus, TokenUsage } from '../types.js';

type SessionEventInput = Omit<SessionEvent, 'id' | 'timestamp' | 'pushedToIm' | 'type' | 'kind' | 'comparison'> & { type: Exclude<SessionEvent['type'], 'raw_stdout' | 'raw_stderr' | 'system' | 'file_change'> };

interface RunState {
  id: string;
  orders: Map<string, number>;
  failed: boolean;
  settled: boolean;
  aborted: boolean;
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
      session.permissionMode ??= 'full-auto';
      if (session.status === 'running' || session.status === 'starting') {
        session.status = 'stopped';
        session.pid = undefined;
        this.status(session, 'stopped');
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
    if (ids.length && agent === 'cursor') throw new Error('当前 Agent 接入不支持图片附件');
    return this.store.readImages(ids);
  }

  history(id: string, limit?: number, before?: number) {
    if (!this.sessions.has(id)) throw new Error('会话不存在');
    const page = this.store.history(id, limit, before);
    if (limit !== 0 && before === undefined) page.events = mergeSessionEvents([...page.events, ...this.sessions.get(id)!.events.filter(event => event.streaming)]);
    return page;
  }

  logs(id: string, limit: number, before?: number) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('会话不存在');
    return readSessionLogs(session, limit, before);
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

  rename(id: string, title: string): AgentSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error('会话不存在');
    const renamed = { ...session, title };
    this.store.saveMetadata(renamed);
    session.title = title;
    return session;
  }

  linkImSession(id: string, binding: ImBinding): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const previous = session.im?.find(item => item.platform === binding.platform);
    const next = { ...previous, ...binding } as ImBinding;
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    session.im = [...session.im?.filter(item => item.platform !== binding.platform) || [], next];
    this.save(session);
  }

  isRunning(id: string): boolean {
    return this.processes.has(id);
  }

  private save(session: AgentSession, event?: SessionEvent): void {
    try { this.store.saveMetadata(session, event); }
    catch (error) { console.error('保存会话失败：', error); }
  }

  private append(session: AgentSession, { type, text, detail, im, images, ...attributes }: SessionEventInput): SessionEvent {
    const event: SessionEvent = {
      id: Math.max(0, ...session.events.map(event => event.id)) + 1,
      ...attributes,
      type,
      text: attributes.streamId ? text : text.slice(0, 50000),
      ...(detail === undefined ? {} : { detail: type === 'tool' ? detail : detail.slice(0, 50000) }),
      timestamp: Date.now(),
      ...(im ? { im } : {}),
      ...(images?.length ? { images: images.map(({ path, mimeType }) => ({ path, mimeType })) } : {}),
    };
    session.updatedAt = event.timestamp;
    if (!event.streaming) {
      this.save(session, event);
      try { this.store.appendEvent(session.id, event); }
      catch (error) { console.error('保存会话事件失败：', error); }
    }
    this.publish(session, event);
    return event;
  }

  private publish(session: AgentSession, event: SessionEvent): void {
    const index = event.streamId ? session.events.findIndex(item => item.streamId === event.streamId) : -1;
    if (index !== -1) session.events.splice(index, 1);
    session.events.push(event);
    if (session.events.length > 50) session.events = session.events.filter((event, index) => event.streaming || index >= session.events.length - 50);
    this.emit(session.id, event);
  }

  private status(session: AgentSession, status: SessionStatus): void {
    session.status = status;
    this.append(session, { type: 'status', text: status });
  }

  private addUsage(session: AgentSession, usage: TokenUsage | undefined, total = false, contextTokens?: number): void {
    const previous = session.usage;
    if (!usage && contextTokens === undefined) return;
    const consumption = usage ? total ? usage : {
      inputTokens: (previous?.inputTokens || 0) + usage.inputTokens,
      outputTokens: (previous?.outputTokens || 0) + usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens !== undefined && (!previous || previous.cacheReadTokens !== undefined) ? (previous?.cacheReadTokens || 0) + usage.cacheReadTokens : undefined,
      cacheWriteTokens: usage.cacheWriteTokens !== undefined && (!previous || previous.cacheWriteTokens !== undefined) ? (previous?.cacheWriteTokens || 0) + usage.cacheWriteTokens : undefined,
    } : previous || { inputTokens: 0, outputTokens: 0 };
    session.usage = { ...consumption, ...(contextTokens !== undefined || previous?.contextTokens !== undefined ? { contextTokens: contextTokens ?? previous?.contextTokens } : {}) };
    this.append(session, { type: 'usage', text: JSON.stringify(session.usage) });
  }

  async create(agent: string, cwd: string, prompt: string, model?: string, im?: ImBinding, images?: AgentImage[], permissionMode?: string | null): Promise<AgentSession> {
    validatePermissionMode(agent, permissionMode);
    if (!adapters[agent]) throw new Error('Unsupported agent');
    if (!prompt.trim()) throw new Error('Prompt is required');
    if (!isAbsolute(cwd) || !(await stat(cwd).then(value => value.isDirectory()).catch(() => false))) {
      throw new Error('Project directory must be an existing absolute path');
    }
    const now = Date.now();
    const session: AgentSession = {
      id: `ses_${randomUUID()}`,
      agent,
      ...(im ? { im: [im] } : {}),
      model,
      permissionMode: permissionMode || 'full-auto',
      cwd: resolve(cwd),
      prompt: prompt.trim(),
      status: 'starting',
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    this.sessions.set(session.id, session);
    this.append(session, { type: 'message', text: session.prompt, im, images });
    this.start(session, session.prompt, images);
    return session;
  }

  async send(id: string, message: string, model?: string, im?: ImBinding, images?: AgentImage[], permissionMode?: string | null): Promise<AgentSession> {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Session not found');
    if (!message.trim()) throw new Error('Message is required');
    const child = this.processes.get(id);
    if (child && (session.status === 'completed' || session.status === 'stopped')) await once(child, 'close');
    if (this.sessions.get(id) !== session) throw new Error('Session not found');
    if (this.processes.has(id)) throw new Error('Wait for the current task to finish or stop it');
    if (!session.externalSessionId) throw new Error('This agent did not create a resumable session');
    validatePermissionMode(session.agent, permissionMode);
    if (permissionMode !== undefined) session.permissionMode = permissionMode || 'full-auto';
    if (model !== undefined) session.model = model || undefined;
    if (im) this.linkImSession(id, im);
    this.append(session, { type: 'message', text: message.trim(), im, images });
    this.start(session, message.trim(), images);
    return session;
  }

  recordImMessage(id: string, content: string, im: ImContext): AgentSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error('会话不存在');
    this.append(session, { type: 'im_message', text: content, im });
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
    try { this.store.markImPushed(session.id, event.id); }
    catch (error) { console.error('保存 IM 推送状态失败：', error); }
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

  async shutdown(): Promise<void> {
    const closed = [...this.processes.values()].map(child => new Promise<void>(resolve => child.once('close', () => resolve())));
    for (const id of this.processes.keys()) this.stop(id);
    await Promise.all(closed);
  }

  private savePending(session: AgentSession): void {
    try { this.store.savePending(session.id, session.events.filter(event => event.streaming)); }
    catch (error) { console.error('保存未完成内容失败：', error); }
  }

  private recordResult(session: AgentSession, run: RunState, result: AdapterResult): void {
    const append = (event: SessionEventInput) => this.append(session, event);
    const streamId = (id: string) => `${run.id}:${id}`;
    if (result.settled) { run.settled = true; run.aborted = result.aborted === true; run.failed = result.failed === true; }
    if (result.externalSessionId) {
      session.externalSessionId = result.externalSessionId;
      this.save(session);
    }
    if (result.clearStreamIds?.length) {
      const clearStreamIds = result.clearStreamIds.map(streamId);
      session.events = session.events.filter(event => !event.streaming || !clearStreamIds.includes(event.streamId!));
      append({ type: 'status', text: session.status, clearStreamIds });
    }
    if (result.contextTokens !== undefined && !result.events.some(event => event.type === 'usage')) this.addUsage(session, undefined, false, result.contextTokens);
    for (const event of result.events) {
      if (event.type === 'usage') {
        this.addUsage(session, event.usage, event.total, result.contextTokens);
        continue;
      }
      const id = event.streamId ? streamId(event.streamId) : undefined;
      const previous = id ? session.events.find(item => item.streamId === id) : undefined;
      if (event.streaming && previous?.text === event.text && previous.detail === event.detail && previous.contentIndex === event.contentIndex) continue;
      if (event.orderKey && !run.orders.has(event.orderKey)) run.orders.set(event.orderKey, Math.max(0, ...session.events.map(item => item.id)) + 1);
      append({
        type: event.type, text: event.text, detail: event.detail,
        streamId: id, order: event.orderKey ? run.orders.get(event.orderKey) : undefined,
        contentIndex: event.contentIndex, streaming: event.streaming,
      });
    }
    if (result.failed !== undefined) run.failed = result.failed;
    if (result.events.some(event => 'streaming' in event && event.streaming === false) || result.clearStreamIds?.length) this.savePending(session);
    if (result.settled && session.status === 'running') {
      this.status(session, run.aborted ? 'stopped' : run.failed ? 'failed' : 'completed');
    }
  }

  private finishRun(session: AgentSession, child: ChildProcessWithoutNullStreams, run: RunState, code: number | null, settlementError?: string): void {
    if (this.processes.get(session.id) !== child) return;
    this.processes.delete(session.id);
    session.pid = undefined;
    if (session.status !== 'stopped' && session.status !== 'failed') {
      if (settlementError && !run.settled && code === 0 && !run.failed) {
        run.failed = true;
        this.append(session, { type: 'error', text: settlementError });
      }
      const status = run.aborted ? 'stopped' : code === 0 && !run.failed ? 'completed' : 'failed';
      if (session.status !== status) this.status(session, status);
    }
    this.emit(`${session.id}:idle`);
  }

  private start(session: AgentSession, prompt: string, images?: AgentImage[]): void {
    const adapter = adapters[session.agent];
    const launch = adapter.launch(prompt, session.externalSessionId, session.model, images, { permissionMode: session.permissionMode, sandboxEnabled: getSandboxEnabled(session.agent) });
    const readRaw = adapter.createRawReader?.();
    const run: RunState = { id: randomUUID(), orders: new Map(), failed: false, settled: false, aborted: false };
    const child = spawn(launch.command, launch.args, {
      cwd: session.cwd,
      stdio: 'pipe',
      detached: process.platform !== 'win32',
      env: session.agent === 'opencode' ? { ...(launch.env || process.env), PWD: session.cwd } : launch.env || process.env,
    });
    const read = adapter.createReader(launch.connect?.(child));
    this.processes.set(session.id, child);
    session.pid = child.pid;
    this.status(session, 'running');
    if (!launch.connect) child.stdin.end(launch.prompt === undefined ? undefined : `${launch.prompt}\n`);

    const consume = (channel: 'stdout' | 'stderr') => createLineReader(line => {
      this.recordResult(session, run, read(line, channel));
    }, readRaw ? chunk => this.recordResult(session, run, readRaw(chunk, channel)) : undefined);
    const stdout = consume('stdout');
    const stderr = consume('stderr');
    const checkpoint = setInterval(() => this.savePending(session), 1000);
    child.stdout.on('data', stdout.write);
    child.stderr.on('data', stderr.write);
    child.on('error', error => {
      run.failed = true;
      this.append(session, { type: 'error', text: error.message });
      if (session.status !== 'stopped') this.status(session, 'failed');
    });
    child.once('close', code => {
      clearInterval(checkpoint);
      stderr.end();
      stdout.end();
      for (const event of session.events.filter((event): event is SessionEvent & { type: SessionEventInput['type'] } => Boolean(event.streaming) && event.type !== 'raw_stdout' && event.type !== 'raw_stderr' && event.type !== 'system' && event.type !== 'file_change')) {
        this.append(session, {
          type: event.type, text: event.text, detail: event.detail,
          rawRecordId: event.rawRecordId, streamId: event.streamId, order: event.order, contentIndex: event.contentIndex, streaming: false,
        });
      }
      this.savePending(session);
      this.finishRun(session, child, run, code, adapter.settlementError);
    });
  }
}
