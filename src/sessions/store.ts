import { closeSync, copyFileSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeSync, writeFileSync, appendFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentImage, AgentSession, SessionEvent } from '../types.js';
import { projectDirectory } from '../projects/storage.js';

type SessionMetadata = Omit<AgentSession, 'events'>;
type HistoryRecord = ({ type: 'session' } & SessionMetadata) | SessionEvent | { type: 'im_pushed'; eventId: number };
type LegacyRecord = { session: SessionMetadata; event?: SessionEvent; pushedEventId?: number };

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
      for (const name of readdirSync(projectPath).filter(file => file.endsWith('.jsonl'))) {
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
      for (const name of readdirSync(directory).filter(file => file.endsWith('.jsonl'))) {
        const file = join(directory, name);
        this.migrateRecords(file);
        const metadata = this.metadata(file);
        this.files.set(metadata.id, file);
        this.metadataKeys.set(metadata.id, metadataKey(metadata));
        sessions.push({ ...metadata, events: this.history(metadata.id, 10).events });
      }
    }
    return sessions;
  }

  save(session: AgentSession, event?: SessionEvent, update = false): void {
    const { events, ...metadata } = session;
    const file = this.files.get(session.id) || this.sessionFile(metadata);
    if (!this.files.has(session.id)) mkdirSync(dirname(file), { recursive: true });
    const key = metadataKey(metadata);
    const entries: HistoryRecord[] = [];
    if (this.metadataKeys.get(session.id) !== key) entries.push({ type: 'session', ...metadata });
    if (event) entries.push(update ? { type: 'im_pushed', eventId: event.id } : event);
    if (entries.length) appendFileSync(file, entries.map(record => `${JSON.stringify(record)}\n`).join(''));
    this.files.set(session.id, file);
    this.metadataKeys.set(session.id, key);
  }

  history(id: string, limit?: number, before?: number): { events: SessionEvent[]; hasMore: boolean } {
    if (limit === 0) return { events: [], hasMore: false };
    if (limit === undefined) return { events: [...this.eventsAfter(id, 0)], hasMore: false };
    const events: SessionEvent[] = [];
    const pushed = new Set<number>();
    let rounds = 0;
    for (const record of records(this.files.get(id)!, true)) {
      if (record.type === 'im_pushed') { pushed.add(record.eventId); continue; }
      if (record.type === 'session') continue;
      const event = record;
      if (before !== undefined && event.id >= before) continue;
      if (rounds === limit) return { events: events.reverse(), hasMore: true };
      events.push(pushed.has(event.id) ? { ...event, pushedToIm: true } : event);
      if (event.type === 'message') rounds++;
    }
    return { events: events.reverse(), hasMore: false };
  }

  getEvent(id: string, eventId: number): SessionEvent | undefined {
    const file = this.files.get(id);
    if (!file) return undefined;
    let pushed = false;
    for (const record of records(file, true)) {
      if (record.type === 'im_pushed') { if (record.eventId === eventId) pushed = true; continue; }
      if (record.type !== 'session' && record.id === eventId) return pushed ? { ...record, pushedToIm: true } : record;
    }
    return undefined;
  }

  *eventsAfter(id: string, after: number): Generator<SessionEvent> {
    const file = this.files.get(id)!;
    const pushed = new Set<number>();
    for (const record of records(file, true)) {
      if (record.type === 'im_pushed') { if (record.eventId > after) pushed.add(record.eventId); continue; }
      if (record.type !== 'session' && record.id <= after) break;
    }
    for (const record of records(file)) {
      if (record.type === 'session' || record.type === 'im_pushed') continue;
      if (record.id > after) yield pushed.has(record.id) ? { ...record, pushedToIm: true } : record;
    }
  }

  remove(id: string): void {
    unlinkSync(this.files.get(id)!);
    this.files.delete(id);
    this.metadataKeys.delete(id);
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
    for (const record of records<HistoryRecord | LegacyRecord>(file)) {
      if ('type' in record) return;
      break;
    }
    const temporary = `${file}.${process.pid}.tmp`;
    const descriptor = openSync(temporary, 'w');
    let previousKey: string | undefined;
    try {
      for (const record of records<LegacyRecord>(file)) {
        const key = metadataKey(record.session);
        if (key !== previousKey) writeSync(descriptor, `${JSON.stringify({ type: 'session', ...record.session })}\n`);
        if (record.event) writeSync(descriptor, `${JSON.stringify(record.event)}\n`);
        if (record.pushedEventId !== undefined) writeSync(descriptor, `${JSON.stringify({ type: 'im_pushed', eventId: record.pushedEventId })}\n`);
        previousKey = key;
      }
    } finally { closeSync(descriptor); }
    copyFileSync(file, `${file}.bak`);
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
