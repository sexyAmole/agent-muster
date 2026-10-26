import { createDecipheriv, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import type { ConversationSettings } from '../commands.js';
import type { AgentImage } from '../../types.js';
import { validatePermissionMode } from '../../agents/settings.js';
import { apiBase, validateApiBase, weixinRequest, WeixinAuthError, type QrStatus, type WeixinMessage, type WeixinImage } from './api.js';

const directory = join(homedir(), '.agent-muster', 'im', 'weixin');
const dataFile = join(directory, 'apps.json');
const imageDirectory = join(directory, 'images');
type Application = {
  id: string; clientId: string; botToken: string; baseUrl: string; userId: string;
  name: string | null; icon: string | null; project: string | null; agent: string | null; model?: string; permissionMode?: string; createdAt: number;
  conversations: Record<string, string>; conversationSettings?: Record<string, ConversationSettings>;
  contextTokens: Record<string, string>; updatesCursor: string;
};
type PollResult = { status: 'WAITING' | 'VERIFY' | 'SUCCESS' | 'FAIL' | 'EXPIRED'; appId?: string; reason?: string };
type Registration = { qrcode: string; baseUrl: string; expiresAt: number; result: PollResult; controller: AbortController; pending?: Promise<PollResult> };
type Client = { controller: AbortController; status: 'connecting' | 'connected' | 'reconnecting' | 'failed'; error?: string };
export type WeixinEvent = { appId: string; message: WeixinMessage };

export class WeixinRegistry extends EventEmitter<{ message: [WeixinEvent] }> {
  private apps: Application[] = [];
  private clients = new Map<string, Client>();
  private registrations = new Map<string, Registration>();
  private writeQueue = Promise.resolve();

  async load(): Promise<void> {
    try { this.apps = JSON.parse(await readFile(dataFile, 'utf8')) as Application[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  list() {
    return this.apps.map(app => ({
      id: app.id, clientId: app.clientId, name: app.name, icon: app.icon, project: app.project, agent: app.agent, model: app.model,
      permissionMode: app.permissionMode, createdAt: app.createdAt,
      connectionStatus: this.clients.get(app.id)?.status || 'idle', connectionError: this.clients.get(app.id)?.error,
    }));
  }

  getBinding(id: string, conversation?: string) {
    const app = this.apps.find(item => item.id === id);
    return app ? { project: app.project, agent: app.agent, model: app.model, permissionMode: app.permissionMode, ...(conversation ? app.conversationSettings?.[conversation] : undefined) } : undefined;
  }

  getSession(id: string, chatId: string) { return this.apps.find(item => item.id === id)?.conversations[chatId]; }

  async configureConversation(id: string, conversation: string, settings: ConversationSettings, newSession = false): Promise<void> {
    const app = this.getApp(id);
    app.conversationSettings ||= {};
    app.conversationSettings[conversation] = { ...app.conversationSettings[conversation], ...settings };
    if (newSession) delete app.conversations[conversation];
    await this.persist();
  }

  sessionBindings() { return this.apps.flatMap(app => Object.values(app.conversations).map(sessionId => ({ sessionId, appId: app.id }))); }

  async setSession(id: string, chatId: string, sessionId: string): Promise<void> {
    this.getApp(id).conversations[chatId] = sessionId;
    await this.persist();
  }

  async start() {
    for (const [id, registration] of this.registrations) if (Date.now() >= registration.expiresAt) await this.cancelRegistration(id);
    const data = await weixinRequest<{ qrcode: string; qrcode_img_content: string }>(apiBase, 'get_bot_qrcode?bot_type=3', { body: { local_token_list: this.apps.slice(-10).map(app => app.botToken) } });
    if (!data.qrcode || !data.qrcode_img_content) throw new Error('微信未返回有效的二维码，请重试');
    const id = randomUUID();
    const expiresAt = Date.now() + 300000;
    const svg = await QRCode.toString(data.qrcode_img_content, { type: 'svg', margin: 1, width: 220 });
    this.registrations.set(id, { qrcode: data.qrcode, baseUrl: apiBase, expiresAt, result: { status: 'WAITING' }, controller: new AbortController() });
    return { id, qrCode: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, expiresAt, interval: 3 };
  }

  async poll(id: string, verifyCode?: string): Promise<PollResult> {
    const registration = this.registrations.get(id);
    if (!registration) throw new Error('扫码会话不存在');
    if (registration.result.status !== 'WAITING' && registration.result.status !== 'VERIFY') return registration.result;
    if (Date.now() >= registration.expiresAt) return registration.result = { status: 'EXPIRED' };
    if (registration.result.status === 'VERIFY' && !verifyCode) return registration.result;
    if (registration.pending) return registration.pending;
    registration.pending = this.completeRegistration(id, registration, verifyCode).finally(() => { delete registration.pending; });
    return registration.pending;
  }

  private async completeRegistration(id: string, registration: Registration, verifyCode?: string): Promise<PollResult> {
    const params = new URLSearchParams({ qrcode: registration.qrcode });
    if (verifyCode) params.set('verify_code', verifyCode);
    let data: QrStatus;
    try {
      data = await weixinRequest<QrStatus>(registration.baseUrl, `get_qrcode_status?${params}`, { signal: registration.controller.signal, timeout: 40000 });
    } catch (error) {
      if ((error as Error).name === 'TimeoutError') return registration.result;
      throw error;
    }
    if (!this.registrations.has(id) || Date.now() >= registration.expiresAt) return { status: 'EXPIRED' };
    switch (data.status) {
      case 'confirmed': {
        if (!data.bot_token || !data.ilink_bot_id || !data.baseurl || !data.ilink_user_id) throw new Error('微信未返回完整的登录信息，请重新扫码');
        const baseUrl = validateApiBase(data.baseurl);
        const existing = this.apps.find(app => app.clientId === data.ilink_bot_id);
        const app: Application = existing ? { ...existing, botToken: data.bot_token, baseUrl, userId: data.ilink_user_id, contextTokens: {}, updatesCursor: '' } : {
          id: randomUUID(), clientId: data.ilink_bot_id, botToken: data.bot_token, baseUrl, userId: data.ilink_user_id,
          name: null, icon: null, project: null, agent: null, createdAt: Date.now(), conversations: {}, contextTokens: {}, updatesCursor: '',
        };
        if (existing) this.apps = this.apps.map(item => item === existing ? app : item);
        else this.apps.push(app);
        try { await this.persist(); }
        catch (error) { this.apps = this.apps.filter(item => item !== app); if (existing) this.apps.push(existing); throw error; }
        this.clients.get(app.id)?.controller.abort();
        this.clients.delete(app.id);
        this.subscribe(app);
        return registration.result = { status: 'SUCCESS', appId: app.id };
      }
      case 'scaned_but_redirect':
        if (!data.redirect_host) throw new Error('微信未返回扫码跳转地址');
        registration.baseUrl = validateApiBase(`https://${data.redirect_host}`);
        return registration.result = { status: 'WAITING' };
      case 'need_verifycode': return registration.result = { status: 'VERIFY' };
      case 'expired': return registration.result = { status: 'EXPIRED' };
      case 'verify_code_blocked': return registration.result = { status: 'FAIL', reason: '验证码尝试次数过多，请重新扫码' };
      case 'binded_redirect': return registration.result = { status: 'FAIL', reason: '此微信 Bot 已连接，请关闭窗口查看已有接入' };
      case 'wait':
      case 'scaned': return registration.result = { status: 'WAITING' };
      default: throw new Error('微信返回了未知的扫码状态，请重试');
    }
  }

  async cancelRegistration(id: string): Promise<void> {
    this.registrations.get(id)?.controller.abort();
    this.registrations.delete(id);
  }

  startSubscriptions(): void { for (const app of this.apps) this.subscribe(app); }

  shutdown(): void {
    for (const registration of this.registrations.values()) registration.controller.abort();
    this.registrations.clear();
    for (const client of this.clients.values()) client.controller.abort();
    this.clients.clear();
  }

  private subscribe(app: Application): void {
    if (this.clients.has(app.id)) return;
    const client: Client = { controller: new AbortController(), status: 'connecting' };
    this.clients.set(app.id, client);
    void this.monitor(app, client);
  }

  private async monitor(app: Application, client: Client): Promise<void> {
    let failures = 0;
    let timeout = 40000;
    while (!client.controller.signal.aborted) {
      try {
        const data = await weixinRequest<{ msgs?: WeixinMessage[]; get_updates_buf?: string; longpolling_timeout_ms?: number }>(app.baseUrl, 'getupdates', {
          body: { get_updates_buf: app.updatesCursor }, token: app.botToken, signal: client.controller.signal, timeout,
        });
        if (client.controller.signal.aborted) return;
        client.status = 'connected'; delete client.error; failures = 0;
        if (data.longpolling_timeout_ms) timeout = Math.max(10000, Math.min(data.longpolling_timeout_ms + 5000, 65000));
        const messages = (data.msgs || []).filter(message => message.message_type === 1 && !message.group_id && message.from_user_id === app.userId && message.context_token && typeof message.message_id === 'number');
        for (const message of messages) app.contextTokens[message.from_user_id!] = message.context_token!;
        if (data.get_updates_buf) app.updatesCursor = data.get_updates_buf;
        if (messages.length || data.get_updates_buf) await this.persist();
        if (client.controller.signal.aborted) return;
        for (const message of messages) this.emit('message', { appId: app.id, message });
      } catch (error) {
        if (client.controller.signal.aborted) return;
        if ((error as Error).name === 'TimeoutError') continue;
        client.error = error instanceof WeixinAuthError ? error.message : '微信连接中断，正在重试';
        if (error instanceof WeixinAuthError) { client.status = 'failed'; return; }
        client.status = 'reconnecting';
        try { await delay(Math.min(1000 * 2 ** Math.min(failures++, 5), 30000), undefined, { signal: client.controller.signal }); }
        catch { return; }
      }
    }
  }

  async downloadImage(image: WeixinImage): Promise<AgentImage> {
    if (!image.media) throw new Error('微信图片缺少媒体信息');
    if (!image.media.full_url && !image.media.encrypt_query_param) throw new Error('微信图片缺少下载地址');
    const url = image.media.full_url ? new URL(image.media.full_url) : new URL(`https://novac2c.cdn.weixin.qq.com/c2c/download?${new URLSearchParams({ encrypted_query_param: image.media.encrypt_query_param! })}`);
    if (url.protocol !== 'https:' || url.hostname !== 'novac2c.cdn.weixin.qq.com' || url.username || url.password || url.port) throw new Error('微信图片地址无效');
    const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok) throw new Error('微信图片下载失败');
    const encrypted = Buffer.from(await response.arrayBuffer());
    const encoded = image.media.aes_key ? Buffer.from(image.media.aes_key, 'base64') : undefined;
    const key = image.aeskey ? Buffer.from(image.aeskey, 'hex') : encoded?.length === 16 ? encoded : encoded ? Buffer.from(encoded.toString(), 'hex') : undefined;
    if (!key || key.length !== 16) throw new Error('微信图片缺少有效的解密密钥');
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    const data = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    let mimeType: string;
    let extension: string;
    if (data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') { mimeType = 'image/png'; extension = 'png'; }
    else if (data.subarray(0, 3).toString('hex') === 'ffd8ff') { mimeType = 'image/jpeg'; extension = 'jpg'; }
    else if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) { mimeType = 'image/gif'; extension = 'gif'; }
    else if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') { mimeType = 'image/webp'; extension = 'webp'; }
    else throw new Error('微信图片格式不受支持，请发送 PNG、JPEG、GIF 或 WebP 图片');
    await mkdir(imageDirectory, { recursive: true, mode: 0o700 });
    const path = join(imageDirectory, `${randomUUID()}.${extension}`);
    await writeFile(path, data, { mode: 0o600 });
    return { type: 'image', mimeType, data: data.toString('base64'), path };
  }

  async send(id: string, chatId: string, content: string, contextToken?: string): Promise<void> {
    const app = this.getApp(id);
    const token = contextToken ?? app.contextTokens[chatId];
    if (!token) throw new Error('请先从微信发送消息后再回复');
    const characters = Array.from(content);
    for (let offset = 0; offset < characters.length; offset += 2000) {
      const chunk = characters.slice(offset, offset + 2000).join('');
      await weixinRequest(app.baseUrl, 'sendmessage', { token: app.botToken, body: { msg: {
        from_user_id: '', to_user_id: chatId, client_id: randomUUID(), message_type: 2, message_state: 2,
        context_token: token, item_list: [{ type: 1, text_item: { text: chunk } }],
      } } });
    }
  }

  async sendToSession(id: string, sessionId: string, content: string): Promise<void> {
    const chatId = Object.entries(this.getApp(id).conversations).find(([, value]) => value === sessionId)?.[0];
    if (!chatId) throw new Error('此对话尚无微信发送目标');
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
    this.clients.get(id)?.controller.abort();
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
    if (!app) throw new Error('微信应用不存在');
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
