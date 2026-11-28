/**
 * How the run page lists a run's output files: grouped by folder, sorted, filtered, with a kind
 * per file for its icon. Plain functions, tested in web/test/output-files.test.ts.
 */
import type { OutputFile } from '../api.ts';

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export type FileKind = 'image' | 'document' | 'data' | 'code' | 'archive' | 'log' | 'other';

const KINDS: Record<string, FileKind> = {};
const add = (kind: FileKind, extensions: string) => extensions.split(' ').forEach((extension) => (KINDS[extension] = kind));
add('image', 'png jpg jpeg gif webp svg bmp ico avif');
add('document', 'md markdown txt pdf html htm rtf doc docx');
add('data', 'json csv tsv yaml yml xml sql sqlite db xlsx');
add('code', 'js mjs cjs ts tsx jsx py rb go rs java kt php sh css scss diff patch');
add('archive', 'zip tar gz tgz bz2 xz 7z rar');
add('log', 'log out err');

/** The kind of a file, by its extension. */
export function fileKind(path: string): FileKind {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? (KINDS[name.slice(dot + 1)] ?? 'other') : 'other';
}

export type SortOrder = 'newest' | 'name' | 'size';

export interface Folder {
  /** Path of the folder relative to the output folder, '' for the top. */
  path: string;
  files: OutputFile[];
  size: number;
  /** Newest modification of a file in it, for sorting folders by "newest". */
  modifiedAt: string;
}

const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

const compare: Record<SortOrder, (a: OutputFile, b: OutputFile) => number> = {
  newest: (a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path),
  name: (a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }),
  size: (a, b) => b.size - a.size || a.path.localeCompare(b.path),
};

/**
 * Groups files by the folder they are in (one level: `reports/2026/a.md` is in `reports/2026`), keeps
 * those whose path contains `filter` (ignoring case), and sorts files and folders. The top folder
 * comes first; other folders follow the same order as their files.
 */
export function groupFiles(files: OutputFile[], order: SortOrder, filter = ''): Folder[] {
  const needle = filter.trim().toLowerCase();
  const byFolder = new Map<string, Folder>();
  for (const file of files) {
    if (needle && !file.path.toLowerCase().includes(needle)) continue;
    const path = folderOf(file.path);
    let folder = byFolder.get(path);
    if (!folder) byFolder.set(path, (folder = { path, files: [], size: 0, modifiedAt: file.modifiedAt }));
    folder.files.push(file);
    folder.size += file.size;
    if (file.modifiedAt > folder.modifiedAt) folder.modifiedAt = file.modifiedAt;
  }
  const folders = [...byFolder.values()];
  for (const folder of folders) folder.files.sort(compare[order]);
  const folderOrder: Record<SortOrder, (a: Folder, b: Folder) => number> = {
    newest: (a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.path.localeCompare(b.path),
    name: (a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }),
    size: (a, b) => b.size - a.size || a.path.localeCompare(b.path),
  };
  return folders.sort((a, b) => (a.path === '' ? -1 : b.path === '' ? 1 : folderOrder[order](a, b)));
}

export const totalSize = (files: OutputFile[]) => files.reduce((sum, file) => sum + file.size, 0);
