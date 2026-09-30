import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { DWClient, TOPIC_ROBOT, type RobotMessage } from 'dingtalk-stream';
import { EnvHttpProxyAgent, fetch } from 'undici';
import type { AgentImage } from './types.js';

const directory = join(homedir(), '.agent-muster');
const dataFile = join(directory, 'dingtalk-apps.json');
const iconDirectory = join(directory, 'dingtalk-icons');
const imageDirectory = join(directory, 'dingtalk-images');
const apiBase = 'https://oapi.dingtalk.com';
const openApiBase = 'https://api.dingtalk.com';
const dispatcher = new EnvHttpProxyAgent();

type DingTalkResponse = { errcode: number; errmsg: string };
type InitResponse = DingTalkResponse & { nonce: string };
type BeginResponse = DingTalkResponse & {
  device_code: string; user_code: string; verification_uri_complete: string; expires_in: number; interval: number;
};
type PollResponse = DingTalkResponse & {
  status: 'WAITING' | 'SUCCESS' | 'FAIL' | 'EXPIRED'; client_id?: string; client_secret?: string; fail_reason?: string;
};
type AccessTokenResponse = { accessToken?: string; expireIn?: number };
type InnerAppsResponse = { appList?: { name?: string; icon?: string; robotInfo?: { robotCode?: string } }[]; code?: string };
type ConversationTarget = { robotCode: string } & ({ type: '1'; userId: string } | { type: '2'; openConversationId: string });
type SendMessageResponse = { processQueryKey?: string; message?: string; invalidStaffIdList?: string[]; flowControlledStaffIdList?: string[] };
type Application = { id: string; clientId: string; clientSecret: string; name: string | null; iconMime: string | null; project: string | null; agent: string | null; conversations: Record<string, string>; conversationTargets?: Record<string, ConversationTarget> };
type RobotMessageBase = Omit<RobotMessage, 'msgtype' | 'text'> & { conversationTitle?: string };
type RobotImage = { downloadCode?: string; pictureDownloadCode?: string };
type IncomingRobotMessage = RobotMessageBase & (
  | { msgtype: 'text'; text: { content: string } }
  | { msgtype: 'picture'; content: RobotImage }
  | { msgtype: 'richText'; content: { richText: ({ text: string; type?: never } | (RobotImage & { type: 'picture' }))[] } }
);
export type DingTalkMessage = { appId: string; message: IncomingRobotMessage };
type Registration = {
  deviceCode: string; expiresAt: number; interval: number; lastPolledAt: number;
  result?: { status: 'SUCCESS'; appId: string } | { status: 'FAIL' | 'EXPIRED'; reason?: string };
  polling?: Promise<{ status: 'WAITING' | 'SUCCESS' | 'FAIL' | 'EXPIRED'; appId?: string; reason?: string }>;
};

async function post<T extends DingTalkResponse>(path: string, body: object): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000), dispatcher,
  });
  if (!response.ok) throw new Error(`钉钉接口请求失败 (${response.status})`);
  const result = await response.json() as T;
  if (result.errcode !== 0) throw new Error(result.errmsg || `钉钉接口错误 (${result.errcode})`);
  return result;
}

export class DingTalkRegistry extends EventEmitter<{ message: [DingTalkMessage] }> {
  private apps: Application[] = [];
  private registrations = new Map<string, Registration>();
  private clients = new Map<string, DWClient>();
  private accessTokens = new Map<string, { value: string; expiresAt: number }>();
  private writeQueue = Promise.resolve();

