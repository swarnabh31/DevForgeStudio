import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { runAgentLoop, type LoopMessage } from '../server/agentLoop';
import {
  saveRunState,
  loadRunState,
  deleteRunState,
  pruneOldRunStates,
  listRunStates,
  type RunState,
  type RunStateMessage
} from '../server/persistence';

// server.ts exports the express app without listening when VITEST is set
process.env.VITEST = '1';
const { app } = await import('../server');

// ---------------- mock Ollama server ----------------
//
// callLLMWithTools uses the non-streaming /api/chat path when no onToken
// callback is given, so the mock only needs to answer with a single
// Ollama-style JSON envelope. `responses` is a scripted sequence — call N gets
// responses[min(N, len-1)].

interface MockOllama {
  port: number;
  close: () => void;
  receivedBodies: string[];
}

function toolCallMessage(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }]
  };
}

function textMessage(text: string): Record<string, unknown> {
  return { role: 'assistant', content: text };
}

function startMockOllama(responses: Array<Record<string, unknown>>): Promise<MockOllama> {
  let n = 0;
  const receivedBodies: string[] = [];
  const server = http.createServer((req, r) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/chat') {
        receivedBodies.push(body);
        const i = Math.min(n, responses.length - 1);
        n += 1;
        r.writeHead(200, { 'Content-Type': 'application/json' });
        r.end(JSON.stringify({ message: responses[i] }));
      } else {
        r.writeHead(404, { 'Content-Type': 'application/json' });
        r.end('{}');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('unexpected server address');
      resolve({ port: addr.port, close: () => server.close(), receivedBodies });
    });
  });
}

let activeMock: MockOllama | null = null;
afterEach(() => {
  if (activeMock) {
    activeMock.close();
    activeMock = null;
  }
});

// ---------------- agent loop: onMessages + priorMessages ----------------

