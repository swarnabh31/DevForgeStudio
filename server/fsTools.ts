import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import ignore from 'ignore';
import { DEFAULT_IGNORED_DIRS, getLanguageForFile, resolveSafePath } from './lib';
import { loadProjectConfig } from './projectConfig';

export const TEXT_EXTENSIONS = new Set(
  Object.keys({
    '.ts': 1, '.tsx': 1, '.js': 1, '.jsx': 1, '.json': 1, '.css': 1, '.scss': 1,
    '.sass': 1, '.less': 1, '.html': 1, '.py': 1, '.md': 1, '.markdown': 1,
    '.yaml': 1, '.yml': 1, '.sql': 1, '.sh': 1, '.bash': 1, '.go': 1, '.rs': 1,
    '.java': 1, '.c': 1, '.cpp': 1, '.h': 1, '.hpp': 1, '.cs': 1, '.php': 1,
    '.rb': 1, '.vue': 1, '.svelte': 1, '.xml': 1, '.svg': 1, '.graphql': 1,
    '.prisma': 1, '.astro': 1, '.txt': 1, '.toml': 1, '.ini': 1, '.cfg': 1
  })
);

export function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

/** Build an ignore matcher from .gitignore + .git/info/exclude + defaults. */
export function buildIgnoreMatcher(rootAbs: string): ReturnType<typeof ignore> {
  const ig = ignore();
  ig.add([...DEFAULT_IGNORED_DIRS]); // names match at any depth via '**' semantics below

  // P2.4: project-configured ignore globs from .devforge.json
  const cfgGlobs = loadProjectConfig(rootAbs).ignoreGlobs;
  if (cfgGlobs?.length) ig.add(cfgGlobs);

  const addIfPresent = (file: string) => {
    try {
      if (fs.existsSync(file)) {
        ig.add(fs.readFileSync(file, 'utf-8'));
      }
    } catch {
      // unreadable ignore file — skip
    }
  };
  addIfPresent(path.join(rootAbs, '.gitignore'));
  addIfPresent(path.join(rootAbs, '.git', 'info', 'exclude'));
  return ig;
}

export interface WalkOptions {
  maxDepth?: number;       // -1 = unlimited-ish safety cap
  maxFiles?: number;       // hard cap on files returned
  maxFileSizeBytes?: number;
  readContents?: boolean;
}

export interface ScannedEntry {
  absPath: string;
  relPath: string;
  isDirectory: boolean;
  size?: number;
  mtimeMs?: number;
}

/**
 * Gitignore-aware recursive scan. Returns entries relative to root with '/' separators.
 * Directory symlinks are never followed. Binary detection applies when reading contents.
 */
export function walkWorkspace(rootAbs: string, opts: WalkOptions = {}): ScannedEntry[] {
  const maxDepth = opts.maxDepth ?? 14;
  const maxFiles = opts.maxFiles ?? 20000;
  const results: ScannedEntry[] = [];
  const rootIg = buildIgnoreMatcher(rootAbs);

  function walk(dir: string, depth: number, dirIg: ReturnType<typeof ignore> | null) {
    if (results.length >= maxFiles) return;

    // Per-directory .gitignore support (parent rules still apply)
    let ig = dirIg || rootIg;
    const nestedGitignore = path.join(dir, '.gitignore');
    try {
      if (dir !== rootAbs && fs.existsSync(nestedGitignore)) {
        ig = ignore();
        ig.add((dirIg || rootIg) as any);
        ig.add(fs.readFileSync(nestedGitignore, 'utf-8'));
      }
    } catch {
      ig = dirIg || rootIg;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootAbs, full).replace(/\\/g, '/');
      const relTest = entry.isDirectory() ? `${rel}/` : rel;

      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
      if (ig.ignores(relTest)) continue;

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        results.push({ absPath: full, relPath: rel, isDirectory: true });
        if (depth < maxDepth) walk(full, depth + 1, ig);
      } else if (entry.isFile()) {
        let size: number | undefined;
        let mtimeMs: number | undefined;
        try {
          const st = fs.statSync(full);
          size = st.size;
          mtimeMs = st.mtimeMs;
        } catch {
          /* keep undefined */
        }
        results.push({ absPath: full, relPath: rel, isDirectory: false, size, mtimeMs });
      }
    }
  }

  walk(rootAbs, 0, null);
  return results;
}

