import fs from 'fs';
import path from 'path';
import { exec, spawn, type ChildProcess } from 'child_process';
import {
  walkWorkspace,
  readFileRange,
  searchWorkspace,
  getOutline,
  looksBinary,
  extractOutline,
  TEXT_EXTENSIONS,
  recordMtime,
  checkConflict
} from './fsTools';
import { getLanguageForFile, resolveSafePath, PathTraversalError } from './lib';
import { backupFileBeforeWrite, createBackupDir } from './backups';
import { applyUnifiedDiff, fuzzyReplace, PatchResult } from './patchEngine';
import {
  applyUpdate,
  loadLedger,
  upsertLedgerBlock,
  renderLedgerBlock,
  renderLedgerHelp,
  recordFileTouched
} from './taskLedger';
import { classifyToolFailure, classifyLlmError } from './errorTaxonomy';
import {
  runVerification,
  renderVerificationFailure,
  type VerifyCommand,
  type VerifyResult
} from './verify';
import {
  estimateMessagesTokens,
  compactWithSummary
} from './compaction';

// ---------------- Types ----------------

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  callId: string;
  name: string;
  ok: boolean;
  content: string;
}

export interface ExecuteToolOptions {
  signal?: AbortSignal;
  /**
   * P7.1: per-call execution budget in ms. When omitted, per-tool defaults
   * apply (see DEFAULT_TOOL_TIMEOUT_MS / SUBAGENT_TOOL_BUDGET_MS).
   */
  timeoutMs?: number;
  /** Directory where pre-edit snapshots are stored (Phase 3 safety net). */
  backupDir?: string;
  /**
   * Post-edit verification: return a human-readable diagnostics summary for the
   * changed file (empty string = clean). Appended to the tool result so the
   * model can self-correct.
   */
  verifyEdit?: (relPath: string) => string;
  /**
   * P1.5e edit validation gate: called with the PROPOSED content before
   * write_file/apply_patch reaches disk. Return a human-readable error string
   * to reject the write (fed back as a tool error for instant self-heal), or
   * null to allow it.
   */
  validateEdit?: (relPath: string, newContent: string) => Promise<string | null>;
  /** P1.3 structured planning: receives every update_plan submission */
  onPlanUpdate?: (steps: Array<{ text: string; status: 'pending' | 'in_progress' | 'completed' }>) => void;
  /** P1.5a: durable task ledger run id — enables the `update_task` tool */
  runId?: string;
  /**
   * P3.1 semantic code retrieval: when provided, enables the `semantic_search`
   * tool. Receives the query, returns a rendered tool-result body.
   */
  semanticSearch?: (query: string, k?: number) => Promise<string>;
  /** P3.3: enables the `delegate_research` tool (read-only explore subagent). */
  runSubagent?: (question: string) => Promise<string>;
  /**
   * P7.4 item 1: enables the `recall` tool — look up scoped long-term memories
   * for the current workspace. Returns a rendered tool-result body.
   */
  queryMemories?: (query: string, k?: number) => Promise<string>;
  /**
   * P7.4 item 1: enables the `remember` tool — persist a durable fact/convention
   * into scoped long-term memory. Returns { ok, error? }.
   */
  remember?: (args: {
    category: string;
    key: string;
    value: string;
    tags?: string[];
    scope?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  /** P5.3: user-defined plugin tools (see server/pluginTools.ts) */
  pluginTools?: PluginRuntimeTool[];
}

/** P5.3: a runtime-registered custom tool (schema + executor). */
export interface PluginRuntimeTool {
  name: string;
  schema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
}

export type LoopEvent =
  | { type: 'iteration'; index: number }
  | { type: 'token'; delta: string }
  | { type: 'tool_call'; name: string; arguments: Record<string, any> }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'permission_request'; runId: string; toolName: string; summary: string }
  | { type: 'files_changed'; files: string[] }
  | { type: 'plan'; items: string[] }
  | { type: 'verify_start'; commands: string[] }
  | { type: 'verify_result'; ok: boolean; results: Array<{ command: string; ok: boolean; exitCode: number; durationMs: number }> }
  | { type: 'verify_heal'; attempt: number; maxAttempts: number }
  | { type: 'context_usage'; usedTokens: number; budgetTokens: number }
  | { type: 'context_compacted'; turnsDigested: number }
  | {
      type: 'plan_update';
      steps: Array<{ text: string; status: 'pending' | 'in_progress' | 'completed' }>;
    }
  | {
      type: 'iteration_end';
      index: number;
      durationMs: number;
      /** P3.4 prompt-caching observability (Ollama stats; undefined when unknown) */
      promptEvalMs?: number;
      promptEvalTokens?: number;
      evalMs?: number;
      evalTokens?: number;
    }

export interface LoopMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface AgentLoopOptions {
  root: string;
  prompt: string;
  modelId: string;
  endpoints: string[];
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemContext: string; // rules + memory + workspace index (pre-built by caller)
  maxIterations?: number;
  signal?: AbortSignal;
  /**
   * P7.1: default per-tool-call execution budget in ms (override per call via
   * ExecuteToolOptions.timeoutMs). Omitted means built-in per-tool defaults.
   */
  toolTimeoutMs?: number;
  sampling?: { temperature: number; topP: number; repeatPenalty: number; numCtxTokens: number };
  /** 'none' appends the qwen3 /no_think soft switch and strips <think> blocks */
  thinkingLevel?: 'none' | 'low' | 'medium' | 'high';
  /** Used only to name the run's backup directory */
  sessionId?: string;
  /** E3 post-edit verification hook — returns diagnostics summary (empty = clean) */
  verifyEdit?: (relPath: string) => string;
  validateEdit?: (relPath: string, newContent: string) => Promise<string | null>;
  /** P1.3 structured planning: receives every update_plan submission */
  onPlanUpdate?: (steps: Array<{ text: string; status: 'pending' | 'in_progress' | 'completed' }>) => void;
  /** Live event feed for streaming UIs */
  onEvent?: (evt: LoopEvent) => void;
  /** RE4: ask before write_file/apply_patch/run_command; false denies the tool call */
  requestPermission?: (toolName: string, args: Record<string, any>) => Promise<boolean>;
  onToolResult?: (result: ToolResult) => void;
  /**
   * Seed the loop with an existing message list (e.g. carried over from a prior
   * auto-continuation pass) instead of rebuilding from `history`. When set,
   * systemContext/history are ignored and `prompt` is appended as a new user
   * turn — so the model resumes with full memory of previous tool activity.
   */
  priorMessages?: LoopMessage[];
  /**
   * P0.1 snapshot hook: called with the current full message list at the end
   * of every iteration and once more after the loop exits. Use it to persist
   * per-run messages so a crashed/cancelled run can be resumed. Errors are
   * swallowed — a snapshot failure must never break the run.
   */
  onMessages?: (messages: LoopMessage[]) => void;
  /** P1.5a: durable task ledger run id (`.devforge/tasks/<runId>.md`) */
  runId?: string;
  /** P3.1: enables the `semantic_search` tool (see ExecuteToolOptions) */
  semanticSearch?: (query: string, k?: number) => Promise<string>;
  /**
   * P3.3: enables the `delegate_research` tool. Spawns a read-only explore
   * subagent; its compact report is returned as this tool's result.
   */
    runSubagent?: (question: string) => Promise<string>;
  /**
   * P7.4 item 1: enables the `recall` tool (query scoped long-term memories for
   * this run's workspace). See ExecuteToolOptions.
   */
  queryMemories?: (query: string, k?: number) => Promise<string>;
  /**
   * P7.4 item 1: enables the `remember` tool (persist a durable fact/convention
   * into scoped long-term memory). See ExecuteToolOptions.
   */
  remember?: (args: {
    category: string;
    key: string;
    value: string;
    tags?: string[];
    scope?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  /** P5.3: user-defined plugin tools (see server/pluginTools.ts) */
  pluginTools?: PluginRuntimeTool[];
  /**
   * P1.2 auto-verify: after each iteration that changed files, run these
   * verification commands; on failure inject the error output back into the
   * loop (up to `maxHealAttempts` times) so the model self-heals.
   */
  autoVerify?: { commands: VerifyCommand[]; maxHealAttempts?: number };
  /**
   * P1.5b self-summarizing compaction: how many recent turns stay verbatim
   * when the context budget nears overflow and older turns get digested.
   * Requires sampling.numCtxTokens to be set (the budget it protects).
   */
  compactionKeepTurns?: number;
  /**
   * P2.2 diff-review gate: called BEFORE write_file/apply_patch executes.
   * Return a (possibly argument-transformed) ToolCall to proceed — e.g. with
   * only the user-accepted hunks — or null to deny. Runs ahead of, and
   * independently from, requestPermission.
   */
  reviewEdit?: (call: ToolCall) => Promise<ToolCall | null>;
  /**
   * P1.5d git-first workflow: called after an edit batch is VERIFIED (or, when
   * no autoVerify is configured, right after the edit batch) with the files
   * changed since the previous commit. Best-effort — never blocks the loop.
   */
  onStepVerified?: (files: string[], summary: string) => void;
}

export interface AgentLoopResult {
  reply: string;
  iterations: number;
  toolCalls: ToolResult[];
  filesChanged: string[];
  usedTools: boolean;
  /** True when the loop exhausted maxIterations without the model producing a final answer */
  hitIterationCap?: boolean;
  /**
   * Final message list (including all tool calls/results). Callers running
   * continuation passes should feed this back via `priorMessages` so the next
   * pass resumes from where this one stopped instead of starting over.
   */
  messages?: LoopMessage[];
}

// ---------------- Tool schema ----------------

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        'List files in the workspace. Returns relative paths. Use to discover project structure.',
      parameters: {
        type: 'object',
        properties: {
          glob: { type: 'string', description: 'Optional glob filter, e.g. "src/**/*.ts"' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description: 'Search file contents across the workspace for a text/regex query.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          glob: { type: 'string', description: 'Optional file glob filter' },
          maxResults: { type: 'number', description: 'Default 50, max 200' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a file from the workspace. Supports ranged reads via offset/limit (line-based).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path inside the workspace' },
          offset: { type: 'number', description: '0-based start line' },
          limit: { type: 'number', description: 'Max lines to return (default 400)' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_outline',
      description: 'Get the top-level symbols (functions/classes/interfaces/types) of a file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a file with full content. Prefer apply_patch for editing existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description:
        'Edit an existing file. PREFERRED: "patch" — a unified diff (one or more @@ hunks with context lines); matching is fuzzy and tolerant of whitespace/indentation drift. ALTERNATIVE: "oldText"/"newText" — replace a unique snippet (exact or near-exact match). Failures include similarity % and the closest line — re-read the file and retry with corrected context.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          patch: { type: 'string', description: 'Unified diff (unidiff) with @@ -oldStart,count +newStart,count @@ hunks. Lines prefixed with - (removed), + (added), or one leading space (context).' },
          oldText: { type: 'string' },
          newText: { type: 'string' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run an allowlisted verification command in the workspace: npm test, npm run lint, npm run build, tsc --noEmit, vitest run, pytest, ruff check, git status/diff. Use it to verify your changes.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Get the git diff of the workspace repository (read-only).',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_plan',
      description:
        'REQUIRED planning tool. Before doing multi-step work, submit your FULL ordered step list here, then call it again whenever a step changes status (mark completed ONLY after the step is verified working). The UI shows this plan live to the user.',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: 'FULL ordered step list (replaces the previous plan).',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Imperative step description, e.g. "Add CSV parser to utils.ts"' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'Default pending.'
                }
              },
              required: ['text']
            }
          },
          note: { type: 'string', description: 'Optional one-line progress note' }
        },
        required: ['steps']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description:
        'Update the durable task ledger — an on-disk progress record that survives crashes and context loss. Send the FULL steps list (it replaces the previous one), plus any new finding, file you are working on, and the single next action.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short task title' },
          steps: {
            type: 'array',
            description: 'FULL ordered step list (replaces previous). Each: { text, status, note? }',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] },
                note: { type: 'string', description: 'Optional detail, e.g. why a step is blocked' }
              },
              required: ['text']
            }
          },
          add_finding: { type: 'string', description: 'A key finding or decision worth remembering' },
          file: { type: 'string', description: 'Workspace-relative file you are creating or editing' },
          next_action: { type: 'string', description: 'The single next thing to do' }
        }
      }
    }
  }
];

