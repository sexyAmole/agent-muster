import { useState } from 'react';

type Props = {
  src?: string | null;
  platform: '钉钉' | '飞书';
  className?: string;
  fallbackClassName?: string;
};

export function AppIcon({ src, platform, className, fallbackClassName }: Props) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  return src && src !== failedSrc
    ? <img className={className} src={src} alt={`${platform}应用图标`} onError={() => setFailedSrc(src)} />
    : <span className={fallbackClassName} aria-label={`${platform}应用`}>{platform[0]}</span>;
}
