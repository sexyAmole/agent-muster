import { setDebugEnabled } from '../debug.js';
import { loadRuntime } from '../runtime.js';
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
  const { registry, sessions, projects, dingtalk, feishu, wecom, weixin } = await loadRuntime();

  if (command === 'agents') {
    printAgents(registry);
    return;
  }
  if (command === 'sessions') {
    printSessions(sessions);
    return;
  }
  await startWeb(options, registry, sessions, projects, dingtalk, feishu, wecom, weixin);
}
