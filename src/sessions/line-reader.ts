import { StringDecoder } from 'node:string_decoder';

export function createLineReader(onLine: (line: string) => void, onChunk?: (chunk: string) => void) {
  const decoder = new StringDecoder('utf8');
  let pending = '';

  return {
    write(chunk: Buffer): void {
      const text = decoder.write(chunk);
      if (text.length) onChunk?.(text);
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) onLine(line);
    },
    end(): void {
      const text = decoder.end();
      if (text.length) onChunk?.(text);
      pending += text;
      if (pending.length) onLine(pending);
      pending = '';
    },
  };
}
