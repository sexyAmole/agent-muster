import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { Client, Domain, EventDispatcher, LoggerLevel, WSClient, registerApp, type EventHandles } from '@larksuiteoapi/node-sdk';
import QRCode from 'qrcode';
import { moveLegacyPath } from '../storage.js';
import type { ConversationSettings } from '../commands.js';
import type { AgentImage } from '../../types.js';

const rootDirectory = join(homedir(), '.agent-muster');
const directory = join(rootDirectory, 'im', 'feishu');
const dataFile = join(directory, 'apps.json');
const imageDirectory = join(directory, 'images');
type Application = {
  id: string; clientId: string; clientSecret: string; name: string | null; icon: string | null;
  project: string | null; agent: string | null; conversations: Record<string, string>; conversationSettings?: Record<string, ConversationSettings>;
};
type PollResult = { status: 'WAITING' | 'SUCCESS' | 'FAIL' | 'EXPIRED'; appId?: string; reason?: string };
type Registration = { controller: AbortController; expiresAt?: number; result: PollResult };
type MessageEvent = Parameters<NonNullable<EventHandles['im.message.receive_v1']>>[0];
export type FeishuMessage = { appId: string; message: MessageEvent };

export class FeishuRegistry extends EventEmitter<{ message: [FeishuMessage] }> {
  private apps: Application[] = [];
  private clients = new Map<string, { api: Client; ws: WSClient }>();
  private registrations = new Map<string, Registration>();
  private writeQueue = Promise.resolve();

