export const windowControlChannel = 'desktop:window-control';
export const fullScreenChannel = 'desktop:fullscreen';

export interface DesktopWindowApi {
  close(): void;
  minimize(): void;
  toggleFullScreen(): void;
  onFullScreenChange(listener: (fullScreen: boolean) => void): () => void;
}
