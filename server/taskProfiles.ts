export type TaskMode =
  | 'general'
  | 'coding'
  | 'debugging'
  | 'testing'
  | 'test_creation'
  | 'refactoring'
  | 'app_development'
  | 'complex_task';

export const TASK_MODES: Array<{ id: TaskMode; label: string; description: string }> = [
  { id: 'general', label: 'General Q&A', description: 'Explanations, questions, quick help' },
  { id: 'coding', label: 'Coding', description: 'Implement features and write code' },
  { id: 'debugging', label: 'Debugging', description: 'Find and fix bugs — precise, low-temperature' },
  { id: 'testing', label: 'Test Running', description: 'Run tests, interpret failures' },
  { id: 'test_creation', label: 'Test Creation', description: 'Write unit/integration tests' },
  { id: 'refactoring', label: 'Refactoring', description: 'Restructure code without behavior change' },
  { id: 'app_development', label: 'App Development', description: 'Build whole features/apps end-to-end' },
  { id: 'complex_task', label: 'Complex Task', description: 'Multi-step, multi-file engineering tasks with deep reasoning' }
];

export interface ResolvedParams {
  temperature: number;
  topP: number;
  repeatPenalty: number;
  numCtxTokens: number;
  maxIterations: number;
  personaAddendum: string;
}

const PERSONAS: Record<TaskMode, string> = {
  general:
    'TASK MODE: General Q&A. Answer concisely and conversationally. Only use tools when the answer requires reading actual code.',
  coding:
    'TASK MODE: Coding. Write clean, typed, idiomatic code following existing project conventions. Read neighboring files to match style before writing.',
  debugging:
    'TASK MODE: Debugging. Be methodical: reproduce → locate root cause via search/read → apply the MINIMAL precise fix. Prefer apply_patch. Explain the root cause in one short paragraph.',
  testing:
    'TASK MODE: Test Running. Investigate test setup before concluding. Report failures precisely (test name, file, line). Suggest or apply minimal fixes.',
  test_creation:
    'TASK MODE: Test Creation. Study existing tests and imports first. Cover happy path + edge cases + error paths. Match the existing test framework and style exactly.',
  refactoring:
    'TASK MODE: Refactoring. Preserve behavior EXACTLY. Change structure only. Make small independent patches per step and verify each file compiles conceptually after edits.',
  app_development:
    'TASK MODE: App Development. Think in terms of architecture first: list files to create/modify, then implement them coherently. Keep imports, types, and naming consistent across files.',
  complex_task:
    'TASK MODE: Complex Task. Plan before acting: enumerate steps, then execute them one by one with tools. Verify your changes (re-read patched regions) before declaring done. Do not stop halfway.'
};

/** Per-task sampling presets tuned for local instruct/code models */
const PRESETS: Record<
  TaskMode,
  Omit<ResolvedParams, 'numCtxTokens' | 'personaAddendum'>
> = {
  general:        { temperature: 0.5, topP: 0.9,  repeatPenalty: 1.1, maxIterations: 6 },
  coding:         { temperature: 0.2, topP: 0.85, repeatPenalty: 1.05, maxIterations: 20 },
  debugging:      { temperature: 0.1, topP: 0.75, repeatPenalty: 1.0, maxIterations: 16 },
  testing:        { temperature: 0.15, topP: 0.8, repeatPenalty: 1.0, maxIterations: 10 },
  test_creation:  { temperature: 0.25, topP: 0.9, repeatPenalty: 1.05, maxIterations: 14 },
  refactoring:    { temperature: 0.15, topP: 0.8, repeatPenalty: 1.0, maxIterations: 18 },
  app_development: { temperature: 0.35, topP: 0.9, repeatPenalty: 1.1, maxIterations: 24 },
  complex_task:   { temperature: 0.25, topP: 0.9, repeatPenalty: 1.1, maxIterations: 32 }
};

/**
 * Resolve model parameters for a task mode given the machine profile.
 * Hardware-aware: context window is clamped by VRAM/RAM budget from systemProfile.
 */
export function resolveTaskParams(
  taskMode: TaskMode,
  recommendedContextTokens: number,
  opts: { largeModel?: boolean } = {}
): ResolvedParams {
  const preset = PRESETS[taskMode] || PRESETS.general;

  // Large models (>13B-ish tags) eat more VRAM per token — halve the context budget
  const budget = opts.largeModel
    ? Math.round(recommendedContextTokens / 2)
    : recommendedContextTokens;

  // Floor so tool results still fit
  const numCtxTokens = Math.max(4096, Math.min(budget, 32768));

  return { ...preset, numCtxTokens, personaAddendum: PERSONAS[taskMode] || PERSONAS.general };
}

export function isTaskMode(v: unknown): v is TaskMode {
  return typeof v === 'string' && v in PRESETS;
}
