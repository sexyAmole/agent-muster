import type { AgentRegistry } from '../../agents/registry.js';
import { FeishuRegistry, type FeishuMessage } from './registry.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { AgentSession, FeishuConversation, SessionEvent } from '../../types.js';

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

export class FeishuBridge {
  private queues = new Map<string, Promise<void>>();
  private seen = new Set<string>();

  constructor(private feishu: FeishuRegistry, private agents: AgentRegistry, private sessions: SessionManager) {
    feishu.on('message', event => this.enqueue(event));
  }

  private enqueue({ appId, message: event }: FeishuMessage): void {
    const { message, sender } = event;
    if (sender.sender_type !== 'user' || message.message_type !== 'text') return;
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
    const body = JSON.parse(message.content) as { text: string };
    let content = body.text;
    for (const mention of message.mentions || []) content = content.replaceAll(mention.key, mention.mentioned_type === 'app' ? '' : `@${mention.name}`);
    content = content.trim();
    if (!content) return;
    const binding = this.feishu.getBinding(appId);
    if (!binding?.project || !binding.agent) {
      await this.feishu.send(appId, message.chat_id, '请先在 Agent Muster 中为此应用绑定项目和 Agent。');
      return;
    }
    if (!this.agents.get(binding.agent)?.installed) {
      await this.feishu.send(appId, message.chat_id, '绑定的 Agent 当前不可用。');
      return;
    }
    const senderId = sender.sender_id?.open_id;
    if (!senderId) throw new Error('飞书消息缺少发送人标识');
    const conversation: FeishuConversation = { type: message.chat_type === 'group' ? 'group' : 'single', senderId };
    const prompt = message.chat_type === 'group' ? `${senderId} 在群聊中说：\n${content}` : content;
    const previousId = this.feishu.getSession(appId, message.chat_id);
    let session = previousId ? this.sessions.get(previousId) : undefined;
    if (session && (this.sessions.isRunning(session.id) || !terminalStatuses.has(session.status))) await waitForCompletion(this.sessions, session);
    const lastEventId = session?.events.at(-1)?.id || 0;
    if (session) {
      this.sessions.linkFeishuSession(session.id, appId);
      this.sessions.send(session.id, prompt, undefined, undefined, undefined, conversation);
    } else {
      session = await this.sessions.create(binding.agent, binding.project, prompt, undefined, undefined, undefined, undefined, { appId, conversation });
      await this.feishu.setSession(appId, message.chat_id, session.id);
    }
    await waitForCompletion(this.sessions, session);
    let output: string | undefined;
    for (const event of this.sessions.eventsAfter(session.id, lastEventId)) {
      if (event.type === 'output') output = event.text.trim();
    }
    const reply = session.status === 'completed' ? output || 'Agent 已执行完成。' : 'Agent 执行失败，请在 Agent Muster 中查看会话日志。';
    await this.feishu.send(appId, message.chat_id, reply);
  }
}