/** P3.1: semantic_search is only exposed when a retrieval backend is wired. */
const SEMANTIC_SEARCH_SCHEMA: any = {
  type: 'function',
  function: {
    name: 'semantic_search',
    description:
      'Semantic code search across the workspace (local embeddings + keyword blend). Finds relevant functions/classes by MEANING, not just exact text. Returns file paths with line ranges — follow up with read_file on those ranges.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, e.g. "where CSV files are parsed"' },
        k: { type: 'number', description: 'Max results (default 6, max 12)' }
      },
      required: ['query']
    }
  }
};

/** P3.3: delegate_research is only exposed when a subagent backend is wired. */
const DELEGATE_RESEARCH_SCHEMA: any = {
  type: 'function',
  function: {
    name: 'delegate_research',
    description:
      'Delegate a research question to a read-only explore subagent (it has its own tool budget and cannot edit anything). Use it for broad investigation ("where/how is X implemented?") so you save your OWN iterations for editing. Returns a compact report with file paths + line ranges.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Precise research question, e.g. "where are CSV files parsed and which function normalizes columns?"' }
      },
      required: ['question']
    }
  }
};

/** P7.4 item 1: recall — query scoped long-term memories (only when wired). */
const RECALL_SCHEMA: any = {
  type: 'function',
  function: {
    name: 'recall',
    description:
      'Search cross-session long-term project memories (decisions, conventions, persistent facts for this workspace + useful global facts). Use it BEFORE re-doing work you may have done on a previous session, or when a "how/where does X work?" question could already be answered from a past run. Returns the top-matching memory entries.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to remember, e.g. "how do we name migration files" or "what is the build command"' },
        k: { type: 'number', description: 'Max results (default 6, max 12)' }
      },
      required: ['query']
    }
  }
};

/** P7.4 item 1: remember — persist a durable fact (only when wired). */
const REMEMBER_SCHEMA: any = {
  type: 'function',
  function: {
    name: 'remember',
    description:
      'Persist a durable project fact, convention, or decision into cross-session memory so it survives compaction and future runs. Use it when you learn something non-obvious that a future session would benefit from (project-specific test commands, architecture invariants, user preferences, a bug we keep re-hitting). Do NOT use for transient or task-specific info.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'convention | fact | architecture | preference | bug_note', enum: ['convention', 'fact', 'architecture', 'preference', 'bug_note'] },
        key: { type: 'string', description: 'Short identifier (snake_case), e.g. "lint_command" or "naming_migration"' },
        value: { type: 'string', description: 'The durable value — the exact command, the convention text, the architectural note' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Free-form tags for scoped retrieval boosts, e.g. ["npm", "ci"]' },
        scope: { type: 'string', description: 'Optional. "global" for cross-project facts (default), or a workspace path for project-local facts.' }
      },
      required: ['key', 'value']
    }
  }
};

function toolSchemas(opts: { semanticSearch?: unknown; runSubagent?: unknown; pluginTools?: PluginRuntimeTool[]; queryMemories?: unknown; remember?: unknown }) {
  const extra = [
    ...(opts.semanticSearch ? [SEMANTIC_SEARCH_SCHEMA] : []),
    ...(opts.runSubagent ? [DELEGATE_RESEARCH_SCHEMA] : []),
    ...(opts.queryMemories ? [RECALL_SCHEMA] : []),
    ...(opts.remember ? [REMEMBER_SCHEMA] : []),
    ...(opts.pluginTools || []).map((t) => t.schema)
  ];
  return extra.length ? [...TOOL_SCHEMAS, ...extra] : TOOL_SCHEMAS;
}

export const ALLOWED_COMMAND_PREFIXES = [
  'npm test',
  'npm run lint',
  'npm run build',
  'tsc --noEmit',
  'vitest run',
  'pytest',
  'ruff check',
  'git status',
  'git diff'
];

/**
 * Strict allowlist validation: prefix match AND no shell metacharacters.
 * Commands run via `exec` (shell), so characters like `&&`, `;`, backticks
 * or `$()` could otherwise smuggle arbitrary commands past the prefix check.
 */
