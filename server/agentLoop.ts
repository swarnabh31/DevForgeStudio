import fs from 'fs';
import path from 'path';
import { execFile, exec } from 'child_process';
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
  /** Directory where pre-edit snapshots are stored (Phase 3 safety net). */
  backupDir?: string;
  /**
   * Post-edit verification: return a human-readable diagnostics summary for the
   * changed file (empty string = clean). Appended to the tool result so the
   * model can self-correct.
   */
  verifyEdit?: (relPath: string) => string;
}

export type LoopEvent =
  | { type: 'iteration'; index: number }
  | { type: 'token'; delta: string }
  | { type: 'tool_call'; name: string; arguments: Record<string, any> }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'permission_request'; runId: string; toolName: string; summary: string }
  | { type: 'files_changed'; files: string[] }
  | { type: 'plan'; items: string[] };

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
  sampling?: { temperature: number; topP: number; repeatPenalty: number; numCtxTokens: number };
  /** 'none' appends the qwen3 /no_think soft switch and strips <think> blocks */
  thinkingLevel?: 'none' | 'low' | 'medium' | 'high';
  /** Used only to name the run's backup directory */
  sessionId?: string;
  /** E3 post-edit verification hook — returns diagnostics summary (empty = clean) */
  verifyEdit?: (relPath: string) => string;
  /** Live event feed for streaming UIs */
  onEvent?: (evt: LoopEvent) => void;
  /** RE4: ask before write_file/apply_patch/run_command; false denies the tool call */
  requestPermission?: (toolName: string, args: Record<string, any>) => Promise<boolean>;
  onToolResult?: (result: ToolResult) => void;
}

