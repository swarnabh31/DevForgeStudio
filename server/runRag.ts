import fs from 'fs';
import path from 'path';
import { embedText, cosineSimilarity, keywordScore } from './embeddings';

/**
 * P7.4 item 3: RAG over past runs.
 *
 * Index + retrieval across this workspace's own past-run artifacts — the
 * non-lossy compaction transcripts (`.opencode/memory/<runId>-c<n>.md`),
 * the durable task ledgers (`.devforge/tasks/<runId>.md`), the run snapshots
 * (`.opencode/runs/<runId>.json`, if still present) and the run log
 * (`.opencode/logs/runs.jsonl`).
 *
 * The design mirrors `codeRetrieval.ts` (chunk + incremental index + hybrid
 * cosine/keyword ranking) so the agent gets a tool that answers the classic
 * "last time we did X on this repo, the fix was Y" question without the
 * owner re-narrating the context.
 *
 * Fully local, zero-new-deps, testable with an injected fake embed.
 */

const MAX_CHUNK_CHARS = 2400;
const WINDOW_CHARS = 1200;
const MAX_CHUNKS_PER_FILE = 40;
const MAX_FILES = 500;
const EMBED_BATCH_DELAY_MS = 10;

export interface RunChunk {
  id: string;
  source: 'transcript' | 'ledger' | 'runlog' | 'snapshot';
  relPath: string;
  runId?: string;
  start: number;
  end: number;
  text: string;
}

interface IndexedFile {
  source: RunChunk['source'];
  relPath: string;
  runId?: string;
  mtimeMs: number;
  size: number;
}

export interface RunRagIndex {
  version: 1;
  files: Record<string, IndexedFile>;
  chunks: RunChunk[];
  vectors: number[][] | null;
}

export interface RetrievedRun {
  source: RunChunk['source'];
  relPath: string;
  runId?: string;
  start: number;
  end: number;
  score: number;
  snippet: string;
}

const indexCache = new Map<string, { index: RunRagIndex; builtAt: number }>();
const INDEX_TTL_MS = 60000;

const RUN_ID_SAFE = /^[A-Za-z0-9_-]{1,128}$/;

function relPathSafe(relPath: string): boolean {
  if (typeof relPath !== 'string' || !relPath) return false;
  if (relPath.includes('..') || relPath.startsWith('/')) return false;
  return true;
}

function safeRunId(v: unknown): string | undefined {
  if (typeof v === 'string' && RUN_ID_SAFE.test(v)) return v;
  return undefined;
}

function indexFilePath(rootAbs: string): string {
  return path.join(rootAbs, '.opencode', 'rag-index.json');
}

function saveIndex(rootAbs: string, index: RunRagIndex): void {
  try {
    const file = indexFilePath(rootAbs);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(index), 'utf-8');
  } catch {}
}

function loadIndex(rootAbs: string): RunRagIndex | null {
  try {
    const raw = JSON.parse(fs.readFileSync(indexFilePath(rootAbs), 'utf-8'));
    if (raw && raw.version === 1 && Array.isArray(raw.chunks)) return raw as RunRagIndex;
  } catch {}
  return null;
}

// ---------------- document enumeration ----------------

interface EnumeratedDoc {
  source: RunChunk['source'];
  relPath: string;
  runId?: string;
  absPath: string;
  mtimeMs: number;
  size: number;
}

