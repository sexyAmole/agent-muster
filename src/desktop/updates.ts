import { dialog, ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import type { ProgressInfo } from 'electron-updater';
import { checkUpdateChannel, downloadUpdateChannel, installUpdateChannel, updateProgressChannel } from './update-api.js';

const { autoUpdater } = electronUpdater;

export function registerDesktopUpdates(window: BrowserWindow, installUpdate: () => void): void {
  if (process.platform !== 'darwin') return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.disableDifferentialDownload = false;

  let availableUpdate: Promise<string | null> | undefined;
  let downloading = false;
  let downloaded = false;
  const progress = (percent: number) => {
    if (window.isDestroyed()) return;
    window.setProgressBar(percent / 100);
    window.webContents.send(updateProgressChannel, percent);
  };
  const onProgress = ({ percent }: ProgressInfo) => progress(Math.min(99, Math.floor(percent)));
  const onError = (error: Error) => console.warn('桌面更新失败：', error.message);
  autoUpdater.on('download-progress', onProgress);
  autoUpdater.on('error', onError);

  ipcMain.handle(checkUpdateChannel, async event => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效的更新请求');
    availableUpdate ??= autoUpdater.checkForUpdates().then(result => result?.isUpdateAvailable ? result.updateInfo.version : null);
    return availableUpdate;
  });
  ipcMain.handle(downloadUpdateChannel, async event => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效的更新请求');
    if (downloading || downloaded) return downloaded;
    downloading = true;
    try {
      if (!await availableUpdate) throw new Error('尚未检测到可下载的新版本，请重新打开应用后重试。');
      progress(0);
      await autoUpdater.downloadUpdate();
      downloaded = true;
      progress(100);
      return true;
    } catch (error) {
      if (!window.isDestroyed()) await dialog.showMessageBox(window, { type: 'error', message: '更新失败', detail: `${error instanceof Error ? error.message : String(error)}\n请点击更新按钮重新下载。`, buttons: ['关闭'] });
      return false;
    } finally {
      downloading = false;
      if (!window.isDestroyed()) window.setProgressBar(-1);
    }
  });
  ipcMain.handle(installUpdateChannel, async event => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效的更新请求');
    if (!downloaded) throw new Error('请先下载新版本。');
    const { response } = await dialog.showMessageBox(window, {
      type: 'info', message: '新版本已下载，是否重启安装？', detail: '重启将结束正在运行的任务，请确认任务已完成。',
      buttons: ['重启并安装', '稍后安装'], defaultId: 1, cancelId: 1,
    });
    if (response === 0) installUpdate();
  });
  window.once('closed', () => {
    ipcMain.removeHandler(checkUpdateChannel);
    ipcMain.removeHandler(downloadUpdateChannel);
    ipcMain.removeHandler(installUpdateChannel);
    autoUpdater.removeListener('download-progress', onProgress);
    autoUpdater.removeListener('error', onError);
  });
}
