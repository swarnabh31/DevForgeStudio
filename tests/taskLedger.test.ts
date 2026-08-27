import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { executeTool, runAgentLoop } from '../server/agentLoop';
import {
  ledgerPath,
  emptyLedger,
  setSteps,
  addFinding,
  setNextAction,
  touchFile,
  renderLedger,
  parseLedger,
  saveLedger,
  loadLedger,
  applyUpdate,
  recordFileTouched,
  renderLedgerHelp,
  renderLedgerBlock,
  upsertLedgerBlock,
  LEDGER_START,
  LEDGER_END,
  isLedgerStatus,
  type TaskLedger
} from '../server/taskLedger';

// ---------------- mock Ollama server (same pattern as resume.test.ts) ----------------

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

// ---------------- core module: paths, guards ----------------

describe('taskLedger: paths and validation', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-ledger-'));
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('computes .devforge/tasks/<runId>.md and rejects unsafe run ids', () => {
    expect(ledgerPath(root, 'run-abc_123')).toBe(path.join(root, '.devforge', 'tasks', 'run-abc_123.md'));
    expect(() => ledgerPath(root, '..\\escape')).toThrow(/unsafe runId/);
    expect(() => ledgerPath(root, 'a/b')).toThrow(/unsafe runId/);
    expect(() => ledgerPath(root, '')).toThrow(/unsafe runId/);
  });

  it('isLedgerStatus only accepts the four statuses', () => {
    expect(isLedgerStatus('pending')).toBe(true);
    expect(isLedgerStatus('in_progress')).toBe(true);
    expect(isLedgerStatus('completed')).toBe(true);
    expect(isLedgerStatus('blocked')).toBe(true);
    expect(isLedgerStatus('done')).toBe(false);
    expect(isLedgerStatus(undefined as any)).toBe(false);
  });
});

// ---------------- core module: mutations ----------------

describe('taskLedger: mutations', () => {
  const L = (): TaskLedger => emptyLedger('r1');

  it('setSteps normalizes, drops empty text, defaults status, and caps at 60', () => {
    const l = L();
    setSteps(l, [
      { text: '  step  one  ', status: 'bogus' },
      { text: 'second', status: 'in_progress', note: 'working on it' },
      { text: '   ' },
      { text: null },
      { notAnObject: true },
      'junk'
    ] as any);
    expect(l.steps).toHaveLength(2);
    expect(l.steps[0]).toEqual({ text: 'step one', status: 'pending' });
    expect(l.steps[1]).toEqual({ text: 'second', status: 'in_progress', note: 'working on it' });

    const many = Array.from({ length: 100 }, (_, i) => ({ text: `s${i}`, status: 'pending' }));
    setSteps(l, many);
    expect(l.steps).toHaveLength(60);
    expect(l.steps[0].text).toBe('s0');
  });

  it('addFinding dedupes and caps at 100 (keeps newest)', () => {
    const l = L();
    addFinding(l, 'first');
    addFinding(l, 'first');
    addFinding(l, '');
    addFinding(l, 42); // coerced to the string "42"
    expect(l.keyFindings).toEqual(['first', '42']);
    for (let i = 0; i < 120; i++) addFinding(l, `f${i}`);
    expect(l.keyFindings).toHaveLength(100);
    expect(l.keyFindings[99]).toBe('f119');
  });

  it('setNextAction trims and only overwrites when different', () => {
    const l = L();
    setNextAction(l, '  run the tests  ');
    expect(l.nextAction).toBe('run the tests');
    setNextAction(l, '');
    expect(l.nextAction).toBe('');
    setNextAction(l, 'ship it');
    expect(l.nextAction).toBe('ship it');
  });

  it('touchFile dedupes (moves to end), normalizes separators, caps at 100', () => {
    const l = L();
    touchFile(l, 'a.ts');
    touchFile(l, '\\a.ts');
    touchFile(l, './a.ts');
    expect(l.filesTouched).toEqual(['a.ts']);
    touchFile(l, 'b.ts');
    touchFile(l, 'a.ts');
    expect(l.filesTouched).toEqual(['b.ts', 'a.ts']);
    touchFile(l, '   ');
    for (let i = 0; i < 120; i++) touchFile(l, `f${i}.ts`);
    expect(l.filesTouched).toHaveLength(100);
  });
});

