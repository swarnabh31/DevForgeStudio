import fs from 'fs';
import path from 'path';
import { createTwoFilesPatch } from 'diff';
import { listBackups, resolveCheckpointDir } from './backups';

export interface FilePatch {
  filePath: string;
  patch: string;
  additions: number;
  deletions: number;
}

function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

/**
 * U3: build a real unified diff for each changed file by comparing the most
 * recent backup snapshot against current disk content.
 */
export function computeDiffsForFiles(rootAbs: string, filesChanged: string[]): FilePatch[] {
  if (!filesChanged.length) return [];
  const backups = listBackups(rootAbs);

  const patches: FilePatch[] = [];
  for (const rel of filesChanged) {
    const normalized = rel.replace(/\\/g, '/');
    const abs = path.join(rootAbs, normalized);
    let newContent = '';
    try {
      newContent = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }

    // Find newest backup that contains this file
    let oldContent = '';
    for (const b of backups) {
      const candidate = path.join(b.dir, normalized);
      if (fs.existsSync(candidate)) {
        oldContent = fs.readFileSync(candidate, 'utf-8');
        break;
      }
    }

    const patch = createTwoFilesPatch(
      `a/${normalized}`,
      `b/${normalized}`,
      oldContent,
      newContent,
      'before agent',
      'after agent',
      { context: 3 }
    );
    const { additions, deletions } = countPatchLines(patch);
    patches.push({ filePath: normalized, patch, additions, deletions });
  }
  return patches;
}

/**
 * P2.1: unified diff of every file captured in ONE checkpoint (backup dir)
 * against the current disk content. Files deleted since the checkpoint show as
 * a full deletion (new side = empty).
 */
export function computeCheckpointDiffs(rootAbs: string, backupName: string): FilePatch[] {
  const dir = resolveCheckpointDir(rootAbs, backupName);
  if (!dir) throw new Error('Checkpoint not found');

  const patches: FilePatch[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(d, entry.name));
        continue;
      }
      const rel = path.relative(dir, path.join(d, entry.name)).replace(/\\/g, '/');
      let oldContent = '';
      try {
        oldContent = fs.readFileSync(path.join(dir, rel), 'utf-8');
      } catch {
        continue;
      }
      let newContent = '';
      try {
        newContent = fs.readFileSync(path.join(rootAbs, rel), 'utf-8');
      } catch {
        // missing on disk — keep '' so the diff renders as a deletion
      }
      const patch = createTwoFilesPatch(
        `a/${rel}`,
        `b/${rel}`,
        oldContent,
        newContent,
        'checkpoint',
        'current disk',
        { context: 3 }
      );
      const { additions, deletions } = countPatchLines(patch);
      patches.push({ filePath: rel, patch, additions, deletions });
    }
  };
  walk(dir);
  patches.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return patches;
}
