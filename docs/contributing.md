# Contributing to DevForge Studio

## Setup

```bash
npm install
npm run dev          # tsx watch server.ts + Vite middleware on :3000
```

Ollama is expected at `http://127.0.0.1:11434` (localhost / `:1234` fallbacks).
For embeddings-based semantic search, pull once: `ollama pull nomic-embed-text`.

## Verification checklist (every change)

1. `npx tsc --noEmit` — typecheck clean
2. `npm test` — full vitest suite green
3. `npm run eval` — agentic harness: core 20/20 baseline must hold
4. `npm run build` — production bundle builds

CI-style regression gating: `npm run eval -- --ci` exits 2 when a task that
passed in the previous recorded run now fails.

## Conventions

- **Structured events over scraped prose.** Anything the UI needs from the
  agent (plan steps, verification status, latency) must arrive as a typed
  NDJSON event, not by parsing model output.
- **Reject before disk.** Edit validation gates and stale-file conflict checks
  run BEFORE any write; the model self-heals from the tool error.
- **Best-effort side features never break the run.** Ledger updates,
  snapshots, telemetry: wrap in try/catch, degrade gracefully.
- **Local only.** No network calls except to the user's own model endpoints.
- Mock-Ollama test convention: speak NDJSON when the request has
  `stream:true`, plain JSON otherwise.

## Adding an agent tool

1. Add the function schema to `TOOL_SCHEMAS` and a dispatch case in
   `executeTool` (`server/agentLoop.ts`).
2. If it is side-effecting, route it through `requestPermission`.
3. Add tests: direct `executeTool` coverage + a scripted eval task if it
   changes agent behavior.

For user-defined tools without touching code, see docs/tools.md
(`.devforge.json` plugin tools).

## Docs

Update `Memory.md` (current state) and `plan.md` (roadmap ticks) with every
merged change.
