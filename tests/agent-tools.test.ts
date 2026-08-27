import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { executeTool, parseJsonActionBlock } from '../server/agentLoop';

let root: string;
const call = (name: string, args: Record<string, any>) => ({
  id: `t-${Math.random().toString(36).slice(2)}`,
  name,
  arguments: args
});

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-loop-'));
  fs.writeFileSync(
    path.join(root, 'src.ts'),
    'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n'
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('executeTool: write_file', () => {
  it('writes new files atomically', async () => {
    const r = await executeTool(root, call('write_file', { path: 'new/dir/file.ts', content: 'export const x = 1;\n' }));
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'new', 'dir', 'file.ts'), 'utf8')).toContain('x = 1');
    expect(fs.existsSync(path.join(root, 'new', 'dir', 'file.ts.ocastmp'))).toBe(false);
  });

  it('reports unchanged when content identical', async () => {
    const r = await executeTool(root, call('write_file', { path: 'new/dir/file.ts', content: 'export const x = 1;\n' }));
    expect(r.ok).toBe(true);
    expect(r.content).toContain('unchanged');
  });

  it('blocks non-text extensions and traversal', async () => {
    const bin = await executeTool(root, call('write_file', { path: 'evil.exe', content: 'MZ...' }));
    expect(bin.ok).toBe(false);

    const trav = await executeTool(root, call('write_file', { path: '../../outside.txt', content: 'nope' }));
    expect(trav.ok).toBe(false);
    expect(trav.content).toContain('BLOCKED');
  });
});

describe('executeTool: apply_patch', () => {
  it('applies an exact unique patch', async () => {
    const r = await executeTool(root, call('apply_patch', {
      path: 'src.ts',
      oldText: 'return 2;',
      newText: 'return 42;'
    }));
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'src.ts'), 'utf8')).toContain('return 42;');
  });

  it('fails when oldText not found', async () => {
    const r = await executeTool(root, call('apply_patch', { path: 'src.ts', oldText: 'NOT THERE', newText: 'x' }));
    expect(r.ok).toBe(false);
    expect(r.content).toContain('not found');
  });

  it('fails when oldText is ambiguous', async () => {
    const r = await executeTool(root, call('apply_patch', { path: 'src.ts', oldText: '\n', newText: '\n' }));
    expect(r.ok).toBe(false);
    expect(r.content).toContain('matches');
  });
});

describe('executeTool: read_file & file_outline', () => {
  it('reads with header info', async () => {
    const r = await executeTool(root, call('read_file', { path: 'src.ts' }));
    expect(r.ok).toBe(true);
    expect(r.content).toContain('[src.ts]');
  });

  it('outlines symbols', async () => {
    const r = await executeTool(root, call('file_outline', { path: 'src.ts' }));
    expect(r.content).toContain('function a');
    expect(r.content).toContain('function b');
  });
});

describe('parseJsonActionBlock', () => {
  it('parses modifiedFiles blocks', () => {
    const batch = parseJsonActionBlock('text before\n```json\n{"modifiedFiles":[{"filePath":"a.ts","content":"x"}]}\n```\ntext after');
    expect(batch?.modifiedFiles).toHaveLength(1);
  });
  it('returns null for non-JSON replies', () => {
    expect(parseJsonActionBlock('just talking, no json here')).toBeNull();
  });
});

// P7.4 item 1: recall / remember tools (only active when backends are wired)
describe('executeTool: recall & remember (scoped memory tools)', () => {
  it('fails gracefully when the backends are not wired', async () => {
    const r = await executeTool(root, call('recall', { query: 'any' }));
    expect(r.ok).toBe(false);
    expect(r.content).toContain('unavailable');
    const m = await executeTool(root, call('remember', { key: 'k', value: 'v' }));
    expect(m.ok).toBe(false);
    expect(m.content).toContain('unavailable');
  });

  it('recall passes query through and reports its body', async () => {
    const r = await executeTool(
      root,
      call('recall', { query: 'lint command', k: 99 }),
      { queryMemories: async (q, k) => `HITS for "${q}" (k=${k})` }
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('lint command');
    expect(r.content).toContain('k=12'); // capped by the tool to <=12
  });

  it('recall reports an empty result as no-matches', async () => {
    const r = await executeTool(root, call('recall', { query: 'x' }), { queryMemories: async () => '' });
    expect(r.ok).toBe(true);
    expect(r.content).toContain('no matching memories');
  });

  it('remember requires key and value', async () => {
    const r = await executeTool(root, call('remember', { key: '', value: 'v' }), { remember: async () => ({ ok: true }) });
    expect(r.ok).toBe(false);
    expect(r.content).toContain('requires both key and value');
  });

  it('remember forwards normalized args and reports success', async () => {
    let got: any = null;
    const r = await executeTool(
      root,
      call('remember', {
        key: 'lint_command',
        value: 'npm run lint',
        category: 'convention',
        tags: ['npm', 'ci', '   ', ''],
        scope: 'c:\\proj'
      }),
      {
        remember: async (args) => {
          got = args;
          return { ok: true };
        }
      }
    );
    expect(r.ok).toBe(true);
    expect(got.key).toBe('lint_command');
    expect(got.value).toBe('npm run lint');
    expect(got.tags).toEqual(['npm', 'ci']);
    expect(got.scope).toBe('c:\\proj'); // scope passthrough (canonicalization is the engine's job)
  });

  it('remember propagates backend failure as a tool error', async () => {
    const r = await executeTool(
      root,
      call('remember', { key: 'k', value: 'v' }),
      { remember: async () => ({ ok: false, error: 'disk full' }) }
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain('disk full');
  });
});

// P7.4 item 3: search_past_runs (only active when the backend is wired)
describe('executeTool: search_past_runs (past-run RAG tool)', () => {
  it('fails gracefully when no backend is wired', async () => {
    const r = await executeTool(root, call('search_past_runs', { query: 'any' }));
    expect(r.ok).toBe(false);
    expect(r.content).toContain('unavailable');
  });

  it('passes query through and caps k at 12', async () => {
    const r = await executeTool(
      root,
      call('search_past_runs', { query: 'csv crash fix', k: 99 }),
      { searchPastRuns: async (q, k) => `RUNS for "${q}" (k=${k})` }
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('csv crash fix');
    expect(r.content).toContain('k=12'); // capped by the tool to <=12
  });

  it('reports an empty result as no-matches', async () => {
    const r = await executeTool(root, call('search_past_runs', { query: 'x' }), { searchPastRuns: async () => '' });
    expect(r.ok).toBe(true);
    expect(r.content).toContain('no past-run matches');
  });

  it('propagates backend failure as a tool error', async () => {
    const r = await executeTool(
      root,
      call('search_past_runs', { query: 'x' }),
      { searchPastRuns: async () => { throw new Error('index corrupted'); } }
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain('index corrupted');
  });
});
