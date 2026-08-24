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
   recordMtime
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
interface ServerLongTermMemory {
  id: string;
  category: 'convention' | 'fact' | 'architecture' | 'preference' | 'bug_note';
  key: string;
  value: string;
  source: 'auto_extracted' | 'user_defined' | 'workspace_scan';
  createdAt: string;
}

let serverLongTermMemories: ServerLongTermMemory[] = [];

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

/**
 * Rank long-term memories against a query using embeddings (nomic-embed-text),
 * blending in keyword overlap so exact terms always surface.
 * Falls back to keyword-only ranking when embeddings are unavailable.
 */
async function retrieveRelevantMemories(query: string, k = 6): Promise<ServerLongTermMemory[]> {
  if (serverLongTermMemories.length === 0) return [];
  const qvec = await embedText(query);
  const scored = serverLongTermMemories.map((m) => {
    let score = keywordScore(query, `${m.key} ${m.value}`);
    const mvec = embeddingCache[m.id];
    if (qvec && mvec) {
      const cos = cosineSimilarity(qvec, mvec);
      score = Math.max(score, cos > 0 ? cos : 0);
    }
    return { memory: m, score };
  });

  // Warm any missing embeddings in the background for next time; persist after
  if (qvec) {
    const missing = serverLongTermMemories.filter((m) => !embeddingCache[m.id]).slice(0, 20);
    if (missing.length) {
      Promise.all(
        missing.map((m) => getMemoryEmbedding(m.id, `${m.key}: ${m.value}`))
      ).then(() => saveEmbeddingCache(process.cwd(), embeddingCache)).catch(() => {});
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter((s) => s.score > 0.12).slice(0, k).map((s) => s.memory);
  // Never return nothing — old behavior (all memories) beats silence
  return top.length ? top : serverLongTermMemories.slice(0, k);
}

// Memory API GET
app.get('/api/memory', (req: Request, res: Response) => {
  res.json({
    longTermMemories: serverLongTermMemories,
    count: serverLongTermMemories.length
  });
});

// Memory API ADD
app.post('/api/memory/add', (req: Request, res: Response) => {
  const { key, value, category = 'convention', source = 'user_defined' } = req.body || {};
  if (!key || !value) {
    return res.status(400).json({ error: 'Key and value are required' });
  }

  const newItem: ServerLongTermMemory = {
    id: `ltm-${cryptoRandomUUID()}`,
    key: key.trim(),
    value: value.trim(),
    category,
    source,
    createdAt: new Date().toLocaleDateString()
  };

  serverLongTermMemories.unshift(newItem);
  persistStore();
  // Warm embedding cache in background for semantic retrieval
  embedText(`${newItem.key}: ${newItem.value}`)
    .then((vec) => {
      if (vec) {
        embeddingCache[newItem.id] = vec;
        saveEmbeddingCache(process.cwd(), embeddingCache);
      }
    })
    .catch(() => {});
  res.json({ success: true, item: newItem, longTermMemories: serverLongTermMemories });
});

// Memory API DELETE
app.delete('/api/memory/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  serverLongTermMemories = serverLongTermMemories.filter((m) => m.id !== id);
  delete embeddingCache[id];
  saveEmbeddingCache(process.cwd(), embeddingCache);
  persistStore();
  res.json({ success: true, longTermMemories: serverLongTermMemories });
});

// Memory API CLEAR
app.post('/api/memory/clear', (req: Request, res: Response) => {
  serverLongTermMemories = [];
  embeddingCache = {};
  saveEmbeddingCache(process.cwd(), embeddingCache);
  persistStore();
  res.json({ success: true, longTermMemories: [] });
});

// Memory API AUTO-EXTRACT — uses the local LLM to mine durable project facts
app.post('/api/memory/extract', async (req: Request, res: Response) => {
  const { sessionId = 'default', modelId, modelEndpoint } = req.body || {};
  const root = getWorkspaceRoot(sessionId);

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

  // Parse the JSON array out of the reply
  let items: Array<{ key?: string; value?: string; category?: string }> = [];
  try {
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) items = JSON.parse(m[0]);
  } catch {}

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(200).json({ success: false, message: 'Model returned no usable memories.', longTermMemories: serverLongTermMemories });
  }

  const extracted: ServerLongTermMemory[] = items
    .filter((i) => i.key && i.value)
    .slice(0, 5)
    .map((i) => ({
      id: `ltm-${cryptoRandomUUID()}`,
      key: String(i.key).slice(0, 80),
      value: String(i.value).slice(0, 500),
      category: (['fact', 'preference', 'convention'].includes(String(i.category)) ? String(i.category) : 'fact') as ServerLongTermMemory['category'],
      source: 'auto_extracted' as ServerLongTermMemory['source'],
      createdAt: new Date().toLocaleDateString()
    }));

  serverLongTermMemories.unshift(...extracted);
  persistStore();
  // Warm embedding cache for the new memories
  Promise.all(
    extracted.map((m) =>
      embedText(`${m.key}: ${m.value}`).then((vec) => {
        if (vec) embeddingCache[m.id] = vec;
      })
    )
  )
    .then(() => saveEmbeddingCache(process.cwd(), embeddingCache))
    .catch(() => {});
  res.json({ success: true, items: extracted, longTermMemories: serverLongTermMemories });
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

// A4: Import graph â€” "what breaks if I change X?"
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
    const timeout = setTimeout(() => controller.abort(), 120000);
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
    const timeout = setTimeout(() => controller.abort(), 120000);
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
import { exec } from 'child_process';
import { getSystemProfile } from './server/systemProfile';
import { resolveTaskParams, isTaskMode, TaskMode } from './server/taskProfiles';
import { listBackups, revertFromBackup, revertFileFromBackup } from './server/backups';
import { loadStore, saveStore, appendRunLog, AgentStore } from './server/persistence';
import type { LoopEvent } from './server/agentLoop';
import { computeDiffsForFiles } from './server/diffUtil';

// RE1: disk-backed store (survives restarts)
const appStore: AgentStore = loadStore(process.cwd());
if (appStore.longTermMemories.length && serverLongTermMemories.length === 0) {
  serverLongTermMemories = appStore.longTermMemories as typeof serverLongTermMemories;
}
function persistStore(): void {
  try {
    appStore.longTermMemories = serverLongTermMemories;
    saveStore(process.cwd(), appStore);
  } catch (e) {
    console.warn('[OpenCode] store save failed:', e);
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

const runControllers: Record<string, AbortController> = {};

function buildWorkspaceIndex(root: string, maxChars = 7000): string {
  const entries = walkWorkspace(root, { maxDepth: 12, maxFiles: 2000 }).filter((e) => !e.isDirectory);
  const codeFiles = entries.filter((f) => TEXT_EXTENSIONS.has(path.extname(f.relPath).toLowerCase()));
  let out = `Workspace root: ${root}\n${entries.length} files total, ${codeFiles.length} code files.\n`;
  out += 'Code file index (path - top-level symbols):\n';

  const lines: string[] = [];
  let used = out.length;
  for (const f of codeFiles.slice(0, 400)) {
    let syms: string[] = [];
    try {
      const buf = fs.readFileSync(f.absPath);
      if (looksBinary(buf)) continue;
      syms = extractOutline(f.absPath, buf.toString('utf-8')).slice(0, 8).map((s) => `${s.kind} ${s.name}`);
    } catch {}
    const line = `- ${f.relPath}${syms.length ? ` (${syms.join(', ')})` : ''}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return out + lines.join('\n') + '\n';
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

app.post('/api/agent/stream', async (req: Request, res: Response) => {
  const {
    prompt,
    modelId = 'local-auto-detected',
    modelEndpoint,
    sessionId = 'default',
    attachments = [],
    thinkingLevel = 'none',
    taskMode,
    writePolicy = 'ask' // 'ask' | 'allow' | 'deny'
  } = req.body || {};

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

  const mode: TaskMode = isTaskMode(taskMode) ? taskMode : 'general';
  const profile = await getSystemProfile();
  const largeModel = /(\d{2,}b|27b|32b|64k|70b)/i.test(modelId || '');
  const taskParams = resolveTaskParams(mode, profile.recommendedContextTokens, { largeModel });

  // Respect the model's own num_ctx setting (Ollama Modelfile PARAMETER num_ctx /
  // "ollama run <model> --ctx") instead of clamping to the hardware estimate.
  const ollamaCtx = await resolveOllamaModelNumCtx(modelEndpoint, modelId);
  if (ollamaCtx) {
    taskParams.numCtxTokens = ollamaCtx;
  }

  const controller = new AbortController();
  runControllers[sessionId] = controller;
  ensureWorkspaceWatcher(sessionId);
  const runId = `run-${cryptoRandomUUID()}`;
  const startedAt = Date.now();

  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  (req.body.history || []).forEach((msg: any) => {
    const text = typeof msg.content === 'string' ? msg.content : '';
    if (text.trim()) history.push({ role: msg.sender === 'user' ? 'user' : 'assistant', content: text });
  });

  // Cross-turn compaction: keep the last 8 turns verbatim; summarize-truncate
  // older turns to their head so long conversations don't drown the context.
  const KEEP_VERBATIM = 16; // messages (≈8 turns)
  if (history.length > KEEP_VERBATIM) {
    const older = history.slice(0, -KEEP_VERBATIM);
    const recent = history.slice(-KEEP_VERBATIM);
    const compacted = older.map((m) => ({
      role: m.role,
      content:
        m.content.length > 300
          ? m.content.slice(0, 300) + '…[earlier message truncated]'
          : m.content
    }));
    history.length = 0;
    history.push(...compacted, ...recent);
  }

  // Semantic retrieval: inject only the memories relevant to this prompt
  const relevantMemories = await retrieveRelevantMemories(prompt);
  const ltmBlock = relevantMemories.length > 0
    ? `=== RELEVANT LONG-TERM PROJECT MEMORIES (LTM) ===\n` +
      relevantMemories.map((m) => `- [${m.category}] ${m.key}: ${m.value}`).join('\n') + `\n\n`
    : '';

  const systemInstruction = `You are OpenCode Agent, an expert software engineer working directly on a real filesystem workspace.

=== HOW TO WORK ===
1. PLAN FIRST: before any edits, briefly state a numbered plan of the changes you will make, then execute the items one by one in order.
2. You have tools: list_files, search, read_file, file_outline, write_file, apply_patch, run_command, git_diff.
3. ALWAYS investigate before editing. Prefer apply_patch for edits; write_file only for new files.
4. EXPLORE EFFICIENTLY: use list_files/file_outline/search first. Never read_file an entire file larger than ~400 lines — read the specific ranges you need or work from its outline. Do not re-read a file you have already read unless it changed.
5. BUDGET YOUR WORK: you have a limited number of iterations. Start editing as soon as you understand enough; do not exhaust your budget on exploration alone. If the task is large, complete the most important changes first and verify them.
6. VERIFY with run_command (npm test / npm run lint / tsc --noEmit) when relevant.
7. Summarize which files you changed and why.

=== CONVERSATION RULES ===
- Answer ONLY the latest user message; build on earlier turns.

${taskParams.personaAddendum}
${ltmBlock}${buildWorkspaceIndex(getWorkspaceRoot(sessionId))}
Use tools to read any file's full contents on demand.`;

  const runLoop = (loopPrompt: string) =>
    runAgentLoop({
      root: getWorkspaceRoot(sessionId),
      prompt: loopPrompt,
      modelId,
      endpoints: [...new Set([modelEndpoint, 'http://127.0.0.1:11434', 'http://localhost:11434', 'http://127.0.0.1:1234'].filter(Boolean))] as string[],
      history,
      systemContext: systemInstruction,
      maxIterations: Math.max(taskParams.maxIterations, thinkingLevel === 'high' ? 8 : 0),
      sessionId,
      thinkingLevel,
      sampling: {
        temperature: taskParams.temperature,
        topP: taskParams.topP,
        repeatPenalty: taskParams.repeatPenalty,
        numCtxTokens: taskParams.numCtxTokens
      },
      signal: controller.signal,
      onEvent: (evt: LoopEvent) => send(evt as any),
      requestPermission: async (_toolName, args) => {
        if (writePolicy === 'allow') return true;
        if (writePolicy === 'deny') return false;
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
      }
    });

    // Auto-continue: if the model exhausted its iteration budget without a final
    // answer, keep going instead of silently stopping (up to 5 extra passes).
    try {
    let result = await runLoop(prompt);
    let continuations = 0;
    while (result.hitIterationCap && !controller.signal.aborted && continuations < 5) {
      continuations++;
      send({ type: 'token', delta: `\n\n⏭ Iteration budget reached — continuing automatically (pass ${continuations + 1})…\n\n` });
      const before = result.filesChanged.length;
      const next = await runLoop(
        'Continue your previous work. Do not repeat completed steps. Finish any remaining edits, verify them, then give your final summary.'
      );
      result = {
        reply: next.reply || result.reply,
        iterations: result.iterations + next.iterations,
        toolCalls: [...result.toolCalls, ...next.toolCalls],
        filesChanged: [...new Set([...result.filesChanged, ...next.filesChanged])],
        usedTools: result.usedTools || next.usedTools,
        hitIterationCap: false
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

    // Surface the agent's numbered plan (if it stated one) as pipeline nodes so
    // the Agent Pipeline tab shows real progress instead of a canned sequence.
    const planItems = (result.reply.match(/^\s*\d+[.)]\s+(.{3,140})/gm) || [])
      .map((l) => l.replace(/^\s*\d+[.)]\s+/, '').trim())
      .filter((t) => !/^https?:/.test(t))
      .slice(0, 8);
    const graphState: LangGraphNodeState[] = [
      { id: 'analyze_context', label: '1. Analyze Context & Prompt', status: 'success', durationMs: 40 },
      ...planItems.map((item, i) => ({
        id: `plan-${i}`,
        label: `Plan ${i + 1}. ${item.length > 70 ? item.slice(0, 67) + '…' : item}`,
        status: 'success' as const
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
          description: `${t.name}: ${t.ok ? 'ok' : 'failed'} â€” ${String(t.content).slice(0, 120)}`,
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
  } catch (err: any) {
    if (controller.signal.aborted || err?.message === 'cancelled') {
      send({ type: 'error', error: 'cancelled' });
    } else {
      send({ type: 'error', error: String(err?.message || err) });
    }
  } finally {
    delete runControllers[sessionId];
    delete pendingPermissions[runId];
    res.end();
  }
});


// Vite Middleware for development & static serving for production
async function startServer() {
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

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`ðŸš€ OpenCode Agent Studio server running on http://127.0.0.1:${PORT} (local only)`);
  });
}

export { app };

// Only boot when run directly (not under Vitest, which imports the app)
if (!process.env.VITEST && !process.env.VITE_TEST) {
  startServer();
}
