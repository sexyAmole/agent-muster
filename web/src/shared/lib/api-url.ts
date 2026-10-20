import type { DesktopRuntimeConfig } from '../../../../src/desktop/window-controls';

declare global {
  interface Window {
    desktopRuntime?: DesktopRuntimeConfig;
  }
}

export function apiUrl(path: string): string {
  const runtime = window.desktopRuntime;
  if (!runtime || !path.startsWith('/api/')) return path;
  const url = new URL(path, runtime.url);
  url.searchParams.set('desktopToken', runtime.token);
  return url.href;
}
