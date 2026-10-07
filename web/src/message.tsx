import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

const MessageContext = createContext<((text: string) => void) | null>(null);

export function MessageProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<{ text: string } | null>(null);
  const lastMessage = useRef<{ text: string; shownAt: number } | null>(null);
  const showMessage = useCallback((text: string) => {
    const now = Date.now();
    if (lastMessage.current?.text === text && now - lastMessage.current.shownAt < 30_000) return;
    lastMessage.current = { text, shownAt: now };
    setMessage({ text });
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 6000);
    return () => window.clearTimeout(timer);
  }, [message]);

  return <MessageContext.Provider value={showMessage}>{children}{message && createPortal(<div className="error-message-layer">
    <div className="error-message" role="alert">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
      <p>{message.text}</p>
      <button type="button" aria-label="关闭错误提示" onClick={() => setMessage(null)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </div>
  </div>, document.body)}</MessageContext.Provider>;
}

export function useErrorMessage(error: string, setError: (error: string) => void) {
  const showMessage = useContext(MessageContext)!;
  useEffect(() => {
    if (!error) return;
    showMessage(error);
    setError('');
  }, [error, setError, showMessage]);
}
