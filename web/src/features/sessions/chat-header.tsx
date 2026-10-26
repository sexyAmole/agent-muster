import React, { useContext } from 'react';
import type { AgentSession as Session } from '../../../../src/types';
import { AppIcon } from '../../shared/components/app-icon';
import { AgentIcon } from '../agents/agent-icon';
import { RunLog } from './run-log';
import { projectLabel, ProjectNamesContext } from '../projects/project-label';
import type { PaneProps } from './types';

type ChatHeaderProps = Pick<PaneProps, 'index' | 'multi' | 'projects' | 'feishuApps'> & {
  selected: Session | null;
  copiedTarget: 'conversation' | 'run-log' | number | null;
  copyConversation: () => Promise<void>;
  copyText: (text: string, target: 'conversation' | 'run-log' | number) => Promise<void>;
  panelControls?: React.ReactNode;
};

export function ChatHeader({ index, multi, projects, feishuApps, selected, copiedTarget, copyConversation, copyText, panelControls }: ChatHeaderProps) {
  const projectNames = useContext(ProjectNamesContext);
  const dingtalkBinding = selected?.im?.find(binding => binding.platform === 'dingtalk');
  const feishuBinding = selected?.im?.find(binding => binding.platform === 'feishu');
  const wecomBinding = selected?.im?.find(binding => binding.platform === 'wecom');
  const weixinBinding = selected?.im?.find(binding => binding.platform === 'weixin');
  const feishuIcon = feishuApps.find(app => app.id === feishuBinding?.appId)?.icon;

  return <div className="chat-header">
    {selected && <span className="conversation-icon chat-session-icon">{weixinBinding && <AppIcon className="conversation-app-icon" fallbackClassName="feishu-app-mark" platform="微信" />}{wecomBinding && <AppIcon className="conversation-app-icon" fallbackClassName="feishu-app-mark" platform="企业微信" />}{dingtalkBinding && <AppIcon className="conversation-app-icon" fallbackClassName="feishu-app-mark" src={`/api/dingtalk/apps/${dingtalkBinding.appId}/icon`} platform="钉钉" />}{feishuBinding && <AppIcon className="conversation-app-icon" fallbackClassName="feishu-app-mark" src={feishuIcon} platform="飞书" />}<AgentIcon agent={selected.agent} className={dingtalkBinding || feishuBinding || wecomBinding || weixinBinding ? 'conversation-agent-badge' : undefined} /></span>}
    <div className="chat-heading">{selected
      ? <><strong title={selected.title ?? selected.prompt}>{selected.title ?? selected.prompt}</strong>{multi && <p>{projectLabel(selected.cwd, projects, projectNames)}</p>}</>
      : <><strong>新对话</strong>{multi && <p>窗口 {index + 1} · 从侧边栏选择对话</p>}</>}{dingtalkBinding?.conversation && <p className="chat-source">{dingtalkBinding.conversation.type === 'group' ? '群聊' : '单聊'}{dingtalkBinding.conversation.type === 'group' && dingtalkBinding.conversation.groupName && ` · 群名称：${dingtalkBinding.conversation.groupName}`} · 提问人：<span title={dingtalkBinding.conversation.senderStaffId}>{dingtalkBinding.conversation.senderName}</span></p>}{weixinBinding?.conversation && <p className="chat-source">微信 · 单聊 · 提问人：{weixinBinding.conversation.senderId}</p>}{wecomBinding?.conversation && <p className="chat-source">企业微信 · {wecomBinding.conversation.type === 'group' ? '群聊' : '单聊'} · 提问人：{wecomBinding.conversation.senderId}</p>}{feishuBinding?.conversation && <p className="chat-source">飞书 · {feishuBinding.conversation.type === 'group' ? '群聊' : '单聊'} · 提问人：{feishuBinding.conversation.senderId}</p>}</div>
    <div className="output-actions">
      {selected && <button className="copy-button" onClick={() => void copyConversation()} aria-label={copiedTarget === 'conversation' ? '已复制对话' : '复制对话'}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{copiedTarget === 'conversation' ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" /></>}</svg></button>}
      {selected && <RunLog key={selected.id} sessionId={selected.id} copied={copiedTarget === 'run-log'} onCopy={copyText} />}
      {panelControls}
    </div>
  </div>;
}