export interface ReadResult {
  path: string;
  name: string;
  language: string;
  content: string;
  totalLines: number;
  offset: number;
  limit: number;
  truncated: boolean;
  byteSize: number;
  modifiedAt: string;
  isBinary: boolean;
}

/** Ranged, binary-safe file read. Lines are 0-based offsets. */
export function readFileRange(rootAbs: string, userPath: string, offset = 0, limit = 2000): ReadResult {
  const absPath = resolveSafePath(rootAbs, userPath);
  const stat = fs.statSync(absPath);
  const raw = fs.readFileSync(absPath);

  const base = {
    path: userPath.replace(/\\/g, '/'),
    name: path.basename(absPath),
    language: getLanguageForFile(absPath),
    byteSize: stat.size,
    modifiedAt: new Date(stat.mtimeMs).toISOString(),
    offset,
    limit
  };

  if (looksBinary(raw)) {
    return {
      ...base,
      content: '',
      totalLines: 0,
      truncated: false,
      isBinary: true
    };
  }

  const text = raw.toString('utf-8');
  const lines = text.split('\n');
  const start = Math.max(0, Math.min(offset, lines.length));
  const end = Math.min(lines.length, start + limit);
  const slice = lines.slice(start, end);

  return {
    ...base,
    content: slice.join('\n'),
    totalLines: lines.length,
    truncated: end < lines.length,
    isBinary: false
  };
}

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  truncated: boolean;
  engine: 'ripgrep' | 'js';
  durationMs: number;
}

function jsSearch(
  rootAbs: string,
  query: string,
  glob: string | undefined,
  maxResults: number,
  caseSensitive: boolean
): { hits: SearchHit[]; truncated: boolean } {
  const globRe =
    glob != null && glob !== ''
      ? (() => {
          const src = glob
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*/g, '\u0000')
            .replace(/\*/g, '[^/]*')
            .replace(/\u0000/g, '.*')
            .replace(/\?/g, '.');
          return new RegExp(`(^|/)${src}$`, 'i');
        })()
      : null;
  const needle = caseSensitive ? query : query.toLowerCase();
  const hits: SearchHit[] = [];
  let truncated = false;

  outer: for (const entry of walkWorkspace(rootAbs, { maxDepth: 14 })) {
    if (entry.isDirectory) continue;
    const ext = path.extname(entry.relPath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) continue;
    if (globRe && !globRe.test(entry.relPath)) continue;
    if ((entry.size ?? Infinity) > 1024 * 1024) continue;

    let buf: Buffer;
    try {
      buf = fs.readFileSync(entry.absPath);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;

    const lines = buf.toString('utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
      const col = hay.indexOf(needle);
      if (col !== -1) {
        hits.push({ path: entry.relPath, line: i + 1, column: col + 1, text: lines[i].slice(0, 300) });
        if (hits.length >= maxResults) {
          truncated = true;
          break outer;
        }
      }
    }
  }
  return { hits, truncated };
}

