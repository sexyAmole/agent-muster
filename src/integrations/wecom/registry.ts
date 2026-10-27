import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WSClient, type TextMessage, type ImageMessage, type MixedMessage, type VoiceMessage, type ImageContent, type WsFrame } from '@wecom/aibot-node-sdk';
import QRCode from 'qrcode';
import type { ConversationSettings } from '../commands.js';
import type { AgentImage } from '../../types.js';
import { validatePermissionMode } from '../../agents/settings.js';
import { StreamReply, splitStreamContent } from '../stream-reply.js';

const rootDirectory = join(homedir(), '.agent-muster');
const directory = join(rootDirectory, 'im', 'wecom');
const dataFile = join(directory, 'apps.json');
const imageDirectory = join(directory, 'images');
type Application = {
  id: string; clientId: string; clientSecret: string; name: string | null; icon: string | null;
  project: string | null; agent: string | null; model?: string; permissionMode?: string; createdAt?: number; conversations: Record<string, string>; conversationSettings?: Record<string, ConversationSettings>;
};
type PollResult = { status: 'WAITING' | 'SUCCESS' | 'FAIL' | 'EXPIRED'; appId?: string; reason?: string };
type Registration = { scode: string; expiresAt: number; result: PollResult; pending?: Promise<PollResult> };
type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'failed';
export type WecomMessage = { appId: string; frame: WsFrame<TextMessage | ImageMessage | MixedMessage | VoiceMessage> };