export interface AgentLoopResult {
  reply: string;
  iterations: number;
  toolCalls: ToolResult[];
  filesChanged: string[];
  usedTools: boolean;
  /** True when the loop exhausted maxIterations without the model producing a final answer */
  hitIterationCap?: boolean;
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
        'Edit an existing file by replacing an exact snippet. oldText must match the current file exactly and be unique. Include enough surrounding lines to be unambiguous.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldText: { type: 'string' },
          newText: { type: 'string' }
        },
        required: ['path', 'oldText', 'newText']
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
  }
];

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
  const signal = options.signal;
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

      case 'write_file': {
        const userPath = String(call.arguments.path);
        const content = String(call.arguments.content ?? '');
        const abs = resolveSafePath(root, userPath);

        // Binary-extension safety
        if (!TEXT_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
          return { callId: call.id, name: call.name, ok: false, content: `ERROR: refusing to write non-text extension ${path.extname(abs)}` };
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
        const oldText = String(call.arguments.oldText ?? '');
        const newText = String(call.arguments.newText ?? '');
        const abs = resolveSafePath(root, userPath);

        if (!oldText) {
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

        const count = current.split(oldText).length - 1;
        if (count === 0) {
          return { callId: call.id, name: call.name, ok: false, content: 'ERROR: oldText not found in file. Read the file again and copy the exact text including whitespace.' };
        }
        if (count > 1) {
          return { callId: call.id, name: call.name, ok: false, content: `ERROR: oldText matches ${count} locations. Include more surrounding lines to make it unique.` };
        }

        // W2: snapshot before patching
        if (options.backupDir) backupFileBeforeWrite(root, abs, options.backupDir);

        const updated = current.replace(oldText, () => newText);
        const tmp = abs + '.ocastmp';
        fs.writeFileSync(tmp, updated, 'utf-8');
        fs.renameSync(tmp, abs);
        recordMtime(abs);

        const added = newText ? newText.split('\n').length : 0;
        const removed = oldText.split('\n').length;
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
        return await new Promise<ToolResult>((resolve) => {
          exec(
            command,
            { cwd: root, timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
            (err, stdout, stderr) => {
              const code = (err as any)?.code;
              const exitCode = typeof code === 'number' ? code : err ? 1 : 0;
              const out = [stdout, stderr].filter(Boolean).join('\n--- stderr ---\n').slice(0, 8000);
              resolve({
                callId: call.id,
                name: call.name,
                ok: exitCode === 0,
                content: `exit=${exitCode}\n${out || '(no output)'}`
              });
            }
          );
        });
      }

      case 'git_diff': {
        return await new Promise<ToolResult>((resolve) => {
          execFile('git', ['diff'], { cwd: root, maxBuffer: 4 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
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
          });
          if (signal?.aborted) {
            resolve({ callId: call.id, name: call.name, ok: false, content: 'ERROR: cancelled' });
          }
        });
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
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/g, '');
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
): Promise<{ content: string; toolCalls: ToolCall[] } | null> {
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
        180000
      );
      if (resp.ok && resp.body && wantsStream) {
        const parsed = await consumeOllamaStream(resp.body, onToken!, signal);
        const cleaned = stripThinkBlocks(parsed.content);
        if (cleaned.trim() || parsed.toolCalls.length) return { content: cleaned, toolCalls: parsed.toolCalls };
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
            return { content: msg.content || '', toolCalls: calls };
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
        180000
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
            return { content: stripThinkBlocks(msg.content || ''), toolCalls: calls };
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

/** Consume Ollama's NDJSON chat stream, emitting token deltas as they arrive. */
async function consumeOllamaStream(
  body: ReadableStream<Uint8Array>,
  onToken: (delta: string) => void,
  signal?: AbortSignal
): Promise<{ content: string; toolCalls: ToolCall[] }> {
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
        if (evt?.done) return { content, toolCalls };
      } catch {
        /* partial line — ignore */
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

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxIterations = opts.maxIterations ?? 8;
  const messages: LoopMessage[] = [{ role: 'system', content: opts.systemContext }];

  // RE7: trim history to last 10 turns
  for (const m of opts.history.slice(-10)) {
    messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: 'user', content: opts.prompt });

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
    verifyEdit: opts.verifyEdit,
    get backupDir() {
      if (!lazyBackupDir) {
        lazyBackupDir = createBackupDir(opts.root, opts.sessionId || 'run');
      }
      return lazyBackupDir;
    }
  };

  let answeredWithoutTools = false;
  let planEmitted = false;

  for (let iter = 0; iter < maxIterations; iter++) {
    if (opts.signal?.aborted) throw new Error('cancelled');
    opts.onEvent?.({ type: 'iteration', index: iter });

    // Context compaction: shrink tool results from earlier iterations so long
    // runs don't drown the model's context window. The most recent iteration's
    // results stay full; older ones keep only their head.
    if (iter > 0) {
      for (const m of messages) {
        if (m.role === 'tool' && m.content.length > 1200) {
          m.content =
            m.content.slice(0, 500) +
            '\n…[older tool result truncated to save context — re-read with offset/limit if you need it again]';
        }
      }
    }

    let llm: { content: string; toolCalls: ToolCall[] } | null = null;
    let lastError: Error | null = null;

    for (const ep of opts.endpoints) {
      try {
        llm = await callLLMWithTools(
          ep,
          opts.modelId,
          messages,
          TOOL_SCHEMAS,
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
      if (iter === 0) {
        throw new Error(humanizeLlmError(lastError) || 'no local LLM reachable at any endpoint');
      }
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

    if (!llm.toolCalls.length) {
      answeredWithoutTools = true;
      break; // final textual answer
    }

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

    for (const call of llm.toolCalls) {
      if (opts.signal?.aborted) throw new Error('cancelled');
      opts.onEvent?.({ type: 'tool_call', name: call.name, arguments: call.arguments });

      // RE4: permission gate on side-effecting tools
      if (
        (call.name === 'write_file' || call.name === 'apply_patch' || call.name === 'run_command') &&
        opts.requestPermission
      ) {
        const summary = call.name === 'run_command'
          ? String(call.arguments.command || '')
          : `${call.name}: ${String(call.arguments.path)}`;
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
          continue;
        }
      }

      const result = await executeTool(opts.root, call, toolOpts);
      toolResults.push(result);
      opts.onEvent?.({ type: 'tool_result', result });
      opts.onToolResult?.(result);

      // Phase 7 no-op guard: stop when the model repeats identical failing calls
      const fingerprint = `${call.name}:${JSON.stringify(call.arguments)}:${result.ok}`;
      if (!result.ok) {
        if (lastFailedFingerprint === fingerprint) {
          failedRepeatCount++;
        } else {
          lastFailedFingerprint = fingerprint;
          failedRepeatCount = 1;
        }
        if (failedRepeatCount >= 3) {
          messages.push({
            role: 'tool',
            content: 'Stopping: the same action has failed repeatedly. Summarize progress and what remains.',
            tool_call_id: call.id
          });
          break;
        }
      } else {
        lastFailedFingerprint = '';
        failedRepeatCount = 0;
      }

      if ((call.name === 'write_file' || call.name === 'apply_patch') && result.ok) {
        filesChanged.add(String(call.arguments.path));
        opts.onEvent?.({ type: 'files_changed', files: [...filesChanged] });
      }

      messages.push({
        role: 'tool',
        content: result.content.slice(0, 12000),
        tool_call_id: result.callId
      });
    }
  }

  return {
    reply,
    iterations: toolResults.length,
    toolCalls: toolResults,
    filesChanged: [...filesChanged],
    usedTools,
    hitIterationCap: !answeredWithoutTools
  };
}

// ---------------- Fallback: structured-JSON actions (non-tool models) ----------------

export interface JsonActionBatch {
  modifiedFiles: Array<{ filePath: string; content: string }>;
  patches?: Array<{ filePath: string; oldText: string; newText: string }>;
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
    const r = await executeTool(root, mkCall('apply_patch', p));
    results.push(r);
    onAction?.(r);
  }
  for (const f of batch.modifiedFiles || []) {
    const r = await executeTool(root, mkCall('write_file', f));
    results.push(r);
    onAction?.(r);
  }
  return results;
}
