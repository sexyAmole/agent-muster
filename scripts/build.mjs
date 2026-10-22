import { rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: { 'cli/index': 'src/cli.ts', 'desktop/main': 'src/desktop/main.ts' },
  // 保持与源码模块相同的目录深度，保留版本信息和前端资源的相对路径。
  outdir: 'dist',
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.19',
  external: ['vite', 'electron', 'electron-updater', 'node-pty', 'ws', '@xterm/headless', '@xterm/addon-serialize'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const __dirname = import.meta.dirname;" },
  logLevel: 'info',
});
await build({
  entryPoints: ['src/desktop/preload.ts'],
  outfile: 'dist/desktop/preload.cjs',
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22.19',
  external: ['electron'],
  logLevel: 'info',
});
