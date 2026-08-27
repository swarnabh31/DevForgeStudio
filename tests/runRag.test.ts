import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ensureRunRagIndex,
  retrievePastRuns,
  renderPastRuns,
  resetRunRagIndex
} from '../server/runRag';

function makeWs(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rgrag-'));
  tempDirs.push(d);
  return d;
}
const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

/** Fake embedding: deterministic hash-bucket bag-of-words, normalized. */
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
const embed = async (t: string) => fakeEmbed(t);

function writeTranscript(ws: string, runId: string, body: string): string {
  const dir = path.join(ws, '.opencode', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}-c1.md`);
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}
function writeLedger(ws: string, runId: string, body: string): string {
  const dir = path.join(ws, '.devforge', 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}.md`);
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}
function writeSnapshot(ws: string, runId: string, obj: any): string {
  const dir = path.join(ws, '.opencode', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}.json`);
  fs.writeFileSync(file, JSON.stringify(obj), 'utf-8');
  return file;
}

describe('ensureRunRagIndex', () => {
  it('enumerates transcripts, ledgers and snapshots, chunking each', async () => {
    const ws = makeWs();
    writeTranscript(ws, 'runA', 'debugged the csv parser: the crash was from an empty column; fix was guarding headers.\n');
    writeLedger(ws, 'runB', '## nextAction\n- restructure auth middleware around the refresh token\n');
    writeSnapshot(ws, 'runC', { runId: 'runC', sessionId: 's1', iterations: 4, filesChanged: ['src/auth.ts'], prompt: 'fix the token rotation', messages: [{ role: 'assistant', content: 'rotated the refresh token' }] });

    const idx = await ensureRunRagIndex(ws, { embed, force: true });
    expect(idx.vectors).not.toBeNull();
    const sources = new Set(idx.chunks.map((c) => c.source));
    expect(sources.has('transcript')).toBe(true);
    expect(sources.has('ledger')).toBe(true);
    expect(sources.has('snapshot')).toBe(true);
    // each chunk is aligned with a vector
    expect(idx.vectors!.length).toBe(idx.chunks.length);
  });

  it('indexes nothing for an empty workspace (no crash, empty index)', async () => {
    const ws = makeWs();
    const idx = await ensureRunRagIndex(ws, { embed, force: true });
    expect(idx.chunks.length).toBe(0);
    expect(idx.vectors).toBeNull();
  });

  it('is incremental — an unchanged file is not re-embedded', async () => {
    const ws = makeWs();
    writeTranscript(ws, 'runA', 'the csv parser crashed on empty input.\n');
    const calls: string[] = [];
    const counting = async (t: string) => { calls.push(t); return fakeEmbed(t); };

    await ensureRunRagIndex(ws, { embed: counting, force: true });
    expect(calls.length).toBeGreaterThan(0);

    // Drop the in-memory index; the on-disk index now carries the vectors.
    // An unchanged file (same mtime+size) is kept, not re-embedded.
    resetRunRagIndex(ws);
    calls.length = 0;
    const idx = await ensureRunRagIndex(ws, { embed: counting, force: true });
    expect(idx.chunks.length).toBeGreaterThan(0);
    expect(calls.length).toBe(0);

    // A genuine change (new mtime + size) re-embeds that file.
    const file = path.join(ws, '.opencode', 'memory', 'runA-c1.md');
    fs.appendFileSync(file, 'second pass notes.');
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(file, t, t);
    resetRunRagIndex(ws);
    calls.length = 0;
    await ensureRunRagIndex(ws, { embed: counting, force: true });
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('retrievePastRuns', () => {
  it('ranks by meaning (embedding mode) and clamps k', async () => {
    const ws = makeWs();
    writeTranscript(ws, 'csvRun', 'Debugging the CSV parser: the crash came from an empty header row; the fix was to guard against undefined columns before splitting.');
    writeLedger(ws, 'authRun', 'Next action: restructure the auth middleware. Refresh-token rotation was the root cause of the 401s.');
    writeSnapshot(ws, 'buildRun', { runId: 'buildRun', sessionId: 's', iterations: 2, filesChanged: ['package.json'], prompt: 'fix the build', messages: [] });

    const res = await retrievePastRuns(ws, 'what was the csv parser crash fix', 20, { embed });
    expect(res.mode).toBe('embedding');
    expect(res.chunks.length).toBeGreaterThanOrEqual(1);
    expect(res.chunks.length).toBeLessThanOrEqual(20);
    // The CSV transcript should top the results.
    expect(res.chunks[0].source).toBe('transcript');
    expect(res.chunks[0].runId).toBe('csvRun');
  });

  it('returns keyword mode (not crash) when embeddings are unavailable', async () => {
    const ws = makeWs();
    writeTranscript(ws, 'csvRun', 'The csv parser crashed on empty input.');
    writeLedger(ws, 'authRun', 'Auth middleware refresh token fix.');
    const noEmbed = async () => null as unknown as number[];
    const res = await retrievePastRuns(ws, 'csv parser crash', 6, { embed: noEmbed });
    expect(res.mode).toBe('keyword');
    expect(res.chunks[0].runId).toBe('csvRun');
  });

  it('filters to a single runId when provided', async () => {
    const ws = makeWs();
    writeTranscript(ws, 'runA', 'csv parser crash fix with header guard.');
    writeTranscript(ws, 'runB', 'auth middleware token rotation fix.');
    const res = await retrievePastRuns(ws, 'crash fix', 6, { embed, runId: 'runB' });
    expect(res.chunks.length).toBeGreaterThan(0);
    expect(res.chunks.every((c) => c.runId === 'runB')).toBe(true);
  });

  it('returns empty (no match) for an unrelated query, without throwing', async () => {
    const ws = makeWs();
    const res = await retrievePastRuns(ws, 'zebra quantum banana', 6, { embed });
    expect(res.chunks.length).toBe(0);
  });
});

describe('renderPastRuns', () => {
  it('renders a friendly empty state and a populated state', async () => {
    const empty = renderPastRuns([], 'embedding');
    expect(empty).toContain('no past-run matches');

    const populated = renderPastRuns(
      [{ source: 'transcript', relPath: '.opencode/memory/x-c1.md', runId: 'x', start: 0, end: 10, score: 0.81, snippet: 'the csv fix' }],
      'embedding'
    );
    expect(populated).toContain('[past-run embedding retrieval]');
    expect(populated).toContain('run=x');
    expect(populated).toContain('the csv fix');
  });
});