// ---------------- core module: render / parse / persistence ----------------

describe('taskLedger: render, parse, persistence', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-ledger-io-'));
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('renders and parses back to the same ledger (round-trip)', () => {
    const l = emptyLedger('rt-run');
    l.title = 'Build feature X';
    l.steps = [
      { text: 'plan', status: 'completed' },
      { text: 'implement', status: 'in_progress', note: 'mid-refactor' },
      { text: 'tests', status: 'pending' },
      { text: 'ship', status: 'blocked', note: 'waiting on CI' }
    ];
    l.filesTouched = ['src/x.ts', 'tests/x.test.ts'];
    l.keyFindings = ['model needs cap 60'];
    l.nextAction = 'finish the refactor';

    const md = renderLedger(l);
    expect(md).toContain('# Task ledger: Build feature X');
    expect(md).toContain('1. [x] plan');
    expect(md).toContain('2. [>] implement — mid-refactor');
    expect(md).toContain('4. [!] ship — waiting on CI');
    expect(md).toContain('- src/x.ts');

    const parsed = parseLedger(md);
    expect(parsed.title).toBe('Build feature X');
    expect(parsed.runId).toBe('rt-run');
    expect(parsed.steps).toEqual(l.steps);
    expect(parsed.filesTouched).toEqual(l.filesTouched);
    expect(parsed.keyFindings).toEqual(l.keyFindings);
    expect(parsed.nextAction).toBe('finish the refactor');
  });

  it('parseLedger tolerates unknown sections and empty files', () => {
    const parsed = parseLedger('# Task ledger: T\n\n## Bogus section\n- weird\n');
    expect(parsed.title).toBe('T');
    expect(parsed.steps).toEqual([]);
    expect(parsed.filesTouched).toEqual([]);
    const empty = parseLedger('');
    expect(empty.title).toBe('Task');
  });

  it('saveLedger writes atomically and loadLedger reads it back', () => {
    const l = emptyLedger('save-run');
    l.title = 'Saved task';
    l.steps = [{ text: 'one', status: 'completed' }];
    const file = saveLedger(root, 'save-run', l);
    expect(file).toBe(ledgerPath(root, 'save-run'));
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(file + '.tmp')).toBe(false);

    const loaded = loadLedger(root, 'save-run');
    expect(loaded).not.toBeNull();
    expect(loaded?.title).toBe('Saved task');
    expect(loaded?.steps).toEqual([{ text: 'one', status: 'completed' }]);
  });

  it('loadLedger returns null for missing, empty, or corrupt files', () => {
    expect(loadLedger(root, 'never-there')).toBeNull();
    const file = ledgerPath(root, 'empty-file');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '\n   \n');
    expect(loadLedger(root, 'empty-file')).toBeNull();
  });

  it('applyUpdate merges across calls and throws when no field is present', () => {
    let led = applyUpdate(root, 'merge-run', { title: 'Merge task' });
    expect(led.title).toBe('Merge task');

    led = applyUpdate(root, 'merge-run', {
      steps: [{ text: 'a', status: 'pending' }, { text: 'b', status: 'pending' }],
      next_action: 'start a'
    });
    expect(led.steps).toHaveLength(2);
    expect(led.nextAction).toBe('start a');

    // snake_case and camelCase aliases both work
    led = applyUpdate(root, 'merge-run', { add_finding: 'first insight' });
    expect(led.keyFindings).toContain('first insight');
    led = applyUpdate(root, 'merge-run', { addFinding: 'second insight' });
    expect(led.keyFindings).toContain('second insight');
    led = applyUpdate(root, 'merge-run', { nextAction: 'do b' });
    expect(led.nextAction).toBe('do b');

    // persisted between calls — fresh load sees the merged state
    const reloaded = loadLedger(root, 'merge-run');
    expect(reloaded?.steps).toHaveLength(2);
    expect(reloaded?.keyFindings).toHaveLength(2);

    expect(() => applyUpdate(root, 'merge-run', {})).toThrow(/at least one/);
    expect(() => applyUpdate(root, 'merge-run', { file: '   ' })).toThrow(/at least one/);
  });

  it('recordFileTouched creates the ledger on demand and appends the file', () => {
    expect(loadLedger(root, 'touch-run')).toBeNull();
    recordFileTouched(root, 'touch-run', 'auto/file.ts');
    const l = loadLedger(root, 'touch-run');
    expect(l?.filesTouched).toEqual(['auto/file.ts']);
    recordFileTouched(root, 'touch-run', 'another.ts');
    expect(loadLedger(root, 'touch-run')?.filesTouched).toEqual(['auto/file.ts', 'another.ts']);
  });
});

