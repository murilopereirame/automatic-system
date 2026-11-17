/**
 * Line diff between two texts, used to compare workflow versions as formulas.
 *
 * It finds the longest common subsequence of lines (the lines both texts keep
 * in the same order); everything else is removed or added. Lines the texts
 * share at the start and end are set aside first, so comparing two versions
 * that differ in a few places stays cheap even for long formulas.
 */

export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
  /** Line number in the old text (`same` and `removed`). */
  oldLine?: number;
  /** Line number in the new text (`same` and `added`). */
  newLine?: number;
}

/** A changed region with a few unchanged lines around it, like a hunk of `git diff`. */
export interface DiffHunk {
  lines: DiffLine[];
}

export interface Diff {
  added: number;
  removed: number;
  hunks: DiffHunk[];
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\n$/, '').split('\n');
}

/** Every line of both texts in order, marked as kept, removed or added. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) (endA--, endB--);

  // lengths[i][j]: longest common subsequence of a[start+i..endA) and b[start+j..endB).
  const rows = endA - start;
  const cols = endB - start;
  const lengths = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lengths[i][j] = a[start + i] === b[start + j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  const same = (i: number, j: number) => lines.push({ kind: 'same', text: a[i], oldLine: i + 1, newLine: j + 1 });
  for (let k = 0; k < start; k++) same(k, k);
  let i = 0;
  let j = 0;
  while (i < rows || j < cols) {
    if (i < rows && j < cols && a[start + i] === b[start + j]) {
      same(start + i, start + j);
      i++, j++;
    } else if (i < rows && (j === cols || lengths[i + 1][j] >= lengths[i][j + 1])) {
      // Removed lines come before the lines that replace them, as in `git diff`.
      lines.push({ kind: 'removed', text: a[start + i], oldLine: start + i + 1 });
      i++;
    } else {
      lines.push({ kind: 'added', text: b[start + j], newLine: start + j + 1 });
      j++;
    }
  }
  for (let k = 0; k < a.length - endA; k++) same(endA + k, endB + k);
  return lines;
}

/** The changes between two texts, grouped into hunks with `context` unchanged lines around each change. */
export function diff(oldText: string, newText: string, context = 3): Diff {
  const lines = diffLines(oldText, newText);
  const changed = lines.map((line, index) => (line.kind === 'same' ? -1 : index)).filter((index) => index >= 0);
  const hunks: DiffHunk[] = [];
  let from = -1;
  let to = -1;
  for (const index of changed) {
    if (from >= 0 && index - context <= to + 1) {
      to = Math.min(lines.length - 1, index + context);
      continue;
    }
    if (from >= 0) hunks.push({ lines: lines.slice(from, to + 1) });
    from = Math.max(0, index - context);
    to = Math.min(lines.length - 1, index + context);
  }
  if (from >= 0) hunks.push({ lines: lines.slice(from, to + 1) });
  return {
    added: lines.filter((line) => line.kind === 'added').length,
    removed: lines.filter((line) => line.kind === 'removed').length,
    hunks,
  };
}
