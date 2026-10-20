import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { generateManifest } from 'material-icon-theme';

const manifest = generateManifest();
const folders = { ...manifest.folderNames, ...manifest.light?.folderNames };
const expandedFolders = { ...manifest.folderNamesExpanded, ...manifest.light?.folderNamesExpanded };
const iconTheme = {
  file: manifest.file,
  folder: [manifest.folder, manifest.folderExpanded],
  folders: Object.fromEntries(Object.entries(folders).map(([name, icon]) => [name, [icon, expandedFolders[name]]])),
  files: { ...manifest.fileNames, ...manifest.light?.fileNames },
  extensions: { ...manifest.fileExtensions, ...manifest.light?.fileExtensions },
  paths: Object.fromEntries(Object.entries(manifest.iconDefinitions!).map(([name, definition]) => [name, definition.iconPath.replace('./../icons/', '')])),
};

export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  define: { __MATERIAL_ICON_THEME__: JSON.stringify(iconTheme) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: resolve(import.meta.dirname, 'index.html'),
        website: resolve(import.meta.dirname, 'website/index.html'),
      },
    },
  },
});
