import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export function StreamText({ text, streaming, onProgress, children }: { text: string; streaming?: boolean; onProgress: () => void; children?: (text: string) => ReactNode }) {
  const [visible, setVisible] = useState(streaming ? '' : text);
  const displayed = useRef(visible);
  const frame = useRef<number | undefined>(undefined);
  const target = useRef<string[]>([]);
  target.current = useMemo(() => Array.from(text), [text]);

  useEffect(() => {
    if (!text.startsWith(displayed.current)) {
      if (frame.current !== undefined) window.cancelAnimationFrame(frame.current);
      frame.current = undefined;
      displayed.current = text;
      setVisible(text);
      return;
    }
    if (frame.current !== undefined || displayed.current === text) return;
    let count = Array.from(displayed.current).length;
    const advance = () => {
      const remaining = target.current.length - count;
      // 积压较多时加快展示，避免长回复在执行结束后仍延迟很久。
      count += remaining > 100 ? Math.ceil(remaining / 60) : 1;
      displayed.current = target.current.slice(0, count).join('');
      setVisible(displayed.current);
      frame.current = count < target.current.length ? window.requestAnimationFrame(advance) : undefined;
    };
    frame.current = window.requestAnimationFrame(advance);
  }, [text]);

  useEffect(() => () => {
    if (frame.current !== undefined) window.cancelAnimationFrame(frame.current);
    frame.current = undefined;
  }, []);
  useLayoutEffect(onProgress, [visible, onProgress]);
  return children ? children(visible) : visible;
}
