const agentIcons: Record<string, string> = {
  codex: new URL('./assets/agents/codex.svg', import.meta.url).href,
  claude: new URL('./assets/agents/claude.svg', import.meta.url).href,
  cursor: new URL('./assets/agents/cursor.svg', import.meta.url).href,
  gemini: new URL('./assets/agents/gemini.svg', import.meta.url).href,
  kimi: new URL('./assets/agents/kimi.svg', import.meta.url).href,
  opencode: new URL('./assets/agents/opencode.svg', import.meta.url).href,
  pi: new URL('./assets/agents/pi.svg', import.meta.url).href,
};

export function AgentIcon({ agent, className }: { agent: string; className?: string }) {
  return <img className={`agent-icon${className ? ` ${className}` : ''}`} src={agentIcons[agent]} alt="" aria-hidden="true" />;
}