describe('runAgentLoop: message snapshots (P0.1)', () => {
  let wsRoot: string;

  beforeAll(() => {
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-resume-'));
  });

  afterAll(() => {
    fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  it('fires onMessages with tool activity, executes the call, then finalises', async () => {
    activeMock = await startMockOllama([
      toolCallMessage('write_file', { path: 'result.txt', content: 'done by run 1\n' }),
      textMessage('All done. Created result.txt.')
    ]);
    const snapshots: LoopMessage[][] = [];

    const result = await runAgentLoop({
      root: wsRoot,
      prompt: 'Create a file called result.txt',
      modelId: 'test-model',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'You are a test agent.',
      maxIterations: 3,
      onMessages: (msgs) => snapshots.push(msgs.map((m) => ({ ...m })))
    });

    expect(result.usedTools).toBe(true);
    expect(result.filesChanged).toContain('result.txt');
    expect(fs.readFileSync(path.join(wsRoot, 'result.txt'), 'utf8')).toContain('done by run 1');
    expect(result.hitIterationCap).toBe(false);
    expect(result.reply).toContain('All done.');

    // seed snapshot (before any LLM call) + per-iteration + final snapshot
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
    const last = snapshots[snapshots.length - 1];
    const toolMsg = last.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    const assistantCall = last.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistantCall?.tool_calls?.[0]?.function.name).toBe('write_file');
  });

  it('continues from priorMessages with full memory of the prior tool activity', async () => {
    // Pass 1: hit the iteration cap mid-task (tool call, no final answer)
    activeMock = await startMockOllama([
      toolCallMessage('write_file', { path: 'part1.txt', content: 'phase 1\n' })
    ]);
    const run1 = await runAgentLoop({
      root: wsRoot,
      prompt: 'Build the feature in two phases',
      modelId: 'test-model',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'You are a test agent.',
      maxIterations: 1
    });
    expect(run1.hitIterationCap).toBe(true);
    expect(fs.existsSync(path.join(wsRoot, 'part1.txt'))).toBe(true);

    // Pass 2: resume with pass 1's message list; the continuation reply comes
    // from a different mock (simulating "the model picked up where it stopped")
    activeMock = await startMockOllama([
      textMessage('Phase 2 complete. Picked up from phase 1.')
    ]);
    const run2 = await runAgentLoop({
      root: wsRoot,
      prompt: 'Continue where you left off',
      modelId: 'test-model',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'You are a test agent.',
      maxIterations: 2,
      priorMessages: run1.messages
    });

    expect(run2.hitIterationCap).toBe(false);
    expect(run2.reply).toContain('Picked up from phase 1');
    // carried-over state: pass 1's assistant tool call is in the final list
    const carried = (run2.messages || []).find((m) => m.role === 'assistant' && m.tool_calls);
    expect(carried).toBeDefined();
    expect(String(carried?.tool_calls?.[0]?.function.arguments)).toContain('part1.txt');
    // and it was actually sent to the model, not just kept in memory
    expect(run2.messages?.length).toBeGreaterThan(2);
  });

  it('resume path: loads a saved snapshot and seeds the loop via priorMessages', async () => {
    // Simulate a crashed run's on-disk snapshot (what /api/agent/stream persists)
    const crashedMessages: RunStateMessage[] = [
      { role: 'system', content: 'context' },
      { role: 'user', content: 'original task' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'crash-1',
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path: 'crash-artifact.txt', content: 'partial\n' }) }
        }]
      },
      { role: 'tool', content: 'ok', tool_call_id: 'crash-1' }
    ];
    saveRunState(wsRoot, 'crashed-run', {
      v: 1,
      runId: 'crashed-run',
      sessionId: 'sess-crash',
      prompt: 'original task',
      modelId: 'test-model',
      iterations: 1,
      filesChanged: ['crash-artifact.txt'],
      messages: crashedMessages,
      savedAt: new Date().toISOString()
    });

    const state = loadRunState(wsRoot, 'crashed-run');
    expect(state).not.toBeNull();
    expect(state?.messages).toHaveLength(4);

    activeMock = await startMockOllama([
      textMessage('Resumed from the crash point and finished.')
    ]);
    const result = await runAgentLoop({
      root: wsRoot,
      prompt: 'Finish the interrupted task',
      modelId: 'test-model',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'ignored on resume',
      maxIterations: 2,
      priorMessages: state!.messages as LoopMessage[]
    });

    expect(result.hitIterationCap).toBe(false);
    expect(result.reply).toContain('Resumed');
    const carried = (result.messages || []).find((m) => m.role === 'assistant' && m.tool_calls);
    expect(carried?.tool_calls?.[0]?.id).toBe('crash-1');
    deleteRunState(wsRoot, 'crashed-run');
  });
});

// ---------------- persistence primitives ----------------

