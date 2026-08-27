import { describe, it, expect, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildEditProposal, serializeHunks, reviewedArgs } from '../server/reviewGate';
import { applyUnifiedDiff } from '../server/patchEngine';
import { runAgentLoop, ToolCall } from '../server/agentLoop';

function makeWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-review-'));
}
const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
});

// ---------------- buildEditProposal ----------------

describe('buildEditProposal', () => {
  it('splits a write_file into hunks against the current file', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    fs.writeFileSync(path.join(ws, 'a.txt'), 'line1\nline2\nline3\nline4\n');
    const p = buildEditProposal(ws, 'write_file', {
      path: 'a.txt',
      content: 'line1\nCHANGED2\nline3\nline4\nNEW5\n'
    });
    if ('error' in p) throw new Error(p.error);
    expect(p.isNewFile).toBe(false);
    expect(p.hunks.length).toBeGreaterThanOrEqual(1);
    const allLines = p.hunks.flatMap((h) => h.lines);
    expect(allLines.some((l) => l.type === '-' && l.content === 'line2')).toBe(true);
    expect(allLines.some((l) => l.type === '+' && l.content === 'CHANGED2')).toBe(true);
  });

  it('flags new files', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    const p = buildEditProposal(ws, 'write_file', { path: 'new.txt', content: 'hello\n' });
    if ('error' in p) throw new Error(p.error);
    expect(p.isNewFile).toBe(true);
    expect(p.hunks.length).toBe(1);
    expect(p.hunks[0].additions).toBeGreaterThan(0);
  });

  it('computes proposals for apply_patch without touching disk', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    fs.writeFileSync(path.join(ws, 'b.txt'), 'alpha\nbeta\ngamma\n');
    const before = fs.readFileSync(path.join(ws, 'b.txt'), 'utf8');
    const patch = '@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n';
    const p = buildEditProposal(ws, 'apply_patch', { path: 'b.txt', patch });
    if ('error' in p) throw new Error(p.error);
    expect(p.newContent).toContain('BETA');
    // nothing was written
    expect(fs.readFileSync(path.join(ws, 'b.txt'), 'utf8')).toBe(before);
  });

  it('returns an error for unappliable patches or missing payloads', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    fs.writeFileSync(path.join(ws, 'c.txt'), 'x\n');
    expect(buildEditProposal(ws, 'apply_patch', { path: 'c.txt', patch: '@@ -1,1 +1,1 @@\n-nope\nyes\n' })).toHaveProperty('error');
    expect(buildEditProposal(ws, 'write_file', { path: '' })).toHaveProperty('error');
    expect(buildEditProposal(ws, 'apply_patch', { path: '../escape.txt', content: 'z' })).toHaveProperty('error');
  });
});

// ---------------- selective application ----------------

describe('reviewedArgs / serializeHunks', () => {
  it('applies ONLY accepted hunks when executed', () => {
    const ws = makeWs();
    tempDirs.push(ws);
    const original = 'aaa\nbbb\nccc\nddd\neee\nfff\nggg\nhhh\niii\njjj\nkkk\nlll\n';
    fs.writeFileSync(path.join(ws, 'multi.txt'), original);
    const p = buildEditProposal(ws, 'write_file', {
      path: 'multi.txt',
      content: 'AAA\nbbb\nccc\nddd\neee\nfff\nggg\nhhh\niii\njjj\nKKK\nlll\n'
    });
    if ('error' in p) throw new Error(p.error);
    expect(p.hunks.length).toBe(2);

    // Accept only hunk 0
    const args = reviewedArgs(p, [p.hunks[0].id]);
    expect(args).not.toBeNull();
    const res = applyUnifiedDiff(original, args!.patch);
    expect(res.ok).toBe(true);
    expect(res.content).toContain('AAA');
    expect(res.content).toContain('kkk'); // hunk 1 NOT applied
    expect(res.content).not.toContain('KKK');

    // All hunks rejected → null
    expect(reviewedArgs(p, [])).toBeNull();
    // Round-trip serialization includes valid headers
    expect(serializeHunks('multi.txt', p.hunks)).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
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

describe('runAgentLoop: P2.2 reviewEdit gate', () => {
  it('denies edits when the reviewer rejects them', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    activeMock = await startMockOllama([
      tcm('write_file', { path: 'denied.txt', content: 'nope\n' }),
      { role: 'assistant', content: 'understood.' }
    ]);
    const result = await runAgentLoop({
      root: ws,
      prompt: 'work',
      modelId: 'm',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'test',
      maxIterations: 3,
      reviewEdit: async () => null
    });
    expect(result.filesChanged).toEqual([]);
    const denied = result.toolCalls.find((t) => !t.ok);
    expect(denied?.content).toContain('DENIED in diff review');
    expect(fs.existsSync(path.join(ws, 'denied.txt'))).toBe(false);
  });

  it('executes the REVIEWER-transformed call instead of the raw one', async () => {
    const ws = makeWs();
    tempDirs.push(ws);
    fs.writeFileSync(path.join(ws, 'doc.txt'), 'keep\nchange-me\nend\n');
    activeMock = await startMockOllama([
      tcm('apply_patch', { path: 'doc.txt', oldText: 'keep', newText: 'REPLACED-EVERYTHING' }),
      { role: 'assistant', content: 'done.' }
    ]);

    // The "user" accepts a different edit than the model proposed: rewrite args
    const transform = (call: ToolCall): ToolCall => ({
      ...call,
      arguments: { path: call.arguments.path, oldText: 'change-me', newText: 'ACCEPTED-BY-REVIEW' }
    });
    const result = await runAgentLoop({
      root: ws,
      prompt: 'work',
      modelId: 'm',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'test',
      maxIterations: 3,
      reviewEdit: async (call) => transform(call)
    });
    expect(result.filesChanged).toContain('doc.txt');
    const content = fs.readFileSync(path.join(ws, 'doc.txt'), 'utf8');
    expect(content).toContain('ACCEPTED-BY-REVIEW');
    expect(content).not.toContain('REPLACED-EVERYTHING'); // raw proposal never applied
    expect(content).toContain('keep');
  });
});
