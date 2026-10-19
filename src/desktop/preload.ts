import { contextBridge, ipcRenderer } from 'electron';
import { fullScreenChannel, windowControlChannel } from './window-controls.js';
import type { DesktopRuntimeConfig, DesktopWindowApi } from './window-controls.js';
import { checkUpdateChannel, updateProgressChannel } from './update-api.js';
import type { DesktopUpdateApi } from './update-api.js';

const configArgument = process.argv.find(argument => argument.startsWith('--agent-muster-runtime='));
if (!configArgument) throw new Error('缺少桌面服务配置');
const runtime: DesktopRuntimeConfig = JSON.parse(configArgument.slice('--agent-muster-runtime='.length));
contextBridge.exposeInMainWorld('desktopRuntime', runtime);

if (process.platform === 'darwin') {
  const updates: DesktopUpdateApi = {
    check: () => ipcRenderer.invoke(checkUpdateChannel),
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
