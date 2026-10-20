import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useErrorMessage } from './message';

export function CodeBlock({ children }: { children?: ReactNode }) {
  const codeRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  useErrorMessage(error, setError);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyCode() {
    if (!codeRef.current) return;
    setCopied(false);
    try {
      await navigator.clipboard.writeText(codeRef.current.textContent ?? '');
      setCopied(true);
    } catch (reason) {
      setError(`复制代码失败：${(reason as Error).message}`);
    }
  }

  return <div className="code-block">
    <button className="code-block-copy" type="button" aria-label={copied ? '代码已复制' : '复制代码'} aria-live="polite" onClick={() => void copyCode()}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{copied ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" /></>}</svg>
    </button>
    <pre ref={codeRef}>{children}</pre>
  </div>;
}
