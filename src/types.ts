export type SessionStatus = 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';

export interface ProjectFileEntry {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'symlink' | 'other';
}

export interface ProjectFileDetail {
  path: string;
  type: string;
  size: number;
  modifiedAt: number;
  preview: 'text' | 'binary' | 'too-large' | 'unsupported';
  content?: string;
}

export interface PermissionMode {
  id: string;
  name: string;
  description: string;
}

export interface AgentInfo {
  sandboxSupported: boolean;
  sandboxEnabled: boolean;
  permissionModes: PermissionMode[];
  id: string;
  name: string;
  command: string;
  installed: boolean;
  path?: string;
  version?: string;
  versionError?: string;
  models: ModelInfo[];
  defaultModel?: string;
}

export type AgentAction = 'install' | 'update' | 'uninstall';

export interface ManagedAgent extends AgentInfo {
  management?: 'npm' | 'cursor';
  managementError?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface SessionUsage extends TokenUsage {
  contextTokens?: number;
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

export type ImContext =
  | { platform: 'dingtalk'; conversation?: DingTalkConversation }
  | { platform: 'feishu'; conversation?: FeishuConversation }
  | { platform: 'wecom'; conversation?: { type: 'single' | 'group'; senderId: string } };

export type ImBinding = ImContext & { appId: string };

export interface SessionEvent {
  id: number;
  rawRecordId?: number;
  streamId?: string;
  order?: number;
  contentIndex?: number;
  streaming?: boolean;
  clearStreamIds?: string[];
  type: 'system' | 'thinking' | 'output' | 'status' | 'error' | 'warning' | 'message' | 'im_message' | 'tool' | 'file_change' | 'usage' | 'raw_stdout' | 'raw_stderr';
  text: string;
  detail?: string;
  kind?: string;
  comparison?: string;
  timestamp: number;
  pushedToIm?: boolean;
  im?: ImContext;
  images?: Pick<AgentImage, 'path' | 'mimeType'>[];
}

export interface ProjectGitChange {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
}

export interface ProjectGitStatus {
  repository: boolean;
  branch: string | null;
  commit: string | null;
  branches: { name: string; remote: boolean }[];
  changes: ProjectGitChange[];
}

export interface ProjectGitDiff {
  staged: string;
  unstaged: string;
  untracked: ProjectFileDetail | null;
}

export interface SessionLog {
  id: number;
  text: string;
  type?: string;
  timestamp?: number;
}

export interface SessionLogPage {
  supported: boolean;
  events: SessionLog[];
  hasMore: boolean;
}

export interface AgentSession {
  id: string;
  agent: string;
  im?: ImBinding[];
  cwd: string;
  prompt: string;
  title?: string;
  model?: string;
  permissionMode?: string;
  usage?: SessionUsage;
  externalSessionId?: string;
  pid?: number;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  events: SessionEvent[];
}
