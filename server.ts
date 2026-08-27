import express, { Request, Response } from 'express';
import { randomUUID as cryptoRandomUUID } from 'crypto';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { DEFAULT_WORKSPACE_FILES, INITIAL_LSP_SERVERS, INITIAL_PREREQUISITES } from './src/data/defaultWorkspace';
import { SUPPORTED_MODELS } from './src/data/models';
import { LSPDiagnostic, WorkspaceFile, LangGraphNodeState, AgentAction, AttachmentFile } from './src/types';
import { DEFAULT_IGNORED_DIRS, getLanguageForFile, resolveSafePath, PathTraversalError } from './server/lib';
import {
  walkWorkspace,
  readFileRange,
  searchWorkspace,
  extractOutline,
  getOutline,
  looksBinary,
   TEXT_EXTENSIONS,
   OutlineSymbol,
   recordMtime,
   noteExternalChange
} from './server/fsTools';

const app = express();
import 'dotenv/config';

const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// In-memory workspace state per session
let globalWorkspace: Record<string, WorkspaceFile> = { ...DEFAULT_WORKSPACE_FILES };
let sessionWorkspaces: Record<string, Record<string, WorkspaceFile>> = {};

// Helper: REAL diagnostics — tsc --noEmit + ruff via server/diagnostics.ts,
// mapped to the LSPDiagnostic shape used by the UI. No regex simulation.
function mapRealDiagnostics(diags: RealDiagnostic[]): LSPDiagnostic[] {
  return diags.map((d, i) => ({
    id: `diag-${d.source}-${i}-${d.line}-${d.column}`,
    filePath: d.file,
    line: d.line,
    column: d.column,
    severity: d.severity === 'error' ? 'error' : 'warning',
    code: d.code,
    message: d.message,
    source: d.source as LSPDiagnostic['source'],
    fixable: false
  }));
}

async function runWorkspaceDiagnostics(sessionId: string, filePath?: string): Promise<LSPDiagnostic[]> {
  try {
    const { diagnostics } = await runRealDiagnostics(getWorkspaceRoot(sessionId));
    const mapped = mapRealDiagnostics(diagnostics);
    if (filePath) {
      const norm = filePath.replace(/\\/g, '/').toLowerCase();
      return mapped.filter((d) => {
        const f = d.filePath.replace(/\\/g, '/').toLowerCase();
        return f === norm || f.endsWith(norm) || norm.endsWith(f);
      });
    }
    return mapped;
  } catch {
    return [];
  }
}

// ---------------- API ENDPOINTS ----------------

// Local Models Auto-Detection Endpoint
app.post('/api/models/detect-local', async (req: Request, res: Response) => {
  const { customEndpoint } = req.body || {};
  const endpointsToProbe = [
    customEndpoint,
    'http://127.0.0.1:11434',
    'http://localhost:11434',
    'http://127.0.0.1:1234',
    'http://localhost:1234',
    'http://localhost:8080',
    'http://localhost:5000'
  ].filter(Boolean);

  const detectedModels: any[] = [];
  const probedEndpoints: string[] = [];
  const seenIds = new Set<string>();

  for (const ep of endpointsToProbe) {
    const cleanEp = (ep as string).replace(/\/$/, '');
    if (probedEndpoints.includes(cleanEp)) continue;
    probedEndpoints.push(cleanEp);

    // Try Ollama /api/tags
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const resp = await fetch(`${cleanEp}/api/tags`, { signal: controller.signal });
      clearTimeout(timeout);

      if (resp.ok) {
        const data: any = await resp.json();
        if (data.models && Array.isArray(data.models)) {
          data.models.forEach((m: any) => {
            const mId = m.name || m.model;
            if (mId && !seenIds.has(mId)) {
              seenIds.add(mId);
              detectedModels.push({
                id: mId,
                name: mId,
                endpoint: cleanEp,
                size: m.size,
                family: m.details?.family || 'llama',
                parameterSize: m.details?.parameter_size,
                provider: 'Ollama / Local'
              });
            }
          });
        }
      }
    } catch (e) {
      // Try OpenAI /v1/models (LM Studio, LocalAI)
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const resp = await fetch(`${cleanEp}/v1/models`, { signal: controller.signal });
        clearTimeout(timeout);

        if (resp.ok) {
          const data: any = await resp.json();
          const list = data.data || data.models;
          if (Array.isArray(list)) {
            list.forEach((m: any) => {
              const mId = m.id || m.name;
              if (mId && !seenIds.has(mId)) {
                seenIds.add(mId);
                detectedModels.push({
                  id: mId,
                  name: mId,
                  endpoint: cleanEp,
                  provider: 'LM Studio / Local AI'
                });
              }
            });
          }
        }
      } catch (err) {}
    }
  }

  res.json({
    success: true,
    count: detectedModels.length,
    models: detectedModels,
    probedEndpoints
  });
});

// ---------------- LONG TERM MEMORY ENGINE ----------------
type MemoryCategory = 'convention' | 'fact' | 'architecture' | 'preference' | 'bug_note';
type MemorySource = 'auto_extracted' | 'user_defined' | 'workspace_scan' | 'agent_remembered';

// P7.4 item 1: scoped memory record. `scope` is either 'global' (usable from
// any workspace) or a normalized workspace path (only surfaces for that
// project). Legacy records (no scope) load as 'global'.
interface ServerLongTermMemory {
  id: string;
  category: MemoryCategory;
  key: string;
  value: string;
  source: MemorySource;
  createdAt: string;
  scope: string; // 'global' or normalized workspace path
  tags?: string[];
  lastAccessedAt?: string;
}

let serverLongTermMemories: ServerLongTermMemory[] = [];

// ---------------- P7.4 item 1: scoped memory engine ----------------

/**
 * Canonical form of a scope: 'global' or a normalized workspace path.
 * Windows drive letters keep their colon ('C:\x' -> 'c:/x'); trailing
 * slashes are trimmed; backslashes become '/'; lowered.
 */
export function canonicalScope(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return 'global';
  let s = String(raw).trim().split('\\').join('/');
  if (!s || s.toLowerCase() === 'global') return 'global';
  // Windows drive-letter path: "C\Users", "C:/Users", or bare "C" -> "C:...".
  if (/^[A-Za-z](?:\/|$)/.test(s)) {
    s = s.charAt(0).toUpperCase() + ':' + s.slice(1);
  }
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s.toLowerCase();
}





/** A memory is visible for workspace `ws` if it is global OR scoped to it. */
function memoryVisibleFor(ws: string | undefined): (m: ServerLongTermMemory) => boolean {
  const target = canonicalScope(ws);
  return (m: ServerLongTermMemory) => {
    const s = canonicalScope(m.scope);
    return s === 'global' || (target !== 'global' && s === target);
  };
}

/**
 * A memory is *clearable* for workspace `ws` iff it is scoped exactly to it.
 * Global memories are shared across projects and must never be wiped by a
 * per-project CLEAR — pass 'global' to clear the shared pool.
 */
function memoryClearableFor(ws: string | undefined): (m: ServerLongTermMemory) => boolean {
  const target = canonicalScope(ws);
  return (m: ServerLongTermMemory) => canonicalScope(m.scope) === target;
}

/**
 * P7.4 item 1: retrieve memories visible for the given workspace, ranked.
 * "Visible" = global OR scoped to this workspace — so loading a project never
 * leaks another project's memories, but cross-project facts (global) still
 * surface. `embed` is injectable so tests never touch the network.
 */
export async function retrieveScopedMemories(
  ws: string | undefined,
  query: string,
  k = 6,
  embed?: (text: string) => Promise<number[] | null>
): Promise<ServerLongTermMemory[]> {
  const embedLocal = embed || ((t: string) => embedText(t) as Promise<number[] | null>);
  const visible = serverLongTermMemories.filter(memoryVisibleFor(ws));
  if (visible.length === 0) return [];

  const qvec = query ? await embedLocal(query) : null;
  // Warm missing embeddings in the background for next time; persist after.
  if (qvec) {
    const missing = visible.filter((m) => !embeddingCache[m.id]).slice(0, 20);
    if (missing.length) {
      Promise.all(
        missing.map((m) => getMemoryEmbedding(m.id, `${m.key}: ${m.value}`))
      ).then(() => saveEmbeddingCache(process.cwd(), embeddingCache)).catch(() => {});
    }
  }

  const scoreOne = (m: ServerLongTermMemory) => {
    const tags = (m.tags || []).join(' ');
    let score = keywordScore(query, `${m.key} ${m.value} ${tags}`);
    const mvec = embeddingCache[m.id];
    if (qvec && mvec) {
      const cos = cosineSimilarity(qvec, mvec);
      score = Math.max(score, cos > 0 ? cos : 0);
    }
    if (m.lastAccessedAt) score += 0.001; // recency tiebreak only
    return score;
  };

  const scored = visible.map((m) => ({ memory: m, score: scoreOne(m) }));
  scored.sort((a, b) => b.score - a.score);
  // Never return nothing — old behavior (best k) beats silence.
  const top = scored.slice(0, k).map((s) => s.memory);
  try {
    const now = new Date().toISOString();
    for (const m of top) m.lastAccessedAt = now;
  } catch {}
  return top;
}

/**
 * P7.4 item 1: mutate the in-memory index and persist to the store.
 * Exposed separately so endpoints, agent tools, and extraction all share one
 * source of truth instead of poking the array directly.
 */
