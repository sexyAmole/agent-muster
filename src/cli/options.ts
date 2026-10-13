export interface CliOptions {
  command: 'web' | 'agents' | 'sessions' | 'update';
  port: number;
  open: boolean;
  dev: boolean;
}

export function parseArgs(args: string[]): CliOptions {
  const command = args[0] && !args[0].startsWith('-') ? args[0] : 'web';
  const options = command === args[0] ? args.slice(1) : args;
  if (command !== 'web' && command !== 'agents' && command !== 'sessions' && command !== 'update') {
    throw new Error(`未知命令：${command}。运行 agent-muster --help 查看帮助。`);
  }
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (command === 'web') {
      if (option === '--no-open' || option === '--dev') continue;
      if (option === '--port' || option === '-p') {
        const value = options[++index];
        if (!value || !/^\d+$/.test(value)) throw new Error(`${option} 需要指定 1–65535 之间的整数端口。`);
        continue;
      }
    }
    throw new Error(`未知参数：${option}。运行 agent-muster --help 查看帮助。`);
  }
  const portIndex = options.findIndex(option => option === '--port' || option === '-p');
  const port = portIndex >= 0 ? Number(options[portIndex + 1]) : 17321;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535 之间的整数。');
  return { command, port, open: !options.includes('--no-open'), dev: options.includes('--dev') };
}
