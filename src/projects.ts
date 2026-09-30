import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const directory = join(homedir(), '.agent-muster');
const dataFile = join(directory, 'projects.json');

export class ProjectRegistry {
  private paths: string[] = [];
  private writeQueue = Promise.resolve();

  async load(): Promise<void> {
    try {
      this.paths = JSON.parse(await readFile(dataFile, 'utf8')) as string[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  list(): string[] {
    return [...this.paths];
  }

  async add(path: string): Promise<string> {
    if (!isAbsolute(path) || !(await stat(path).then(value => value.isDirectory()).catch(() => false))) {
      throw new Error('Project directory must be an existing absolute path');
    }
    const project = resolve(path);
    if (this.paths.includes(project)) return project;
    this.paths.push(project);
    const snapshot = JSON.stringify(this.paths);
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(directory, { recursive: true });
      const temporary = `${dataFile}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot);
      await rename(temporary, dataFile);
    });
    await this.writeQueue;
    return project;
  }

  async remove(path: string): Promise<void> {
    const index = this.paths.indexOf(path);
    if (index < 0) throw new Error('Project not found');
    this.paths.splice(index, 1);
    const snapshot = JSON.stringify(this.paths);
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(directory, { recursive: true });
      const temporary = `${dataFile}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot);
      await rename(temporary, dataFile);
    });
    await this.writeQueue;
  }
}
