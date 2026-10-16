import { AgentRegistry } from '../agents/registry.js';
import { setDebugEnabled } from '../debug.js';
import { DingTalkRegistry } from '../integrations/dingtalk/registry.js';
import { FeishuRegistry } from '../integrations/feishu/registry.js';
import { WecomRegistry } from '../integrations/wecom/registry.js';
import { ProjectRegistry } from '../projects/registry.js';
import { SessionManager } from '../sessions/manager.js';
import { printAgents, printHelp, printSessions, printVersion } from './commands.js';
import { parseArgs } from './options.js';
import { updatePackage } from './updates.js';
import { startWeb } from './web.js';

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    await printVersion();
    return;
  }
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    printHelp();
    return;
  }
  const options = parseArgs(args);
  setDebugEnabled(options.debug);
  const { command } = options;
  if (command === 'update') {
    await updatePackage();
    return;
  }
  const registry = new AgentRegistry();
  await registry.scan();
  const sessions = new SessionManager();
  await sessions.load();
  const projects = new ProjectRegistry();
  await projects.load();
  const dingtalk = new DingTalkRegistry();
  await dingtalk.load();
  const feishu = new FeishuRegistry();
  await feishu.load();
  const wecom = new WecomRegistry();
  await wecom.load();

  if (command === 'agents') {
    printAgents(registry);
    return;
  }
  if (command === 'sessions') {
    printSessions(sessions);
    return;
  }
  await startWeb(options, registry, sessions, projects, dingtalk, feishu, wecom);
}
