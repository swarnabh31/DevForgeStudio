# DevForge Studio — Architecture

> A local-first, privacy-focused agentic AI coding tool with a full web UI.
> Ollama-bound by design: no cloud LLMs, no API providers, ever.

## High-level flow

```
Browser (React 19 + Vite + Tailwind v4)
   │  POST /api/agent/stream (NDJSON events)
   ▼
server.ts (Express)
   │  resolveTaskContext() — task mode + persona + LTM + project rules + repo map
   ▼
runAgentLoop() — server/agentLoop.ts
   │  system prompt → LLM w/ tools → execute tools → repeat
   ├── server/fsTools.ts        list/search/read/write/patch/outline/git_diff
   ├── server/verify.ts         auto-verify & self-heal after edits
   ├── server/codeRetrieval.ts  semantic_search (local embeddings)
   ├── server/subagents.ts      delegate_research (read-only subagent)
   ├── server/pluginTools.ts    user-defined tools (.devforge.json)
   └── events streamed back: token / tool_call / tool_result / plan_update /
       verify_* / context_usage / iteration_end / files_changed …
```

## Key subsystems

| Area | Files | Notes |
|------|-------|-------|
| Agent loop | `server/agentLoop.ts` | Tool-use loop; streaming; permission gate; compaction |
| Patching | `server/patchEngine.ts` | Fuzzy unified-diff apply (indentation-tolerant) |
| Long sessions | `taskLedger`, `compaction`, `persistence` | Disk-backed progress; digest compaction; crash resume snapshots |
| Safety | `editValidation.ts`, stale-file conflict registry in `fsTools.ts`, `gitWorkflow.ts` | Validate before disk; refuse stale writes; branch-per-run + step commits |
| Retrieval | `codeRetrieval.ts`, `repoMap.ts` | Chunk-level embedding index (nomic-embed-text); ranked repo map |
| Subagents | `subagents.ts` | Read-only explore agents with their own iteration budget |
| Extensibility | `pluginTools.ts`, `.devforge.json` | Declarative command-based custom tools |
| GUI superpowers | Checkpoints tab, diff review modal, live dashboard, task board, stats | See plan.md Phase 2/4 |

## Event-driven UI

The agent run is an NDJSON stream of typed events. The React app renders chat,
pipeline graph, live dashboard panels, and the task board purely from these
structured events — no screen-scraping of model prose (regex fallbacks only).

## Model support

- Any Ollama-compatible endpoint (`/api/chat` first, OpenAI-compatible fallback).
- Hardware-aware context sizing (`server/systemProfile.ts`) clamped by each
  model family's known ceiling (`server/modelMatrix.ts`).
- Local embeddings via `nomic-embed-text` for semantic code search.

## Testing

- `npm test` — vitest suite (unit + endpoint + loop integration with a mock Ollama).
- `npm run eval` — agentic regression harness over the real loop:
  `--suite core|swe|all`. Results tracked in `benchmark/results/`.
