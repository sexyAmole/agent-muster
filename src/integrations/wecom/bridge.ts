import { MessageType, type ImageContent } from '@wecom/aibot-node-sdk';
import type { ProjectRegistry } from '../../projects/registry.js';
import { handleCommand } from '../commands.js';
import { withContextUsage } from '../reply.js';
import { type StreamReply, watchStreamOutput } from '../stream-reply.js';
import type { AgentRegistry } from '../../agents/registry.js';
import { WecomRegistry, type WecomMessage } from './registry.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { AgentImage, AgentSession, ImBinding, SessionEvent } from '../../types.js';

const terminalStatuses = new Set(['completed', 'failed', 'stopped']);
function waitForCompletion(sessions: SessionManager, session: AgentSession): Promise<void> {
  if (terminalStatuses.has(session.status) && !sessions.isRunning(session.id)) return Promise.resolve();
  return new Promise(resolve => {
    const check = () => {
      if (!terminalStatuses.has(session.status) || sessions.isRunning(session.id)) return;
      sessions.off(session.id, onEvent);
      sessions.off(`${session.id}:idle`, check);
      resolve();
    };
    const onEvent = (event: SessionEvent) => { if (event.type === 'status') check(); };
    sessions.on(session.id, onEvent);
    sessions.on(`${session.id}:idle`, check);
    check();
  });
}

export class WecomBridge {
  private queues = new Map<string, Promise<void>>();
  private seen = new Set<string>();

  constructor(private wecom: WecomRegistry, private agents: AgentRegistry, private sessions: SessionManager, private projects: ProjectRegistry) {
    wecom.on('message', event => this.enqueue(event));
  }

  private enqueue({ appId, frame }: WecomMessage): void {
    const message = frame.body;
    if (!message) return;
    const chatId = message.chattype === 'group' ? message.chatid : message.from.userid;
    if (!chatId) return;
    const key = `${appId}:${message.chattype}:${chatId}`;
    const messageKey = `${appId}:${message.msgid}`;
    if (this.seen.has(messageKey)) return;
    this.seen.add(messageKey);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
    const response = this.wecom.startReply(appId, chatId, frame).then(reply => ({ reply }), error => ({ error }));
    const task = Promise.all([this.queues.get(key), response]).then(async ([, result]) => {
      if ('error' in result) throw result.error;
      const { reply } = result;
      try {
        await this.process(appId, chatId, message, reply);
        await reply.finish('未识别到消息内容。');
      } catch (error) {
        console.error(`企业微信消息 ${message.msgid} 处理失败：`, error);
        await reply.finish('Agent 执行失败，请在 Agent Muster 中查看会话日志。');
      }
    }).catch(error => { console.error('企业微信流式回复失败：', error); });
    this.queues.set(key, task);
    void task.finally(() => { if (this.queues.get(key) === task) this.queues.delete(key); });
  }

  private async resolveBinding(appId: string, chatId: string, reply: StreamReply) {
    const binding = this.wecom.getBinding(appId, chatId);
    if (!binding?.project || !binding.agent) {
      await reply.finish('请先在 Agent Muster 中为此应用绑定项目和 Agent。');
      return;
    }
    if (!this.projects.list().includes(binding.project)) {
      await reply.finish('当前项目不存在，请通过 /projects 查看列表并使用 /project 切换项目。');
      return;
    }
    if (!this.agents.get(binding.agent)?.installed) {
      await reply.finish('绑定的 Agent 当前不可用。');
      return;
    }
    return { ...binding, project: binding.project, agent: binding.agent };
  }

  private async downloadImages(appId: string, agent: string, attachments: ImageContent[], reply: StreamReply): Promise<AgentImage[] | undefined> {
    if (attachments.length && agent === 'cursor') {
      await reply.finish(`当前 ${this.agents.get(agent)!.name} 接入不支持图片附件，请在 Agent Muster 中绑定支持图片的 Agent。`);
      return;
    }
    const images: AgentImage[] = [];
    try {
      for (const image of attachments) images.push(await this.wecom.downloadImage(appId, image));
    } catch (error) {
      await reply.finish((error as Error).message);
      return;
    }
    return images;
  }

  private async replyResult(session: AgentSession, lastEventId: number, response: StreamReply): Promise<void> {
    let output: string | undefined;
    for (const event of this.sessions.eventsAfter(session.id, lastEventId)) {
      if (event.type === 'output') output = event.text.trim();
    }
    const reply = session.status === 'completed' ? output || 'Agent 已执行完成。' : 'Agent 执行失败，请在 Agent Muster 中查看会话日志。';
    await response.finish(withContextUsage(reply, session.usage));
  }

  private async process(appId: string, chatId: string, message: NonNullable<WecomMessage['frame']['body']>, reply: StreamReply): Promise<void> {
    let content = '';
    const attachments: ImageContent[] = [];
    if (message.msgtype === MessageType.Text) content = message.text.content;
    else if (message.msgtype === MessageType.Voice) content = message.voice.content;
    else if (message.msgtype === MessageType.Image) attachments.push(message.image);
    else if (message.msgtype === MessageType.Mixed) {
      content = message.mixed.msg_item.filter(item => item.msgtype === 'text').map(item => item.text?.content || '').join('\n');
      for (const item of message.mixed.msg_item) if (item.msgtype === 'image' && item.image) attachments.push(item.image);
    }
    content = content.trim();
    if (!content && !attachments.length) return;
    if (!attachments.length && await handleCommand(content, appId, chatId, this.wecom, this.projects, this.agents, this.sessions, text => reply.finish(text))) return;
    const binding = await this.resolveBinding(appId, chatId, reply);
    if (!binding) return;
    const senderId = message.from.userid;
    if (!senderId) throw new Error('企业微信消息缺少发送人标识');
    const images = await this.downloadImages(appId, binding.agent, attachments, reply);
    if (!images) return;
    if (!content && images.length) content = '请查看这张图片。';
    const im: ImBinding = { platform: 'wecom', appId, conversation: { type: message.chattype === 'group' ? 'group' : 'single', senderId } };
    const prompt = message.chattype === 'group' ? `${senderId} 在群聊中说：\n${content}` : content;
    const previousId = this.wecom.getSession(appId, chatId);
    let session = previousId ? this.sessions.get(previousId) : undefined;
    if (session && (this.sessions.isRunning(session.id) || !terminalStatuses.has(session.status))) await waitForCompletion(this.sessions, session);
    const lastEventId = session?.events.at(-1)?.id || 0;
    if (session) {
      await this.sessions.send(session.id, prompt, binding.model, im, images, binding.permissionMode);
    } else {
      session = await this.sessions.create(binding.agent, binding.project, prompt, binding.model || undefined, im, images, binding.permissionMode);
      await this.wecom.setSession(appId, chatId, session.id);
    }
    const unwatch = watchStreamOutput(this.sessions, session, lastEventId, reply);
    try {
      await waitForCompletion(this.sessions, session);
      await this.replyResult(session, lastEventId, reply);
    } finally { unwatch(); }
  }
}
