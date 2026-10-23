const agentIcons: Record<string, string> = {
  codex: new URL('../../shared/assets/agents/codex.svg', import.meta.url).href,
  claude: new URL('../../shared/assets/agents/claude.svg', import.meta.url).href,
  cursor: new URL('../../shared/assets/agents/cursor.svg', import.meta.url).href,
  gemini: new URL('../../shared/assets/agents/gemini.svg', import.meta.url).href,
  opencode: new URL('../../shared/assets/agents/opencode.svg', import.meta.url).href,
  pi: new URL('../../shared/assets/agents/pi.svg', import.meta.url).href,
  workbuddy: new URL('../../shared/assets/agents/workbuddy.png', import.meta.url).href,
  trae: new URL('../../shared/assets/agents/trae.png', import.meta.url).href,
  qodercn: new URL('../../shared/assets/agents/qodercn.svg', import.meta.url).href,
};

export function AgentIcon({ agent, className }: { agent: string; className?: string }) {
  return <img className={`agent-icon${className ? ` ${className}` : ''}`} src={agentIcons[agent]} alt="" aria-hidden="true" />;
}