const SHELL_METACHARS = /[;&|<>`$(){}\[\]~*?!\\\r\n'"]/;

export function isCommandAllowed(command: string): { ok: boolean; reason?: string } {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, reason: 'empty command' };
  if (!ALLOWED_COMMAND_PREFIXES.some((p) => cmd.startsWith(p))) {
    return { ok: false, reason: `not allowlisted. Allowed: ${ALLOWED_COMMAND_PREFIXES.join(', ')}` };
  }
  const m = cmd.match(SHELL_METACHARS);
  if (m) {
    return { ok: false, reason: `shell metacharacter "${m[0]}" rejected — only single simple commands are permitted` };
  }
  return { ok: true };
}

// ---------------- Tool execution ----------------

// ---------------- P7.1: parallel-safe classification + execution guard ----------------

/**
 * P7.1: tools that are pure and state-free — safe to run as a concurrent
 * batch. Deliberately narrow: `read_file` records mtimes (E5 conflict
 * detector), `semantic_search` maintains an index, `delegate_research`
 * spawns a subagent, and everything else mutates state. Keep it this way.
 */
export const PARALLEL_SAFE_TOOLS = new Set(['list_files', 'search', 'file_outline']);

export function isReadOnlyParallelTool(name: string): boolean {
  return PARALLEL_SAFE_TOOLS.has(name);
}

/** Default per-call budget for ordinary built-in tools. */
export const DEFAULT_TOOL_TIMEOUT_MS = 10000;
/** delegate_research / semantic_search run their own long work — 20 min budget. */
export const SUBAGENT_TOOL_BUDGET_MS = 1200000;

export function toolTimeoutFor(name: string, options: ExecuteToolOptions): number {
  if (options.timeoutMs && options.timeoutMs > 0) return options.timeoutMs;
  if (name === 'delegate_research' || name === 'semantic_search') return SUBAGENT_TOOL_BUDGET_MS;
  return DEFAULT_TOOL_TIMEOUT_MS;
}

/** Shell child processes are tracked so a guard abort can kill them directly. */
let activeShellChildren: Set<ChildProcess> | null = null;
export function __activeShellChildren(): Set<ChildProcess> {
  if (!activeShellChildren) activeShellChildren = new Set();
  return activeShellChildren;
}

/**
 * P7.1: run `run` under a per-call budget AND an abort signal. The guard
 * WINS the race at the first of {work done, budget, abort} — so even a tool
 * that ignores its input (like a plain plugin callback) is cut off at the
 * deadline or on cancel, and any tracked shell child is killed to free the
 * process. Callers (Promise.allSettled batches) always get a settled result.
 */
function withToolGuard(
  callId: string,
  callName: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  run: () => Promise<ToolResult>
): Promise<ToolResult> {
  const fail = (content: string): ToolResult => ({ callId, name: callName, ok: false, content });
  let child: ChildProcess | undefined;
  const killChild = () => {
    if (!child) return;
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
    setTimeout(() => { try { child!.kill('SIGKILL'); } catch { /* already dead */ } }, 250).unref();
  };

  if (signal && signal.aborted) {
    return Promise.resolve(fail('ERROR: cancelled — run aborted before this call started.'));
  }

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(() => {
      killChild();
      resolve(fail(
        `ERROR: ${callName} exceeded its ${timeoutMs}ms time budget (timed out). ` +
        'Try a smaller scope, or move on and note it as blocked.'
      ));
    }, timeoutMs);
  });

  let resolveAbort: ((r: ToolResult) => void) | undefined;
  const abortPromise = signal
    ? new Promise<ToolResult>((resolve) => {
        resolveAbort = resolve;
      })
    : null;

  const onAbort = () => {
    killChild();
    resolveAbort?.(fail('ERROR: cancelled — the run was aborted while this call was in flight.'));
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const work = run().catch((err: any) => toolError(callName, callId, err));

  return Promise.race([work, timeoutPromise, ...(abortPromise ? [abortPromise] : [])]).finally(() => {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  });
}

/**
 * P7.1: `exec` with the child tracked for abort-kill. Keeps the old
 * (err, stdout, stderr) callback semantics verbatim.
 */
function spawnShellCommandTracked(
  command: string,
  opts: { cwd: string; timeout?: number; maxBuffer?: number },
  cb: (err: { code?: number; message: string } | null, stdout: string, stderr: string) => void
): void {
  const child = spawn(command, {
    cwd: opts.cwd,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  __activeShellChildren().add(child);
  const cleanup = () => __activeShellChildren().delete(child);
  const t = opts.timeout ? setTimeout(() => {
    try { child.kill('SIGTERM'); } catch { }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { } }, 2000).unref();
  }, opts.timeout) : undefined;
  const max = opts.maxBuffer ?? 8 * 1024 * 1024;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b: Buffer) => { if (stdout.length < max) stdout += b.toString('utf8'); });
  child.stderr.on('data', (b: Buffer) => { if (stderr.length < max) stderr += b.toString('utf8'); });
  child.on('error', (err: NodeJS.ErrnoException) => {
    if (t) clearTimeout(t);
    cleanup();
    cb(null, '', err.message);
  });
  child.on('close', (code: number | null) => {
    if (t) clearTimeout(t);
    cleanup();
    const err = code === 0 ? null : { code: code ?? 1, message: `exit ${code}` };
    cb(err, stdout.slice(0, max), stderr.slice(0, max));
  });
}

/** P7.1: `execFile` variant for direct binaries (git), same tracking. */
function spawnExecFileSyncTracked(
  file: string,
  args: string[],
  opts: { cwd: string; timeout?: number; maxBuffer?: number },
  cb: (err: { code?: number; message: string } | null, stdout: string) => void
): void {
  const child = spawn(file, args, {
    cwd: opts.cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  __activeShellChildren().add(child);
  const cleanup = () => __activeShellChildren().delete(child);
  const t = opts.timeout ? setTimeout(() => {
    try { child.kill('SIGTERM'); } catch { }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { } }, 2000).unref();
  }, opts.timeout) : undefined;
  const max = opts.maxBuffer ?? 4 * 1024 * 1024;
  let out = '';
  child.stdout.on('data', (b: Buffer) => { if (out.length < max) out += b.toString('utf8'); });
  child.on('error', (err: NodeJS.ErrnoException) => {
    if (t) clearTimeout(t);
    cleanup();
    cb(null, out);
  });
  child.on('close', (code: number | null) => {
    if (t) clearTimeout(t);
    cleanup();
    const err = code === 0 ? null : { code: code ?? 1, message: `exit ${code}` };
    cb(err, out.slice(0, max));
  });
}

function shellOutcome(
  callId: string,
  callName: string,
  cbErr: { code?: number; message: string } | null,
  stdout: string,
  stderr: string,
  maxSlice: number
): ToolResult {
  const code = typeof (cbErr as any)?.code === 'number' ? (cbErr as any).code : cbErr ? 1 : 0;
  const out = [stdout, stderr].filter(Boolean).join('\n--- stderr ---\n').slice(0, maxSlice);
  return {
    callId,
    name: callName,
    ok: code === 0,
    content: `exit=${code}\n${out || '(no output)'}`
  };
}
// ---------------- end P7.1 helpers ----------------

function toolError(name: string, callId: string, err: unknown): ToolResult {
  const msg = err instanceof PathTraversalError
    ? `BLOCKED: ${err.message}`
    : String((err as any)?.message || err);
  return { callId, name, ok: false, content: `ERROR: ${msg}` };
}

export async function executeTool(
  root: string,
  call: ToolCall,
  options: ExecuteToolOptions = {}
): Promise<ToolResult> {
  // P7.1: public entry — every invocation goes through the per-call guard.
  return withToolGuard(call.id, call.name, toolTimeoutFor(call.name, options), options.signal, () =>
    executeToolInner(root, call, options)
  );
}

async function executeToolInner(
  root: string,
  call: ToolCall,
  options: ExecuteToolOptions = {}
): Promise<ToolResult> {
  const signal = options.signal;

  // P5.3: plugin tools take precedence by name over the built-in switch
  if (options.pluginTools?.length) {
    const plugin = options.pluginTools.find((t) => t.name === call.name);
    if (plugin) {
      try {
        const r = await plugin.execute(call.arguments || {});
        return { callId: call.id, name: call.name, ok: r.ok, content: r.output };
      } catch (err: any) {
        return {
          callId: call.id,
          name: call.name,
          ok: false,
          content: `ERROR: plugin tool "${call.name}" failed — ${String(err?.message || err)}`
        };
      }
    }
  }

  try {
    switch (call.name) {
      case 'list_files': {
        const entries = walkWorkspace(root, { maxDepth: 12, maxFiles: 3000 });
        let paths = entries.filter((e) => !e.isDirectory).map((e) => e.relPath);
        if (call.arguments.glob) {
          const src = String(call.arguments.glob)
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*/g, '\u0000')
            .replace(/\*/g, '[^/]*')
            .replace(/\u0000/g, '.*')
            .replace(/\?/g, '.');
          const re = new RegExp(`(^|/)${src}$`, 'i');
          paths = paths.filter((p) => re.test(p));
        }
        return { callId: call.id, name: call.name, ok: true, content: paths.join('\n') || '(no files)' };
      }

      case 'search': {
        const r = await searchWorkspace(root, String(call.arguments.query), {
          glob: call.arguments.glob,
          maxResults: Math.min(Number(call.arguments.maxResults) || 50, 200),
          caseSensitive: false
        });
        const body = r.hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n') || '(no matches)';
        return {
          callId: call.id,
          name: call.name,
          ok: true,
          content: `${body}${r.truncated ? `\n(truncated, ${r.hits.length} shown)` : ''}`
        };
      }

      case 'read_file': {
        const reqOffset = Number(call.arguments.offset) || 0;
        const reqLimit = Number(call.arguments.limit) || 0;
        const r = readFileRange(
          root,
          String(call.arguments.path),
          reqOffset,
          Math.min(reqLimit || 400, 2000)
        );
        if (r.isBinary) {
          return { callId: call.id, name: call.name, ok: false, content: 'ERROR: binary file — not readable as text' };
        }
        // Large-file guard: an unqualified read of a big file floods the context
        // window. Give the model its outline + head instead and ask for ranges.
        if (!reqLimit && reqOffset === 0 && r.totalLines > 400) {
          try {
            recordMtime(resolveSafePath(root, String(call.arguments.path)));
          } catch {}
          const o = getOutline(root, String(call.arguments.path));
          const symbols = o.symbols.map((s) => `L${s.line} ${s.kind} ${s.name}`).join('\n');
          return {
            callId: call.id,
            name: call.name,
            ok: true,
            content:
              `[${r.path}] is large (${r.totalLines} lines). Full read skipped to protect context.\n` +
              `=== OUTLINE ===\n${symbols || '(no symbols)'}\n` +
              `=== HEAD (lines 1-80) ===\n` +
              r.content.split('\n').slice(0, 80).join('\n') +
              `\nUse read_file with offset/limit to fetch only the sections you need (e.g. around the line numbers above).`
          };
        }
        try {
          recordMtime(resolveSafePath(root, String(call.arguments.path)));
        } catch {}
        const header = `[${r.path}] lines ${r.offset + 1}-${r.offset + (r.content.split('\n').length)} of ${r.totalLines}${r.truncated ? ' (TRUNCATED — use offset for more)' : ''}\n`;
        return { callId: call.id, name: call.name, ok: true, content: header + r.content };
      }

      case 'file_outline': {
        const o = getOutline(root, String(call.arguments.path));
        const body = o.symbols.map((s) => `L${s.line} ${s.kind} ${s.name}`).join('\n') || '(no symbols)';
        return { callId: call.id, name: call.name, ok: true, content: body };
      }

      // P3.1: semantic code retrieval (only wired when options.semanticSearch set)
      case 'semantic_search': {
        if (!options.semanticSearch) {
          return { callId: call.id, name: call.name, ok: false, content: 'ERROR: semantic search unavailable in this run' };
        }
        const body = await options.semanticSearch(
          String(call.arguments.query),
          Math.min(Number(call.arguments.k) || 6, 12)
        );
        return { callId: call.id, name: call.name, ok: true, content: body };
      }

      // P3.3: read-only explore subagent (only wired when options.runSubagent set)
      case 'delegate_research': {
        if (!options.runSubagent) {
          return { callId: call.id, name: call.name, ok: false, content: 'ERROR: research delegation unavailable in this run' };
        }
        try {
          const report = await options.runSubagent(String(call.arguments.question || ''));
          return { callId: call.id, name: call.name, ok: true, content: report };
        } catch (err: any) {
          return {
            callId: call.id,
            name: call.name,
            ok: false,
            content: `ERROR: subagent failed — ${String(err?.message || err)}; investigate yourself with search/read_file.`
          };
        }
      }

      // P7.4 item 1: query scoped long-term memories (only wired when options.queryMemories set)
      case 'recall': {
        if (!options.queryMemories) {
          return { callId: call.id, name: call.name, ok: false, content: 'ERROR: recall tool unavailable in this run' };
        }
        const k = Math.min(Number(call.arguments.k) || 6, 12);
        try {
          const body = await options.queryMemories(String(call.arguments.query || ''), k);
          return { callId: call.id, name: call.name, ok: true, content: body || '(no matching memories)' };
        } catch (err: any) {
          return {
            callId: call.id,
            name: call.name,
            ok: false,
            content: `ERROR: recall failed — ${String(err?.message || err)}`
          };
        }
      }

      // P7.4 item 1: persist a durable fact/convention scoped to this run's workspace
      case 'remember': {
        if (!options.remember) {
          return { callId: call.id, name: call.name, ok: false, content: 'ERROR: remember tool unavailable in this run' };
        }
        const key = String(call.arguments.key || '').trim();
        const value = String(call.arguments.value || '').trim();
        if (!key || !value) {
          return { callId: call.id, name: call.name, ok: false, content: 'ERROR: remember requires both key and value' };
        }
        const rawTags = call.arguments.tags;
        const tags = Array.isArray(rawTags)
          ? rawTags.map((t) => String(t)).filter((t) => t.trim()).slice(0, 8)
          : typeof rawTags === 'string' && rawTags.trim()
            ? rawTags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 8)
            : undefined;
        const r = await options.remember({
          category: String(call.arguments.category || 'fact'),
          key: key.slice(0, 120),
          value: value.slice(0, 800),
          tags,
          scope: call.arguments.scope
        });
        if (!r.ok) {
          return { callId: call.id, name: call.name, ok: false, content: `ERROR: remember failed — ${r.error || 'unknown'}` };
        }
        return { callId: call.id, name: call.name, ok: true, content: 'Recorded (durable). It will survive compaction and be available to future sessions via recall.' };
      }

      case 'write_file': {
        const userPath = String(call.arguments.path);
        const content = String(call.arguments.content ?? '');
        const abs = resolveSafePath(root, userPath);

        // Binary-extension safety
        if (!TEXT_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
          return { callId: call.id, name: call.name, ok: false, content: `ERROR: refusing to write non-text extension ${path.extname(abs)}` };
        }

        // P1.5e edit validation gate — reject invalid content BEFORE disk
        const gateErr = options.validateEdit ? await options.validateEdit(userPath, content) : null;
        if (gateErr) {
          return {
            callId: call.id,
            name: call.name,
            ok: false,
            content: `EDIT REJECTED BY VALIDATION GATE (file was NOT written):\n${gateErr}\nFix the issues and re-apply the write.`
          };
        }

        // E5: refuse to clobber external modifications
        if (fs.existsSync(abs)) {
          const conflict = checkConflict(abs);
          if (conflict.conflicted) {
            return {
              callId: call.id,
              name: call.name,
              ok: false,
              content: 'ERROR: CONFLICT — this file was modified outside the agent since you last read it. Re-read the file and re-apply your change on the fresh content.'
            };
          }
          // Skip no-op writes (checksum compare)
          const existing = fs.readFileSync(abs);
          const raw = Buffer.from(content, 'utf-8');
          if (existing.length === raw.length && existing.equals(raw)) {
            recordMtime(abs);
            return { callId: call.id, name: call.name, ok: true, content: 'unchanged (content identical)' };
          }
          // W2: snapshot before overwrite
          if (options.backupDir) backupFileBeforeWrite(root, abs, options.backupDir);
        }

        fs.mkdirSync(path.dirname(abs), { recursive: true });

        // Atomic write: temp + rename
        const tmp = abs + '.ocastmp';
        fs.writeFileSync(tmp, content, 'utf-8');
        fs.renameSync(tmp, abs);
        recordMtime(abs);

        const verifyNote = options.verifyEdit ? options.verifyEdit(userPath) : '';
        return {
          callId: call.id,
          name: call.name,
          ok: true,
          content: `wrote ${userPath.replace(/\\/g, '/')} (${Buffer.byteLength(content)} bytes)${verifyNote}`
        };
      }

      case 'apply_patch': {
        const userPath = String(call.arguments.path);
        const patchArg = String(call.arguments.patch ?? '');
        const oldText = String(call.arguments.oldText ?? '');
        const newText = String(call.arguments.newText ?? '');
        const abs = resolveSafePath(root, userPath);

        const hasDiff = patchArg.trim().length > 0;
        const hasSnippet = oldText.length > 0 || newText.length > 0;
        if (!hasDiff && !hasSnippet) {
          return {
            callId: call.id,
            name: call.name,
            ok: false,
            content: 'ERROR: provide "patch" (unified diff) or "oldText"/"newText" to apply.'
          };
        }
        if (!hasDiff && oldText.length === 0) {
          return { callId: call.id, name: call.name, ok: false, content: 'ERROR: oldText is empty' };
        }

        // E5: refuse to patch a file changed externally since the agent read it
        const conflict = checkConflict(abs);
        if (conflict.conflicted) {
          return {
            callId: call.id,
            name: call.name,
            ok: false,
            content: 'ERROR: CONFLICT — this file was modified outside the agent since you last read it. Re-read the file and re-apply your patch on the fresh content.'
          };
        }

        const buf = fs.readFileSync(abs);
        if (looksBinary(buf)) {
          return { callId: call.id, name: call.name, ok: false, content: 'ERROR: binary file' };
        }
        const current = buf.toString('utf-8');

        const res: PatchResult = hasDiff
          ? applyUnifiedDiff(current, patchArg)
          : fuzzyReplace(current, oldText, newText);

        if (!res.ok) {
          return { callId: call.id, name: call.name, ok: false, content: `ERROR: ${res.error}` };
        }

        // P1.5e edit validation gate on the PATCHED result — before disk
        const patchGateErr = options.validateEdit ? await options.validateEdit(userPath, res.content!) : null;
        if (patchGateErr) {
          return {
            callId: call.id,
            name: call.name,
            ok: false,
            content: `EDIT REJECTED BY VALIDATION GATE (file was NOT modified):\n${patchGateErr}\nFix the issues and re-apply the patch.`
          };
        }

        // W2: snapshot before patching
        if (options.backupDir) backupFileBeforeWrite(root, abs, options.backupDir);

        const tmp = abs + '.ocastmp';
        fs.writeFileSync(tmp, res.content!, 'utf-8');
        fs.renameSync(tmp, abs);
        recordMtime(abs);

        const added = res.added ?? 0;
        const removed = res.removed ?? 0;
        const verifyNote = options.verifyEdit ? options.verifyEdit(userPath) : '';
        return {
          callId: call.id,
          name: call.name,
          ok: true,
          content: `patched ${userPath.replace(/\\/g, '/')} (+${added}/-${removed} lines)${verifyNote}`
        };
      }

      case 'run_command': {
        const command = String(call.arguments.command || '').trim();
        const check = isCommandAllowed(command);
        if (!check.ok) {
          return {
            callId: call.id,
            name: call.name,
            ok: false,
            content: `ERROR: command rejected — ${check.reason}`
          };
        }
        // P7.1: tracked spawn so the guard's abort can kill the shell child.
        return await new Promise<ToolResult>((resolve) => {
          spawnShellCommandTracked(
            command,
            { cwd: root, timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout, stderr) => {
              resolve(
                shellOutcome(call.id, call.name, err, stdout, stderr, 8000)
              );
            }
          );
        });
      }

      case 'git_diff': {
        // P7.1: tracked spawn so the guard's abort can kill the child.
        return await new Promise<ToolResult>((resolve) => {
          spawnExecFileSyncTracked(
            'git',
            ['diff'],
            { cwd: root, maxBuffer: 4 * 1024 * 1024, timeout: 15000 },
            (err, stdout) => {
              if (err && !stdout) {
                resolve({ callId: call.id, name: call.name, ok: false, content: `ERROR: ${err.message}` });
              } else {
                resolve({
                  callId: call.id,
                  name: call.name,
                  ok: true,
                  content: stdout.slice(0, 16000) || '(no unstaged changes)'
                });
              }
            }
          );
        });
      }

      case 'update_plan': {
        // P1.3 structured planning discipline: plan → execute → verify with
        // explicit statuses, surfaced live via plan_update events (no regex scraping).
        const rawSteps = Array.isArray(call.arguments?.steps) ? call.arguments.steps : [];
        const steps = rawSteps
          .slice(0, 20)
          .map((s: any) => ({
            text: String(s?.text || '').slice(0, 160),
            status: (['pending', 'in_progress', 'completed'].includes(s?.status) ? s.status : 'pending') as
              | 'pending'
              | 'in_progress'
              | 'completed'
          }))
          .filter((s: any) => s.text);
        if (!steps.length) {
          return {
            callId: call.id,
            name: call.name,
            ok: false,
            content: 'ERROR: update_plan requires a non-empty steps array [{text, status}].'
          };
        }
        try {
          options.onPlanUpdate?.(steps);
        } catch {}
        const done = steps.filter((s: any) => s.status === 'completed').length;
        const note = call.arguments?.note ? ` — ${String(call.arguments.note).slice(0, 120)}` : '';
        return {
          callId: call.id,
          name: call.name,
          ok: true,
          content: `plan updated (${done}/${steps.length} completed)${note}. Keep statuses current as you work.`
        };
      }

      case 'update_task': {
        const runId = options.runId;
        if (!runId) {
          return {
            callId: call.id,
            name: call.name,
            ok: false,
            content: 'ERROR: no run id bound to this session — the durable task ledger is unavailable'
          };
        }
        const ledger = applyUpdate(root, runId, call.arguments);
        let stepSummary = 'no steps';
        if (ledger.steps.length) {
          const done = ledger.steps.filter((s) => s.status === 'completed').length;
          stepSummary = `${done}/${ledger.steps.length} steps done`;
        }
        return {
          callId: call.id,
          name: call.name,
          ok: true,
          content:
            `ledger updated: ${stepSummary}; next: ${ledger.nextAction || '(none)'}; ` +
            `files tracked: ${ledger.filesTouched.length}`
        };
      }

      default:
        return { callId: call.id, name: call.name, ok: false, content: `ERROR: unknown tool "${call.name}"` };
    }
  } catch (err: any) {
    return toolError(call.name, call.id, err);
  }
}

// ---------------- LLM callers ----------------

/**
 * Turn raw fetch/network failures into an actionable message for the user.
 * Used by both the streaming and legacy agent routes.
 */
export function humanizeLlmError(err: unknown): string {
  const anyErr = err as any;
  const code = anyErr?.cause?.code || anyErr?.code || '';
  const msg = String(anyErr?.message || err || '');
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|UND_ERR|fetch failed|socket hang up|aborted/i.test(`${code} ${msg}`)) {
    return 'Could not reach your local model server. ' +
      "1) Start it: `ollama serve` (or launch LM Studio). " +
      "2) Pull a model if needed: `ollama pull qwen2.5-coder:7b`. " +
      '3) Press Rescan in the header, then try again.';
  }
  return msg || String(err);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (init.signal) init.signal.removeEventListener('abort', onAbort);
  }
}

/** Strip qwen3-style <think> reasoning blocks from model output. */
function stripThinkBlocks(text: string): string {
  let out = text.replace(/<think>[\s\S]*?\/think\u003E/g, '')
  const lastOpen = out.lastIndexOf('<think>')
  if (lastOpen !== -1) {
    // Unterminated open tag: keep text AFTER the tag (likely the actual
    // answer); drop only the tag and the raw reasoning preceding it.
    const head = lastOpen > 0 ? out.slice(0, lastOpen).trimEnd() : ''
    const tail = out.slice(lastOpen + '<think>'.length).trim()
    out = [head, tail].filter(Boolean).join('\n')
  }
  return out;
}

/** One LLM call that may return tool_calls (OpenAI-style normalized). */
async function callLLMWithTools(
  endpoint: string,
  modelId: string,
  messages: LoopMessage[],
  tools: typeof TOOL_SCHEMAS,
  signal?: AbortSignal,
  sampling?: { temperature: number; topP: number; repeatPenalty: number; numCtxTokens: number },
  onToken?: (delta: string) => void,
  thinkingLevel?: 'none' | 'low' | 'medium' | 'high'
): Promise<{ content: string; toolCalls: ToolCall[]; stats?: LlmCallStats } | null> {
  const cleanEp = endpoint.replace(/\/$/, '');
  const payloadTools = tools.length ? tools : undefined;
  const wantsStream = !!onToken;

  // qwen3 soft switch: /no_think in the latest user message disables reasoning
  let effectiveMessages: LoopMessage[] = messages;
  if (thinkingLevel === 'none') {
    effectiveMessages = messages.map((m, i) =>
      i === messages.length - 1 && m.role === 'user'
        ? { ...m, content: `${m.content}\n\n/no_think` }
        : m
    );
  }

  // Ollama-style runtime options
  const ollamaOptions = sampling
    ? {
        temperature: sampling.temperature,
        top_p: sampling.topP,
        repeat_penalty: sampling.repeatPenalty,
        num_ctx: Math.round(sampling.numCtxTokens)
      }
    : undefined;

  // RE3: one retry with backoff per endpoint on network errors
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1500));
      if (signal?.aborted) throw new Error('cancelled');
    }

    // 1. Ollama /api/chat (supports NDJSON token streaming)
    try {
      const resp = await fetchWithTimeout(
        `${cleanEp}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelId,
            messages: effectiveMessages,
            stream: wantsStream,
            tools: payloadTools,
            options: ollamaOptions
          }),
          signal
        },
        600000
      );
      if (resp.ok && resp.body && wantsStream) {
        const parsed = await consumeOllamaStream(resp.body, onToken!, signal);
        const cleaned = stripThinkBlocks(parsed.content);
        if (cleaned.trim() || parsed.toolCalls.length) return { content: cleaned, toolCalls: parsed.toolCalls, stats: parsed.stats };
        continue; // empty — try next strategy/attempt
      }
      if (resp.ok) {
        const data: any = await resp.json();
        const msg = data?.message;
        if (msg && (typeof msg.content === 'string' || Array.isArray(msg.tool_calls))) {
          const calls: ToolCall[] = (msg.tool_calls || []).map((tc: any, i: number) => ({
            id: `ollama-${Date.now()}-${i}`,
            name: tc.function?.name,
            arguments: typeof tc.function?.arguments === 'string'
              ? safeJsonParse(tc.function.arguments)
              : tc.function?.arguments || {}
          }));
          if (calls.length || (msg.content && msg.content.trim())) {
            return { content: msg.content || '', toolCalls: calls, stats: statsFromOllamaDone(data) };
          }
        }
      }
    } catch (e: any) {
      if (signal?.aborted) throw new Error('cancelled');
      continue;
    }

    // 2. OpenAI-compatible /v1/chat/completions (non-streaming fallback)
    try {
      const resp = await fetchWithTimeout(
        `${cleanEp}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: modelId,
            messages: effectiveMessages,
            stream: false,
            tools: payloadTools,
            ...(sampling ? { temperature: sampling.temperature, top_p: sampling.topP } : {})
          }),
          signal
        },
        600000
      );
      if (resp.ok) {
        const data: any = await resp.json();
        const msg = data?.choices?.[0]?.message;
        if (msg) {
          const calls: ToolCall[] = (msg.tool_calls || []).map((tc: any, i: number) => ({
            id: tc.id || `openai-${Date.now()}-${i}`,
            name: tc.function?.name,
            arguments: safeJsonParse(tc.function?.arguments || '{}')
          }));
          if (calls.length || (typeof msg.content === 'string' && msg.content.trim())) {
            const u = data?.usage;
            return {
              content: stripThinkBlocks(msg.content || ''),
              toolCalls: calls,
              stats:
                u && typeof u.prompt_tokens === 'number'
                  ? { promptEvalTokens: u.prompt_tokens, evalTokens: u.completion_tokens }
                  : undefined
            };
          }
        }
      }
    } catch (e: any) {
      if (signal?.aborted) throw new Error('cancelled');
    }

    // If a non-streaming response already returned content we would have exited.
    void wantsStream;
  }

  return null;
}

/** P3.4: per-call inference stats from Ollama's final stream frame / response. */
interface LlmCallStats {
  promptEvalTokens?: number;
  promptEvalMs?: number;
  evalTokens?: number;
  evalMs?: number;
}

function statsFromOllamaDone(d: any): LlmCallStats | undefined {
  if (!d || typeof d !== 'object') return undefined;
  const s: LlmCallStats = {};
  if (typeof d.prompt_eval_count === 'number') s.promptEvalTokens = d.prompt_eval_count;
  if (typeof d.prompt_eval_duration === 'number') s.promptEvalMs = Math.round(d.prompt_eval_duration / 1e6);
  if (typeof d.eval_count === 'number') s.evalTokens = d.eval_count;
  if (typeof d.eval_duration === 'number') s.evalMs = Math.round(d.eval_duration / 1e6);
  return Object.keys(s).length ? s : undefined;
}

/** Consume Ollama's NDJSON chat stream, emitting token deltas as they arrive. */
async function consumeOllamaStream(
  body: ReadableStream<Uint8Array>,
  onToken: (delta: string) => void,
  signal?: AbortSignal
): Promise<{ content: string; toolCalls: ToolCall[]; stats?: LlmCallStats }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let toolCalls: ToolCall[] = [];

  while (true) {
    if (signal?.aborted) break;
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        const delta = evt?.message?.content;
        if (typeof delta === 'string' && delta) {
          content += delta;
          onToken(delta);
        }
        if (Array.isArray(evt?.message?.tool_calls) && evt.message.tool_calls.length) {
          toolCalls = evt.message.tool_calls.map((tc: any, i: number) => ({
            id: `ollama-${Date.now()}-${i}`,
            name: tc.function?.name,
            arguments:
              typeof tc.function?.arguments === 'string'
                ? safeJsonParse(tc.function.arguments)
                : tc.function?.arguments || {}
          }));
        }
        if (evt?.done) return { content, toolCalls, stats: statsFromOllamaDone(evt) };
      } catch {
        /* partial line — ignore */
      }
    }
  }
  // Epilogue: some servers close the stream without a trailing newline (and
  // eval mocks send one complete JSON document). Process the leftover so a
  // well-formed final line is never dropped.
  if (buffer) {
    const line = buffer.trim();
    if (line) {
      try {
        const evt = JSON.parse(line);
        const delta = evt?.message?.content;
        if (typeof delta === 'string' && delta) {
          content += delta;
          onToken(delta);
        }
        if (Array.isArray(evt?.message?.tool_calls) && evt.message.tool_calls.length) {
          toolCalls = evt.message.tool_calls.map((tc: any, i: number) => ({
            id: `ollama-${Date.now()}-${i}`,
            name: tc.function?.name,
            arguments:
              typeof tc.function?.arguments === 'string'
                ? safeJsonParse(tc.function.arguments)
                : tc.function?.arguments || {}
          }));
        }
      } catch {
        /* trailing partial data — ignore */
      }
    }
  }
  return { content, toolCalls };
}

function safeJsonParse(s: string): Record<string, any> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ---------------- The loop ----------------

/**
 * P1.5a: re-inject the durable task ledger into the first system message every
 * iteration. If the ledger exists on disk it is rendered in full (so a resumed
 * run starts with progress, not amnesia); otherwise the model gets the usage
 * help for the `update_task` tool. Best-effort — a ledger failure must never
 * break the run.
 */
function refreshLedgerInPrompt(messages: LoopMessage[], root: string, runId: string | undefined): void {
  if (!runId) return;
  try {
    const block = renderLedgerBlock(loadLedger(root, runId));
    const sysIdx = messages.findIndex((m) => m.role === 'system');
    if (sysIdx === -1) {
      // No system message yet (priorMessages path): create one.
      messages.unshift({ role: 'system', content: renderLedgerHelp() + block });
      return;
    }
    // P3.4 prefix stability: only mutate the system message when the rendered
    // block ACTUALLY changed — rewriting identical content byte-for-byte would
    // still be a no-op for the model, but keeping the string reference stable
    // makes prompt-cache friendliness explicit.
    const next = upsertLedgerBlock(messages[sysIdx].content, block);
    if (next !== messages[sysIdx].content) messages[sysIdx].content = next;
  } catch {
    /* ledger refresh is best-effort */
  }
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxIterations = opts.maxIterations ?? 8;
  const messages: LoopMessage[] = opts.priorMessages
    ? [...opts.priorMessages]
    : [{ role: 'system', content: opts.systemContext }];
  if (!opts.priorMessages) {
    // RE7: trim history to last 20 turns
    for (const m of opts.history.slice(-20)) {
      messages.push({ role: m.role, content: m.content });
    }
  }

  messages.push({ role: 'user', content: opts.prompt });

  // P0.1: snapshot helper — failures must never break the run.
  const snapshot = (): void => {
    try {
      opts.onMessages?.([...messages]);
    } catch {
      /* snapshot is best-effort */
    }
  };
  if (opts.onMessages) snapshot();

  const toolResults: ToolResult[] = [];
  const filesChanged = new Set<string>();
  let reply = '';
  let usedTools = false;
  let lastFailedFingerprint = '';
  let failedRepeatCount = 0;

  // W2: backup dir created lazily on first actual write
  let lazyBackupDir: string | undefined;
  const toolOpts: ExecuteToolOptions = {
    signal: opts.signal,
    // P7.1: run-level default; the guard applies per-tool budgets inside
    timeoutMs: opts.toolTimeoutMs,
    verifyEdit: opts.verifyEdit,
    validateEdit: opts.validateEdit,
    onPlanUpdate: (steps) => {
      try {
        opts.onPlanUpdate?.(steps);
      } catch {}
      try {
        opts.onEvent?.({ type: 'plan_update', steps });
      } catch {}
    },
    runId: opts.runId,
    semanticSearch: opts.semanticSearch,
    runSubagent: opts.runSubagent,
    queryMemories: opts.queryMemories,
    remember: opts.remember,
    pluginTools: opts.pluginTools,
    get backupDir() {
      if (!lazyBackupDir) {
        lazyBackupDir = createBackupDir(opts.root, opts.sessionId || 'run');
      }
      return lazyBackupDir;
    }
  };

  let answeredWithoutTools = false;
  let planEmitted = false;
  let lastToolCallCount = 0;
  // P1.2 auto-verify state
  let editsSinceVerify = false;
  let healAttemptsUsed = 0;
  // P1.5d files already handed to the git committer
  let committedFiles = new Set<string>();
  // Only true when the for-loop genuinely exhausts maxIterations. Errors,
  // aborts, and the failed-call guard must NOT count as "budget reached",
  // otherwise the caller fires pointless auto-continue passes.
  let capGenuinelyReached = false;
  let stoppedBeforeCap = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    if (opts.signal?.aborted) throw new Error('cancelled');
    const iterStart = Date.now();
    opts.onEvent?.({ type: 'iteration', index: iter });

    // P1.5a: keep the durable task ledger fresh in the system prompt every
    // iteration so the model always knows current progress and next action.
    refreshLedgerInPrompt(messages, opts.root, opts.runId);

    // Context management (iter > 0): prefer P1.5b self-summarizing compaction
    // when the conversation nears the context budget; the LLM digests the
    // oldest turns into a dense summary instead of us dropping them blind.
    // If summarization is unavailable/fails, fall back to head truncation.
    let summarizedThisIter = false;
    let turnsDigested = 0;
    const ctxBudget = opts.sampling?.numCtxTokens;
    if (iter > 0 && ctxBudget && opts.endpoints.length > 0) {
      const usedTokens = estimateMessagesTokens(messages);
      opts.onEvent?.({ type: 'context_usage', usedTokens, budgetTokens: ctxBudget });
      if (usedTokens > ctxBudget * 0.75) {
        try {
          turnsDigested = await compactWithSummary(messages, {
            endpoint: opts.endpoints[0],
            modelId: opts.modelId,
            signal: opts.signal,
            keepRecentTurns: opts.compactionKeepTurns ?? 4,
            // P7.4: keep compaction non-lossy — full verbatim goes to
            // .opencode/memory/<runId>-<n>.md and the digest points at it.
            ...(opts.runId ? { root: opts.root, runId: opts.runId } : {})
          });
        } catch {
          turnsDigested = 0;
        }
        summarizedThisIter = turnsDigested > 0;
        if (summarizedThisIter) {
          opts.onEvent?.({ type: 'context_compacted', turnsDigested });
        }
      }
    }

    // Truncation-based compaction (fallback / below-budget upkeep): shrink tool
    // results from earlier iterations so long runs don't drown the model's
    // context window. The most recent iteration's results stay full; older ones keep only their head.
    if (iter > 0 && !summarizedThisIter) {
      const toolMsgs = messages.filter((m) => m.role === 'tool');
      const keepFull = Math.max(0, toolMsgs.length - lastToolCallCount);
      for (const m of toolMsgs.slice(0, keepFull)) {
        if (m.content.length > 1200) {
          m.content =
            m.content.slice(0, 500) +
            '\n…[older tool result truncated to save context — re-read with offset/limit if you need it again]';
        }
      }
      // Compact old assistant narration too: on long runs the model's own prose
      // accumulates and prompt-eval time grows every iteration (painful on local
      // LLMs). Keep only the head of assistant turns older than the last round.
      const asstMsgs = messages.filter((m) => m.role === 'assistant');
      const keepAsst = Math.max(0, asstMsgs.length - 2);
      for (const m of asstMsgs.slice(0, keepAsst)) {
        if (m.content.length > 600) {
          m.content = m.content.slice(0, 300) + '\n…[earlier narration truncated to save context]';
        }
      }
    }

    let llm: { content: string; toolCalls: ToolCall[]; stats?: LlmCallStats } | null = null;
    let lastError: Error | null = null;

    for (const ep of opts.endpoints) {
      try {
        llm = await callLLMWithTools(
          ep,
          opts.modelId,
          messages,
          toolSchemas(opts),
          opts.signal,
          opts.sampling,
          opts.onEvent ? (delta) => opts.onEvent!({ type: 'token', delta }) : undefined,
          opts.thinkingLevel
        );
        if (llm) break;
      } catch (err: any) {
        if (opts.signal?.aborted || err?.message === 'cancelled') throw new Error('cancelled');
        lastError = err;
        break; // RE3 retry already handled inside callLLMWithTools
      }
    }

    if (!llm) {
      const cls = classifyLlmError(lastError);
      if (iter === 0) {
        throw new Error(humanizeLlmError(lastError) || 'no local LLM reachable at any endpoint');
      }
      // Visible, CATEGORIZED failure instead of a silent empty reply mid-run
      stoppedBeforeCap = true;
      opts.onEvent?.({
        type: 'token',
        delta:
          `\n\n[error:${cls.category}] Model stopped responding after iteration ${iter}${lastError ? ` (${lastError.message})` : ''}. Showing partial result so far.` +
          (cls.guidance ? `\nRecovery hint: ${cls.guidance}` : '')
      });
      break;
    }

    reply = llm.content || reply;

    // Live plan tracking: when the model states a numbered plan, broadcast the
    // items once so streaming UIs can show per-step progress.
    if (!planEmitted && llm.content) {
      const items = (llm.content.match(/^\s*\d+[.)]\s+(.{3,140})/gm) || [])
        .map((l) => l.replace(/^\s*\d+[.)]\s+/, '').trim())
        .filter((t) => !/^https?:/.test(t))
        .slice(0, 8);
      if (items.length >= 2) {
        planEmitted = true;
        opts.onEvent?.({ type: 'plan', items });
      }
    }

    // Some models (qwen3) refuse native tool calls and instead emit the actions
    // as a fenced ```json block. Recover them so they go through the SAME
    // permission-gated execution path below (never bypass the gate).
    if (!llm.toolCalls.length && llm.content) {
      const batch = parseJsonActionBlock(llm.content);
      if (batch) {
        // Drop the raw fence from the reply so the user sees prose, not JSON
        const stripped = llm.content.replace(/```json[\s\S]*?```/g, '').trim();
        if (stripped) llm.content = stripped;
        const ts = Date.now();
        let n = 0;
        for (const p of batch.patches || []) {
          llm.toolCalls.push({
            id: `jsonbatch-${ts}-${n++}`,
            name: 'apply_patch',
            arguments: { path: p.filePath, oldText: p.oldText, newText: p.newText, ...(p.patch ? { patch: p.patch } : {}) }
          });
        }
        for (const f of batch.modifiedFiles || []) {
          llm.toolCalls.push({
            id: `jsonbatch-${ts}-${n++}`,
            name: 'write_file',
            arguments: { path: f.filePath, content: f.content }
          });
        }
      }
    }

    if (!llm.toolCalls.length) {
      answeredWithoutTools = true;
      // P3.4/P2.3: the final iteration still reports its timing + inference stats
      opts.onEvent?.({
        type: 'iteration_end',
        index: iter,
        durationMs: Date.now() - iterStart,
        ...(llm.stats || {})
      });
      break; // final textual answer
    }

    lastToolCallCount = llm.toolCalls.length;
    usedTools = true;
    messages.push({
      role: 'assistant',
      content: llm.content || '',
      ...(llm.toolCalls.length
        ? {
            tool_calls: llm.toolCalls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: JSON.stringify(c.arguments) }
            }))
          }
        : {})
    });

    // ---------------- P7.1 batch scheduler ----------------
    // Consecutive runs of >= 2 parallel-safe tools (pure, state-free, read-only:
    // list_files / search / file_outline) fan out CONCURRENTLY: every dispatch
    // event is emitted before any result is awaited (Promise.allSettled), but
    // results are recorded in model-declared order so the transcript is
    // deterministic. Everything else — writes, patches, commands, subagents,
    // plugins, and a lone read-only call — runs strictly sequential through
    // runOneSequential, preserving P2.2 review gates, RE4 permission gates,
    // and the 5x failed-call guard exactly as before.
    const runOneSequential = async (callIn: ToolCall): Promise<boolean> => {
      // returns true when the failed-call guard stopped the round
      let call = callIn;
      opts.onEvent?.({ type: 'tool_call', name: call.name, arguments: call.arguments });

      // P2.2 diff-review gate: user accepts/rejects hunks BEFORE execution;
      // the returned call may carry rewritten arguments (accepted hunks only).
      if (
        (call.name === 'write_file' || call.name === 'apply_patch') &&
        opts.reviewEdit
      ) {
        let reviewed: ToolCall | null = null;
        try {
          reviewed = await opts.reviewEdit(call);
        } catch (err: any) {
          const fail: ToolResult = {
            callId: call.id,
            name: call.name,
            ok: false,
            content: `ERROR: review gate failed — ${err?.message || err}`
          };
          toolResults.push(fail);
          opts.onEvent?.({ type: 'tool_result', result: fail });
          opts.onToolResult?.(fail);
          messages.push({ role: 'tool', content: fail.content, tool_call_id: call.id });
          return false;
        }
        if (!reviewed) {
          const denied: ToolResult = {
            callId: call.id,
            name: call.name,
            ok: false,
            content: 'DENIED in diff review. Do not retry this exact edit; adjust it or proceed without it.'
          };
          toolResults.push(denied);
          opts.onEvent?.({ type: 'tool_result', result: denied });
          opts.onToolResult?.(denied);
          messages.push({ role: 'tool', content: denied.content, tool_call_id: denied.callId });
          return false;
        }
        call = reviewed;
      }

      // RE4: permission gate on side-effecting tools
      if (
        (call.name === 'write_file' || call.name === 'apply_patch' || call.name === 'run_command') &&
        opts.requestPermission
      ) {
        const allowed = await opts.requestPermission(call.name, call.arguments);
        if (!allowed) {
          const denied: ToolResult = {
            callId: call.id,
            name: call.name,
            ok: false,
            content: 'DENIED by user. Do not retry this action; proceed without it or explain.'
          };
          toolResults.push(denied);
          opts.onToolResult?.(denied);
          messages.push({ role: 'tool', content: denied.content, tool_call_id: denied.callId });
          return false;
        }
      }

      const result = await executeTool(opts.root, call, toolOpts);
      toolResults.push(result);
      opts.onEvent?.({ type: 'tool_result', result });
      opts.onToolResult?.(result);

      // P1.4 error taxonomy: failed calls get a CATEGORY + tailored recovery
      // hint appended to the message the model sees next iteration.
      let failureGuidance = '';
      if (!result.ok) {
        const cls = classifyToolFailure(result.content);
        if (cls.category !== 'cancelled' && cls.guidance) {
          failureGuidance = `\n\n[${cls.category}] Recovery: ${cls.guidance}`;
        }
      }

      // Phase 7 no-op guard: stop when the model repeats identical failing calls
      const fingerprint = `${call.name}:${JSON.stringify(call.arguments)}:${result.ok}`;
      if (!result.ok) {
        if (lastFailedFingerprint === fingerprint) {
          failedRepeatCount++;
        } else {
          lastFailedFingerprint = fingerprint;
          failedRepeatCount = 1;
        }
        if (failedRepeatCount >= 5) {
          // Visible signal in the stream so users know why the run stopped early
          opts.onEvent?.({
            type: 'token',
            delta: `\n\n[agent stopped: "${call.name}" has now failed ${failedRepeatCount} times with identical arguments — escalating for a final summary]`
          });
          messages.push({
            role: 'tool',
            content: `The same action has failed ${failedRepeatCount} times with identical arguments. STOP retrying it. Summarize progress, and state what remains and why it is failing.`,
            tool_call_id: call.id
          });
          stoppedBeforeCap = true;
          return true; // next iteration asks the model to summarize
        }
      } else {
        lastFailedFingerprint = '';
        failedRepeatCount = 0;
      }

      if ((call.name === 'write_file' || call.name === 'apply_patch') && result.ok) {
        filesChanged.add(String(call.arguments.path));
        editsSinceVerify = true;
        opts.onEvent?.({ type: 'files_changed', files: [...filesChanged] });
        // P1.5a: auto-track the file in the durable ledger (best-effort).
        if (opts.runId) {
          try {
            recordFileTouched(opts.root, opts.runId, String(call.arguments.path));
          } catch {
            /* ledger is best-effort */
          }
        }
      }

      messages.push({
        role: 'tool',
        content:
          result.content.slice(0, 12000) +
          (failureGuidance ? `\n${failureGuidance}` : ''),
        tool_call_id: result.callId
      });
      return false;
    };

    {
      const roundCalls = llm.toolCalls;
      let roundIdx = 0;
      while (roundIdx < roundCalls.length) {
        if (opts.signal?.aborted) throw new Error('cancelled');

        // Maximal run of parallel-safe tools starting at roundIdx.
        let runEnd = roundIdx;
        while (runEnd < roundCalls.length && isReadOnlyParallelTool(roundCalls[runEnd].name)) runEnd++;
        const run = roundCalls.slice(roundIdx, runEnd);

        if (run.length >= 2) {
          // Dispatch EVERY call first (events in model order), then collect
          // them all — this is what makes the fan-out observable and gives
          // every call a concurrent shot at the budget.
          for (const cl of run) {
            opts.onEvent?.({ type: 'tool_call', name: cl.name, arguments: cl.arguments });
          }
          const settled = await Promise.allSettled(
            run.map((cl) => executeTool(opts.root, cl, toolOpts))
          );
          for (let b = 0; b < run.length; b++) {
            const cl = run[b];
            const st = settled[b];
            const result: ToolResult =
              st.status === 'fulfilled'
                ? st.value
                : toolError(cl.name, cl.id, st.reason);
            toolResults.push(result);
            opts.onEvent?.({ type: 'tool_result', result });
            opts.onToolResult?.(result);
            // Read-only batch calls cannot change files; a success simply
            // clears any pending failed-repeat streak (the 5x guard itself is
            // for mutating actions and runs only in runOneSequential).
            if (result.ok) {
              lastFailedFingerprint = '';
              failedRepeatCount = 0;
            }
            let failureGuidance = '';
            if (!result.ok) {
              const cls = classifyToolFailure(result.content);
              if (cls.category !== 'cancelled' && cls.guidance) {
                failureGuidance = `\n\n[${cls.category}] Recovery: ${cls.guidance}`;
              }
            }
            messages.push({
              role: 'tool',
              content:
                result.content.slice(0, 12000) +
                (failureGuidance ? `\n${failureGuidance}` : ''),
              tool_call_id: result.callId
            });
          }
          roundIdx = runEnd;
          continue;
        }

        // Single call: strictly sequential (gates + guard apply here).
        const stopped = await runOneSequential(roundCalls[roundIdx]);
        roundIdx += 1;
        if (stopped) break; // guard escalated; next LLM iteration summarizes
      }
    }

    // P1.2 auto-verify: after an iteration that edited files, run the
    // project's verify commands; failures are fed back into the loop so the
    // model self-heals immediately instead of failing end-of-run.
    const editedThisIter = editsSinceVerify;
    let stepVerifiedOk = !opts.autoVerify || opts.autoVerify.commands.length === 0;
    if (editedThisIter && opts.autoVerify && opts.autoVerify.commands.length > 0) {
      editsSinceVerify = false;
      const maxHeals = opts.autoVerify.maxHealAttempts ?? 3;
      const commands = opts.autoVerify.commands;
      const cmdNames = commands.map((c) => c.command);
      opts.onEvent?.({ type: 'verify_start', commands: cmdNames });
      let results: VerifyResult[] = [];
      try {
        results = await runVerification(opts.root, commands);
      } catch (err: any) {
        results = [
          {
            command: { name: 'verify', command: cmdNames[0] || 'verify' },
            ok: false,
            exitCode: -1,
            durationMs: 0,
            output: `verification runner error: ${err?.message || err}`
          }
        ];
      }
      const allOk = results.length > 0 && results.every((r) => r.ok);
      stepVerifiedOk = allOk;
      opts.onEvent?.({
        type: 'verify_result',
        ok: allOk,
        results: results.map((r) => ({
          command: r.command.command,
          ok: r.ok,
          exitCode: r.exitCode,
          durationMs: r.durationMs
        }))
      });

      if (!allOk) {
        if (healAttemptsUsed < maxHeals) {
          healAttemptsUsed++;
          opts.onEvent?.({ type: 'verify_heal', attempt: healAttemptsUsed, maxAttempts: maxHeals });
          messages.push({ role: 'user', content: renderVerificationFailure(results) });
          snapshot();
          continue; // next iteration: model sees the failures and heals
        }
        // Heal budget exhausted — stop with a visible reason.
        stoppedBeforeCap = true;
        opts.onEvent?.({
          type: 'token',
          delta: `\n\n[auto-verify still failing after ${maxHeals} heal attempts — stopping for review]`
        });
        messages.push({
          role: 'user',
          content:
            renderVerificationFailure(results) +
            `\n\nThe automatic heal budget (${maxHeals} attempts) is exhausted. Summarize what is broken and what remains.`
        });
        break;
      }
    }

    // P1.5d git-first workflow: auto-commit each VERIFIED step (or, without
    // verification configured, each edit batch). Best-effort, never blocking.
    if (editedThisIter && stepVerifiedOk && opts.onStepVerified) {
      const pending = [...filesChanged].filter((f) => !committedFiles.has(f));
      if (pending.length) {
        for (const f of pending) committedFiles.add(f);
        try {
          opts.onStepVerified(pending, reply.slice(0, 120));
        } catch {
          /* git workflow is best-effort */
        }
      }
    }

    // P2.3: per-iteration timing for the live dashboard
    opts.onEvent?.({
      type: 'iteration_end',
      index: iter,
      durationMs: Date.now() - iterStart,
      ...(llm.stats || {})
    });

    // P0.1: snapshot the full message list every iteration so a crash here
    // loses at most one iteration of work.
    snapshot();
  }

  capGenuinelyReached = !answeredWithoutTools && !stoppedBeforeCap;
  snapshot(); // final snapshot so callers can diff/save even on early answer

  return {
    reply,
    iterations: toolResults.length,
    toolCalls: toolResults,
    filesChanged: [...filesChanged],
    usedTools,
    hitIterationCap: capGenuinelyReached,
    messages
  };
}

