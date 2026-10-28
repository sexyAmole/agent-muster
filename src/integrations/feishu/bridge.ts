import type { ProjectRegistry } from '../../projects/registry.js';
import { handleCommand } from '../commands.js';
import { withContextUsage } from '../reply.js';
import { type StreamReply, watchStreamOutput } from '../stream-reply.js';
import type { AgentRegistry } from '../../agents/registry.js';
import { FeishuRegistry, type FeishuMessage } from './registry.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { AgentImage, AgentSession, ImBinding, SessionEvent } from '../../types.js';

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

function readPost(post: PostContent, message: FeishuMessage['message']['message'], imageKeys: string[]): string {
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
  return lines.join('\n');
}

function readMessage(message: FeishuMessage['message']['message']): { content: string; imageKeys: string[] } | undefined {
  let content = '';
  const imageKeys: string[] = [];
  if (message.message_type === 'text') content = (JSON.parse(message.content) as { text: string }).text;
  else if (message.message_type === 'image') imageKeys.push((JSON.parse(message.content) as { image_key: string }).image_key);
  else if (message.message_type === 'post') {
    content = readPost(JSON.parse(message.content) as PostContent, message, imageKeys);
  } else return;
  for (const mention of message.mentions || []) content = content.replaceAll(mention.key, mention.mentioned_type === 'app' ? '' : `@${mention.name}`);
  content = content.trim();
  return { content, imageKeys };
}

export class FeishuBridge {
  private queues = new Map<string, Promise<void>>();
  private seen = new Set<string>();

  constructor(private feishu: FeishuRegistry, private agents: AgentRegistry, private sessions: SessionManager, private projects: ProjectRegistry) {
    feishu.on('message', event => this.enqueue(event));
  }

  private enqueue({ appId, message: event }: FeishuMessage): void {
    const { message, sender } = event;
    if (sender.sender_type !== 'user' || !['text', 'image', 'post', 'audio'].includes(message.message_type)) return;
    const key = `${appId}:${message.chat_id}`;
    const messageKey = `${appId}:${message.message_id}`;
    if (this.seen.has(messageKey)) return;
    this.seen.add(messageKey);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
    const response = this.feishu.startReply(appId, message.chat_id, message.chat_type === 'group' ? sender.sender_id?.open_id : undefined)
      .then(reply => ({ reply }), error => ({ error }));
    const task = Promise.all([this.queues.get(key), response]).then(async ([, result]) => {
      if ('error' in result) throw result.error;
      const { reply } = result;
      try {
        await this.process(appId, event, reply);
        await reply.finish('未识别到消息内容。');
      } catch (error) {
        console.error(`飞书消息 ${message.message_id} 处理失败：`, error);
        await reply.finish('Agent 执行失败，请在 Agent Muster 中查看会话日志。');
      }
    }).catch(error => { console.error('飞书流式回复失败：', error); });
    this.queues.set(key, task);
    void task.finally(() => { if (this.queues.get(key) === task) this.queues.delete(key); });
  }

  private async resolveBinding(appId: string, chatId: string, reply: StreamReply) {
    const binding = this.feishu.getBinding(appId, chatId);
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

  private async downloadImages(appId: string, message: FeishuMessage['message']['message'], agent: string, imageKeys: string[], reply: StreamReply): Promise<AgentImage[] | undefined> {
    if (imageKeys.length && agent === 'cursor') {
      await reply.finish(`当前 ${this.agents.get(agent)!.name} 接入不支持图片附件，请在 Agent Muster 中绑定支持图片的 Agent。`);
      return;
    }
    const images: AgentImage[] = [];
    try {
      for (const imageKey of imageKeys) images.push(await this.feishu.downloadImage(appId, message.message_id, imageKey));
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

  private async process(appId: string, { message, sender }: FeishuMessage['message'], reply: StreamReply): Promise<void> {
    if (message.message_type === 'audio') {
      await reply.finish('暂不支持语音消息，请改用文字发送。');
      return;
    }
    const parsed = readMessage(message);
    if (!parsed) return;
    let { content } = parsed;
    const { imageKeys } = parsed;
    if (!content && !imageKeys.length) return;
    if (!imageKeys.length && await handleCommand(content, appId, message.chat_id, this.feishu, this.projects, this.agents, this.sessions, text => reply.finish(text))) return;
    const binding = await this.resolveBinding(appId, message.chat_id, reply);
    if (!binding) return;
    const senderId = sender.sender_id?.open_id;
    if (!senderId) throw new Error('飞书消息缺少发送人标识');
    const images = await this.downloadImages(appId, message, binding.agent, imageKeys, reply);
    if (!images) return;
    if (!content && images.length) content = '请查看这张图片。';
    const im: ImBinding = { platform: 'feishu', appId, conversation: { type: message.chat_type === 'group' ? 'group' : 'single', senderId } };
    const prompt = message.chat_type === 'group' ? `${senderId} 在群聊中说：\n${content}` : content;
    const previousId = this.feishu.getSession(appId, message.chat_id);
    let session = previousId ? this.sessions.get(previousId) : undefined;
    if (session && (this.sessions.isRunning(session.id) || !terminalStatuses.has(session.status))) await waitForCompletion(this.sessions, session);
    const lastEventId = session?.events.at(-1)?.id || 0;
    if (session) {
      await this.sessions.send(session.id, prompt, binding.model, im, images, binding.permissionMode);
    } else {
      session = await this.sessions.create(binding.agent, binding.project, prompt, binding.model || undefined, im, images, binding.permissionMode);
      await this.feishu.setSession(appId, message.chat_id, session.id);
    }
    const unwatch = watchStreamOutput(this.sessions, session, lastEventId, reply);
    try {
      await waitForCompletion(this.sessions, session);
      await this.replyResult(session, lastEventId, reply);
    } finally { unwatch(); }
  }
}
