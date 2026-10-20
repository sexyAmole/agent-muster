import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  publicDir: resolve(import.meta.dirname, '../public'),
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, '../../dist/website'),
    emptyOutDir: true,
  },
});