// ---------------- core module: prompt injection ----------------

describe('taskLedger: prompt block', () => {
  it('renderLedgerBlock wraps help or rendered ledger in markers', () => {
    const help = renderLedgerBlock(null);
    expect(help).toContain(LEDGER_START);
    expect(help).toContain(LEDGER_END);
    expect(help).toContain('update_task');
    expect(renderLedgerHelp()).toContain('update_task');

    const withLedger = renderLedgerBlock(emptyLedger('blk'));
    expect(withLedger).toContain('# Task ledger:');
  });

  it('upsertLedgerBlock appends when absent and replaces when present', () => {
    const base = 'You are DevForge.\nAnswer questions.';
    const v1 = renderLedgerBlock(emptyLedger('u1'));
    const once = upsertLedgerBlock(base, v1);
    expect(once).toContain(base.split('\n')[0]);
    expect(once).toContain(LEDGER_START);

    const v2 = renderLedgerBlock(emptyLedger('u2'));
    const twice = upsertLedgerBlock(once, v2);
    expect(twice.split(LEDGER_START).length - 1).toBe(1);
    expect(twice.split(LEDGER_END).length - 1).toBe(1);
    expect(twice).toContain('- Run: u2');
    expect(twice).not.toContain('- Run: u1');
    // leading text preserved
    expect(twice.startsWith('You are DevForge.')).toBe(true);
  });
});

// ---------------- executeTool integration ----------------

describe('executeTool: update_task', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-ledger-tool-'));
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('errors cleanly when no runId is bound', async () => {
    const r = await executeTool(root, {
      id: 'c1',
      name: 'update_task',
      arguments: { title: 'no run' }
    });
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/run id/i);
  });

  it('rejects an unsafe runId via ledgerPath', async () => {
    const r = await executeTool(
      root,
      { id: 'c2', name: 'update_task', arguments: { title: 'bad' } },
      { runId: '../evil' }
    );
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/ERROR/);
  });

  it('persists the ledger and returns a summary', async () => {
    const r = await executeTool(
      root,
      {
        id: 'c3',
        name: 'update_task',
        arguments: {
          title: 'Tool task',
          steps: [
            { text: 'step one', status: 'completed' },
            { text: 'step two', status: 'in_progress' }
          ],
          file: 'src/tool.ts',
          next_action: 'finish step two'
        }
      },
      { runId: 'tool-run' }
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('1/2 steps done');
    expect(r.content).toContain('finish step two');

    const l = loadLedger(root, 'tool-run');
    expect(l?.title).toBe('Tool task');
    expect(l?.steps).toHaveLength(2);
    expect(l?.filesTouched).toContain('src/tool.ts');
    expect(l?.nextAction).toBe('finish step two');
  });

  it('surfaces applyUpdate validation errors as tool errors', async () => {
    const r = await executeTool(
      root,
      { id: 'c4', name: 'update_task', arguments: { noSuchField: true } },
      { runId: 'tool-run' }
    );
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/at least one/);
  });
});

// ---------------- runAgentLoop integration: durable ledger end-to-end ----------------

