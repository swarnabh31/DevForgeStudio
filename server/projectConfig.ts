import fs from 'fs';
import path from 'path';

/**
 * P2.4 Project rules: `.devforge.json` in the workspace root + AGENTS.md-style
 * instruction files. Gives per-project control over agent behavior:
 * project instructions, default write policy, verify commands, ignore globs.
 */

export type ProjectWritePolicy = 'ask' | 'allow' | 'deny' | 'review';

export interface ProjectConfig {
  /** Free-form project instructions injected into the system prompt. */
  instructions?: string;
  /** Default write policy for runs in this workspace. */
  writePolicy?: ProjectWritePolicy;
  /** Extra verify commands run by the auto-verify loop (before detected ones). */
  verifyCommands?: string[];
  /** Glob patterns the agent should ignore (list_files/search/index). */
  ignoreGlobs?: string[];
  /** P5.3: user-defined plugin tools (command-based, run in workspace root). */
  tools?: PluginToolSpec[];
}

/** P5.3: declarative custom tool — a shell command with {{arg}} placeholders. */
export interface PluginToolSpec {
  /** Tool name exposed to the model (snake_case, 1-40 chars) */
  name: string;
  description?: string;
  /** Declared arguments; each becomes an {{arg}} placeholder in `command`. */
  parameters?: Record<string, { type?: 'string' | 'number' | 'boolean'; description?: string }>;
  /** Shell command run in the workspace root. Supports {{arg}} tokens and {{__json}}. */
  command: string;
}

export const PROJECT_CONFIG_FILE = '.devforge.json';
/** AGENTS.md-style instruction files, checked in order. */
export const INSTRUCTION_FILES = ['AGENTS.md', 'AGENTS.instructions.md'];

const CONFIG_CACHE_TTL_MS = 5000;
const configCache = new Map<string, { at: number; config: ProjectConfig }>();

const MAX_INSTRUCTIONS_CHARS = 8000;
const MAX_VERIFY_COMMANDS = 10;
const MAX_IGNORE_GLOBS = 100;
const MAX_PLUGIN_TOOLS = 12;
const MAX_PLUGIN_ARGS = 8;
const MAX_PLUGIN_COMMAND = 500;

function sanitizeConfig(raw: unknown): ProjectConfig {
  if (!raw || typeof raw !== 'object') return {};
  const c = raw as Record<string, any>;
  const out: ProjectConfig = {};

  if (typeof c.instructions === 'string' && c.instructions.trim()) {
    out.instructions = c.instructions.trim().slice(0, MAX_INSTRUCTIONS_CHARS);
  }
  if (['ask', 'allow', 'deny', 'review'].includes(c.writePolicy)) {
    out.writePolicy = c.writePolicy as ProjectWritePolicy;
  }
  if (Array.isArray(c.verifyCommands)) {
    out.verifyCommands = c.verifyCommands
      .filter((v: unknown): v is string => typeof v === 'string' && !!v.trim())
      .map((v: string) => v.trim().slice(0, 300))
      .slice(0, MAX_VERIFY_COMMANDS);
  }
  if (Array.isArray(c.ignoreGlobs)) {
    out.ignoreGlobs = c.ignoreGlobs
      .filter((v: unknown): v is string => typeof v === 'string' && !!v.trim() && !v.includes('..'))
      .map((v: string) => v.trim())
      .slice(0, MAX_IGNORE_GLOBS);
  }
  if (Array.isArray(c.tools)) {
    out.tools = c.tools
      .filter(
        (t: any): t is PluginToolSpec =>
          !!t && typeof t === 'object' &&
          typeof t.name === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(t.name) &&
          typeof t.command === 'string' && !!t.command.trim()
      )
      .slice(0, MAX_PLUGIN_TOOLS)
      .map((t: any) => ({
        name: t.name,
        ...(typeof t.description === 'string' && t.description.trim()
          ? { description: t.description.trim().slice(0, 300) }
          : {}),
        ...(t.parameters && typeof t.parameters === 'object' && !Array.isArray(t.parameters)
          ? {
              parameters: Object.fromEntries(
                Object.entries(t.parameters as Record<string, any>)
                  .filter(([k, v]) => /^[a-zA-Z_][\w]{0,30}$/.test(k) && !!v && typeof v === 'object')
                  .slice(0, MAX_PLUGIN_ARGS)
                  .map(([k, v]) => [
                    k,
                    {
                      type: ['string', 'number', 'boolean'].includes(v.type) ? v.type : 'string',
                      ...(typeof v.description === 'string' ? { description: v.description.slice(0, 200) } : {})
                    }
                  ])
              )
            }
          : {}),
        command: t.command.trim().slice(0, MAX_PLUGIN_COMMAND)
      }));
    // de-duplicate by name (first wins)
    const seen = new Set<string>();
    out.tools = out.tools.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
  }
  return out;
}

/** Load `.devforge.json` from the workspace root. {} when missing/corrupt. Cached (5 s TTL). */
export function loadProjectConfig(root: string): ProjectConfig {
  try {
    const file = path.join(root, PROJECT_CONFIG_FILE);
    const cached = configCache.get(file);
    const mtime = fs.existsSync(file) ? fs.statSync(file).mtimeMs : -1;
    if (cached && cached.at === mtime) return cached.config;
    const config = sanitizeConfig(JSON.parse(fs.readFileSync(file, 'utf-8')));
    configCache.set(file, { at: mtime, config });
    return config;
  } catch {
    return {};
  }
}

/** Atomic-save `.devforge.json` into the workspace root. Throws on invalid input paths only. */
export function saveProjectConfig(root: string, config: ProjectConfig): ProjectConfig {
  const clean = sanitizeConfig(config);
  const file = path.join(root, PROJECT_CONFIG_FILE);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
  configCache.delete(file);
  return clean;
}

/**
 * Collect project instructions: `.devforge.json` `instructions` first,
 * then AGENTS.md-style files in workspace root. Concatenated, capped.
 */
export function loadProjectInstructions(root: string): string {
  const parts: string[] = [];
  const cfg = loadProjectConfig(root);
  if (cfg.instructions) parts.push(cfg.instructions);
  for (const name of INSTRUCTION_FILES) {
    try {
      const text = fs.readFileSync(path.join(root, name), 'utf-8').trim();
      if (text) parts.push(`(from ${name})\n${text.slice(0, MAX_INSTRUCTIONS_CHARS)}`);
      break; // first existing AGENTS.md-style file wins
    } catch {
      /* not present */
    }
  }
  const joined = parts.join('\n\n');
  return joined.length > MAX_INSTRUCTIONS_CHARS * 2 ? joined.slice(0, MAX_INSTRUCTIONS_CHARS * 2) + '\n…[truncated]' : joined;
}
