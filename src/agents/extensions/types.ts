export const extensionAgents = {
  codex: 'Codex', claude: 'Claude Code', pi: 'Pi', gemini: 'Gemini CLI',
  opencode: 'OpenCode', cursor: 'Cursor', kimi: 'Kimi Code CLI',
  dsh: 'DeepSeek Harness', qodercn: 'Qoder CLI CN', workbuddy: 'WorkBuddy',
} as const;
export type ExtensionAgent = keyof typeof extensionAgents;
export type McpTransport = 'stdio' | 'http' | 'sse' | 'ws';

export const extensionTransports: Record<ExtensionAgent, readonly McpTransport[]> = {
  codex: ['stdio', 'http'], claude: ['stdio', 'http', 'sse', 'ws'],
  pi: ['stdio', 'http'], gemini: ['stdio', 'http', 'sse'],
  opencode: ['stdio', 'http'], cursor: ['stdio', 'http', 'sse'],
  kimi: ['stdio', 'http', 'sse'], dsh: ['stdio', 'http'],
  qodercn: ['stdio', 'http', 'sse', 'ws'], workbuddy: ['stdio', 'http', 'sse'],
};

export interface LocalSkill {
  name: string;
  path: string;
}

export interface McpServer {
  name: string;
  source?: string;
  transport: string;
  enabled?: boolean;
  revision: string;
}

export interface McpServerConfig {
  config: Record<string, unknown>;
  revision: string;
}
