import type { ProjectRegistry } from '../../projects/registry.js';
import { handleCommand } from '../commands.js';
import type { AgentRegistry } from '../../agents/registry.js';
import { FeishuRegistry, type FeishuMessage } from './registry.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { AgentImage, AgentSession, FeishuConversation, SessionEvent } from '../../types.js';

const terminalStatuses = new Set(['completed', 'failed', 'stopped']);
type PostElement =
  | { tag: 'text'; text: string }
  | { tag: 'a'; text: string; href: string }
  | { tag: 'at'; user_id: string; user_name?: string }
  | { tag: 'img'; image_key: string };
type PostContent = { title?: string; content: PostElement[][] };

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

export class FeishuBridge {
  private queues = new Map<string, Promise<void>>();
  private seen = new Set<string>();

  constructor(private feishu: FeishuRegistry, private agents: AgentRegistry, private sessions: SessionManager, private projects: ProjectRegistry) {
    feishu.on('message', event => this.enqueue(event));
  }

  private enqueue({ appId, message: event }: FeishuMessage): void {
    const { message, sender } = event;
    if (sender.sender_type !== 'user' || !['text', 'image', 'post'].includes(message.message_type)) return;
    const key = `${appId}:${message.chat_id}`;
    const messageKey = `${appId}:${message.message_id}`;
    if (this.seen.has(messageKey)) return;
    this.seen.add(messageKey);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
    const task = (this.queues.get(key) || Promise.resolve()).then(() => this.process(appId, event)).catch(async error => {
      console.error(`飞书消息 ${message.message_id} 处理失败：`, error);
      try { await this.feishu.send(appId, message.chat_id, 'Agent 执行失败，请在 Agent Muster 中查看会话日志。'); }
      catch (replyError) { console.error('飞书错误消息发送失败：', replyError); }
    });
    this.queues.set(key, task);
    void task.finally(() => { if (this.queues.get(key) === task) this.queues.delete(key); });
  }

  private async process(appId: string, { message, sender }: FeishuMessage['message']): Promise<void> {
    let content = '';
    const imageKeys: string[] = [];
    if (message.message_type === 'text') content = (JSON.parse(message.content) as { text: string }).text;
    else if (message.message_type === 'image') imageKeys.push((JSON.parse(message.content) as { image_key: string }).image_key);
    else if (message.message_type === 'post') {
      const post = JSON.parse(message.content) as PostContent;
      const lines = [post.title || ''];
      for (const row of post.content) {
        const parts: string[] = [];
        for (const part of row) {
          if (part.tag === 'img') imageKeys.push(part.image_key);
          else if (part.tag === 'text') parts.push(part.text);
          else if (part.tag === 'a') parts.push(`[${part.text}](${part.href})`);
          else if (part.tag === 'at') {
            const mention = message.mentions?.find(item => item.key === part.user_id || item.id.open_id === part.user_id);
            if (mention?.mentioned_type !== 'app') parts.push(mention ? mention.key : `@${part.user_name || part.user_id}`);
          }
        }
        lines.push(parts.join(''));
      }
      content = lines.join('\n');
    } else return;
    for (const mention of message.mentions || []) content = content.replaceAll(mention.key, mention.mentioned_type === 'app' ? '' : `@${mention.name}`);
    content = content.trim();
    if (!content && !imageKeys.length) return;
    if (!imageKeys.length && await handleCommand(content, appId, message.chat_id, this.feishu, this.projects, this.agents, this.sessions, text => this.feishu.send(appId, message.chat_id, text))) return;
    const binding = this.feishu.getBinding(appId, message.chat_id);
    if (!binding?.project || !binding.agent) {
      await this.feishu.send(appId, message.chat_id, '请先在 Agent Muster 中为此应用绑定项目和 Agent。');
      return;
    }
    if (!this.projects.list().includes(binding.project)) {
      await this.feishu.send(appId, message.chat_id, '当前项目不存在，请通过 /projects 查看列表并使用 /project 切换项目。');
      return;
    }
    if (!this.agents.get(binding.agent)?.installed) {
      await this.feishu.send(appId, message.chat_id, '绑定的 Agent 当前不可用。');
      return;
    }
    const senderId = sender.sender_id?.open_id;
    if (!senderId) throw new Error('飞书消息缺少发送人标识');
    if (imageKeys.length && (binding.agent === 'kimi' || binding.agent === 'cursor')) {
      await this.feishu.send(appId, message.chat_id, `当前 ${this.agents.get(binding.agent)!.name} 接入不支持图片附件，请在 Agent Muster 中绑定支持图片的 Agent。`);
      return;
    }
    const images: AgentImage[] = [];
    try {
      for (const imageKey of imageKeys) images.push(await this.feishu.downloadImage(appId, message.message_id, imageKey));
    } catch (error) {
      await this.feishu.send(appId, message.chat_id, (error as Error).message);
      return;
    }
    if (!content && images.length) content = '请查看这张图片。';
    const conversation: FeishuConversation = { type: message.chat_type === 'group' ? 'group' : 'single', senderId };
    const prompt = message.chat_type === 'group' ? `${senderId} 在群聊中说：\n${content}` : content;
    const previousId = this.feishu.getSession(appId, message.chat_id);
    let session = previousId ? this.sessions.get(previousId) : undefined;
    if (session && (this.sessions.isRunning(session.id) || !terminalStatuses.has(session.status))) await waitForCompletion(this.sessions, session);
    const lastEventId = session?.events.at(-1)?.id || 0;
    if (session) {
      this.sessions.linkFeishuSession(session.id, appId);
      this.sessions.send(session.id, prompt, binding.model, undefined, images, conversation);
    } else {
      session = await this.sessions.create(binding.agent, binding.project, prompt, binding.model || undefined, undefined, undefined, images, { appId, conversation });
      await this.feishu.setSession(appId, message.chat_id, session.id);
    }
    await waitForCompletion(this.sessions, session);
    let output: string | undefined;
    for (const event of this.sessions.eventsAfter(session.id, lastEventId)) {
      if (event.type === 'output') output = event.text.trim();
    }
    const reply = session.status === 'completed' ? output || 'Agent 已执行完成。' : 'Agent 执行失败，请在 Agent Muster 中查看会话日志。';
    await this.feishu.send(appId, message.chat_id, reply, 'markdown');
  }
}
