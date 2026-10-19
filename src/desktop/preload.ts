import { contextBridge, ipcRenderer } from 'electron';
import { fullScreenChannel, windowControlChannel } from './window-controls.js';
import type { DesktopWindowApi } from './window-controls.js';

if (process.platform === 'darwin') {
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
