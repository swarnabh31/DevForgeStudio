import fs from 'fs';
import path from 'path';

/**
 * Local embeddings via Ollama (nomic-embed-text). Used for semantic retrieval
 * of long-term memories. Degrades gracefully: if the embedding model is not
 * pulled or Ollama is down, callers fall back to keyword matching / no-op.
 */

const EMBED_ENDPOINTS = [
  'http://127.0.0.1:11434',
  'http://localhost:11434'
];

let unavailableUntil = 0; // circuit breaker: don't hammer a dead Ollama

export async function embedText(text: string): Promise<number[] | null> {
  if (Date.now() < unavailableUntil) return null;
  for (const base of EMBED_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${base}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text', prompt: text.slice(0, 4000) }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        const data: any = await res.json();
        if (Array.isArray(data.embedding) && data.embedding.length > 0) {
          return data.embedding as number[];
        }
      }
    } catch {
      /* try next endpoint */
    }
  }
  // Back off for 60s after total failure
  unavailableUntil = Date.now() + 60000;
  return null;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Simple keyword-overlap fallback when embeddings are unavailable. */
export function keywordScore(query: string, text: string): number {
  const q = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  if (!q.size) return 0;
  const t = new Set(text.toLowerCase().split(/\W+/));
  let hits = 0;
  for (const w of q) if (t.has(w)) hits++;
  return hits / q.size;
}

/** Ensure the embedding model exists locally; best-effort pull is NOT done
 * automatically (respect user bandwidth) — we only probe availability. */
export async function embeddingModelAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${EMBED_ENDPOINTS[0]}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return false;
    const data: any = await res.json();
    return (data.models || []).some(
      (m: any) => String(m.name || '').startsWith('nomic-embed-text')
    );
  } catch {
    return false;
  }
}

/** Persist embeddings alongside the store without bloating memory entries in transit. */
export function saveEmbeddingCache(rootAbs: string, cache: Record<string, number[]>): void {
  try {
    const dir = path.join(rootAbs, '.opencode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'embeddings.json'), JSON.stringify(cache), 'utf-8');
  } catch {}
}

export function loadEmbeddingCache(rootAbs: string): Record<string, number[]> {
  try {
    const p = path.join(rootAbs, '.opencode', 'embeddings.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {}
  return {};
}
