import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import {
  resolveSafePath,
  PathTraversalError,
  getLanguageForFile,
  DEFAULT_IGNORED_DIRS
} from '../server/lib';

const root = path.resolve(os.tmpdir(), 'ocas-test-root');

describe('resolveSafePath', () => {
  it('resolves a simple relative path inside the root', () => {
    expect(resolveSafePath(root, 'src/index.ts')).toBe(path.join(root, 'src', 'index.ts'));
  });

  it('resolves nested relative paths', () => {
    expect(resolveSafePath(root, path.join('a', 'b', 'c.py'))).toBe(
      path.join(root, 'a', 'b', 'c.py')
    );
  });

  it('accepts absolute paths inside the root', () => {
    const abs = path.join(root, 'file.md');
    expect(resolveSafePath(root, abs)).toBe(abs);
  });

  it('rejects .. traversal escaping the root', () => {
    expect(() => resolveSafePath(root, '../outside.txt')).toThrow(PathTraversalError);
    expect(() => resolveSafePath(root, 'src/../../etc/passwd')).toThrow(PathTraversalError);
  });

  it('rejects absolute paths outside the root', () => {
    const outside = path.resolve(os.tmpdir(), 'other-place', 'secret.txt');
    if (path.relative(root, outside).startsWith('..')) {
      expect(() => resolveSafePath(root, outside)).toThrow(PathTraversalError);
    }
  });

  it('rejects sibling-directory tricks (rootfoo)', () => {
    const sibling = root + '-evil';
    expect(() => resolveSafePath(root, sibling + '/x.ts')).toThrow(PathTraversalError);
  });

  it('rejects empty and null-byte paths', () => {
    expect(() => resolveSafePath(root, '')).toThrow(PathTraversalError);
    expect(() => resolveSafePath(root, '   ')).toThrow(PathTraversalError);
    expect(() => resolveSafePath(root, 'src\0/evil')).toThrow(PathTraversalError);
  });

  it('requires an absolute root', () => {
    expect(() => resolveSafePath('relative-root', 'a.txt')).toThrow(/absolute/);
  });
});

describe('getLanguageForFile', () => {
  it('maps common extensions', () => {
    expect(getLanguageForFile('src/App.tsx')).toBe('typescript');
    expect(getLanguageForFile('main.py')).toBe('python');
    expect(getLanguageForFile('styles.scss')).toBe('css');
    expect(getLanguageForFile('docker-compose.yml')).toBe('yaml');
    expect(getLanguageForFile('.gitignore')).toBe('plaintext');
  });

  it('falls back to plaintext for unknown extensions', () => {
    expect(getLanguageForFile('archive.zst')).toBe('plaintext');
  });
});

describe('DEFAULT_IGNORED_DIRS', () => {
  it('contains the essential heavy/vcs dirs', () => {
    ['node_modules', '.git', 'dist', 'build', 'coverage'].forEach((d) =>
      expect(DEFAULT_IGNORED_DIRS.has(d)).toBe(true)
    );
  });
});
