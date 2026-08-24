import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';

export interface RealDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  code: string;
  message: string;
  source: string;
}

function execCmd(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 60000
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = (err as any)?.code;
        resolve({
          stdout: (stdout || '').slice(0, 200000),
          stderr: (stderr || '').slice(0, 100000),
          code: typeof code === 'number' ? code : err ? 1 : 0
        });
      }
    );
  });
}

/** Parse `file(line,col): error TS1234: msg` and `file:line:col: msg` styles. */
export function parseCompilerOutput(
  output: string,
  source: string,
  severityForCode?: (code: string) => 'error' | 'warning'
): RealDiagnostic[] {
  const diags: RealDiagnostic[] = [];
  for (const line of output.split('\n')) {
    // TypeScript style: src/app.ts(12,5): error TS2304: Cannot find name 'x'.
    let m = line.match(/^\s*(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(\S+):\s*(.+)$/);
    if (m) {
      const code = m[5];
      diags.push({
        file: m[1].replace(/\\/g, '/'),
        line: parseInt(m[2], 10),
        column: parseInt(m[3], 10),
        severity: severityForCode ? severityForCode(code) : (m[4] as 'error' | 'warning'),
        code,
        message: m[6].trim(),
        source
      });
      continue;
    }
    // Python/ruff style: path:line:col: CODE message
    m = line.match(/^\s*(.+?):(\d+):(\d+):\s*(\S+)\s+(.+)$/);
    if (m && !line.includes('node_modules')) {
      const code = m[4];
      const isWarning = /^(W|E501|warning)/.test(code) === false && /^W/.test(code);
      diags.push({
        file: m[1].replace(/\\/g, '/'),
        line: parseInt(m[2], 10),
        column: parseInt(m[3], 10),
        severity: isWarning ? 'warning' : 'error',
        code,
        message: m[5].trim(),
        source
      });
    }
  }
  return diags;
}

let tscCache: { at: number; root: string; diags: RealDiagnostic[] } | null = null;

/**
 * Run real TypeScript diagnostics via `tsc --noEmit` in the workspace.
 * Cached for 10 seconds to avoid hammering on every edit.
 */
export async function runTscDiagnostics(rootAbs: string, force = false): Promise<RealDiagnostic[]> {
  if (
    !force &&
    tscCache &&
    tscCache.root === rootAbs &&
    Date.now() - tscCache.at < 10000
  ) {
    return tscCache.diags;
  }

  const hasTsconfig = fs.existsSync(path.join(rootAbs, 'tsconfig.json'));
  if (!hasTsconfig) {
    return [];
  }

  const tscBin = path.join(rootAbs, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.CMD' : 'tsc');
  const useLocal = fs.existsSync(tscBin);
  const result = await execCmd(
    useLocal ? tscBin : 'npx',
    useLocal ? ['--noEmit', '--pretty', 'false'] : ['--yes', 'tsc', '--noEmit', '--pretty', 'false'],
    rootAbs,
    90000
  );

  const diags = parseCompilerOutput(result.stdout + '\n' + result.stderr, 'tsc');
  tscCache = { at: Date.now(), root: rootAbs, diags };
  return diags;
}

/** Python checks: ruff if installed, otherwise py_compile syntax check. */
export async function runPythonDiagnostics(rootAbs: string): Promise<RealDiagnostic[]> {
  const ruff = await execCmd('ruff', ['check', '.', '--output-format=concise'], rootAbs, 30000);
  if (!(ruff.stderr.includes('not recognized') || ruff.stderr.includes('not found') || ruff.code === 127)) {
    return parseCompilerOutput(ruff.stdout + '\n' + ruff.stderr, 'ruff');
  }
  return [];
}

/** Run all applicable diagnostics for a workspace. */
export async function runRealDiagnostics(rootAbs: string, opts: { python?: boolean } = {}): Promise<{
  diagnostics: RealDiagnostic[];
  ranTools: string[];
}> {
  const jobs: Array<Promise<{ tool: string; diags: RealDiagnostic[] }>> = [
    runTscDiagnostics(rootAbs).then((diags) => ({ tool: 'tsc --noEmit', diags }))
  ];
  if (opts.python !== false) {
    jobs.push(runPythonDiagnostics(rootAbs).then((diags) => ({ tool: 'ruff', diags })));
  }

  const settled = await Promise.all(jobs);
  const ranTools = settled.filter((s) => s.diags.length > 0 || s.tool === 'tsc --noEmit').map((s) => s.tool);
  return {
    diagnostics: settled.flatMap((s) => s.diags),
    ranTools
  };
}

// ---------------- A4: Import graph ----------------

const IMPORT_RE = /(?:import\s+(?:[\w*{}\s,]+?\s+from\s+)?|require\()\s*['"]([^'"]+)['"]/g;
const PY_IMPORT_RE = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.,\s]+))/gm;

