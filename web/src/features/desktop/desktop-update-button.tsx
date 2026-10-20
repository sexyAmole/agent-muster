import { useEffect, useState } from 'react';
import type { DesktopUpdateApi } from '../../../../src/desktop/update-api';

declare global {
  interface Window {
    desktopUpdates?: DesktopUpdateApi;
  }
}

export function DesktopUpdateButton() {
  const updates = window.desktopUpdates;
  const [checking, setChecking] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  useEffect(() => updates?.onProgress(setPercent), [updates]);

  if (!updates) return null;

  const label = checking ? percent === null ? '正在检查更新' : percent === 100 ? '下载完成' : `正在下载更新 ${percent}%` : '检查更新';
  async function check() {
    if (checking) return;
    setChecking(true);
    try {
      await updates!.check();
    } finally {
      setChecking(false);
      setPercent(null);
    }
  }

  return <button type="button" className="desktop-update-button" aria-label={label} aria-disabled={checking} aria-busy={checking} onClick={() => void check()}>
    {percent !== null ? <span className="desktop-update-percent">{percent}%</span> : <svg className={checking ? 'desktop-update-spinning' : undefined} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.55-1.55L20 8M4 16l2.35 2.55A7 7 0 0 0 17.9 17" /></svg>}
  </button>;
}
