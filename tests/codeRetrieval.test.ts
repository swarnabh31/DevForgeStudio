import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  chunkSourceFile,
  ensureCodeIndex,
  retrieveCode,
  renderRetrieval,
  resetCodeIndex
} from '../server/codeRetrieval';

function makeWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-retrieval-'));
}
const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  // fresh in-memory index per test (temp roots differ, but be explicit)
});

/** Fake embedding: deterministic vector = hash buckets of words. */
const DIM = 32;
function fakeEmbed(text: string): number[] {
  const v = new Array(DIM).fill(0);
  for (const w of text.toLowerCase().split(/\W+/)) {
    if (!w) continue;
    let h = 0;
    for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
    v[h % DIM] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

describe('chunkSourceFile', () => {
  it('chunks TS files at outline symbol boundaries', () => {
    const src = [
      'export function parseCsv(text: string) {',
      '  return text.split(",");',
      '}',
      '',
      'export class Widget {',
      '  render() { return 1; }',
      '}'
    ].join('\n');
    const chunks = chunkSourceFile('a.ts', src);
    expect(chunks.length).toBe(2);
    expect(chunks[0].name).toBe('parseCsv');
    expect(chunks[0].kind).toBe('function');
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[1].name).toBe('Widget');
    expect(chunks[1].startLine).toBe(5);
  });

  it('falls back to sliding windows when no symbols exist', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} lorem ipsum`);
    const chunks = chunkSourceFile('plain.txt', lines.join('\n'));
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].name).toBeUndefined();
    // windows advance by step and stay within bounds
    expect(chunks[1].startLine).toBeGreaterThan(chunks[0].startLine);
    expect(chunks[chunks.length - 1].endLine).toBeLessThanOrEqual(200);
  });

  it('returns [] for empty content', () => {
    expect(chunkSourceFile('x.ts', '')).toEqual([]);
  });
});

describe('ensureCodeIndex', () => {
  it('indexes files incrementally — unchanged files are not re-chunked', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    fs.mkdirSync(path.join(ws, 'src'));
    fs.writeFileSync(path.join(ws, 'src', 'a.ts'), 'export function alpha() { return 1; }\n');

    const calls: string[] = [];
    const embed = async (t: string) => {
      calls.push(t);
      return fakeEmbed(t);
    };

    await ensureCodeIndex(ws, { embed, force: true });
    const firstCalls = calls.length;
    expect(firstCalls).toBeGreaterThan(0);

    // No changes → nothing re-embedded
    await ensureCodeIndex(ws, { embed });
    expect(calls.length).toBe(firstCalls);

    // Change one file (different size AND forced mtime so the cache sees it)
    const changed = 'export function beta() { return 2; } // touched with more content\n';
    fs.writeFileSync(path.join(ws, 'src', 'a.ts'), changed);
    const future = Date.now() / 1000 + 5;
    fs.utimesSync(path.join(ws, 'src', 'a.ts'), new Date(), new Date(future * 1000));
    await ensureCodeIndex(ws, { embed, force: true });
    expect(calls.length).toBeGreaterThan(firstCalls);
    expect(calls[calls.length - 1]).toContain('beta');
  });

  it('falls back to keyword mode when embeddings are unavailable', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    fs.writeFileSync(path.join(ws, 'a.ts'), 'export function gammaParser() { return 3; }\n');
    const index = await ensureCodeIndex(ws, { embed: async () => null, force: true });
    expect(index.vectors).toBeNull();
    expect(index.chunks.length).toBeGreaterThan(0);

    const { chunks, mode } = await retrieveCode(ws, 'gammaParser', 6, { embed: async () => null });
    expect(mode).toBe('keyword');
    expect(chunks[0].relPath).toBe('a.ts');
  });
});

describe('retrieveCode + renderRetrieval', () => {
  it('ranks the semantically relevant chunk first (embedding mode)', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    fs.writeFileSync(
      path.join(ws, 'csv.ts'),
      'export function parseCsvRow(line: string) {\n  return line.split(",");\n}\n'
    );
    fs.writeFileSync(
      path.join(ws, 'ui.ts'),
      'export function drawButton(label: string) {\n  console.log(label);\n}\n'
    );
    const { chunks, mode } = await retrieveCode(ws, 'parse a csv row into columns', 6, {
      embed: async (t) => fakeEmbed(t)
    });
    void mode;
    expect(chunks[0].relPath).toBe('csv.ts');
    expect(chunks[0].snippet).toContain('parseCsvRow');
    const rendered = renderRetrieval(chunks, 'embedding');
    expect(rendered).toContain('csv.ts:');
    expect(rendered).toContain('read_file');
  });

  it('renders an empty-state body when nothing matches', () => {
    const body = renderRetrieval([{ relPath: 'x.ts', startLine: 1, endLine: 2, score: 0, snippet: 'hi' }], 'keyword');
    expect(body).toContain('no relevant code found');
  });
});

describe('agentLoop semantic_search wiring', () => {
  it('executeTool dispatches semantic_search when wired; errors when not', async () => {
    const { executeTool } = await import('../server/agentLoop');
    const ws = makeWs();
    tempDirs.push(ws);
    const call = (args: Record<string, unknown>) => ({
      id: 'c1',
      name: 'semantic_search',
      arguments: args
    });

    const missing = await executeTool(ws, call({ query: 'x' }));
    expect(missing.ok).toBe(false);
    expect(missing.content).toContain('unavailable');

    const ok = await executeTool(ws, call({ query: 'anything' }), {
      semanticSearch: async (q) => `RESULT for ${q}`
    });
    expect(ok.ok).toBe(true);
    expect(ok.content).toBe('RESULT for anything');
  });
});
