import { describe, it, expect } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { executeTool, ALLOWED_COMMAND_PREFIXES } from '../server/agentLoop';
import { parseCompilerOutput } from '../server/diagnostics';
import { buildImportGraph } from '../server/diagnostics';

const root = process.cwd();
const call = (name: string, args: Record<string, any>) => ({
  id: `t-${Math.random().toString(36).slice(2)}`,
  name,
  arguments: args
});

describe('run_command allowlist', () => {
  it('rejects non-allowlisted commands', async () => {
    const r = await executeTool(root, call('run_command', { command: 'del /q *' }));
    expect(r.ok).toBe(false);
    expect(r.content).toContain('not allowlisted');
    const r2 = await executeTool(root, call('run_command', { command: 'rm -rf /' }));
    expect(r2.ok).toBe(false);
  });

  it('runs an allowlisted command and captures exit code', async () => {
    const cmd = process.platform === 'win32' ? 'git status' : 'git status';
    const r = await executeTool(root, call('run_command', { command: cmd }));
    // repo may not be a git repo; either way output format must hold
    expect(r.content.startsWith('exit=')).toBe(true);
    void ALLOWED_COMMAND_PREFIXES;
  });
});

describe('parseCompilerOutput', () => {
  it('parses tsc-style lines', () => {
    const diags = parseCompilerOutput(
      "src/app.ts(12,5): error TS2304: Cannot find name 'x'.\nsrc/b.ts(3,1): warning TS6133: 'y' is declared but never used.",
      'tsc'
    );
    expect(diags).toHaveLength(2);
    expect(diags[0]).toMatchObject({
      file: 'src/app.ts',
      line: 12,
      column: 5,
      severity: 'error',
      code: 'TS2304'
    });
    expect(diags[1].severity).toBe('warning');
  });

  it('parses concise ruff/py lines', () => {
    const diags = parseCompilerOutput(
      'main.py:10:5: F841 local variable `x` is assigned to but never used',
      'ruff'
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe('F841');
    expect(diags[0].line).toBe(10);
  });

  it('ignores garbage lines', () => {
    expect(parseCompilerOutput('hello\nworld\n', 'tsc')).toHaveLength(0);
  });
});

describe('buildImportGraph', () => {
  let tmp: string;
  it.beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-graph-'));
    fs.writeFileSync(path.join(tmp, 'util.ts'), 'export const one = 1;\n');
    fs.writeFileSync(
      path.join(tmp, 'app.ts'),
      "import { one } from './util';\nexport const two = one + 1;\n"
    );
  });
  it.afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('computes deps and reverse deps', () => {
    const g = buildImportGraph(tmp, 'app.ts');
    expect(g.dependenciesOf).toContain('util.ts');
    const gRev = buildImportGraph(tmp, 'util.ts');
    expect(gRev.importedBy).toContain('app.ts');
  });

  it('reports empty blast radius for unimported files', () => {
    const g = buildImportGraph(tmp, 'does-not-exist.ts');
    expect(g.importedBy).toHaveLength(0);
  });
});