  async load(): Promise<void> {
    await moveLegacyPath(join(rootDirectory, 'feishu-apps.json'), dataFile);
    try { this.apps = JSON.parse(await readFile(dataFile, 'utf8')) as Application[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  list() {
    return this.apps.map(({ clientSecret, conversations, conversationSettings, ...app }) => ({
      ...app, connectionStatus: this.clients.get(app.id)?.ws.getConnectionStatus().state,
    }));
  }

  getBinding(id: string, conversation?: string) {
    const app = this.apps.find(item => item.id === id);
    return app ? { project: app.project, agent: app.agent, ...(conversation ? app.conversationSettings?.[conversation] : undefined) } : undefined;
  }

  getSession(id: string, chatId: string) {
    return this.apps.find(item => item.id === id)?.conversations[chatId];
  }

  async configureConversation(id: string, conversation: string, settings: ConversationSettings, newSession = false): Promise<void> {
    const app = this.apps.find(item => item.id === id);
    if (!app) throw new Error('应用不存在');
    app.conversationSettings ||= {};
    app.conversationSettings[conversation] = { ...app.conversationSettings[conversation], ...settings };
    if (newSession) delete app.conversations[conversation];
    await this.persist();
  }

  sessionBindings() {
    return this.apps.flatMap(app => Object.values(app.conversations).map(sessionId => ({ sessionId, appId: app.id })));
  }

  async setSession(id: string, chatId: string, sessionId: string): Promise<void> {
    this.getApp(id).conversations[chatId] = sessionId;
    await this.persist();
  }

  async start() {
    const id = randomUUID();
    const registration: Registration = { controller: new AbortController(), result: { status: 'WAITING' } };
    this.registrations.set(id, registration);
    return new Promise<{ id: string; verificationUrl: string; qrCode: string; expiresAt: number; interval: number }>((resolve, reject) => {
      void registerApp({
        source: 'agent-muster', createOnly: true, signal: registration.controller.signal,
        appPreset: { name: 'Agent Muster', desc: '通过飞书与本地编码 Agent 对话' },
        addons: {
          scopes: { tenant: ['im:message:send_as_bot', 'im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly', 'im:message:readonly'] },
          events: { items: { tenant: ['im.message.receive_v1'] } },
        },
        onQRCodeReady: ({ url, expireIn }) => {
          registration.expiresAt = Date.now() + expireIn * 1000;
          void QRCode.toString(url, { type: 'svg', margin: 1, width: 220 }).then(svg => {
            resolve({ id, verificationUrl: url, qrCode: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, expiresAt: registration.expiresAt!, interval: 2 });
          }).catch(error => { registration.controller.abort(); reject(error); });
        },
      }).then(async result => {
        if (result.user_info?.tenant_brand === 'lark') throw new Error('请使用飞书账号创建应用');
        const app: Application = {
          id: randomUUID(), clientId: result.client_id, clientSecret: result.client_secret,
          name: 'Agent Muster', icon: null, project: null, agent: null, conversations: {},
        };
        this.apps.push(app);
        try { await this.persist(); }
        catch (error) { this.apps = this.apps.filter(item => item.id !== app.id); throw error; }
        this.subscribe(app);
        registration.result = { status: 'SUCCESS', appId: app.id };
      }).catch((error: Error & { code?: string; description?: string }) => {
        registration.result = { status: error.code === 'expired_token' ? 'EXPIRED' : 'FAIL', reason: error.description || error.message };
        if (!registration.expiresAt) this.registrations.delete(id);
        reject(error);
      });
    });
  }

  poll(id: string): PollResult {
    const registration = this.registrations.get(id);
    if (!registration) throw new Error('扫码会话不存在');
    if (registration.result.status === 'WAITING' && registration.expiresAt && Date.now() >= registration.expiresAt) {
      registration.result = { status: 'EXPIRED' };
      registration.controller.abort();
    }
    return registration.result;
  }

  async cancelRegistration(id: string): Promise<void> {
    const registration = this.registrations.get(id);
    if (!registration) return;
    registration.controller.abort();
    this.registrations.delete(id);
  }

  startSubscriptions(): void { for (const app of this.apps) this.subscribe(app); }

  shutdown(): void {
    for (const registration of this.registrations.values()) registration.controller.abort();
    for (const client of this.clients.values()) client.ws.close({ force: true });
    this.clients.clear();
  }

  private subscribe(app: Application): void {
    if (this.clients.has(app.id)) return;
    const config = { appId: app.clientId, appSecret: app.clientSecret, domain: Domain.Feishu, loggerLevel: LoggerLevel.warn };
    const api = new Client(config);
    const ws = new WSClient(config);
    const eventDispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': data => { this.emit('message', { appId: app.id, message: data }); },
    });
    this.clients.set(app.id, { api, ws });
    void ws.start({ eventDispatcher }).catch(error => console.error(`飞书应用 ${app.clientId} 消息监听失败：`, error));
  }

  async downloadImage(id: string, messageId: string, imageKey: string): Promise<AgentImage> {
    if (!messageId || !imageKey) throw new Error('飞书图片消息缺少消息 ID 或图片标识');
    const client = this.clients.get(id);
    if (!client) throw new Error('飞书应用消息监听未启动');
    let data: Buffer;
    try {
      const result = await client.api.im.messageResource.get({
        path: { message_id: messageId, file_key: imageKey }, params: { type: 'image' },
      });
      data = await buffer(result.getReadableStream());
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status;
      throw new Error(`飞书图片下载失败${status ? `（HTTP ${status}）` : ''}，请确认应用已开通 im:message:readonly 权限并发布，且机器人在消息所在的会话中。`);
    }
    if (!data.length) throw new Error('飞书返回了空图片');
    // 资源接口可能返回通用二进制类型，依据图片文件头识别格式。
    let mimeType: string;
    let extension: string;
    if (data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') { mimeType = 'image/png'; extension = 'png'; }
    else if (data.subarray(0, 3).toString('hex') === 'ffd8ff') { mimeType = 'image/jpeg'; extension = 'jpg'; }
    else if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) { mimeType = 'image/gif'; extension = 'gif'; }
    else if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') { mimeType = 'image/webp'; extension = 'webp'; }
    else throw new Error('飞书返回了不支持的图片格式，请发送 PNG、JPEG、GIF 或 WebP 图片。');
    await mkdir(imageDirectory, { recursive: true, mode: 0o700 });
    const path = join(imageDirectory, `${randomUUID()}.${extension}`);
    await writeFile(path, data, { mode: 0o600 });
    return { type: 'image', mimeType, data: data.toString('base64'), path };
  }

  async send(id: string, chatId: string, content: string, format: 'text' | 'markdown' = 'text'): Promise<void> {
    const client = this.clients.get(id);
    if (!client) throw new Error('飞书应用消息监听未启动');
    // 按 UTF-8 字节分段，避免超过飞书消息大小限制。
    let chunk = '';
    let size = 0;
    const chunks: string[] = [];
    for (const character of content) {
      const bytes = Buffer.byteLength(character);
      if (size + bytes > 20000) { chunks.push(chunk); chunk = ''; size = 0; }
      chunk += character; size += bytes;
    }
    if (chunk) chunks.push(chunk);
    for (const text of chunks) {
      const result = await client.api.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId, msg_type: format === 'markdown' ? 'interactive' : 'text',
          content: JSON.stringify(format === 'markdown'
            ? { schema: '2.0', body: { elements: [{ tag: 'markdown', content: text }] } }
            : { text }),
        },
      });
      if (result.code !== 0) throw new Error(`飞书消息发送失败：${result.msg} (${result.code})`);
    }
  }

  async sendToSession(id: string, sessionId: string, content: string): Promise<void> {
    const chatId = Object.entries(this.getApp(id).conversations).find(([, value]) => value === sessionId)?.[0];
    if (!chatId) throw new Error('此对话尚无飞书发送目标');
    await this.send(id, chatId, content, 'markdown');
  }

  async bind(id: string, binding: { project?: string | null; agent?: string | null }, projects: string[], agents: string[]) {
    if (binding.project !== undefined && binding.project !== null && !projects.includes(binding.project)) throw new Error('项目不存在');
    if (binding.agent !== undefined && binding.agent !== null && !agents.includes(binding.agent)) throw new Error('Agent 不可用');
    const app = this.getApp(id);
    if ((binding.project !== undefined && binding.project !== app.project) || (binding.agent !== undefined && binding.agent !== app.agent)) { app.conversations = {}; app.conversationSettings = {}; }
    if (binding.project !== undefined) app.project = binding.project;
    if (binding.agent !== undefined) app.agent = binding.agent;
    await this.persist();
    return this.list().find(item => item.id === id)!;
  }

  async syncMetadata(id: string) {
    const app = this.getApp(id);
    const client = this.clients.get(id);
    if (!client) throw new Error('飞书应用消息监听未启动');
    const result = await client.api.request<{ code: number; msg: string; bot?: { app_name: string; avatar_url: string } }>({ url: '/open-apis/bot/v3/info', method: 'GET' });
    if (result.code !== 0 || !result.bot) throw new Error(`飞书应用信息获取失败：${result.msg}`);
    app.name = result.bot.app_name;
    app.icon = result.bot.avatar_url;
    await this.persist();
    return this.list().find(item => item.id === id)!;
  }

  async remove(id: string): Promise<void> {
    this.getApp(id);
    this.clients.get(id)?.ws.close({ force: true });
    this.clients.delete(id);
    this.apps = this.apps.filter(item => item.id !== id);
    await this.persist();
  }

  async unbindSession(sessionId: string): Promise<void> {
    let changed = false;
    for (const app of this.apps) {
      for (const [chatId, id] of Object.entries(app.conversations)) {
        if (id !== sessionId) continue;
        delete app.conversations[chatId];
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  async unbindProject(project: string): Promise<void> {
    for (const app of this.apps) {
      for (const [conversation, settings] of Object.entries(app.conversationSettings || {})) {
        if (settings.project !== project) continue;
        delete settings.project;
        delete app.conversations[conversation];
      }
    }
    const apps = this.apps.filter(app => app.project === project);
    for (const app of apps) { app.project = null; app.conversations = {}; app.conversationSettings = {}; }
    await this.persist();
  }

  private getApp(id: string): Application {
    const app = this.apps.find(item => item.id === id);
    if (!app) throw new Error('飞书应用不存在');
    return app;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.apps);
    const write = this.writeQueue.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(`${dataFile}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${dataFile}.tmp`, dataFile);
    });
    this.writeQueue = write.catch(() => {});
    return write;
  }
}
