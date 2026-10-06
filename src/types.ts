export type SessionStatus = 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';

export interface AgentInfo {
  id: string;
  name: string;
  command: string;
  installed: boolean;
  models: ModelInfo[];
  defaultModel?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentImage {
  type: 'image';
  mimeType: string;
  data: string;
  path: string;
}

export interface DingTalkConversation {
  type: 'single' | 'group';
  groupName?: string;
  senderName: string;
  senderStaffId: string;
}

export type FeishuConversation = { type: 'single' | 'group'; senderId: string };

export interface SessionEvent {
  id: number;
  type: 'output' | 'status' | 'error' | 'warning' | 'message' | 'dingtalk_message' | 'feishu_message' | 'tool' | 'file_change' | 'usage';
  text: string;
  detail?: string;
  kind?: string;
  comparison?: string;
  timestamp: number;
  dingtalkConversation?: DingTalkConversation;
  feishuConversation?: FeishuConversation;
}

export interface AgentSession {
  id: string;
  agent: string;
  dingtalkAppId?: string;
  feishuAppId?: string;
  dingtalkConversation?: DingTalkConversation;
  feishuConversation?: FeishuConversation;
  cwd: string;
  prompt: string;
  model?: string;
  usage?: TokenUsage;
  externalSessionId?: string;
  pid?: number;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  events: SessionEvent[];
}
