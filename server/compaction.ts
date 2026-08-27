import fs from 'fs';
import path from 'path';

// P1.5b Self-summarizing compaction + P1.5c groundwork (token accountant).
//
// When the running conversation nears the model's context budget, the oldest
// turns are replaced by a single LLM-generated digest BEFORE num_ctx overflow,
// instead of destructively head-truncating tool results. The digest is
// instructed to preserve exactly what matters across long sessions: decisions,
// file paths + what was learned about them, errors hit + fixes applied, and
// open work.
//
// P7.4 non-lossy mode: before replacing digested turns, the full verbatim
// transcript is persisted to <root>/.opencode/memory/<runId>-<n>.md and the
// digest carries a pointer to it, so the agent can read_file the full detail
// back at any time.

export interface CompactionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

// ---------------- Token accountant (P1.5c groundwork) ----------------

/** Per-message overhead (role framing, separators) in estimated tokens. */
const PER_MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Chars→tokens heuristic (~4 chars/token for code+English mix). Good enough to
 * decide WHEN to compact; no tokenizer dependency on purpose (local-first, zero deps).
 */
export function estimateMessagesTokens(messages: Array<{ content: string }>): number {
  let chars = 0;
  for (const m of messages) chars += (m.content?.length || 0) + PER_MESSAGE_OVERHEAD_TOKENS * 4;
  return Math.ceil(chars / 4);
}

// ---------------- Turn segmentation ----------------

export interface TurnSegment {
  start: number;
  end: number; // exclusive
}

/**
 * Group flat message list into conversational turns. A turn starts at a 'user'
 * message, or at any assistant message NOT immediately following a tool result
 * (an assistant right after tool output is a NEW iteration; an assistant right
 * after the user prompt belongs to that user's turn). Tool results attach to
 * the current turn, so an assistant/tool_call pair is never split mid-way.
 */
export function segmentTurns(messages: CompactionMessage[]): TurnSegment[] {
  const segments: TurnSegment[] = [];
  let start = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const prev = i > 0 ? messages[i - 1] : undefined;
    const startsTurn =
      m.role === 'user' || (m.role === 'assistant' && !!prev && prev.role !== 'user');
    if (startsTurn) {
      if (start !== -1) segments.push({ start, end: i });
      start = i;
    }
  }
  if (start !== -1) segments.push({ start, end: messages.length });
  return segments;
}

// ---------------- Digest generation ----------------

const DIGEST_MARKER = '=== CONVERSATION DIGEST';

function buildSummarizationPrompt(transcript: string): string {
  return (
    'You are compressing part of an ongoing coding-agent conversation so work can continue ' +
    'in a limited context window. Produce a DENSE digest (max ~350 words) preserving ONLY ' +
    'durable facts. Use these exact sections:\n' +
    'Decisions: choices made and why\n' +
    'Files: every file path mentioned, with one line on what was done/learned there\n' +
    'Errors & Fixes: errors encountered and how each was resolved\n' +
    'Remaining: unfinished steps / next actions\n' +
    'Never invent information. Omit pleasantries and narration.\n\n' +
    'CONVERSATION EXCERPT:\n' +
    transcript
  );
}

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

