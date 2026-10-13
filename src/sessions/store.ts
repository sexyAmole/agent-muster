import { closeSync, copyFileSync, readFileSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeSync, writeFileSync, appendFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentImage, AgentSession, DingTalkConversation, FeishuConversation, ImBinding, SessionEvent } from '../types.js';
import { projectDirectory } from '../projects/storage.js';
import { mergeSessionEvents } from './events.js';

type SessionMetadata = Omit<AgentSession, 'events'>;
type HistoryRecord = ({ type: 'session' } & SessionMetadata) | SessionEvent | { type: 'im_pushed'; eventId: number };
type LegacyRecord = { session: SessionMetadata; event?: SessionEvent; pushedEventId?: number };

type LegacyImFields = {
  dingtalkAppId?: string;
  feishuAppId?: string;
  dingtalkConversation?: DingTalkConversation;
  feishuConversation?: FeishuConversation;
};
type LegacyImEvent = { [Type in 'dingtalk_message' | 'feishu_message']: Omit<SessionEvent, 'type'> & { type: Type } }['dingtalk_message' | 'feishu_message'];
type StoredRecord = HistoryRecord | LegacyRecord | LegacyImEvent;

function migrateImRecord(record: HistoryRecord | Exclude<StoredRecord, LegacyRecord>): HistoryRecord {
  const { dingtalkAppId, feishuAppId, dingtalkConversation, feishuConversation, ...rest } = record as typeof record & LegacyImFields;
  if (rest.type === 'session') {
    const im: ImBinding[] = [...rest.im || []];
    if (dingtalkAppId) im.push({ platform: 'dingtalk', appId: dingtalkAppId, conversation: dingtalkConversation });
    if (feishuAppId) im.push({ platform: 'feishu', appId: feishuAppId, conversation: feishuConversation });
    return { ...rest, ...(im.length ? { im } : {}) };
  }
  if (rest.type === 'im_pushed') return rest;
  if (rest.type === 'dingtalk_message' || rest.type === 'feishu_message') {
    return { ...rest, type: 'im_message', im: rest.type === 'dingtalk_message'
      ? { platform: 'dingtalk', conversation: dingtalkConversation }
      : { platform: 'feishu', conversation: feishuConversation } };
  }
  if (dingtalkConversation) return { ...rest, im: { platform: 'dingtalk', conversation: dingtalkConversation } };
  if (feishuConversation) return { ...rest, im: { platform: 'feishu', conversation: feishuConversation } };
  return rest;
}

function metadataKey({ updatedAt, ...metadata }: SessionMetadata): string {
  return JSON.stringify(metadata);
}

function* records<T = HistoryRecord>(file: string, reverse = false): Generator<T> {
  const descriptor = openSync(file, 'r');
  try {
    const size = fstatSync(descriptor).size;
    let position = reverse ? size : 0;
    let pending: Buffer = Buffer.alloc(0);
    while (reverse ? position > 0 : position < size) {
      const length = Math.min(65536, reverse ? position : size - position);
      const chunk = Buffer.alloc(length);
      const offset = reverse ? position - length : position;
      const bytes = readSync(descriptor, chunk, 0, length, offset);
      position = reverse ? offset : position + bytes;
      const data = reverse ? Buffer.concat([chunk.subarray(0, bytes), pending]) : Buffer.concat([pending, chunk.subarray(0, bytes)]);
      if (reverse) {
        let end = data.length;
        for (let index = data.length - 1; index >= 0; index--) {
          if (data[index] !== 10) continue;
          if (end > index + 1) yield JSON.parse(data.subarray(index + 1, end).toString('utf8')) as T;
          end = index;
        }
        pending = data.subarray(0, end);
      } else {
        let start = 0;
        for (let index = 0; index < data.length; index++) {
          if (data[index] !== 10) continue;
          if (index > start) yield JSON.parse(data.subarray(start, index).toString('utf8')) as T;
          start = index + 1;
        }
        pending = data.subarray(start);
      }
    }
    if (pending.length) yield JSON.parse(pending.toString('utf8')) as T;
  } finally { closeSync(descriptor); }
}

export class SessionStore {
  private files = new Map<string, string>();
  private metadataKeys = new Map<string, string>();
  private pendingKeys = new Map<string, string>();

  constructor(private directory = join(homedir(), '.agent-muster')) {}

