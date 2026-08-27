import { describe, it, expect } from 'vitest';
import {
  parseUnifiedDiff,
  applyUnifiedDiff,
  fuzzyReplace,
  norm
} from '../server/patchEngine';

describe('norm', () => {
  it('strips indentation and trailing whitespace, expands tabs, strips CR', () => {
    expect(norm('\tindent')).toBe('indent');
    expect(norm('  indent')).toBe('indent');
    expect(norm('trailing   ')).toBe('trailing');
    expect(norm('crlf\r')).toBe('crlf');
    expect(norm('internal  spaces  kept')).toBe('internal  spaces  kept');
  });
});

describe('parseUnifiedDiff', () => {
  it('parses a single hunk with counts', () => {
    const diff = parseUnifiedDiff('@@ -2,3 +2,4 @@\n ctx\n-old\n+new\n+extra\n ctx2\n');
    expect(diff.hunks).toHaveLength(1);
    const h = diff.hunks[0];
    expect(h.oldStart).toBe(2);
    expect(h.oldCount).toBe(3);
    expect(h.newStart).toBe(2);
    expect(h.newCount).toBe(4);
    expect(h.lines.map(l => l.type)).toEqual([' ', '-', '+', '+', ' ']);
    expect(h.lines[1].content).toBe('old');
    expect(h.lines[2].content).toBe('new');
  });

  it('defaults count to 1 when omitted', () => {
    const diff = parseUnifiedDiff('@@ -5 +5 @@\n-a\n+b\n');
    expect(diff.hunks[0].oldCount).toBe(1);
    expect(diff.hunks[0].newCount).toBe(1);
  });

  it('parses multiple hunks', () => {
    const p = parseUnifiedDiff('@@ -1,2 +1,2 @@\n-a\n+b\n@@ -10,1 +11,1 @@\n-x\n+y\n');
    expect(p.hunks).toHaveLength(2);
    expect(p.hunks[1].oldStart).toBe(10);
  });

  it('treats blank lines as context', () => {
    const p = parseUnifiedDiff('@@ -1,2 +1,2 @@\n \n-a\n+b\n');
    expect(p.hunks[0].lines[0]).toEqual({ type: ' ', content: '' });
  });
});

describe('applyUnifiedDiff', () => {
  const file = 'line1\nline2\nline3\nline4\nline5\n';

  it('applies a modification hunk with context', () => {
    const r = applyUnifiedDiff(file, '@@ -2,3 +2,3 @@\n line2\n-line3\n+LINE3\n line4\n');
    expect(r.ok).toBe(true);
    expect(r.content).toBe('line1\nline2\nLINE3\nline4\nline5\n');
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
  });

  it('applies pure insertion', () => {
    const r = applyUnifiedDiff(file, '@@ -3,0 +4,2 @@\n line3\n+NEW\n+MORE\n');
    expect(r.ok).toBe(true);
    expect(r.content).toContain('line3\nNEW\nMORE\nline4');
  });

  it('applies pure deletion', () => {
    const r = applyUnifiedDiff(file, '@@ -4,3 +4,2 @@\n line4\n-line5\n');
    // pure deletion with only context before; line5 removed
    expect(r.ok).toBe(true);
    expect(r.content).not.toContain('line5\n');
  });

  it('tolerates whitespace/indentation drift in context', () => {
    const drifted = 'line1\n  line2\nline3\nline4\nline5\n';
    const r = applyUnifiedDiff(drifted, '@@ -2,3 +2,3 @@\n line2\n-line3\n+LINE3\n line4\n');
    expect(r.ok).toBe(true);
    // context taken from the file's actual content, so indentation preserved
    expect(r.content).toBe('line1\n  line2\nLINE3\nline4\nline5\n');
  });

  it('applies multiple hunks in order', () => {
    const r = applyUnifiedDiff(file, [
      '@@ -2,2 +2,2 @@', ' line2', '-line3', '+AAA', ' line4',
      '@@ -1,1 +1,1 @@', '-line1', '+BBB'
    ].join('\n') + '\n');
    expect(r.ok).toBe(true);
    const out = r.content!;
    expect(out).toContain('BBB');
    expect(out).toContain('AAA');
    expect(out).not.toContain('line1');
    expect(out).not.toContain('line3');
  });

  it('returns actionable error for near-miss context (50-74%)', () => {
    const r = applyUnifiedDiff(file, '@@ -1,5 +1,5 @@\n TOTALLY DIFFERENT\n-more\n+less\n COMPLETELY OTHER\n UNRELATED X\n UNRELATED Y\n');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/similarity|not found/i);
  });

  it('returns actionable error when not found at all', () => {
    const r = applyUnifiedDiff(file, '@@ -1,3 +1,3 @@\n zzzz\n-aaaa\n+bbbb\n cccc\n');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  it('rejects a patch with no hunks', () => {
    const r = applyUnifiedDiff(file, 'no diff here');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no @@ hunks/i);
  });
});

describe('fuzzyReplace', () => {
  it('exact match applies', () => {
    const r = fuzzyReplace('a\nb\nc', 'b', 'B');
    expect(r.ok).toBe(true);
    expect(r.content).toBe('a\nB\nc');
  });

  it('exact match ambiguous fails', () => {
    const r = fuzzyReplace('a\na\na', 'a', 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/matches 3/);
  });

  it('whitespace-tolerant fuzzy match applies (>=80%)', () => {
    // file has tabs + trailing whitespace; oldText uses spaces, no trailing ws
    const file = 'function main() {\n\treturn 1;\n\tconst x = 2;  \n}\n';
    const r = fuzzyReplace(file, '  return 1;\n  const x = 2;', '  return 3;');
    expect(r.ok).toBe(true);
    expect(r.content).toContain('return 3;');
    expect(r.content).not.toContain('return 1;');
  });

  it('near-miss (50-79%) fails with actionable message', () => {
    const r = fuzzyReplace('const a = 1;\nconst b = 2;\nconst c = 3;', 'const a = 1;\nconst ZZZ = 2;\nconst c = 3;', 'replaced');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/line /i);
    expect(r.similarity).toBeGreaterThanOrEqual(0); // similarity reported when available
  });

  it('no match fails', () => {
    const r = fuzzyReplace('abc\ndef', 'totally different text not present here xyz', 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  it('empty oldText fails', () => {
    const r = fuzzyReplace('abc', '', 'x');
    expect(r.ok).toBe(false);
  });

  it('CRLF content: exact match after CR in oldText is avoided; fuzzy handles CR', () => {
    const file = 'alpha\r\nbeta\r\ngamma\r\n';
    // oldText without \r should fuzzy-match (norm strips \r)
    const r = fuzzyReplace(file, 'alpha\nbeta', 'ALPHA\nBETA');
    expect(r.ok).toBe(true);
    expect(r.content).toContain('ALPHA');
  });
});
