import { contextBridge, ipcRenderer } from 'electron';
import { fullScreenChannel, runtimeConfigChannel, windowControlChannel } from './window-controls.js';
import type { DesktopRuntimeConfig, DesktopWindowApi } from './window-controls.js';
import { checkUpdateChannel, downloadUpdateChannel, installUpdateChannel, updateProgressChannel } from './update-api.js';
import type { DesktopUpdateApi } from './update-api.js';

const pageArgument = process.argv.find(argument => argument.startsWith('--agent-muster-page='));
if (!pageArgument) throw new Error('缺少桌面页面配置');
if (location.href === pageArgument.slice('--agent-muster-page='.length)) {
  const runtime: DesktopRuntimeConfig | null = ipcRenderer.sendSync(runtimeConfigChannel);
  if (!runtime) throw new Error('缺少桌面服务配置');
  contextBridge.exposeInMainWorld('desktopRuntime', runtime);
}

if (process.platform === 'darwin') {
  const updates: DesktopUpdateApi = {
    check: () => ipcRenderer.invoke(checkUpdateChannel),
    download: () => ipcRenderer.invoke(downloadUpdateChannel),
    install: () => ipcRenderer.invoke(installUpdateChannel),
    onProgress: listener => {
      const handle = (_event: Electron.IpcRendererEvent, percent: number) => listener(percent);
      ipcRenderer.on(updateProgressChannel, handle);
      return () => { ipcRenderer.removeListener(updateProgressChannel, handle); };
    },
  };
  contextBridge.exposeInMainWorld('desktopUpdates', updates);
  const controls: DesktopWindowApi = {
    close: () => ipcRenderer.send(windowControlChannel, 'close'),
    minimize: () => ipcRenderer.send(windowControlChannel, 'minimize'),
    toggleFullScreen: () => ipcRenderer.send(windowControlChannel, 'toggle-fullscreen'),
    onFullScreenChange: listener => {
      const handle = (_event: Electron.IpcRendererEvent, fullScreen: boolean) => listener(fullScreen);
      ipcRenderer.on(fullScreenChannel, handle);
      return () => { ipcRenderer.removeListener(fullScreenChannel, handle); };
    },
  };
  contextBridge.exposeInMainWorld('desktopWindow', controls);
}
