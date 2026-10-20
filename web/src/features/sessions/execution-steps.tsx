import React, { useEffect, useRef, useState } from 'react';
import type { SessionStatus as Status } from '../../../../src/types';
import { statusLabel, type ExecutionRound } from './session-utils';

export function ExecutionSteps({ round, stepCount, commandCount, children }: { round: ExecutionRound; stepCount: number; commandCount: number; children: React.ReactNode }) {
  const [now, setNow] = useState(Date.now());
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = round.active;
    if (!round.active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [round.active]);
  const seconds = round.message && (round.end || round.active)
    ? Math.max(0, Math.floor(((round.end?.timestamp ?? now) - round.message.timestamp) / 1000)) : undefined;
  const duration = seconds === undefined || seconds === 0 ? '' : seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分${seconds % 60 ? ` ${seconds % 60} 秒` : ''}`;
  const state = round.end && round.end.text !== 'completed' ? statusLabel[round.end.text as Status] : '';
  const summary = <><span>执行过程{stepCount > 0 && ` · ${stepCount} 步`}</span>{commandCount > 0 && <span className="execution-meta">· {commandCount} 个命令</span>}{duration && <span className="execution-meta">· {duration}</span>}{state && <span className="execution-meta">· {state}</span>}<span className="tool-call-chevron" aria-hidden="true" /></>;
  const content = <div className="execution-content">{children}{round.active && <div className="thinking-step" role="status"><span className="thinking-label">思考中…</span></div>}</div>;
  return <details ref={detailsRef} className="execution-steps" open={round.active}><summary>{summary}</summary>{content}</details>;
}
