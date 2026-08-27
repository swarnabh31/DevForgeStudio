import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createBackupDir,
  backupFileBeforeWrite,
  resolveCheckpointDir,
  listCheckpointFiles
} from '../server/backups';
import { computeCheckpointDiffs } from '../server/diffUtil';

let root: string;
afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function setup(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-checkpoints-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'const a = 1;\n');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'b.ts'), 'const b = 2;\n');
  return root;
}

describe('P2.1 checkpoint helpers', () => {
  it('resolveCheckpointDir rejects path escapes and unknown names', () => {
    const ws = setup();
    expect(resolveCheckpointDir(ws, '..')).toBeNull();
    expect(resolveCheckpointDir(ws, 'no-such-checkpoint')).toBeNull();
  });

  it('lists checkpoint files with relative paths and sizes', () => {
    const ws = setup();
    const dir = createBackupDir(ws, 'cp-test');
    backupFileBeforeWrite(ws, path.join(ws, 'a.ts'), dir);
    const name = path.basename(dir);
    expect(resolveCheckpointDir(ws, name)).toBe(dir);
    const files = listCheckpointFiles(ws, name);
    expect(files.map((f) => f.path)).toEqual(['a.ts']);
    expect(files[0].size).toBeGreaterThan(0);
  });

  it('checkpoint diff shows modification vs disk and deletion for removed files', () => {
    const ws = setup();
    const dir = createBackupDir(ws, 'cp-diff');
    backupFileBeforeWrite(ws, path.join(ws, 'a.ts'), dir);

    // Modify a.ts on disk, delete sub/b.ts? b was never backed up — instead
    // back it up too, then delete it.
    fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
    backupFileBeforeWrite(ws, path.join(ws, 'sub', 'b.ts'), dir);
    fs.writeFileSync(path.join(ws, 'a.ts'), 'const a = 42;\n');
    fs.rmSync(path.join(ws, 'sub'), { recursive: true, force: true });

    const patches = computeCheckpointDiffs(ws, path.basename(dir));
    const a = patches.find((p) => p.filePath === 'a.ts');
    const b = patches.find((p) => p.filePath.endsWith('b.ts'));
    expect(a).toBeDefined();
    expect(a!.patch).toContain('-const a = 1;');
    expect(a!.patch).toContain('+const a = 42;');
    expect(b).toBeDefined();
    expect(b!.deletions).toBeGreaterThan(0);
    expect(b!.additions).toBe(0);
  });

  it('checkpoint diff reports no differences when disk matches the snapshot', () => {
    const ws = setup();
    const dir = createBackupDir(ws, 'cp-clean');
    backupFileBeforeWrite(ws, path.join(ws, 'a.ts'), dir);
    const patches = computeCheckpointDiffs(ws, path.basename(dir));
    // The unified patch exists but contains no +/- body lines
    const changed = patches.filter((p) => p.additions > 0 || p.deletions > 0);
    expect(changed).toHaveLength(0);
  });
});
