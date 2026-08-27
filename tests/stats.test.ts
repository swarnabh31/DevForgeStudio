import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { appendRunLog, readRunLog, StoredRun } from '../server/persistence';

describe('readRunLog', () => {
  it('returns entries newest-first and skips corrupt lines', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-stats-'));
    const runs: StoredRun[] = [1, 2, 3].map((i) => ({
      runId: `run-${i}`,
      sessionId: 'default',
      startedAt: new Date(i).toISOString(),
      durationMs: i * 100,
      modelId: 'm',
      taskMode: 'coding',
      promptChars: 10,
      toolCalls: [{ name: 'read_file', ok: true }],
      filesChanged: i === 2 ? ['a.ts'] : [],
      iterations: i
    }));
    // order in file is oldest first; line 2 is corrupt
    appendRunLog(ws, runs[0]);
    fs.appendFileSync(path.join(ws, '.opencode', 'logs', 'runs.jsonl'), '{corrupt\n');
    appendRunLog(ws, runs[1]);
    appendRunLog(ws, runs[2]);

    const read = readRunLog(ws, 10);
    expect(read.map((r) => r.runId)).toEqual(['run-3', 'run-2', 'run-1']);

    const limited = readRunLog(ws, 1);
    expect(limited).toHaveLength(1);
    expect(limited[0].runId).toBe('run-3');

    expect(readRunLog(ws.replace(/\\/g, '/'), 5)).toHaveLength(3);
  });

  it('returns [] when no log exists', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-stats-'));
    expect(readRunLog(ws)).toEqual([]);
  });
});

describe('GET /api/stats/runs', () => {
  it('responds with aggregate shape', async () => {
    const { app } = await import('../server');
    const res = await request(app).get('/api/stats/runs?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.totals).toHaveProperty('runs');
    expect(res.body.totals).toHaveProperty('completionRate');
    expect(Array.isArray(res.body.toolUsage)).toBe(true);
    expect(Array.isArray(res.body.runs)).toBe(true);
  });
});
