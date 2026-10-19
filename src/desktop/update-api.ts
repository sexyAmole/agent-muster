export const checkUpdateChannel = 'desktop:check-update';
export const updateProgressChannel = 'desktop:update-progress';

export interface DesktopUpdateApi {
  check(): Promise<void>;
  onProgress(listener: (percent: number) => void): () => void;
}
