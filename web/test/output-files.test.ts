/** Listing a run's output files on the run page (web/src/run-view/output-files.ts). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OutputFile } from '../src/api.ts';
import { fileKind, formatSize, groupFiles, totalSize } from '../src/run-view/output-files.ts';

const file = (path: string, size: number, minute: number): OutputFile => ({ path, size, modifiedAt: `2026-01-01T10:${String(minute).padStart(2, '0')}:00.000Z` });
const files = [file('notes.md', 100, 5), file('screens/home.png', 5000, 1), file('screens/login.png', 3000, 9), file('reports/2026/test.json', 50, 3), file('a.txt', 10, 2)];
const layout = (folders: ReturnType<typeof groupFiles>) => folders.map((folder) => [folder.path, folder.files.map((entry) => entry.path)]);

test('groups files by folder, the top folder first', () => {
  assert.deepEqual(layout(groupFiles(files, 'name')), [
    ['', ['a.txt', 'notes.md']],
    ['reports/2026', ['reports/2026/test.json']],
    ['screens', ['screens/home.png', 'screens/login.png']],
  ]);
});

test('sorts files and folders by newest or size', () => {
  assert.deepEqual(layout(groupFiles(files, 'newest')), [
    ['', ['notes.md', 'a.txt']],
    ['screens', ['screens/login.png', 'screens/home.png']],
    ['reports/2026', ['reports/2026/test.json']],
  ]);
  const bySize = groupFiles(files, 'size');
  assert.deepEqual(bySize.map((folder) => folder.path), ['', 'screens', 'reports/2026']);
  assert.equal(bySize[1].size, 8000);
});

test('filters by path, ignoring case, and drops folders left empty', () => {
  assert.deepEqual(layout(groupFiles(files, 'name', ' SCREENS/L ')), [['screens', ['screens/login.png']]]);
  assert.deepEqual(groupFiles(files, 'name', 'nothing'), []);
});

test('tells file kinds apart by extension', () => {
  assert.equal(fileKind('screens/home.PNG'), 'image');
  assert.equal(fileKind('report.md'), 'document');
  assert.equal(fileKind('data.json'), 'data');
  assert.equal(fileKind('fix.diff'), 'code');
  assert.equal(fileKind('build.tar.gz'), 'archive');
  assert.equal(fileKind('Makefile'), 'other');
  assert.equal(fileKind('.env'), 'other');
});

test('sizes', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(50 * 1024 * 1024), '50 MB');
  assert.equal(totalSize(files), 8160);
});
