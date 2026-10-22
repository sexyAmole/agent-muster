import { useEffect, useState } from 'react';
import type { DesktopUpdateApi } from '../../../../src/desktop/update-api';

declare global {
  interface Window {
    desktopUpdates?: DesktopUpdateApi;
  }
}

export function DesktopUpdateButton() {
  const updates = window.desktopUpdates;
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  useEffect(() => {
    if (!updates) return;
    let active = true;
    void updates.check().then(version => {
      if (active) setVersion(version);
    }).catch(error => console.warn('自动检查桌面更新失败：', error));
    return () => { active = false; };
  }, [updates]);
  useEffect(() => updates?.onProgress(setPercent), [updates]);

  if (!updates || !version) return null;

  const label = busy ? percent === null ? '准备下载更新' : percent === 100 ? '下载完成' : `正在下载更新 ${percent}%` : `下载新版 ${version}`;
  async function download() {
    if (busy) return;
    setBusy(true);
    try {
      await updates!.download();
    } finally {
      setBusy(false);
      setPercent(null);
    }
  }

  return <button type="button" className="desktop-update-button" aria-label={label} aria-disabled={busy} aria-busy={busy} onClick={() => void download()}>
    {percent !== null ? <span className="desktop-update-percent">{percent}%</span> : <svg className={busy ? 'desktop-update-spinning' : undefined} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.55-1.55L20 8M4 16l2.35 2.55A7 7 0 0 0 17.9 17" /></svg>}
  </button>;
}
