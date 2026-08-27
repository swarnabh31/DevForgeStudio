// P1.5g — Agentic regression harness.
// Runs every task in benchmark/tasks.ts against the real runAgentLoop,
// verifies the results, and records a per-run score in benchmark/results/.
//
// Mock mode (default): each task's `passes[].script` replays LLM responses
// from a local HTTP server — tests the plumbing (tool execution, ledger,
// context carry-over) deterministically, no model needed.
// Live mode (--live): real LLM at --endpoint/--model; scripts are ignored.
//
// Usage:
//   npm run eval                        # mock mode, all tasks
//   npm run eval -- --only bugfix       # only tasks in a category
//   npm run eval -- --keep              # keep temp workspaces for debugging
//   npx tsx benchmark/eval.ts --live --model qwen2.5-coder:7b \
//       --endpoint http://localhost:11434
//
// Exit codes: 0 = all pass, 1 = task failures, 2 = CI regression gate.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { execSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runAgentLoop } from '../server/agentLoop';
import type { LoopMessage } from '../server/agentLoop';
import { TASKS } from './tasks';
import { SWE_TASKS } from './sweTasks';
import type { EvalMeta, PassMsg } from './tasks';
import type { EvalTask } from './tasks';

// ---------------- CLI args ----------------

interface Args {
  mode: 'mock' | 'live';
  model: string;
  endpoint: string;
  only: string[];
  keep: boolean;
  ci: boolean;
  timeoutMs: number;
  verbose: boolean;
  suite: 'core' | 'swe' | 'all';
}