// 扫码协议参照企业微信官方 wecom-cli 的 auth/qrcode.rs。
const qrSource = 'wecom_cli_external';
async function qrRequest<T>(path: string, params: Record<string, string>): Promise<T> {
  const response = await fetch(`https://work.weixin.qq.com/ai/qc/${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`企业微信扫码请求失败（${response.status}），请重试`);
  const result = await response.json() as { errcode?: number; errmsg?: string; data?: T };
  if (result.errcode || !result.data) throw new Error(result.errmsg || '企业微信未返回有效的扫码数据，请重试');
  return result.data;
}

export class WecomRegistry extends EventEmitter<{ message: [WecomMessage] }> {
  private apps: Application[] = [];
  private clients = new Map<string, { ws: WSClient; status: ConnectionStatus }>();
  private registrations = new Map<string, Registration>();
  private writeQueue = Promise.resolve();

  async load(): Promise<void> {
    try {
      this.apps = JSON.parse(await readFile(dataFile, 'utf8')) as Application[];
      let needsPersist = false;
      for (const app of this.apps) {
        if (!app.createdAt) { app.createdAt = Date.now(); needsPersist = true; }
      }
      if (needsPersist) await this.persist();
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  list() {
    return this.apps.map(({ clientSecret, conversations, conversationSettings, ...app }) => ({
      ...app, connectionStatus: this.clients.get(app.id)?.status || 'idle',
    }));
  }

  getBinding(id: string, conversation?: string) {
    const app = this.apps.find(item => item.id === id);
    return app ? { project: app.project, agent: app.agent, model: app.model, permissionMode: app.permissionMode, ...(conversation ? app.conversationSettings?.[conversation] : undefined) } : undefined;
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
    for (const [id, registration] of this.registrations) {
      if (Date.now() >= registration.expiresAt) this.registrations.delete(id);
    }
    const data = await qrRequest<{ scode: string; auth_url: string }>('generate', {
      source: qrSource, plat: String(process.platform === 'darwin' ? 1 : process.platform === 'win32' ? 2 : process.platform === 'linux' ? 3 : 0),
    });
    if (!data.scode || !data.auth_url) throw new Error('企业微信未返回有效的二维码，请重试');
    const url = new URL(data.auth_url);
    if (url.protocol !== 'https:' || url.hostname !== 'work.weixin.qq.com') throw new Error('企业微信返回了无效的授权地址');
    const id = randomUUID();
    const expiresAt = Date.now() + 300000;
    const svg = await QRCode.toString(data.auth_url, { type: 'svg', margin: 1, width: 220 });
    this.registrations.set(id, { scode: data.scode, expiresAt, result: { status: 'WAITING' } });
    return {
      id, verificationUrl: `https://work.weixin.qq.com/ai/qc/gen?${new URLSearchParams({ source: qrSource, scode: data.scode })}`,
      qrCode: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, expiresAt, interval: 3,
    };
  }

  async poll(id: string): Promise<PollResult> {
    const registration = this.registrations.get(id);
    if (!registration) throw new Error('扫码会话不存在');
    if (registration.result.status !== 'WAITING') return registration.result;
    if (Date.now() >= registration.expiresAt) return registration.result = { status: 'EXPIRED' };
    if (registration.pending) return registration.pending;
    registration.pending = this.completeRegistration(id, registration).finally(() => { delete registration.pending; });
    return registration.pending;
  }

  private async completeRegistration(id: string, registration: Registration): Promise<PollResult> {
    const data = await qrRequest<{ status: string; bot_info?: { botid: string; secret: string } }>('query_result', { scode: registration.scode });
    if (!this.registrations.has(id) || Date.now() >= registration.expiresAt) return { status: 'EXPIRED' };
    if (data.status === 'success') {
      if (!data.bot_info?.botid || !data.bot_info.secret) throw new Error('企业微信未返回机器人凭证，请重新扫码');
      const app: Application = {
        id: randomUUID(), clientId: data.bot_info.botid, clientSecret: data.bot_info.secret,
        name: null, icon: null, project: null, agent: null, createdAt: Date.now(), conversations: {},
      };
      if (this.apps.some(item => item.clientId === app.clientId)) return registration.result = { status: 'FAIL', reason: '此机器人已接入' };
      this.apps.push(app);
      try { await this.persist(); }
      catch (error) { this.apps = this.apps.filter(item => item.id !== app.id); throw error; }
      this.subscribe(app);
      registration.result = { status: 'SUCCESS', appId: app.id };
    } else if (data.status === 'expired') registration.result = { status: 'EXPIRED' };
    else if (data.status === 'fail' || data.status === 'cancel') registration.result = { status: 'FAIL', reason: '企业微信授权未完成，请重新扫码' };
    return registration.result;
  }

  async cancelRegistration(id: string): Promise<void> { this.registrations.delete(id); }

  startSubscriptions(): void { for (const app of this.apps) this.subscribe(app); }

  shutdown(): void {
    this.registrations.clear();
    for (const client of this.clients.values()) client.ws.disconnect();
    this.clients.clear();
  }

  private subscribe(app: Application): void {
    if (this.clients.has(app.id)) return;
    const ws = new WSClient({
      botId: app.clientId, secret: app.clientSecret,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const client = { ws, status: 'connecting' as ConnectionStatus };
    this.clients.set(app.id, client);
    ws.on('authenticated', () => { client.status = 'connected'; });
    ws.on('disconnected', () => { client.status = 'reconnecting'; });
    ws.on('reconnecting', () => { client.status = 'reconnecting'; });
    ws.on('error', () => { client.status = 'failed'; });
    ws.on('event.disconnected_event', () => { client.status = 'failed'; });
    for (const event of ['message.text', 'message.image', 'message.mixed', 'message.voice'] as const) {
      ws.on(event, frame => { this.emit('message', { appId: app.id, frame }); });
    }
    ws.connect();
  }

  async downloadImage(id: string, image: ImageContent): Promise<AgentImage> {
    const client = this.clients.get(id);
    if (!client) throw new Error('企业微信应用消息监听未启动');
    if (!image.aeskey) throw new Error('企业微信图片缺少解密密钥');
    const { buffer: data } = await client.ws.downloadFile(image.url, image.aeskey);
    if (!data.length) throw new Error('企业微信返回了空图片');
    // 资源接口可能返回通用二进制类型，依据图片文件头识别格式。
    let mimeType: string;
    let extension: string;
    if (data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') { mimeType = 'image/png'; extension = 'png'; }
    else if (data.subarray(0, 3).toString('hex') === 'ffd8ff') { mimeType = 'image/jpeg'; extension = 'jpg'; }
    else if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) { mimeType = 'image/gif'; extension = 'gif'; }
    else if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') { mimeType = 'image/webp'; extension = 'webp'; }
    else throw new Error('企业微信返回了不支持的图片格式，请发送 PNG、JPEG、GIF 或 WebP 图片。');
    await mkdir(imageDirectory, { recursive: true, mode: 0o700 });
    const path = join(imageDirectory, `${randomUUID()}.${extension}`);
    await writeFile(path, data, { mode: 0o600 });
    return { type: 'image', mimeType, data: data.toString('base64'), path };
  }

  async startReply(id: string, chatId: string, frame: WecomMessage['frame']): Promise<StreamReply> {
    const client = this.clients.get(id);
    if (!client) throw new Error('企业微信应用消息监听未启动');
    const streamId = randomUUID();
    const write = async (content: string, finish: boolean) => {
      const [text, remaining] = splitStreamContent(content);
      await client.ws.replyStream(frame, streamId, text, finish);
      if (finish && remaining) await this.send(id, chatId, remaining);
    };
    await write('正在处理中…', false);
    return new StreamReply(write);
  }

  async send(id: string, chatId: string, content: string): Promise<void> {
    const client = this.clients.get(id);
    if (!client) throw new Error('企业微信应用消息监听未启动');
    let chunk = '';
    let size = 0;
    for (const character of content) {
      const bytes = Buffer.byteLength(character);
      if (size + bytes > 4000) {
        await client.ws.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: chunk } });
        chunk = ''; size = 0;
      }
      chunk += character; size += bytes;
    }
    if (chunk) await client.ws.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: chunk } });
  }

  async sendToSession(id: string, sessionId: string, content: string): Promise<void> {
    const chatId = Object.entries(this.getApp(id).conversations).find(([, value]) => value === sessionId)?.[0];
    if (!chatId) throw new Error('此对话尚无企业微信发送目标');
    await this.send(id, chatId, content);
  }

  async bind(id: string, binding: { project?: string | null; agent?: string | null; model?: string; permissionMode?: string }, projects: string[], agents: string[]) {
    if (binding.project !== undefined && binding.project !== null && !projects.includes(binding.project)) throw new Error('项目不存在');
    if (binding.agent !== undefined && binding.agent !== null && !agents.includes(binding.agent)) throw new Error('Agent 不可用');
    const app = this.getApp(id);
    if (binding.permissionMode !== undefined) {
      const agent = binding.agent !== undefined ? binding.agent : app.agent;
      if (!agent) throw new Error('请先选择 Agent');
      validatePermissionMode(agent, binding.permissionMode);
    }
    if ((binding.project !== undefined && binding.project !== app.project) || (binding.agent !== undefined && binding.agent !== app.agent)) { app.conversations = {}; app.conversationSettings = {}; }
    if (binding.project !== undefined) app.project = binding.project;
    if (binding.agent !== undefined) {
      if (binding.agent !== app.agent) { delete app.permissionMode; delete app.model; }
      app.agent = binding.agent;
    }
    if (binding.model !== undefined) app.model = binding.model;
    if (binding.permissionMode !== undefined) app.permissionMode = binding.permissionMode;
    await this.persist();
    return this.list().find(item => item.id === id)!;
  }

  async remove(id: string): Promise<void> {
    this.getApp(id);
    this.clients.get(id)?.ws.disconnect();
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
    if (!app) throw new Error('企业微信应用不存在');
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