export function addMemoryToIndex(item: {
  key: string;
  value: string;
  category?: unknown;
  source?: unknown;
  createdAt?: string;
  scope?: unknown;
  tags?: unknown;
  lastAccessedAt?: string;
  id?: string;
}): ServerLongTermMemory {
  const record: ServerLongTermMemory = {
    id: item.id || `ltm-${cryptoRandomUUID()}`,
    key: String(item.key).trim(),
    value: String(item.value).trim(),
    category: (['fact', 'preference', 'convention', 'architecture', 'bug_note'].includes(String(item.category))
      ? String(item.category)
      : 'fact') as MemoryCategory,
    source: (['auto_extracted', 'user_defined', 'workspace_scan', 'agent_remembered'].includes(String(item.source))
      ? String(item.source)
      : 'user_defined') as MemorySource,
    createdAt: item.createdAt || new Date().toISOString(),
    scope: canonicalScope(item.scope),
    tags: Array.isArray(item.tags) ? item.tags.map((t) => String(t)).filter(Boolean) : undefined,
    lastAccessedAt: item.lastAccessedAt
  };
  serverLongTermMemories.unshift(record);
  return record;
}

export function removeMemoryById(id: string): boolean {
  const before = serverLongTermMemories.length;
  serverLongTermMemories = serverLongTermMemories.filter((m) => m.id !== id);
  const removed = serverLongTermMemories.length !== before;
  if (removed) {
    delete embeddingCache[id];
    try { saveEmbeddingCache(process.cwd(), embeddingCache); } catch {}
  }
  return removed;
}

export function clearVisibleMemories(ws: string | undefined): number {
  const clearable = serverLongTermMemories.filter(memoryClearableFor(ws));
  for (const m of clearable) delete embeddingCache[m.id];
  serverLongTermMemories = serverLongTermMemories.filter((m) => !memoryClearableFor(ws)(m));
  try { saveEmbeddingCache(process.cwd(), embeddingCache); } catch {}
  return clearable.length;
}

export function visibleMemoryList(ws: string | undefined): ServerLongTermMemory[] {
  return serverLongTermMemories.filter(memoryVisibleFor(ws));
}

// Trusted workspace root per session (set by load-directory); used by the path guard.
// Defaults to the app's own directory so the agent works on real files out of the box.
const sessionWorkspaceRoots: Record<string, string> = {};
const DEFAULT_WORKSPACE_ROOT = process.cwd();
function getWorkspaceRoot(sessionId: string): string {
  return sessionWorkspaceRoots[sessionId] || DEFAULT_WORKSPACE_ROOT;
}

// ---------------- Browser-imported workspaces ----------------
// Files imported via the browser folder picker have no absolute disk path
// (browser security). They are materialized under .opencode/imported/<session>/
// so the agent's disk-based tools operate on a real copy of that tree.
const importedSessionRoots: Record<string, string> = {};
// Sessions where the user explicitly loaded a real disk path (Load Folder)
const explicitlyLoadedSessions = new Set<string>();

function ensureImportedRoot(sessionId: string): string {
  if (importedSessionRoots[sessionId]) return importedSessionRoots[sessionId];
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
  const dir = path.join(process.cwd(), '.opencode', 'imported', safeId);
  fs.mkdirSync(dir, { recursive: true });
  importedSessionRoots[sessionId] = dir;
  sessionWorkspaceRoots[sessionId] = dir;
  ensureWorkspaceWatcher(sessionId);
  return dir;
}

// ---------------- External-edit file watching ----------------// Keeps the in-memory workspace cache in sync with real disk changes made
// outside the app. Safety net for writes remains the mtime conflict registry.
const watchedRoots = new Set<string>();
function ensureWorkspaceWatcher(sessionId: string): void {
  const root = getWorkspaceRoot(sessionId);
  if (watchedRoots.has(root)) return;
  watchedRoots.add(root);
  watchWorkspace(root, (absPath, event) => {
    // P1.5f: flag real external modifications of files the agent has seen,
    // so the next write to them is refused until the agent re-reads.
    if (event === 'change') noteExternalChange(absPath);
    // Update every session cache that maps to this root
    const rel = path.relative(root, absPath).replace(/\\/g, '/');
    for (const [sid, sroot] of Object.entries(sessionWorkspaceRoots)) {
      if (sroot !== root) continue;
      const ws = sessionWorkspaces[sid];
      if (!ws || !(rel in ws)) continue; // only track files already in cache
      if (event === 'unlink') {
        delete ws[rel];
      } else {
        try {
          const content = fs.readFileSync(absPath, 'utf-8');
          ws[rel] = {
            ...ws[rel],
            path: rel,
            name: path.basename(absPath),
            content,
            isModified: ws[rel].originalContent !== content
          };
        } catch {
          /* unreadable — keep stale copy */
        }
      }
    }
    if (sessionId === 'default' || sessionWorkspaces['default']) {
      const ws = sessionWorkspaces['default'] || globalWorkspace;
      if (rel in ws && event === 'change') {
        try {
          const content = fs.readFileSync(absPath, 'utf-8');
          ws[rel] = { ...ws[rel], content, isModified: ws[rel].originalContent !== content };
        } catch {}
      }
    }
  });
}

// ---------------- Semantic memory retrieval (embeddings) ----------------
let embeddingCache: Record<string, number[]> = loadEmbeddingCache(process.cwd());

async function getMemoryEmbedding(id: string, text: string): Promise<number[] | null> {
  if (embeddingCache[id]) return embeddingCache[id];
  const vec = await embedText(text);
  if (vec) {
    embeddingCache[id] = vec;
  }
  return vec;
}

// Memory API GET — scope-aware: only memories visible for this session's workspace
app.get('/api/memory', (req: Request, res: Response) => {
  const sessionId = (req.query.sessionId as string) || 'default';
  const ws = getWorkspaceRoot(sessionId);
  const visible = visibleMemoryList(ws);
  res.json({ longTermMemories: visible, count: visible.length });
});

// Memory API ADD — scope-aware: defaults to the session's workspace, allows 'global'
app.post('/api/memory/add', async (req: Request, res: Response) => {
  const { key, value, category = 'convention', source = 'user_defined', scope, tags, sessionId = 'default' } = req.body || {};
  if (!key || !value) {
    return res.status(400).json({ error: 'Key and value are required' });
  }
  // Default to the current session's workspace; honor explicit 'global'.
  const defaultScope = canonicalScope(getWorkspaceRoot(sessionId));
  const finalScope = scope ? canonicalScope(scope) : defaultScope;
  const record = addMemoryToIndex({
    key,
    value,
    category,
    source,
    scope: finalScope,
    tags,
    createdAt: new Date().toISOString()
  });
  persistStore();
  // Warm embedding cache in background for semantic retrieval
  try {
    const vec = await embedText(`${record.key}: ${record.value}`);
    if (vec) {
      embeddingCache[record.id] = vec;
      saveEmbeddingCache(process.cwd(), embeddingCache);
    }
  } catch {}
  res.json({ success: true, item: record, longTermMemories: visibleMemoryList(finalScope) });
});

// Memory API DELETE
app.delete('/api/memory/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const removed = removeMemoryById(id);
  persistStore();
  res.json({ success: removed, longTermMemories: serverLongTermMemories });
});

// Memory API CLEAR — clears only this workspace's own (project-scoped) memories.
// Global (cross-project) memories and other projects' memories are untouched.
app.post('/api/memory/clear', (req: Request, res: Response) => {
  const { sessionId = 'default' } = req.body || {};
  const ws = getWorkspaceRoot(sessionId);
  const before = serverLongTermMemories.length;
  const cleared = clearVisibleMemories(ws);
  persistStore();
  res.json({ success: true, cleared, remaining: serverLongTermMemories.length - cleared, longTermMemories: serverLongTermMemories });
});

// Memory API AUTO-EXTRACT — scopes extracted facts to the current workspace.
app.post('/api/memory/extract', async (req: Request, res: Response) => {
  const { sessionId = 'default', modelId, modelEndpoint } = req.body || {};
  const root = getWorkspaceRoot(sessionId);
  const scope = canonicalScope(root);

  const workspaceIndex = buildWorkspaceIndex(root).slice(0, 4000);
  const recentTranscript = (appStore.transcripts[sessionId] || [])
    .slice(-6)
    .map((t) => `${t.role}: ${t.content.slice(0, 300)}`)
    .join('\n');

  const extractionPrompt = `You are analyzing a local coding workspace to extract durable facts for long-term memory.

=== WORKSPACE STRUCTURE ===
${workspaceIndex}

=== RECENT ACTIVITY ===
${recentTranscript || '(none)'}

Extract up to 5 durable facts or conventions about THIS project (e.g. stack/frameworks, test commands, code style conventions, architecture patterns, important constraints).
Return ONLY a JSON array, no prose: [{"key": "short-name", "value": "the fact", "category": "fact"|"preference"|"convention"}]`;

  const endpoints = [...new Set([modelEndpoint, 'http://127.0.0.1:11434', 'http://localhost:11434', 'http://127.0.0.1:1234'].filter(Boolean))] as string[];

  let raw: string | null = null;
  for (const ep of endpoints) {
    raw = await callLocalLLM(ep, String(modelId || 'local-auto-detected'), [
      { role: 'user', content: extractionPrompt }
    ]);
    if (raw) break;
  }

  if (!raw) {
    return res.status(503).json({
      error: 'Could not reach your local model server. Start it (`ollama serve`), pull a model, then retry extraction.',
      success: false
    });
  }

  let items: Array<{ key?: string; value?: string; category?: string }> = [];
  try {
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) items = JSON.parse(m[0]);
  } catch {}

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(200).json({ success: false, message: 'Model returned no usable memories.', longTermMemories: visibleMemoryList(scope) });
  }

  const extracted: ServerLongTermMemory[] = [];
  for (const i of items.filter((x) => x && x.key && x.value).slice(0, 5)) {
    const rec = addMemoryToIndex({
      key: String(i.key).slice(0, 80),
      value: String(i.value).slice(0, 500),
      category: ['fact', 'preference', 'convention', 'architecture', 'bug_note'].includes(String(i.category)) ? String(i.category) : 'fact',
      source: 'auto_extracted',
      scope,
      createdAt: new Date().toISOString()
    });
    extracted.push(rec);
  }
  persistStore();
  // Warm embeddings for the new memories
  await Promise.all(
    extracted.map(async (m) => {
      try {
        const v = await embedText(`${m.key}: ${m.value}`);
        if (v) {
          embeddingCache[m.id] = v;
          saveEmbeddingCache(process.cwd(), embeddingCache);
        }
      } catch {}
    })
  );
  res.json({ success: true, items: extracted, longTermMemories: visibleMemoryList(scope) });
});

