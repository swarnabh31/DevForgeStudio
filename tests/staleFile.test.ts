import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  recordMtime,
  checkConflict,
  noteExternalChange,
  forgetMtime,
  isFlaggedExternallyChanged
} from '../server/fsTools';
import { executeTool } from '../server/agentLoop';

function makeWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-stale-'));
}
const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});
function ws(): string {
  const d = makeWs();
  tempDirs.push(d);
  return d;
}

describe('P1.5f hash-confirmed conflict detection', () => {
  it('touch-only mtime changes are NOT conflicts', () => {
    const root = ws();
    const abs = path.join(root, 'a.ts');
    fs.writeFileSync(abs, 'const x = 1;\n');
    recordMtime(abs);

    // External editor saves identical content (mtime bumps)
    fs.writeFileSync(abs, 'const x = 1;\n');
    fs.utimesSync(abs, new Date(Date.now() + 9000), new Date(Date.now() + 9000));

    expect(checkConflict(abs).conflicted).toBe(false);
  });

  it('real content changes ARE conflicts even when size matches', () => {
    const root = ws();
    const abs = path.join(root, 'b.ts');
    fs.writeFileSync(abs, 'const y = 10;\n'); // same length as replacement
    recordMtime(abs);

    fs.utimesSync(abs, new Date(Date.now()), new Date(Date.now()));
    fs.writeFileSync(abs, 'const y = 20;\n');

    expect(checkConflict(abs).conflicted).toBe(true);
  });

  it('noteExternalChange flags known files only after real divergence', () => {
    const root = ws();
    const unknown = path.join(root, 'never-seen.txt');
    fs.writeFileSync(unknown, 'hi\n');

    // Unknown file: watcher event must be ignored
    noteExternalChange(unknown);
    expect(isFlaggedExternallyChanged(unknown)).toBe(false);

    // Known file with unchanged content (agent's own write echo): not flagged
    const known = path.join(root, 'known.txt');
    fs.writeFileSync(known, 'stable\n');
    recordMtime(known);
    noteExternalChange(known);
    expect(isFlaggedExternallyChanged(known)).toBe(false);

    // Known file externally changed: flagged
    fs.writeFileSync(known, 'externally edited\n');
    noteExternalChange(known);
    expect(isFlaggedExternallyChanged(known)).toBe(true);
    expect(checkConflict(known).conflicted).toBe(true);

    // Agent re-read clears the flag and allows edits again
    forgetMtime(known);
    recordMtime(known);
    expect(isFlaggedExternallyChanged(known)).toBe(false);
    expect(checkConflict(known).conflicted).toBe(false);
  });
});

describe('P1.5f end-to-end: conflict forces re-read before edit', () => {
  function call(name: string, args: Record<string, unknown>) {
    return { id: `t-${Math.random().toString(36).slice(2)}`, name, arguments: args };
  }

  it('apply_patch refuses a stale file, then succeeds after read_file', async () => {
    const root = ws();
    const abs = path.join(root, 'code.ts');
    fs.writeFileSync(abs, 'const value = 1;\n');

    // Agent reads → records state
    await executeTool(root, call('read_file', { path: 'code.ts' }));

    // External change mid-run (what the watcher would report)
    fs.writeFileSync(abs, 'const value = 999;\n');
    noteExternalChange(abs);

    const denied = await executeTool(
      root,
      call('apply_patch', { path: 'code.ts', oldText: 'const value = 1;', newText: 'const value = 2;' })
    );
    expect(denied.ok).toBe(false);
    expect(denied.content).toContain('CONFLICT');
    expect(fs.readFileSync(abs, 'utf8')).toContain('999');

    // Model complies: re-reads, then re-applies on fresh content
    const reread = await executeTool(root, call('read_file', { path: 'code.ts' }));
    expect(reread.ok).toBe(true);

    const patched = await executeTool(
      root,
      call('apply_patch', { path: 'code.ts', oldText: 'const value = 999;', newText: 'const value = 2;' })
    );
    expect(patched.ok).toBe(true);
    expect(fs.readFileSync(abs, 'utf8')).toContain('const value = 2;');
  });
});
