import { useEffect, useState } from 'react';
import type { DesktopWindowApi } from '../../src/desktop/window-controls';

declare global {
  interface Window {
    desktopWindow?: DesktopWindowApi;
  }
}

export function DesktopWindowControls() {
  const controls = window.desktopWindow;
  const [fullScreen, setFullScreen] = useState(false);
  useEffect(() => controls?.onFullScreenChange(setFullScreen), [controls]);

  if (!controls) return null;

  return <div className="desktop-titlebar">
    <div className="desktop-traffic-lights" role="group" aria-label="窗口控制">
      <button className="desktop-window-close" aria-label="关闭窗口" onClick={controls.close}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m4 4 4 4m0-4L4 8" /></svg></button>
      <button className="desktop-window-minimize" aria-label="最小化窗口" disabled={fullScreen} onClick={controls.minimize}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 6h5" /></svg></button>
      <button className="desktop-window-fullscreen" aria-label={fullScreen ? '退出全屏' : '进入全屏'} onClick={controls.toggleFullScreen}><svg viewBox="0 0 12 12" aria-hidden="true">{fullScreen ? <path d="M3 5h2V3m4 4H7v2" /> : <path d="M3 5V3h2m4 4v2H7" />}</svg></button>
    </div>
  </div>;
}
