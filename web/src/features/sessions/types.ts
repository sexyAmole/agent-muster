import type { AgentInfo as Agent, AgentSession as Session } from '../../../../src/types';
import type { Application } from '../integrations/im-panel';

export type FeishuApp = Pick<Application, 'id' | 'icon'>;
export type SessionSummary = Omit<Session, 'events'>;
export type PaneState = { sessionId: string | null; cwd: string; revision: number };
export type PaneProps = {
  index: number;
  pane: PaneState;
  panelProject: string | null;
  multi: boolean;
  active: boolean;
  agents: Agent[];
  projects: string[];
  sessions: SessionSummary[];
  feishuApps: FeishuApp[];
  onFocus: (index: number) => void;
  pickingProject: boolean;
  onAddProject: (index: number) => Promise<void>;
  onProjectChange: (index: number, path: string) => void;
  onSessionCreated: (index: number, session: SessionSummary) => void;
  onSessionUpdate: (session: Pick<Session, 'id' | 'status' | 'updatedAt'> & Partial<Pick<Session, 'externalSessionId' | 'permissionMode' | 'sandboxEnabled'>>) => void;
};
export type ChatPaneProps = PaneProps;