/** Search tool: ripgrep when available, JS fallback otherwise. */
export function searchWorkspace(
  rootAbs: string,
  query: string,
  opts: { glob?: string; maxResults?: number; caseSensitive?: boolean } = {}
): Promise<SearchResult> {
  const started = Date.now();
  const maxResults = Math.min(opts.maxResults ?? 100, 500);
  const globFilter = (rel: string) => {
    if (!opts.glob) return true;
    const src = opts.glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`(^|/)${src}$`, 'i').test(rel);
  };

  return new Promise((resolve) => {
    execFile(
      'rg',
      [
        '--json',
        '--max-count', '50',
        '--max-filesize', '1M',
        '-g', opts.glob || '!*.min.*',
        ...(opts.caseSensitive ? [] : ['-i']),
        '--',
        query,
        '.'
      ],
      { cwd: rootAbs, maxBuffer: 16 * 1024 * 1024, timeout: 15000 },
      (err, stdout) => {
        if (!err && stdout) {
          try {
            const hits: SearchHit[] = [];
            let truncated = false;
            for (const line of stdout.split('\n')) {
              if (!line.trim()) continue;
              const evt = JSON.parse(line);
              if (evt.type === 'match') {
                const d = evt.data;
                const rel = String(d.path.text || '').replace(/\\/g, '/').replace(/^\.\//, '');
                if (!globFilter(rel)) continue;
                hits.push({
                  path: rel,
                  line: d.line_number,
                  column: (d.submatches?.[0]?.start ?? 0) + 1,
                  text: (d.lines.text || '').trimEnd().slice(0, 300)
                });
                if (hits.length >= maxResults) {
                  truncated = true;
                  break;
                }
              }
            }
            resolve({
              query,
              hits,
              truncated,
              engine: 'ripgrep',
              durationMs: Date.now() - started
            });
            return;
          } catch {
            /* fall through to js */
          }
        }
        const js = jsSearch(rootAbs, query, opts.glob, maxResults, !!opts.caseSensitive);
        resolve({
          query,
          ...js,
          engine: 'js',
          durationMs: Date.now() - started
        });
      }
    );
  });
}

export interface OutlineSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'method' | 'variable' | 'def';
  line: number;
}

export interface FileOutline {
  path: string;
  language: string;
  symbols: OutlineSymbol[];
}

