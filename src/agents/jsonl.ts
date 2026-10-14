import { createReadStream } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export async function* jsonlLines(file: string): AsyncGenerator<string> {
  const handle = await open(file, 'r');
  let size: number;
  let complete: boolean;
  try {
    size = (await handle.stat()).size;
    if (!size) return;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    complete = last[0] === 10;
  } finally { await handle.close(); }
  const stream = createReadStream(file, { end: size - 1 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let pending: string | undefined;
  try {
    for await (const line of lines) {
      if (pending !== undefined) yield pending;
      pending = line;
    }
    if (complete && pending !== undefined) yield pending;
  } finally { lines.close(); stream.destroy(); }
}

export async function findJsonl(directory: string, matches: (file: string) => boolean, sessionId?: string): Promise<string | undefined> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findJsonl(file, matches, sessionId);
      if (found) return found;
    } else if (entry.isFile() && entry.name.endsWith('.jsonl') && matches(file)) {
      if (!sessionId) return file;
      for await (const line of jsonlLines(file)) {
        const record = JSON.parse(line) as { sessionId?: string };
        if (record.sessionId === sessionId) return file;
        break;
      }
    }
  }
  return undefined;
}

