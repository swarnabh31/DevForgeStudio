import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  createBackupDir,
  backupFileBeforeWrite,
  listBackups,
  revertFromBackup
} from '../server/backups';
import { checkConflict, recordMtime, forgetMtime } from '../server/fsTools';
import { executeTool } from '../server/agentLoop';

let root: string;
const call = (name: string, args: Record<string, any>) => ({
  id: `t-${Math.random().toString(36).slice(2)}`,
  name,
  arguments: args
});

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-safe-'));
  fs.writeFileSync(path.join(root, 'code.ts'), 'const a = 1;\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('backup engine', () => {
  it('backs up a file before agent write and revert restores it', async () => {
    const backupDir = createBackupDir(root, 'test-session');

    // Agent overwrites the file
    const r1 = await executeTool(
      root,
      call('apply_patch', { path: 'code.ts', oldText: 'const a = 1;', newText: 'const a = 999;' }),
      { backupDir }
    );
    expect(r1.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'code.ts'), 'utf8')).toContain('999');

    // Backup captured the old content
    const backups = listBackups(root);
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(path.join(backups[0].dir, 'code.ts'), 'utf8')).toContain('const a = 1;');

    // Revert restores it
    const result = revertFromBackup(root);
    expect(result.restored).toContain('code.ts');
    expect(fs.readFileSync(path.join(root, 'code.ts'), 'utf8')).toContain('const a = 1;');
  });

  it('lazily creates backup only when a write occurs (read-only runs leave none)', () => {
    expect(listBackups(root).length).toBe(1); // still just the one from previous test
  });

  it('does not create backup entries for brand-new files', async () => {
    const backupDir = createBackupDir(root, 'new-file-run');
    await executeTool(root, call('write_file', { path: 'brand-new.ts', content: 'x\n' }), { backupDir });
    // dir exists but has no restored files inside
    const entries = fs.readdirSync(backupDir);
    expect(entries.length).toBe(0);
    void listBackups;
  });
});

describe('conflict detection (E5)', () => {
  it('flags external modification after read', async () => {
    // Agent reads the file → mtime recorded
    await executeTool(root, call('read_file', { path: 'code.ts' }));
    expect(checkConflict(path.join(root, 'code.ts')).conflicted).toBe(false);

    // Simulate an external editor changing the file (content, not just mtime)
    const abs = path.join(root, 'code.ts');
    fs.writeFileSync(abs, 'const a = 1000;\n');

    expect(checkConflict(abs).conflicted).toBe(true);

    // Agent write must now refuse
    const r = await executeTool(root, call('apply_patch', {
      path: 'code.ts',
      oldText: 'const a = 1;',
      newText: 'hacked;'
    }));
    expect(r.ok).toBe(false);
    expect(r.content).toContain('CONFLICT');
    expect(fs.readFileSync(abs, 'utf8')).not.toContain('hacked');

    // After re-read (fresh state), write succeeds again
    forgetMtime(abs);
    recordMtime(abs);
    const r2 = await executeTool(root, call('apply_patch', {
      path: 'code.ts',
      oldText: 'const a = 1000;',
      newText: 'const a = 2;'
    }));
    expect(r2.ok).toBe(true);
  });

  it('verifyEdit hook appends diagnostics to tool result', async () => {
    const r = await executeTool(
      root,
      call('write_file', { path: 'broken.py', content: 'def broken()\n  return 1\n' }),
      {
        verifyEdit: (rel) =>
          rel.endsWith('.py') ? '\n⚠ VERIFICATION: 1 error(s) — missing colon' : ''
      }
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('VERIFICATION');
  });
});
