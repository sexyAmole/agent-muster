import agentManagement from '../../../docs/screenshots/agent-management.jpg';
import agentSelector from '../../../docs/screenshots/agent-selector.jpg';
import imIntegration from '../../../docs/screenshots/im-integration.jpg';
import multiPane from '../../../docs/screenshots/multi-pane.jpg';
import claude from '../../src/shared/assets/agents/claude.svg';
import codex from '../../src/shared/assets/agents/codex.svg';
import cursor from '../../src/shared/assets/agents/cursor.svg';
import gemini from '../../src/shared/assets/agents/gemini.svg';
import kimi from '../../src/shared/assets/agents/kimi.svg';
import opencode from '../../src/shared/assets/agents/opencode.svg';
import pi from '../../src/shared/assets/agents/pi.svg';

export const repository = 'https://github.com/sexyAmole/agent-muster';
export const documentation = `${repository}/blob/main/README.zh-CN.md`;
export const agents = [
  { name: 'Codex', icon: codex },
  { name: 'Claude Code', icon: claude },
  { name: 'Pi', icon: pi },
  { name: 'Kimi CLI', icon: kimi },
  { name: 'Gemini CLI', icon: gemini },
  { name: 'OpenCode', icon: opencode },
  { name: 'Cursor', icon: cursor },
];
export const features = [
  {
    label: '多窗口会话',
    title: '任务并行，上下文各自清晰',
    description: '单窗、双栏、四宫格，按任务安排你的工作台。每个窗口独立选择项目和会话。',
    detail: '按项目保存对话记录，随时继续已有任务，实时查看回复、工具调用与执行状态。',
    image: multiPane,
    alt: '四宫格会话布局，每个窗口独立选择项目与 Agent',
    anchor: '创建第一个任务',
    link: '了解如何创建任务',
  },
  {
    label: 'Agent 管理',
    title: '不同 Agent，统一管理',
    description: '自动检测本机 Agent CLI，集中查看安装状态、版本与命令路径，直接安装、更新或卸载。',
    detail: '选择适合任务的 Agent 与模型，延续已有的登录和模型配置。',
    image: agentManagement,
    alt: 'Agent 管理界面中的版本、安装状态与管理操作',
    anchor: '功能',
    link: '查看支持的 Agent',
  },
  {
    label: 'IM 集成',
    title: '任务，从一条消息开始',
    description: '扫码接入钉钉或飞书，将应用绑定项目和 Agent。在单聊或群聊中发起任务，结果回到原对话。',
    detail: '同一聊天继续已有会话，支持通过指令切换项目和模型。保持本地服务运行，无需公网地址。',
    image: imIntegration,
    alt: '钉钉和飞书应用的扫码接入界面',
    anchor: 'im-集成',
    link: '了解消息平台接入',
  },
  {
    label: '本地工作',
    title: '工作在本地，选择在你手中',
    description: '项目与对话记录保存在本机，Agent 在你选择的项目目录中执行任务。',
    detail: '继续使用各 Agent 自己的登录与模型配置。Agent Muster 负责把工作组织起来。',
    image: agentSelector,
    alt: '在本地项目中选择 Agent 和模型创建任务',
    anchor: '本地数据',
    link: '查看本地数据说明',
  },
];
export const installMethods = [
  { label: '直接运行', command: 'npx agent-muster', description: '无需全局安装，在终端执行后自动打开本地工作台。' },
  { label: '全局安装', command: 'npm install -g agent-muster\nagent-muster', description: '安装后，随时使用 agent-muster 命令启动工作台。' },
];

