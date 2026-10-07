import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { adapters } from '../agents/adapters.js';
import type { AgentImage, AgentSession, DingTalkConversation, FeishuConversation, SessionEvent, SessionStatus, TokenUsage } from '../types.js';

const sessionDirectory = join(homedir(), '.agent-muster', 'sessions');
const legacyDataFile = join(homedir(), '.agent-muster', 'sessions.json');

function sessionFile(id: string): string {
  return join(sessionDirectory, `${encodeURIComponent(id)}.json`);
}

async function writeSession(id: string, snapshot: string): Promise<void> {
  await mkdir(sessionDirectory, { recursive: true });
  const file = sessionFile(id);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, snapshot);
  await rename(temporary, file);
}

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
  private writeQueue = Promise.resolve();

  async load(): Promise<void> {
    const restore = (session: AgentSession) => {
      if (session.status === 'running' || session.status === 'starting') {
        session.status = 'stopped';
        session.pid = undefined;
      }
      session.events ||= [];
      for (const event of session.events) {
        if (event.type === 'error' && isWarning(event.text)) event.type = 'warning';
      }
      this.sessions.set(session.id, session);
    };

    try {
      const files = await readdir(sessionDirectory);
      for (const file of files.filter(name => name.endsWith('.json'))) {
        restore(JSON.parse(await readFile(join(sessionDirectory, file), 'utf8')) as AgentSession);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    try {
      const stored = JSON.parse(await readFile(legacyDataFile, 'utf8')) as AgentSession[];
      for (const session of stored) {
        const existing = this.sessions.get(session.id);
        if (existing && existing.updatedAt >= session.updatedAt) continue;
        restore(session);
        await writeSession(session.id, JSON.stringify(session));
      }
      await rename(legacyDataFile, `${legacyDataFile}.${Date.now()}.bak`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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

  private save(session: AgentSession): void {
    const snapshot = JSON.stringify(session);
    this.writeQueue = this.writeQueue.then(() => writeSession(session.id, snapshot))
      .catch(error => console.error('Failed to save session:', error));
  }

  private append(session: AgentSession, type: SessionEvent['type'], text: string, detail?: string, kind?: string, comparison?: string, dingtalkConversation?: DingTalkConversation, feishuConversation?: FeishuConversation): void {
    const event: SessionEvent = {
      id: (session.events.at(-1)?.id || 0) + 1,
      type,
      text: text.slice(0, 50000),
      ...(detail === undefined ? {} : { detail: detail.slice(0, 50000) }),
      ...(kind === undefined ? {} : { kind }),
      ...(comparison === undefined ? {} : { comparison }),
      timestamp: Date.now(),
      ...(dingtalkConversation ? { dingtalkConversation } : {}),
      ...(feishuConversation ? { feishuConversation } : {}),
    };
    session.events.push(event);
    if (session.events.length > 500) session.events.splice(0, session.events.length - 500);
    session.updatedAt = event.timestamp;
    this.emit(session.id, event);
    this.save(session);
  }

  private status(session: AgentSession, status: SessionStatus): void {
    session.status = status;
    this.append(session, 'status', status);
  }

  private addUsage(session: AgentSession, usage: TokenUsage, total = false): void {
    session.usage = total ? usage : {
      inputTokens: (session.usage?.inputTokens || 0) + usage.inputTokens,
      outputTokens: (session.usage?.outputTokens || 0) + usage.outputTokens,
    };
    this.append(session, 'usage', JSON.stringify(session.usage));
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
    this.append(session, 'message', session.prompt, undefined, undefined, undefined, dingtalkConversation, feishu?.conversation);
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
    this.append(session, 'message', message.trim(), undefined, undefined, undefined, dingtalkConversation, feishuConversation);
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
    const event = session.events.find(item => item.id === eventId && item.type === 'output');
    if (!event) throw new Error('助手结果不存在');
    event.pushedToIm = true;
    this.emit(session.id, event);
    this.save(session);
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
    await this.writeQueue;
    await unlink(sessionFile(id));
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
    let failed = false;
    const recordStderr = (line: string) => {
      if (!line.trim()) return;
      const error = adapter.readError?.(line);
      if (error) failed = true;
      this.append(session, isWarning(line) ? 'warning' : 'error', error || line);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) {
        const result = read(line.trim());
        if (result.externalSessionId) {
          session.externalSessionId = result.externalSessionId;
          this.save(session);
        }
        if (result.text) this.append(session, 'output', result.text);
        if (result.usage) this.addUsage(session, result.usage, result.usageIsTotal);
        for (const tool of result.tools || []) this.append(session, 'tool', tool.name, tool.detail);
        for (const change of result.changes || []) {
          const diff = change.diff || fileDiff(session.cwd, change.path);
          this.append(session, 'file_change', change.path, diff, change.kind, change.diff || !diff ? undefined : 'HEAD');
        }
        if (result.error) { failed = true; this.append(session, 'error', result.error); }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrPending += chunk.toString('utf8');
      const lines = stderrPending.split('\n');
      stderrPending = lines.pop() || '';
      for (const line of lines) recordStderr(line);
    });
    child.on('error', error => {
      this.append(session, 'error', error.message);
      this.processes.delete(session.id);
      session.pid = undefined;
      if (session.status !== 'stopped') this.status(session, 'failed');
      this.emit(`${session.id}:idle`);
    });
    child.on('close', code => {
      recordStderr(stderrPending);
      if (pending.trim()) {
        const result = read(pending.trim());
        if (result.externalSessionId) {
          session.externalSessionId = result.externalSessionId;
          this.save(session);
        }
        if (result.text) this.append(session, 'output', result.text);
        if (result.usage) this.addUsage(session, result.usage, result.usageIsTotal);
        for (const tool of result.tools || []) this.append(session, 'tool', tool.name, tool.detail);
        for (const change of result.changes || []) {
          const diff = change.diff || fileDiff(session.cwd, change.path);
          this.append(session, 'file_change', change.path, diff, change.kind, change.diff || !diff ? undefined : 'HEAD');
        }
        if (result.error) { failed = true; this.append(session, 'error', result.error); }
      }
      this.processes.delete(session.id);
      session.pid = undefined;
      if (session.status !== 'stopped' && session.status !== 'failed') {
        this.status(session, code === 0 && !failed ? 'completed' : 'failed');
      }
      this.emit(`${session.id}:idle`);
    });
  }
}
