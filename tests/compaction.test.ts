import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  estimateMessagesTokens,
  segmentTurns,
  compactWithSummary,
  type CompactionMessage
} from '../server/compaction';
import { runAgentLoop } from '../server/agentLoop';

// ---------------- token accountant ----------------

describe('estimateMessagesTokens', () => {
  it('scales with content size (~4 chars/token + per-message overhead)', () => {
    const one = estimateMessagesTokens([{ content: 'a'.repeat(400) }]);
    expect(one).toBeGreaterThanOrEqual(100);
    const two = estimateMessagesTokens([
      { content: 'a'.repeat(400) },
      { content: 'b'.repeat(400) }
    ]);
    expect(two).toBeGreaterThan(one);
  });

  it('handles empty input', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });
});

// ---------------- segmentation ----------------

describe('segmentTurns', () => {
  const user: CompactionMessage = { role: 'user', content: 'u' };
  const asstCall: CompactionMessage = {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: '1', type: 'function', function: { name: 'x', arguments: '{}' } }
    ]
  };
  const tool: CompactionMessage = { role: 'tool', content: 'r', tool_call_id: '1' };
  const asstText: CompactionMessage = { role: 'assistant', content: 'done' };

  it('keeps assistant/tool_call pairs attached to their turn', () => {
    const segments = segmentTurns([user, asstCall, tool, asstText]);
    // user turn owns its first assistant tool-call + result; a fresh assistant
    // message after a tool result is a new iteration turn
    expect(segments.map((s) => [s.start, s.end])).toEqual([
      [0, 3],
      [3, 4]
    ]);
  });

  it('returns [] for messages with no turn start (defensive)', () => {
    expect(segmentTurns([{ role: 'tool', content: 'orphan' }])).toEqual([]);
  });
});

// ---------------- digest compaction ----------------

interface MockServer {
  port: number;
  close: () => void;
  summarizeRequests: number;
}

/**
 * Mock Ollama that answers BOTH agent-style calls (NDJSON, scripted) and
 * summarization calls (non-stream, detected by the CONVERSATION EXCERPT prompt)
 * with a fixed digest.
 */
function startMock(
  agentResponses: Array<Record<string, unknown>>,
  opts: { failSummaries?: boolean; shortDigest?: boolean } = {}
): Promise<MockServer> {
  let n = 0;
  const state = { summarizeRequests: 0 };
  const server = http.createServer((req, r) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/api/chat') {
        r.writeHead(404, {});
        r.end('{}');
        return;
      }
      let parsed: any = {};
      try {
        parsed = JSON.parse(body);
      } catch {}
      const isSummary =
        !parsed.tools &&
        typeof parsed.messages?.[0]?.content === 'string' &&
        parsed.messages[0].content.includes('CONVERSATION EXCERPT');
      if (isSummary) {
        state.summarizeRequests++;
        r.writeHead(200, { 'Content-Type': 'application/json' });
        const content =
          opts.failSummaries || opts.shortDigest
            ? opts.failSummaries
              ? ''
              : 'too short'
            : 'Files: src/a.txt — created; src/b.txt — patched. Decisions: use util X. Errors & Fixes: none yet. Remaining: verify.';
        r.end(JSON.stringify({ message: { role: 'assistant', content } }));
        return;
      }
      const i = Math.min(n, agentResponses.length - 1);
      n += 1;
      r.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      r.write(JSON.stringify({ message: agentResponses[i] }) + '\n');
      r.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('unexpected address');
      resolve({
        port: addr.port,
        close: () => server.close(),
        get summarizeRequests() {
          return state.summarizeRequests;
        }
      });
    });
  });
}

let activeMock: MockServer | null = null;
afterEach(() => {
  if (activeMock) {
    activeMock.close();
    activeMock = null;
  }
});

function tcm(name: string, args: Record<string, unknown>) {
  return { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] };
}

