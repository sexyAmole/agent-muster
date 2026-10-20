import { chmodSync, globSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

if (process.platform !== 'win32') {
  const require = createRequire(import.meta.url);
  const root = resolve(dirname(require.resolve('node-pty')), '..');
  // node-pty 的预编译辅助程序在发布包中没有保留可执行权限。
  for (const file of globSync(['prebuilds/*/spawn-helper', 'build/Release/spawn-helper'], { cwd: root })) {
    chmodSync(resolve(root, file), 0o755);
  }
}
