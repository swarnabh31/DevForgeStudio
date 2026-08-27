import fs from 'fs';
import path from 'path';
import { walkWorkspace, extractOutline, looksBinary, TEXT_EXTENSIONS } from './fsTools';
import { loadProjectConfig } from './projectConfig';

/**
 * P3.2 Smarter workspace map — aider-style repo-map ranking within a strict
 * char budget. Files are scored by:
 *   • recency      — recently modified files matter more (mtime decay)
 *   • fan-in       — how many other files import them (dependency importance)
 *   • symbols      — outline-bearing code files beat flat scripts
 * The highest-ranked files (with their top-level symbols) fill the map until
 * the character budget is exhausted, so the model sees the IMPORTANT part of
 * a big repo instead of the first N entries alphabetically.
 */

const MAX_MAP_FILES = 400;
const MAX_DEP_SCAN_FILES = 300;
const MAX_IMPORTS_PER_FILE = 40;
const RECENCY_HALF_LIFE_DAYS = 14;

export interface RepoMapEntry {
  relPath: string;
  score: number;
  symbols: string[];
  fanIn: number;
  ageDays: number | null;
}

/** Extract relative-import specifiers from ts/js/python source (best-effort). */
export function extractRelativeImports(relPath: string, content: string): string[] {
  const specs: string[] = [];
  const re = /(?:from\s+|require\(\s*|import\s+)['"](\.[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) && specs.length < MAX_IMPORTS_PER_FILE) {
    specs.push(m[1]);
  }
  if (relPath.endsWith('.py')) {
    // same-directory python imports: `from . import x` / `from .mod import y`
    const pyRel = /(?:from\s+)\.([\w.]*)\s+import/g;
    while ((m = pyRel.exec(content)) && specs.length < MAX_IMPORTS_PER_FILE) {
      specs.push('./' + (m[1] || ''));
    }
  }
  return specs;
}

/** Resolve `./x` / `../y` specifier against the importing file's directory,
 * trying explicit extensions and index files (TS/JS style resolution). */
function resolveSpecifier(importerRel: string, spec: string, knownFiles: Set<string>): string | null {
  const baseDir = path.posix.dirname(importerRel);
  const joined = path.posix.normalize(path.posix.join(baseDir, spec)).replace(/^\.\//, '');
  const candidates = [
    joined,
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map((ext) => joined + ext),
    ...['/index.ts', '/index.js', '/index.tsx'].map((suf) => joined + suf)
  ];
  for (const c of candidates) if (knownFiles.has(c)) return c;
  return null;
}

interface FileMeta {
  relPath: string;
  mtimeMs: number;
  content: string;
  imports: string[]; // resolved target paths
}

function scanFiles(rootAbs: string): Map<string, FileMeta> {
  const globs = loadProjectConfig(rootAbs).ignoreGlobs;
  const entries = walkWorkspace(rootAbs, { maxDepth: 12, maxFiles: MAX_MAP_FILES + 500 }).filter(
    (e) =>
      !e.isDirectory &&
      TEXT_EXTENSIONS.has(path.extname(e.relPath).toLowerCase()) &&
      !(globs || []).some((g) => e.relPath.startsWith(g.replace(/\*.*$/, '')))
  );

  const knownFiles = new Set(entries.map((e) => e.relPath));
  const files = new Map<string, FileMeta>();
  for (const entry of entries.slice(0, MAX_DEP_SCAN_FILES)) {
    try {
      let st = { mtimeMs: entry.mtimeMs ?? 0 };
      if (!st.mtimeMs) st = { mtimeMs: fs.statSync(entry.absPath).mtimeMs };
      const buf = fs.readFileSync(entry.absPath);
      if (looksBinary(buf)) continue;
      const content = buf.toString('utf-8');
      const imports = extractRelativeImports(entry.relPath, content)
        .map((s) => resolveSpecifier(entry.relPath, s, knownFiles))
        .filter((p): p is string => !!p);
      files.set(entry.relPath, { relPath: entry.relPath, mtimeMs: st.mtimeMs, content, imports });
    } catch {
      /* unreadable file — skip */
    }
  }
  return files;
}

/**
 * Build the ranked repo map. Returns rendered lines (no header) that fit in
 * `maxChars`, highest-scored first.
 */
export function buildRepoMap(rootAbs: string, maxChars = 7000): { text: string; entries: RepoMapEntry[]; scanned: number } {
  const now = Date.now();
  const files = scanFiles(rootAbs);

  // Dependency fan-in (only edges between scanned files count)
  const fanIn = new Map<string, number>();
  for (const f of files.values()) {
    for (const target of f.imports) {
      if (files.has(target)) fanIn.set(target, (fanIn.get(target) || 0) + 1);
    }
  }
  const maxFanIn = Math.max(1, ...fanIn.values());

  const entries: RepoMapEntry[] = [];
  for (const f of files.values()) {
    let symbols: RepoMapEntry['symbols'] = [];
    try {
      symbols = extractOutline(f.relPath, f.content).slice(0, 8).map((s) => `${s.kind} ${s.name}`);
    } catch {}

    const ageDays = f.mtimeMs > 0 ? (now - f.mtimeMs) / 86_400_000 : null;
    const recency =
      ageDays === null ? 0.2 : Math.pow(0.5, Math.min(ageDays, 365) / RECENCY_HALF_LIFE_DAYS); // 1 → ~0
    const dep = (fanIn.get(f.relPath) || 0) / maxFanIn;
    const sym = symbols.length ? 0.3 : 0;

    entries.push({
      relPath: f.relPath,
      score: Number((0.45 * recency + 0.35 * dep + sym).toFixed(4)),
      symbols,
      fanIn: fanIn.get(f.relPath) || 0,
      ageDays
    });
  }

  entries.sort((a, b) => b.score - a.score);

  const lines: string[] = [];
  let used = 0;
  for (const e of entries.slice(0, MAX_MAP_FILES)) {
    const line = `- ${e.relPath}${e.symbols.length ? ` (${e.symbols.join(', ')})` : ''}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }

  return { text: lines.join('\n'), entries, scanned: files.size };
}
