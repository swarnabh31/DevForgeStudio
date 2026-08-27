import fs from 'fs';
import path from 'path';
import { embedText, cosineSimilarity, keywordScore } from './embeddings';
import { walkWorkspace, extractOutline, looksBinary, TEXT_EXTENSIONS } from './fsTools';
import { loadProjectConfig } from './projectConfig';

/**
 * P3.1 Embedding-based code retrieval.
 *
 * Chunk-level index of the workspace (functions/classes via regex outline,
 * sliding-window fallback) embedded with the local Ollama embedding model.
 * Retrieval gives the agent semantically relevant code locations instead of
 * blind truncation. Fully local; degrades to keyword scoring when embeddings
 * are unavailable (model not pulled / Ollama down).
 */

const INDEX_FILE = path.join('.opencode', 'code-index.json');
const MAX_CHUNK_LINES = 80;
const WINDOW_LINES = 60;
const WINDOW_STEP = 40;
const MAX_CHUNKS_PER_FILE = 60;
const MAX_INDEX_FILES = 2000;
const EMBED_BATCH_DELAY_MS = 15; // gentle on the local embedding server

export interface CodeChunk {
  id: string;            // `${relPath}:${startLine}-${endLine}`
  relPath: string;
  name?: string;         // symbol name when outline-derived
  kind?: string;
  startLine: number;     // 1-based, inclusive
  endLine: number;       // 1-based, inclusive
  text: string;
}

interface IndexedFile {
  mtimeMs: number;
  size: number;
}

export interface CodeIndex {
  version: 1;
  files: Record<string, IndexedFile>;
  chunks: CodeChunk[];
  vectors: number[][] | null; // null → keyword-only mode
}

const indexCache = new Map<string, { index: CodeIndex; builtAt: number }>();
const INDEX_TTL_MS = 60000;

// ---------------- chunking ----------------

/** Split a file into semantic chunks: outline symbols first, window fallback. */
export function chunkSourceFile(relPath: string, content: string): CodeChunk[] {
  const lines = content.split('\n');
  if (!lines.length || !content.trim()) return [];

  const chunks: CodeChunk[] = [];
  const push = (start: number, end: number, name?: string, kind?: string) => {
    if (end < start) end = start;
    chunks.push({
      id: `${relPath}:${start + 1}-${end + 1}`,
      relPath,
      name,
      kind,
      startLine: start + 1,
      endLine: end + 1,
      text: lines.slice(start, end + 1).join('\n').slice(0, 4000)
    });
  };

  // Outline-anchored pass (symbol span = its line to the next top-level symbol)
  const symbols = extractOutline(relPath, content);
  if (symbols.length > 0 && symbols.length <= MAX_CHUNKS_PER_FILE) {
    const sorted = [...symbols].sort((a, b) => a.line - b.line);
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i];
      const start = Math.max(0, s.line - 1);
      // extend to just before the next symbol at same-or-lower depth heuristic:
      // simply to the next symbol's line (regex outlines are top-level biased)
      const end = Math.min(
        lines.length - 1,
        i + 1 < sorted.length ? Math.max(start, sorted[i + 1].line - 2) : lines.length - 1,
        start + MAX_CHUNK_LINES - 1
      );
      push(start, end, s.name, s.kind);
    }
    return chunks.slice(0, MAX_CHUNKS_PER_FILE);
  }

  // Sliding-window fallback for files without a usable outline
  for (let start = 0; start < lines.length; start += WINDOW_STEP) {
    const end = Math.min(lines.length - 1, start + WINDOW_LINES - 1);
    push(start, end);
    if (chunks.length >= MAX_CHUNKS_PER_FILE) break;
  }
  return chunks;
}

// ---------------- persistence ----------------

function indexFilePath(rootAbs: string): string {
  return path.join(rootAbs, INDEX_FILE);
}

function saveIndex(rootAbs: string, index: CodeIndex): void {
  try {
    const file = indexFilePath(rootAbs);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Persist without chunk bodies? Bodies are needed for snippets — cap size by
    // trimming stored text instead.
    const slim: CodeIndex = {
      ...index,
      chunks: index.chunks.map((c) => ({ ...c, text: c.text.slice(0, 1200) }))
    };
    fs.writeFileSync(file, JSON.stringify(slim), 'utf-8');
  } catch {}
}

function loadIndex(rootAbs: string): CodeIndex | null {
  try {
    const raw = JSON.parse(fs.readFileSync(indexFilePath(rootAbs), 'utf-8'));
    if (raw && raw.version === 1 && Array.isArray(raw.chunks)) return raw as CodeIndex;
  } catch {}
  return null;
}

// ---------------- indexing ----------------

async function embedChunks(
  chunks: CodeChunk[],
  embed: (text: string) => Promise<number[] | null>
): Promise<number[][] | null> {
  const vectors: number[][] = [];
  for (const c of chunks) {
    const header = c.name ? `${c.kind} ${c.name} in ${c.relPath}\n` : `${c.relPath}\n`;
    const v = await embed((header + c.text).slice(0, 3000));
    if (!v) return null; // embeddings unavailable → whole-index keyword mode
    vectors.push(v);
    await new Promise((r) => setTimeout(r, EMBED_BATCH_DELAY_MS));
  }
  return vectors;
}

/**
 * Build/refresh the workspace code index incrementally (unchanged files are
 * skipped by mtime+size). `opts.embed` injectable for tests; defaults to the
 * real Ollama embedText.
 */