  async saveImage(data: Buffer, mimeType: string): Promise<string> {
    const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
    const extension = extensions[mimeType];
    if (typeof extension !== 'string') throw new Error('仅支持 PNG、JPEG、GIF 和 WebP 图片');
    if (!data.length) throw new Error('图片不能为空');
    const valid = mimeType === 'image/png' ? data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
      : mimeType === 'image/jpeg' ? data.subarray(0, 3).toString('hex') === 'ffd8ff'
      : mimeType === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))
      : data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!valid) throw new Error('图片内容与格式不匹配');
    const directory = join(this.directory, 'images');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const id = `${randomUUID()}.${extension}`;
    await writeFile(join(directory, id), data, { mode: 0o600 });
    return id;
  }

  async readImages(ids: string[]): Promise<AgentImage[]> {
    const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    return Promise.all(ids.map(async id => {
      const match = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.(png|jpg|gif|webp)$/.exec(id);
      if (!match) throw new Error('图片标识无效');
      const path = join(this.directory, 'images', id);
      const data = await readFile(path);
      return { type: 'image', path, mimeType: types[match[1]], data: data.toString('base64') };
    }));
  }

  async load(): Promise<AgentSession[]> {
    const projects = join(this.directory, 'projects');
    mkdirSync(projects, { recursive: true });
    await this.migrate();
    for (const project of readdirSync(projects, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      const projectPath = join(projects, project.name);
      for (const name of readdirSync(projectPath).filter(file => file.endsWith('.jsonl') && !file.endsWith('.raw.jsonl'))) {
        const source = join(projectPath, name);
        this.migrateRecords(source);
        const target = this.sessionFile(this.metadata(source));
        mkdirSync(dirname(target), { recursive: true });
        try { await stat(target); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          renameSync(source, target);
          continue;
        }
        throw new Error(`迁移目标已存在：${target}`);
      }
      if (!readdirSync(projectPath).length) rmdirSync(projectPath);
    }
    const sessions: AgentSession[] = [];
    for (const project of readdirSync(projects, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      const directory = join(projects, project.name, 'sessions');
      try { await stat(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      for (const name of readdirSync(directory).filter(file => file.endsWith('.jsonl') && !file.endsWith('.raw.jsonl'))) {
        const file = join(directory, name);
        this.migrateRecords(file);
        const metadata = this.metadata(file);
        this.files.set(metadata.id, file);
        this.metadataKeys.set(metadata.id, metadataKey(metadata));
        this.recoverPending(metadata);
        sessions.push({ ...metadata, events: this.history(metadata.id, 10).events });
      }
    }
    return sessions;
  }

  saveMetadata(session: AgentSession): void {
    const { events, ...metadata } = session;
    const file = this.files.get(session.id) || this.sessionFile(metadata);
    if (!this.files.has(session.id)) mkdirSync(dirname(file), { recursive: true });
    const key = metadataKey(metadata);
    if (this.metadataKeys.get(session.id) !== key) this.appendRecord(file, { type: 'session', ...metadata });
    this.files.set(session.id, file);
    this.metadataKeys.set(session.id, key);
  }

  appendEvent(id: string, event: SessionEvent): void {
    this.appendRecord(this.files.get(id)!, event);
  }

  appendRaw(id: string, event: SessionEvent): void {
    this.appendRecord(this.rawFile(this.files.get(id)!), event);
  }

  markImPushed(id: string, eventId: number): void {
    this.appendRecord(this.files.get(id)!, { type: 'im_pushed', eventId });
  }

  private appendRecord(file: string, record: HistoryRecord): void {
    appendFileSync(file, `${JSON.stringify(record)}\n`);
  }

  history(id: string, limit?: number, before?: number, includeRaw = true): { events: SessionEvent[]; hasMore: boolean } {
    if (limit === 0) return { events: [], hasMore: false };
    if (limit === undefined) return { events: mergeSessionEvents([...this.eventsAfter(id, 0, includeRaw)]), hasMore: false };
    const events: SessionEvent[] = [];
    const pushed = new Set<number>();
    let rounds = 0;
    let hasMore = false;
    for (const record of records(this.files.get(id)!, true)) {
      if (record.type === 'im_pushed') { pushed.add(record.eventId); continue; }
      if (record.type === 'session') continue;
      const event = record;
      if (!includeRaw && (event.type === 'raw_stdout' || event.type === 'raw_stderr')) continue;
      if (before !== undefined && event.id >= before) continue;
      if (rounds === limit) { hasMore = true; break; }
      events.push(pushed.has(event.id) ? { ...event, pushedToIm: true } : event);
      if (event.type === 'message') rounds++;
    }
    const firstId = events.at(-1)?.id;
    const rawFile = this.rawFile(this.files.get(id)!);
    if (includeRaw && firstId !== undefined && existsSync(rawFile)) {
      for (const event of records<SessionEvent>(rawFile, true)) {
        if (before !== undefined && event.id >= before) continue;
        if (event.id < firstId) break;
        events.push(event);
      }
    }
    return { events: mergeSessionEvents(events.reverse()), hasMore };
  }

  logs(id: string, limit: number, before?: number): { events: SessionEvent[]; hasMore: boolean } {
    const file = this.files.get(id)!;
    const rawFile = this.rawFile(file);
    const events: SessionEvent[] = [];
    for (const source of existsSync(rawFile) ? [file, rawFile] : [file]) {
      let count = 0;
      for (const record of records(source, true)) {
        if (record.type !== 'raw_stdout' && record.type !== 'raw_stderr') continue;
        if (before !== undefined && record.id >= before) continue;
        events.push(record);
        if (++count > limit) break;
      }
    }
    events.sort((a, b) => b.id - a.id);
    return { events: events.slice(0, limit).reverse(), hasMore: events.length > limit };
  }

  getEvent(id: string, eventId: number): SessionEvent | undefined {
    const file = this.files.get(id);
    if (!file) return undefined;
    let pushed = false;
    for (const record of records(file, true)) {
      if (record.type === 'im_pushed') { if (record.eventId === eventId) pushed = true; continue; }
      if (record.type !== 'session' && record.id === eventId) return pushed ? { ...record, pushedToIm: true } : record;
    }
    const rawFile = this.rawFile(file);
    if (existsSync(rawFile)) {
      for (const event of records<SessionEvent>(rawFile, true)) {
        if (event.id === eventId) return event;
        if (event.id < eventId) break;
      }
    }
    return undefined;
  }

  *eventsAfter(id: string, after: number, includeRaw = true): Generator<SessionEvent> {
    const file = this.files.get(id)!;
    const pushed = new Set<number>();
    for (const record of records(file, true)) {
      if (record.type === 'im_pushed') { if (record.eventId > after) pushed.add(record.eventId); continue; }
      if (record.type !== 'session' && record.id <= after) break;
    }
    const normalized = (function* () {
      for (const record of records(file)) {
        if (record.type !== 'session' && record.type !== 'im_pushed' && (includeRaw || (record.type !== 'raw_stdout' && record.type !== 'raw_stderr'))) yield record;
      }
    })();
    const rawFile = this.rawFile(file);
    const raw = includeRaw && existsSync(rawFile) ? records<SessionEvent>(rawFile) : [][Symbol.iterator]();
    let left = normalized.next();
    let right = raw.next();
    try {
      while (!left.done || !right.done) {
        const useLeft = right.done || (!left.done && left.value.id <= right.value.id);
        const event = (useLeft ? left.value : right.value)!;
        if (event.id > after) yield pushed.has(event.id) ? { ...event, pushedToIm: true } : event;
        if (useLeft) left = normalized.next();
        else right = raw.next();
      }
    } finally {
      normalized.return(undefined);
      raw.return?.(undefined);
    }
  }

  remove(id: string): void {
    this.savePending(id, []);
    const file = this.files.get(id)!;
    unlinkSync(file);
    const rawFile = this.rawFile(file);
    if (existsSync(rawFile)) unlinkSync(rawFile);
    this.files.delete(id);
    this.metadataKeys.delete(id);
  }

  savePending(id: string, events: SessionEvent[]): void {
    const file = `${this.files.get(id)!}.pending`;
    if (!events.length) {
      if (existsSync(file)) unlinkSync(file);
      this.pendingKeys.delete(id);
      return;
    }
    const key = JSON.stringify(events);
    if (this.pendingKeys.get(id) === key) return;
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, key);
    renameSync(temporary, file);
    this.pendingKeys.set(id, key);
  }

  private recoverPending(metadata: SessionMetadata): void {
    const file = `${this.files.get(metadata.id)!}.pending`;
    if (!existsSync(file)) return;
    const pending = JSON.parse(readFileSync(file, 'utf8')) as SessionEvent[];
    const events = this.history(metadata.id).events;
    const completed = new Set(events.filter(event => !event.streaming).map(event => event.streamId));
    let id = events.reduce((maximum, event) => Math.max(maximum, event.id), 0);
    for (const event of pending) {
      if (completed.has(event.streamId)) continue;
      metadata.updatedAt = Math.max(metadata.updatedAt, event.timestamp);
      this.saveMetadata({ ...metadata, events: [] });
      this.appendEvent(metadata.id, { ...event, id: ++id, streaming: false });
    }
    this.savePending(metadata.id, []);
  }

  private rawFile(file: string): string {
    return file.replace(/\.jsonl$/, '.raw.jsonl');
  }

  private sessionFile(session: SessionMetadata): string {
    const project = projectDirectory(this.directory, session.cwd);
    mkdirSync(join(project, 'sessions'), { recursive: true });
    const file = join(project, 'project.json');
    try { writeFileSync(file, JSON.stringify({ path: session.cwd }), { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return join(project, 'sessions', `${encodeURIComponent(session.id)}.jsonl`);
  }

  private metadata(file: string): SessionMetadata {
    let updatedAt: number | undefined;
    for (const record of records(file, true)) {
      if (record.type === 'session') {
        const { type, ...metadata } = record;
        return updatedAt === undefined ? metadata : { ...metadata, updatedAt: Math.max(metadata.updatedAt, updatedAt) };
      }
      if (record.type !== 'im_pushed' && updatedAt === undefined) updatedAt = record.timestamp;
    }
    throw new Error('会话文件缺少会话信息');
  }

  private migrateRecords(file: string): void {
    const requiresMigration = (record: StoredRecord): boolean => !('type' in record)
      || record.type === 'dingtalk_message' || record.type === 'feishu_message'
      || ['dingtalkAppId', 'feishuAppId', 'dingtalkConversation', 'feishuConversation'].some(key => key in record);
    let required = false;
    for (const record of records<StoredRecord>(file)) {
      if (requiresMigration(record)) { required = true; break; }
    }
    if (!required) return;
    const temporary = `${file}.${process.pid}.tmp`;
    const descriptor = openSync(temporary, 'w');
    const write = (record: Exclude<StoredRecord, LegacyRecord>) => writeSync(descriptor, `${JSON.stringify(migrateImRecord(record))}\n`);
    let previousKey: string | undefined;
    try {
      for (const record of records<StoredRecord>(file)) {
        if ('type' in record) { write(record); continue; }
        const key = metadataKey(record.session);
        if (key !== previousKey) write({ type: 'session', ...record.session });
        if (record.event) write(record.event);
        if (record.pushedEventId !== undefined) write({ type: 'im_pushed', eventId: record.pushedEventId });
        previousKey = key;
      }
    } finally { closeSync(descriptor); }
    copyFileSync(file, `${file}.${Date.now()}.bak`);
    renameSync(temporary, file);
  }

  private importSession(session: SessionMetadata, events: Iterable<SessionEvent>): void {
    const file = this.sessionFile(session);
    try {
      this.migrateRecords(file);
      if (this.metadata(file).updatedAt >= session.updatedAt) return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    const descriptor = openSync(temporary, 'w');
    try {
      writeSync(descriptor, `${JSON.stringify({ type: 'session', ...session })}\n`);
      for (const event of events) {
        if (event.type === 'error' && event.text.trim().split(/\r?\n/).every(line => /^\S+\s+WARN\b/.test(line))) event.type = 'warning';
        writeSync(descriptor, `${JSON.stringify(event)}\n`);
      }
    } finally { closeSync(descriptor); }
    renameSync(temporary, file);
  }

  private async migrate(): Promise<void> {
    const databaseFile = join(this.directory, 'sessions.sqlite');
    let hasDatabase = true;
    try { await stat(databaseFile); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; hasDatabase = false; }
    if (hasDatabase) {
      const { DatabaseSync } = await import('node:sqlite');
      const database = new DatabaseSync(databaseFile);
      try {
        for (const row of database.prepare('SELECT data FROM sessions').iterate()) {
          const session = JSON.parse(row.data as string) as SessionMetadata;
          const rows = database.prepare('SELECT data FROM events WHERE session_id = ? ORDER BY id').iterate(session.id);
          const events = function* () { for (const event of rows) yield JSON.parse(event.data as string) as SessionEvent; };
          this.importSession(session, events());
        }
        database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally { database.close(); }
      await rename(databaseFile, `${databaseFile}.bak`);
    }
    const directory = join(this.directory, 'sessions');
    let files: string[];
    try { files = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; files = []; }
    for (const name of files.filter(file => file.endsWith('.json'))) {
      const file = join(directory, name);
      const { events = [], ...session } = JSON.parse(await readFile(file, 'utf8')) as AgentSession;
      this.importSession(session, events);
      await rename(file, `${file}.bak`);
    }
    const legacyFile = join(this.directory, 'sessions.json');
    let legacy: string;
    try { legacy = await readFile(legacyFile, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return; }
    for (const { events = [], ...session } of JSON.parse(legacy) as AgentSession[]) this.importSession(session, events);
    await rename(legacyFile, `${legacyFile}.${Date.now()}.bak`);
  }
}
