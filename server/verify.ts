import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { loadProjectConfig } from './projectConfig';

/**
 * P1.2 Auto-verify / self-heal loop.
 *
 * Detect which verification commands a project supports (from package.json
 * scripts, tsconfig.json, pyproject.toml / pytest) and run them after the
 * agent's edit batches so failures feed straight back into the running loop.
 */

export interface VerifyCommand {
  /** Short label, e.g. "tsc --noEmit" */
  name: string;
  /** Shell command run in the workspace root */
  command: string;
}

export interface VerifyResult {
  command: VerifyCommand;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  output: string;
}

const detectionCache = new Map<string, { at: number; commands: VerifyCommand[] }>();
const DETECTION_TTL_MS = 30000;

/** Max chars of per-command output fed back to the model (protect context). */
const MAX_OUTPUT_CHARS = 4000;
const DEFAULT_CMD_TIMEOUT_MS = 120000;

function readJsonSafe(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Detect verification commands for a workspace root, in fast-fail order:
 * typecheck → lint → tests. Returns [] when nothing is detectable.
 * Cached per root (30 s TTL).
 */
export function detectVerifyCommands(root: string): VerifyCommand[] {
  const cached = detectionCache.get(root);
  if (cached && Date.now() - cached.at < DETECTION_TTL_MS) return cached.commands;

  const commands: VerifyCommand[] = [];

  // P2.4: user-configured verify commands from .devforge.json run FIRST.
  for (const cmd of loadProjectConfig(root).verifyCommands || []) {
    commands.push({ name: cmd, command: cmd });
  }

  const pkg = readJsonSafe(path.join(root, 'package.json'));
  const scripts: Record<string, string> | undefined = pkg?.scripts;

  // Typecheck
  if (scripts?.typecheck) {
    commands.push({ name: `npm run typecheck`, command: 'npm run typecheck' });
  } else if (
    fs.existsSync(path.join(root, 'tsconfig.json')) &&
    fs.existsSync(path.join(root, 'node_modules', '.bin'))
  ) {
    // Only use tsc when it is locally installed — never auto-install via npx here.
    commands.push({ name: 'tsc --noEmit', command: 'tsc --noEmit' });
  }

  // Lint
  if (scripts?.lint) commands.push({ name: 'npm run lint', command: 'npm run lint' });

  // Tests
  if (scripts?.test && !/^echo/i.test(scripts.test)) {
    commands.push({ name: 'npm test', command: 'npm test' });
  }

  // Python projects
  const hasPyproject = fs.existsSync(path.join(root, 'pyproject.toml'));
  if (hasPyproject || fs.existsSync(path.join(root, 'pytest.ini'))) {
    commands.push({ name: 'pytest', command: 'pytest -x -q' });
  }

  detectionCache.set(root, { at: Date.now(), commands: [...commands] });
  return commands;
}

function execShell(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = (err as any)?.code;
        resolve({
          exitCode: typeof code === 'number' ? code : err ? 1 : 0,
          stdout: (stdout || '').toString(),
          stderr: (stderr || '').toString()
        });
      }
    );
  });
}

/**
 * Run verification commands sequentially; stop at the first failure unless
 * `runAll` is set. Each result's output is truncated to MAX_OUTPUT_CHARS with
 * the tail kept (errors usually live there).
 */
export async function runVerification(
  root: string,
  commands: VerifyCommand[],
  opts: { timeoutMs?: number; runAll?: boolean } = {}
): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  for (const command of commands) {
    const startedAt = Date.now();
    const { exitCode, stdout, stderr } = await execShell(
      command.command,
      root,
      opts.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS
    );
    let output = [stdout, stderr].filter(Boolean).join('\n--- stderr ---\n').trim();
    if (output.length > MAX_OUTPUT_CHARS) {
      output =
        '…[head truncated]\n' + output.slice(output.length - MAX_OUTPUT_CHARS);
    }
    results.push({
      command,
      ok: exitCode === 0,
      exitCode,
      durationMs: Date.now() - startedAt,
      output: output || '(no output)'
    });
    if (exitCode !== 0 && !opts.runAll) break;
  }
  return results;
}

/**
 * Human-readable summary injected into the loop when verification fails.
 * Includes the failing command + its output so the model can fix it directly.
 */
export function renderVerificationFailure(results: VerifyResult[]): string {
  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok).map((r) => r.command.command);
  const lines: string[] = ['AUTOMATIC VERIFICATION FAILED — you must fix these errors before finishing.'];
  if (passed.length) lines.push(`Passed: ${passed.join(', ')}`);
  for (const f of failed) {
    lines.push('', `Failing command: \`${f.command.command}\` (exit ${f.exitCode})`, f.output);
  }
  lines.push(
    '',
    'Fix the reported errors in the affected files, then continue the task.'
  );
  return lines.join('\n');
}
