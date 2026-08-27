// Fuzzy unified-diff patch engine (P1.1)
// Aider-style diff parsing + whitespace/indentation-tolerant anchor matching.

export interface DiffLine {
  type: ' ' | '-' | '+';
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
}

export interface PatchResult {
  ok: boolean;
  content?: string;
  added?: number;
  removed?: number;
  error?: string;
  similarity?: number;
  bestLine?: number;
}

function norm(line: string): string {
  // Match on indentation-insensitive whitespace signature: tabs expanded,
  // leading/trailing whitespace stripped (tolerates indentation drift).
  return line.replace(/\t/g, '  ').replace(/\r$/, '').trim();
}

export { norm };

export function parseUnifiedDiff(patch: string): ParsedDiff {
  const lines = patch.split('\n');
  // Drop the phantom empty line produced by a trailing newline
  // (a blank *body* line is only stripped if it is the very last line).
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const hunks: DiffHunk[] = [];

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) {
      i++;
      continue;
    }

    const oldStart = parseInt(m[1], 10);
    const oldCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
    const newStart = parseInt(m[3], 10);
    const newCount = m[4] !== undefined ? parseInt(m[4], 10) : 1;
    i++;

    const hunkLines: DiffLine[] = [];
    while (i < lines.length) {
      const ln = lines[i];
      if (ln.startsWith('@@ ')) break;

      if (ln.length === 0) {
        hunkLines.push({ type: ' ', content: '' });
      } else {
        const t = ln[0];
        if (t === ' ' || t === '-' || t === '+') {
          hunkLines.push({ type: t as ' ' | '-' | '+', content: ln.slice(1) });
        } else {
          hunkLines.push({ type: ' ', content: ln });
        }
      }
      i++;
    }

    hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines });
  }

  return { hunks };
}

function hunkAnchor(hunk: DiffHunk): string[] {
  return hunk.lines
    .filter(l => l.type === ' ' || l.type === '-')
    .map(l => l.content);
}

interface LocateResult {
  line: number;
  score: number;
}

function fuzzyLocate(anchor: string[], fileLines: string[]): LocateResult | null {
  if (anchor.length === 0) return null;

  const anchorNorm = anchor.map(norm);
  const fileNorm = fileLines.map(norm);
  const n = anchorNorm.length;
  const maxStart = fileNorm.length - n;
  if (maxStart < 0) return null;

  let bestLine = 0;
  let bestScore = -1;

  for (let start = 0; start <= maxStart; start++) {
    let matches = 0;
    for (let j = 0; j < n; j++) {
      if (fileNorm[start + j] === anchorNorm[j]) matches++;
    }
    const score = matches / n;
    if (score > bestScore) {
      bestScore = score;
      bestLine = start;
    }
    if (bestScore >= 0.999) break;
  }

  return { line: bestLine, score: bestScore };
}

function applyHunkAt(fileLines: string[], hunk: DiffHunk, startLine: number): string[] {
  const result: string[] = fileLines.slice(0, startLine);
  let filePos = startLine;

  for (const hl of hunk.lines) {
    if (hl.type === ' ') {
      if (filePos < fileLines.length) result.push(fileLines[filePos]);
      filePos++;
    } else if (hl.type === '-') {
      filePos++;
    } else if (hl.type === '+') {
      result.push(hl.content);
    }
  }

  if (filePos < fileLines.length) result.push(...fileLines.slice(filePos));
  return result;
}

export function applyUnifiedDiff(content: string, patch: string): PatchResult {
  const diff = parseUnifiedDiff(patch);
  if (diff.hunks.length === 0) {
    return { ok: false, error: 'No @@ hunks found in patch. Provide at least one hunk with context lines.' };
  }

  let workLines = content.split('\n');
  let totalAdded = 0;
  let totalRemoved = 0;
  const sorted = [...diff.hunks].sort((a, b) => a.oldStart - b.oldStart);

  for (const hunk of sorted) {
    const anchor = hunkAnchor(hunk);
    const match = anchor.length > 0 ? fuzzyLocate(anchor, workLines) : null;

    let startPos: number;

    if (match && match.score >= 0.75) {
      startPos = match.line;
    } else if (match && match.score >= 0.50) {
      return {
        ok: false,
        error: `Hunk context found near line ${match.line + 1} with ${Math.round(match.score * 100)}% similarity (< 75% required). Read the file and provide corrected context lines.`,
        similarity: match.score,
        bestLine: match.line + 1
      };
    } else if (anchor.length === 0) {
      startPos = Math.max(0, hunk.oldStart - 1);
    } else {
      const pct = match ? Math.round(match.score * 100) : 0;
      return {
        ok: false,
        error: `Hunk context not found (best match: ${pct}% similarity). Read the file and provide accurate context lines.`,
        similarity: match?.score,
        bestLine: match ? match.line + 1 : undefined
      };
    }

    workLines = applyHunkAt(workLines, hunk, startPos);
    totalAdded += hunk.lines.filter(l => l.type === '+').length;
    totalRemoved += hunk.lines.filter(l => l.type === '-').length;
  }

  return { ok: true, content: workLines.join('\n'), added: totalAdded, removed: totalRemoved };
}

export function fuzzyReplace(content: string, oldText: string, newText: string): PatchResult {
  if (!oldText) {
    return { ok: false, error: 'oldText is empty' };
  }

  if (content.includes(oldText)) {
    const count = content.split(oldText).length - 1;
    if (count > 1) {
      return { ok: false, error: `oldText matches ${count} locations. Include more surrounding lines to make it unique.` };
    }
    const updated = content.replace(oldText, () => newText);
    return {
      ok: true,
      content: updated,
      added: (newText || '').split('\n').length,
      removed: oldText.split('\n').length
    };
  }

  const anchor = oldText.split('\n');
  const fileLines = content.split('\n');
  const match = fuzzyLocate(anchor, fileLines);

  if (!match) {
    return { ok: false, error: 'oldText not found in file (exact or fuzzy). Re-read the file and copy the exact text.' };
  }

  if (match.score >= 0.80) {
    const newLines = [...fileLines];
    newLines.splice(match.line, anchor.length, ...newText.split('\n'));
    return {
      ok: true,
      content: newLines.join('\n'),
      added: (newText || '').split('\n').length,
      removed: anchor.length
    };
  }

  const pct = Math.round(match.score * 100);
  if (match.score >= 0.50) {
    return {
      ok: false,
      error: `Close match at line ${match.line + 1} (${pct}% similarity). Copy the exact text from the file including whitespace and retry.`,
      similarity: match.score,
      bestLine: match.line + 1
    };
  }

  return {
    ok: false,
    error: `oldText not found (best match at line ${match.line + 1} is only ${pct}% similar). Re-read the file and copy the exact text including whitespace.`,
    similarity: match.score,
    bestLine: match.line + 1
  };
}