// ---------------- Fallback: structured-JSON actions (non-tool models) ----------------

export interface JsonActionBatch {
  modifiedFiles: Array<{ filePath: string; content: string }>;
  patches?: Array<{ filePath: string; oldText?: string; newText?: string; patch?: string }>;
  commandToRun?: string;
}

export function parseJsonActionBlock(text: string): JsonActionBatch | null {
  const m = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    if (!parsed.modifiedFiles && !parsed.patches) return null;
    return parsed as JsonActionBatch;
  } catch {
    return null;
  }
}

export async function executeJsonActions(
  root: string,
  batch: JsonActionBatch,
  onAction?: (r: ToolResult) => void
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  let counter = 0;
  const mkCall = (name: string, args: Record<string, any>): ToolCall => ({
    id: `fallback-${Date.now()}-${counter++}`,
    name,
    arguments: args
  });

  for (const p of batch.patches || []) {
    const r = await executeTool(root, mkCall('apply_patch', {
      path: p.filePath,
      oldText: p.oldText,
      newText: p.newText,
      ...(typeof p.patch === 'string' ? { patch: p.patch } : {})
    } as Record<string, any>));
    results.push(r);
    onAction?.(r);
  }
  for (const f of batch.modifiedFiles || []) {
    const r = await executeTool(root, mkCall('write_file', { path: f.filePath, content: f.content }));
    results.push(r);
    onAction?.(r);
  }
  return results;
}
