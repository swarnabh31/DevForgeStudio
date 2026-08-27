# DevForge Studio

> **Your Local-First AI Software Engineering Studio.**

A **local-first, in-browser AI coding agent** that reads, searches, edits, and verifies **real files on your disk** using **your own locally-downloaded models** (Ollama, LM Studio, or any OpenAI-compatible endpoint). No cloud APIs, no telemetry, no subscriptions — your code never leaves your machine.

---

## Table of contents

- [Why DevForge Studio?](#why-devforge-studio)
- [Feature at a glance](#feature-at-a-glance)
- [Getting started](#getting-started)
- [How the agent works, end to end](#how-the-agent-works-end-to-end)
- [Feature guide](#feature-guide)
- [Safety & security](#safety--security)
- [Where things are stored](#where-things-are-stored)
- [Project rules (`.devforge.json`)](#project-rules-devforgejson)
- [Architecture](#architecture)
- [API reference](#api-reference)
- [Troubleshooting & common fixes](#troubleshooting--common-fixes)
- [Scripts](#scripts)
- [Benchmark](#benchmark)
- [License](#license)

---

## Why DevForge Studio?

| | Cloud AI coding tools | DevForge Studio |
|---|---|---|
| Code privacy | Uploaded to third-party servers | Never leaves your disk |
| Cost | Monthly subscription / per-token | Free — runs on your own hardware |
| Offline | No | Yes, fully |
| Filesystem access | Sandboxed copy | Real files on your disk, with backups |
| Model choice | Vendor-locked | Any Ollama / OpenAI-compatible local model |

**Advantages at a glance**

- **Works on your real project** — point it at any folder on disk; the agent reads, edits, and verifies actual files (with automatic backups and one-click revert).
- **Private by design** — localhost-only server by default, no cloud calls, no telemetry.
- **Hardware-aware** — detects your GPU/VRAM/RAM and tunes context windows and sampling accordingly.
- **Model-agnostic** — auto-detects every model served by Ollama, LM Studio, or any OpenAI-compatible endpoint.
- **Transparent** — every tool call, file change, plan step, diff, iteration, and verify result is visible live.

---

## Feature at a glance

- **Chat-driven agent loop** — natural-language tasks; the agent plans, edits, verifies, and self-corrects.
- **8 task modes** — behavior presets that tune sampling + persona per kind of work (coding, debugging, refactoring, …).
- **4 thinking levels** — from instant "no thinking" to deep multi-step reasoning.
- **4 write policies** — `ask` / `allow` / `deny` / per-hunk `review`.
- **15 built-in tools** — file ops, fuzzy patching, allowlisted commands, semantic search, subagents, memory, and past-run retrieval.
- **Durable task ledger** — on-disk step-by-step progress that survives crashes *and* iteration-cap resumption, so a 10-step task never restarts from step 1.
- **Auto-continue + crash/cancel resume** — long tasks keep going past their iteration budget and can be picked up later from a snapshot.
- **Auto-verify & self-heal** — after edits, real `tsc` / `ruff` / `vitest` / `pytest` / `npm` output is fed back until clean.
- **Backups, diffs & checkpoints** — every overwrite is snapshot; revert per-file or to a whole checkpoint.
- **Long-term memory** — `remember` / `recall` persist project facts & conventions across sessions.
- **Past-run RAG** — `search_past_runs` recalls "last time we did X, the fix was Y".
- **Git integration** — per-run work branches and optional auto-commit of verified steps.
- **LAN mode** — opt-in remote access with a token gate, loopback trust, and per-route CSRF checks.
- **Multi-session, onboarding wizard, model catalog, stats dashboard, in-app docs** — a complete studio, not just a chat box.

---

## Getting started

### Prerequisites

1. **Node.js 20+** — https://nodejs.org
2. **Ollama** (or LM Studio / any OpenAI-compatible local server) — https://ollama.com/download
3. A local model, e.g.:

```bash
ollama pull qwen2.5-coder:7b
# or, for higher quality:
ollama pull qwen3:27b
```

Optional: bake in a bigger context window so the app picks it up automatically (not clamped):

```bash
ollama run qwen2.5-coder:7b --ctx 32768
```

### Quickstart

```bash
git clone https://github.com/swarnabh31/DevForgeStudio.git
cd DevForgeStudio
npm install

# start Ollama in another terminal (if not already running):
ollama serve

npm run dev
```

Open **http://127.0.0.1:3000**. Then:

1. Pick a model from the header dropdown (press **Rescan** if empty).
2. Choose a task mode (default **Coding**).
3. Set your target directory in the Code Workspace sidebar (**Load Folder**) — or just start chatting and let the agent explore the default workspace.
4. Prompt away. Approve permission prompts as they appear.

### First-run tips

- If no models are detected, follow the in-app guided panel: start Ollama → pull a model → **Rescan**.
- Use **No thinking** for fast Q&A; switch to higher thinking levels for hard debugging.
- Set the write policy to **Ask** (default) so each file/command change is approved by you before it lands.
- Every agent edit is backed up — use the per-file **Revert** button or a **checkpoint** if you don't like a change.

---

## How the agent works, end to end

Here's the exact lifecycle of a single prompt, and *when* each behavior triggers. This is the heart of the app.

```
You send a prompt
      │
      ▼
[resolveTaskContext]  task mode → sampling params + persona + project rules
      │
      ▼
[agent loop]  starts with the system prompt
   (rules + memory + workspace index + project instructions + task ledger)
      │
      ▼
  ┌────────────────────────── iteration ──────────────────────────┐
  │  1. Refresh the durable task ledger into the system prompt     │
  │  2. (if near context budget) compact oldest turns into a       │
  │     digest — non-lossy, full text saved to .opencode/memory/    │
  │  3. LLM decides: answer, or call tools                          │
  │  4. Tools run:                                                  │
  │       - parallel-safe reads (list/search/outline) fan out       │
  │       - writes/patches: backup → validate → conflict check →    │
  │         (review gate if policy=review) → write → auto-touched   │
  │       - commands: allowlist + metachar guard → run              │
  │       - permission gate (if policy=ask) pauses for you          │
  │  5. failed-call guard (stops 5× identical failures)             │
  └───────────────────────────────────────────────────────────────┘
      │
      ▼
  answer without tools → done. Tool calls hit the iteration cap → ↓
      │
      ▼
[auto-continue] up to 5 more passes, resuming from the in-progress
  step in the ledger (NOT from step 1); transcripts carried forward
      │
      ▼
[auto-verify + self-heal] detected verify commands run; failures fed
  back to the model (up to 3 heal attempts) until clean
      │
      ▼
[finalize] diagnostics, file diffs, plan/graph state, run log,
  delete the resume snapshot on clean success
```

Key behaviors and *when* they fire:

- **Planning** — the agent is instructed to call `update_plan` at the start of multi-step work and again as steps change status. The UI renders it live; it is also mirrored to the durable ledger.
- **Permission gate** — only when write policy is `ask` (or non-edit tools in `review`), the stream pauses and waits for your Allow/Deny.
- **Edit review gate** — only when write policy is `review`, each edit is broken into hunks you accept/reject individually.
- **Iteration cap & auto-continue** — every task mode runs a maximum of **50 iterations** (raised to ≥12 when thinking level is High). If the model exhausts its budget mid-task, DevForge auto-continues for up to 5 more passes — carrying the full transcript *and* the durable ledger so it resumes at the correct step.
- **Auto-verify** — fires after a run that touched files, and **mid-loop** after an edit batch in supported workspaces. It runs workspace-detected commands (`tsc --noEmit`, `ruff check`, `vitest run`/`npm test`/`pytest`, `npm run build`) plus any you list in `.devforge.json`, and feeds failures back for healing.
- **Compaction** — fires automatically only when the conversation crosses ~75% of the model's context budget.
- **Resume after crash/cancel** — the snapshot is kept on a cancel or crash (deleted on clean success) and becomes a "pending resume" you can pick back up.

---

## Feature guide

### 1. Agent chat
The main interface. Type a request ("add input validation to `server.ts`", "fix the failing test") and watch the agent work in real time:

- **Live token streaming** — replies appear as they're generated.
- **Visible tool use** — every `list_files`, `search`, `read_file`, `write_file`, `apply_patch`, `run_command`, `semantic_search`, `delegate_research`, etc. is shown as it happens.
- **Markdown replies** with syntax-highlighted code blocks and color-coded unified diffs inline.
- **Thinking selector** — choose *No thinking* (default), *Low*, *Medium*, or *High* per turn.
- **Permission & review cards** — inline Allow/Deny and per-hunk accept/reject, depending on write policy.
- **Stop / Pause** — Stop aborts the in-flight run server-side; Pause is a client-side state marker.

### 2. Task modes
Pick a mode in the header. Each mode sets a persona and a tuned sampling preset (`maxIterations` is 50 for all; the context window is hardware-aware, floored at 8 k and capped at 64 k tokens):

| Mode | Best for | Temp | Top-P | Repeat pen. | Persona focus |
|---|---|---|---|---|---|
| General Q&A | Explanations, quick questions | 0.5 | 0.9 | 1.1 | Concise; tools only when reading code is needed |
| Coding | Implementing features | 0.2 | 0.85 | 1.05 | Clean, typed, idiomatic; match existing style |
| Debugging | Find & fix bugs | 0.1 | 0.75 | 1.0 | Reproduce → locate → minimal fix |
| Test Running | Run tests, interpret failures | 0.15 | 0.8 | 1.0 | Report failures precisely; minimal fixes |
| Test Creation | Write unit/integration tests | 0.25 | 0.9 | 1.05 | Happy path + edge + error; match framework |
| Refactoring | Restructure, no behavior change | 0.15 | 0.8 | 1.0 | Preserve behavior exactly; small patches |
| App Development | Build whole features end-to-end | 0.35 | 0.9 | 1.1 | Architecture first, then coherent implementation |
| Complex Task | Multi-step, multi-file engineering | 0.25 | 0.9 | 1.1 | Plan → execute step-by-step → verify, don't stop halfway |

### 3. Thinking levels
- **None** (default) — appends the qwen3 `/no_think` soft switch and strips any leaked `</think>` blocks. Fastest; best for Q&A.
- **Low / Medium / High** — allow the model's reasoning phase. **High** also raises the minimum iteration budget so deep multi-step work has room.

### 4. Write policies
| Policy | Behavior |
|---|---|
| `ask` (default) | Agent pauses for your Allow/Deny before each write / patch / command |
| `allow` | Auto-approve all side-effecting tools (trusted batch work) |
| `deny` | Block all writes; read-only exploration only |
| `review` | Every edit is split into hunks you accept/reject individually |

The per-project default can be set in `.devforge.json` → `writePolicy`.

### 5. Code workspace sidebar
Docked beside the chat (drag the divider to resize):

- **Load Folder** — paste an absolute path (e.g. `C:\Users\you\MyProject`) and press Enter to make it the active workspace. Quoted Windows "Copy as Path" values are handled. Leave it empty to open the native folder picker.
- **File tree + CodeMirror 6 editor** — open and edit any workspace file with syntax highlighting for JS/TS/HTML/JSON/Python.
- **Per-file Diff & Revert** — see a file's diff against the pre-edit snapshot, or revert it.
- **Checkpoint timeline** — browse every backup checkpoint, inspect its diff, and revert the whole workspace to any point.
- **LSP diagnostics footer** — real `tsc --noEmit` / `ruff check` errors shown as they occur.

### 6. Tool system (the 15 built-in tools)
The agent exposes these to the model. Read-only tools are marked *(ro)*.

| Tool | What it does | Notes |
|---|---|---|
| `list_files` *(ro)* | List workspace files, optional `glob` filter | Parallel-safe |
| `search` *(ro)* | Full-text/regex search across files | Parallel-safe; `maxResults` up to 200 |
| `read_file` *(ro)* | Read a file, ranged reads via `offset`/`limit` | Records mtime for conflict detection |
| `file_outline` *(ro)* | Top-level symbols (functions/classes/types) | Parallel-safe |
| `write_file` | Create/overwrite a file with full content | Backup → validate → write |
| `apply_patch` | Edit a file via unified diff **or** `oldText`/`newText` | Fuzzy, whitespace-tolerant matching |
| `run_command` | Run an allowlisted verify command | See [command allowlist](#command-allowlist) |
| `git_diff` *(ro)* | Read the repo's `git diff` | Read-only |
| `update_plan` | Submit the live ordered step list for the UI | Mirrored to the durable ledger |
| `update_task` | Update the durable task ledger (steps/findings/next action) | Survives crashes & resume |
| `semantic_search` *(ro)* | Meaning-based code search (local embeddings + keyword blend) | Only when a retrieval backend is available |
| `delegate_research` *(ro)* | Delegate a broad question to a read-only subagent | Own iteration budget; cannot edit |
| `recall` *(ro)* | Search cross-session long-term memories | Scoped: workspace or global |
| `remember` | Persist a durable fact/convention/decision | Category + tags + scope |
| `search_past_runs` *(ro)* | RAG over past-run transcripts, ledgers, snapshots, logs | "Last time we did X…" |
| **Plugin tools** | Your own tools declared in `.devforge.json` | See [Project rules](#project-rules-devforgejson) |

The last five plus plugin tools appear automatically only when their backends are wired (they always are in a normal install).

### 7. Durable task ledger
A disk-backed progress record at `.devforge/tasks/<runId>.md`. The agent maintains it via `update_task` (and it is auto-updated as `update_plan` steps move). It holds the full step list with statuses (`pending` / `in_progress` / `completed` / `blocked`), key findings, files touched, and the single `next_action`.

- **Why it matters** — it is re-injected into the system prompt **every iteration**, so the model always knows its current step, how much is done, and what's next — even in a brand-new conversation.
- **This is what makes resumption correct** — after hitting the iteration cap or a crash/cancel, the continuation pass reads the ledger and resumes at the in-progress step instead of redone-from-scratch work.

### 8. Auto-continue & resume
- **Auto-continue** — when the iteration cap is hit mid-task, up to 5 more passes run automatically (`priorMessages` carries the full transcript; the ledger carries step position). You'll see a token line "Iteration budget reached — continuing automatically (pass N)".
- **Crash/cancel resume** — the run snapshot is kept at `.opencode/runs/<runId>.json` on a cancel or crash and shown under **pending resums**; re-submitting seeds the loop from that snapshot.

### 9. Auto-verify & self-heal
After a run that touched files (and mid-loop after an edit batch), DevForge runs the workspace's verify commands and feeds failures back to the model for up to 3 heal attempts. Detection is based on your project's manifest (`package.json` scripts, `tsconfig`, pytest config, etc.); you can add more via `.devforge.json` → `verifyCommands`.

### 10. Long-term memory
- **`remember`** — persist a durable fact/convention/preference/bug-note, scoped per-workspace or global.
- **`recall`** — retrieve the best-matching memories before re-doing work or answering a "how/where does X work?" question.
- **Memory Inspector** — browse, add, edit, delete, auto-extract, and clear memories from the UI.

### 11. Semantic search & past-run RAG
- **`semantic_search`** — find code by meaning (local embeddings, keyword fallback). Returns file paths + line ranges to read.
- **`search_past_runs`** — semantic search over this workspace's compaction transcripts, task ledgers, run snapshots, and run logs. Great for "what was the fix for that earlier?" without re-investigating.

### 12. Subagents
`delegate_research` spawns a **read-only** explore subagent with its own small iteration budget. It can't edit — it returns a compact report with file paths + line ranges. Use it to investigate broadly so the main agent saves its own iterations for actual edits.

### 13. Plugin tools (`.devforge.json` → `tools`)
Declare your own command-backed tools. Each is a shell command with `{{arg}}` placeholders, run in the workspace root. Example:

```json
{ "name": "fmt", "description": "Format a file",
  "parameters": { "path": { "type": "string", "description": "file to format" } },
  "command": "npx prettier --write {{path}}" }
```

### 14. Git integration
When the workspace is a git repo: a dedicated work branch is created per run (with a checkpoint commit of pre-run changes), and each verified step can be auto-committed (best-effort). DevForge-managed dirs (`.opencode`, `.devforge`, `.git`) are excluded from the agent's commits.

### 15. Model detection & context control
- Auto-scans Ollama (`:11434`), LM Studio (`:1234`) and common ports; press **Rescan** if none appear.
- Your model's own context setting (`num_ctx` baked into the Ollama model) is detected via `/api/show` and respected — not clamped.
- Without an explicit setting, a hardware-aware estimate (~2k tokens/GB VRAM) is used, then floored at 8 k / capped at 64 k.

### 16. Agent pipeline visualizer & live dashboard
The **Agent Pipeline** tab renders the agent's progress as a live node graph driven by real loop events (not a canned animation). The **Live Dashboard** shows the plan steps, tool feed, files touched, per-iteration stats (including Ollama prompt-cache `promptEvalMs/tokens`), and a context-budget meter.

### 17. Multi-session management
Run multiple named, isolated agent sessions in parallel — each with its own workspace, chat, and status. Sessions persist across restarts (localStorage + a server-side copy). Per-session **Stop / Pause / Resume**, plus **Stop All / Pause All**.

### 18. Onboarding wizard, stats dashboard & docs
- **Onboarding Wizard** — hardware-aware model catalog with one-click Ollama pull (progress shown).
- **Stats Dashboard** — run telemetry (completion rate, avg duration/iterations, tool usage, by-mode breakdown).
- **Docs Panel** — in-app markdown docs (`/api/docs`).

### 19. LAN mode (opt-in)
Set `DEVFORGE_HOST=lan` (or `HOST=0.0.0.0`) to expose the studio on your LAN. It keeps a token gate, loopback trust, timing-safe comparison, per-route CSRF checks, and a rate-limited lockout. The token is printed to the console on startup.

---

## Safety & security

- **Localhost-only** by default — the server binds to `127.0.0.1`; nothing is exposed to your network (LAN mode is opt-in, gated).
- **Path guard** — every filesystem operation blocks traversal (`resolveSafePath`); extensively tested.
- **Permission gate** — write/patch/command tools respect `ask` / `allow` / `deny`.
- **Edit review gate** — `review` policy requires per-hunk acceptance.
- **Command allowlist** — only these prefixes can run, and shell metacharacters are rejected (see [allowlist](#command-allowlist)).
- **Edit validation** — cheap syntax/import checks (quote balance, etc.) run before a write hits disk, so obvious breakage is bounced back to the model.
- **Atomic writes + conflict detection** — files are written atomically; if you edited a file externally while the agent holds stale contents, the write is refused until it re-reads.
- **Backups** — every overwrite is snapshotted to `.opencode/backups/`; revert per-file or to a checkpoint.
- **Binary write blocking** — only text files are written; atomic by construction.

### Command allowlist
The only commands `run_command` may execute (prefix match, no shell metacharacters):

`npm test` · `npm run lint` · `npm run build` · `tsc --noEmit` · `vitest run` · `pytest` · `ruff check` · `git status` · `git diff`

---

## Where things are stored

Everything lives next to your project (workspace root):

```
.your-project/
├── .devforge.json             # project rules (see below)  [you create this]
├── AGENTS.md                  # optional instructions file
├── .devforge/
│   └── tasks/<runId>.md       # durable task ledger (per run)
└── .opencode/
    ├── store.json             # app store (long-term memory index, etc.)
    ├── backups/               # pre-write file snapshots (checkpoints)
    ├── runs/<runId>.json      # crash/cancel resume snapshots (auto-pruned ~7d)
    ├── memory/<runId>-c<n>.md # non-lossy compaction digests
    ├── code-index.json        # semantic-search index
    ├── embeddings.json        # local embedding cache
    ├── rag-index.json         # past-run RAG index
    ├── logs/runs.jsonl        # run telemetry (feeds Stats Dashboard)
    └── auth-token.json        # LAN mode token (only when LAN mode is on)
```

Both `.opencode/` and `.devforge/` are excluded from the agent's git commits and from the workspace watcher/index.

---

## Project rules (`.devforge.json`)

Optional file in the workspace root that overrides agent behavior per project. Every field is optional; missing/corrupt files are ignored safely (5 s cache).

| Field | Type | Effect |
|---|---|---|
| `instructions` | `string` (≤8000 chars) | Free-form text injected into the system prompt of every run |
| `writePolicy` | `"ask" \| "allow" \| "deny" \| "review"` | Default write policy for this workspace |
| `verifyCommands` | `string[]` (≤10) | Extra verify commands run by the auto-verify loop (before auto-detected ones) |
| `ignoreGlobs` | `string[]` (≤100) | Glob patterns the agent skips in list/search/index |
| `tools` | `PluginToolSpec[]` (≤12) | Your own command-backed tools (see [plugin tools](#13-plugin-tools-devforgejson--tools)) |

Instruction files: after `.devforge.json` → `instructions`, DevForge also reads **`AGENTS.md`** (or `AGENTS.instructions.md`) from the workspace root and appends it to the system prompt.

**Example `.devforge.json`:**

```json
{
  "instructions": "This is a TypeScript monorepo. Always run pnpm, not npm. Keep exports named.",
  "writePolicy": "review",
  "verifyCommands": ["npm run typecheck", "npm test -- --run path"],
  "ignoreGlobs": ["vendor/**", "dist/**", "**/__snapshots__"],
  "tools": [
    { "name": "format_file", "description": "Prettier-format a file",
      "parameters": { "path": { "type": "string" } },
      "command": "npx prettier --write {{path}}" }
  ]
}
```

---

## Architecture

### Directory layout

```
server.ts                Express backend + Vite dev middleware + all routes (auth/CSRF,
                         onboarding catalog & Ollama pull, memory CRUD/auto-extract, RAG)
server/
├── agentLoop.ts         tool schemas + executeTool + runAgentLoop: streaming LLM client,
│                        permission/review hooks, thinking-level control, parallel-safe
│                        read scheduling, failed-call guard, base system prompt / coding
│                        rules, auto-verify/self-heal, compaction, ledger refresh
├── backups.ts           pre-write snapshot engine; checkpoint listing, revert
├── codeRetrieval.ts     semantic_search: chunking, index, local-embedding + keyword blend
├── compaction.ts        context-budget digesting (non-lossy transcripts → .opencode/memory)
├── diagnostics.ts       tsc --noEmit / ruff runners + parsers, import graph
├── diffUtil.ts          unified diffs (file & checkpoint) from backup-vs-disk
├── editValidation.ts    pre-write balance / syntax / import scan
├── embeddings.ts        local embedding model wrapper + cosine/keyword scoring + cache
├── errorTaxonomy.ts     failure classification that steers recovery
├── fsTools.ts           gitignore-aware walker, ranged reads, content search, outlines,
│                        binary detection, mtime-based conflict/external-change tracking
├── gitWorkflow.ts       per-run work branch + verified-step auto-commits
├── lanAccess.ts         LAN token gate, loopback trust, CSRF, rate-limited lockout
├── lib.ts               resolveSafePath traversal guard, language map, shared helpers
├── modelMatrix.ts       supported model presets / hardware-aware catalog
├── patchEngine.ts       unified-diff apply + fuzzy (whitespace/indent-tolerant) replace
├── persistence.ts       long-term memory store, run snapshots (crash/cancel resume),
│                        run telemetry (runs.jsonl)
├── pluginTools.ts       user-defined command-backed tools from .devforge.json
├── projectConfig.ts     .devforge.json + AGENTS.md instruction loader (sanitized, cached)
├── repoMap.ts           workspace code map injected into the prompt
├── reviewGate.ts        per-hunk edit-review proposal builder (writePolicy=review)
├── runRag.ts            search_past_runs RAG over transcripts/ledgers/snapshots/logs
├── subagents.ts         delegate_research read-only explore subagent
├── systemProfile.ts     CPU / GPU / VRAM / RAM detection + recommended context
├── taskLedger.ts        durable on-disk task ledger (update_task) + prompt render/inject
├── taskProfiles.ts      8 task modes → sampling params + personas
├── verify.ts            verify-command detection + auto-verify / self-heal runner
└── watcher.ts           workspace file watcher (external-change detection)
src/
├── main.tsx             React entry + global CSRF fetch wrapper
├── App.tsx              state engine; NDJSON/SSE streaming client; resizable split
├── types.ts             shared types (TaskMode, ThinkingLevel, SystemProfile, …)
├── data/                default models + default workspace
└── components/          chat UI, code workspace, pipeline visualizer, dashboards,
                         onboarding, modals, memory inspector, docs panel, LSP panel…
tests/                   35 Vitest suites (291 tests)
benchmark/               agentic regression suite (npm run eval)
docs/                    in-app markdown docs
scripts/package.ps1      Windows release packaging
BENCHMARK.md             benchmark methodology + published results
```

### Request lifecycle (server)
1. `POST /api/agent/stream` authenticates (LAN gate if enabled) + CSRF-checks.
2. Resolves `runId` (new, or a supplied one for resume) and `priorMessages` if resuming.
3. `resolveTaskContext` builds system instructions: base rules + memory + workspace index + project instructions + task-mode persona.
4. Wires hooks: permission, review gate, auto-verify, semantic search, subagents, recall/remember, past-run RAG, plugin tools, snapshot persistence, step commits.
5. Runs the agent loop → auto-continue → finalize (diagnostics, diffs, plan/graph, run log), then deletes the resume snapshot on clean success.
6. Streams newline-delimited JSON events throughout.

### Streaming event types (client consumes)
`iteration` (start), `token`, `tool_call`, `tool_result`, `plan` / `plan_update`, `files_changed`, `permission_request`, `edit_review_request`, `verify_start` / `verify_result` / `verify_heal`, `context_usage`, `context_compacted`, `iteration_end`, `done`, `error`, `cancelled`.

---

## API reference

| Method & path | Purpose |
|---|---|
| `POST /api/agent/stream` | Run an agent task; streams NDJSON events back (the main loop) |
| `POST /api/agent/permission` | Allow/deny a pending tool call |
| `POST /api/agent/review` | Resolve an edit-review (accepted hunk indices) |
| `POST /api/agent/cancel` | Stop the in-flight run for a session |
| `POST /api/agent/resume` | Retrieve a run's saved snapshot to resume it |
| `GET  /api/agent/pending-resumes` | List resumable (crashed/cancelled) snapshots |
| `POST /api/models/detect-local` | Detect local Ollama/LM Studio + list tags |
| `GET  /api/system/profile` | CPU/GPU/VRAM/RAM profile + recommended context |
| `POST /api/lsp/diagnose` | Run LSP/type diagnostics |
| `GET  /api/onboarding/catalog` | Hardware-aware model catalog |
| `POST /api/onboarding/pull` | Ollama pull with progress (SSE) |
| `GET  /api/workspace/files` | List workspace files |
| `POST /api/workspace/files` | Save a workspace file |
| `GET  /api/workspace/file-diff` | Unified diff for one file |
| `POST /api/workspace/revert-file` | Restore a file's original content |
| `POST /api/workspace/execute` | Run a command in the workspace |
| `POST /api/workspace/load-directory` | Seed the workspace from a local folder |
| `GET  /api/workspace/backups` | Checkpoint list |
| `GET  /api/workspace/checkpoint-diff` | Diff of one checkpoint |
| `POST /api/workspace/revert` | Revert workspace to a checkpoint |
| `GET  /api/project/config` | Load project rules (`.devforge.json`) |
| `POST /api/project/config` | Save project rules |
| `GET  /api/memory` · `POST /api/memory/add` · `DELETE /api/memory/:id` · `POST /api/memory/clear` | Long-term memory CRUD |
| `POST /api/memory/extract` | Trigger LLM auto-extraction of memories |
| `POST /api/memory/rag/search` | Past-run RAG search |
| `GET  /api/docs` · `GET /api/docs/:name` | List / read in-app docs |
| `GET  /api/stats/runs` | Run telemetry for the Stats Dashboard |
| `GET  /api/sync/sessions` · `POST /api/sync/sessions` | Session persistence (survives localStorage wipe) |

CSRF: all mutating calls must carry the `x-devforge-csrf: devforge` header (injected automatically by the client).

---

## Troubleshooting & common fixes

**No models detected** → Start Ollama (`ollama serve`), confirm `ollama list`, then press **Rescan** in the model selector. If Ollama runs on a non-default host/port, add it via the model selector's custom endpoint.

**Context looks too small / long tasks get cut off** → Bake in a bigger window (`ollama run <model> --ctx 32768`) so it's detected via `/api/show`; otherwise the app falls back to a hardware-aware (~2k tokens/GB VRAM) floor of 8 k.

**Writes are being blocked / lots of prompts** → Lower the write policy: `review` → `ask` → `allow`. `ask` prompts per change; `allow` auto-approves; keep `ask`/`review` for anything you want to review.

**Edit rejected with a "stale" / conflict error** → You changed the file externally while the agent had it open. Re-run the prompt or let the agent re-read the file; the conflict guard refuses stale writes by design.

**`run_command` says "not allowlisted"** → Only the [allowlist commands](#command-allowlist) can run, with no shell metacharacters. Add what you need to `.devforge.json` → `verifyCommands`, or run it yourself in a terminal.

**Task restarted from the beginning after stopping / long run** → Check the durable ledger at `.devforge/tasks/<runId>.md`; on any resume (auto-continue or crash/cancel) the agent resumes from the in-progress step recorded there. If that file is missing/empty, the agent didn't maintain its plan — use the `complex_task` or `coding` mode, which strongly encourage planning.

**"Cancelled" or a run left half-done** → It was stopped (or the process died). The snapshot is kept at `.opencode/runs/<runId>.json`. Resume via **pending resums** in the UI, then re-send to continue.

**A model edit broke something** → Use per-file **Revert**, or the **Checkpoint timeline** to roll the whole workspace back. Every overwrite is snapshotted first.

**Diagnose shows compiler errors after a run** → The auto-verify loop feeds them back for self-heal (up to 3 attempts); if it still fails, read the LSP panel and ask the agent to fix the specific error, or revert.

**LAN access won't open / token** → `DEVFORGE_HOST=lan npm run dev`; grab the printed token and open `http://<host>:3000`. Loopback is trusted; remote clients need the token + CSRF header (the app handles the latter).

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server (Express + Vite middleware) at http://127.0.0.1:3000 |
| `npm test` | Vitest suite (291 tests across 35 suites) |
| `npm run lint` | TypeScript check (`tsc --noEmit`) |
| `npm run build` | Production build (Vite + esbuild) |
| `npm start` | Run the production server (`dist/server.cjs`) |
| `npm run eval` | Agentic regression suite (`benchmark/eval.ts`) |
| `npm run package` | Windows release build (PowerShell) |
| `npm run clean` | Remove `dist/` and `build/` |

---

## Benchmark

Tested against real repositories on the developer's machine (RTX 5090 + `qwen3-coder-next`):

| Test | Score |
|---|---|
| 34 real projects, read-only analysis | **93.1 / 100** |
| 6 projects with live agent edits | **91.3 / 100** (5/6 perfect edit → preserve → revert cycles) |

Read-only checks never modify repos; live-edit tests run on temporary copies only. Full methodology and results: **[BENCHMARK.md](BENCHMARK.md)**.

---

## License

MIT — see [LICENSE](LICENSE).
