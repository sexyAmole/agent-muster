import type { Server } from 'node:http';
import { spawn, type IPty } from 'node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { WebSocket, WebSocketServer } from 'ws';
import type { TerminalServerMessage } from './protocol.js';

const { Terminal } = headless;
const { SerializeAddon } = serialize;

type ProjectTerminal = {
  process: IPty;
  screen: InstanceType<typeof Terminal>;
  serializer: InstanceType<typeof SerializeAddon>;
  clients: Set<WebSocket>;
  exitCode?: number;
  disposed: boolean;
};

function send(socket: WebSocket, message: TerminalServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 1024 * 1024) {
    socket.close(1013, '终端输出过快，请重新连接');
    return;
  }
  socket.send(JSON.stringify(message));
}

export function attachTerminalServer(server: Server, knownProject: (path: string) => boolean, desktopToken?: string) {
  const terminals = new Map<string, ProjectTerminal>();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  function broadcast(terminal: ProjectTerminal, message: TerminalServerMessage): void {
    for (const socket of terminal.clients) send(socket, message);
  }

  function closeProject(path: string): void {
    const terminal = terminals.get(path);
    if (!terminal) return;
    terminals.delete(path);
    terminal.disposed = true;
    if (terminal.exitCode === undefined) terminal.process.kill();
    for (const socket of terminal.clients) {
      send(socket, { type: 'exit', exitCode: terminal.exitCode });
      socket.close(1000);
    }
    terminal.screen.dispose();
  }

  function createTerminal(path: string): ProjectTerminal {
    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL;
    if (!shell) throw new Error('未设置 SHELL，无法启动终端');
    const child = spawn(shell, process.platform === 'win32' ? ['-NoLogo'] : ['-l'], {
      cwd: path, cols: 80, rows: 24, name: 'xterm-256color',
      env: { ...process.env, PWD: path },
    });
    const screen = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer);
    const terminal: ProjectTerminal = { process: child, screen, serializer, clients: new Set(), disposed: false };
    terminals.set(path, terminal);
    // 在输出解析完成后再广播，保证重新连接时的屏幕快照与后续输出顺序一致。
    child.onData(data => {
      if (terminal.disposed) return;
      child.pause();
      screen.write(data, () => {
        if (terminal.disposed) return;
        broadcast(terminal, { type: 'output', data });
        child.resume();
      });
    });
    child.onExit(({ exitCode }) => {
      if (terminal.disposed) return;
      screen.write('', () => {
        if (terminal.disposed) return;
        terminal.exitCode = exitCode;
        closeProject(path);
      });
    });
    return terminal;
  }

  server.on('upgrade', (request, socket, head) => {
    if (request.url?.split('?')[0] !== '/api/terminals') return;
    const url = new URL(request.url, 'http://127.0.0.1');
    const address = server.address();
    const host = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : '';
    const authorized = request.headers.host === host && (desktopToken
      ? url.searchParams.get('desktopToken') === desktopToken && request.headers.origin === 'null'
      : request.headers.origin === `http://${host}`);
    const path = url.searchParams.get('path');
    if (!authorized || !path || !knownProject(path)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, client => {
      sockets.emit('connection', client, request);
      client.on('error', () => client.terminate());
      try {
        const terminal = terminals.get(path) ?? createTerminal(path);
        terminal.screen.write('', () => {
          if (terminal.disposed || client.readyState !== WebSocket.OPEN) return;
          send(client, { type: 'ready', cols: terminal.screen.cols, rows: terminal.screen.rows, data: terminal.serializer.serialize() });
          terminal.clients.add(client);
        });
        client.on('close', () => terminal.clients.delete(client));
        client.on('message', (raw, binary) => {
          try {
            if (binary || !knownProject(path) || terminal.disposed) throw new Error('终端连接已失效');
            const message: unknown = JSON.parse(raw.toString());
            if (!message || typeof message !== 'object' || !('type' in message)) throw new Error('终端消息无效');
            if (terminal.exitCode !== undefined) {
              throw new Error('终端已退出，请新建终端');
            } else if (message.type === 'input' && 'data' in message && typeof message.data === 'string') {
              terminal.process.write(message.data);
            } else if (message.type === 'resize' && 'cols' in message && 'rows' in message
              && Number.isInteger(message.cols) && Number.isInteger(message.rows)
              && typeof message.cols === 'number' && typeof message.rows === 'number'
              && message.cols >= 2 && message.cols <= 500 && message.rows >= 1 && message.rows <= 200) {
              const { cols, rows } = message;
              terminal.screen.write('', () => {
                if (terminal.disposed) return;
                terminal.process.resize(cols, rows);
                terminal.screen.resize(cols, rows);
                broadcast(terminal, { type: 'resize', cols, rows });
              });
            } else {
              throw new Error('终端消息无效');
            }
          } catch (error) {
            send(client, { type: 'error', message: (error as Error).message });
          }
        });
      } catch (error) {
        send(client, { type: 'error', message: `启动终端失败：${(error as Error).message}` });
        client.close(1011);
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of sockets.clients) {
      if (!alive.has(client)) { client.terminate(); continue; }
      alive.delete(client);
      client.ping();
    }
  }, 30000);
  heartbeat.unref();
  const alive = new WeakSet<WebSocket>();
  sockets.on('connection', client => {
    alive.add(client);
    client.on('pong', () => alive.add(client));
  });

  return {
    closeProject,
    shutdown: () => {
      clearInterval(heartbeat);
      for (const path of terminals.keys()) closeProject(path);
      for (const client of sockets.clients) client.terminate();
      sockets.close();
    },
  };
}
