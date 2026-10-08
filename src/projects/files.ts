import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const excludedDirectories = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);

export async function searchProjectFiles(project: string, query: string): Promise<string[]> {
  const files: string[] = [];
  const keyword = query.toLowerCase();
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(join(project, directory), { withFileTypes: true });
    entries.sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= 50) return;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !excludedDirectories.has(entry.name)) await visit(path);
      else if (entry.isFile() && path.toLowerCase().includes(keyword)) files.push(path);
    }
  }
  await visit('');
  return files;
}
