import fs from 'fs';
import path from 'path';

// ---------------- P1.5a: durable task ledger ----------------
//
// A disk-backed progress record at `.devforge/tasks/<runId>.md`, maintained via
// the `update_task` tool. The ledger is re-injected into the system prompt on
// every loop iteration, so a crashed/cancelled run can be reconstructed from
// disk alone — zero conversation history required.

export type LedgerStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface LedgerStep {
  text: string;
  status: LedgerStatus;
  note?: string;
}

export interface TaskLedger {
  v: 1;
  runId: string;
  title: string;
  updatedAt: string;
  steps: LedgerStep[];
  filesTouched: string[];
  keyFindings: string[];
  nextAction: string;
}

export interface UpdateTaskArgs {
  title?: unknown;
  steps?: Array<{ text?: unknown; status?: unknown; note?: unknown }>;
  addFinding?: unknown;
  add_finding?: unknown;
  file?: unknown;
  nextAction?: unknown;
  next_action?: unknown;
}

export const LEDGER_START = '<<<TASK_LEDGER';
export const LEDGER_END = '>>>TASK_LEDGER';

export const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

const MAX_STEPS = 60;
const MAX_FINDINGS = 100;
const MAX_FILES = 100;
const MAX_TEXT = 400;

const STATUS_MARK: Record<LedgerStatus, string> = {
  pending: ' ',
  in_progress: '>',
  completed: 'x',
  blocked: '!'
};

const MARK_STATUS: Record<string, LedgerStatus> = {
  ' ': 'pending',
  '>': 'in_progress',
  x: 'completed',
  '!': 'blocked'
};

export function isLedgerStatus(v: unknown): v is LedgerStatus {
  return v === 'pending' || v === 'in_progress' || v === 'completed' || v === 'blocked';
}

function clampText(v: unknown): string {
  const s = String(v ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
}

function normalizeRelPath(v: unknown): string {
  let s = String(v ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  while (s.startsWith('/')) s = s.slice(1);
  return s;
}

export function ledgerPath(rootAbs: string, runId: string): string {
  if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId)) {
    throw new Error(`unsafe runId "${String(runId).slice(0, 40)}"`);
  }
  return path.join(rootAbs, '.devforge', 'tasks', `${runId}.md`);
}

export function emptyLedger(runId: string, title?: string): TaskLedger {
  return {
    v: 1,
    runId,
    title: clampText(title) || 'Task',
    updatedAt: new Date().toISOString(),
    steps: [],
    filesTouched: [],
    keyFindings: [],
    nextAction: ''
  };
}

// ---------------- Mutations ----------------

export function setSteps(
  ledger: TaskLedger,
  steps: Array<{ text?: unknown; status?: unknown; note?: unknown }>
): void {
  ledger.steps = (steps || [])
    .filter((s) => s && typeof s === 'object')
    .map((s): LedgerStep | null => {
      const text = clampText(s.text);
      if (!text) return null;
      const status = isLedgerStatus(s.status) ? s.status : 'pending';
      const note = clampText(s.note);
      return { text, status, ...(note ? { note } : {}) };
    })
    .filter((s): s is LedgerStep => s !== null)
    .slice(0, MAX_STEPS);
}

export function addFinding(ledger: TaskLedger, finding: unknown): void {
  const f = clampText(finding);
  if (!f || ledger.keyFindings.includes(f)) return;
  ledger.keyFindings.push(f);
  if (ledger.keyFindings.length > MAX_FINDINGS) {
    ledger.keyFindings = ledger.keyFindings.slice(-MAX_FINDINGS);
  }
}

export function setNextAction(ledger: TaskLedger, action: unknown): void {
  const a = clampText(action);
  if (a !== ledger.nextAction) ledger.nextAction = a;
}

export function touchFile(ledger: TaskLedger, file: unknown): void {
  const f = normalizeRelPath(file);
  if (!f) return;
  const idx = ledger.filesTouched.indexOf(f);
  if (idx !== -1) ledger.filesTouched.splice(idx, 1);
  ledger.filesTouched.push(f);
  if (ledger.filesTouched.length > MAX_FILES) {
    ledger.filesTouched = ledger.filesTouched.slice(-MAX_FILES);
  }
}

