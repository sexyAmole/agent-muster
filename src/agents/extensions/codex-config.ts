import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

type RpcResponse = { id?: number; error?: unknown; result?: unknown };

export async function withCodexConfig<T>(operation: (request: (method: string, params: unknown) => Promise<unknown>) => Promise<T>): Promise<T> {
  const child = spawn('codex', ['app-server'], { cwd: homedir(), stdio: ['pipe', 'pipe', 'ignore'], shell: process.platform === 'win32', windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const messages = lines[Symbol.asyncIterator]();
  let sequence = 0;
  let failure = 'Codex 配置进程已退出，请检查 CLI 和用户配置目录';
  const timer = setTimeout(() => {
    failure = 'Codex 配置请求超时，请重试';
    child.kill();
  }, 15000);
  child.on('error', error => {
    failure = (error as NodeJS.ErrnoException).code === 'ENOENT' ? '请先安装 Codex CLI' : '无法启动 Codex 配置进程';
    lines.close();
  });
  child.stdin.on('error', () => lines.close());
  function send(message: object) {
    child.stdin.write(JSON.stringify(message) + '\n');
  }
  async function request(method: string, params: unknown): Promise<unknown> {
    const id = ++sequence;
    send({ id, method, params });
    for (;;) {
      const line = await messages.next();
      if (line.done) throw new Error(failure);
      let response: RpcResponse;
      try { response = JSON.parse(line.value); }
      catch { throw new Error('Codex 配置进程返回了无效的响应'); }
      if (response.id !== id) continue;
      if (response.error) {
        throw new Error(method === 'config/value/write' ? 'Codex 未保存配置，请刷新列表并检查配置格式' : '无法读取 Codex 配置，请检查 Codex CLI 和用户配置');
      }
      return response.result;
    }
  }
  try {
    await request('initialize', { clientInfo: { name: 'agent_muster', version: '0.1.0' } });
    send({ method: 'initialized' });
    return await operation(request);
  } finally {
    clearTimeout(timer);
    lines.close();
    child.kill();
  }
}
