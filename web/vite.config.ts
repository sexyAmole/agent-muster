import { defineConfig } from 'vite';
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
  plugins: [react()],
  define: { __MATERIAL_ICON_THEME__: JSON.stringify(iconTheme) },
  build: { outDir: 'dist', emptyOutDir: true },
});