function parseArgs(argv: string[]): Args {
  let mode: 'mock' | 'live' = 'mock';
  let model = 'mock-model';
  let endpoint = '';
  const only: string[] = [];
  let keep = false;
  let ci = false;
  let verbose = false;
  let timeoutMs = 60_000;
  let suite: 'core' | 'swe' | 'all' = 'core';

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[i];
    };
    if (a === '--live') mode = 'live';
    else if (a === '--model') model = next();
    else if (a === '--endpoint') endpoint = next().replace(/\/$/, '');
    else if (a === '--only')
      next()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((v) => only.push(v));
    else if (a === '--suite') {
      const v = next();
      if (v !== 'core' && v !== 'swe' && v !== 'all') throw new Error(`--suite must be core|swe|all`);
      suite = v;
    } else if (a === '--keep') keep = true;
    else if (a === '--ci') ci = true;
    else if (a === '--verbose' || a === '-v') verbose = true;
    else if (a === '--timeout') {
      timeoutMs = parseInt(next(), 10);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout must be ms > 0');
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown flag ${a} (see --help)`);
    }
  }

  if (mode === 'live') {
    if (!endpoint) throw new Error('--live requires --endpoint http://host:port');
    timeoutMs = 300_000;
  }

  return { mode, model, endpoint, only, keep, ci, timeoutMs, verbose, suite };
}

function printHelp(): void {
  console.log(`Agentic regression harness (P1.5g)

Usage: npm run eval [flags]
       npx tsx benchmark/eval.ts [flags]

Flags:
  --live               Run against a real LLM endpoint instead of the mock server
  --model <id>         Model id (default 'mock-model'; required with --live)
  --endpoint <url>     Ollama endpoint, e.g. http://localhost:11434 (required for --live)
  --only <cat,id,...>  Filter tasks by category or id (bugfix,refactor,feature,testing,ledger,tricky,swe)
  --suite <name>       core (default) | swe | all — task suite to run
  --keep               Don't delete temp workspaces (for debugging)
  --ci                 Exit 2 if any task regressed vs. the last recorded run
  --timeout <ms>       Per-pass wall-clock timeout (default 60000 mock / 300000 live)
  -v, --verbose        Log every LLM request body and tool result
  -h, --help           This help

Exit codes: 0 = all pass, 1 = task failures, 2 = CI regression gate tripped
`);
}

// ---------------- mock Ollama server ----------------

interface MockOllama {
  port: number;
  close: () => Promise<void>;
  receivedBodies: string[];
}

function startMockOllama(responses: PassMsg[]): Promise<MockOllama> {
  let n = 0;
  const receivedBodies: string[] = [];
  const sockets = new Set<NodeJS.ReadWriteStream>();
  const server = http.createServer((req, r) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/chat') {
        receivedBodies.push(body);
        // Clamp: if a buggy script under-provides responses, repeat the last
        // (final text) message so the loop terminates instead of hanging.
        const i = Math.min(n, responses.length - 1);
        n += 1;
        r.writeHead(200, { 'Content-Type': 'application/json' });
        r.end(JSON.stringify({ message: responses[i] }));
      } else {
        r.writeHead(404, { 'Content-Type': 'application/json' });
        r.end('{}');
      }
    });
    req.on('close', () => sockets.delete(req.socket));
  });
  server.on('connection', (s) => sockets.add(s));
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('unexpected server address'));
        return;
      }
      resolve({
        port: addr.port,
        receivedBodies,
        close: async () => {
          for (const s of [...sockets]) (s as { destroy?: () => void }).destroy?.();
          await new Promise<void>((res) => server.close(() => res()));
        }
      });
    });
  });
}

// ---------------- per-task execution ----------------

interface TaskOutcome {
  task: EvalTask;
  status: 'pass' | 'fail' | 'error';
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  error?: string;
  durationMs: number;
  passes: number;
}

async function runOneTask(task: EvalTask, args: Args): Promise<TaskOutcome> {
  const started = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `eval-${task.id.replace(/[^a-z0-9-]/gi, '')}-`));
  const cleanup = (): void => {
    if (args.keep) return;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  try {
    task.setup(root);

    const meta: EvalMeta = {
      mode: args.mode,
      model: args.mode === 'live' ? args.model : undefined,
      passBodies: [],
      replies: []
    };

    let priorMessages: LoopMessage[] | undefined;

    for (let p = 0; p < task.passes.length; p++) {
      const pass = task.passes[p];
      // Pass 0 always starts fresh; later passes chain unless continues===false.
      const usePrior = p > 0 && pass.continues !== false && priorMessages ? [...priorMessages] : undefined;

      let mock: MockOllama | null = null;
      try {
        if (args.mode === 'mock') {
          mock = await startMockOllama(pass.script);
        }
        const endpoint = args.mode === 'live' ? args.endpoint : `http://127.0.0.1:${mock?.port}`;

        const maxIter =
          args.mode === 'live' ? task.liveMaxIterations ?? 12 : pass.script.length + 2;

        const ac = new AbortController();
        const deadline = setTimeout(() => ac.abort(), args.timeoutMs);

        let result;
        try {
          result = await runAgentLoop({
            root,
            prompt: pass.prompt,
            modelId: args.model,
            endpoints: [endpoint],
            history: [],
            systemContext:
              'You are a coding agent. Use the tools to complete the user request. ' +
              'When finished, reply with a short summary of what you changed.',
            maxIterations: maxIter,
            signal: ac.signal,
            priorMessages: usePrior,
            runId: task.runId,
            onEvent: args.verbose
              ? (evt) => {
                  if (evt.type === 'tool_call')
                    console.log(`         · tool ${evt.name} ${JSON.stringify(evt.arguments).slice(0, 200)}`);
                }
              : undefined
          });
        } finally {
          clearTimeout(deadline);
        }

        if (args.verbose) {
          for (const b of mock?.receivedBodies ?? []) {
            console.log(`         · LLM request #${(mock?.receivedBodies?.indexOf(b) ?? 0) + 1} (${b.length}b)`);
          }
          console.log(`         · reply: ${result.reply.slice(0, 120)}`);
        }

        priorMessages = result.messages ? [...result.messages] : priorMessages;
        meta.passBodies.push(mock ? [...mock.receivedBodies] : []);
        meta.replies.push(result.reply);
      } finally {
        if (mock) await mock.close();
      }
    }

    let checks: Array<{ name: string; ok: boolean; detail?: string }>;
    try {
      checks = task.verify(root, meta);
    } catch (err: any) {
      checks = [{ name: 'verify() threw', ok: false, detail: `${err?.name || 'Error'}: ${err?.message || err}` }];
    }

    const allOk = checks.length > 0 && checks.every((c) => c.ok);
    return {
      task,
      status: allOk ? 'pass' : 'fail',
      checks,
      durationMs: Date.now() - started,
      passes: task.passes.length
    };
  } catch (err: any) {
    return {
      task,
      status: 'error',
      checks: [],
      error: `${err?.name || 'Error'}: ${err?.message || String(err)}`,
      durationMs: Date.now() - started,
      passes: task.passes.length
    };
  } finally {
    cleanup();
  }
}