/** Regex-based top-level symbol outline (upgradeable to AST later). */
export function extractOutline(filePath: string, content: string): OutlineSymbol[] {
  const lang = getLanguageForFile(filePath);
  const symbols: OutlineSymbol[] = [];
  const lines = content.split('\n');

  const push = (name: string, kind: OutlineSymbol['kind'], line: number) => {
    if (name) symbols.push({ name, kind, line: line + 1 });
  };

  lines.forEach((line, i) => {
    if (lang === 'typescript' || lang === 'javascript') {
      let m = line.match(/(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
      if (m) return push(m[1], 'function', i);
      m = line.match(/(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
      if (m) return push(m[1], 'class', i);
      m = line.match(/(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/);
      if (m) return push(m[1], 'interface', i);
      m = line.match(/(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/);
      if (m) return push(m[1], 'type', i);
      m = line.match(/(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/);
      if (m) return push(m[1], 'enum', i);
      m = line.match(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
      if (m) return push(m[1], 'function', i);
    } else if (lang === 'python') {
      let m = line.match(/^(\s*)def\s+([A-Za-z_]\w*)/);
      if (m) return push(m[2], m[1].length === 0 ? 'def' : 'method', i);
      m = line.match(/^(\s*)class\s+([A-Za-z_]\w*)/);
      if (m) return push(m[2], 'class', i);
    }
  });

  return symbols;
}

export function getOutline(rootAbs: string, userPath: string): FileOutline {
  const absPath = resolveSafePath(rootAbs, userPath);
  const buf = fs.readFileSync(absPath);
  const language = getLanguageForFile(absPath);
  if (looksBinary(buf)) {
    return { path: userPath.replace(/\\/g, '/'), language, symbols: [] };
  }
  return {
    path: userPath.replace(/\\/g, '/'),
    language,
    symbols: extractOutline(absPath, buf.toString('utf-8'))
  };
}

// ---------------- Conflict detection (E5 / P1.5f) ----------------

/** Last-known state for workspace files (recorded on agent reads/writes). */
interface KnownFileState {
  mtimeMs: number;
  size: number;
  /** sha1 of content at record time; null for oversized/unreadable files */
  hash: string | null;
}
const knownStates = new Map<string, KnownFileState>();
/** Files the watcher confirmed were modified outside the agent mid-run. */
const externalChanges = new Set<string>();

const HASH_CAP_BYTES = 2 * 1024 * 1024;

function hashFile(absPath: string): string | null {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > HASH_CAP_BYTES) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createHash } = require('crypto') as typeof import('crypto');
    return createHash('sha1').update(fs.readFileSync(absPath)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Record the agent's view of a file (after a read or an agent write).
 * Clears any pending external-change flag for the file.
 */
export function recordMtime(absPath: string): void {
  const key = path.resolve(absPath);
  try {
    const st = fs.statSync(key);
    knownStates.set(key, { mtimeMs: st.mtimeMs, size: st.size, hash: hashFile(key) });
    externalChanges.delete(key);
  } catch {
    /* file may not exist yet */
  }
}

export interface ConflictInfo {
  conflicted: boolean;
  expectedMtime?: number;
  actualMtime?: number;
}

/**
 * P1.5f: detect external modification since the agent last saw this file.
 * Conflicted when (a) the watcher flagged a real divergence, or (b) the mtime
 * differs AND the content hash differs (hash comparison avoids false positives
 * from touch-only/mtime-granularity changes).
 */
export function checkConflict(absPath: string): ConflictInfo {
  const key = path.resolve(absPath);
  try {
    const actual = fs.statSync(key);
    const known = knownStates.get(key);
    if (!known) return { conflicted: false, actualMtime: actual.mtimeMs };
    if (externalChanges.has(key)) {
      return { conflicted: true, expectedMtime: known.mtimeMs, actualMtime: actual.mtimeMs };
    }
    // Hash-first comparison (authoritative, immune to mtime granularity):
    // only computed for files we could hash at record time (≤2 MB).
    if (known.hash !== null) {
      const currentHash = hashFile(key);
      if (currentHash === null) {
        return { conflicted: false, actualMtime: actual.mtimeMs }; // unreadable — don't guess
      }
      if (currentHash !== known.hash) {
        return { conflicted: true, expectedMtime: known.mtimeMs, actualMtime: actual.mtimeMs };
      }
      // Identical content — refresh metadata quietly, never a conflict
      known.mtimeMs = actual.mtimeMs;
      known.size = actual.size;
      return { conflicted: false, actualMtime: actual.mtimeMs };
    }
    // Hash-less fallback (oversized files): mtime/size signal
    if (Math.abs(actual.mtimeMs - known.mtimeMs) > 1 || actual.size !== known.size) {
      return { conflicted: true, expectedMtime: known.mtimeMs, actualMtime: actual.mtimeMs };
    }
    return { conflicted: false, actualMtime: actual.mtimeMs };
  } catch {
    return { conflicted: false };
  }
}

/**
 * P1.5f: called by the workspace watcher for external 'change' events.
 * Only files the agent has previously seen are tracked; the change is marked
 * only when the on-disk content actually differs from the recorded hash (this
 * filters out the watcher echoes of the agent's OWN writes, which refresh their
 * record at write time).
 */
export function noteExternalChange(absPath: string): void {
  const key = path.resolve(absPath);
  const known = knownStates.get(key);
  if (!known) return; // never seen by the agent — nothing to protect
  try {
    const st = fs.statSync(key);
    const currentHash = hashFile(key);
    if (st.size !== known.size || (known.hash !== null && currentHash !== null && currentHash !== known.hash)) {
      externalChanges.add(key);
    } else if (Math.abs(st.mtimeMs - known.mtimeMs) > 1 && known.hash === null && currentHash === null) {
      externalChanges.add(key); // no hash available — trust size+mtime divergence
    }
  } catch {
    /* vanished — unlink events are handled elsewhere */
  }
}

/** Test/debug helper: is this file currently flagged as externally changed? */
export function isFlaggedExternallyChanged(absPath: string): boolean {
  return externalChanges.has(path.resolve(absPath));
}

export function forgetMtime(absPath: string): void {
  const key = path.resolve(absPath);
  knownStates.delete(key);
  externalChanges.delete(key);
}
