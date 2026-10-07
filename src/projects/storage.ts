import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

export function projectDirectory(directory: string, path: string): string {
  const id = createHash('sha256').update(resolve(path)).digest('hex');
  return join(directory, 'projects', id);
}
