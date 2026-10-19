import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { WebContents } from 'electron';
import { loadRuntime, startRuntime } from '../runtime.js';
import { fullScreenChannel, windowControlChannel } from './window-controls.js';

const execute = promisify(execFile);
let mainWindow: BrowserWindow | undefined;
let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
let quitting = false;

async function restoreShellPath(): Promise<void> {
  if (process.platform === 'win32') return;
  const loginShell = process.env.SHELL;
  if (!loginShell) throw new Error('未设置 SHELL，无法读取终端中的命令路径');
  const { stdout } = await execute(loginShell, ['-ilc', 'printf "\\0%s\\0" "$PATH"'], { timeout: 10000 });
  const path = stdout.split('\0')[1];
  if (!path) throw new Error('无法读取终端中的 PATH');
  process.env.PATH = path;
}

function openExternal(url: string): void {
  const { protocol } = new URL(url);
  if (protocol === 'https:' || protocol === 'http:') {
    void shell.openExternal(url).catch(error => dialog.showErrorBox('无法打开链接', error.message));
  }
}

function configureContents(contents: WebContents, origin: string): void {
  contents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === origin) return;
    event.preventDefault();
    openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === origin) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } } };
    }
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('did-create-window', window => configureContents(window.webContents, origin));
}

app.setName('Agent Muster');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });

  const startup = app.whenReady().then(async () => {
    const icon = app.isPackaged ? join(process.resourcesPath, 'icon.png') : resolve(import.meta.dirname, '../../resources/desktop/icon.png');
    if (app.dock) app.dock.setIcon(icon);
    await restoreShellPath();
    process.chdir(homedir());
    runtime = await startRuntime(await loadRuntime(), 0);
    if (quitting) return;
    mainWindow = new BrowserWindow({
      title: 'Agent Muster',
      icon,
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' as const } : {}),
      width: 1280,
      height: 840,
      minWidth: 720,
      minHeight: 540,
      show: false,
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: join(import.meta.dirname, 'preload.cjs') },
    });
    if (process.platform === 'darwin') {
      mainWindow.setWindowButtonVisibility(false);
      mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send(fullScreenChannel, true));
      mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send(fullScreenChannel, false));
      ipcMain.on(windowControlChannel, (event, action: unknown) => {
        if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return;
        if (action === 'close') mainWindow.close();
        if (action === 'minimize' && !mainWindow.isFullScreen()) mainWindow.minimize();
        if (action === 'toggle-fullscreen') mainWindow.setFullScreen(!mainWindow.isFullScreen());
      });
    }
    configureContents(mainWindow.webContents, runtime.url);
    mainWindow.once('ready-to-show', () => mainWindow?.show());
    mainWindow.on('closed', () => { mainWindow = undefined; });
    await mainWindow.loadURL(runtime.url);
  }).catch(error => {
    dialog.showErrorBox('Agent Muster 启动失败', error.message);
    process.exitCode = 1;
    app.quit();
  });

  app.on('window-all-closed', () => app.quit());
  process.once('SIGINT', () => app.quit());
  process.once('SIGTERM', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void startup.then(async () => {
      await runtime?.shutdown();
      app.quit();
    }).catch(error => {
      dialog.showErrorBox('Agent Muster 退出失败', error.message);
      app.exit(1);
    });
  });
}
