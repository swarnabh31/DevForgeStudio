import { LSPServerStatus, PrerequisiteStatus, WorkspaceFile } from '../types';

/**
 * Sessions start with an EMPTY workspace. Real files enter via
 * "Load Folder" (/api/workspace/load-directory) or the agent's own tools —
 * never from pre-seeded demo content.
 */
export const DEFAULT_WORKSPACE_FILES: Record<string, WorkspaceFile> = {};

/**
 * The app does not embed language servers. Diagnostics come from real
 * toolchain invocations (tsc --noEmit / ruff check) managed by
 * server/diagnostics.ts. These entries describe those real runners.
 */
export const INITIAL_LSP_SERVERS: LSPServerStatus[] = [
  {
    id: 'tsc-runner',
    name: 'TypeScript Compiler (tsc --noEmit)',
    language: 'TypeScript / JS',
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
    status: 'idle',
    activeDiagnosticsCount: 0,
    version: 'local toolchain'
  },
  {
    id: 'ruff-runner',
    name: 'Ruff (Python linter)',
    language: 'Python',
    extensions: ['.py'],
    status: 'idle',
    activeDiagnosticsCount: 0,
    version: 'local toolchain'
  }
];

/**
 * Nothing is "pre-installed" by magic. Prerequisites are Node.js and a local
 * model server (Ollama/LM Studio) — surfaced honestly in the first-run guide.
 */
export const INITIAL_PREREQUISITES: PrerequisiteStatus[] = [];
