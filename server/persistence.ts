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

export interface AgentStore {
  longTermMemories: Array<{
    id: string;
    category: string;
    key: string;
    value: string;
    source: string;
    createdAt: string;
  }>;
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
