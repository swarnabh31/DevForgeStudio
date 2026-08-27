import fs from 'fs';
import path from 'path';
import { resolveSafePath } from './lib';

export interface BackupRecord {
  dir: string;       // absolute backup dir
  rel: string;       // relative path inside workspace
  savedAt: string;
}

function backupsRoot(rootAbs: string): string {
  return path.join(rootAbs, '.opencode', 'backups');
}

/** Copy a file into the run's backup dir before the agent overwrites it. */
export function backupFileBeforeWrite(
  rootAbs: string,
  absPath: string,
  backupDir: string
): BackupRecord | null {
  try {
    if (!fs.existsSync(absPath)) return null; // new file — nothing to back up

    const rel = path.relative(rootAbs, absPath);
    const dest = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(absPath, dest);
    return { dir: backupDir, rel: rel.replace(/\\/g, '/'), savedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}

/** Create (or reuse) a timestamped backup directory for one agent run. */
export function createBackupDir(rootAbs: string, sessionId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeId = sessionId.replace(/[^\w-]/g, '_').slice(0, 40);
  const dir = path.join(backupsRoot(rootAbs), `${stamp}__${safeId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** List available backups for a workspace, newest first. */
export function listBackups(rootAbs: string): Array<{ dir: string; name: string; createdAt: string }> {
  const rootDir = backupsRoot(rootAbs);
  if (!fs.existsSync(rootDir)) return [];
  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ dir: path.join(rootDir, e.name), name: e.name }))
    .sort((a, b) => b.name.localeCompare(a.name))
    .map((b) => ({
      ...b,
      createdAt: b.name.split('__')[0] || b.name
    }));
}

export interface RevertResult {
  restored: string[];
  missing: string[];
  backupName: string;
}

/**
 * Restore all files from a backup dir into the workspace.
 * If `targetBackupDir` is omitted, the most recent backup is used.
 */
export function revertFromBackup(rootAbs: string, targetBackupDir?: string): RevertResult {
  const backups = listBackups(rootAbs);
  if (!backups.length) throw new Error('No backups available to revert');

  const chosen = targetBackupDir
    ? backups.find((b) => path.resolve(b.dir) === path.resolve(targetBackupDir))
    : backups[0];
  if (!chosen) throw new Error('Specified backup not found');

  // Guard: backup dir must live under our backups root
  resolveSafePath(rootAbs, path.join('.opencode', 'backups', path.basename(chosen.dir)));

  const restored: string[] = [];
  const missing: string[] = [];

  function restoreRecursive(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        restoreRecursive(full);
      } else {
        const rel = path.relative(chosen.dir, full);
        const dest = resolveSafePath(rootAbs, rel); // never escapes root
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(full, dest);
        restored.push(rel.replace(/\\/g, '/'));
      }
    }
  }

  // If the backed-up file no longer exists in the workspace it is recreated;
  // files created after the backup are not deleted (documented behavior).
  void missing;

  restoreRecursive(chosen.dir);
  return { restored, missing, backupName: chosen.name };
}

/** Find the newest backup snapshot containing this file, or null. */
export function findLatestBackupForFile(rootAbs: string, rel: string): string | null {
  const normalized = rel.replace(/\\/g, '/');
  for (const b of listBackups(rootAbs)) {
    if (fs.existsSync(path.join(b.dir, normalized))) return b.dir;
  }
  return null;
}

/** Revert a single file from its most recent backup. Returns false if none exists. */
export function revertFileFromBackup(rootAbs: string, rel: string): { reverted: boolean; backupName?: string } {
  const dir = findLatestBackupForFile(rootAbs, rel);
  if (!dir) return { reverted: false };
  const normalized = rel.replace(/\\/g, '/');
  resolveSafePath(rootAbs, normalized); // guard
  fs.copyFileSync(path.join(dir, normalized), path.join(rootAbs, normalized));
  return { reverted: true, backupName: path.basename(dir) };
}

// ---------------- P2.1: checkpoint timeline ----------------

/** Resolve a backup name to its dir, refusing anything outside the backups root. */
export function resolveCheckpointDir(rootAbs: string, backupName: string): string | null {
  if (!/^[\w.-]+$/.test(backupName)) return null; // name charset guard
  const dir = path.join(backupsRoot(rootAbs), backupName);
  try {
    // Path-escape guard: basename must survive resolution under the root
    resolveSafePath(rootAbs, path.join('.opencode', 'backups', backupName));
  } catch {
    return null;
  }
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? dir : null;
}

export interface CheckpointFile {
  path: string;
  size: number;
}

/** Files captured inside one checkpoint (backup dir), relative paths, sorted. */
export function listCheckpointFiles(rootAbs: string, backupName: string): CheckpointFile[] {
  const dir = resolveCheckpointDir(rootAbs, backupName);
  if (!dir) throw new Error('Checkpoint not found');
  const files: CheckpointFile[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = path.relative(dir, full).replace(/\\/g, '/');
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {}
        files.push({ path: rel, size });
      }
    }
  };
  walk(dir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}
