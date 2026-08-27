import fs from 'fs';
import { createTwoFilesPatch } from 'diff';
import { parseUnifiedDiff, applyUnifiedDiff, fuzzyReplace } from './patchEngine';
import { resolveSafePath } from './lib';

/**
 * P2.2 Diff-review workflow: turn a proposed write_file/apply_patch call into
 * a hunk-split unified diff the user can accept/reject per hunk BEFORE anything
 * is written. Accepted hunks are re-serialized into a minimal unified diff and
 * executed through the normal (fuzzy, atomic, backed-up) patch engine.
 */

export interface ReviewLine {
  type: ' ' | '-' | '+';
  content: string;
}

export interface ReviewHunk {
  id: number;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  additions: number;
  deletions: number;
  lines: ReviewLine[];
}

export interface EditProposal {
  path: string;
  oldContent: string;
  newContent: string;
  isNewFile: boolean;
  hunks: ReviewHunk[];
}

type ProposalResult = EditProposal | { error: string };

/** Compute what a write_file/apply_patch call WOULD produce, split into hunks. */
export function buildEditProposal(root: string, _toolName: string, args: Record<string, any>): ProposalResult {
  const userPath = String(args?.path || '');
  if (!userPath) return { error: 'missing path' };
  let abs: string;
  try {
    abs = resolveSafePath(root, userPath);
  } catch (err: any) {
    return { error: err?.message || 'invalid path' };
  }

  let oldContent = '';
  let exists = false;
  try {
    exists = fs.existsSync(abs);
    if (exists) oldContent = fs.readFileSync(abs, 'utf-8');
  } catch (err: any) {
    return { error: err?.message || 'unreadable file' };
  }

  let newContent: string;
  const hasDiff = typeof args.patch === 'string' && args.patch.trim().length > 0;
  if (typeof args.content === 'string') {
    // write_file (also covers JSON-fallback full writes)
    newContent = args.content;
  } else if (hasDiff) {
    const r = applyUnifiedDiff(oldContent, args.patch);
    if (!r.ok) return { error: r.error || 'patch failed to apply' };
    newContent = r.content!;
  } else if (typeof args.oldText === 'string' || typeof args.newText === 'string') {
    const r = fuzzyReplace(oldContent, String(args.oldText ?? ''), String(args.newText ?? ''));
    if (!r.ok) return { error: r.error || 'replacement failed to apply' };
    newContent = r.content!;
  } else {
    return { error: 'no edit payload found (need content, patch, or oldText/newText)' };
  }

  const relPath = userPath.replace(/\\/g, '/');
  const diffText = createTwoFilesPatch(
    `a/${relPath}`,
    `b/${relPath}`,
    oldContent,
    newContent,
    exists ? 'current' : '/dev/null',
    'proposed',
    { context: 3 }
  );

  const parsed = parseUnifiedDiff(diffText);
  const hunks: ReviewHunk[] = parsed.hunks.map((h, i) => ({
    id: i,
    oldStart: h.oldStart,
    oldCount: h.oldCount,
    newStart: h.newStart,
    newCount: h.newCount,
    header: `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`,
    additions: h.lines.filter((l) => l.type === '+').length,
    deletions: h.lines.filter((l) => l.type === '-').length,
    lines: h.lines.map((l) => ({ type: l.type, content: l.content }))
  }));

  return {
    path: relPath,
    oldContent,
    newContent,
    isNewFile: !exists,
    hunks
  };
}

/** Re-serialize a subset of hunks into a minimal unified diff for execution. */
export function serializeHunks(_path: string, hunks: ReviewHunk[]): string {
  const out: string[] = [];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`);
    for (const l of h.lines) out.push(`${l.type}${l.content}`);
  }
  return out.join('\n');
}

/**
 * Turn an accepted-hunks selection into replacement tool arguments.
 * Returns null when nothing was accepted (caller should deny the edit).
 */
export function reviewedArgs(
  proposal: EditProposal,
  acceptedIds: number[]
): Record<string, any> | null {
  const accepted = proposal.hunks.filter((h) => acceptedIds.includes(h.id));
  if (!accepted.length) return null;
  return { path: proposal.path, patch: serializeHunks(proposal.path, accepted) };
}
