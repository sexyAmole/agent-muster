import type { ProjectRegistry } from '../../projects/registry.js';
import { handleCommand } from '../commands.js';
import { withContextUsage } from '../reply.js';
import type { AgentRegistry } from '../../agents/registry.js';
import { WeixinRegistry, type WeixinEvent } from './registry.js';
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

export class WeixinBridge {
  private queues = new Map<string, Promise<void>>();
  private seen = new Set<string>();

  constructor(private weixin: WeixinRegistry, private agents: AgentRegistry, private sessions: SessionManager, private projects: ProjectRegistry) {
    weixin.on('message', event => this.enqueue(event));
  }

  private enqueue(event: WeixinEvent): void {
    const { appId, message } = event;
    if (!message.from_user_id || !message.context_token || message.message_id === undefined) return;
    const key = `${appId}:${message.from_user_id}`;
    const messageKey = `${appId}:${message.message_id}`;
    if (this.seen.has(messageKey)) return;
    this.seen.add(messageKey);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
    const task = (this.queues.get(key) || Promise.resolve()).then(() => this.process(event)).catch(async () => {
      console.error('微信消息处理失败，请检查会话日志');
      try { await this.weixin.send(appId, message.from_user_id!, 'Agent 执行失败，请在 Agent Muster 中查看会话日志。', message.context_token); }
      catch { console.error('微信错误消息发送失败'); }
    });
    this.queues.set(key, task);
    void task.finally(() => { if (this.queues.get(key) === task) this.queues.delete(key); });
  }

  private async process({ appId, message }: WeixinEvent): Promise<void> {
    const chatId = message.from_user_id!;
    const reply = (text: string) => this.weixin.send(appId, chatId, text, message.context_token);
    const items = message.item_list || [];
    if (items.some(item => ![1, 2, 3].includes(item.type))) { await reply('目前支持文字、图片和带转写文字的语音，请改用这些消息类型。'); return; }
    if (items.some(item => item.type === 3 && !item.voice_item?.text?.trim())) { await reply('这条语音没有转写文字，请改用文字发送。'); return; }
    const content = items.map(item => item.type === 1 ? item.text_item?.text : item.type === 3 ? item.voice_item?.text : '').filter(Boolean).join('\n').trim();
    const attachments = items.filter(item => item.type === 2);
    if (!content && !attachments.length) return;
    if (!attachments.length && await handleCommand(content, appId, chatId, this.weixin, this.projects, this.agents, this.sessions, reply)) return;
    const binding = this.weixin.getBinding(appId, chatId);
    if (!binding?.project || !binding.agent) { await reply('请先在 Agent Muster 中为此微信 Bot 绑定项目和 Agent。'); return; }
    if (!this.projects.list().includes(binding.project)) { await reply('当前项目不存在，请使用 /projects 查看列表并通过 /project 切换项目。'); return; }
    if (!this.agents.get(binding.agent)?.installed) { await reply('绑定的 Agent 当前不可用。'); return; }
    if (attachments.length && binding.agent === 'cursor') { await reply('当前 Agent 接入不支持图片附件，请绑定支持图片的 Agent。'); return; }
    const images: AgentImage[] = [];
    try {
      for (const item of attachments) {
        if (!item.image_item) throw new Error('微信图片缺少媒体信息');
        images.push(await this.weixin.downloadImage(item.image_item));
      }
    } catch (error) { await reply((error as Error).message); return; }
    const im: ImBinding = { platform: 'weixin', appId, conversation: { type: 'single', senderId: chatId } };
    const previousId = this.weixin.getSession(appId, chatId);
    let session = previousId ? this.sessions.get(previousId) : undefined;
    if (session && (this.sessions.isRunning(session.id) || !terminalStatuses.has(session.status))) await waitForCompletion(this.sessions, session);
    const lastEventId = session?.events.at(-1)?.id || 0;
    const prompt = content || '请查看这张图片。';
    if (session) await this.sessions.send(session.id, prompt, binding.model, im, images, binding.permissionMode);
    else {
      session = await this.sessions.create(binding.agent, binding.project, prompt, binding.model || undefined, im, images, binding.permissionMode);
      await this.weixin.setSession(appId, chatId, session.id);
    }
    await waitForCompletion(this.sessions, session);
    let output: string | undefined;
    for (const event of this.sessions.eventsAfter(session.id, lastEventId)) if (event.type === 'output') output = event.text.trim();
    const result = session.status === 'completed' ? output || 'Agent 已执行完成。' : 'Agent 执行失败，请在 Agent Muster 中查看会话日志。';
    await reply(withContextUsage(result, session.usage));
  }
}
