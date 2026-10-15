import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { projectDirectory } from './storage.js';

const directory = join(homedir(), '.agent-muster');
const projectsDirectory = join(directory, 'projects');

export class ProjectRegistry {
  private paths: string[] = [];
  private metadata = new Map<string, { name?: string; order?: number }>();
  private writeQueue = Promise.resolve();

  async load(): Promise<void> {
    await mkdir(projectsDirectory, { recursive: true });
    const legacyFile = join(directory, 'projects.json');
    let legacy: string[] = [];
    try { legacy = JSON.parse(await readFile(legacyFile, 'utf8')) as string[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const path of legacy) await this.persist(path);
    await rm(legacyFile, { force: true });
    this.paths = [];
    this.metadata.clear();
    for (const entry of await readdir(projectsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(projectsDirectory, entry.name, 'project.json');
      try {
        const { path, name, order } = JSON.parse(await readFile(file, 'utf8')) as { path: string; name?: string; order?: number };
        this.paths.push(path);
        this.metadata.set(path, { name, order });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  names(): Record<string, string> {
    return Object.fromEntries([...this.metadata].filter(([, value]) => value.name).map(([path, value]) => [path, value.name!]));
  }

  async rename(path: string, name: string): Promise<void> {
    const write = this.writeQueue.then(async () => {
      const metadata = { ...this.metadata.get(path), name };
      await this.persist(path, metadata);
      this.metadata.set(path, metadata);
    });
    this.writeQueue = write.catch(() => {});
    await write;
  }

  async reorder(paths: string[]): Promise<void> {
    const write = this.writeQueue.then(async () => {
      for (const [order, path] of paths.entries()) {
        const metadata = { ...this.metadata.get(path), order };
        await this.persist(path, metadata);
        this.metadata.set(path, metadata);
      }
      this.paths = [...paths, ...this.paths.filter(path => !paths.includes(path))];
    });
    this.writeQueue = write.catch(() => {});
    await write;
  }

  list(): string[] {
    return [...this.paths].sort((a, b) => (this.metadata.get(a)?.order ?? Infinity) - (this.metadata.get(b)?.order ?? Infinity));
  }

  async add(path: string): Promise<string> {
    if (!isAbsolute(path) || !(await stat(path).then(value => value.isDirectory()).catch(() => false))) {
      throw new Error('Project directory must be an existing absolute path');
    }
    const project = resolve(path);
    if (this.paths.includes(project)) return project;
    this.paths.push(project);
    this.writeQueue = this.writeQueue.then(() => this.persist(project));
    await this.writeQueue;
    return project;
  }

  async remove(path: string): Promise<void> {
    const index = this.paths.indexOf(path);
    if (index < 0) throw new Error('Project not found');
    this.paths.splice(index, 1);
    this.metadata.delete(path);
    this.writeQueue = this.writeQueue.then(() => rm(projectDirectory(directory, path), { recursive: true }));
    await this.writeQueue;
  }

  private async persist(path: string, metadata = this.metadata.get(path)): Promise<void> {
    const project = projectDirectory(directory, path);
    await mkdir(join(project, 'sessions'), { recursive: true });
    const file = join(project, 'project.json');
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ path, ...metadata }));
    await rename(temporary, file);
  }
}
