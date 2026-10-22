import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { app, dialog, ipcMain, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { gt, valid } from 'semver';
import { checkUpdateChannel, downloadUpdateChannel, updateProgressChannel } from './update-api.js';

interface Release {
  tag_name: string;
  assets: { name: string; browser_download_url: string; size: number }[];
}

interface AvailableUpdate {
  version: string;
  asset: Release['assets'][number];
}

async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const response = await fetch('https://api.github.com/repos/sexyAmole/agent-muster/releases/latest', {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) throw new Error('尚未找到正式发布版本，请在 GitHub Releases 发布新版 DMG 后重试。');
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') throw new Error('GitHub 检查更新次数已达上限，请稍后重试。');
  if (!response.ok) throw new Error(`无法获取新版本（HTTP ${response.status}），请稍后重试。`);
  const release = await response.json() as Release;
  const latest = valid(release.tag_name);
  if (!latest) throw new Error('发布版本号无效，请使用 v0.1.17 这样的版本标签。');
  const current = app.getVersion();
  if (!gt(latest, current)) return null;
  const asset = release.assets.find(asset => asset.name.endsWith(`-${process.arch}.dmg`));
  if (!asset) throw new Error(`新版 ${latest} 尚未提供 ${process.arch === 'arm64' ? 'Apple 芯片' : 'Intel 芯片'} 的 DMG 安装包，请等待发布完成后重试。`);
  const downloadUrl = new URL(asset.browser_download_url);
  if (downloadUrl.origin !== 'https://github.com' || !downloadUrl.pathname.startsWith('/sexyAmole/agent-muster/releases/download/')) throw new Error('更新安装包地址无效。');
  return { version: latest, asset };
}

async function downloadUpdate(window: BrowserWindow, { version, asset }: AvailableUpdate): Promise<void> {
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: '保存新版安装包', defaultPath: join(app.getPath('downloads'), asset.name), filters: [{ name: 'DMG 安装包', extensions: ['dmg'] }],
  });
  if (canceled || !filePath) return;
  const temporaryPath = `${filePath}.${randomBytes(6).toString('hex')}.download`;
  const progress = (percent: number) => {
    if (window.isDestroyed()) return;
    window.setProgressBar(percent / 100);
    window.webContents.send(updateProgressChannel, percent);
  };
  try {
    progress(0);
    const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!download.ok || !download.body) throw new Error(`安装包下载失败（HTTP ${download.status}），请点击更新按钮重新下载。`);
    let received = 0;
    let lastPercent = 0;
    const reader = download.body.getReader();
    await pipeline(async function* () {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          const percent = Math.min(99, Math.floor(received / asset.size * 100));
          if (percent !== lastPercent) { lastPercent = percent; progress(percent); }
          yield value;
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    }(), createWriteStream(temporaryPath, { flags: 'wx' }));
    if (received !== asset.size) throw new Error('安装包下载不完整，请点击更新按钮重新下载。');
    await rename(temporaryPath, filePath);
    progress(100);
  } finally {
    if (!window.isDestroyed()) window.setProgressBar(-1);
    await rm(temporaryPath, { force: true });
  }
  if (window.isDestroyed()) return;
  const { response: action } = await dialog.showMessageBox(window, {
    type: 'info', message: `新版 ${version} 已下载`, detail: '请先结束正在运行的任务并退出 Agent Muster，再将 DMG 中的应用拖入“应用程序”替换旧版。未签名应用可能需要在系统设置的“隐私与安全性”中允许打开。',
    buttons: ['打开安装包', '在文件夹中显示', '稍后安装'], defaultId: 0, cancelId: 2,
  });
  if (action === 0) {
    const error = await shell.openPath(filePath);
    if (error) throw new Error(`无法打开安装包：${error}`);
  } else if (action === 1) shell.showItemInFolder(filePath);
}

export function registerDesktopUpdates(window: BrowserWindow): void {
  if (process.platform !== 'darwin') return;
  let availableUpdate: Promise<AvailableUpdate | null> | undefined;
  let downloading = false;
  ipcMain.handle(checkUpdateChannel, async event => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效的更新请求');
    availableUpdate ??= checkForUpdate();
    return (await availableUpdate)?.version ?? null;
  });
  ipcMain.handle(downloadUpdateChannel, async event => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效的更新请求');
    if (downloading) return;
    downloading = true;
    try {
      const update = await availableUpdate;
      if (!update) throw new Error('尚未检测到可下载的新版本，请重新打开应用后重试。');
      await downloadUpdate(window, update);
    } catch (error) {
      if (!window.isDestroyed()) await dialog.showMessageBox(window, { type: 'error', message: '更新失败', detail: error instanceof Error ? error.message : String(error), buttons: ['关闭'] });
    } finally {
      downloading = false;
    }
  });
  window.once('closed', () => {
    ipcMain.removeHandler(checkUpdateChannel);
    ipcMain.removeHandler(downloadUpdateChannel);
  });
}
