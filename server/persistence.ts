import fs from 'fs';
import path from 'path';

export interface StoredRun {
  runId: string;
  sessionId: string;
  startedAt: string;
  durationMs: number;
  modelId: string;
  taskMode?: string;
  promptChars: number;
  toolCalls: Array<{ name: string; ok: boolean }>;
  filesChanged: string[];
  iterations: number;
  error?: string;
}

/**
 * P7.4 item 1: a scoping key for long-term memories. `'global'` means usable
 * from any workspace (user-wide conventions, cross-project facts); anything
 * else is a normalized workspace directory path — the memory only surfaces
 * when that project is loaded. Legacy records (no `scope`) are treated as
 * `'global'` on load.
 */
export type MemoryScope = 'global' | string;

export interface LongTermMemoryRecord {
  id: string;
  category: string;
  key: string;
  value: string;
  source: string;
  createdAt: string;
  /** P7.4 item 1: scope (see MemoryScope). Absent/empty = 'global'. */
  scope?: MemoryScope;
  /** P7.4 item 1: free-form tags, used for scoped retrieval boosts. */
  tags?: string[];
  /** P7.4 item 1: last time this memory was surfaced (recency tiebreak). */
  lastAccessedAt?: string;
}

export interface AgentStore {
  longTermMemories: LongTermMemoryRecord[];
  transcripts: Record<
    string,
    Array<{ role: 'user' | 'assistant'; content: string; at: string }>
  >;
  preferences: {
    lastModelId?: string;
    lastTaskMode?: string;
    permissionGrants?: Record<string, 'allow' | 'deny'>;
  };
  /** Full chat transcripts per UI session (survives browser storage wipes) */
  sessionChats: Record<
    string,
    { name: string; messages: unknown[]; updatedAt: string }
  >;
}

const EMPTY_STORE: AgentStore = { longTermMemories: [], transcripts: {}, preferences: {}, sessionChats: {} };

function storeDir(rootAbs: string): string {
  return path.join(rootAbs, '.opencode');
}
function storeFile(rootAbs: string): string {
  return path.join(storeDir(rootAbs), 'store.json');
}
function logFile(rootAbs: string): string {
  return path.join(storeDir(rootAbs), 'logs', 'runs.jsonl');
}

export function loadStore(rootAbs: string): AgentStore {
  try {
    if (fs.existsSync(storeFile(rootAbs))) {
      return { ...EMPTY_STORE, ...JSON.parse(fs.readFileSync(storeFile(rootAbs), 'utf-8')) };
    }
  } catch {
    /* corrupted store — start fresh rather than crash */
  }
  return { ...EMPTY_STORE };
}

/** Atomic whole-store write (temp + rename). Debounce externally if needed. */
export function saveStore(rootAbs: string, store: AgentStore): void {
  fs.mkdirSync(storeDir(rootAbs), { recursive: true });
  const tmp = storeFile(rootAbs) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmp, storeFile(rootAbs));
}

export function appendRunLog(rootAbs: string, run: StoredRun): void {
  try {
    fs.mkdirSync(path.dirname(logFile(rootAbs)), { recursive: true });
    fs.appendFileSync(logFile(rootAbs), JSON.stringify(run) + '\n', 'utf-8');
  } catch {
    /* logging must never break a run */
  }
}

/** P4.2: read the last `limit` run-log entries, newest first. Corrupt lines skipped. */
export function readRunLog(rootAbs: string, limit = 200): StoredRun[] {
  const out: StoredRun[] = [];
  try {
    if (!fs.existsSync(logFile(rootAbs))) return out;
    const lines = fs.readFileSync(logFile(rootAbs), 'utf-8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed && typeof parsed.runId === 'string') out.push(parsed);
      } catch {
        /* skip corrupt line */
      }
    }
  } catch {}
  return out;
}

// ---------------- P0.1: per-run message snapshots (crash/cancel resume) ----------------
//
// While an agent run is in flight we persist the full tool-call message list
// after every iteration. If the process dies or the user cancels, the snapshot
// remains on disk and can be loaded to build a resume prompt with full memory
// of prior tool activity.

export interface RunStateMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface RunState {
  v: 1;
  runId: string;
  sessionId: string;
  prompt: string;
  modelId?: string;
  modelEndpoint?: string;
  thinkingLevel?: 'none' | 'low' | 'medium' | 'high';
  taskMode?: string;
  writePolicy?: 'ask' | 'allow' | 'deny';
  iterations: number;
  filesChanged: string[];
  messages: RunStateMessage[];
  savedAt: string;
}

const RUNS_DIR_NAME = 'runs';

/** Hard cap (~500 KB) so a pathological tool result can't bloat the snapshot. */
const RUN_STATE_MAX_BYTES = 500 * 1024;

