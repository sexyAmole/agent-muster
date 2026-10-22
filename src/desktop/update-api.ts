export const checkUpdateChannel = 'desktop:check-update';
export const downloadUpdateChannel = 'desktop:download-update';
export const updateProgressChannel = 'desktop:update-progress';

export interface DesktopUpdateApi {
  check(): Promise<string | null>;
  download(): Promise<void>;
  onProgress(listener: (percent: number) => void): () => void;
}