// ---------------- Render / parse ----------------

export function renderLedger(ledger: TaskLedger): string {
  const lines: string[] = [];
  lines.push(`# Task ledger: ${ledger.title}`);
  lines.push('');
  lines.push(`- Run: ${ledger.runId}`);
  lines.push(`- Updated: ${ledger.updatedAt}`);
  lines.push(`- Next action: ${ledger.nextAction || '(none)'}`);
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  if (!ledger.steps.length) {
    lines.push('(no steps recorded yet)');
  } else {
    ledger.steps.forEach((s, i) => {
      lines.push(`${i + 1}. [${STATUS_MARK[s.status]}] ${s.text}${s.note ? ` — ${s.note}` : ''}`);
    });
  }
  lines.push('');
  lines.push('## Files touched');
  lines.push('');
  if (!ledger.filesTouched.length) lines.push('(none yet)');
  else for (const f of ledger.filesTouched) lines.push(`- ${f}`);
  lines.push('');
  lines.push('## Key findings');
  lines.push('');
  if (!ledger.keyFindings.length) lines.push('(none yet)');
  else for (const f of ledger.keyFindings) lines.push(`- ${f}`);
  lines.push('');
  return lines.join('\n');
}

export function parseLedger(md: string): TaskLedger {
  if (typeof md !== 'string') throw new Error('ledger is not a string');
  const lines = md.split(/\r?\n/);
  const ledger: TaskLedger = {
    v: 1,
    runId: '',
    title: 'Task',
    updatedAt: '',
    steps: [],
    filesTouched: [],
    keyFindings: [],
    nextAction: ''
  };
  let section: 'header' | 'steps' | 'files' | 'findings' = 'header';

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    if (line.startsWith('## ') && !line.startsWith('###')) {
      const h = line.slice(3).trim().toLowerCase();
      if (h.startsWith('steps')) section = 'steps';
      else if (h.startsWith('files')) section = 'files';
      else if (h.includes('finding')) section = 'findings';
      else section = 'header';
      continue;
    }

    switch (section) {
      case 'header': {
        const t = line.match(/^#\s+Task ledger:\s*(.+)$/i);
        if (t) {
          ledger.title = t[1].trim();
          continue;
        }
        if (/^#\s+/.test(line)) continue;
        const run = line.match(/^-\s*Run:\s*(.+)$/i);
        if (run) {
          ledger.runId = run[1].trim();
          continue;
        }
        const upd = line.match(/^-\s*Updated:\s*(.+)$/i);
        if (upd) {
          ledger.updatedAt = upd[1].trim();
          continue;
        }
        const nxt = line.match(/^-\s*Next action:\s*(.+)$/i);
        if (nxt) {
          const v = nxt[1].trim();
          ledger.nextAction = v === '(none)' ? '' : v;
          continue;
        }
        continue;
      }
      case 'steps': {
        if (/^\(no steps/i.test(line)) continue;
        const m = line.match(/^\s*\d+\.\s*\[([ x>!])\]\s*(.+)$/);
        if (m) {
          const status = MARK_STATUS[m[1]] || 'pending';
          let text = m[2];
          let note: string | undefined;
          const idx = text.lastIndexOf(' — ');
          if (idx > 0) {
            note = text.slice(idx + 3).trim();
            text = text.slice(0, idx).trim();
          }
          if (text) ledger.steps.push({ text, status, ...(note ? { note } : {}) });
        }
        continue;
      }
      case 'files': {
        if (/^\(none/i.test(line)) continue;
        const m = line.match(/^-\s*(.+)$/);
        if (m) {
          const f = normalizeRelPath(m[1]);
          if (f) ledger.filesTouched.push(f);
        }
        continue;
      }
      case 'findings': {
        if (/^\(none/i.test(line)) continue;
        const m = line.match(/^-\s*(.+)$/);
        if (m) {
          const f = m[1].trim();
          if (f) ledger.keyFindings.push(f);
        }
        continue;
      }
    }
  }
  return ledger;
}

// ---------------- Persistence ----------------

export function saveLedger(rootAbs: string, runId: string, ledger: TaskLedger): string {
  const file = ledgerPath(rootAbs, runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, renderLedger(ledger) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
  return file;
}

export function loadLedger(rootAbs: string, runId: string): TaskLedger | null {
  try {
    const file = ledgerPath(rootAbs, runId);
    if (!fs.existsSync(file)) return null;
    const md = fs.readFileSync(file, 'utf-8');
    if (!md.trim()) return null;
    const parsed = parseLedger(md);
    parsed.runId = parsed.runId || runId;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Apply one `update_task` call: load (or start fresh) → merge → save,
 * in a single call so concurrent loop iterations can't stomp each other.
 */
export function applyUpdate(rootAbs: string, runId: string, args: UpdateTaskArgs): TaskLedger {
  const a = args || {};
  const finding = a.addFinding !== undefined ? a.addFinding : a.add_finding;
  const next = a.nextAction !== undefined ? a.nextAction : a.next_action;
  const present =
    a.title !== undefined ||
    Array.isArray(a.steps) ||
    finding !== undefined ||
    (a.file !== undefined && String(a.file).trim() !== '') ||
    next !== undefined;
  if (!present) {
    throw new Error('update_task needs at least one of: title, steps, add_finding, file, next_action');
  }

  const ledger = loadLedger(rootAbs, runId) || emptyLedger(runId);

  if (a.title !== undefined) {
    const t = clampText(a.title);
    if (t) ledger.title = t;
  }
  if (Array.isArray(a.steps)) setSteps(ledger, a.steps);
  if (finding !== undefined) addFinding(ledger, finding);
  if (a.file !== undefined) touchFile(ledger, a.file);
  if (next !== undefined) setNextAction(ledger, next);

  ledger.updatedAt = new Date().toISOString();
  saveLedger(rootAbs, runId, ledger);
  return ledger;
}

/** Auto-record a file touched by write_file/apply_patch (best-effort). */
export function recordFileTouched(rootAbs: string, runId: string, file: string): void {
  const ledger = loadLedger(rootAbs, runId) || emptyLedger(runId);
  touchFile(ledger, file);
  ledger.updatedAt = new Date().toISOString();
  saveLedger(rootAbs, runId, ledger);
}

// ---------------- Prompt injection ----------------

export function renderLedgerHelp(): string {
  return [
    'You maintain a durable task ledger — an on-disk record of your progress that survives crashes and context loss.',
    'Update it with the `update_task` tool:',
    '- `steps`: the FULL ordered step list (it replaces the previous list). Status is one of: pending, in_progress, completed, blocked. Add a `note` for detail (e.g. why a step is blocked).',
    '- `add_finding`: a key finding or decision worth remembering (deduped, capped).',
    '- `file`: a workspace-relative file you are creating or editing.',
    '- `next_action`: the single next thing to do (replaces the previous one).',
    'Call it at the start of a task, after finishing any step, when you discover something important, and before switching files.'
  ].join('\n');
}

export function renderLedgerBlock(ledger: TaskLedger | null): string {
  const body = ledger ? renderLedger(ledger) : renderLedgerHelp();
  return `\n\n${LEDGER_START}\n${body}\n${LEDGER_END}\n`;
}

/**
 * Replace an existing `<<<TASK_LEDGER … >>>TASK_LEDGER` block in the text, or
 * append it when absent. Uses indexOf (markers may legally break regex).
 */
export function upsertLedgerBlock(existing: string, block: string): string {
  const start = existing.indexOf(LEDGER_START);
  const end = existing.indexOf(LEDGER_END);
  if (start === -1 || end === -1 || end < start) return existing + block;
  let keep = start;
  while (keep > 0 && existing[keep - 1] === '\n') keep--;
  return existing.slice(0, keep) + block + existing.slice(end + LEDGER_END.length).replace(/^\n/, '');
}
