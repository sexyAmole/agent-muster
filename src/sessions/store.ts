import { closeSync, copyFileSync, readFileSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeSync, writeFileSync, appendFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentImage, AgentSession, DingTalkConversation, FeishuConversation, ImBinding, SessionEvent } from '../types.js';
import { projectDirectory } from '../projects/storage.js';
import { mergeSessionEvents } from './events.js';
import { applyEventMetadata, applyMetadataChanges, metadataChanges, sessionEvent, sessionMetadata, storedEvent } from './records.js';
import type { SessionMetadata, SessionRecord } from './records.js';

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
  private metadataSnapshots = new Map<string, SessionMetadata>();
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
        this.migrateStorage(source);
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
        this.migrateStorage(file);
        const metadata = this.metadata(file);
        this.files.set(metadata.id, file);
        this.metadataSnapshots.set(metadata.id, structuredClone(metadata));
        this.recoverPending(metadata);
        sessions.push({ ...metadata, events: this.history(metadata.id, 10).events });
      }
    }
    return sessions;
  }

  saveMetadata(session: AgentSession, event?: SessionEvent): void {
    const metadata = sessionMetadata(session);
    const file = this.files.get(session.id) || this.sessionFile(metadata);
    const previous = this.metadataSnapshots.get(session.id);
    if (!previous) {
      mkdirSync(dirname(file), { recursive: true });
      this.appendRecord(file, { type: 'session', formatVersion: 2, ...metadata });
    } else {
      const changes = metadataChanges(previous, metadata, event);
      if (Object.keys(changes).length) this.appendRecord(file, { type: 'session_update', timestamp: session.updatedAt, changes });
    }
    this.files.set(session.id, file);
    this.metadataSnapshots.set(session.id, structuredClone(metadata));
  }

  appendEvent(id: string, event: SessionEvent): void {
    const file = this.files.get(id)!;
    this.appendRecord(file, storedEvent(event));
    if (event.pushedToIm) this.markImPushed(id, event.id);
  }

  markImPushed(id: string, eventId: number): void {
    this.appendRecord(this.files.get(id)!, { type: 'im_pushed', eventId });
  }

  private appendRecord(file: string, record: SessionRecord): void {
    appendFileSync(file, `${JSON.stringify(record)}\n`);
  }

  history(id: string, limit?: number, before?: number): { events: SessionEvent[]; hasMore: boolean } {
    if (limit === 0) return { events: [], hasMore: false };
    if (limit === undefined) return { events: mergeSessionEvents([...this.eventsAfter(id, 0)]), hasMore: false };
    const events: SessionEvent[] = [];
    const pushed = new Set<number>();
    let rounds = 0;
    let hasMore = false;
    for (const record of records<SessionRecord>(this.files.get(id)!, true)) {
      if (record.type === 'im_pushed') { pushed.add(record.eventId); continue; }
      if (record.type === 'session' || record.type === 'session_update') continue;
      const event = sessionEvent(record);
      if (event.type === 'raw_stdout' || event.type === 'raw_stderr') continue;
      if (before !== undefined && event.id >= before) continue;
      if (rounds === limit) { hasMore = true; break; }
      events.push(pushed.has(event.id) ? { ...event, pushedToIm: true } : event);
      if (event.type === 'message') rounds++;
    }
    return { events: mergeSessionEvents(events.reverse()), hasMore };
  }

  getEvent(id: string, eventId: number): SessionEvent | undefined {
    const file = this.files.get(id);
    if (!file) return undefined;
    let pushed = false;
    for (const record of records<SessionRecord>(file, true)) {
      if (record.type === 'im_pushed') { if (record.eventId === eventId) pushed = true; continue; }
      if (record.type !== 'session' && record.type !== 'session_update' && record.id === eventId) {
        const event = sessionEvent(record);
        return pushed ? { ...event, pushedToIm: true } : event;
      }
    }
    return undefined;
  }

  *eventsAfter(id: string, after: number): Generator<SessionEvent> {
    const file = this.files.get(id)!;
    const pushed = new Set<number>();
    for (const record of records<SessionRecord>(file, true)) {
      if (record.type === 'im_pushed') { if (record.eventId > after) pushed.add(record.eventId); continue; }
      if (record.type !== 'session' && record.type !== 'session_update' && record.id <= after) break;
    }
    for (const record of records<SessionRecord>(file)) {
      if (record.type === 'session' || record.type === 'session_update' || record.type === 'im_pushed' || record.type === 'raw_stdout' || record.type === 'raw_stderr') continue;
      if (record.id > after) {
        const event = sessionEvent(record);
        yield pushed.has(event.id) ? { ...event, pushedToIm: true } : event;
      }
    }
  }

  remove(id: string): void {
    this.savePending(id, []);
    const file = this.files.get(id)!;
    unlinkSync(file);
    const rawFile = this.rawFile(file);
    if (existsSync(rawFile)) unlinkSync(rawFile);
    this.files.delete(id);
    this.metadataSnapshots.delete(id);
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
    let metadata: SessionMetadata | undefined;
    for (const record of records<SessionRecord>(file)) {
      if (record.type === 'session') {
        const { type, formatVersion, ...initial } = record;
        metadata = initial;
      } else if (metadata && record.type === 'session_update') {
        applyMetadataChanges(metadata, record.changes);
        metadata.updatedAt = Math.max(metadata.updatedAt, record.timestamp);
      } else if (metadata && record.type !== 'session_update' && record.type !== 'im_pushed') {
        applyEventMetadata(metadata, sessionEvent(record));
      }
    }
    if (!metadata) throw new Error('会话文件缺少会话信息');
    return metadata;
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

  private migrateStorage(file: string): void {
    type MigrationRecord = HistoryRecord | SessionRecord;
    let required = false;
    for (const record of records<MigrationRecord>(file)) {
      if ((record.type === 'session' && (!('formatVersion' in record) || record.formatVersion !== 2))
        || (record.type === 'usage' && 'text' in record)) {
        required = true;
        break;
      }
    }
    if (!required) return;
    const temporary = `${file}.${process.pid}.tmp`;
    const descriptor = openSync(temporary, 'w');
    const write = (record: SessionRecord) => writeSync(descriptor, `${JSON.stringify(record)}\n`);
    let current: SessionMetadata | undefined;
    let pending: SessionMetadata | undefined;
    let latestSnapshot: SessionMetadata | undefined;
    let legacySnapshot = false;
    const flush = (event?: SessionEvent) => {
      if (!pending) return;
      if (!current) {
        write({ type: 'session', formatVersion: 2, ...pending });
      } else {
        const changes = metadataChanges(current, pending);
        if (event?.type === 'status' && event.text === pending.status) delete changes.status;
        if (event?.type === 'usage' && JSON.stringify(JSON.parse(event.text)) === JSON.stringify(pending.usage)) delete changes.usage;
        if (Object.keys(changes).length || pending.updatedAt > Math.max(current.updatedAt, event?.timestamp ?? 0)) write({ type: 'session_update', timestamp: pending.updatedAt, changes });
      }
      current = pending;
      pending = undefined;
    };
    const restoreSnapshot = () => {
      if (!current || !latestSnapshot) return;
      const changes = metadataChanges(current, latestSnapshot);
      if (Object.keys(changes).length) {
        write({ type: 'session_update', timestamp: current.updatedAt, changes });
        applyMetadataChanges(current, changes);
      }
    };
    try {
      for (const record of records<MigrationRecord>(file)) {
        if (record.type === 'session') {
          flush();
          const { type, pid, contextTokens, formatVersion, ...metadata } = record as typeof record & { pid?: number; contextTokens?: number; formatVersion?: number };
          legacySnapshot = formatVersion !== 2;
          if (contextTokens !== undefined) metadata.usage = { inputTokens: 0, outputTokens: 0, ...metadata.usage, contextTokens };
          pending = metadata;
          latestSnapshot = structuredClone(metadata);
        } else if (record.type === 'session_update') {
          flush();
          if (legacySnapshot) restoreSnapshot();
          write(record);
          if (current) {
            applyMetadataChanges(current, record.changes);
            current.updatedAt = Math.max(current.updatedAt, record.timestamp);
            latestSnapshot = structuredClone(current);
            legacySnapshot = false;
          }
        } else if (record.type === 'im_pushed') {
          flush();
          write(record);
        } else {
          const original = record.type === 'usage' && 'usage' in record ? sessionEvent(record) : record as SessionEvent;
          const contextTokens = pending?.usage?.contextTokens ?? current?.usage?.contextTokens;
          const event = original.type === 'usage' && contextTokens !== undefined
            ? { ...original, text: JSON.stringify({ contextTokens, ...JSON.parse(original.text) }) }
            : original;
          flush(event);
          if (legacySnapshot && record.type === 'usage' && 'usage' in record) restoreSnapshot();
          write(storedEvent(event));
          if (event.pushedToIm) write({ type: 'im_pushed', eventId: event.id });
          if (current) {
            applyEventMetadata(current, event);
            if (record.type === 'usage' && 'usage' in record) legacySnapshot = false;
            if (!legacySnapshot) latestSnapshot = structuredClone(current);
          }
        }
      }
      flush();
      if (!current || !latestSnapshot) throw new Error('会话文件缺少会话信息');
      restoreSnapshot();
    } finally { closeSync(descriptor); }
    copyFileSync(file, `${file}.${Date.now()}.bak`);
    renameSync(temporary, file);
  }

  private importSession(session: SessionMetadata, events: Iterable<SessionEvent>): void {
    const file = this.sessionFile(session);
    try {
      this.migrateRecords(file);
      this.migrateStorage(file);
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
      writeSync(descriptor, `${JSON.stringify({ type: 'session', ...session })}\n`);
    } finally { closeSync(descriptor); }
    renameSync(temporary, file);
    this.migrateStorage(file);
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
