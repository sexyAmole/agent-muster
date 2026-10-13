import { StringDecoder } from 'node:string_decoder';

export function createLineReader(onLine: (line: string) => void) {
  const decoder = new StringDecoder('utf8');
  let pending = '';

  return {
    write(chunk: Buffer): void {
      pending += decoder.write(chunk);
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) onLine(line);
    },
    end(): void {
      pending += decoder.end();
      if (pending.length) onLine(pending);
      pending = '';
    },
  };
}