// Models endpoint

app.get('/api/models', (req: Request, res: Response) => {
  res.json({ models: SUPPORTED_MODELS });
});

// ---------------- SERVER-SIDE CHAT PERSISTENCE ----------------
// Chat history survives localStorage wipes / device switches.

app.post('/api/sync/sessions', (req: Request, res: Response) => {
  const { sessions } = req.body || {};
  if (!Array.isArray(sessions)) {
    return res.status(400).json({ error: 'sessions array is required' });
  }
  for (const s of sessions) {
    if (!s?.id) continue;
    appStore.sessionChats[s.id] = {
      name: String(s.name || s.id).slice(0, 120),
      messages: Array.isArray(s.messages) ? s.messages.slice(-200) : [],
      updatedAt: new Date().toISOString()
    };
  }
  try {
    saveStore(process.cwd(), appStore);
    res.json({ success: true, count: Object.keys(appStore.sessionChats).length });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/api/sync/sessions', (req: Request, res: Response) => {
  res.json({
    sessions: Object.entries(appStore.sessionChats).map(([id, chat]) => ({
      id,
      name: chat.name,
      messages: chat.messages,
      updatedAt: chat.updatedAt
    }))
  });
});

// Workspace files endpoint
app.get('/api/workspace/files', (req: Request, res: Response) => {
  const sessionId = (req.query.sessionId as string) || 'default';
  const workspace = sessionWorkspaces[sessionId] || globalWorkspace;
  res.json({ files: workspace });
});

// Load and scan directory by path endpoint
app.post('/api/workspace/load-directory', (req: Request, res: Response) => {
  const { directoryPath, sessionId = 'default' } = req.body;
  if (!directoryPath) {
    return res.status(400).json({ error: 'Missing directory path' });
  }

  // Strip whitespace and surrounding quotes (Windows "Copy as Path" adds them)
  const cleanPath = String(directoryPath).trim().replace(/^["']+|["']+$/g, '').trim();
  // Resolve path relative to process.cwd() or absolute path
  const targetAbsPath = path.isAbsolute(cleanPath)
    ? path.resolve(cleanPath)
    : path.resolve(process.cwd(), cleanPath);

  let scannedFiles: Record<string, WorkspaceFile> = {};

  if (fs.existsSync(targetAbsPath) && fs.statSync(targetAbsPath).isDirectory()) {
    // Gitignore-aware scan via shared walker; read text files under 3MB into the cache
    for (const entry of walkWorkspace(targetAbsPath, { maxDepth: 12, maxFiles: 20000 })) {
      if (entry.isDirectory) continue;
      const ext = path.extname(entry.relPath).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      if ((entry.size ?? 0) >= 3 * 1024 * 1024) continue;
      try {
        const content = fs.readFileSync(entry.absPath, 'utf-8');
        scannedFiles[entry.relPath] = {
          path: entry.relPath,
          name: path.basename(entry.absPath),
          content,
          language: getLanguageForFile(entry.relPath),
          isModified: false,
          originalContent: content
        };
      } catch (err) {
        // Ignore unreadable or locked files
      }
    }
  }

  // If path is a local machine path or not found on server container
  if (Object.keys(scannedFiles).length === 0) {
    const isDrivePath = /^[a-zA-Z]:[\\/]/i.test(cleanPath) || cleanPath.startsWith('/Users/') || cleanPath.startsWith('/home/') || cleanPath.startsWith('~/');
    
    return res.status(200).json({
      success: false,
      isLocalMachinePath: true,
      directoryPath: cleanPath,
      message: isDrivePath
        ? `The directory path "${cleanPath}" is on your local machine's disk. Browser security prevents cloud servers from reading local disk paths directly. Please use the "Browse Local Folder" button to pick this folder from your PC!`
        : `Directory path "${cleanPath}" was not found on the server filesystem. Use the "Browse Local Folder" button to select and load the folder directly from your computer!`
    });
  }

  sessionWorkspaces[sessionId] = scannedFiles;
  sessionWorkspaceRoots[sessionId] = targetAbsPath;
  explicitlyLoadedSessions.add(sessionId);
  ensureWorkspaceWatcher(sessionId);
  if (sessionId === 'default') {
    globalWorkspace = scannedFiles;
  }

  res.json({
    success: true,
    activeDirectory: cleanPath,
    files: scannedFiles,
    fileCount: Object.keys(scannedFiles).length
  });
});

app.post('/api/workspace/files', async (req: Request, res: Response) => {
  const { path: filePath, content, language, sessionId = 'default', imported } = req.body;
  if (!filePath || content === undefined) {
    return res.status(400).json({ error: 'Missing path or content' });
  }

  // Browser-imported folders have no absolute disk path (browser security), so
  // materialize them onto disk under .opencode/imported/<session>/ and point the
  // session's workspace root there. The agent's tools then operate on a REAL
  // copy of the imported tree instead of silently falling back to the app cwd.
  let effectiveRel = String(filePath).replace(/\\/g, '/');
  if (imported && !explicitlyLoadedSessions.has(sessionId)) {
    const importRoot = ensureImportedRoot(sessionId);
    // Strip the top-level folder name from webkitRelativePath ("Pkg/src/a.ts" -> "src/a.ts")
    const parts = effectiveRel.split('/').filter(Boolean);
    if (parts.length > 1) effectiveRel = parts.slice(1).join('/');
    try {
      const abs = resolveSafePath(importRoot, effectiveRel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(content), 'utf-8');
      recordMtime(abs);
    } catch (err: any) {
      return res.status(400).json({ error: `Import failed: ${String(err?.message || err)}` });
    }
  }

  // Guard: ensure the requested path cannot escape the workspace root
  try {
    resolveSafePath(getWorkspaceRoot(sessionId), effectiveRel);
  } catch (err) {
    return res.status(403).json({ error: 'Path escapes the workspace root and was blocked' });
  }

  const workspace = sessionWorkspaces[sessionId] || { ...globalWorkspace };
  const ext = path.extname(effectiveRel);
  const lang = language || (ext === '.ts' || ext === '.tsx' ? 'typescript' : ext === '.py' ? 'python' : ext === '.json' ? 'json' : 'plaintext');

  const oldContent = workspace[effectiveRel]?.content || '';

  workspace[effectiveRel] = {
    path: effectiveRel,
    name: path.basename(effectiveRel),
    content,
    language: lang,
    isModified: oldContent !== content,
    originalContent: workspace[effectiveRel]?.originalContent || oldContent
  };

  sessionWorkspaces[sessionId] = workspace;
  if (sessionId === 'default') {
    globalWorkspace = workspace;
  }

  // For explicitly-loaded (on-disk) sessions, persist the edited content to
  // disk and refresh the mtime registry so agent conflict detection stays in
  // sync with user saves (was in-memory only, causing phantom CONFLICTs).
  if (!(imported && !explicitlyLoadedSessions.has(sessionId))) {
    try {
      const root = getWorkspaceRoot(sessionId);
      const abs = resolveSafePath(root, effectiveRel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(content), 'utf-8');
      recordMtime(abs);
    } catch (err: any) {
      // In-memory-only workspace (no real root) or escape — keep the update
      // in memory; surface nothing since the in-memory state is the source of
      // truth for the editor.
    }
  }

  const diagnostics = await runWorkspaceDiagnostics(sessionId);

  res.json({
    success: true,
    file: workspace[effectiveRel],
    importedToDisk: Boolean(imported && !explicitlyLoadedSessions.has(sessionId)),
    diagnostics
  });
});

// ---------------- PHASE 1: REAL FILESYSTEM TOOLS ----------------

// Ranged, binary-safe disk read
app.get('/api/workspace/read', (req: Request, res: Response) => {
  const sessionId = (req.query.sessionId as string) || 'default';
  const userPath = req.query.path as string;
  if (!userPath) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }
  try {
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
    const limitRaw = parseInt(String(req.query.limit ?? '2000'), 10);
    const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 2000 : limitRaw), 50000);
    const result = readFileRange(getWorkspaceRoot(sessionId), userPath, offset, limit);
    res.json(result);
  } catch (err: any) {
    if (err instanceof PathTraversalError) {
      return res.status(403).json({ error: err.message });
    }
    if (err?.code === 'ENOENT') {
      return res.status(404).json({ error: `File not found: ${userPath}` });
    }
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// Lazy folder tree listing
app.get('/api/workspace/tree', (req: Request, res: Response) => {
  const sessionId = (req.query.sessionId as string) || 'default';
  const root = getWorkspaceRoot(sessionId);
  const relDir = (req.query.path as string) || '';
  const depth = Math.min(parseInt(String(req.query.depth ?? '1'), 10) || 1, 5);

  try {
    const dirAbs = relDir ? resolveSafePath(root, relDir) : root;
    if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) {
      return res.status(404).json({ error: `Directory not found: ${relDir}` });
    }

    // Walk just this subtree with a small depth budget
    const entries = walkWorkspace(root, {
      maxDepth: 0,
      maxFiles: 100000,
      readContents: false
    });
    // walkWorkspace scans the whole tree; for lazy listing we filter by prefix + depth
    const prefix = relDir ? `${relDir.replace(/\\/g, '/').replace(/\/$/, '')}/` : '';
    const maxSegments = (prefix ? prefix.split('/').length : 0) + depth;
    const nodes = entries
      .filter((e) => {
        if (!e.relPath.startsWith(prefix)) return false;
        const segs = e.relPath.split('/').length;
        return segs <= maxSegments;
      })
      .map((e) => ({
        path: e.relPath,
        name: path.basename(e.absPath),
        isDirectory: e.isDirectory,
        size: e.size,
        modifiedAt: e.mtimeMs ? new Date(e.mtimeMs).toISOString() : undefined
      }));

    res.json({
      path: relDir,
      root,
      nodes,
      truncated: nodes.length >= 10000
    });
  } catch (err: any) {
    if (err instanceof PathTraversalError) {
      return res.status(403).json({ error: err.message });
    }
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// Search tool (ripgrep with JS fallback)
app.post('/api/tools/search', async (req: Request, res: Response) => {
  const { query, glob, maxResults, caseSensitive, sessionId = 'default' } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Missing query' });
  }
  try {
    const result = await searchWorkspace(getWorkspaceRoot(sessionId), query, {
      glob,
      maxResults,
      caseSensitive
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Single-file outline
app.get('/api/workspace/outline', (req: Request, res: Response) => {
  const sessionId = (req.query.sessionId as string) || 'default';
  const userPath = req.query.path as string;
  if (!userPath) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }
  try {
    res.json(getOutline(getWorkspaceRoot(sessionId), userPath));
  } catch (err: any) {
    if (err instanceof PathTraversalError) {
      return res.status(403).json({ error: err.message });
    }
    if (err?.code === 'ENOENT') {
      return res.status(404).json({ error: `File not found: ${userPath}` });
    }
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

// Bulk index: file list + outlines for the whole workspace (context for the agent)
app.get('/api/workspace/index', (req: Request, res: Response) => {
  const sessionId = (req.query.sessionId as string) || 'default';
  const root = getWorkspaceRoot(sessionId);
  const maxOutlines = Math.min(parseInt(String(req.query.maxOutlines ?? '300'), 10) || 300, 1000);

  try {
    const entries = walkWorkspace(root, { maxDepth: 14, maxFiles: 20000, readContents: false });
    const files = entries.filter((e) => !e.isDirectory);
    const codeFiles = files.filter((f) => TEXT_EXTENSIONS.has(path.extname(f.relPath).toLowerCase()));

    const outlines: Array<{ path: string; symbols: number; languages?: never }> = [];
    const outlineDetails: Record<string, OutlineSymbol[]> = {};
    let outlined = 0;
    for (const f of codeFiles.slice(0, maxOutlines)) {
      try {
        const buf = fs.readFileSync(f.absPath);
        if (looksBinary(buf)) continue;
        const symbols = extractOutline(f.absPath, buf.toString('utf-8'));
        outlineDetails[f.relPath] = symbols;
        outlined++;
      } catch {
        /* skip unreadable */
      }
    }

    res.json({
      root,
      fileCount: files.length,
      codeFileCount: codeFiles.length,
      outlinedCount: outlined,
      files: files.map((f) => ({
        path: f.relPath,
        size: f.size,
        language: getLanguageForFile(f.relPath)
      })),
      outlines: outlineDetails
    });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// A4: Import graph — "what breaks if I change X?"
app.get('/api/tools/import-graph', (req: Request, res: Response) => {
  const sessionId = (req.query.sessionId as string) || 'default';
  const target = req.query.path as string;
  if (!target) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }
  try {
    resolveSafePath(getWorkspaceRoot(sessionId), target); // validate
    res.json(buildImportGraph(getWorkspaceRoot(sessionId), target));
  } catch (err: any) {
    if (err instanceof PathTraversalError) return res.status(403).json({ error: err.message });
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// LSP Diagnosis Endpoint — REAL tsc --noEmit / ruff diagnostics (10s-cached)
app.post('/api/lsp/diagnose', async (req: Request, res: Response) => {
  const { filePath, sessionId = 'default' } = req.body;

  const allDiagnostics = await runWorkspaceDiagnostics(sessionId, filePath);

  res.json({
    diagnostics: allDiagnostics,
    clean: allDiagnostics.filter(d => d.severity === 'error').length === 0,
    timestamp: new Date().toISOString()
  });
});

// Multi-modal attachment parsing endpoint (local only - no external APIs)
app.post('/api/attachments/parse', async (req: Request, res: Response) => {
  const { name, mimeType, contentBase64, textContent } = req.body;

  if (textContent) {
    return res.json({
      name,
      summary: `Extracted text document (${textContent.length} chars)`,
      parsedText: textContent
    });
  }

  // Real PDF text extraction via pdf-parse
  const isPdf =
    String(mimeType || '').includes('pdf') || String(name || '').toLowerCase().endsWith('.pdf');
  if (isPdf && contentBase64) {
    try {
      const { PDFParse } = await import('pdf-parse');
      const buf = Buffer.from(String(contentBase64), 'base64');
      if (buf.length > 25 * 1024 * 1024) {
        return res.status(413).json({ error: 'PDF too large (>25MB)', name });
      }
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      try {
        const result = await parser.getText();
        const text = (result as any).text || '';
        if (!text.trim()) {
          return res.json({
            name,
            summary: 'PDF contains no extractable text (likely scanned images)',
            parsedText: `[PDF ${name}: no extractable text — scanned/image-only PDF]`
          });
        }
        return res.json({
          name,
          pages: (result as any).pages?.length ?? undefined,
          summary: `Extracted ${text.length} chars of text from PDF`,
          parsedText: text.slice(0, 200000)
        });
      } finally {
        await parser.destroy();
      }
    } catch (err: any) {
      return res.status(422).json({
        error: `PDF parsing failed: ${String(err?.message || err)}`,
        name
      });
    }
  }

  // Images and other binary types are passed through for the LLM
  res.json({
    name,
    summary: `Attached file loaded (${name}) - will be processed by local LLM`,
    parsedText: `[Attached document or image: ${name}]\nMIME: ${mimeType}\n\nNote: Attachments are sent to the local LLM for analysis. Ensure your local model supports vision (e.g., llava, moondream, qwen2.5-vl).`
  });
});

// Code Execution — REAL allowlisted command execution in the session workspace.
app.post('/api/workspace/execute', (req: Request, res: Response) => {
  const { command, sessionId = 'default' } = req.body;

  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: 'Command is required' });
  }

  // Same security policy as the agent loop's run_command tool
  const check = isCommandAllowed(command);
  if (!check.ok) {
    return res.status(403).json({ error: `Command rejected — ${check.reason}`, command });
  }

  const root = getWorkspaceRoot(sessionId);
  exec(
    command,
    { cwd: root, timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    (err, stdout, stderr) => {
      const code = (err as any)?.code;
      const exitCode = typeof code === 'number' ? code : err ? 1 : 0;
      res.json({
        command,
        stdout: `$ ${command}\n${[stdout, stderr].filter(Boolean).join('\n--- stderr ---\n')}`,
        exitCode,
        cwd: root,
        timestamp: new Date().toISOString()
      });
    }
  );
});

// Call a locally-detected LLM (Ollama /api/chat or OpenAI-compatible /v1/chat/completions)
async function callLocalLLM(
  endpoint: string,
  modelId: string,
  messages: Array<{ role: string; content: string }>
): Promise<string | null> {
  const cleanEp = (endpoint as string).replace(/\/$/, '');

  // 1. Try Ollama /api/chat
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000);
    const resp = await fetch(`${cleanEp}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages, stream: false }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (resp.ok) {
      const data: any = await resp.json();
      const text = data?.message?.content;
      if (typeof text === 'string' && text.trim()) return text;
    }
  } catch (e) {
    // Fall through to OpenAI-compatible endpoint
  }

  // 2. Try OpenAI-compatible /v1/chat/completions (LM Studio, LocalAI, llama.cpp server)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000);
    const resp = await fetch(`${cleanEp}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages, stream: false }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (resp.ok) {
      const data: any = await resp.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim()) return text;
    }
  } catch (e) {
    // No local LLM available at this endpoint
  }

  return null;
}

// ---------------- AGENT RUN (tool-calling loop) ----------------

import { runAgentLoop, ToolResult, isCommandAllowed } from './server/agentLoop';
import { detectVerifyCommands } from './server/verify';
import { buildEditProposal, reviewedArgs } from './server/reviewGate';
import { ensureRunBranch, commitVerifiedStep } from './server/gitWorkflow';
import { validateEditedContent } from './server/editValidation';
import { exec } from 'child_process';
import { getSystemProfile } from './server/systemProfile';
import { resolveTaskParams, isTaskMode, TaskMode } from './server/taskProfiles';
import { listBackups, revertFromBackup, revertFileFromBackup, listCheckpointFiles } from './server/backups';
import {
  loadStore,
  saveStore,
  appendRunLog,
  AgentStore,
  saveRunState,
  loadRunState,
  deleteRunState,
  pruneOldRunStates,
  listRunStates,
  RunState,
  readRunLog
} from './server/persistence';
import type { LoopEvent } from './server/agentLoop';
import { computeDiffsForFiles, computeCheckpointDiffs } from './server/diffUtil';
import { loadProjectConfig, saveProjectConfig, loadProjectInstructions, ProjectConfig } from './server/projectConfig';
import { retrieveCode, renderRetrieval } from './server/codeRetrieval';
import { buildRepoMap } from './server/repoMap';
import { getOrCreateToken, createLanGate, lanAddresses } from './server/lanAccess';
import { findModelPreset, MODEL_PRESETS } from './server/modelMatrix';
import { getPluginToolDefs, buildPluginSchemas, executePluginTool } from './server/pluginTools';

// RE1: disk-backed store (survives restarts)
const appStore: AgentStore = loadStore(process.cwd());
if (appStore.longTermMemories.length && serverLongTermMemories.length === 0) {
  // P7.4 item 1: normalize legacy records (no scope/tags) onto the new shape.
  serverLongTermMemories = appStore.longTermMemories.map((r) => ({
    id: r.id,
    category: r.category as MemoryCategory,
    key: r.key,
    value: r.value,
    source: r.source as MemorySource,
    createdAt: r.createdAt,
    scope: canonicalScope((r as any).scope),
    tags: Array.isArray((r as any).tags) ? (r as any).tags.map((t: unknown) => String(t)) : undefined,
    lastAccessedAt: (r as any).lastAccessedAt
  }));
}
function persistStore(): void {
  try {
    appStore.longTermMemories = serverLongTermMemories;
    saveStore(process.cwd(), appStore);
  } catch (e) {
    console.warn('[DevForge] store save failed:', e);
  }
}
import { runRealDiagnostics, RealDiagnostic } from './server/diagnostics';
import { watchWorkspace } from './server/watcher';
import {
  embedText,
  cosineSimilarity,
  keywordScore,
  loadEmbeddingCache,
  saveEmbeddingCache
} from './server/embeddings';
import { buildImportGraph } from './server/diagnostics';

// Hardware profile endpoint (GPU/VRAM/RAM detection)
app.get('/api/system/profile', async (_req: Request, res: Response) => {
  try {
    const profile = await getSystemProfile();
    res.json(profile);
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ---------------- P4.1 ONBOARDING: model catalog, recommendation, pull ----------------

// P5.2: model compatibility matrix (tuned presets per local model family)
app.get('/api/models/matrix', (_req: Request, res: Response) => {
  res.json({ success: true, presets: MODEL_PRESETS });
});

const MODEL_CATALOG = [
  { id: 'qwen2.5-coder:3b', label: 'Qwen2.5 Coder 3B', minVramMB: 4000, sizeHintGB: 2 },
  { id: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder 7B', minVramMB: 8000, sizeHintGB: 4.7 },
  { id: 'qwen2.5-coder:14b', label: 'Qwen2.5 Coder 14B', minVramMB: 14000, sizeHintGB: 9 },
  { id: 'qwen2.5-coder:32b', label: 'Qwen2.5 Coder 32B', minVramMB: 24000, sizeHintGB: 20 },
  { id: 'deepseek-coder-v2:16b', label: 'DeepSeek Coder V2 16B', minVramMB: 12000, sizeHintGB: 8.9 },
  { id: 'llama3.1:8b', label: 'Llama 3.1 8B (general)', minVramMB: 8000, sizeHintGB: 4.9 }
];

app.get('/api/onboarding/catalog', async (_req: Request, res: Response) => {
  let profile: any = null;
  try {
    profile = await getSystemProfile();
  } catch {}
  const vram = profile?.totalVramMB || 0;
  const catalog = MODEL_CATALOG.map((m) => {
    const preset = findModelPreset(m.id);
    return { ...m, fitsHardware: !vram || vram >= m.minVramMB, notes: preset?.notes, family: preset?.family };
  });
  const recommended =
    [...catalog].reverse().find((m) => m.fitsHardware && /coder/.test(m.id)) ||
    catalog.find((m) => m.fitsHardware) ||
    catalog[0];
  res.json({ success: true, profile, catalog, recommendedId: recommended.id });
});

// Proxy an `ollama pull` with NDJSON progress passthrough (local Ollama only).
app.post('/api/onboarding/pull', async (req: Request, res: Response) => {
  const { model, endpoint } = req.body || {};
  const name = String(model || '').trim();
  if (!name || /[;&|`$]/.test(name)) {
    return res.status(400).json({ error: 'A single model name is required' });
  }
  const base = String(endpoint || 'http://127.0.0.1:11434').replace(/\/$/, '');
  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(`${base}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
      signal: AbortSignal.timeout(30 * 60 * 1000)
    });
  } catch (err: any) {
    return res.status(502).json({ error: `Ollama unreachable at ${base}: ${String(err?.message || err)}` });
  }
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    return res.status(502).json({ error: `Pull failed (${upstream.status}): ${text.slice(0, 300)}` });
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch {
    res.write(JSON.stringify({ error: 'stream interrupted' }) + '\n');
  }
  res.end();
});

// ---------------- BACKUP / REVERT (Phase 3 safety net) ----------------

app.get('/api/workspace/backups', (req: Request, res: Response) => {
  const sessionId = (req.query.sessionId as string) || 'default';
  try {
    res.json({ backups: listBackups(getWorkspaceRoot(sessionId)) });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.post('/api/workspace/revert', (req: Request, res: Response) => {
  const { sessionId = 'default', backupName } = req.body || {};
  try {
    const root = getWorkspaceRoot(sessionId);
    const target = backupName
      ? path.join(root, '.opencode', 'backups', String(backupName))
      : undefined;
    const result = revertFromBackup(root, target);
    // Refresh in-memory cache from disk after revert
    const refreshed: Record<string, WorkspaceFile> = {};
    for (const rel of result.restored) {
      const abs = resolveSafePath(root, rel);
      if (fs.existsSync(abs)) {
        const content = fs.readFileSync(abs, 'utf-8');
        refreshed[rel] = {
          path: rel,
          name: path.basename(rel),
          content,
          language: getLanguageForFile(rel),
          isModified: false,
          originalContent: content
        };
      }
    }
    res.json({ success: true, ...result, files: refreshed });
  } catch (err: any) {
    if (err instanceof PathTraversalError) {
      return res.status(403).json({ error: err.message });
    }
    res.status(400).json({ error: String(err?.message || err) });
  }
});

// U5: per-file revert (one-click undo in CodeWorkspace)
app.post('/api/workspace/revert-file', (req: Request, res: Response) => {
  const { sessionId = 'default', path: filePath } = req.body || {};
  if (!filePath) return res.status(400).json({ error: 'Missing path' });
  try {
    const root = getWorkspaceRoot(sessionId);
    const result = revertFileFromBackup(root, filePath);
    if (!result.reverted) {
      return res.status(404).json({ error: 'No backup snapshot found for this file' });
    }
    const abs = resolveSafePath(root, filePath);
    const content = fs.readFileSync(abs, 'utf-8');
    res.json({ success: true, backupName: result.backupName, content });
  } catch (err: any) {
    if (err instanceof PathTraversalError) return res.status(403).json({ error: err.message });
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// U5: per-file unified diff (latest backup vs disk)
app.get('/api/workspace/file-diff', (req: Request, res: Response) => {
  const sessionId = (req.query.sessionId as string) || 'default';
  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).json({ error: 'Missing path' });
  try {
    const patches = computeDiffsForFiles(getWorkspaceRoot(sessionId), [filePath]);
    if (!patches.length) {
      return res.json({ hasChanges: false, message: 'No changes vs last backup' });
    }
    res.json({ hasChanges: true, ...patches[0] });
  } catch (err: any) {
    if (err instanceof PathTraversalError) return res.status(403).json({ error: err.message });
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// P2.1: files captured in one checkpoint
app.get('/api/workspace/checkpoint-files', (req: Request, res: Response) => {
  const sessionId = (req.query.sessionId as string) || 'default';
  const backupName = req.query.backupName as string;
  if (!backupName) return res.status(400).json({ error: 'Missing backupName' });
  try {
    res.json({ files: listCheckpointFiles(getWorkspaceRoot(sessionId), backupName) });
  } catch (err: any) {
    if (err instanceof PathTraversalError) return res.status(403).json({ error: err.message });
    res.status(404).json({ error: String(err?.message || err) });
  }
});

// P4.2: local-only run telemetry (from .opencode/logs/runs.jsonl)
app.get('/api/stats/runs', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const runs = readRunLog(process.cwd(), limit);
  const completed = runs.filter((r) => !r.error);
  const withEdits = runs.filter((r) => r.filesChanged?.length > 0);
  const toolCounts: Record<string, { calls: number; fails: number }> = {};
  for (const r of runs) {
    for (const t of r.toolCalls || []) {
      const e = (toolCounts[t.name] ||= { calls: 0, fails: 0 });
      e.calls++;
      if (!t.ok) e.fails++;
    }
  }
  res.json({
    success: true,
    totals: {
      runs: runs.length,
      completed: completed.length,
      completionRate: runs.length ? Number((completed.length / runs.length * 100).toFixed(1)) : null,
      editRuns: withEdits.length,
      avgDurationMs: runs.length ? Math.round(runs.reduce((s, r) => s + (r.durationMs || 0), 0) / runs.length) : null,
      avgIterations: runs.length ? Number((runs.reduce((s, r) => s + (r.iterations || 0), 0) / runs.length).toFixed(1)) : null,
      totalFilesChanged: runs.reduce((s, r) => s + (r.filesChanged?.length || 0), 0)
    },
    toolUsage: Object.entries(toolCounts)
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.calls - a.calls),
    byMode: runs.reduce<Record<string, number>>((acc, r) => {
      const m = String(r.taskMode || 'general');
      acc[m] = (acc[m] || 0) + 1;
      return acc;
    }, {}),
    runs: runs.slice(0, 50).map((r) => ({
      runId: r.runId,
      sessionId: r.sessionId,
      startedAt: r.startedAt,
      durationMs: r.durationMs,
      iterations: r.iterations,
      taskMode: r.taskMode,
      modelId: r.modelId,
      filesChangedCount: r.filesChanged?.length || 0,
      toolCalls: r.toolCalls?.length || 0,
      error: r.error
    }))
  });
});

// P5.4 docs site: markdown docs served from /docs
const DOCS_DIR = path.join(process.cwd(), 'docs');
const SAFE_DOC_NAME = /^[a-z0-9_-]{1,64}$/;

app.get('/api/docs', (_req: Request, res: Response) => {
  try {
    const files = fs
      .readdirSync(DOCS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({
        name: f.replace(/\.md$/, ''),
        title: f
          .replace(/\.md$/, '')
          .split('-')
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ')
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, docs: files });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/api/docs/:name', (req: Request, res: Response) => {
  const name = String(req.params.name || '');
  if (!SAFE_DOC_NAME.test(name)) return res.status(400).json({ error: 'Invalid doc name' });
  const file = path.join(DOCS_DIR, `${name}.md`);
  try {
    res.json({ success: true, name, content: fs.readFileSync(file, 'utf-8') });
  } catch {
    res.status(404).json({ error: `Doc "${name}" not found` });
  }
});

// P2.1: whole-step unified diff (checkpoint vs current disk)
app.get('/api/workspace/checkpoint-diff', (req: Request, res: Response) => {
  const sessionId = (req.query.sessionId as string) || 'default';
  const backupName = req.query.backupName as string;
  if (!backupName) return res.status(400).json({ error: 'Missing backupName' });
  try {
    const patches = computeCheckpointDiffs(getWorkspaceRoot(sessionId), backupName);
    res.json({ patches });
  } catch (err: any) {
    if (err instanceof PathTraversalError) return res.status(403).json({ error: err.message });
    res.status(404).json({ error: String(err?.message || err) });
  }
});

const runControllers: Record<string, AbortController> = {};

// Cache the workspace index per root: it reads up to 400 files synchronously,
// which is wasteful on every request and brutal on large repos. Invalidate via
// TTL so edits made outside the watcher still show up within 30s.
const workspaceIndexCache: Record<string, { text: string; builtAt: number }> = {};
const WORKSPACE_INDEX_TTL_MS = 30_000;

function buildWorkspaceIndex(root: string, maxChars = 7000): string {
  const cached = workspaceIndexCache[root];
  if (cached && Date.now() - cached.builtAt < WORKSPACE_INDEX_TTL_MS) return cached.text;
  const text = buildWorkspaceIndexUncached(root, maxChars);
  workspaceIndexCache[root] = { text, builtAt: Date.now() };
  return text;
}

function buildWorkspaceIndexUncached(root: string, maxChars = 7000): string {
  // P3.2: ranked repo map (recency + dependency fan-in + symbol presence)
  // replaces the old first-400-alphabetical file listing.
  const { text, scanned } = buildRepoMap(root, maxChars);
  const header = `Workspace root: ${root}\nRanked code map (${scanned} files scanned; highest-signal first — recently changed and heavily imported files lead):\n`;
  return text ? header + text + '\n' : header + '(no code files found)\n';
}

app.post('/api/agent/cancel', (req: Request, res: Response) => {
  const { sessionId = 'default' } = req.body || {};
  const controller = runControllers[sessionId];
  if (controller) {
    controller.abort();
    delete runControllers[sessionId];
    return res.json({ success: true, cancelled: true });
  }
  res.json({ success: true, cancelled: false, message: 'No active run for session' });
});

// ---------------- RE2/RE4: NDJSON STREAMING RUN + PERMISSIONS ----------------

const pendingPermissions: Record<string, (allowed: boolean) => void> = {};

app.post('/api/agent/permission', (req: Request, res: Response) => {
  const { runId, allowed } = req.body || {};
  const resolver = pendingPermissions[String(runId)];
  if (resolver) {
    resolver(!!allowed);
    delete pendingPermissions[String(runId)];
    res.json({ success: true });
  } else {
    res.json({ success: false, message: 'No pending permission request' });
  }
});

// P2.2: diff-review responses (accepted hunk ids per run)
const pendingReviews: Record<string, (accepted: number[] | null) => void> = {};

app.post('/api/agent/review', (req: Request, res: Response) => {
  const { runId, accepted } = req.body || {};
  const resolver = pendingReviews[String(runId)];
  if (resolver) {
    resolver(Array.isArray(accepted) ? accepted.map(Number).filter((n) => Number.isInteger(n)) : null);
    delete pendingReviews[String(runId)];
    res.json({ success: true });
  } else {
    res.json({ success: false, message: 'No pending review request' });
  }
});

// P2.4: per-project rules stored in <workspace>/.devforge.json
app.get('/api/project/config', (req: Request, res: Response) => {
  const sessionId = String(req.query.sessionId || 'default');
  res.json({ success: true, config: loadProjectConfig(getWorkspaceRoot(sessionId)) });
});

app.post('/api/project/config', (req: Request, res: Response) => {
  const { sessionId = 'default', config } = req.body || {};
  try {
    const saved = saveProjectConfig(getWorkspaceRoot(String(sessionId)), config || {});
    res.json({ success: true, config: saved });
  } catch (e: any) {
    res.status(400).json({ success: false, message: e?.message || 'Failed to save project config' });
  }
});

// Cache of per-model num_ctx values read from Ollama /api/show
const ollamaCtxCache = new Map<string, number>();

async function resolveOllamaModelNumCtx(endpoint: string | undefined, modelId?: string): Promise<number | null> {
  if (!modelId) return null;
  const cached = ollamaCtxCache.get(modelId);
  if (cached) return cached;
  const base = (endpoint || 'http://127.0.0.1:11434').replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return null;
    const d: any = await r.json();
    // Priority: explicit PARAMETER num_ctx in the Modelfile > trained context length
    const paramMatch = String(d?.parameters || '').match(/num_ctx\s+(\d+)/);
    let ctx: number | null = paramMatch ? parseInt(paramMatch[1], 10) : null;
    if (!ctx && d?.model_info) {
      const key = Object.keys(d.model_info).find((k) => k.endsWith('.context_length'));
      ctx = key ? Number(d.model_info[key]) || null : null;
    }
    if (ctx && ctx >= 2048) {
      ollamaCtxCache.set(modelId, ctx);
      return ctx;
    }
  } catch {}
  return null;
}

// ---------------- P0.1: shared task-context resolver ----------------
//
// Both `/api/agent/stream` and `/api/agent/resume` must rebuild the exact same
// system instruction (task params, persona, LTM, workspace index) so a resumed
// run is indistinguishable from a fresh one given the same inputs. Centralise
// that here instead of duplicating the template.
async function resolveTaskContext(
  sessionId: string,
  prompt: string,
  modelId: string,
  modelEndpoint: string | undefined,
  taskMode: unknown,
  thinkingLevel: string
): Promise<{
  mode: TaskMode;
  taskParams: ReturnType<typeof resolveTaskParams>;
  systemContext: string;
}> {
  const mode: TaskMode = isTaskMode(taskMode) ? taskMode : 'general';
  const profile = await getSystemProfile();
  const largeModel = /(\d{2,}b|27b|32b|64k|70b)/i.test(modelId || '');
  const taskParams = resolveTaskParams(mode, profile.recommendedContextTokens, { largeModel });

  // P5.2 model compatibility matrix: apply family-tuned sampling deltas and
  // context ceiling on top of the task-mode defaults.
  const modelPreset = findModelPreset(modelId);
  if (modelPreset) {
    const { temperature, topP, repeatPenalty } = { ...taskParams, ...(modelPreset.sampling || {}) };
    taskParams.temperature = temperature;
    taskParams.topP = topP;
    taskParams.repeatPenalty = repeatPenalty;
    if (modelPreset.maxCtxTokens) {
      taskParams.numCtxTokens = Math.min(taskParams.numCtxTokens, modelPreset.maxCtxTokens);
    }
  }

  // Honour the model's own num_ctx setting instead of clamping to hardware estimate.
  const ollamaCtx = await resolveOllamaModelNumCtx(modelEndpoint, modelId);
  if (ollamaCtx) {
    taskParams.numCtxTokens = ollamaCtx;
  }

  const wsRoot = getWorkspaceRoot(sessionId);
  const relevantMemories = await retrieveScopedMemories(wsRoot, prompt);
  const ltmBlock =
    relevantMemories.length > 0
      ? `=== RELEVANT LONG-TERM PROJECT MEMORIES (LTM) ===\n` +
        relevantMemories.map((m) => `- [${m.category}] ${m.key}: ${m.value}`).join('\n') +
        `\n- These are cross-session facts/conventions. Use the recall tool to look up more; remember them with the remember tool if you discover new durable facts.\n\n`
      : '';

  // P2.4: project rules from .devforge.json + AGENTS.md-style files
  const projectRules = loadProjectInstructions(getWorkspaceRoot(sessionId));
  const rulesBlock = projectRules
    ? `=== PROJECT RULES (must be followed) ===\n${projectRules}\n\n`
    : '';

  const systemInstruction = `You are DevForge Agent, an expert software engineer working directly on a real filesystem workspace.

=== HOW TO WORK ===
1. PLAN FIRST: before any edits, briefly state a numbered plan of the changes you will make, then execute the items one by one in order.
2. You have tools: list_files, search, read_file, file_outline, write_file, apply_patch, run_command, git_diff.
3. ALWAYS investigate before editing. Prefer apply_patch for edits; write_file only for new files.
4. EXPLORE EFFICIENTLY: use list_files/file_outline/search first (and semantic_search when available for meaning-based lookups). Never read_file an entire file larger than ~400 lines — read the specific ranges you need or work from its outline. Do not re-read a file you have already read unless it changed.
5. BUDGET YOUR WORK: you have a limited number of iterations. Start editing as soon as you understand enough; do not exhaust your budget on exploration alone. If the task is large, complete the most important changes first and verify them.
6. VERIFY with run_command (npm test / npm run lint / tsc --noEmit) when relevant.
7. Summarize which files you changed and why.

=== CONVERSATION RULES ===
- Answer ONLY the latest user message; build on earlier turns.

${taskParams.personaAddendum}
${ltmBlock}${rulesBlock}${buildWorkspaceIndex(getWorkspaceRoot(sessionId))}
Use tools to read any file's full contents on demand.`;

  return { mode, taskParams, systemContext: systemInstruction };
}

app.post('/api/agent/stream', async (req: Request, res: Response) => {
  const {
    prompt,
    modelId = 'local-auto-detected',
    modelEndpoint,
    sessionId = 'default',
    attachments = [],
    thinkingLevel = 'none',
    taskMode,
    writePolicy: clientWritePolicy, // 'ask' | 'allow' | 'deny' | 'review'; falls back to project config
    runId: clientRunId,        // optional: reuse a prior snapshot's runId for resume
    priorMessages              // optional: message list to seed the loop (resume path)
  } = req.body || {};

  // P2.4: per-project default write policy from .devforge.json when unset by the client
  const writePolicy =
    clientWritePolicy ||
    loadProjectConfig(getWorkspaceRoot(String(sessionId))).writePolicy ||
    'ask';

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  const send = (evt: Record<string, any>) => {
    try {
      res.write(JSON.stringify(evt) + '\n');
    } catch {}
  };

  if (!prompt) {
    send({ type: 'error', error: 'Prompt is required' });
    return res.end();
  }

  // P0.1: resume support — if the client passes `runId` we resume from that
  // saved snapshot's message list (`priorMessages`), otherwise we start a
  // fresh run with a new id.
  const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
  let runId: string;
  let prior: any[] | undefined;
  if (typeof clientRunId === 'string' && SAFE_RUN_ID.test(clientRunId)) {
    runId = clientRunId;
    if (Array.isArray(priorMessages) && priorMessages.length > 0) {
      prior = priorMessages.slice(0, 200); // defensive cap; real cap lives in the loop
    }
  } else {
    runId = `run-${cryptoRandomUUID()}`;
  }

  const { mode, taskParams, systemContext } = await resolveTaskContext(
    sessionId,
    prompt,
    modelId,
    modelEndpoint,
    taskMode,
    thinkingLevel
  );

  const controller = new AbortController();
  runControllers[sessionId] = controller;
  ensureWorkspaceWatcher(sessionId);
  const startedAt = Date.now();

  // P0.1: per-run message snapshot. Saved after every iteration; deleted on
  // clean success, kept on cancel/error so the run can be resumed.
  let seenFiles: string[] = [];
  const persistSnapshot = (messages: any[]) => {
    try {
      saveRunState(process.cwd(), runId, {
        v: 1,
        runId,
        sessionId,
        prompt: prompt.slice(0, 4000),
        modelId,
        modelEndpoint,
        thinkingLevel,
        taskMode,
        writePolicy,
        iterations: 0, // updated from result.iterations on completion
        filesChanged: seenFiles,
        messages,
        savedAt: new Date().toISOString()
      });
    } catch {}
  };

  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  (req.body.history || []).forEach((msg: any) => {
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (text.trim()) history.push({ role: msg.sender === 'user' ? 'user' : 'assistant', content: text });
  });

  // Cross-turn compaction: keep the last 8 turns verbatim; summarize-truncate
  // older turns to their head so long conversations don't drown the context.
  const KEEP_VERBATIM = 16; // messages (8 turns)
  if (history.length > KEEP_VERBATIM) {
    const older = history.slice(0, -KEEP_VERBATIM);
    const recent = history.slice(-KEEP_VERBATIM);
    const compacted = older.map((m) => ({
      role: m.role,
      content:
        m.content.length > 300
          ? m.content.slice(0, 300) + '[earlier message truncated]'
          : m.content
    }));
    history.length = 0;
    history.push(...compacted, ...recent);
  }

  const loopOpts = {
    root: getWorkspaceRoot(sessionId),
    modelId,
    endpoints: [...new Set([modelEndpoint, 'http://127.0.0.1:11434', 'http://localhost:11434', 'http://127.0.0.1:1234'].filter(Boolean))] as string[],
    history,
    systemContext,
    maxIterations: Math.max(taskParams.maxIterations, thinkingLevel === 'high' ? 12 : 0),
    sessionId,
    // P1.5a: durable task ledger bound to this run
    runId,
    // P3.1: semantic code retrieval tool (local embeddings, keyword fallback)
    semanticSearch: async (query: string, k?: number) => {
      const { chunks, mode } = await retrieveCode(getWorkspaceRoot(sessionId), query, k);
      return renderRetrieval(chunks, mode);
    },
    // P7.4 item 1: recall — search scoped long-term memories for this workspace
    queryMemories: async (query: string, k?: number) => {
      const ws = getWorkspaceRoot(sessionId);
      const results = await retrieveScopedMemories(ws, query, Math.min(k || 6, 12));
      if (results.length === 0) return '(no memories matched this query)';
      return results.map((m) => `- [${m.category} · ${m.scope}] ${m.key}: ${m.value}`).join('\n');
    },
    // P7.4 item 1: remember — persist a durable fact for this workspace or 'global'
    remember: async (args) => {
      const defaultScope = canonicalScope(getWorkspaceRoot(sessionId));
      const scope: string = args.scope ? canonicalScope(args.scope) : defaultScope;
      const rec = addMemoryToIndex({
        category: args.category || 'fact',
        key: args.key,
        value: args.value,
        source: 'agent_remembered',
        scope,
        tags: args.tags,
        createdAt: new Date().toISOString()
      });
      persistStore();
      try {
        const v = await embedText(`${rec.key}: ${rec.value}`);
        if (v) {
          embeddingCache[rec.id] = v;
          saveEmbeddingCache(process.cwd(), embeddingCache);
        }
      } catch {}
      return { ok: true };
    },
    // P3.3: read-only explore subagent (own iteration budget, cannot edit)
    runSubagent: async (question: string) => {
      const { runExploreSubagent } = await import('./server/subagents');
      const sub = await runExploreSubagent({
        root: getWorkspaceRoot(sessionId),
        endpoints: [...new Set([modelEndpoint, 'http://127.0.0.1:11434', 'http://localhost:11434', 'http://127.0.0.1:1234'].filter(Boolean))] as string[],
        modelId,
        question,
        semanticSearch: async (q, kk) => {
          const r = await retrieveCode(getWorkspaceRoot(sessionId), q, kk);
          return renderRetrieval(r.chunks, r.mode);
        }
      });
      return `[subagent report · ${sub.iterations} iterations${sub.stoppedEarly ? ' · HIT ITS OWN BUDGET (report may be incomplete)' : ''}]\n${sub.report}`;
    },
    // P1.5e edit validation gate: cheap syntax/import checks before any write hits disk
    validateEdit: async (relPath: string, newContent: string) => {
      const r = await validateEditedContent(getWorkspaceRoot(sessionId), relPath, newContent);
      return r.ok ? null : r.errors.join('\n');
    },
    // P1.2 auto-verify / self-heal: enable when the workspace has detectable
    // verify commands (package.json scripts, tsconfig, pytest config)
    ...(detectVerifyCommands(getWorkspaceRoot(sessionId)).length
      ? {
          autoVerify: {
            commands: detectVerifyCommands(getWorkspaceRoot(sessionId)),
            maxHealAttempts: 3
          }
        }
      : {}),
    thinkingLevel,
    // P0.1: if the client resumed from a snapshot, seed the loop with the
    // saved message list so the model continues instead of re-exploring.
    ...(prior ? { priorMessages: prior } : {}),
    sampling: {
      temperature: taskParams.temperature,
      topP: taskParams.topP,
      repeatPenalty: taskParams.repeatPenalty,
      numCtxTokens: taskParams.numCtxTokens
    },
    signal: controller.signal,
    onEvent: (evt: LoopEvent) => {
      if (evt.type === 'files_changed') {
        for (const f of evt.files) if (!seenFiles.includes(f)) seenFiles.push(f);
      }
      send(evt as any);
    },
    // P0.1: persist the message list after every iteration so a crash/cancel
    // leaves a resumable snapshot on disk. `seenFiles` is mutated in place so
    // the closure always sees the latest progress.
    onMessages: (msgs) => persistSnapshot(msgs),
    requestPermission: async (_toolName: string, args: Record<string, any>) => {
      if (writePolicy === 'allow') return true;
      if (writePolicy === 'deny') return false;
      // P2.2: in review mode non-edit tools (e.g. run_command) still ask;
      // write_file/apply_patch were already gated by the hunk-level review.
      if (writePolicy === 'review' && _toolName !== 'run_command') return true;
      // RE4: pause loop until user answers via /api/agent/permission
      send({
        type: 'permission_request',
        runId,
        toolName: _toolName,
        summary: _toolName === 'run_command' ? String(args.command || '') : String(args.path || '')
      });
      return await new Promise<boolean>((resolve) => {
        pendingPermissions[runId] = resolve;
      });
    },
    // P2.2 diff-review gate (only in 'review' write policy): the user accepts/
    // rejects individual hunks; only accepted hunks are executed.
    ...(writePolicy === 'review'
      ? {
          reviewEdit: async (call: any) => {
            const proposal = buildEditProposal(getWorkspaceRoot(sessionId), call.name, call.arguments);
            if ('error' in proposal) {
              send({ type: 'token', delta: `\n\n[diff review unavailable: ${proposal.error}]` });
              return null;
            }
            send({
              type: 'edit_review_request',
    runId,
    // P5.3: user-defined plugin tools from .devforge.json
    ...(getPluginToolDefs(getWorkspaceRoot(sessionId)).length
      ? {
          pluginTools: getPluginToolDefs(getWorkspaceRoot(sessionId)).map((def) => ({
            name: def.name,
            schema: buildPluginSchemas([def])[0],
            execute: (args: Record<string, unknown>) => executePluginTool(getWorkspaceRoot(sessionId), def, args)
          }))
        }
      : {}),
              toolName: call.name,
              path: proposal.path,
              isNewFile: proposal.isNewFile,
              hunks: proposal.hunks
            });
            const accepted = await new Promise<number[] | null>((resolve) => {
              pendingReviews[runId] = resolve;
            });
            if (!accepted || !accepted.length) return null;
            const args = reviewedArgs(proposal, accepted);
            return args ? { ...call, arguments: args } : null;
          }
        }
      : {}),
    // P1.5d git-first workflow: auto-commit each verified step (best-effort)
    onStepVerified: async (files: string[], summary: string) => {
      try {
        const res = await commitVerifiedStep(
          getWorkspaceRoot(sessionId),
          files,
          `DevForge(${runId.slice(0, 8)}): ${summary || files.join(', ')}`
        );
        if (res.ok && res.commit) {
          send({ type: 'token', delta: `\n\n📌 Committed verified step \`${res.commit}\` (${files.length} file${files.length > 1 ? 's' : ''})` });
        }
      } catch {
        /* git workflow is best-effort */
      }
    }
  };
  const runLoop = (loopPrompt: string) => runAgentLoop({ ...loopOpts, prompt: loopPrompt });
  // P2.3: latest structured plan submitted via update_plan (for final graphState)
  let latestPlanSteps: Array<{ text: string; status: string }> | null = null;
  void latestPlanSteps;
  Object.assign(loopOpts, {
    onPlanUpdate: (steps: Array<{ text: string; status: string }>) => {
      latestPlanSteps = steps.map((s) => ({ text: s.text, status: s.status }));
    }
  });

    // Auto-continue: if the model exhausted its iteration budget without a final
    // answer, keep going instead of silently stopping (up to 5 extra passes).
    try {
    // P1.5d: dedicated work branch + dirty-state checkpoint commit for git workspaces
    try {
      const branchInfo = await ensureRunBranch(getWorkspaceRoot(sessionId), runId);
      if (branchInfo) {
        send({
          type: 'token',
          delta: `\n\n🌿 Working on branch \`${branchInfo.branch}\` (base: ${branchInfo.baseBranch})${branchInfo.createdCheckpointCommit ? ' — pre-run changes checkpointed' : ''}`
        });
      }
    } catch {}
    let result = await runLoop(prompt);
    let continuations = 0;
    while (result.hitIterationCap && !controller.signal.aborted && continuations < 5) {
      continuations++;
      send({ type: 'token', delta: `\n\nIteration budget reached — continuing automatically (pass ${continuations + 1})` });
      const before = result.filesChanged.length;
      // Re-embed the original task: pass 1's task prompt is NOT in `history`
      // (it rode alone in pass 1's last user message, which this prompt replaces),
      // so a generic "continue" instruction loses the task entirely and the model
      // replies "there is no previous work to continue". Keep up to 2000 chars so
      // multi-part tasks don't lose requirements in continuation passes.
      const task = prompt.length > 2000 ? prompt.slice(0, 2000) + '\u2026' : prompt;
      const next = await runAgentLoop({
        ...loopOpts,
        prompt: `Original task: ${task}\n\nContinue that task from where it left off. Do not repeat completed steps. Finish any remaining work, verify it, then give your final summary.`,
        // Resume with pass 1's full message list (tool calls + results) so the
        // model continues from where it stopped instead of re-exploring.
        priorMessages: result.messages
      });
      result = {
        reply: next.reply || result.reply,
        iterations: result.iterations + next.iterations,
        toolCalls: [...result.toolCalls, ...next.toolCalls],
        filesChanged: [...new Set([...result.filesChanged, ...next.filesChanged])],
        usedTools: result.usedTools || next.usedTools,
        // Carry through whether the continuation ALSO hit its cap, so the
        // loop can keep auto-continuing (up to 5 passes) instead of stopping
        // after the first exhausted budget.
        hitIterationCap: next.hitIterationCap === true,
        messages: next.messages || result.messages
      };
      if (next.filesChanged.length === before && !next.usedTools) break; // model has nothing left to do
    }

    appendRunLog(process.cwd(), {
      runId,
      sessionId,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      modelId,
      taskMode: mode,
      promptChars: prompt.length,
      toolCalls: result.toolCalls.map((t) => ({ name: t.name, ok: t.ok })),
      filesChanged: result.filesChanged,
      iterations: result.iterations
    });

    const lspDiagnostics: LSPDiagnostic[] = await runWorkspaceDiagnostics(sessionId);

    // P2.3: prefer the agent's STRUCTURED plan (update_plan events) over
    // regex-scraped numbered prose for the final pipeline graph.
    const structured = latestPlanSteps && latestPlanSteps.length ? latestPlanSteps : null;
    const planItems = structured
      ? structured.map((s) => s.text)
      : (result.reply.match(/^\s*\d+[.)]\s+(.{3,140})/gm) || [])
          .map((l: string) => l.replace(/^\s*\d+[.)]\s+/, '').trim())
          .filter((t: string) => !/^https?:/.test(t))
          .slice(0, 8);
    const planStatusFor = (i: number): 'success' | 'failed' | 'pending' => {
      if (!structured) return i < Math.min(planItems.length, 8) ? 'success' : 'pending';
      const st = structured[i]?.status;
      if (st === 'completed') return 'success';
      if (st === 'in_progress' || !st) return 'success';
      return 'pending';
    };
    const graphState: LangGraphNodeState[] = [
      { id: 'analyze_context', label: '1. Analyze Context & Prompt', status: 'success', durationMs: 40 },
      ...planItems.map((item, i) => ({
        id: `plan-${i}`,
        label: `${item.length > 70 ? item.slice(0, 67) + '…' : item}`,
        status: planStatusFor(i),
        ...(structured?.[i]?.status === 'in_progress' ? { message: 'in progress' } : {})
      })),
      {
        id: 'execute_tools',
        label: `Tool Execution (${result.toolCalls.length} calls)`,
        status: result.toolCalls.some((t) => !t.ok) && result.toolCalls.every((t) => !t.ok) ? 'failed' : 'success',
        message: result.filesChanged.length ? `Changed: ${result.filesChanged.join(', ')}` : undefined,
        durationMs: Math.max(result.iterations * 10, 50)
      },
      { id: 'verify_lsp', label: 'Verification Re-Check', status: 'success', durationMs: 40 },
      {
        id: 'complete',
        label: 'Final Delivery',
        status: 'success',
        message: `${result.filesChanged.length} file(s) changed across ${result.iterations} tool results`
      }
    ];

    send({
      type: 'done',
      payload: {
        reply: result.reply,
        actions: result.toolCalls.map((t) => ({
          type: t.name.startsWith('run') ? 'run_command' : 'read_file',
          target: t.name,
          description: `${t.name}: ${t.ok ? 'ok' : 'failed'} — ${String(t.content).slice(0, 120)}`,
          status: t.ok ? 'completed' : 'failed'
        })),
        lspDiagnostics,
        graphState,
        iterations: result.iterations,
        filesChanged: result.filesChanged,
        filePatches: computeDiffsForFiles(getWorkspaceRoot(sessionId), result.filesChanged),
        usedTools: result.usedTools,
        appliedParams: taskParams,
        timestamp: new Date().toISOString()
      }
    });

    // P0.1: clean success — remove the per-run snapshot so it does not show
    // up as a "pending resume". A crash / cancel path leaves the file behind,
    // and the user can pick it up via /api/agent/pending-resumes.
    try { deleteRunState(process.cwd(), runId); } catch {}
  } catch (err: any) {
    if (controller.signal.aborted || err?.message === 'cancelled') {
      send({ type: 'error', error: 'cancelled' });
    } else {
      send({ type: 'error', error: String(err?.message || err) });
    }
  } finally {
    delete runControllers[sessionId];
    delete pendingPermissions[runId];
    if (pendingReviews[runId]) {
      try { pendingReviews[runId](null); } catch {}
      delete pendingReviews[runId];
    }
    res.end();
  }
});


// ---------------- P0.2: resume + pending-resumes endpoints ----------------
//
// `POST /api/agent/resume` re-runs a crashed/cancelled run from its last
// snapshot. The saved message list is fed back via `priorMessages`, so the
// model continues with full memory of prior tool activity instead of
// re-exploring the workspace.
app.post('/api/agent/resume', async (req: Request, res: Response) => {
  const { runId } = req.body || {};
  if (!runId) {
    return res.status(400).json({ error: 'runId is required' });
  }
  const state = loadRunState(process.cwd(), String(runId));
  if (!state) {
    return res.status(404).json({ error: 'No run snapshot found for that runId' });
  }
  // Mark as consumed so it stops showing up in /api/agent/pending-resumes.
  deleteRunState(process.cwd(), String(runId));
  return res.status(200).json(state);
});

// `GET /api/agent/pending-resumes` lists resumable snapshots (most recent
// first) without returning the (large) message payloads.
app.get('/api/agent/pending-resumes', async (_req: Request, res: Response) => {
  const list = listRunStates(process.cwd());
  return res.json({ items: list, count: list.length });
});


// Vite Middleware for development & static serving for production
async function startServer() {
  // P4.4: LAN access is opt-in. DEVFORGE_HOST=lan (or HOST=0.0.0.0) binds all
  // interfaces and gates every request behind a shared auth token.
  const lanRequested =
    process.env.DEVFORGE_HOST === 'lan' ||
    process.env.HOST === '0.0.0.0' ||
    process.env.HOST === 'lan';

  if (lanRequested) {
    const token = getOrCreateToken(process.cwd());
    const secureCookie = process.env.LAN_COOKIE_SECURE === '1';
    app.use(createLanGate(token, {
      secureCookie,
      maxAttemptsPerWindow: Number(process.env.LAN_MAX_ATTEMPTS) || 10,
      windowMs: Number(process.env.LAN_WINDOW_MS) || 60_000,
      lockMs: Number(process.env.LAN_LOCK_MS) || 60_000,
    }));
    const urls = [`http://localhost:${PORT}?token=${token}`].concat(
      lanAddresses().map((ip) => `http://${ip}:${PORT}?token=${token}`)
    );
    (app as any).__devforgeLanUrls = urls;
    console.log(`🌐 DevForge Studio listening on LAN with auth token:`);
    for (const u of urls) console.log(`   ${u}`);
    console.log(`   (mutating requests require the X-DevForge-Csrf header; the UI sends it automatically.)`);
    await serveUi();
    app.listen(PORT, '0.0.0.0', () => {});
    return;
  }

  await serveUi();
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`🚀 DevForge Studio server running on http://127.0.0.1:${PORT} (local only)`);
  });
}

async function serveUi() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
}

export { app };

// Only boot when run directly (not under Vitest, which imports the app)
if (!process.env.VITEST && !process.env.VITE_TEST) {
  startServer();
}
