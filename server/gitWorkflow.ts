import path from 'path';
import { execFile } from 'child_process';

/**
 * P1.5d Git-first workflow.
 *
 * When the workspace is a git repository, every run gets its own work branch
 * (with a checkpoint commit of any pre-existing dirty state) and every VERIFIED
 * step is auto-committed — giving true rollback granularity and clean diffs for
 * the review UI. Non-git folders keep using the backup system as fallback.
 */

function git(rootAbs: string, args: string[], timeoutMs = 30000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: rootAbs, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = (err as any)?.code;
        resolve({
          code: typeof code === 'number' ? code : err ? 1 : 0,
          stdout: (stdout || '').toString(),
          stderr: (stderr || '').toString()
        });
      }
    );
  });
}

/** True when root is inside a git work tree (cheap, cached per run call). */
export async function isGitRepo(rootAbs: string): Promise<boolean> {
  const r = await git(rootAbs, ['rev-parse', '--is-inside-work-tree']);
  return r.code === 0 && r.stdout.trim() === 'true';
}

/** Paths that must never be committed by the agent workflow. */
const EXCLUDES = [':(exclude).opencode', ':(exclude).devforge', ':(exclude).git'];

export interface RunBranchInfo {
  branch: string;
  createdCheckpointCommit: boolean;
  baseBranch: string;
}

/**
 * Create a dedicated work branch for a run:
 * - remembers the current branch as the base,
 * - commits any dirty working-tree state as a checkpoint commit on the new
 *   branch so per-step diffs stay clean,
 * - switches to `devforge/run-<stamp>` (best-effort; returns null on failure).
 */
export async function ensureRunBranch(rootAbs: string, runId: string): Promise<RunBranchInfo | null> {
  if (!(await isGitRepo(rootAbs))) return null;

  const base = await git(rootAbs, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (base.code !== 0) return null;
  const baseBranch = base.stdout.trim() || 'HEAD';

  // Never nest branches inside an in-progress merge/rebase
  const state = await git(rootAbs, ['status', '--porcelain']);
  if (state.stderr.includes('rebase') || state.stderr.includes('merge')) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeId = runId.replace(/[^\w-]/g, '').slice(0, 12);
  const branch = `devforge/run-${stamp}-${safeId}`;

  const create = await git(rootAbs, ['checkout', '-b', branch]);
  if (create.code !== 0) return null;

  let createdCheckpointCommit = false;
  const dirty = await git(rootAbs, ['status', '--porcelain']);
  if (dirty.stdout.trim()) {
    await git(rootAbs, ['add', '-A', '--', '.', ...EXCLUDES]);
    const commit = await git(rootAbs, [
      'commit',
      '-m',
      `DevForge: checkpoint before agent run ${runId.slice(0, 12)}`
    ]);
    createdCheckpointCommit = commit.code === 0;
  }

  return { branch, createdCheckpointCommit, baseBranch };
}

/**
 * Commit specific workspace files (a verified step). Stages ONLY the given
 * paths (never blanket-adds), best-effort: failures resolve with ok:false
 * instead of throwing.
 */
export async function commitVerifiedStep(
  rootAbs: string,
  files: string[],
  message: string
): Promise<{ ok: boolean; commit?: string; error?: string }> {
  if (!(await isGitRepo(rootAbs))) return { ok: false, error: 'not a git repository' };
  const valid = files.filter((f) => {
    try {
      resolveSafeRel(rootAbs, f);
      return true;
    } catch {
      return false;
    }
  });
  if (!valid.length) return { ok: false, error: 'no valid files to stage' };

  for (const rel of valid) {
    const add = await git(rootAbs, ['add', '--', rel]);
    if (add.code !== 0) return { ok: false, error: add.stderr.trim() || 'git add failed' };
  }
  const commit = await git(rootAbs, ['commit', '-m', message.slice(0, 200)]);
  if (commit.code !== 0) {
    // Nothing staged (e.g. content identical) is fine, not an error worth noise
    if (/nothing to commit/i.test(commit.stdout + commit.stderr)) return { ok: false, error: 'nothing to commit' };
    return { ok: false, error: commit.stderr.trim() || 'git commit failed' };
  }
  const hash = await git(rootAbs, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, commit: hash.stdout.trim() || undefined };
}

function resolveSafeRel(rootAbs: string, rel: string): string {
  const abs = path.resolve(rootAbs, rel);
  const normRoot = path.resolve(rootAbs);
  if (abs !== normRoot && !abs.startsWith(normRoot + path.sep)) {
    throw new Error('path escapes workspace');
  }
  return abs;
}
