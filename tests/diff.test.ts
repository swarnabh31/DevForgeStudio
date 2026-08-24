import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { computeDiffsForFiles } from '../server/diffUtil';
import { createBackupDir, backupFileBeforeWrite } from '../server/backups';

describe('computeDiffsForFiles', () => {
  it('produces a unified diff with counts from backup vs disk', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-diff-'));
    try {
      fs.writeFileSync(path.join(root, 'f.ts'), 'const a = 1;\nconst b = 2;\n');
      const backupDir = createBackupDir(root, 'diff-test');
      backupFileBeforeWrite(root, path.join(root, 'f.ts'), backupDir);

      fs.writeFileSync(path.join(root, 'f.ts'), 'const a = 100;\nconst b = 2;\nconst c = 3;\n');

      const patches = computeDiffsForFiles(root, ['f.ts']);
      expect(patches).toHaveLength(1);
      expect(patches[0].additions).toBe(2);
      expect(patches[0].deletions).toBe(1);
      expect(patches[0].patch).toContain('-const a = 1;');
      expect(patches[0].patch).toContain('+const a = 100;');
      expect(patches[0].patch).toContain('+const c = 3;');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty for unchanged/unknown files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-diff2-'));
    try {
      expect(computeDiffsForFiles(root, ['missing.ts'])).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
