import type { AgentRegistry } from '../../agents/registry.js';
import { DingTalkRegistry, type DingTalkMessage } from './registry.js';
import type { SessionManager } from '../../sessions/manager.js';
import type { AgentImage, AgentSession, DingTalkConversation, SessionEvent } from '../../types.js';

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

export class DingTalkBridge {
  private queues = new Map<string, Promise<void>>();
  private seen = new Set<string>();

  constructor(private dingtalk: DingTalkRegistry, private agents: AgentRegistry, private sessions: SessionManager) {
    dingtalk.on('message', event => this.enqueue(event));
  }

  private enqueue({ appId, message }: DingTalkMessage): void {
    if (!message.msgId || !message.conversationId || !['1', '2'].includes(message.conversationType)) return;
    const messageKey = `${appId}:${message.msgId}`;
    if (this.seen.has(messageKey)) return;
    this.seen.add(messageKey);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
    const conversation = `${message.conversationType}:${message.conversationId}`;
    const key = `${appId}:${conversation}`;
    const task = (this.queues.get(key) || Promise.resolve())
      .then(() => this.process(appId, conversation, message))
      .catch(async error => {
        console.error(`DingTalk message processing failed for ${appId} (message ${message.msgId}, conversation ${conversation}, type ${message.msgtype}):`, error);
        try {
          await this.dingtalk.reply(appId, message.sessionWebhook, 'Agent 执行失败，请在 Agent Muster 中查看会话日志。');
        } catch (replyError) {
          console.error(`DingTalk error reply failed for ${appId}:`, replyError);
        }
      });
    this.queues.set(key, task);
    void task.finally(() => { if (this.queues.get(key) === task) this.queues.delete(key); });
  }

  private async process(appId: string, conversation: string, message: DingTalkMessage['message']): Promise<void> {
    if (!['text', 'picture', 'richText'].includes(message.msgtype)) return;
    if (message.msgtype === 'text' && !message.text.content.trim()) return;
    const binding = this.dingtalk.getBinding(appId);
    if (!binding?.project || !binding.agent) {
      await this.dingtalk.reply(appId, message.sessionWebhook, '请先在 Agent Muster 中为此应用绑定项目和 Agent。');
      return;
    }
    if (!this.agents.get(binding.agent)?.installed) {
      await this.dingtalk.reply(appId, message.sessionWebhook, '绑定的 Agent 当前不可用。');
      return;
    }
    await this.dingtalk.setConversationTarget(appId, conversation, message);
    let content: string;
    const images: AgentImage[] = [];
    if (message.msgtype === 'text') content = message.text.content.trim();
    else {
      const parts = message.msgtype === 'picture' ? [{ ...message.content, type: 'picture' as const }] : message.content.richText;
      const promptParts: string[] = [];
      for (const part of parts) {
        if (part.type === 'picture') {
          const downloadCode = part.downloadCode ?? part.pictureDownloadCode;
          if (!downloadCode) throw new Error('钉钉图片消息缺少下载码');
          if (binding.agent === 'kimi') throw new Error('当前 Kimi CLI 不支持图片附件输入');
          images.push(await this.dingtalk.downloadImage(appId, message.robotCode, downloadCode));
        } else promptParts.push(part.text);
      }
      content = promptParts.join('').trim();
      if (!content && images.length) content = '请查看这张图片。';
      if (!content) return;
    }
    const dingtalkConversation: DingTalkConversation = {
      type: message.conversationType === '2' ? 'group' : 'single',
      ...(message.conversationType === '2' ? { groupName: message.conversationTitle } : {}),
      senderName: message.senderNick,
      senderStaffId: message.senderStaffId,
    };
    const prompt = message.conversationType === '2'
      ? `${message.senderNick}（${message.senderStaffId}）在群聊中说：\n${content}`
      : content;
    const previousId = this.dingtalk.getSession(appId, conversation);
    let session = previousId ? this.sessions.get(previousId) : undefined;
    if (session) this.sessions.linkDingTalkSession(session.id, appId);
    if (session && !terminalStatuses.has(session.status)) await waitForCompletion(this.sessions, session);
    const lastEventId = session?.events.at(-1)?.id || 0;
    if (session) this.sessions.send(session.id, prompt, undefined, dingtalkConversation, images);
    else {
      session = await this.sessions.create(binding.agent, binding.project, prompt, undefined, appId, dingtalkConversation, images);
      await this.dingtalk.setSession(appId, conversation, session.id);
    }
    await waitForCompletion(this.sessions, session);
    if (session.status === 'failed') {
      console.error(`DingTalk Agent execution failed for ${appId} (message ${message.msgId}, conversation ${conversation}, session ${session.id}):`,
        session.events.filter(event => event.id > lastEventId && event.type === 'error').map(event => event.text).join('\n'));
    }
    const reply = session.status === 'completed'
      ? session.events.filter(event => event.id > lastEventId && event.type === 'output').at(-1)?.text.trim() || 'Agent 已执行完成。'
      : 'Agent 执行失败，请在 Agent Muster 中查看会话日志。';
    await this.dingtalk.reply(appId, message.sessionWebhook, reply);
  }
}
