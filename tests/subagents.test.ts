import { describe, it, expect, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runExploreSubagent, isReadOnlyTool } from '../server/subagents';
import { executeTool } from '../server/agentLoop';

function makeWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-subagent-'));
}
const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

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
        const i = Math.min(n, responses.length - 1);
        n += 1;
        let wantsStream = false;
        try {
          wantsStream = JSON.parse(body).stream === true;
        } catch {}
        r.writeHead(200, { 'Content-Type': wantsStream ? 'application/x-ndjson' : 'application/json' });
        if (wantsStream) {
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

describe('runExploreSubagent', () => {
  it('researches with read-only tools and returns a compact report', async () => {
    activeMock = await startMockOllama([
      toolCallMessage('read_file', { path: 'src.ts' }),
      textMessage(
        'ANSWER: parsing lives in src.ts.\nsrc.ts:1-3 parseCsv\nKey fact: splits on commas.'
      )
    ]);
    const ws = makeWs();
    tempDirs.push(ws);
    fs.writeFileSync(path.join(ws, 'src.ts'), 'export function parseCsv(s: string) {\n  return s.split(",");\n}\n');

    const sub = await runExploreSubagent({
      root: ws,
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      modelId: 'test-model',
      question: 'where are CSVs parsed?'
    });

    expect(sub.report).toContain('parseCsv');
    expect(sub.stoppedEarly).toBe(false);
    expect(fs.existsSync(path.join(ws, 'src.ts'))).toBe(true); // untouched
  });

  it('HARD-DENIES side-effecting tools even if the model attempts them', async () => {
    activeMock = await startMockOllama([
      toolCallMessage('write_file', { path: 'evil.txt', content: 'nope' }),
      toolCallMessage('read_file', { path: 'src.ts' }),
      textMessage('done investigating')
    ]);
    const ws = makeWs();
    tempDirs.push(ws);
    fs.writeFileSync(path.join(ws, 'src.ts'), 'export const a = 1;\n');

    await runExploreSubagent({
      root: ws,
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      modelId: 'test-model',
      question: 'look around'
    });

    expect(fs.existsSync(path.join(ws, 'evil.txt'))).toBe(false);
  });

  it('reports an empty report when the budget runs out', async () => {
    // Clamped single response keeps calling read_file forever → budget exhausted
    activeMock = await startMockOllama([toolCallMessage('list_files', {})]);
    const ws = makeWs();
    tempDirs.push(ws);

    const sub = await runExploreSubagent({
      root: ws,
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      modelId: 'test-model',
      question: 'map the repo',
      maxIterations: 3
    });

    expect(sub.stoppedEarly).toBe(true);
    expect(sub.iterations).toBeGreaterThanOrEqual(3);
    expect(sub.report.length).toBeGreaterThan(0);
  });
});

describe('delegate_research tool dispatch', () => {
  it('errors clearly when not wired; returns the report when wired', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    const call = (args: Record<string, unknown>) => ({
      id: 'c1',
      name: 'delegate_research',
      arguments: args
    });

    const missing = await executeTool(ws, call({ question: 'q' }));
    expect(missing.ok).toBe(false);
    expect(missing.content).toContain('unavailable');

    const ok = await executeTool(ws, call({ question: 'where is X?' }), {
      runSubagent: async (q) => `REPORT about ${q}`
    });
    expect(ok.ok).toBe(true);
    expect(ok.content).toBe('REPORT about where is X?');
  });
});

describe('isReadOnlyTool', () => {
  it('classifies read vs write tools', () => {
    expect(isReadOnlyTool('read_file')).toBe(true);
    expect(isReadOnlyTool('search')).toBe(true);
    expect(isReadOnlyTool('write_file')).toBe(false);
    expect(isReadOnlyTool('run_command')).toBe(false);
  });
});
