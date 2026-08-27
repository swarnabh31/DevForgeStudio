import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateEditedContent, scanBalance } from '../server/editValidation';
import { executeTool } from '../server/agentLoop';

function makeWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-editgate-'));
}
const tempDirs: string[] = [];
function ws(): string {
  const d = makeWs();
  tempDirs.push(d);
  return d;
}

// ---------------- validators ----------------

describe('validateEditedContent', () => {
  it('rejects invalid JSON with a line number', async () => {
    const root = ws();
    const r = await validateEditedContent(root, 'config.json', '{\n  "a": 1,\n  broken\n}');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('invalid JSON');
    expect(r.errors[0]).toMatch(/line \d+/);
  });

  it('accepts valid JSON', async () => {
    const root = ws();
    expect((await validateEditedContent(root, 'config.json', '{"a": [1, 2]}')).ok).toBe(true);
  });

  it('catches JS syntax errors via node --check', async () => {
    const root = ws();
    const bad = await validateEditedContent(root, 'app.js', 'function f( {\n  return 1;\n}\n');
    expect(bad.ok).toBe(false);

    const good = await validateEditedContent(root, 'app.js', 'const x = (1 + 2) * 3;\nexport default x;\n');
    expect(good.ok).toBe(true);
  });

  it('flags unbalanced braces in TS via the scanner', async () => {
    const root = ws();
    const bad = await validateEditedContent(
      root,
      'mod.ts',
      'export function f() {\n  if (x) {\n    // missing closes\n'
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toMatch(/unclosed '\{'|syntax issue/i);

    // strings/comments containing brackets must NOT trip the scanner
    const good = await validateEditedContent(
      root,
      'clean.ts',
      'export const s = "({[]})";\n// )]} {\nexport function g(): void {}\n'
    );
    expect(good.ok).toBe(true);
  });

  it('detects unresolved relative imports in TS', async () => {
    const root = ws();
    const r = await validateEditedContent(
      root,
      'src/main.ts',
      "import { helper } from './missing-helper';\nexport const x = 1;\n"
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("unresolved import './missing-helper'");

    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'helper.ts'), 'export const helper = 1;\n');
    const okR = await validateEditedContent(
      root,
      'src/main.ts',
      "import { helper } from './helper';\nexport const x = helper;\n"
    );
    expect(okR.ok).toBe(true);
  });

  it('passes unsupported types through untouched', async () => {
    const root = ws();
    expect((await validateEditedContent(root, 'notes.md', '# any **text**')).ok).toBe(true);
  });
});

describe('scanBalance', () => {
  it('reports unmatched closing and unclosed openers with line numbers', () => {
    expect(scanBalance('const a = 1;\n)\n')).toEqual([{ line: 2, message: "unmatched closing ')'" }]);
    const issues = scanBalance('function f() {\n  const arr = [\n');
    expect(issues.some((i) => i.message === "unclosed '{'")).toBe(true);
    expect(issues.some((i) => i.message === "unclosed '['")).toBe(true);
  });
});

// ---------------- gated tool execution ----------------

function call(name: string, args: Record<string, unknown>) {
  return { id: `t-${Math.random().toString(36).slice(2)}`, name, arguments: args };
}

describe('executeTool: P1.5e validation gate', () => {
  it('write_file rejects invalid JSON before it reaches disk', async () => {
    const root = ws();
    const result = await executeTool(
      root,
      call('write_file', { path: 'cfg.json', content: '{broken}' }),
      {
        validateEdit: async (rel, content) =>
          rel.endsWith('.json') && !isValidJson(content) ? 'invalid JSON' : null
      }
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('EDIT REJECTED BY VALIDATION GATE');
    expect(fs.existsSync(path.join(root, 'cfg.json'))).toBe(false);
  });

  it('apply_patch rejects invalid patched content and leaves the file untouched', async () => {
    const root = ws();
    fs.writeFileSync(path.join(root, 'app.ts'), 'export const a = 1;\nexport const b = 2;\n');
    const before = fs.readFileSync(path.join(root, 'app.ts'), 'utf8');

    const patch = '@@ -1,2 +1,2 @@\n export const a = 1;\n-export const b = 2;\n+export const b = ;\n';
    const result = await executeTool(root, call('apply_patch', { path: 'app.ts', patch }), {
      validateEdit: async (_rel, content) => (content.includes('= ;') ? 'syntax error: missing expression' : null)
    });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('file was NOT modified');
    expect(fs.readFileSync(path.join(root, 'app.ts'), 'utf8')).toBe(before);
  });

  it('allows valid edits through and writes them', async () => {
    const root = ws();
    const result = await executeTool(
      root,
      call('write_file', { path: 'good.js', content: 'module.exports = 42;\n' }),
      { validateEdit: async () => null }
    );
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(root, 'good.js'))).toBe(true);
  });
});

function isValidJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}
