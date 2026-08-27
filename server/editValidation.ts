import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';

/**
 * P1.5e Edit validation gates.
 *
 * Cheap, fast checks run against the PROPOSED content of every write_file /
 * apply_patch BEFORE it reaches disk. Failures come back as tool errors so the
 * model self-heals instantly instead of failing end-of-run diagnostics.
 *
 * Checks (by file type):
 * - .json          → strict JSON.parse
 * - .js/.mjs/.cjs  → `node --check` (exact syntax check) when node exists
 * - .ts/.tsx/.jsx  → bracket/quote/comment balance scanner (best-effort)
 * - .py            → python -m py_compile when python exists
 * - ts/js/jsx/tsx  → unresolved RELATIVE imports (./x, ../y) must exist on disk
 */

export interface EditValidationResult {
  ok: boolean;
  errors: string[];
}

function err(errors: string | string[]): EditValidationResult {
  return { ok: false, errors: Array.isArray(errors) ? errors : [errors] };
}

const JS_EXT = new Set(['.js', '.mjs', '.cjs']);
const TS_EXT = new Set(['.ts', '.tsx', '.jsx']);

function execCmd(cmd: string, args: string[], cwd: string, timeoutMs = 15000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (e, stdout, stderr) => {
        const code = (e as any)?.code;
        resolve({
          code: typeof code === 'number' ? code : e ? 1 : 0,
          stdout: (stdout || '').toString(),
          stderr: (stderr || '').toString()
        });
      }
    );
  });
}

// ---------------- JSON ----------------

function validateJson(content: string): EditValidationResult {
  try {
    JSON.parse(content);
    return { ok: true, errors: [] };
  } catch (e: any) {
    let where = '';
    const m = String(e?.message || '').match(/position (\d+)/);
    if (m) {
      const line = content.slice(0, parseInt(m[1], 10)).split('\n').length;
      where = ` (line ${line})`;
    }
    return err([`invalid JSON${where}: ${e?.message}`]);
  }
}

// ---------------- JS via node --check ----------------

async function validateWithNode(content: string): Promise<EditValidationResult> {
  const tmp = path.join(os.tmpdir(), `dvcheck-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(tmp, content, 'utf-8');
  try {
    const r = await execCmd(process.execPath.endsWith('node.exe') || process.execPath.includes('node') ? process.execPath : 'node', ['--check', tmp], os.tmpdir());
    if (r.code !== 0) {
      const lines = (r.stderr || '').split('\n').filter((l) => l.trim() && !l.startsWith('node:'));
      return err(lines.slice(0, 6).join('\n') || 'node --check reported a syntax error');
    }
    return { ok: true, errors: [] };
  } catch {
    return { ok: true, errors: [] }; // checker unavailable — never block
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

// ---------------- Bracket / quote / comment scanner (TS/TSX/Jsx fallback) ----------------

interface ScanIssue {
  line: number;
  message: string;
}

export function scanBalance(content: string): ScanIssue[] {
  const issues: ScanIssue[] = [];
  const stack: Array<{ ch: string; line: number }> = [];
  let line = 1;
  type State = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template';
  let state: State = 'code';
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    const next = content[i + 1];
    if (c === '\n') {
      line++;
      // single-quoted strings may not span lines
      if (state === 'single') issues.push({ line: line - 1, message: 'unterminated string literal' });
      if (state === 'single') state = 'code';
      if (state === 'line-comment') state = 'code';
      continue;
    }
    switch (state) {
      case 'line-comment':
        break;
      case 'block-comment':
        if (c === '*' && next === '/') {
          state = 'code';
          i++;
        }
        break;
      case 'single':
        if (c === '\\') i++;
        else if (c === "'") state = 'code';
        break;
      case 'double':
        if (c === '\\') i++;
        else if (c === '"') state = 'code';
        break;
      case 'template':
        if (c === '\\') i++;
        else if (c === '`') state = 'code';
        break;
      case 'code':
        if (c === '/' && next === '/') {
          state = 'line-comment';
          i++;
        } else if (c === '/' && next === '*') {
          state = 'block-comment';
          i++;
        } else if (c === "'") state = 'single';
        else if (c === '"') state = 'double';
        else if (c === '`') state = 'template';
        else if (c === '(' || c === '[' || c === '{') stack.push({ ch: c, line });
        else if (c === ')' || c === ']' || c === '}') {
          const open = stack.pop();
          if (!open) issues.push({ line, message: `unmatched closing '${c}'` });
          else if (open.ch !== pairs[c]) issues.push({ line, message: `'${c}' closes '${open.ch}' opened at line ${open.line}` });
        }
        break;
    }
  }
  if (state === 'block-comment') issues.push({ line, message: 'unterminated block comment' });
  for (const open of stack.slice(0, 5)) {
    issues.push({ line: open.line, message: `unclosed '${open.ch}'` });
  }
  return issues;
}

