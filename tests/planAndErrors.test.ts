import { describe, it, expect, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  classifyToolFailure,
  classifyLlmError
} from '../server/errorTaxonomy';
import { executeTool, runAgentLoop } from '../server/agentLoop';

// ---------------- taxonomy classification ----------------

describe('classifyToolFailure (P1.4)', () => {
  const cases: Array<[string, string, boolean]> = [
    ['DENIED by user. Do not retry this action', 'permission', false],
    ['ERROR: CONFLICT — this file was modified outside the agent since you last read it.', 'conflict', false],
    ['EDIT REJECTED BY VALIDATION GATE (file was NOT written):\ninvalid JSON', 'validation_gate', true],
    ['ERROR: Hunk context found near line 3 with 60% similarity (< 75% required).', 'patch_match', true],
    ["ERROR: provide \"patch\" (unified diff) or \"oldText\"/\"newText\" to apply.", 'missing_input', true],
    ['exit=1\nFAIL src/a.test.ts — expected 2 got 3', 'command', false],
    ['ERROR: binary file', 'filesystem', true]
  ];

  for (const [content, category, retryable] of cases) {
    it(`classifies "${category}"`, () => {
      const cls = classifyToolFailure(content);
      expect(cls.category).toBe(category);
      expect(cls.retryable).toBe(retryable);
      if (category !== 'cancelled') expect(cls.guidance).toBeTruthy();
    });
  }

  it('gives unknown errors a cautious default', () => {
    const cls = classifyToolFailure('ERROR: something weird');
    expect(cls.category).toBe('unknown');
    expect(cls.guidance).toBeTruthy();
  });
});

describe('classifyLlmError (P1.4)', () => {
  it('recognizes network failures with recovery guidance', () => {
    const e = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const cls = classifyLlmError(e);
    expect(cls.category).toBe('network');
    expect(cls.guidance).toContain('ollama serve');
  });

  it('recognizes cancellation and timeouts distinctly', () => {
    expect(classifyLlmError(new Error('cancelled')).category).toBe('cancelled');
    expect(classifyLlmError(new Error('request aborted: timeout')).category).toBe('timeout');
    expect(classifyLlmError(new Error('mystery')).category).toBe('unknown');
  });
});

// ---------------- P1.3 structured planning ----------------

function makeWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-plan-'));
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

describe('update_plan tool (P1.3)', () => {
  it('accepts a valid plan and reports completion counts', async () => {
    const root = ws();
    const seen: any[] = [];
    const result = await executeTool(root, {
      id: 'p1',
      name: 'update_plan',
      arguments: {
        steps: [
          { text: 'Parse input', status: 'completed' },
          { text: 'Implement parser', status: 'in_progress' },
          { text: 'Write tests' }
        ],
        note: 'halfway'
      }
    }, { onPlanUpdate: (steps) => seen.push(steps) });

    expect(result.ok).toBe(true);
    expect(result.content).toContain('1/3 completed');
    expect(seen[0]).toEqual([
      { text: 'Parse input', status: 'completed' },
      { text: 'Implement parser', status: 'in_progress' },
      { text: 'Write tests', status: 'pending' }
    ]);
  });

  it('rejects empty plans', async () => {
    const result = await executeTool(ws(), {
      id: 'p2',
      name: 'update_plan',
      arguments: { steps: [] }
    });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('requires a non-empty steps array');
  });
});

// ---------------- loop integration ----------------

interface MockOllama {
  port: number;
  close: () => void;
}
function tcm(name: string, args: Record<string, unknown>) {
  return { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] };
}
function startMockOllama(responses: Array<Record<string, unknown>>): Promise<MockOllama> {
  let n = 0;
  const server = http.createServer((req, r) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => {
      void body;
      const i = Math.min(n, responses.length - 1);
      n += 1;
      const wantsStream = (() => {
        try {
          return JSON.parse(body).stream === true;
        } catch {
          return false;
        }
      })();
      r.writeHead(200, { 'Content-Type': wantsStream ? 'application/x-ndjson' : 'application/json' });
      if (wantsStream) {
        r.write(JSON.stringify({ message: responses[i] }) + '\n');
        r.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
      } else {
        r.end(JSON.stringify({ message: responses[i] }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('unexpected address');
      resolve({ port: addr.port, close: () => server.close() });
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

describe('runAgentLoop: P1.3/P1.4 integration', () => {
  it('emits plan_update events during the run', async () => {
    const root = ws();
    activeMock = await startMockOllama([
      tcm('update_plan', {
        steps: [
          { text: 'Create module', status: 'in_progress' },
          { text: 'Verify', status: 'pending' }
        ]
      }),
      tcm('write_file', { path: 'mod.ts', content: 'export const m = 1;\n' }),
      tcm('update_plan', {
        steps: [
          { text: 'Create module', status: 'completed' },
          { text: 'Verify', status: 'completed' }
        ]
      }),
      { role: 'assistant', content: 'All steps done.' }
    ]);

    const events: any[] = [];
    const result = await runAgentLoop({
      root,
      prompt: 'work',
      modelId: 'm',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'test',
      maxIterations: 6,
      onEvent: (e) => events.push(e)
    });
    expect(result.reply).toContain('All steps done.');
    const updates = events.filter((e) => e.type === 'plan_update');
    expect(updates.length).toBe(2);
    expect(updates[0].steps).toHaveLength(2);
    expect(updates[1].steps.every((s: any) => s.status === 'completed')).toBe(true);
    // P2.3: per-iteration timing events
    const iterEnds = events.filter((e) => e.type === 'iteration_end');
    expect(iterEnds.length).toBeGreaterThanOrEqual(3);
    expect(iterEnds[0]).toMatchObject({ index: 0 });
    expect(typeof iterEnds[0].durationMs).toBe('number');
  });

  it('conversation carries [category] guidance after a patch_match failure', async () => {
    const root = ws();
    fs.writeFileSync(path.join(root, 'code.ts'), 'const a = 1;\n');
    activeMock = await startMockOllama([
      tcm('apply_patch', { path: 'code.ts', oldText: 'ABSENT ANCHOR LINE', newText: 'x' }),
      { role: 'assistant', content: 'will re-read.' }
    ]);
    const result = await runAgentLoop({
      root,
      prompt: 'work',
      modelId: 'm',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'test',
      maxIterations: 3
    });
    const failedMsg = result.messages!.find(
      (m) => m.role === 'tool' && m.content.includes('[patch_match] Recovery:')
    );
    expect(failedMsg).toBeDefined();
    expect(failedMsg!.content).toContain('read_file');
  });
});
