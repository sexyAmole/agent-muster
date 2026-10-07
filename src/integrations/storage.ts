import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function moveLegacyPath(source: string, target: string): Promise<void> {
  try { await stat(source); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  try {
    await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await rename(source, target);
    return;
  }
  throw new Error(`迁移目标已存在：${target}`);
}
