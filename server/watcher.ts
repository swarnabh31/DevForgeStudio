import fs from 'fs';
import path from 'path';

/**
 * Watches a workspace root for external file changes and notifies via callback
 * so in-memory caches can be invalidated. One watcher per root (deduped).
 */

const watchers = new Map<string, fs.FSWatcher>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.opencode', 'dist', 'build', 'coverage',
  '.next', '.cache', '__pycache__', '.venv', 'venv'
]);
const IGNORED_SUFFIXES = ['.log'];

function shouldIgnore(absPath: string): boolean {
  const parts = absPath.split(path.sep);
  if (parts.some((p) => IGNORED_DIRS.has(p))) return true;
  if (IGNORED_SUFFIXES.some((s) => absPath.endsWith(s))) return true;
  return false;
}

/**
 * Start (or restart) watching a workspace root. Only one watcher per root is
 * kept; events are debounced 300ms per file path.
 */
export function watchWorkspace(
  rootAbs: string,
  onChange: (absPath: string, event: 'change' | 'unlink') => void
): void {
  unwatchWorkspace(rootAbs);
  try {
    const watcher = fs.watch(rootAbs, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const absPath = path.join(rootAbs, String(filename));
      if (shouldIgnore(absPath)) return;
      const existing = pending.get(absPath);
      if (existing) clearTimeout(existing);
      // Coalesce rapid edit bursts into one event per path
      pending.set(
        absPath,
        setTimeout(() => {
          pending.delete(absPath);
          try {
            const exists = fs.existsSync(absPath) && fs.statSync(absPath).isFile();
            if (exists && eventType === 'change') onChange(absPath, 'change');
            else if (!exists) onChange(absPath, 'unlink');
          } catch {
            /* vanished mid-debounce — ignore */
          }
        }, 300)
      );
    });
    watcher.on('error', () => {
      /* e.g. root deleted — stop silently; conflict detection still guards writes */
      unwatchWorkspace(rootAbs);
    });
    watchers.set(rootAbs, watcher);
  } catch {
    /* recursive watching unsupported on this FS — non-fatal */
  }
}

export function unwatchWorkspace(rootAbs: string): void {
  const w = watchers.get(rootAbs);
  if (w) {
    w.close();
    watchers.delete(rootAbs);
  }
}
