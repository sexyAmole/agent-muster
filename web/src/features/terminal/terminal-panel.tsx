import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import type { TerminalClientMessage, TerminalServerMessage } from '../../../../src/terminals/protocol';
import { apiUrl } from '../../shared/lib/api-url';
import './terminal-panel.css';

type ConnectionState = 'connecting' | 'running' | 'exited' | 'disconnected';

export function TerminalPanel({ project }: { project: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [message, setMessage] = useState('正在连接终端…');

  useEffect(() => {
    let disposed = false;
    let ready = false;
    let exited = false;
    let failed = false;
    let pendingCharacters = 0;
    let frame = 0;
    setState('connecting');
    setMessage('正在连接终端…');
    const terminal = new Terminal({
      cursorBlink: true, fontSize: 12, fontFamily: 'Menlo, Monaco, Consolas, monospace',
      scrollback: 1000, screenReaderMode: true,
      theme: { background: '#ffffff', foreground: '#303030', cursor: '#555555', selectionBackground: '#dce5ed', black: '#303030', brightBlack: '#737373' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current!);
    terminal.textarea?.setAttribute('aria-label', '终端输入');
    terminal.options.disableStdin = true;
    const url = new URL(apiUrl(`/api/terminals?${new URLSearchParams({ path: project })}`), window.location.href);
    url.protocol = 'ws:';
    const socket = new WebSocket(url);

    function send(value: TerminalClientMessage): void {
      if (ready && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
    }
    function resize(): void {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed || !ready || exited || !container.current?.clientWidth || !container.current.clientHeight) return;
        const dimensions = fit.proposeDimensions();
        if (!dimensions) return;
        const cols = Math.max(2, Math.min(500, dimensions.cols));
        const rows = Math.max(1, Math.min(200, dimensions.rows));
        if (terminal.cols === cols && terminal.rows === rows) return;
        terminal.resize(cols, rows);
        send({ type: 'resize', cols, rows });
      });
    }
    function write(data: string, done?: () => void): void {
      pendingCharacters += data.length;
      if (pendingCharacters > 2 * 1024 * 1024) {
        failed = true;
        setMessage('终端输出过快，连接已暂停，请重新连接');
        socket.close();
        return;
      }
      terminal.write(data, () => {
        pendingCharacters -= data.length;
        if (!disposed) done?.();
      });
    }
    socket.addEventListener('message', event => {
      if (disposed) return;
      const data = JSON.parse(event.data) as TerminalServerMessage;
      if (data.type === 'ready') {
        terminal.resize(data.cols, data.rows);
        write(data.data, () => {
          ready = true;
          if (exited || socket.readyState !== WebSocket.OPEN) return;
          terminal.options.disableStdin = false;
          setState('running');
          setMessage('');
          resize();
          if (!document.activeElement?.closest('[role="tablist"]')) terminal.focus();
        });
      } else if (data.type === 'output') {
        write(data.data);
      } else if (data.type === 'resize') {
        terminal.resize(data.cols, data.rows);
      } else if (data.type === 'exit') {
        exited = true;
        terminal.options.disableStdin = true;
        setState('exited');
        setMessage(data.exitCode === undefined ? '终端已关闭' : `终端已退出，退出码 ${data.exitCode}`);
      } else if (data.type === 'error') {
        failed = true;
        setMessage(data.message);
      }
    });
    socket.addEventListener('error', () => {
      if (disposed) return;
      failed = true;
      setMessage('终端连接失败，请重新连接');
    });
    socket.addEventListener('close', event => {
      ready = false;
      if (disposed || exited) return;
      terminal.options.disableStdin = true;
      setState('disconnected');
      if (!failed) setMessage(event.reason || '终端连接已断开，请重新连接');
    });
    const input = terminal.onData(data => {
      for (const [chunk] of data.matchAll(/[\s\S]{1,4096}/gu)) send({ type: 'input', data: chunk });
    });
    terminal.attachCustomKeyEventHandler(event => {
      if (event.key === 'Tab' && event.shiftKey) return false;
      if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true;
      if (event.code === 'KeyC') {
        event.preventDefault();
        void navigator.clipboard.writeText(terminal.getSelection()).catch(() => {
          if (!disposed) setMessage('复制失败，请检查剪贴板权限');
        });
        return false;
      }
      if (event.code === 'KeyV') {
        event.preventDefault();
        void navigator.clipboard.readText().then(text => { if (!disposed && ready && !exited) terminal.paste(text); }).catch(() => {
          if (!disposed) setMessage('粘贴失败，请检查剪贴板权限');
        });
        return false;
      }
      return true;
    });
    const observer = new ResizeObserver(resize);
    observer.observe(container.current!);
    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      input.dispose();
      socket.close();
      terminal.dispose();
    };
  }, [project, revision]);

  return <section className="terminal-panel" aria-label="项目终端">
    {message && <div className="terminal-toolbar">
      <p className={`terminal-status${state === 'disconnected' ? ' file-panel-error' : ''}`} role="status">{message}</p>
      <div className="file-panel-actions">
        {(state === 'exited' || state === 'disconnected') && <button type="button" aria-label={state === 'exited' ? '新建终端' : '重新连接终端'} onClick={() => setRevision(value => value + 1)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{state === 'exited' ? <path d="M12 5v14M5 12h14" /> : <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 6.1A8 8 0 0 1 19.7 10M4.3 14A8 8 0 0 0 17.9 17.9" /></>}</svg></button>}
      </div>
    </div>}
    <div className="terminal-viewport" ref={container} />
  </section>;
}