describe('compactWithSummary', () => {
  it('replaces oldest turns with a digest, keeps system + recent turns verbatim', async () => {
    activeMock = await startMock([]);
    const messages: CompactionMessage[] = [
      { role: 'system', content: 'sys rules' },
      ...Array.from({ length: 6 }, (_, i): CompactionMessage[] => [
        { role: 'user', content: `turn ${i}` },
        { role: 'assistant', content: `answer ${i}` }
      ]).flat()
    ];
    const digested = await compactWithSummary(messages, {
      endpoint: `http://127.0.0.1:${activeMock.port}`,
      modelId: 'm',
      keepRecentTurns: 2
    });
    // 12 messages form 6 turns (assistant attaches to its user); keep 2 recent → digest 4
    expect(digested).toBe(4);
    expect(messages[0].content).toBe('sys rules');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('CONVERSATION DIGEST');
    expect(messages[1].content).toContain('src/a.txt');
    expect(activeMock.summarizeRequests).toBe(1);
    // last two turns untouched
    expect(messages[messages.length - 1].content).toBe('answer 5');
    expect(messages[messages.length - 2].content).toBe('turn 5');
  });

  it('is a no-op when there are too few turns or summarization fails', async () => {
    activeMock = await startMock([], { failSummaries: true });
    const few: CompactionMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' }
    ];
    expect(await compactWithSummary(few, {
      endpoint: `http://127.0.0.1:${activeMock.port}`,
      modelId: 'm'
    })).toBe(0);

    const many: CompactionMessage[] = [
      { role: 'system', content: 's' },
      ...Array.from({ length: 5 }, (_, i): CompactionMessage[] => [
        { role: 'user', content: `t${i}` },
        { role: 'assistant', content: `a${i}` }
      ]).flat()
    ];
    const snapshot = JSON.stringify(many);
    expect(await compactWithSummary(many, {
      endpoint: `http://127.0.0.1:${activeMock.port}`,
      modelId: 'm',
      keepRecentTurns: 2
    })).toBe(0);
    expect(JSON.stringify(many)).toBe(snapshot); // untouched on failure
  });

  it('rejects too-short digests instead of destroying context', async () => {
    activeMock = await startMock([], { shortDigest: true });
    const many: CompactionMessage[] = [
      { role: 'system', content: 's' },
      ...Array.from({ length: 5 }, (_, i): CompactionMessage[] => [
        { role: 'user', content: `t${i}` },
        { role: 'assistant', content: `a${i}` }
      ]).flat()
    ];
    const snapshot = JSON.stringify(many);
    expect(
      await compactWithSummary(many, {
        endpoint: `http://127.0.0.1:${activeMock.port}`,
        modelId: 'm',
        keepRecentTurns: 2
      })
    ).toBe(0);
    expect(JSON.stringify(many)).toBe(snapshot);
  });

  // P7.4 non-lossy compaction: full verbatim transcript is persisted before the
  // digested turns are replaced, and the digest points the agent back to it.

  function manyTurns(): CompactionMessage[] {
    return [
      { role: 'system', content: 's' },
      ...Array.from({ length: 5 }, (_, i): CompactionMessage[] => [
        { role: 'user', content: `t${i} - user marker ${i}` },
        { role: 'assistant', content: `a${i} - asst marker ${i}` }
      ]).flat()
    ];
  }

  it('writes the full verbatim transcript to .opencode/memory and points the digest at it', async () => {
    activeMock = await startMock([]);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-nonlossy-'));
    try {
      const messages = manyTurns();
      const digested = await compactWithSummary(messages, {
        endpoint: `http://127.0.0.1:${activeMock.port}`,
        modelId: 'm',
        keepRecentTurns: 2,
        root: ws,
        runId: 'run-xyz/1'
      });
      expect(digested).toBe(3);
      const file = path.join(ws, '.opencode', 'memory', 'run-xyz_1-c1.md');
      expect(fs.existsSync(file)).toBe(true);
      const body = fs.readFileSync(file, 'utf-8');
      // Every digested message content survives verbatim on disk
      for (let i = 0; i < 3; i++) {
        expect(body).toContain(`t${i} - user marker ${i}`);
        expect(body).toContain(`a${i} - asst marker ${i}`);
      }
      expect(body).toContain('# Conversation transcript — run-xyz_1 (compaction 1)');
      // Keeps system + recent turns, with a pointer inside the digest marker
      expect(messages[0].content).toBe('s');
      expect(messages[messages.length - 1].content).toBe('a4 - asst marker 4');
      const digestMsg = messages.find((m) => m.role === 'user' && m.content.includes('CONVERSATION DIGEST'))!;
      expect(digestMsg.content).toContain('read_file .opencode/memory/run-xyz_1-c1.md');
      expect(digestMsg.content).toMatch(/\(\d+ chars\)/);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('numbers repeated compactions sequentially so no transcript overwrites its predecessor', async () => {
    activeMock = await startMock([]);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-nonlossy-seq-'));
    try {
      for (let i = 0; i < 2; i++) {
        const messages = manyTurns();
        await compactWithSummary(messages, {
          endpoint: `http://127.0.0.1:${activeMock.port}`,
          modelId: 'm',
          keepRecentTurns: 2,
          root: ws,
          runId: 'r-seq'
        });
      }
      const files = fs.readdirSync(path.join(ws, '.opencode', 'memory')).sort();
      expect(files).toEqual(['r-seq-c1.md', 'r-seq-c2.md']);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('writes no transcript and keeps the plain digest when root/runId is not provided', async () => {
    activeMock = await startMock([]);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-nodir-'));
    try {
      const messages = manyTurns();
      await compactWithSummary(messages, {
        endpoint: `http://127.0.0.1:${activeMock.port}`,
        modelId: 'm',
        keepRecentTurns: 2
      });
      expect(fs.existsSync(path.join(ws, '.opencode'))).toBe(false);
      const digestMsg = messages.find((m) => m.role === 'user' && m.content.includes('CONVERSATION DIGEST'))!;
      expect(digestMsg.content).not.toContain('read_file');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('falls back to a plain digest when the transcript cannot be written to disk', async () => {
    activeMock = await startMock([]);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-nonlossy-block-'));
    try {
      // Block the destination cross-platform: .opencode is a regular file,
      // so .opencode/memory can never be created.
      fs.writeFileSync(path.join(ws, '.opencode'), 'not a directory');
      const messages = manyTurns();
      const digested = await compactWithSummary(messages, {
        endpoint: `http://127.0.0.1:${activeMock.port}`,
        modelId: 'm',
        keepRecentTurns: 2,
        root: ws,
        runId: 'r1'
      });
      expect(digested).toBe(3);
      const digestMsg = messages.find((m) => m.role === 'user' && m.content.includes('CONVERSATION DIGEST'))!;
      expect(digestMsg.content).not.toContain('read_file ');
      // Blocked file untouched
      expect(fs.readFileSync(path.join(ws, '.opencode'), 'utf-8')).toBe('not a directory');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ---------------- loop integration ----------------

describe('runAgentLoop: P1.5b self-summarizing compaction', () => {
  it('digests old turns when the context budget nears overflow and keeps working', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-compact-'));
    // A large fixture so the read_file TOOL RESULT floods the context estimate
    fs.writeFileSync(path.join(ws, 'data.txt'), 'z'.repeat(12000));
    activeMock = await startMock([
      tcm('read_file', { path: 'data.txt' }),
      tcm('list_files', {}),
      { role: 'assistant', content: 'All done.' }
    ]);

    const events: any[] = [];
    const result = await runAgentLoop({
      root: ws,
      prompt: 'build the feature',
      modelId: 'test-model',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'test agent',
      maxIterations: 6,
      onEvent: (e) => events.push(e),
      sampling: { temperature: 0.7, topP: 0.9, repeatPenalty: 1.1, numCtxTokens: 1200 },
      compactionKeepTurns: 1
    });

    expect(result.reply).toContain('All done.');
    expect(events.some((e) => e.type === 'context_usage')).toBe(true);

    const compactedEvt = events.find((e) => e.type === 'context_compacted');
    expect(compactedEvt).toBeDefined();
    expect(compactedEvt.turnsDigested).toBeGreaterThan(0);
    expect(activeMock.summarizeRequests).toBeGreaterThanOrEqual(1);

    // The final message list contains a digest and no longer the original prompt
    const digestMsg = result.messages!.find(
      (m) => m.role === 'user' && m.content.includes('CONVERSATION DIGEST')
    );
    expect(digestMsg).toBeDefined();

    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('does not compact when no context budget is configured', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-compact-'));
    activeMock = await startMock([
      tcm('write_file', { path: 'a.txt', content: 'x'.repeat(6000) }),
      { role: 'assistant', content: 'done early' }
    ]);
    const events: any[] = [];
    await runAgentLoop({
      root: ws,
      prompt: 'work',
      modelId: 'test-model',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'test',
      maxIterations: 3,
      onEvent: (e) => events.push(e)
    });
    expect(events.some((e) => e.type === 'context_usage')).toBe(false);
    expect(events.some((e) => e.type === 'context_compacted')).toBe(false);
    fs.rmSync(ws, { recursive: true, force: true });
  });
});
