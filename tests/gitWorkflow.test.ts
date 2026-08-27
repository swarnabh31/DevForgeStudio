import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { isGitRepo, ensureRunBranch, commitVerifiedStep } from '../server/gitWorkflow';
import { runAgentLoop } from '../server/agentLoop';

function makeWs(withGit: boolean): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ocas-git-'));
  if (withGit) {
    execSync('git init', { cwd: ws, stdio: 'ignore' });
    execSync('git config user.email "agent@test.local"', { cwd: ws, stdio: 'ignore' });
    execSync('git config user.name "DevForge Test"', { cwd: ws, stdio: 'ignore' });
  }
  return ws;
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

describe('isGitRepo / ensureRunBranch', () => {
  it('detects git vs non-git workspaces', async () => {
    const plain = makeWs(false);
    tempDirs.push(plain);
    const repo = makeWs(true);
    tempDirs.push(repo);
    expect(await isGitRepo(plain)).toBe(false);
    expect(await isGitRepo(repo)).toBe(true);
  });

  it('creates a run branch and checkpoints dirty state (excluding .opencode)', async () => {
    const ws = makeWs(true);
    tempDirs.push(ws);
    execSync('git commit --allow-empty -m init', { cwd: ws, stdio: 'ignore' });
    fs.writeFileSync(path.join(ws, 'tracked.txt'), 'dirty before run\n');
    fs.mkdirSync(path.join(ws, '.opencode', 'backups'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.opencode', 'backups', 'junk.txt'), 'never commit me\n');

    const info = await ensureRunBranch(ws, 'run-abc123');
    expect(info).not.toBeNull();
    expect(info!.branch.startsWith('devforge/run-')).toBe(true);
    expect(info!.createdCheckpointCommit).toBe(true);

    const head = execSync('git log -1 --format=%s', { cwd: ws }).toString().trim();
    expect(head).toContain('checkpoint before agent run');
    // tracked dirty file committed, .opencode excluded
    const files = execSync('git ls-files', { cwd: ws }).toString();
    expect(files).toContain('tracked.txt');
    expect(files).not.toContain('.opencode');
  });

  it('returns null outside a git repo', async () => {
    const plain = makeWs(false);
    tempDirs.push(plain);
    expect(await ensureRunBranch(plain, 'run-x')).toBeNull();
  });
});

describe('commitVerifiedStep', () => {
  it('commits only the specified files with the given message', async () => {
    const ws = makeWs(true);
    tempDirs.push(ws);
    execSync('git commit --allow-empty -m init', { cwd: ws, stdio: 'ignore' });
    fs.writeFileSync(path.join(ws, 'a.txt'), 'A\n');
    fs.writeFileSync(path.join(ws, 'b.txt'), 'B\n');

    const res = await commitVerifiedStep(ws, ['a.txt'], 'step one');
    expect(res.ok).toBe(true);
    expect(res.commit).toBeTruthy();
    const committed = execSync('git show --name-only --format=', { cwd: ws }).toString().trim().split('\n');
    expect(committed).toContain('a.txt');
    expect(committed).not.toContain('b.txt'); // still uncommitted
  });

  it('rejects path escapes and reports nothing-to-commit cleanly', async () => {
    const ws = makeWs(true);
    tempDirs.push(ws);
    execSync('git commit --allow-empty -m init', { cwd: ws, stdio: 'ignore' });
    const esc = await commitVerifiedStep(ws, ['../outside.txt'], 'evil');
    expect(esc.ok).toBe(false);

    const none = await commitVerifiedStep(ws, [], 'empty');
    expect(none.ok).toBe(false);
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

describe('runAgentLoop: P1.5d onStepVerified hook', () => {
  it('fires after each verified edit batch with the pending files', async () => {
    const ws = makeWs(false); // loop hook is independent of actual git presence
    tempDirs.push(ws);
    activeMock = await startMockOllama([
      tcm('write_file', { path: 'one.txt', content: '1\n' }),
      tcm('write_file', { path: 'two.txt', content: '2\n' }),
      { role: 'assistant', content: 'finished.' }
    ]);

    const steps: Array<{ files: string[]; summary: string }> = [];
    const result = await runAgentLoop({
      root: ws,
      prompt: 'work',
      modelId: 'm',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'test',
      maxIterations: 5,
      autoVerify: { commands: [{ name: 'ok', command: 'node -e "process.exit(0)"' }], maxHealAttempts: 1 },
      onStepVerified: (files, summary) => steps.push({ files, summary })
    });

    expect(result.reply).toContain('finished.');
    expect(steps.length).toBe(2);
    expect(steps[0].files).toEqual(['one.txt']);
    expect(steps[1].files).toEqual(['two.txt']); // no duplicates across steps
  });

  it('does NOT fire when verification fails', async () => {
    const ws = makeWs(false);
    tempDirs.push(ws);
    activeMock = await startMockOllama([
      tcm('write_file', { path: 'bad.txt', content: 'x\n' }),
      { role: 'assistant', content: 'giving up.' }
    ]);
    const steps: string[][] = [];
    await runAgentLoop({
      root: ws,
      prompt: 'work',
      modelId: 'm',
      endpoints: [`http://127.0.0.1:${activeMock.port}`],
      history: [],
      systemContext: 'test',
      maxIterations: 3,
      autoVerify: { commands: [{ name: 'fail', command: 'node -e "process.exit(1)"' }], maxHealAttempts: 0 },
      onStepVerified: (files) => steps.push(files)
    });
    expect(steps).toEqual([]);
  });
});