// ---------------- results ----------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(HERE, 'results');
const HISTORY_FILE = path.join(RESULTS_DIR, 'eval-history.jsonl');
const REPORT_FILE = path.join(RESULTS_DIR, 'eval-report.md');

interface HistoryEntry {
  ts: string;
  mode: string;
  model?: string;
  commit: string;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  passRate: number;
  failures: string[];
}

function readGitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8').trim();
    if (!raw) return [];
    return raw
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line) as HistoryEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is HistoryEntry => e !== null);
  } catch {
    return [];
  }
}

function persistResults(outcomes: TaskOutcome[], commit: string, mode: string, model?: string): HistoryEntry {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const total = outcomes.length;
  const passed = outcomes.filter((o) => o.status === 'pass').length;
  const failed = outcomes.filter((o) => o.status === 'fail').length;
  const errors = outcomes.filter((o) => o.status === 'error').length;
  const entry: HistoryEntry = {
    ts: new Date().toISOString(),
    mode,
    model,
    commit,
    total,
    passed,
    failed,
    errors,
    passRate: total > 0 ? passed / total : 0,
    failures: outcomes.filter((o) => o.status !== 'pass').map((o) => o.task.id)
  };

  fs.appendFileSync(HISTORY_FILE, `${JSON.stringify(entry)}\n`);
  writeReport(outcomes, entry);
  return entry;
}