export async function ensureCodeIndex(
  rootAbs: string,
  opts: { embed?: (text: string) => Promise<number[] | null>; force?: boolean } = {}
): Promise<CodeIndex> {
  const cached = indexCache.get(rootAbs);
  if (cached && !opts.force && Date.now() - cached.builtAt < INDEX_TTL_MS) return cached.index;

  const globs = loadProjectConfig(rootAbs).ignoreGlobs;
  const entries = walkWorkspace(rootAbs, { maxDepth: 12, maxFiles: MAX_INDEX_FILES }).filter(
    (e) =>
      !e.isDirectory &&
      TEXT_EXTENSIONS.has(path.extname(e.relPath).toLowerCase()) &&
      !(globs || []).some((g) => e.relPath.startsWith(g.replace(/\*.*$/, '')))
  );

  const previous = cached?.index || loadIndex(rootAbs) || {
    version: 1 as const,
    files: {},
    chunks: [],
    vectors: null
  };

  const files: Record<string, IndexedFile> = {};
  const keptChunks: CodeChunk[] = [];
  const keptVectors: Array<number[] | undefined> = [];
  const freshChunks: CodeChunk[] = [];
  const changedOrNew: string[] = [];

  // Carry forward unchanged files (with their vectors, positionally aligned)
  const oldVectorByChunkId = new Map<string, number>();
  if (previous.vectors) {
    previous.chunks.forEach((c, i) => oldVectorByChunkId.set(c.id, i));
  }

  for (const entry of entries) {
    let st: fs.Stats;
    try {
      st = fs.statSync(entry.absPath);
    } catch {
      continue;
    }
    const prev = previous.files[entry.relPath];
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
      files[entry.relPath] = prev;
      for (const c of previous.chunks.filter((c) => c.relPath === entry.relPath)) {
        keptChunks.push(c);
        const vi = oldVectorByChunkId.get(c.id);
        keptVectors.push(previous.vectors && vi !== undefined ? previous.vectors[vi] : undefined);
      }
    } else {
      files[entry.relPath] = { mtimeMs: st.mtimeMs, size: st.size };
      try {
        const buf = fs.readFileSync(entry.absPath);
        if (looksBinary(buf)) continue;
        freshChunks.push(...chunkSourceFile(entry.relPath, buf.toString('utf-8')));
        changedOrNew.push(entry.relPath);
      } catch {}
    }
  }

  const embed = opts.embed || embedText;
  let vectors: number[][] | null = null;

  if (freshChunks.length) {
    const freshVectors = await embedChunks(freshChunks, embed);
    if (freshVectors) {
      // Mixed index: previously embedded chunks keep their vectors
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
      const index: CodeIndex = { version: 1, files, chunks: all, vectors };
      indexCache.set(rootAbs, { index, builtAt: Date.now() });
      saveIndex(rootAbs, index);
      return index;
    }
    // Embeddings unavailable — fall through to keyword-only index
  } else if (previous.vectors && Object.keys(files).length === Object.keys(previous.files).length) {
    vectors = previous.vectors; // nothing changed and we already had vectors
  }

  const index: CodeIndex = {
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

export interface RetrievedChunk {
  relPath: string;
  name?: string;
  kind?: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

/**
 * Hybrid retrieval: cosine similarity over embeddings (when available) blended
 * with keyword overlap so exact identifier matches still surface. Returns the
 * top-k chunks with short snippets.
 */
export async function retrieveCode(
  rootAbs: string,
  query: string,
  k = 6,
  opts: { embed?: (text: string) => Promise<number[] | null> } = {}
): Promise<{ chunks: RetrievedChunk[]; mode: 'embedding' | 'keyword' }> {
  const index = await ensureCodeIndex(rootAbs, opts);
  const qVec = index.vectors ? await (opts.embed || embedText)(query) : null;

  const scored = index.chunks.map((c, i) => {
    const kw = keywordScore(query, `${c.relPath} ${c.name || ''} ${c.text}`);
    if (index.vectors && qVec) {
      const cos = Math.max(0, cosineSimilarity(qVec, index.vectors[i]));
      return { chunk: c, score: 0.7 * cos + 0.3 * kw };
    }
    return { chunk: c, score: kw };
  });

  scored.sort((a, b) => b.score - a.score);
  const mode: 'embedding' | 'keyword' = index.vectors && qVec ? 'embedding' : 'keyword';

  const chunks = scored.slice(0, k).map(({ chunk, score }) => ({
    relPath: chunk.relPath,
    name: chunk.name,
    kind: chunk.kind,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    score: Number(score.toFixed(4)),
    snippet: chunk.text.split('\n').slice(0, 6).join('\n')
  }));

  return { chunks, mode };
}

/** Render retrieval results as an agent-friendly tool result body. */
export function renderRetrieval(results: RetrievedChunk[], mode: string): string {
  if (!results.length || results.every((r) => r.score <= 0)) {
    return '(no relevant code found — try search or list_files)';
  }
  const blocks = results.map(
    (r) =>
      `${r.relPath}:${r.startLine}-${r.endLine}${r.name ? ` (${r.kind} ${r.name})` : ''} [score ${r.score}]\n${r.snippet}`
  );
  return `[semantic ${mode} retrieval]\n\n${blocks.join('\n---\n')}\n\nUse read_file with offset/limit around these ranges.`;
}

/** Test helper: drop the in-memory index for a root. */
export function resetCodeIndex(rootAbs: string): void {
  indexCache.delete(rootAbs);
}