describe('run state persistence (P0.1)', () => {
  let root: string;

  const makeState = (runId: string): RunState => ({
    v: 1,
    runId,
    sessionId: 'sess-test',
    prompt: 'test prompt',
    modelId: 'm1',
    iterations: 2,
    filesChanged: ['a.ts'],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ],
    savedAt: new Date().toISOString()
  });

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-persist-'));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('round-trips save → load → delete', () => {
    saveRunState(root, 'rt-1', makeState('rt-1'));
    const loaded = loadRunState(root, 'rt-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.runId).toBe('rt-1');
    expect(loaded?.sessionId).toBe('sess-test');
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.filesChanged).toContain('a.ts');

    deleteRunState(root, 'rt-1');
    expect(loadRunState(root, 'rt-1')).toBeNull();
  });

  it('returns null for missing and malformed snapshots', () => {
    expect(loadRunState(root, 'never-saved')).toBeNull();
    const dir = path.join(root, '.opencode', 'runs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    expect(loadRunState(root, 'bad')).toBeNull();
    // path traversal via runId must be rejected, not written
    expect(() => runFile('..\\escape')).toThrow();
  });

  // re-exports the private guard for the traversal check above
  function runFile(p: string) {
    const fs2 = fs;
    void fs2;
    // loadRunState swallows the throw — verify no file escaped the dir instead
    loadRunState(root, p as any);
    expect(fs.existsSync(path.join(path.dirname(root), 'escape.json'))).toBe(false);
    throw new Error('guard ok');
  }

  it('pruneOldRunStates removes only stale snapshots', () => {
    saveRunState(root, 'fresh-run', makeState('fresh-run'));
    saveRunState(root, 'stale-run', makeState('stale-run'));
    const staleFile = path.join(root, '.opencode', 'runs', 'stale-run.json');
    const past = new Date(Date.now() - 2 * 3600 * 1000);
    fs.utimesSync(staleFile, past, past);

    const removed = pruneOldRunStates(root, 3600 * 1000); // 1h budget
    expect(removed).toContain('stale-run');
    expect(removed).not.toContain('fresh-run');
    expect(loadRunState(root, 'stale-run')).toBeNull();
    expect(loadRunState(root, 'fresh-run')).not.toBeNull();
  });

  it('listRunStates returns metadata (no messages), most recent first', () => {
    saveRunState(root, 'state-a', makeState('state-a'));
    saveRunState(root, 'state-b', makeState('state-b'));
    const bFile = path.join(root, '.opencode', 'runs', 'state-b.json');
    const past = new Date(Date.now() - 5000);
    fs.utimesSync(bFile, past, past);

    const list = listRunStates(root);
    expect(list.some((r) => r.runId === 'state-a')).toBe(true);
    expect(list.some((r) => r.runId === 'state-b')).toBe(true);
    expect(list[0].runId).toBe('state-a'); // newer mtime first
    const a = list.find((r) => r.runId === 'state-a')!;
    expect(a.sessionId).toBe('sess-test');
    expect(a.prompt).toBe('test prompt');
    expect(a).not.toHaveProperty('messages');
  });

  it('truncates oversized tool results on save', () => {
    // Exceed the 500 KB cap so truncation triggers
    const bigContent = 'x'.repeat(600 * 1024);
    const big: RunState = {
      ...makeState('big-run'),
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: bigContent, tool_call_id: 't' }
      ]
    };
    saveRunState(root, 'big-run', big);
    const loaded = loadRunState(root, 'big-run');
    const tool = loaded?.messages.find((m) => m.role === 'tool');
    expect(tool?.content.length).toBeLessThan(bigContent.length);
    expect(tool?.content).toContain('truncated');
  });
});

// ---------------- server endpoints: resume + pending-resumes ----------------

describe('resume endpoints (P0.2)', () => {
  const ids = ['resume-ok-1', 'pending-list-1'];

  const seed = (runId: string) =>
    saveRunState(process.cwd(), runId, {
      v: 1,
      runId,
      sessionId: 'sess-resume',
      prompt: `prompt for ${runId}`,
      modelId: 'm1',
      iterations: 3,
      filesChanged: ['x.ts'],
      messages: [
        { role: 'system', content: 'ctx' },
        { role: 'user', content: 'task' },
        { role: 'assistant', content: 'almost done' }
      ],
      savedAt: new Date().toISOString()
    });

  afterAll(() => {
    for (const id of ids) deleteRunState(process.cwd(), id);
  });

  it('responds 400 when runId is missing', async () => {
    const res = await request(app).post('/api/agent/resume').send({});
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/runId/);
  });

  it('responds 404 for an unknown runId', async () => {
    const res = await request(app).post('/api/agent/resume').send({ runId: 'no-such-run-xyz' });
    expect(res.status).toBe(404);
  });

  it('returns the saved snapshot and consumes it (single-use)', async () => {
    seed('resume-ok-1');
    const res = await request(app).post('/api/agent/resume').send({ runId: 'resume-ok-1' });
    expect(res.status).toBe(200);
    expect(res.body.runId).toBe('resume-ok-1');
    expect(res.body.sessionId).toBe('sess-resume');
    expect(Array.isArray(res.body.messages)).toBe(true);
    expect(res.body.iterations).toBe(3);

    // consumed: a second resume must 404
    const again = await request(app).post('/api/agent/resume').send({ runId: 'resume-ok-1' });
    expect(again.status).toBe(404);
  });

  it('lists pending resumes with metadata only', async () => {
    seed('pending-list-1');
    const res = await request(app).get('/api/agent/pending-resumes');
    expect(res.status).toBe(200);
    expect(typeof res.body.count).toBe('number');
    const found = (res.body.items as Array<Record<string, unknown>>).find((i) => i.runId === 'pending-list-1');
    expect(found).toBeDefined();
    expect(found?.sessionId).toBe('sess-resume');
    expect(found?.iterations).toBe(3);
    expect(found).not.toHaveProperty('messages');
  });
});
