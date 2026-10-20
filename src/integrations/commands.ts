import { basename } from 'node:path';
import type { AgentRegistry } from '../agents/registry.js';
import type { ProjectRegistry } from '../projects/registry.js';
import type { SessionManager } from '../sessions/manager.js';
import type { AgentInfo, AgentSession } from '../types.js';

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

function statusResponse(binding: ReturnType<CommandRegistry['getBinding']>, agent: AgentInfo | undefined, session: AgentSession | undefined): string {
  const model = binding?.model === undefined ? session?.model : binding.model;
  return `项目：${binding?.project || '未绑定'}\nAgent：${agent?.name || '未绑定'}\n模型：${model || (agent?.defaultModel ? `Agent 默认（${agent.defaultModel}）` : 'Agent 默认')}\n对话：${session?.id || '尚未创建'}`;
}

async function selectProject(argument: string, appId: string, conversation: string, registry: CommandRegistry, projects: ProjectRegistry): Promise<string> {
  const paths = projects.list();
  const project = /^\d+$/.test(argument) ? paths[Number(argument) - 1] : paths.find(path => path === argument);
  if (!project) return '项目不存在，请通过 /projects 查看列表，再发送 /project 编号或完整路径。';
  await registry.configureConversation(appId, conversation, { project }, true);
  return `已切换到项目：${project}\n下一条消息将开启新对话。`;
}

function modelsResponse(agent: AgentInfo | undefined): string {
  return !agent?.installed ? '请先在 Agent Muster 中为此应用绑定可用的 Agent。' : agent.models.length
    ? agent.models.map((model, index) => `${index + 1}. ${model.name}（${model.id}）`).join('\n') + '\n使用 /model 编号或模型ID 切换，/model default 恢复默认模型。'
    : '当前 Agent 没有可选模型。使用 /model default 恢复默认模型。';
}

async function selectModel(argument: string, appId: string, conversation: string, registry: CommandRegistry, agent: AgentInfo | undefined): Promise<string> {
  const model = /^\d+$/.test(argument) ? agent?.models[Number(argument) - 1] : agent?.models.find(item => item.id === argument);
  if (!agent?.installed) return '请先在 Agent Muster 中为此应用绑定可用的 Agent。';
  if (argument !== 'default' && !model) return '模型不存在，请通过 /models 查看列表，再发送 /model 编号或模型ID。';
  await registry.configureConversation(appId, conversation, { model: argument === 'default' ? '' : model!.id });
  return `已切换到${argument === 'default' ? ' Agent 默认模型' : `模型：${model!.id}`}，下一条任务生效。`;
}

export async function handleCommand(content: string, appId: string, conversation: string, registry: CommandRegistry, projects: ProjectRegistry, agents: AgentRegistry, sessions: SessionManager, reply: (text: string) => Promise<void>): Promise<boolean> {
  if (!content.startsWith('/')) return false;
  const match = /^(\/\S*)(?:\s+([\s\S]*))?$/.exec(content)!;
  const command = match[1];
  const argument = match[2]?.trim() || '';
  const binding = registry.getBinding(appId, conversation);
  let agent = binding?.agent ? agents.get(binding.agent) : undefined;
  const invalid = `指令无效。\n${help}`;
  if (argument && command !== '/project' && command !== '/model') {
    await reply(invalid);
    return true;
  }
  if (agent?.installed && (command === '/models' || (command === '/model' && argument !== 'default') || command === '/status')) {
    agent = await agents.loadModels(agent.id);
  }
  let response: string;
  switch (command) {
    case '/help':
      response = help;
      break;
    case '/status': {
      const sessionId = registry.getSession(appId, conversation);
      response = statusResponse(binding, agent, sessionId ? sessions.get(sessionId) : undefined);
      break;
    }
    case '/new':
      await registry.configureConversation(appId, conversation, {}, true);
      response = '已开启新对话，下一条消息将创建会话。历史记录已保留。';
      break;
    case '/projects': {
      const paths = projects.list();
      response = paths.length ? paths.map((path, index) => `${index + 1}. ${basename(path)}\n${path}`).join('\n') + '\n使用 /project 编号或完整路径 切换项目。' : '暂无项目，请先在 Agent Muster 中添加项目。';
      break;
    }
    case '/project':
      response = await selectProject(argument, appId, conversation, registry, projects);
      break;
    case '/models':
      response = modelsResponse(agent);
      break;
    case '/model':
      response = await selectModel(argument, appId, conversation, registry, agent);
      break;
    default:
      response = invalid;
  }
  await reply(response);
  return true;
}
