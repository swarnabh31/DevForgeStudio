import { describe, it, expect, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  detectVerifyCommands,
  runVerification,
  renderVerificationFailure
} from '../server/verify';
import { runAgentLoop } from '../server/agentLoop';

function makeWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-verify-'));
}
const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

// ---------------- detection ----------------

describe('detectVerifyCommands', () => {
  it('returns [] when nothing detectable', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    expect(detectVerifyCommands(ws)).toEqual([]);
  });

  it('detects package.json scripts (typecheck > lint > test order)', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    fs.writeFileSync(
      path.join(ws, 'package.json'),
      JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest run', typecheck: 'tsc --noEmit' } })
    );
    const cmds = detectVerifyCommands(ws).map((c) => c.command);
    expect(cmds).toEqual(['npm run typecheck', 'npm run lint', 'npm test']);
  });

  it('uses local tsc when tsconfig + node_modules exist but no typecheck script', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    fs.writeFileSync(path.join(ws, 'tsconfig.json'), '{}');
    fs.mkdirSync(path.join(ws, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo no tests' } })
    );
    const cmds = detectVerifyCommands(ws);
    // tsc detected; `echo` test script deliberately ignored
    expect(cmds.map((c) => c.command)).toEqual(['tsc --noEmit']);
  });

  it('detects pytest for python projects', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    fs.writeFileSync(path.join(ws, 'pyproject.toml'), '[tool.pytest]\n');
    expect(detectVerifyCommands(ws).map((c) => c.command)).toEqual(['pytest -x -q']);
  });
});

// ---------------- runner ----------------

describe('runVerification', () => {
  it('reports pass and failure with exit codes', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    const results = await runVerification(ws, [
      { name: 'ok', command: `node -e "process.exit(0)"` },
      { name: 'bad', command: `node -e "console.error('boom'); process.exit(3)"` }
    ]);
    expect(results.length).toBe(2);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].exitCode).toBe(3);
    expect(results[1].output).toContain('boom');
  });

  it('stops at first failure unless runAll', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    const cmds = [
      { name: 'a', command: `node -e "process.exit(1)"` },
      { name: 'b', command: `node -e "process.exit(0)"` }
    ];
    expect((await runVerification(ws, cmds)).length).toBe(1);
    expect((await runVerification(ws, cmds, { runAll: true })).length).toBe(2);
  });

  it('keeps the TAIL of oversized output', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    const results = await runVerification(ws, [
      {
        name: 'noisy',
        command: `node -e "console.log('x'.repeat(9000) + 'THE_REAL_ERROR'); process.exit(1)"`
      }
    ]);
    expect(results[0].output.length).toBeLessThan(9000);
    expect(results[0].output).toContain('THE_REAL_ERROR');
  });
});

describe('renderVerificationFailure', () => {
  it('includes failing command and output', () => {
    const msg = renderVerificationFailure([
      {
        command: { name: 't', command: 'tsc --noEmit' },
        ok: false,
        exitCode: 2,
        durationMs: 10,
        output: "src/x.ts(1,1): error TS2304: Cannot find name 'foo'"
      }
    ]);
    expect(msg).toContain('VERIFICATION FAILED');
    expect(msg).toContain('tsc --noEmit');
    expect(msg).toContain('TS2304');
  });
});

// ---------------- agent loop integration ----------------

interface MockOllama {
  port: number;
  close: () => void;
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
  const server = http.createServer((req, r) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/chat') {
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
          // Ollama-style NDJSON: message chunk then final done frame
          r.write(JSON.stringify({ message: responses[i] }) + '\n');
          r.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
        } else {
          r.end(JSON.stringify({ message: responses[i] }));
        }
      } else {
        r.writeHead(404, {});
        r.end('{}');
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

describe('runAgentLoop: P1.2 auto-verify / self-heal', () => {
  it('runs verification after edits, injects failures back, and lets the model heal', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    // A sentinel file the verify command checks; starts missing (fail), the
    // "model" creates it during the heal pass so verification then passes.
    activeMock = await startMockOllama([
      toolCallMessage('write_file', { path: 'src.txt', content: 'work\n' }),
      toolCallMessage('write_file', { path: 'verified.txt', content: 'ok\n' }),
      textMessage('Fixed and verified.')
    ]);

    const events: any[] = [];
    const result = await runAgentLoop({
      root: ws,
      prompt: 'do work',
      modelId: 'test-model',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'test',
      maxIterations: 6,
      onEvent: (e) => events.push(e),
      autoVerify: {
        commands: [
          {
            name: 'sentinel',
            command: `node -e "require('fs').accessSync('verified.txt')" `
          }
        ],
        maxHealAttempts: 3
      }
    });

    expect(result.reply).toContain('Fixed and verified.');
    const types = events.map((e) => e.type);
    // edit -> verify fail -> heal -> edit -> verify pass -> final answer
    expect(types.filter((t) => t === 'verify_start').length).toBe(2);
    expect(types.filter((t) => t === 'verify_result').length).toBe(2);
    expect(events.find((e) => e.type === 'verify_result' && e.ok === true)).toBeDefined();
    expect(events.find((e) => e.type === 'verify_result' && e.ok === false)).toBeDefined();
    expect(events.find((e) => e.type === 'verify_heal')).toMatchObject({ attempt: 1, maxAttempts: 3 });
    expect(fs.existsSync(path.join(ws, 'verified.txt'))).toBe(true);
  });

  it('stops with a visible reason when heal attempts are exhausted', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    // Single clamped response: the model keeps writing files, verification
    // keeps failing, until the heal budget runs out.
    activeMock = await startMockOllama([
      toolCallMessage('write_file', { path: 'a.txt', content: 'x\n' })
    ]);

    const events: any[] = [];
    const result = await runAgentLoop({
      root: ws,
      prompt: 'do work',
      modelId: 'test-model',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'test',
      maxIterations: 5,
      onEvent: (e) => events.push(e),
      autoVerify: {
        commands: [{ name: 'always-fail', command: `node -e "process.exit(7)"` }],
        maxHealAttempts: 2
      }
    });

    // 1 initial + 2 heals, then stop
    expect(events.filter((e) => e.type === 'verify_start').length).toBe(3);
    expect(events.filter((e) => e.type === 'verify_heal').map((e) => e.attempt)).toEqual([1, 2]);
    const stopToken = events.find(
      (e) => e.type === 'token' && String(e.delta || '').includes('auto-verify still failing')
    );
    expect(stopToken).toBeDefined();
    expect(result.hitIterationCap).toBe(false);
  });

  it('does not verify when no files were edited', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    activeMock = await startMockOllama([
      toolCallMessage('list_files', {}),
      textMessage('just looked around')
    ]);
    const events: any[] = [];
    await runAgentLoop({
      root: ws,
      prompt: 'explore only',
      modelId: 'test-model',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'test',
      maxIterations: 3,
      onEvent: (e) => events.push(e),
      autoVerify: {
        commands: [{ name: 'never', command: `node -e "process.exit(1)"` }]
      }
    });
    expect(events.some((e) => e.type === 'verify_start')).toBe(false);
  });
});

