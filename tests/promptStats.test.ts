import { describe, it, expect, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import { runAgentLoop } from '../server/agentLoop';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

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
        r.writeHead(200, { 'Content-Type': wantsStream ? 'application/x-ndjson' : 'application/json' });
        if (wantsStream) {
          r.write(JSON.stringify({ message: responses[i] }) + '\n');
          // Final done frame carries inference timing stats
          r.end(
            JSON.stringify({
              message: { role: 'assistant', content: '' },
              done: true,
              prompt_eval_count: 500,
              prompt_eval_duration: 250_000_000,
              eval_count: 42,
              eval_duration: 840_000_000
            }) + '\n'
          );
        } else {
          r.end(
            JSON.stringify({
              message: responses[i],
              done: true,
              prompt_eval_count: 500,
              prompt_eval_duration: 250_000_000,
              eval_count: 42,
              eval_duration: 840_000_000
            })
          );
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

describe('P3.4 prompt-eval stats surfaced from Ollama', () => {
  it('emits iteration_end with prompt/eval timings (streaming path)', async () => {
    activeMock = await startMockOllama([{ role: 'assistant', content: 'All done.' }]);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-stats-'));
    tempDirs.push(ws);

    const events: any[] = [];
    await runAgentLoop({
      root: ws,
      prompt: 'say done',
      modelId: 'test-model',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'test',
      maxIterations: 2,
      onEvent: (e) => events.push(e)
    });

    const end = events.find((e) => e.type === 'iteration_end');
    expect(end).toBeDefined();
    expect(end.promptEvalTokens).toBe(500);
    expect(end.promptEvalMs).toBe(250);
    expect(end.evalTokens).toBe(42);
    expect(end.evalMs).toBe(840);
  });
});
