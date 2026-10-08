import { basename } from 'node:path';
import type { AgentRegistry } from '../agents/registry.js';
import type { ProjectRegistry } from '../projects/registry.js';
import type { SessionManager } from '../sessions/manager.js';

export type ConversationSettings = { project?: string; model?: string };

type CommandRegistry = {
  getBinding(id: string, conversation: string): { project: string | null; agent: string | null; model?: string } | undefined;
  getSession(id: string, conversation: string): string | undefined;
  configureConversation(id: string, conversation: string, settings: ConversationSettings, newSession?: boolean): Promise<void>;
};

const help = [
  '/new：开启新对话，保留历史记录',
  '/projects：查看项目列表',
  '/project 编号或完整路径：切换项目并开启新对话',
  '/models：查看当前 Agent 的模型列表',
  '/model 编号或模型ID：切换模型，下一条任务生效',
  '/model default：恢复 Agent 默认模型',
  '/status：查看当前项目、Agent、模型和对话',
  '/help：查看指令说明',
].join('\n');

export async function handleCommand(content: string, appId: string, conversation: string, registry: CommandRegistry, projects: ProjectRegistry, agents: AgentRegistry, sessions: SessionManager, reply: (text: string) => Promise<void>): Promise<boolean> {
  if (!content.startsWith('/')) return false;
  const match = /^(\/\S*)(?:\s+([\s\S]*))?$/.exec(content)!;
  const command = match[1];
  const argument = match[2]?.trim() || '';
  const binding = registry.getBinding(appId, conversation);
  const agent = binding?.agent ? agents.get(binding.agent) : undefined;
  let response: string;
  if (command === '/help' && !argument) response = help;
  else if (command === '/status' && !argument) {
    const sessionId = registry.getSession(appId, conversation);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    const model = binding?.model === undefined ? session?.model : binding.model;
    response = `项目：${binding?.project || '未绑定'}\nAgent：${agent?.name || '未绑定'}\n模型：${model || (agent?.defaultModel ? `Agent 默认（${agent.defaultModel}）` : 'Agent 默认')}\n对话：${session?.id || '尚未创建'}`;
  } else if (command === '/new' && !argument) {
    await registry.configureConversation(appId, conversation, {}, true);
    response = '已开启新对话，下一条消息将创建会话。历史记录已保留。';
  } else if (command === '/projects' && !argument) {
    const paths = projects.list();
    response = paths.length ? paths.map((path, index) => `${index + 1}. ${basename(path)}\n${path}`).join('\n') + '\n使用 /project 编号或完整路径 切换项目。' : '暂无项目，请先在 Agent Muster 中添加项目。';
  } else if (command === '/project') {
    const paths = projects.list();
    const project = /^\d+$/.test(argument) ? paths[Number(argument) - 1] : paths.find(path => path === argument);
    if (!project) response = '项目不存在，请通过 /projects 查看列表，再发送 /project 编号或完整路径。';
    else {
      await registry.configureConversation(appId, conversation, { project }, true);
      response = `已切换到项目：${project}\n下一条消息将开启新对话。`;
    }
  } else if (command === '/models' && !argument) {
    response = !agent?.installed ? '请先在 Agent Muster 中为此应用绑定可用的 Agent。' : agent.models.length
      ? agent.models.map((model, index) => `${index + 1}. ${model.name}（${model.id}）`).join('\n') + '\n使用 /model 编号或模型ID 切换，/model default 恢复默认模型。'
      : '当前 Agent 没有可选模型。使用 /model default 恢复默认模型。';
  } else if (command === '/model') {
    const model = /^\d+$/.test(argument) ? agent?.models[Number(argument) - 1] : agent?.models.find(item => item.id === argument);
    if (!agent?.installed) response = '请先在 Agent Muster 中为此应用绑定可用的 Agent。';
    else if (argument !== 'default' && !model) response = '模型不存在，请通过 /models 查看列表，再发送 /model 编号或模型ID。';
    else {
      await registry.configureConversation(appId, conversation, { model: argument === 'default' ? '' : model!.id });
      response = `已切换到${argument === 'default' ? ' Agent 默认模型' : `模型：${model!.id}`}，下一条任务生效。`;
    }
  } else response = `指令无效。\n${help}`;
  await reply(response);
  return true;
}