function runsDir(rootAbs: string): string {
  return path.join(storeDir(rootAbs), RUNS_DIR_NAME);
}

function runStateFile(rootAbs: string, runId: string): string {
  // Reject any path separators so a crafted runId can't escape the runs dir.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(runId)) {
    throw new Error(`Invalid runId: ${runId}`);
  }
  return path.join(runsDir(rootAbs), `${runId}.json`);
}

function truncateMessageList(messages: RunStateMessage[]): RunStateMessage[] {
  // If the total message list exceeds our cap, keep the most recent messages
  // and truncate the oldest tool-result bodies so we never lose the tail
  // (which is what continuation actually needs).
  const size = JSON.stringify(messages).length;
  if (size <= RUN_STATE_MAX_BYTES) return messages;
  const out = messages.map((m) => ({ ...m }));
  const large: RunStateMessage[] = out.filter(
    (m) => m.role === 'tool' && m.content.length > 400
  );
  for (const m of large) {
    m.content = m.content.slice(0, 400) + '\n…[truncated for snapshot]';
  }
  const newSize = JSON.stringify(out).length;
  if (newSize <= RUN_STATE_MAX_BYTES) return out;
  // Still too large — drop oldest messages past the first 4 and last 30.
  if (out.length > 34) {
    const head = out.slice(0, 4);
    const tail = out.slice(-30);
    const mid = out.slice(4, out.length - 30).map((m) => ({
      ...m,
      content: m.content.slice(0, 200) + '…[truncated]'
    }));
    return [...head, ...mid, ...tail];
  }
  return out;
}

/**
 * Persist a run snapshot atomically (temp + rename). Fails silently on IO
 * errors — this is a best-effort cache and must never break an active run.
 */
export function saveRunState(rootAbs: string, runId: string, state: RunState): void {
  try {
    fs.mkdirSync(runsDir(rootAbs), { recursive: true });
    const trimmed: RunState = { ...state, messages: truncateMessageList(state.messages) };
    let json = JSON.stringify(trimmed, null, 0);
    if (json.length > RUN_STATE_MAX_BYTES * 1.05) {
      json = JSON.stringify({
        ...trimmed,
        messages: trimmed.messages.slice(-40)
      });
    }
    const tmp = runStateFile(rootAbs, runId) + '.tmp';
    fs.writeFileSync(tmp, json, 'utf-8');
    fs.renameSync(tmp, runStateFile(rootAbs, runId));
  } catch {
    /* snapshot persistence is best-effort; never block the run */
  }
}

/** Load a saved run snapshot, or null if not found / corrupt. */
export function loadRunState(
  rootAbs: string,
  runId: string
): RunState | null {
  try {
    const file = runStateFile(rootAbs, runId);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as RunState;
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Delete a run snapshot (typically after the run completes successfully so we
 * don't keep stale resumable state on disk).
 */
export function deleteRunState(rootAbs: string, runId: string): void {
  try {
    const file = runStateFile(rootAbs, runId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

/**
 * Remove snapshots older than `maxAgeMs` (default 7 days) so `.opencode/runs`
 * stays bounded. Returns the list of removed runIds for observability.
 */
export function pruneOldRunStates(
  rootAbs: string,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000
): string[] {
  const removed: string[] = [];
  try {
    const dir = runsDir(rootAbs);
    if (!fs.existsSync(dir)) return removed;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (now - st.mtimeMs > maxAgeMs) {
        fs.unlinkSync(file);
        removed.push(name.replace(/\.json$/, ''));
      }
    }
  } catch {
    /* ignore */
  }
  return removed;
}

/**
 * List all resumable run snapshots (most recent first) with metadata only —
 * messages are NOT returned, since they can be large.
 */
export function listRunStates(rootAbs: string): Array<
  Pick<RunState, 'runId' | 'sessionId' | 'prompt' | 'iterations' | 'filesChanged' | 'savedAt'>
> {
  const out: Array<
    Pick<RunState, 'runId' | 'sessionId' | 'prompt' | 'iterations' | 'filesChanged' | 'savedAt'>
  > = [];
  try {
    const dir = runsDir(rootAbs);
    if (!fs.existsSync(dir)) return out;
    const entries = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => {
        let mtime = 0;
        try {
          mtime = fs.statSync(path.join(dir, n)).mtimeMs;
        } catch {}
        return { name: n, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const e of entries) {
      const st = loadRunState(rootAbs, e.name.replace(/\.json$/, ''));
      if (!st) continue;
      out.push({
        runId: st.runId,
        sessionId: st.sessionId,
        prompt: st.prompt.slice(0, 200),
        iterations: st.iterations,
        filesChanged: st.filesChanged,
        savedAt: st.savedAt
      });
    }
  } catch {
    /* ignore */
  }
  return out;
}
