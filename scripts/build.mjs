import { rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/cli.ts'],
  // 保持与源码模块相同的目录深度，保留版本信息和前端资源的相对路径。
  outfile: 'dist/cli/index.js',
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.19',
  external: ['vite'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const __dirname = import.meta.dirname;" },
  logLevel: 'info',
});