function validateBalanced(content: string, label: string): EditValidationResult {
  const issues = scanBalance(content);
  if (!issues.length) return { ok: true, errors: [] };
  return err(issues.slice(0, 6).map((i) => `${label} syntax issue at line ${i.line}: ${i.message}`));
}

// ---------------- Relative-import resolution ----------------

const RESOLVE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js'];
const IMPORT_RE = /(?:import\s+(?:[\w*{}\s,]+?\s+from\s+)?|import\s*\(\s*|require\()\s*['"](\.[^'"]+)['"]/g;

function checkRelativeImports(rootAbs: string, relPath: string, content: string): string[] {
  const absDir = path.dirname(path.resolve(rootAbs, relPath));
  const errors: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(content))) {
    const spec = m[1];
    const base = path.resolve(absDir, spec);
    let found = false;
    for (const ext of RESOLVE_EXTS) {
      if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) {
        found = true;
        break;
      }
    }
    if (!found) {
      const line = content.slice(0, m.index).split('\n').length;
      errors.push(`unresolved import '${spec}' at line ${line}`);
      if (errors.length >= 5) break;
    }
  }
  return errors;
}

// ---------------- Entry point ----------------

/**
 * Validate proposed content for a workspace-relative file path before write.
 * Never throws; unknown types pass clean (ok:true).
 */
export async function validateEditedContent(
  rootAbs: string,
  relPath: string,
  newContent: string
): Promise<EditValidationResult> {
  try {
    const ext = path.extname(relPath).toLowerCase();

    if (ext === '.json') return validateJson(newContent);

    if (JS_EXT.has(ext)) {
      const r = await validateWithNode(newContent);
      if (!r.ok) return r;
      const badImports = checkRelativeImports(rootAbs, relPath, newContent);
      return badImports.length ? err(badImports) : { ok: true, errors: [] };
    }

    if (TS_EXT.has(ext)) {
      const r = validateBalanced(newContent, path.basename(relPath));
      if (!r.ok) return r;
      const badImports = checkRelativeImports(rootAbs, relPath, newContent);
      return badImports.length ? err(badImports) : { ok: true, errors: [] };
    }

    if (ext === '.py') {
      // python -m py_compile needs a real file
      const tmp = path.join(os.tmpdir(), `dvcheck-${Date.now()}.py`);
      fs.writeFileSync(tmp, newContent, 'utf-8');
      try {
        const r = await execCmd('python', ['-m', 'py_compile', tmp], os.tmpdir(), 15000);
        if (r.code !== 0 && !/not recognized|not found/i.test(r.stderr)) {
          return err((r.stderr || 'python compile error').split('\n').filter(Boolean).slice(-6).join('\n'));
        }
      } catch {
        /* python unavailable — skip */
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {}
      }
      return { ok: true, errors: [] };
    }

    return { ok: true, errors: [] }; // unsupported type — gate passes
  } catch {
    return { ok: true, errors: [] }; // validation must never crash the loop
  }
}
