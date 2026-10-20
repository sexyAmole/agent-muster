import React, { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { SessionEvent as Event, AgentSession as Session } from '../../../../src/types';
import { ActionIcon } from '../../shared/components/action-icon';
import { CodeBlock } from '../../shared/components/code-block';
import { FileMentionTextarea } from './file-mention-textarea';
import { MessageImages } from './message-images';
import { StreamText } from './stream-text';
import { MessageDate } from './message-date';
import { FileChange, ToolTimeline } from './tool-timeline';

type ConversationItemProps = {
  item: Event | Event[];
  index: number;
  session: Session;
  showActions: boolean;
  copiedTarget: 'conversation' | 'run-log' | number | null;
  pushingId: number | null;
  imPlatform: string;
  copyText: (text: string, target: 'conversation' | 'run-log' | number) => Promise<void>;
  pushToIm: (event: Event) => Promise<void>;
  followStream: () => void;
  resendMessage?: (event: Event, content: string) => Promise<void>;
};

function AssistantReply({ event, session, showActions, copiedTarget, pushingId, imPlatform, copyText, pushToIm, followStream }: Omit<ConversationItemProps, 'item' | 'index'> & { event: Event }) {
  return <div className="chat-turn assistant-turn">{event.type === 'im_message' && <div className="dingtalk-sent-label">应用 · 已发送到{event.im?.platform === 'feishu' ? '飞书' : event.im?.platform === 'wecom' ? '企业微信' : '钉钉'}</div>}<div className="assistant-copy">{event.type === 'im_message' ? <div className="dingtalk-sent-content">{event.text}</div> : <StreamText text={event.text} streaming={event.streaming} onProgress={followStream}>{text => <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>{text}</ReactMarkdown>}</StreamText>}</div><div className="reply-actions">{showActions && <button className="reply-copy" aria-label={copiedTarget === event.id ? '已复制这条回复' : '复制这条回复'} onClick={() => void copyText(event.text, event.id)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{copiedTarget === event.id ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" /></>}</svg></button>}<MessageDate timestamp={event.timestamp} />{showActions && event.type === 'output' && Boolean(session.im?.length) && event.text.trim() && <button className="reply-push" disabled={pushingId !== null || event.pushedToIm} onClick={() => void pushToIm(event)}>{pushingId === event.id ? '推送中…' : event.pushedToIm ? '已推送' : `推送给${imPlatform}`}</button>}</div></div>;
}

function UserMessage({ event, session, resendMessage }: Pick<ConversationItemProps, 'session' | 'resendMessage'> & { event: Event }) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(event.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editButton = useRef<HTMLButtonElement>(null);

  function cancelEdit() {
    setEditing(false);
    requestAnimationFrame(() => editButton.current?.focus());
  }

  async function resend(submitEvent: React.FormEvent) {
    submitEvent.preventDefault();
    if (!resendMessage || busy || !content.trim()) return;
    setBusy(true); setError('');
    try {
      await resendMessage(event, content.trim());
      setEditing(false);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  const images = event.images?.length ? <MessageImages sessionId={session.id} eventId={event.id} count={event.images.length} /> : null;
  return <div className="chat-turn user-turn">
    {editing && resendMessage ? <form className="user-message-editor" onSubmit={resend} aria-label="编辑上一条消息" aria-busy={busy}>
      <FileMentionTextarea project={session.cwd} aria-label="修改消息内容" value={content} onChange={setContent} disabled={busy} autoFocus rows={2} onKeyDown={keyEvent => {
        if (keyEvent.key === 'Escape' && !busy) { keyEvent.preventDefault(); cancelEdit(); }
      }} />
      {images}
      {error && <p className="user-message-edit-error" role="alert">{error}</p>}
      <div className="user-message-edit-actions"><button type="button" disabled={busy} onClick={cancelEdit}>取消</button><button type="submit" disabled={busy || !content.trim()}>{busy ? '发送中…' : '发送'}</button></div>
    </form> : <div className="user-bubble">
      {event.text}
      {images}
    </div>}
    <div className="reply-actions user-message-actions">
      <MessageDate timestamp={event.timestamp} />
      {resendMessage && !editing && <button ref={editButton} type="button" className="user-message-edit-trigger" aria-label="编辑消息" onClick={() => { setContent(event.text); setError(''); setEditing(true); }}><ActionIcon type="edit" /></button>}
    </div>
  </div>;
}

export function ConversationItem({ item, index, ...reply }: ConversationItemProps) {
  const { session, followStream } = reply;
  if (Array.isArray(item)) return <ToolTimeline events={item} accordionName={`tools-${index}-${session.id}-${item[0].streamId || item[0].id}`} agent={session.agent} />;
  switch (item.type) {
    case 'thinking':
      return <details className="thinking-step"><summary className="thinking-label"><span>{item.streaming ? '思考中…' : '思考内容'}<span> · {Array.from(item.text).length} 字</span></span><span className="tool-call-chevron" aria-hidden="true" /></summary><div className="thinking-content"><StreamText text={item.text} streaming={item.streaming} onProgress={followStream} /></div></details>;
    case 'message':
      return <UserMessage event={item} session={session} resendMessage={reply.resendMessage} />;
    case 'file_change':
      return <FileChange event={item} cwd={session.cwd} />;
    case 'error':
      return <div className="chat-notice">{item.text}</div>;
    default:
      return <AssistantReply {...reply} event={item} />;
  }
}
