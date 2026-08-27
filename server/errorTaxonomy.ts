/**
 * P1.4 Error taxonomy.
 *
 * Classifies agent failures into categories with DISTINCT recovery strategies,
 * replacing generic "retry" nudges:
 * - cancelled        run aborted by user
 * - network          local LLM endpoint unreachable / socket failures
 * - timeout          command or request exceeded its budget
 * - model_format     model emitted malformed arguments / JSON
 * - permission       user denied the action — never retry
 * - conflict         file changed externally mid-run — re-read first
 * - validation_gate  edit rejected by syntax/import gate — fix code, don't retry blind
 * - patch_match      fuzzy patch didn't match — copy exact text from file
 * - missing_input    tool called without required payload
 * - filesystem       missing files, binary reads, etc.
 * - command          allowlisted command ran and failed (exit != 0) — expected signal
 * - unknown
 */

export type ErrorCategory =
  | 'cancelled'
  | 'network'
  | 'timeout'
  | 'model_format'
  | 'permission'
  | 'conflict'
  | 'validation_gate'
  | 'patch_match'
  | 'missing_input'
  | 'filesystem'
  | 'command'
  | 'unknown';

export interface FailureClassification {
  category: ErrorCategory;
  /** true when retrying the identical call could plausibly succeed */
  retryable: boolean;
  /** one-line recovery instruction appended to the failed tool result */
  guidance: string;
}

const RULES: Array<{ category: ErrorCategory; pattern: RegExp; retryable: boolean; guidance: string }> = [
  {
    category: 'permission',
    pattern: /DENIED (?:by user|in diff review)/i,
    retryable: false,
    guidance: 'The user refused this action. Do NOT repeat it — adjust the approach or explain what you need.'
  },
  {
    category: 'conflict',
    pattern: /CONFLICT — this file was modified outside/i,
    retryable: false,
    guidance: 'The file changed since you last read it. read_file it again and re-apply your edit on the FRESH content.'
  },
  {
    category: 'validation_gate',
    pattern: /EDIT REJECTED BY VALIDATION GATE/i,
    retryable: true,
    guidance: 'Your proposed content is invalid. Fix the reported syntax/import issue in your newText/content, then re-apply.'
  },
  {
    category: 'patch_match',
    pattern: /(similarity|best.?match|No @@ hunks|not found in file|oldText\s+(not found|.*?not unique))/i,
    retryable: true,
    guidance: 'Your patch text did not match the file. Re-read the exact region with read_file (use offset/limit) and copy text VERBATIM into oldText/context lines.'
  },
  {
    category: 'model_format',
    pattern: /(invalid json|failed to parse|expects .* property|missing required|no edit payload|must be of type)/i,
    retryable: true,
    guidance: 'Your tool call arguments were malformed. Re-issue the call with complete, correctly-typed JSON arguments.'
  },
  {
    category: 'timeout',
    pattern: /(timed? ?out|ETIMEDOUT|killed.*timeout)/i,
    retryable: true,
    guidance: 'This step exceeded its time budget. Try a smaller/faster variant (e.g. narrower test scope), or move on and note it as blocked.'
  },
  {
    category: 'network',
    pattern: /(ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up|fetch failed|UND_ERR)/i,
    retryable: true,
    guidance: 'A local service was unreachable. If this persists the run cannot continue — summarize progress so far.'
  },
  {
    category: 'missing_input',
    pattern: /(provide "patch"|oldText is empty|required parameter|provide .oldText.\/.newText.)/i,
    retryable: true,
    guidance: 'Required parameters were missing. Re-emit the call including every required argument.'
  },
  {
    category: 'filesystem',
    pattern: /(ENOENT|EISDIR|binary file|non-text extension|no such file|does not exist|path escapes|BLOCKED:)/i,
    retryable: true,
    guidance: 'Filesystem-level problem. Verify the path exists with list_files/read_file before writing; create parent files first if needed.'
  },
  {
    category: 'cancelled',
    pattern: /^ERROR: cancelled$/i,
    retryable: false,
    guidance: ''
  }
];

/** Classify a failed tool result's content into a category + recovery strategy. */
export function classifyToolFailure(content: string): FailureClassification {
  const text = String(content || '');
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      return { category: rule.category, retryable: rule.retryable, guidance: rule.guidance };
    }
  }
  // A command that simply exited non-zero is an EXPECTED verification signal,
  // not a malfunction — treat separately from generic errors.
  if (/^exit=\d+/m.test(text)) {
    return {
      category: 'command',
      retryable: false,
      guidance: 'The command ran but reported failure (see output above). Diagnose from its output; do not blindly rerun.'
    };
  }
  if (text.startsWith('ERROR:') || text.startsWith('BLOCKED')) {
    return { category: 'unknown', retryable: true, guidance: 'Reassess before retrying: re-read relevant state, then attempt a corrected version.' };
  }
  return { category: 'unknown', retryable: true, guidance: '' };
}

/** Classify an exception thrown by the LLM caller itself. */
export function classifyLlmError(err: unknown): FailureClassification {
  const msg = String((err as any)?.message || err || '');
  if (/cancel/i.test(msg)) return { category: 'cancelled', retryable: false, guidance: '' };
  for (const rule of RULES) {
    if (rule.category === 'network' && rule.pattern.test(`${(err as any)?.cause?.code || ''} ${msg}`)) {
      return {
        category: 'network',
        retryable: true,
        guidance: 'Check that your local model server is running (`ollama serve`), then resume the run.'
      };
    }
  }
  if (/abort|timeout/i.test(msg)) return { category: 'timeout', retryable: true, guidance: 'The model took too long to respond. Retry; consider a smaller task chunk.' };
  return { category: 'unknown', retryable: true, guidance: '' };
}

/**
 * Human-readable category tag used in stream messages, e.g. "[validation_gate]".
 */
export function categoryTag(c: ErrorCategory): string {
  return `[${c}]`;
}
