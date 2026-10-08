import { useState } from 'react';

export function MessageImages({ sessionId, eventId, count }: { sessionId: string; eventId: number; count: number }) {
  const [failed, setFailed] = useState<number[]>([]);
  return <div className="message-images" aria-label="消息图片">
    {Array.from({ length: count }, (_, index) => {
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages/${eventId}/images/${index}`;
      return failed.includes(index)
        ? <span key={index} className="message-image-error" role="status">图片 {index + 1} 加载失败</span>
        : <a key={index} className="message-image" href={url} target="_blank" rel="noreferrer" aria-label={`查看图片 ${index + 1} 原图`}>
          <img src={url} alt={`用户发送的图片 ${index + 1}`} loading="lazy" onError={() => setFailed(current => [...current, index])} />
        </a>;
    })}
  </div>;
}
