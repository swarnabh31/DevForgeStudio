/**
 * P1.5b Self-summarizing compaction + P1.5c groundwork (token accountant).
 *
 * When the running conversation nears the model's context budget, the oldest
 * turns are replaced by a single LLM-generated digest BEFORE num_ctx overflow,
 * instead of destructively head-truncating tool results. The digest is
 * instructed to preserve exactly what matters across long sessions: decisions,
 * file paths + what was learned about them, errors hit + fixes applied, and
 * open work.
 */

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

function renderDigest(digest: string, turnsDigested: number): string {
  return (
    `${DIGEST_MARKER} — ${turnsDigested} older turn(s) summarized to save context] ===\n` +
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

  const replacement: CompactionMessage = {
    role: 'user',
    content: renderDigest(digest, digested.length)
  };
  messages.splice(startIdx, endIdx - startIdx, replacement);
  return digested.length;
}
