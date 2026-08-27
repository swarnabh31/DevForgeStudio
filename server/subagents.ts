import { runAgentLoop } from './agentLoop';

/**
 * P3.3 Subagents — isolated read-only explore agents.
 *
 * The main loop can delegate pure research ("where is X handled?") to a
 * subagent that gets ONLY read-only tools and a small iteration budget, so
 * exploration doesn't burn the main loop's iterations or flood its context:
 * the subagent's final report comes back as one compact tool result.
 * Concurrency model: 1 main agent + sequential reader subagents.
 */

const READ_ONLY_TOOLS = new Set(['list_files', 'search', 'read_file', 'file_outline', 'semantic_search']);

export interface SubagentResult {
  report: string;
  iterations: number;
  stoppedEarly: boolean;
}

export interface ExploreSubagentOptions {
  root: string;
  endpoints: string[];
  modelId: string;
  question: string;
  /** Iteration budget for the subagent (default 6). */
  maxIterations?: number;
  /** Optional semantic-search backend to expose inside the subagent too. */
  semanticSearch?: (query: string, k?: number) => Promise<string>;
}

export async function runExploreSubagent(opts: ExploreSubagentOptions): Promise<SubagentResult> {
  const maxIterations = Math.max(1, opts.maxIterations ?? 6);
  const systemContext =
    `You are DevForge Research, a READ-ONLY explore subagent. Your only job is to answer the ` +
    `main agent's research question about this codebase.\n` +
    `Rules:\n` +
    `- Use list_files/search/read_file/file_outline${opts.semanticSearch ? '/semantic_search' : ''} to investigate.\n` +
    `- You CANNOT create or modify anything — do not attempt it.\n` +
    `- Be efficient: at most a handful of targeted reads; never read whole large files.\n` +
    `- Finish with a COMPACT report: direct answer first, then file paths with line ranges ` +
    `(path:start-end) for everything relevant, then key facts the caller needs. No filler.`;

  const result = await runAgentLoop({
    root: opts.root,
    prompt: `RESEARCH QUESTION: ${opts.question.slice(0, 2000)}`,
    modelId: opts.modelId,
    endpoints: opts.endpoints,
    history: [],
    systemContext,
    maxIterations,
    // Hard guard: deny every side-effecting tool even if the model tries one.
    requestPermission: async () => false,
    ...(opts.semanticSearch ? { semanticSearch: opts.semanticSearch } : {})
  });

  const report =
    (result.reply || '').trim() ||
    '(subagent produced no report — it may have run out of its iteration budget)';

  return {
    report: report.slice(0, 4000),
    iterations: result.iterations ?? 0,
    stoppedEarly: !!result.hitIterationCap
  };
}

/** True when the given tool is allowed inside a read-only subagent. */
export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}
