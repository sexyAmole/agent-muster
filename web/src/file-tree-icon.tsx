declare const __MATERIAL_ICON_THEME__: {
  file: string;
  folder: [string, string];
  folders: Record<string, [string, string]>;
  files: Record<string, string>;
  extensions: Record<string, string>;
  paths: Record<string, string>;
};

const theme = __MATERIAL_ICON_THEME__;
const folders = new Map(Object.entries(theme.folders));
const files = new Map(Object.entries(theme.files));
const extensions = new Map(Object.entries(theme.extensions));
const icons = import.meta.glob<string>('../../node_modules/material-icon-theme/icons/*.svg', {
  eager: true,
  query: '?url&no-inline',
  import: 'default',
});

export function FileTreeIcon({ name, directory, expanded }: { name: string; directory: boolean; expanded: boolean }) {
  const normalized = name.toLowerCase();
  let icon: string | undefined;
  if (directory) {
    icon = (folders.get(normalized) ?? theme.folder)[expanded ? 1 : 0];
  } else {
    icon = files.get(normalized);
    const parts = normalized.split('.');
    for (let index = 1; !icon && index < parts.length; index++) {
      icon = extensions.get(parts.slice(index).join('.'));
    }
    icon ??= theme.file;
  }
  const path = `../../node_modules/material-icon-theme/icons/${theme.paths[icon!]}`;
  return <img className="file-tree-icon" src={icons[path]} alt="" aria-hidden="true" draggable={false} />;
}
