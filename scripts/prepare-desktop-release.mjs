import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

const output = 'release-assets';
const manifests = new Map();
await mkdir(output, { recursive: true });

for (const directory of await readdir('installers')) {
  const source = join('installers', directory);
  for (const name of await readdir(source)) {
    const path = join(source, name);
    if (!name.endsWith('.yml')) {
      await copyFile(path, join(output, name));
      continue;
    }
    const manifest = parse(await readFile(path, 'utf8'));
    const existing = manifests.get(name);
    if (existing) {
      if (existing.version !== manifest.version) throw new Error(`更新清单版本不一致：${name}`);
      existing.files.push(...manifest.files);
    } else {
      manifests.set(name, manifest);
    }
  }
}

for (const [name, manifest] of manifests) {
  await writeFile(join(output, name), stringify(manifest));
}
