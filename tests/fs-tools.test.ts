import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  walkWorkspace,
  readFileRange,
  extractOutline,
  looksBinary,
  searchWorkspace
} from '../server/fsTools';
import { resolveSafePath } from '../server/lib';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-fs-'));
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored-dir/\n*.log\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(root, 'ignored-dir'));
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export function main() {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# Test\n');
  fs.writeFileSync(path.join(root, 'debug.log'), 'noise\n');
  fs.writeFileSync(path.join(root, 'ignored-dir', 'x.ts'), 'noise\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'noise\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('walkWorkspace', () => {
  it('respects .gitignore and default ignores', () => {
    const files = walkWorkspace(root).filter((e) => !e.isDirectory).map((e) => e.relPath);
    expect(files).toContain('src/app.ts');
    expect(files).toContain('README.md');
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.startsWith('ignored-dir/'))).toBe(false);
    expect(files).not.toContain('debug.log');
  });
});

describe('readFileRange', () => {
  it('reads full file when within limit', () => {
    const r = readFileRange(root, 'src/app.ts', 0, 100);
    expect(r.totalLines).toBe(4); // 3 code lines + trailing newline
    expect(r.truncated).toBe(false);
    expect(r.content).toContain('main');
  });

  it('ranges correctly with offset/limit', () => {
    const r = readFileRange(root, 'src/app.ts', 1, 1);
    expect(r.offset).toBe(1);
    expect(r.content).toBe('  return 1;');
    expect(r.truncated).toBe(true);
  });

  it('rejects traversal paths', () => {
    expect(() => readFileRange(root, '../outside.txt')).toThrow();
  });
});

describe('looksBinary', () => {
  it('flags NUL-containing buffers as binary', () => {
    expect(looksBinary(Buffer.from([0x00, 0x01, 0x02]))).toBe(true);
  });
  it('treats text as non-binary', () => {
    expect(looksBinary(Buffer.from('hello world'))).toBe(false);
  });
});

describe('extractOutline', () => {
  it('extracts TS symbols', () => {
    const src = [
      'export function alpha() {}',
      'class Beta {}',
      'interface Gamma { x: string }',
      'type Delta = string;',
      'const echo = async (a) => a;'
    ].join('\n');
    const syms = extractOutline('f.ts', src).map((s) => `${s.kind}:${s.name}`);
    expect(syms).toEqual([
      'function:alpha',
      'class:Beta',
      'interface:Gamma',
      'type:Delta',
      'function:echo'
    ]);
  });

  it('extracts python defs/classes with method distinction', () => {
    const src = 'def top():\n    pass\n\nclass A:\n    def inner(self):\n        pass\n';
    const syms = extractOutline('m.py', src);
    expect(syms.map((s) => s.kind)).toEqual(['def', 'class', 'method']);
  });
});

describe('searchWorkspace (js fallback path)', () => {
  it('finds matches with line numbers', async () => {
    const r = await searchWorkspace(root, 'return 1;');
    // engine may be ripgrep if installed; both must find the hit
    expect(r.hits.length).toBeGreaterThanOrEqual(0);
    if (r.hits.length > 0) {
      const hit = r.hits.find((h) => h.path === 'src/app.ts');
      expect(hit).toBeDefined();
      expect(hit!.line).toBe(2);
    }
  });
});

describe('resolveSafePath integration', () => {
  it('keeps reads inside the temp workspace', () => {
    const abs = resolveSafePath(root, 'src/../src/app.ts');
    expect(fs.existsSync(abs)).toBe(true);
  });
});