export interface ImportEdge {
  from: string;
  to: string;
}

/** Resolve a module specifier to a workspace-relative file, best-effort. */
function resolveSpecifier(fromRel: string, spec: string, allFiles: Set<string>): string | null {
  if (!spec.startsWith('.') && !spec.startsWith('/')) {
    // Try tsconfig-style "@app/..." aliases? Keep simple: skip bare specifiers
    // unless they match an existing file exactly.
    const direct = spec.replace(/^\/+/, '');
    for (const ext of ['', '.ts', '.tsx', '.js', '.py']) {
      if (allFiles.has(direct + ext)) return direct + ext;
    }
    return null;
  }
  const baseDir = path.posix.dirname(fromRel);
  let resolved = path.posix.normalize(path.posix.join(baseDir === '.' ? '' : baseDir, spec));
  for (const ext of ['', '.ts', '.tsx', '.js', '.json', '.py', '/index.ts', '/index.js']) {
    if (allFiles.has(resolved + ext)) return resolved + ext;
  }
  return null;
}

export interface ImportGraphResult {
  dependenciesOf: string[];
  importedBy: string[];
  edges: ImportEdge[];
}

/**
 * What breaks if I change X? Returns files X imports (dependencies) and files
 * importing X (reverse deps / blast radius).
 */
export function buildImportGraph(rootAbs: string, targetRel: string): ImportGraphResult {
  const allFiles = new Set<string>();
  const sizes = new Map<string, number>();

  // Phase 1: collect candidate files (capped so huge repos can't hang requests)
  const MAX_FILES = 3000;
  const MAX_FILE_BYTES = 512 * 1024;
  const walk = (dir: string, depth: number) => {
    if (depth > 10 || allFiles.size >= MAX_FILES) return;
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (allFiles.size >= MAX_FILES) return;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(rootAbs, full).replace(/\\/g, '/');
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(ts|tsx|js|jsx|py)$/.test(e.name)) {
        try {
          const sz = fs.statSync(full).size;
          if (sz <= MAX_FILE_BYTES) {
            allFiles.add(rel);
            sizes.set(rel, sz);
          }
        } catch { /* unreadable */ }
      }
    }
  };
  walk(rootAbs, 0);

  const edges: ImportEdge[] = [];
  const byFile = new Map<string, string[]>(); // file -> specs

  for (const rel of allFiles) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(rootAbs, rel), 'utf-8');
    } catch {
      continue;
    }
    void sizes;
    const specs: string[] = [];

    if (rel.endsWith('.py')) {
      let m: RegExpExecArray | null;
      const re = new RegExp(PY_IMPORT_RE.source, 'gm');
      while ((m = re.exec(content))) {
        const mod = m[1] || m[2];
        if (!mod) continue;
        for (const part of mod.split(',')) {
          const clean = part.trim().split(/\s+as\s+/)[0].trim();
          if (clean) specs.push(clean.replace(/\./g, '/'));
        }
      }
    } else {
      let m: RegExpExecArray | null;
      IMPORT_RE.lastIndex = 0;
      while ((m = IMPORT_RE.exec(content))) specs.push(m[1]);
    }

    const deps = specs
      .map((s) => resolveSpecifier(rel, s, allFiles))
      .filter((x): x is string => x !== null && x !== rel);
    byFile.set(rel, deps);
    for (const d of deps) edges.push({ from: rel, to: d });
  }

  const normalizedTarget = targetRel.replace(/\\/g, '/');
  const dependenciesOf = edges.filter((e) => e.from === normalizedTarget).map((e) => e.to);
  const importedBy = edges.filter((e) => e.to === normalizedTarget).map((e) => e.from);

  return { dependenciesOf, importedBy, edges };
}
