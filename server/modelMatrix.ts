/**
 * P5.2 Model compatibility matrix — tested-and-tuned presets per popular
 * local model family. Each entry captures what we know empirically about the
 * family: sampling preferences, thinking-mode handling, context limits, and
 * known quirks. Matching is by model-id substring so tags like
 * `qwen2.5-coder:14b-instruct-q4_K_M` resolve correctly.
 */

export interface ModelPreset {
  /** Canonical family name, e.g. "qwen2.5-coder" */
  family: string;
  /** Substrings (lowercased) that match this family in a model id */
  match: string[];
  /** Preferred sampling deltas applied on top of task-mode presets */
  sampling?: { temperature?: number; topP?: number; repeatPenalty?: number };
  /** Hard context ceiling for the family (tokens), when known */
  maxCtxTokens?: number;
  /** How the family handles reasoning output */
  thinking: 'none' | 'soft-switch' | 'think-blocks';
  /** Human-readable notes surfaced to users */
  notes: string;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    family: 'qwen2.5-coder',
    match: ['qwen2.5-coder', 'qwen2.5_coder'],
    sampling: { temperature: 0.15, topP: 0.8 },
    maxCtxTokens: 32768,
    thinking: 'none',
    notes:
      'Best all-round local coding family. Deterministic at low temperature; keep topP ≤0.85. No thinking mode.'
  },
  {
    family: 'qwen3',
    match: ['qwen3', 'qwen3-coder'],
    sampling: { temperature: 0.2, topP: 0.9 },
    maxCtxTokens: 65536,
    thinking: 'soft-switch',
    notes:
      'Supports /no_think soft switch and long context (up to ~64k+). Good tool calling; slightly verbose with thinking enabled.'
  },
  {
    family: 'deepseek-coder-v2',
    match: ['deepseek-coder-v2', 'deepseek-coder2', 'deepseek-v2'],
    sampling: { temperature: 0.1, topP: 0.9, repeatPenalty: 1.05 },
    maxCtxTokens: 65536,
    thinking: 'none',
    notes:
      'Strong multi-language code generation. Sensitive to repetition — keep repeatPenalty ≥1.05.'
  },
  {
    family: 'deepseek-r1',
    match: ['deepseek-r1', 'r1-distill'],
    sampling: { temperature: 0.5, topP: 0.95 },
    maxCtxTokens: 65536,
    thinking: 'think-blocks',
    notes:
      'Reasoning-first family: emits <think> blocks (stripped automatically). Needs higher temperature than coder models; slow but thorough.'
  },
  {
    family: 'llama3',
    match: ['llama3', 'llama-3'],
    sampling: { temperature: 0.25, topP: 0.9 },
    maxCtxTokens: 131072,
    thinking: 'none',
    notes:
      'General-purpose baseline. Decent tool use on 8b+ variants; context claims beyond 32k degrade on consumer hardware.'
  },
  {
    family: 'codellama',
    match: ['codellama'],
    sampling: { temperature: 0.1, topP: 0.9, repeatPenalty: 1.1 },
    maxCtxTokens: 16384,
    thinking: 'none',
    notes:
      'Legacy code model. Works best with short prompts and small diffs; limited tool-call reliability.'
  },
  {
    family: 'mistral',
    match: ['mistral', 'devstral', 'codestral'],
    sampling: { temperature: 0.2, topP: 0.9 },
    maxCtxTokens: 32768,
    thinking: 'none',
    notes:
      'Fast and lean. Devstral variant is notably better at agentic tool calling than base Mistral.'
  }
];

/** Match a model id (any tag format) to its family preset. */
export function findModelPreset(modelId: string | undefined | null): ModelPreset | null {
  if (!modelId) return null;
  const id = String(modelId).toLowerCase();
  for (const preset of MODEL_PRESETS) {
    if (preset.match.some((m) => id.includes(m))) return preset;
  }
  return null;
}