function enumerateDocs(rootAbs: string): EnumeratedDoc[] {
  const out: EnumeratedDoc[] = [];
  const seen = new Set<string>();
  const push = (d: EnumeratedDoc) => {
    const key = `${d.source}:${d.relPath}`;
    if (seen.has(key) || !relPathSafe(d.relPath)) return;
    seen.add(key);
    out.push(d);
    if (out.length >= MAX_FILES) throw new Error('cap hit');
  };

  const memDir = path.join(rootAbs, '.opencode', 'memory');
  if (fs.existsSync(memDir)) {
    for (const name of fs.readdirSync(memDir)) {
      if (!name.endsWith('.md')) continue;
      const base = name.replace(/\.md$/, '');
      const m = /^(.+)-c(\d+)$/.exec(base);
      const runId = safeRunId(m ? m[1] : base);
      const abs = path.join(memDir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) continue;
      try {
        push({ source: 'transcript', relPath: `.opencode/memory/${name}`, runId, absPath: abs, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        break;
      }
    }
  }

  const taskDir = path.join(rootAbs, '.devforge', 'tasks');
  if (fs.existsSync(taskDir)) {
    for (const name of fs.readdirSync(taskDir)) {
      if (!name.endsWith('.md')) continue;
      const runId = safeRunId(name.replace(/\.md$/, ''));
      const abs = path.join(taskDir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) continue;
      try {
        push({ source: 'ledger', relPath: `.devforge/tasks/${name}`, runId, absPath: abs, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        break;
      }
    }
  }

  const runsDir = path.join(rootAbs, '.opencode', 'runs');
  if (fs.existsSync(runsDir)) {
    for (const name of fs.readdirSync(runsDir)) {
      if (!name.endsWith('.json')) continue;
      const runId = safeRunId(name.replace(/\.json$/, ''));
      const abs = path.join(runsDir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) continue;
      try {
        push({ source: 'snapshot', relPath: `.opencode/runs/${name}`, runId, absPath: abs, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        break;
      }
    }
  }

  const logFile = path.join(rootAbs, '.opencode', 'logs', 'runs.jsonl');
  if (fs.existsSync(logFile)) {
    let st: fs.Stats;
    try {
      st = fs.statSync(logFile);
      if (st && st.size <= 1000000) {
        push({ source: 'runlog', relPath: '.opencode/logs/runs.jsonl', absPath: logFile, mtimeMs: st.mtimeMs, size: st.size });
      }
    } catch {}
  }

  return out;
}

// ---------------- chunking ----------------

function chunkDocument(text: string, base: { id: string; source: RunChunk['source']; relPath: string; runId?: string }): RunChunk[] {
  if (!text.trim()) return [];
  if (text.length <= MAX_CHUNK_CHARS) {
    return [{ id: base.id, source: base.source, relPath: base.relPath, runId: base.runId, start: 0, end: text.length, text }];
  }
  const chunks: RunChunk[] = [];
  for (let i = 0; i < text.length && chunks.length < MAX_CHUNKS_PER_FILE; i += WINDOW_CHARS) {
    chunks.push({
      ...base,
      id: `${base.id}:${i}`,
      start: i,
      end: Math.min(text.length, i + WINDOW_CHARS),
      text: text.slice(i, i + WINDOW_CHARS)
    });
  }
  return chunks;
}

function toDocument(doc: EnumeratedDoc): string {
  try {
    const raw = fs.readFileSync(doc.absPath, 'utf-8');
    if (doc.source === 'runlog') {
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            const r = JSON.parse(line);
            return `run=${r.runId} session=${r.sessionId} mode=${r.taskMode || '-'} iters=${r.iterations} files=[${(r.filesChanged || []).join(', ')}] tools=[${(r.toolCalls || []).map((t: any) => `${t.name}:${t.ok ? 'ok' : 'fail'}`).join(', ')}]${r.error ? ` error=${r.error}` : ''}`;
          } catch {
            return line;
          }
        })
        .join('\n');
    }
    if (doc.source === 'snapshot') {
      try {
        const s = JSON.parse(raw);
        const msgs: any[] = Array.isArray(s.messages) ? s.messages : [];
        const parts = [
          `run=${s.runId} session=${s.sessionId} iters=${s.iterations} files=[${(s.filesChanged || []).join(', ')}]`,
          s.prompt ? `prompt: ${String(s.prompt).slice(0, 400)}` : ''
        ].filter(Boolean);
        const tails = msgs
          .slice(-12)
          .map((m: any) => {
            const role = m.role || 'unknown';
            const content = typeof m.content === 'string' ? m.content : '';
            const tools = Array.isArray(m.tool_calls) ? ` [calls: ${m.tool_calls.map((t: any) => (t.function && t.function.name) || '').filter(Boolean).join(', ')}]` : '';
            return `${role}${tools}: ${content.slice(0, 400)}`;
          })
          .join('\n');
        return parts.join('\n') + (tails ? '\n' + tails : '');
      } catch {
        return raw;
      }
    }
    return raw;
  } catch {
    return '';
  }
}

// ---------------- embedding ----------------

async function embedChunks(chunks: RunChunk[], embed: (text: string) => Promise<number[] | null>): Promise<number[][] | null> {
  const vectors: number[][] = [];
  for (const c of chunks) {
    const header = c.runId ? `[past-run ${c.runId} - ${c.source}]\n` : `[${c.source}]\n`;
    const v = await embed((header + c.text).slice(0, 3000));
    if (!v) return null;
    vectors.push(v);
    await new Promise((r) => setTimeout(r, EMBED_BATCH_DELAY_MS));
  }
  return vectors;
}

// ---------------- indexing ----------------

export async function ensureRunRagIndex(
  rootAbs: string,
  opts: { embed?: (text: string) => Promise<number[] | null>; force?: boolean } = {}
): Promise<RunRagIndex> {
  const cached = indexCache.get(rootAbs);
  if (cached && !opts.force && Date.now() - cached.builtAt < INDEX_TTL_MS) return cached.index;

  const previous = cached?.index || loadIndex(rootAbs) || {
    version: 1 as const,
    files: {},
    chunks: [],
    vectors: null
  };
  const docs = enumerateDocs(rootAbs);
  const files: Record<string, IndexedFile> = {};
  const keptChunks: RunChunk[] = [];
  const keptVectors: Array<number[] | undefined> = [];
  const freshChunks: RunChunk[] = [];
  const changedOrNew: string[] = [];

  const oldVectorByChunkId = new Map<string, number>();
  if (previous.vectors) {
    previous.chunks.forEach((c, i) => oldVectorByChunkId.set(c.id, i));
  }

  for (const doc of docs) {
    const key = `${doc.source}:${doc.relPath}`;
    const prev = previous.files[key];
    if (prev && prev.mtimeMs === doc.mtimeMs && prev.size === doc.size) {
      files[key] = prev;
      for (const c of previous.chunks.filter((cc) => `${cc.source}:${cc.relPath}` === key)) {
        keptChunks.push(c);
        const vi = oldVectorByChunkId.get(c.id);
        keptVectors.push(previous.vectors && vi !== undefined ? previous.vectors[vi] : undefined);
      }
    } else {
      files[key] = { source: doc.source, relPath: doc.relPath, runId: doc.runId, mtimeMs: doc.mtimeMs, size: doc.size };
      const body = toDocument(doc);
      if (!body.trim()) continue;
      const base = { id: `${doc.source}:${doc.relPath}`, source: doc.source, relPath: doc.relPath, runId: doc.runId };
      freshChunks.push(...chunkDocument(body, base));
      changedOrNew.push(key);
    }
  }

  const embed = opts.embed || ((t: string) => embedText(t) as Promise<number[] | null>);
  let vectors: number[][] | null = null;

  if (freshChunks.length) {
    const freshVectors = await embedChunks(freshChunks, embed);
    if (freshVectors) {
      const all = [...keptChunks, ...freshChunks];
      const allVecs: number[][] = [];
      let fi = 0;
      for (let i = 0; i < all.length; i++) {
        if (i < keptChunks.length) {
          const v = keptVectors[i];
          allVecs.push(v && v.length ? v : new Array(freshVectors[0].length).fill(0));
        } else {
          allVecs.push(freshVectors[fi++]);
        }
      }
      vectors = allVecs;
      const index: RunRagIndex = { version: 1, files, chunks: all, vectors };
      indexCache.set(rootAbs, { index, builtAt: Date.now() });
      saveIndex(rootAbs, index);
      return index;
    }
  } else if (previous.vectors && Object.keys(files).length === Object.keys(previous.files).length) {
    vectors = previous.vectors;
  }

  const index: RunRagIndex = {
    version: 1,
    files,
    chunks: [...keptChunks, ...freshChunks],
    vectors: vectors ?? (freshChunks.length === 0 ? previous.vectors : null)
  };
  indexCache.set(rootAbs, { index, builtAt: Date.now() });
  if (changedOrNew.length) saveIndex(rootAbs, index);
  return index;
}

// ---------------- retrieval ----------------

export async function retrievePastRuns(
  rootAbs: string,
  query: string,
  k = 6,
  opts: { embed?: (text: string) => Promise<number[] | null>; runId?: string } = {}
): Promise<{ chunks: RetrievedRun[]; mode: 'embedding' | 'keyword' }> {
  const index = await ensureRunRagIndex(rootAbs, opts);
  const kClamped = Math.max(1, Math.min(20, k));
  const embedded = opts.embed || ((t: string) => embedText(t) as Promise<number[] | null>);
  const qVec = index.vectors ? await embedded(query) : null;

  const candidates = opts.runId ? index.chunks.filter((c) => c.runId === opts.runId) : index.chunks;

  const scored = candidates.map((c) => {
    const idx = index.chunks.indexOf(c);
    const kw = keywordScore(query, `${c.relPath} ${c.runId || ''} ${c.text}`);
    if (index.vectors && qVec && idx >= 0) {
      const cos = Math.max(0, cosineSimilarity(qVec, index.vectors![idx] ?? []));
      return { chunk: c, score: 0.7 * cos + 0.3 * kw };
    }
    return { chunk: c, score: kw };
  });

  scored.sort((a, b) => b.score - a.score);
  const mode: 'embedding' | 'keyword' = index.vectors && qVec ? 'embedding' : 'keyword';

  const chunks = scored.slice(0, kClamped).map(({ chunk, score }) => ({
    source: chunk.source,
    relPath: chunk.relPath,
    runId: chunk.runId,
    start: chunk.start,
    end: chunk.end,
    score: Number(score.toFixed(4)),
    snippet: chunk.text.slice(0, 400)
  }));

  return { chunks, mode };
}

/** Render retrieval results as an agent-friendly tool result body. */
export function renderPastRuns(results: RetrievedRun[], mode: string): string {
  if (!results.length || results.every((r) => r.score <= 0)) {
    return '(no past-run matches for this query - try a different phrase, or check `recall` for durable memories)';
  }
  const blocks = results.map(
    (r) => `run=${r.runId || '(unknown)'} via ${r.source} at ${r.relPath} [score ${r.score}]\n${r.snippet}`
  );
  return `[past-run ${mode} retrieval]\n\n${blocks.join('\n---\n')}\n\nOpen the transcript/ledger with read_file and search inside it for the exact snippet. Durable takeaways are also available via the recall tool.`;
}

/** Test helper: drop the in-memory index for a root. */
export function resetRunRagIndex(rootAbs: string): void {
  indexCache.delete(rootAbs);
}
