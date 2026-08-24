import path from 'path';

export const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.cache',
  'coverage',
  '.vite',
  '.next',
  '.idea',
  '.vscode'
]);

export const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'css',
  '.sass': 'css',
  '.less': 'css',
  '.html': 'html',
  '.py': 'python',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.sql': 'sql',
  '.sh': 'bash',
  '.bash': 'bash',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'cpp',
  '.cpp': 'cpp',
  '.h': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.rb': 'ruby',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.xml': 'xml',
  '.svg': 'xml',
  '.graphql': 'graphql',
  '.prisma': 'prisma',
  '.astro': 'html',
  '.txt': 'plaintext',
  '.env': 'plaintext',
  '.gitignore': 'plaintext',
  '.toml': 'plaintext'
};

export function getLanguageForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_MAP[ext] || 'plaintext';
}

export class PathTraversalError extends Error {
  constructor(userPath: string) {
    super(`Path escapes workspace root: ${userPath}`);
    this.name = 'PathTraversalError';
  }
}

/**
 * Resolve a client/model-supplied path against a trusted workspace root and
 * guarantee the result stays inside the root. Accepts absolute paths that are
 * already inside the root, or relative paths.
 *
 * @throws PathTraversalError when the resolved path escapes the root.
 */
export function resolveSafePath(rootAbsPath: string, userPath: string): string {
  if (!rootAbsPath || !path.isAbsolute(rootAbsPath)) {
    throw new Error('Workspace root must be an absolute path');
  }
  if (typeof userPath !== 'string' || userPath.trim() === '') {
    throw new PathTraversalError(String(userPath));
  }

  // Neutralize common traversal tricks before resolving
  const cleaned = userPath.replace(/\0/g, '').trim();
  if (cleaned !== userPath.trim() || cleaned.includes('\0')) {
    throw new PathTraversalError(userPath);
  }

  const resolvedRoot = path.resolve(rootAbsPath);
  const candidate = path.isAbsolute(cleaned)
    ? path.resolve(cleaned)
    : path.resolve(resolvedRoot, cleaned);

  const rel = path.relative(resolvedRoot, candidate);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathTraversalError(userPath);
  }
  return candidate;
}