describe('runAgentLoop: durable task ledger (P1.5a)', () => {
  let wsRoot: string;
  beforeAll(() => {
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-ledger-loop-'));
  });
  afterAll(() => {
    fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  it('updates the ledger via update_task, auto-touches files, and injects progress every iteration', async () => {
    activeMock = await startMockOllama([
      toolCallMessage('update_task', {
        title: 'Loop task',
        steps: [
          { text: 'record plan', status: 'completed' },
          { text: 'write the file', status: 'in_progress' },
          { text: 'wrap up', status: 'pending' }
        ],
        add_finding: 'mock confirms ledger path',
        next_action: 'write artifact.txt'
      }),
      toolCallMessage('write_file', { path: 'artifact.txt', content: 'payload\n' }),
      textMessage('Task recorded and file written.')
    ]);

    const runId = 'ledger-loop-1';
    const result = await runAgentLoop({
      root: wsRoot,
      prompt: 'Do the ledger task',
      modelId: 'test-model',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'You are a test agent.',
      maxIterations: 3,
      runId
    });

    expect(result.usedTools).toBe(true);
    expect(fs.readFileSync(path.join(wsRoot, 'artifact.txt'), 'utf8')).toContain('payload');
    expect(result.reply).toContain('Task recorded');

    // ledger on disk has the model-recorded state AND the auto-touched file
    const l = loadLedger(wsRoot, runId);
    expect(l).not.toBeNull();
    expect(l?.title).toBe('Loop task');
    expect(l?.steps).toHaveLength(3);
    expect(l?.keyFindings).toContain('mock confirms ledger path');
    expect(l?.filesTouched).toContain('artifact.txt'); // auto-touch, not model-recorded

    // every LLM request carried the ledger (or help) block in the system prompt
    expect(activeMock.receivedBodies.length).toBe(3);
    for (const body of activeMock.receivedBodies) {
      expect(body).toContain('<<<TASK_LEDGER');
      expect(body).toContain('>>>TASK_LEDGER');
    }
    // first request predates the model's update_task call (help text only);
    // later requests carry the growing ledger
    expect(activeMock.receivedBodies[0]).toContain('durable task ledger');
    expect(activeMock.receivedBodies[1]).toContain('record plan');
    expect(activeMock.receivedBodies[2]).toContain('artifact.txt');
  });

  it('a resumed run (no conversation) reconstructs progress from the ledger alone', async () => {
    const runId = 'ledger-resume-1';
    // Pass 1: the model records progress, then the run "dies" (no final text)
    activeMock = await startMockOllama([
      toolCallMessage('update_task', {
        title: 'Crash task',
        steps: [
          { text: 'phase one', status: 'completed' },
          { text: 'phase two', status: 'in_progress', note: 'half patched' }
        ],
        next_action: 'finish phase two'
      })
    ]);
    await runAgentLoop({
      root: wsRoot,
      prompt: 'Start the crash task',
      modelId: 'test-model',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'You are a test agent.',
      maxIterations: 1,
      runId
    });
    const l1 = loadLedger(wsRoot, runId);
    expect(l1?.steps[1].status).toBe('in_progress');

    // Pass 2: brand-new conversation (empty history, no priorMessages) — the
    // system prompt must already contain the saved progress when it hits the model
    activeMock = await startMockOllama([
      textMessage('I already know where I left off — phase two, half patched.')
    ]);
    await runAgentLoop({
      root: wsRoot,
      prompt: 'continue',
      modelId: 'test-model',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'You are a test agent (fresh context).',
      maxIterations: 1,
      runId
    });
    const body = activeMock.receivedBodies[0];
    expect(body).toContain('Crash task');
    expect(body).toContain('half patched');
    expect(body).toContain('finish phase two');
  });

  it('without a runId the ledger machinery stays dormant (no files, no block)', async () => {
    const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-ledger-dormant-'));
    activeMock = await startMockOllama([
      toolCallMessage('update_task', { title: 'should fail' }),
      textMessage('Ledger unavailable, moving on.')
    ]);
    const result = await runAgentLoop({
      root: freshRoot,
      prompt: 'Try the ledger without a run id',
      modelId: 'test-model',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'You are a test agent.',
      maxIterations: 2
    });
    expect(result.reply).toContain('moving on');
    expect(fs.existsSync(path.join(freshRoot, '.devforge'))).toBe(false);
    fs.rmSync(freshRoot, { recursive: true, force: true });
    for (const body of activeMock.receivedBodies) {
      expect(body).not.toContain('<<<TASK_LEDGER');
    }
    // the tool call itself failed cleanly and the model kept going
    const failed = result.toolCalls.find((t) => t.name === 'update_task');
    expect(failed?.ok).toBe(false);
  });
});
