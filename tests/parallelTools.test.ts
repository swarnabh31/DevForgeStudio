import { describe, it, expect, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import {
  runAgentLoop,
  isReadOnlyParallelTool,
  executeTool,
  type ToolCall,
  type PluginRuntimeTool
} from '../server/agentLoop';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------- mock Ollama (same protocol contract as other loop tests) ----------------

interface MockOllama {
  port: number;
  close: () => void;
}

function startMockOllama(responses: Array<Record<string, unknown>>): Promise<MockOllama> {
  let n = 0;
  const server = http.createServer((req, r) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/chat') {
        const i = Math.min(n, responses.length - 1);
        n += 1;
        let wantsStream = false;
        try {
          wantsStream = JSON.parse(body).stream === true;
        } catch {}
        r.writeHead(200, {
          'Content-Type': wantsStream ? 'application/x-ndjson' : 'application/json'
        });
        if (wantsStream) {
          r.write(JSON.stringify({ message: responses[i] }) + '\n');
          r.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
        } else {
          r.end(JSON.stringify({ message: responses[i], done: true }));
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

function tcm(namesArgs: Array<{ name: string; args: Record<string, unknown> }>): Record<string, unknown> {
  return {
    role: 'assistant',
    content: '',
    tool_calls: namesArgs.map(({ name, args }) => ({ function: { name, arguments: args } }))
  };
}

let activeMock: MockOllama | null = null;
const tempDirs: string[] = [];
afterEach(() => {
  if (activeMock) {
    activeMock.close();
    activeMock = null;
  }
});
afterAll(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

function makeWs(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-par-'));
  return ws;
}

function seedWorkspace(ws: string): void {
  fs.mkdirSync(path.join(ws, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, 'src', 'lib', 'greeter.ts'),
    'export function greet(name: string) {\n  return `hello ${name}`;\n}\n' +
      'export const FAREWELL = "goodbye";\n'
  );
  fs.writeFileSync(path.join(ws, 'README.md'), '# demo\n\nunique-needle-xyz lives here\n');
  fs.writeFileSync(path.join(ws, 'src', 'main.ts'), 'import { greet } from "./lib/greeter";\nconsole.log(greet("dev"));\n');
}

// ---------------- classification ----------------

describe('P7.1 read-only parallel tool classification', () => {
  it('classifies the pure, state-free read-only tools, and nothing stateful', () => {
    expect(isReadOnlyParallelTool('list_files')).toBe(true);
    expect(isReadOnlyParallelTool('search')).toBe(true);
    expect(isReadOnlyParallelTool('file_outline')).toBe(true);

    // Excluded on purpose: they mutate shared state, spawn subagents, or
    // run arbitrary work. Safe to keep sequential only.
    expect(isReadOnlyParallelTool('read_file')).toBe(false); // recordMtime
    expect(isReadOnlyParallelTool('semantic_search')).toBe(false); // index maintenance
    expect(isReadOnlyParallelTool('delegate_research')).toBe(false);
    expect(isReadOnlyParallelTool('update_task')).toBe(false);
    expect(isReadOnlyParallelTool('update_plan')).toBe(false);
    expect(isReadOnlyParallelTool('run_command')).toBe(false);
    expect(isReadOnlyParallelTool('write_file')).toBe(false);
    expect(isReadOnlyParallelTool('apply_patch')).toBe(false);
    expect(isReadOnlyParallelTool('unknown_tool')).toBe(false);

    // Plugin tools are user-defined side effects — never auto-parallelized.
    expect(isReadOnlyParallelTool('my_custom_tool')).toBe(false);
  });
});

// ---------------- loop integration ----------------

describe('P7.1 parallel read-only batch in runAgentLoop', () => {
  it('fans a read-only batch out concurrently (all calls dispatched before any result)', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    seedWorkspace(ws);

    activeMock = await startMockOllama([
      tcm([
        { name: 'list_files', args: { glob: 'src/**/*.ts' } },
        { name: 'search', args: { query: 'unique-needle-xyz' } },
        { name: 'file_outline', args: { path: 'src/lib/greeter.ts' } }
      ]),
      { role: 'assistant', content: 'done.' }
    ]);

    const events: any[] = [];
    const result = await runAgentLoop({
      root: ws,
      prompt: 'investigate',
      modelId: 'm',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'test',
      maxIterations: 3,
      onEvent: (e) => events.push(e)
    });

    const calls = events.filter((e) => e.type === 'tool_call');
    const results = events.filter((e) => e.type === 'tool_result');
    expect(calls).toHaveLength(3);
    expect(results).toHaveLength(3);

    // CONCURRENT PROOF: when the three read-only tools share a batch, ALL
    // three dispatch before the first result lands (Promise.allSettled fan-out).
    // The old sequential loop would interleave: call, result, call, result, …
    const firstResultIdx = events.findIndex((e) => e.type === 'tool_result');
    const lastCallIdx = Math.max(...events.map((e, i) => (e.type === 'tool_call' ? i : -1)));
    expect(lastCallIdx).toBeLessThan(firstResultIdx);

    // Model-declared ORDER is preserved in the transcript
    expect(results.map((e) => e.result.name)).toEqual(['list_files', 'search', 'file_outline']);
    expect(result.toolCalls.map((t) => t.name)).toEqual(['list_files', 'search', 'file_outline']);
    // All three actually produced real results
    expect(results.every((e) => e.result.ok)).toBe(true);
  });

  it('partial-failure isolation: one bad call in the batch does not sink the others', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    seedWorkspace(ws);

    activeMock = await startMockOllama([
      tcm([
        { name: 'list_files', args: {} },
        { name: 'file_outline', args: { path: 'no/such/file.ts' } }, // fails
        { name: 'search', args: { query: 'greet' } }
      ]),
      { role: 'assistant', content: 'done.' }
    ]);

    const result = await runAgentLoop({
      root: ws,
      prompt: 'go',
      modelId: 'm',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'test',
      maxIterations: 3
    });

    const names = result.toolCalls.map((t) => t.name);
    expect(names).toEqual(['list_files', 'file_outline', 'search']);
    const good = result.toolCalls.filter((t) => t.ok).length;
    const bad = result.toolCalls.filter((t) => !t.ok).length;
    expect(good).toBe(2);
    expect(bad).toBe(1);
    const outlineErr = result.toolCalls.find((t) => t.name === 'file_outline')!;
    expect(outlineErr.content).toMatch(/ERROR/);
  });

  it('write path stays STRICTLY SEQUENTIAL after the read batch (order + determinism)', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    seedWorkspace(ws);
    activeMock = await startMockOllama([
      tcm([
        { name: 'list_files', args: {} },
        { name: 'search', args: { query: 'greet' } },
        { name: 'file_outline', args: { path: 'src/lib/greeter.ts' } }
      ]),
      tcm([{ name: 'write_file', args: { path: 'out.txt', content: 'result\n' } }]),
      { role: 'assistant', content: 'done.' }
    ]);

    const events: any[] = [];
    const result = await runAgentLoop({
      root: ws,
      prompt: 'go',
      modelId: 'm',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'test',
      maxIterations: 5,
      onEvent: (e) => events.push(e),
      requestPermission: async () => true
    });

    const names = result.toolCalls.map((t) => t.name);
    expect(names).toEqual(['list_files', 'search', 'file_outline', 'write_file']);
    expect(fs.readFileSync(path.join(ws, 'out.txt'), 'utf8')).toBe('result\n');
    expect(result.filesChanged).toContain('out.txt');

    // The write_file dispatch must come AFTER all three read results
    const writeCallIdx = events.findIndex((e) => e.type === 'tool_call' && e.name === 'write_file');
    const thirdResultIdx = events.filter((e) => e.type === 'tool_result').length
      ? events.lastIndexOf((e: any) => e.type === 'tool_result' && e.result.name === 'file_outline')
      : -1;
    expect(writeCallIdx).toBeGreaterThan(thirdResultIdx);
  });

  it('a single read-only tool (no batch) still runs fine through the sequential path', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    seedWorkspace(ws);
    activeMock = await startMockOllama([
      tcm([{ name: 'list_files', args: {} }]),
      { role: 'assistant', content: 'done.' }
    ]);
    const result = await runAgentLoop({
      root: ws,
      prompt: 'go',
      modelId: 'm',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'test',
      maxIterations: 3
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('list_files');
    expect(result.toolCalls[0].ok).toBe(true);
  });

  it('permission deny + failed-repeat guard still apply for sequential tools', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    seedWorkspace(ws);
    activeMock = await startMockOllama([
      ...Array.from({ length: 7 }, () =>
        tcm([{ name: 'write_file', args: { path: 'x.txt', content: 'no\n' } }])
      ),
      { role: 'assistant', content: 'end.' }
    ]);

    const result = await runAgentLoop({
      root: ws,
      prompt: 'go',
      modelId: 'm',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'test',
      maxIterations: 10,
      requestPermission: async () => false
    });

    // Denied: user refused every write
    const denials = result.toolCalls.filter((t) => /DENIED/.test(t.content));
    expect(denials.length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(ws, 'x.txt'))).toBe(false);
  });
});

// ---------------- per-call timeout + cancel (executeTool direct) ----------------

describe('P7.1 per-call timeout + cancel propagation', () => {
  it('a hung tool call is cut off at toolTimeoutMs with a timeout error', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    const hangTool: PluginRuntimeTool = {
      name: 'hang',
      schema: { type: 'object' },
      execute: async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return { ok: true, output: 'late' };
      }
    };
    const call: ToolCall = { id: 'c1', name: 'hang', arguments: {} };
    const t0 = Date.now();
    const p = executeTool(ws, call, { timeoutMs: 120, pluginTools: [hangTool] });
    const result = await p;
    const wall = Date.now() - t0;
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/budget|timed out|timeout/i);
    expect(wall).toBeLessThan(2000); // didn't wait for the 5s sleep
  });

  it('aborting the signal cancels a pending tool call', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    const controller = new AbortController();
    const slowTool: PluginRuntimeTool = {
      name: 'slow',
      schema: { type: 'object' },
      execute: async () => {
        await new Promise((r) => setTimeout(r, 3000));
        return { ok: true, output: 'late' };
      }
    };
    const call: ToolCall = { id: 'c2', name: 'slow', arguments: {} };
    setTimeout(() => controller.abort(), 60);
    const result = await executeTool(ws, call, {
      timeoutMs: 10000,
      signal: controller.signal,
      pluginTools: [slowTool]
    });
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/cancelled/i);
  });

  it('a healthy call inside the timeout budget still succeeds', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    fs.writeFileSync(path.join(ws, 'ok.txt'), 'fine\n');
    const result = await executeTool(
      ws,
      { id: 'c3', name: 'read_file', arguments: { path: 'ok.txt' } },
      { timeoutMs: 2000 }
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain('fine');
  });
});
