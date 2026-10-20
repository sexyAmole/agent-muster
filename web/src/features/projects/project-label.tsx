import { createContext } from 'react';

export function shortPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

export const ProjectNamesContext = createContext<Record<string, string>>({});

export function projectLabel(path: string, projects: string[], names: Record<string, string>): string {
  if (names[path]) return names[path];
  const name = shortPath(path);
  return projects.filter(project => shortPath(project) === name).length > 1
    ? path.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
    : name;
}