function writeReport(outcomes: TaskOutcome[], entry: HistoryEntry): void {
  const byCategory: Record<string, TaskOutcome[]> = {};
  for (const o of outcomes) {
    (byCategory[o.task.category] ??= []).push(o);
  }

  const lines: string[] = [];
  lines.push('# Agentic Regression Report');
  lines.push('');
  lines.push(`- **When**: ${entry.ts}`);
  lines.push(`- **Commit**: ${entry.commit}`);
  lines.push(`- **Mode**: ${entry.mode}${entry.model ? ` (${entry.model})` : ''}`);
  lines.push(`- **Score**: ${entry.passed}/${entry.total} (${(entry.passRate * 100).toFixed(1)}%)`);
  lines.push('');

  const catTitles: Record<string, string> = {
    bugfix: 'Bugfixes',
    refactor: 'Refactors',
    feature: 'Features',
    testing: 'Testing',
    ledger: 'Ledger',
    tricky: 'Tricky'
  };
  for (const cat of ['bugfix', 'refactor', 'feature', 'testing', 'ledger', 'tricky']) {
    const list = byCategory[cat];
    if (!list?.length) continue;
    const pass = list.filter((o) => o.status === 'pass').length;
    lines.push(`## ${catTitles[cat]} — ${pass}/${list.length}`);
    lines.push('');
    lines.push('| Task | Name | Result | Failed checks | Time |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const o of list) {
      const failedChecks =
        o.checks.filter((c) => !c.ok).map((c) => c.name).join('; ') || '—';
      const status = o.status === 'pass' ? 'PASS' : o.status === 'fail' ? 'FAIL' : 'ERROR';
      lines.push(`| ${o.task.id} | ${o.task.name} | ${status} | ${failedChecks} | ${(o.durationMs / 1000).toFixed(2)}s |`);
    }
    lines.push('');
    const errored = list.filter((o) => o.error);
    if (errored.length) {
      lines.push('<details><summary>Errors</summary>');
      lines.push('');
      lines.push('```');
      for (const o of errored) lines.push(`${o.task.id}: ${o.error}`);
      lines.push('```');
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(`*Generated by benchmark/eval.ts · ${outcomes.length} tasks · ${entry.ts}*`);
  fs.writeFileSync(REPORT_FILE, lines.join('\n'));
}

// ---------------- CI regression gate ----------------

function regressionDelta(failures: string[]): { regressed: string[]; improved: string[] } {
  const history = loadHistory();
  const prev = new Set(history[history.length - 1]?.failures ?? []);
  const cur = new Set(failures);
  return {
    regressed: [...cur].filter((id) => !prev.has(id)),
    improved: [...prev].filter((id) => !cur.has(id))
  };
}

// ---------------- main ----------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const commit = readGitCommit();

  const ALL_TASKS = args.suite === 'swe' ? SWE_TASKS : args.suite === 'all' ? [...TASKS, ...SWE_TASKS] : TASKS;

  let tasks = ALL_TASKS;
  if (args.only.length) {
    tasks = ALL_TASKS.filter(
      (t) =>
        args.only.includes(t.category) ||
        args.only.some((o) => o === t.id || t.id.toLowerCase().includes(o.toLowerCase()))
    );
    if (!tasks.length)
      throw new Error(`--only matched no tasks in suite '${args.suite}' (categories: bugfix,refactor,feature,testing,ledger,tricky,swe)`);
  }

  console.log('');
  console.log('Agentic regression harness — P1.5g + P5.1');
  console.log(`  mode:    ${args.mode}${args.mode === 'live' ? ` (${args.model} @ ${args.endpoint})` : ''}`);
  console.log(`  suite:   ${args.suite}`);
  console.log(`  tasks:   ${tasks.length} of ${ALL_TASKS.length}${args.only.length ? ` (filter: ${args.only.join(',')})` : ''}`);
  console.log(`  commit:  ${commit}`);
  console.log('');

  const outcomes: TaskOutcome[] = [];
  for (const task of tasks) {
    process.stdout.write(`  ${task.id.padEnd(34)}`);
    const o = await runOneTask(task, args);
    outcomes.push(o);

    const mark = o.status === 'pass' ? 'PASS' : o.status === 'fail' ? 'FAIL' : 'ERROR';
    const pad = ' '.repeat(Math.max(1, 36 - mark.length));
    const secs = (o.durationMs / 1000).toFixed(2);
    const color = o.status === 'pass' ? '\x1b[32m' : '\x1b[31m';
    console.log(`${pad}${color}${mark}\x1b[0m  ${secs}s`);

    if (o.status === 'fail') {
      for (const c of o.checks) if (!c.ok) console.log(`      ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    }
    if (o.status === 'error') console.log(`      ✗ ${o.error}`);
  }

  const failures = outcomes.filter((o) => o.status !== 'pass').map((o) => o.task.id);
  const entry = persistResults(outcomes, commit, args.mode, args.mode === 'live' ? args.model : undefined);

  console.log('');
  console.log(`Score:   ${entry.passed}/${entry.total} pass (${(entry.passRate * 100).toFixed(1)}%)`);
  console.log(`History: ${HISTORY_FILE}`);
  console.log(`Report:  ${REPORT_FILE}`);

  if (args.ci) {
    // History was just appended, so exclude this run from the comparison.
    const history = loadHistory();
    const prev = history.length > 1 ? history[history.length - 2] : undefined;
    const prevFails = new Set(prev?.failures ?? []);
    const curFails = new Set(failures);
    const regressed = [...curFails].filter((id) => !prevFails.has(id));
    const improved = [...(prev?.failures ?? [])].filter((id) => !curFails.has(id));
    if (regressed.length) {
      console.log(`\n[ci] REGRESSION: newly failing: ${regressed.join(', ')}`);
      console.log('\x1b[31m[ci] gate FAILED — fix these or revert.\x1b[0m');
      process.exitCode = 2;
      return;
    }
    if (improved.length) console.log(`\n[ci] improved since last run: ${improved.join(', ')}`);
    console.log('\x1b[32m[ci] gate OK — no regressions.\x1b[0m');
  }

  if (outcomes.some((o) => o.status !== 'pass')) process.exitCode = 1;
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error('harness crashed:', err);
    process.exitCode = 1;
  });
}