async function summarizeWithLlm(
  endpoint: string,
  modelId: string,
  transcript: string,
  signal?: AbortSignal,
  timeoutMs = 120000
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const resp = await fetch(`${endpoint.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: buildSummarizationPrompt(transcript) }],
        stream: false,
        options: { temperature: 0.2 }
      }),
      signal: controller.signal
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const content = data?.message?.content;
    const cleaned = typeof content === 'string' ? stripThink(content) : '';
    return cleaned.length > 40 ? cleaned : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function renderDigest(
  digest: string,
  turnsDigested: number,
  pointer?: { relPath: string; chars: number }
): string {
  const pointerLine = pointer
    ? '\nFull verbatim transcript (re-read for exact detail): ' +
      `read_file ${pointer.relPath} (${pointer.chars} chars)\n`
    : '';
  return (
    `${DIGEST_MARKER} — ${turnsDigested} older turn(s) summarized to save context] ===\n` +
    pointerLine +
    digest +
    '\n=== END DIGEST ==='
  );
}

// ---------------- The compaction entry point ----------------

export interface CompactionOptions {
  endpoint: string;
  modelId: string;
  signal?: AbortSignal;
  /** Turns kept verbatim at the tail of the conversation (default 4). */
  keepRecentTurns?: number;
  /** Never digest more than this many turns in one pass (default 12). */
  maxTurnsPerPass?: number;
  /**
   * P7.4 non-lossy compaction: when set (with `runId`), the full verbatim
   * transcript of the digested turns is written to `<root>/.opencode/memory/`
   * and the digest references it by pointer. Best-effort — IO failure falls
   * back to the plain digest and never breaks the run.
   */
  root?: string;
  runId?: string;
}

/**
 * P7.4: persist the digested window verbatim so nothing is lost to
 * summarization. Returns the relative path the agent can `read_file`.
 * The path is derived from `runId` + a per-run sequence number, so repeated
 * compactions in the same run append distinct files instead of overwriting
 * each other (window size alone is NOT unique: several compactions can digest
 * the same number of messages).
 * Best-effort: returns null on any error (bad runId, IO failure, etc.).
 */
function nextTranscriptSeq(rootAbs: string, safeRun: string): number {
  try {
    const dir = path.join(rootAbs, '.opencode', 'memory');
    let max = 0;
    for (const n of fs.readdirSync(dir)) {
      const m = n.match(new RegExp('^' + safeRun + '-c(\\d+)\\.md$'));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max + 1;
  } catch {
    return 1;
  }
}

function writeNonLossyTranscript(
  rootAbs: string,
  runId: string,
  messages: CompactionMessage[],
  seq: number
): string | null {
  try {
    const safeRun = runId.replace(/[^\w-]/g, '_').slice(0, 64);
    if (!safeRun) return null;
    const dir = path.join(rootAbs, '.opencode', 'memory');
    const relPath = `.opencode/memory/${safeRun}-c${seq}.md`;
    const parts: string[] = [
      `# Conversation transcript — ${safeRun} (compaction ${seq})`,
      '',
      `Captured ${new Date().toISOString()} during self-summarizing compaction.`,
      `This file holds the FULL verbatim turns that the digest in the live context`,
      `replaced. Read it back (read_file ${relPath}) whenever exact detail is needed.`,
      ''
    ];
    for (const m of messages) {
      const calls = m.tool_calls
        ?.map((c) => ` [tool_call: ${c.function.name} ${c.function.arguments}]`)
        .join('');
      parts.push(`## [${m.role}]${calls || m.tool_call_id ? ' [tool_result]' : ''}`);
      parts.push('');
      parts.push(m.content || '(empty)');
      parts.push('');
    }
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(rootAbs, relPath);
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, parts.join('\n'), 'utf-8');
    fs.renameSync(tmp, target);
    return relPath;
  } catch {
    return null;
  }
}

/**
 * Replace the oldest turns (between the system prompt and the recent window)
 * with a single digest message, in place. Returns the number of turns digested
 * (0 = nothing compacted / summarization unavailable, so the caller's
 * truncation fallback still applies).
 *
 * The first system message and the final user turn are never digested.
 */
export async function compactWithSummary(
  messages: CompactionMessage[],
  opts: CompactionOptions
): Promise<number> {
  if (messages.length < 6) return 0;
  const keepRecentTurns = opts.keepRecentTurns ?? 4;
  const maxTurnsPerPass = opts.maxTurnsPerPass ?? 12;

  // System messages stay pinned at the front
  let sysEnd = 0;
  while (sysEnd < messages.length && messages[sysEnd].role === 'system') sysEnd++;

  const body = messages.slice(sysEnd);
  const segments = segmentTurns(body);
  if (segments.length <= keepRecentTurns) return 0;

  const digestCount = Math.min(segments.length - keepRecentTurns, maxTurnsPerPass);
  const digested = segments.slice(0, digestCount);
  const startIdx = sysEnd + digested[0].start;
  const endIdx = sysEnd + digested[digested.length - 1].end;

  const transcript = messages
    .slice(startIdx, endIdx)
    .map((m) => `[${m.role}] ${(m.content || '(tool call)').slice(0, 1500)}`)
    .join('\n')
    .slice(0, 24000);

  const digest = await summarizeWithLlm(opts.endpoint, opts.modelId, transcript, opts.signal);
  if (!digest) return 0;

  // P7.4: persist the digested window verbatim BEFORE we splice it out of the
  // live message array — this is the whole point of non-lossy compaction.
  let pointer: { relPath: string; chars: number } | undefined;
  if (opts.root && opts.runId) {
    const safeRun = opts.runId.replace(/[^\w-]/g, '_').slice(0, 64);
    if (safeRun) {
      const seq = nextTranscriptSeq(opts.root, safeRun);
      const verbatim = messages.slice(startIdx, endIdx);
      const relPath = writeNonLossyTranscript(opts.root, opts.runId, verbatim, seq);
      if (relPath) {
        pointer = { relPath, chars: verbatim.reduce((n, m) => n + (m.content?.length || 0), 0) };
      }
    }
  }

  const replacement: CompactionMessage = {
    role: 'user',
    content: renderDigest(digest, digested.length, pointer)
  };
  messages.splice(startIdx, endIdx - startIdx, replacement);
  return digested.length;
}