  async load(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(dataFile, 'utf8')) as Application[];
      this.apps = stored.map(({ id, clientId, clientSecret, name, iconMime, project, agent, conversations, conversationTargets }) => ({
        id, clientId, clientSecret, name: name || null, iconMime: iconMime || null, project, agent: agent || null, conversations: conversations || {}, conversationTargets,
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  list() {
    return this.apps.map(({ id, clientId, name, iconMime, project, agent }) => ({ id, clientId, name, icon: iconMime ? `/api/dingtalk/apps/${id}/icon` : null, project, agent }));
  }

  async getIcon(id: string) {
    const app = this.apps.find(item => item.id === id);
    if (!app?.iconMime) return null;
    return { data: await readFile(join(iconDirectory, id)), mime: app.iconMime };
  }

  getBinding(id: string) {
    const app = this.apps.find(item => item.id === id);
    return app ? { project: app.project, agent: app.agent } : undefined;
  }

  getSession(id: string, conversation: string): string | undefined {
    return this.apps.find(item => item.id === id)?.conversations[conversation];
  }

  sessionBindings() {
    return this.apps.flatMap(app => Object.values(app.conversations).map(sessionId => ({ sessionId, appId: app.id })));
  }

  async setSession(id: string, conversation: string, sessionId: string): Promise<void> {
    const app = this.apps.find(item => item.id === id);
    if (!app) throw new Error('钉钉应用不存在');
    app.conversations[conversation] = sessionId;
    await this.persist();
  }

  async setConversationTarget(id: string, conversation: string, message: IncomingRobotMessage): Promise<void> {
    const app = this.apps.find(item => item.id === id);
    if (!app) throw new Error('钉钉应用不存在');
    const target: ConversationTarget = message.conversationType === '1'
      ? { type: '1', robotCode: message.robotCode, userId: message.senderStaffId }
      : { type: '2', robotCode: message.robotCode, openConversationId: message.conversationId };
    app.conversationTargets ||= {};
    app.conversationTargets[conversation] = target;
    await this.persist();
  }

  async downloadImage(id: string, robotCode: string, downloadCode: string): Promise<AgentImage> {
    const app = this.apps.find(item => item.id === id);
    if (!app) throw new Error('钉钉应用不存在');
    if (!downloadCode) throw new Error('钉钉图片消息缺少下载码');
    if (!robotCode) throw new Error('钉钉图片消息缺少机器人编码');
    const token = await this.getAccessToken(app);
    const response = await fetch(`${openApiBase}/v1.0/robot/messageFiles/download`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({ robotCode, downloadCode }),
      redirect: 'error', signal: AbortSignal.timeout(10000), dispatcher,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`钉钉图片下载地址获取失败 (${response.status}): ${body.slice(0, 2000)}`);
    let result: { downloadUrl?: string };
    try { result = JSON.parse(body) as { downloadUrl?: string }; }
    catch (error) { throw new Error(`钉钉图片下载地址响应不是有效 JSON: ${body.slice(0, 2000)}`, { cause: error }); }
    if (typeof result?.downloadUrl !== 'string' || !result.downloadUrl) throw new Error(`钉钉未返回图片下载地址: ${body.slice(0, 2000)}`);
    const url = new URL(result.downloadUrl);
    if (url.protocol !== 'https:') throw new Error('钉钉返回了无效的图片下载地址');
    const image = await fetch(url, { signal: AbortSignal.timeout(30000), dispatcher });
    if (!image.ok) throw new Error(`钉钉图片下载失败 (${image.status}): ${(await image.text()).slice(0, 2000)}`);
    const mimeType = image.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
    if (!mimeType || !extensions[mimeType]) throw new Error(`钉钉返回了不支持的图片类型: ${mimeType}`);
    const data = Buffer.from(await image.arrayBuffer());
    if (!data.length) throw new Error('钉钉返回了空图片');
    await mkdir(imageDirectory, { recursive: true, mode: 0o700 });
    const path = join(imageDirectory, `${randomUUID()}.${extensions[mimeType]}`);
    await writeFile(path, data, { mode: 0o600 });
    return { type: 'image', mimeType, data: data.toString('base64'), path };
  }

  async sendToSession(appId: string, sessionId: string, content: string): Promise<void> {
    const app = this.apps.find(item => item.id === appId);
    if (!app) throw new Error('钉钉应用不存在');
    const conversation = Object.keys(app.conversations).find(key => app.conversations[key] === sessionId);
    const target = conversation ? app.conversationTargets?.[conversation] : undefined;
    if (!target) throw new Error('此对话尚无发送目标，请先在钉钉中向应用发送一条消息');
    if (!target.robotCode || (target.type === '1' ? !target.userId : !target.openConversationId)) throw new Error('钉钉对话的发送目标不完整');
    const token = await this.getAccessToken(app);
    const path = target.type === '1' ? '/v1.0/robot/oToMessages/batchSend' : '/v1.0/robot/groupMessages/send';
    const response = await fetch(`${openApiBase}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({
        robotCode: target.robotCode, msgKey: 'sampleText', msgParam: JSON.stringify({ content }),
        ...(target.type === '1' ? { userIds: [target.userId] } : { openConversationId: target.openConversationId }),
      }),
      redirect: 'error', signal: AbortSignal.timeout(10000), dispatcher,
    });
    const result = await response.json() as SendMessageResponse;
    if (!response.ok) throw new Error(result.message || `钉钉消息发送失败 (${response.status})`);
    if (result.invalidStaffIdList?.length) throw new Error('钉钉消息发送失败：接收人无效');
    if (result.flowControlledStaffIdList?.length) throw new Error('钉钉消息发送失败：发送频率受限，请稍后重试');
    if (!result.processQueryKey) throw new Error(result.message || '钉钉未返回消息发送凭证');
  }

  async unbindSession(sessionId: string): Promise<void> {
    let changed = false;
    for (const app of this.apps) {
      for (const [conversation, id] of Object.entries(app.conversations)) {
        if (id !== sessionId) continue;
        delete app.conversations[conversation];
        delete app.conversationTargets?.[conversation];
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  async reply(id: string, webhook: string, content: string): Promise<void> {
    const url = new URL(webhook);
    if (url.protocol !== 'https:' || url.hostname !== 'oapi.dingtalk.com' || url.pathname !== '/robot/sendBySession') {
      throw new Error('钉钉返回了无效的回复地址');
    }
    const client = this.clients.get(id);
    if (!client) throw new Error('钉钉订阅未启动');
    const accessToken = await client.getAccessToken() as string;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': accessToken },
      body: JSON.stringify({ msgtype: 'text', text: { content } }),
      redirect: 'error', signal: AbortSignal.timeout(10000), dispatcher,
    });
    if (!response.ok) throw new Error(`钉钉回复失败 (${response.status})`);
    const result = await response.json() as DingTalkResponse;
    if (result.errcode !== 0) throw new Error(result.errmsg || `钉钉回复失败 (${result.errcode})`);
  }

  startSubscriptions(): void {
    for (const app of this.apps) this.subscribe(app);
  }

  shutdown(): void {
    for (const client of this.clients.values()) client.disconnect();
    this.clients.clear();
    this.accessTokens.clear();
  }

  private subscribe(app: Application): void {
    const current = this.clients.get(app.id);
    if (current?.config.clientId === app.clientId && current.config.clientSecret === app.clientSecret) return;
    current?.disconnect();
    const client = new DWClient({ clientId: app.clientId, clientSecret: app.clientSecret });
    client.registerCallbackListener(TOPIC_ROBOT, event => {
      try {
        const message = JSON.parse(event.data) as IncomingRobotMessage;
        this.emit('message', { appId: app.id, message });
        client.socketCallBackResponse(event.headers.messageId, null);
      } catch (error) {
        console.error(`DingTalk message handling failed for ${app.clientId}:`, error);
      }
    });
    this.clients.set(app.id, client);
    void client.connect().catch(error => console.error(`DingTalk subscription failed for ${app.clientId}:`, error));
  }

  async start() {
    const { nonce } = await post<InitResponse>('/app/registration/init', {});
    const result = await post<BeginResponse>('/app/registration/begin', { nonce });
    const url = new URL(result.verification_uri_complete);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.dingtalk.com')) throw new Error('钉钉返回了无效的授权地址');
    const id = randomUUID();
    const expiresAt = Date.now() + result.expires_in * 1000;
    this.registrations.set(id, { deviceCode: result.device_code, expiresAt, interval: result.interval, lastPolledAt: 0 });
    const svg = await QRCode.toString(url.href, { type: 'svg', margin: 1, width: 220 });
    return { id, userCode: result.user_code, verificationUrl: url.href, qrCode: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, expiresAt, interval: result.interval };
  }

  async poll(id: string) {
    const registration = this.registrations.get(id);
    if (!registration) throw new Error('扫码会话不存在');
    if (registration.result) return registration.result;
    if (Date.now() >= registration.expiresAt) {
      registration.result = { status: 'EXPIRED' };
      return registration.result;
    }
    if (registration.polling) return registration.polling;
    if (Date.now() - registration.lastPolledAt < registration.interval * 1000) return { status: 'WAITING' as const };
    registration.lastPolledAt = Date.now();
    registration.polling = (async () => {
      const result = await post<PollResponse>('/app/registration/poll', { device_code: registration.deviceCode });
      if (result.status === 'SUCCESS') {
        if (!result.client_id || !result.client_secret) throw new Error('钉钉未返回应用凭证');
        const app = await this.saveApp(result.client_id, result.client_secret);
        this.subscribe(app);
        registration.result = { status: 'SUCCESS', appId: app.id };
      } else if (result.status === 'FAIL' || result.status === 'EXPIRED') {
        registration.result = { status: result.status, reason: result.fail_reason };
      }
      return registration.result || { status: 'WAITING' as const };
    })();
    try { return await registration.polling; }
    finally { registration.polling = undefined; }
  }

  async bind(id: string, binding: { project?: string | null; agent?: string | null }, projects: string[], agents: string[]) {
    if (binding.project !== undefined && binding.project !== null && !projects.includes(binding.project)) throw new Error('项目不存在');
    if (binding.agent !== undefined && binding.agent !== null && !agents.includes(binding.agent)) throw new Error('Agent 不可用');
    const app = this.apps.find(item => item.id === id);
    if (!app) throw new Error('钉钉应用不存在');
    if ((binding.project !== undefined && binding.project !== app.project) || (binding.agent !== undefined && binding.agent !== app.agent)) {
      app.conversations = {};
      app.conversationTargets = {};
    }
    if (binding.project !== undefined) app.project = binding.project;
    if (binding.agent !== undefined) app.agent = binding.agent;
    await this.persist();
    return { id: app.id, clientId: app.clientId, name: app.name, icon: app.iconMime ? `/api/dingtalk/apps/${app.id}/icon` : null, project: app.project, agent: app.agent };
  }

  async remove(id: string): Promise<void> {
    const index = this.apps.findIndex(app => app.id === id);
    if (index < 0) throw new Error('钉钉应用不存在');
    const [app] = this.apps.splice(index, 1);
    this.clients.get(id)?.disconnect();
    this.clients.delete(id);
    this.accessTokens.delete(id);
    await this.persist();
    if (app.iconMime) await rm(join(iconDirectory, id), { force: true });
  }

  async unbindProject(project: string): Promise<void> {
    for (const app of this.apps) {
      if (app.project !== project) continue;
      app.project = null;
      app.conversations = {};
      app.conversationTargets = {};
    }
    await this.persist();
  }

  private async saveApp(clientId: string, clientSecret: string) {
    let app = this.apps.find(item => item.clientId === clientId);
    if (app) {
      if (app.clientSecret !== clientSecret) this.accessTokens.delete(app.id);
      app.clientSecret = clientSecret;
    }
    else {
      app = { id: randomUUID(), clientId, clientSecret, name: null, iconMime: null, project: null, agent: null, conversations: {} };
      this.apps.push(app);
    }
    await this.persist();
    return app;
  }

  async syncMetadata(id: string) {
    const app = this.apps.find(item => item.id === id);
    if (!app) throw new Error('钉钉应用不存在');
    const token = await this.getAccessToken(app);
    const response = await fetch(`${openApiBase}/v1.0/microApp/allInnerApps`, {
      headers: { 'x-acs-dingtalk-access-token': token }, signal: AbortSignal.timeout(10000), dispatcher,
    });
    const result = await response.json() as InnerAppsResponse;
    if (response.status === 403 && result.code === 'Forbidden.AccessDenied.AccessTokenPermissionDenied') {
      throw new Error('缺少钉钉权限 qyapi_get_microapp_list，请在钉钉开发者后台为此应用开通后重试');
    }
    if (!response.ok) throw new Error(`钉钉应用信息获取失败 (${response.status})`);
    const match = result.appList?.find(item => item.robotInfo?.robotCode === app.clientId);
    if (!match?.name || !match.icon) throw new Error('钉钉应用列表中未找到与当前 Client ID 匹配的名称和图标');
    const iconUrl = new URL(match.icon);
    if (iconUrl.protocol !== 'https:') throw new Error('钉钉返回了无效的图标地址');
    const iconResponse = await fetch(iconUrl, { signal: AbortSignal.timeout(10000), dispatcher });
    if (!iconResponse.ok) throw new Error(`钉钉图标下载失败 (${iconResponse.status})`);
    const mime = iconResponse.headers.get('content-type')?.split(';')[0];
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp' && mime !== 'image/gif') {
      throw new Error('钉钉返回了无效的图标');
    }
    await mkdir(iconDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(iconDirectory, app.id), Buffer.from(await iconResponse.arrayBuffer()), { mode: 0o600 });
    app.name = match.name;
    app.iconMime = mime;
    await this.persist();
    return { id: app.id, clientId: app.clientId, name: app.name, icon: `/api/dingtalk/apps/${app.id}/icon?v=${Date.now()}`, project: app.project, agent: app.agent };
  }

  private async getAccessToken(app: Application): Promise<string> {
    const cached = this.accessTokens.get(app.id);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const response = await fetch(`${openApiBase}/v1.0/oauth2/accessToken`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: app.clientId, appSecret: app.clientSecret }),
      signal: AbortSignal.timeout(10000), dispatcher,
    });
    if (!response.ok) throw new Error(`钉钉 accessToken 获取失败 (${response.status})`);
    const result = await response.json() as AccessTokenResponse;
    if (!result.accessToken || !result.expireIn) throw new Error('钉钉未返回有效的 accessToken');
    this.accessTokens.set(app.id, { value: result.accessToken, expiresAt: Date.now() + Math.max(0, result.expireIn - 60) * 1000 });
    return result.accessToken;
  }

  private async persist() {
    const snapshot = JSON.stringify(this.apps);
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${dataFile}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, dataFile);
    });
    await this.writeQueue;
  }
}
