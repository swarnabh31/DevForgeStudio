# Memory.md — DevForge Studio

> Project memory for the next session. Explains the current state and functions of the app.
>
> **Status: all phases of plan.md (0–7) are IMPLEMENTED.** The app is a real, local-first coding
> agent — not a mock. Read plan.md for phase details; this file describes what exists now.

---

## 1. What this project is

**DevForge Studio** is a local-first, in-browser AI coding agent that reads, searches, edits,
and verifies **real files on the user's disk** using **their own downloaded local models**
(Ollama / any OpenAI-compatible local server). No external/cloud APIs.

- Model discovery auto-scans `localhost:11434` (Ollama), `:1234` (LM Studio) and common ports;
  a header dropdown lists detected models — nothing hardcoded.
- **Task-Aware Intelligence (USP)**: the user picks a task mode; the app tunes model parameters per
  task AND per hardware profile (GPU/VRAM detection sizes the context window).

## 2. Tech stack & layout

```
server.ts                          Express backend + Vite middleware + all routes (~1300 lines)
server/
├── lib.ts                         resolveSafePath guard, language map, DEFAULT_IGNORED_DIRS
├── fsTools.ts                     gitignore-aware walker, ranged reads, search (rg + JS fallback),
│                                  outlines, binary detection, mtime conflict registry
├── agentLoop.ts                   TOOL_SCHEMAS, executeTool, runAgentLoop (streaming + permissions
│                                  + no-op guard), JSON-action fallback, ALLOWED_COMMAND_PREFIXES
├── backups.ts                     .opencode/backups snapshot engine, list/revert
├── diffUtil.ts                    unified diffs from backup-vs-disk ('diff' package)
├── diagnostics.ts                 tsc --noEmit + ruff runners/parsers, import graph
├── systemProfile.ts               GPU/VRAM/RAM/CPU detection (nvidia-smi, AMD CIM, Apple Metal)
├── taskProfiles.ts                8 task modes → temperature/top_p/num_ctx/iterations/persona
└── persistence.ts                 .opencode/store.json + logs/runs.jsonl
src/
├── App.tsx                        State engine; NDJSON streaming client; /commands; Stop wiring
├── types.ts                       Shared interfaces (incl. TaskMode, SystemProfile)
├── data/models.ts                 createLocalModelObject() (DEFAULT_LOCAL_MODEL only as fallback)
└── components/
    ├── Header.tsx                 Model dropdown (auto-detected), Task-mode dropdown, HW badge
    ├── ChatInterface.tsx          Markdown replies, DiffView, attachments, thinking selector
    ├── Markdown.tsx               react-markdown + rehype-highlight rendering
    ├── DiffView.tsx               Color-coded unified diff renderer
    ├── CodeWorkspace.tsx          CodeMirror 6 editor, file tree, terminal view
    ├── AgentGraphVisualizer.tsx   "Agent Pipeline" fed by real loop results
    ├── LspPanel / MultiSessionManager / SettingsModal / ModelSelectorModal /
    │   MemoryInspector / PrerequisitesBanner
tests/                            69 Vitest tests across 10 suites
plan.md                           Phase 0–7 execution plan (all complete)
```

Scripts: `npm run dev` · `npm test` (Vitest) · `npm run lint` (`tsc --noEmit`) · build/start for prod.

## 3. How it works now

### Models & task intelligence
- `POST /api/models/detect-local` probes endpoints via Ollama `/api/tags` + `/v1/models`; client also
  scans directly. Dropdown shows only what was found; empty list = "No models detected".
- `GET /api/system/profile`: detects GPU(s)/VRAM (nvidia-smi → AMD CIM → Apple unified memory),
  RAM, acceleration (cuda/metal/rocm/cpu); computes recommended context tokens (~2k/VRAM-GB).
- Task modes (general/coding/debugging/testing/test_creation/refactoring/app_development/
  complex_task) set temperature, top_p, repeat_penalty, max loop iterations, num_ctx (halved for
  large models), plus a persona addendum in the system prompt. Params are **per-request Ollama
  `options` / OpenAI payload fields — never global server settings**.

### Agent loop (`runAgentLoop`)
- OpenAI-style tools: `list_files`, `search`, `read_file`, `file_outline`, `write_file`,
  `apply_patch`, `run_command`, `git_diff`. Max iterations from task mode (3–14).
- Token streaming from Ollama (`stream:true`, NDJSON consumption); OpenAI-compat stays non-streaming.
- RE4 permission gate before write_file/apply_patch/run_command (`ask`/`allow`/`deny` policies,
  resolved via `/api/agent/permission`; legacy route auto-allows).
- No-op guard breaks after 3 identical failing calls. Retry w/ backoff per endpoint.
- JSON-action fallback (`{modifiedFiles, patches}`) for non-tool models.

### Filesystem reality
- Workspace root defaults to `process.cwd()`; "Load Folder" overrides per session. All FS ops go
  through `resolveSafePath` (blocks traversal; tested incl. null bytes, sibling tricks).
- Gitignore-aware scanning (`.gitignore` + `.git/info/exclude` + nested + defaults, `ignore` pkg);
  symlinks skipped; binary-safe reads with offset/limit ranges.
- Writes are atomic (temp+rename), checksum-deduped, text-extension-only.
- Backups: every overwrite snapshots to `.opencode/backups/<ts>__<session>/` (lazy — read-only runs
  create nothing). `GET /api/workspace/backups` + `POST /api/workspace/revert`.
- Conflict detection: mtimes recorded on agent reads; external edits make write/patch refuse with
  CONFLICT until the model re-reads.
- Search uses ripgrep when available (JS walker grep fallback). Import graph:
  `GET /api/tools/import-graph?path=` → dependencies + importedBy (blast radius).

### Verification
- Real diagnostics: `tsc --noEmit` (10s cache) + `ruff check`, parsed into structured records.
- After runs that change files, one corrective loop pass feeds real compiler errors back to the model.
- Per-write regex verification hook appends errors to tool results for in-run self-correction.
- `run_command` allowlist only: npm test/lint/build, tsc --noEmit, vitest run, pytest, ruff check,
  git status/diff.

### Streaming, persistence, observability
- `POST /api/agent/stream` (NDJSON): `iteration`, `token`, `tool_call`, `tool_result`,
  `files_changed`, `permission_request`, `done` (includes reply, actions, filePatches, params).
- Client renders tokens live; Stop aborts reader + kills server loop (`/api/agent/cancel`).
- `.opencode/store.json` persists LTM + session transcripts (atomic writes, loaded on boot);
  `.opencode/logs/runs.jsonl` structured run records.
- Legacy `POST /api/agent/run` still exists (non-streaming, same loop) for compatibility.

### UI
- Markdown chat w/ highlighted code; unified diffs inline; CodeMirror editor; model dropdown +
  task dropdown + hardware badge; sessions persist to localStorage; `/test` `/fix` `/explain`
  `/new-session`; Ctrl/Cmd+Enter send, Esc stop; tab renamed "Agent Pipeline".

## 4. Security posture
- Server binds `127.0.0.1`. Path guard on every FS route/model-write. Binary-extension write block.
- Command allowlist; permission prompts for side-effecting tools; no-op guard; backups+revert.

## 5. Remaining ideas (from original roadmap P2 tier — none blocking)
- File watching for external edits (conflict detection covers safety already)
- Embeddings-based project memory (nomic-embed-text available locally)
- Plan-then-act mode surfaced in the visualizer; multi-file all-or-nothing transactions
- Per-session permission "always allow" memory

## 5.5 Git/GitHub operations — DECIDED, ON HOLD
Two-stage plan agreed with owner; do NOT start without asking:
1. **Stage 1 (local git)**: `git_commit/add/branch/checkout/log` tools — reversible ops, fit
   existing permission model. Enables agent checkpointing its own work.
2. **Stage 2 (remote)**: `git_push` + `gh` CLI PR creation. Push NEVER auto-allowed (prompt every
   time), no force-push ever, no pushing to main without explicit confirm, verification required
   before offering to commit.
Hard-deny list: git config changes, credentials, hooks, history rewriting (rebase/filter-branch),
GitHub settings/access management.

## 6. Benchmark & marketing assets (KEEP)
`benchmark/run-benchmark.ts` is a non-invasive real-world test harness:
- Tests against real repos read-only; live agent-edit tests run on TEMP COPIES only
- Own session IDs; reuses running app or boots its own server on :3000
- Usage: `npx tsx benchmark/run-benchmark.ts --max 40 [--agent] [--projects-dir <path>]`
- **Results (owner's machine, RTX 5090 + qwen3-coder-next):**
  - All 34 real projects, read-only: **93.1 / 100**
  - 6 projects with live agent edits: **91.3 / 100** (5/6 perfect: edit applied → code preserved
    → diff tracked → clean revert)
- **MARKETING PLAN**: keep benchmark results as authenticity proof for the product page/README —
  "tested against N real repositories, here's exactly what was tested and how scored". Publish
  report.md (sanitized) alongside a methodology description. Do not delete results.

## 7. ⚠️ NEXT SESSION TODO — "Pre-share checklist" (~1–2 days)
Goal: make the MVP genuinely shareable. Pick up here:
1. **README**: prerequisites (Node 20+, Ollama install, `ollama pull <model>` quickstart), setup
   steps, feature overview, benchmark-results section (see §6)
2. **First-run UX**: when model dropdown is empty, show in-app guided panel ("1. Start Ollama
   (`ollama serve`) → 2. pull a model (`ollama pull qwen2.5-coder:7b`) → 3. Rescan") instead of
   just "No models detected"
3. **Error surfaces**: chat errors when Ollama is down must be actionable ("Start Ollama and press
   Rescan") — not raw fetch failures. Audit both stream + legacy paths.
4. **Repo hygiene**: add LICENSE (MIT suggested), ensure `benchmark/results/` and `.opencode/` are
   gitignored, verify `.env.example` matches reality
5. **Kill or clearly mark legacy `/api/agent/run`** — two agent code paths invite bugs; prefer
   removing once streaming path confirmed stable (it is, per benchmarks)

## 8. Session log
- **Latest session (2026-08-24) — UX & model-config fixes**:
  - **"No thinking" selector now actually works**: previously `thinkingLevel` was sent to the
    server but ignored by the LLM call (only used to bump maxIterations). Now when set to `none`,
    qwen3's `/no_think` soft switch is appended to the last user message and any
    `<think>...</think>` blocks are stripped from replies (`server/agentLoop.ts`:
    `stripThinkBlocks`, threaded through `AgentLoopOptions.thinkingLevel` → `callLLMWithTools`).
  - **Ollama num_ctx respected**: removed effective hard-clamp of context at 32768. New
    `resolveOllamaModelNumCtx()` in server.ts queries Ollama `/api/show` (cached per model) for the
    model's own `PARAMETER num_ctx` (falls back to trained context length from `model_info`) and
    passes it straight through as `num_ctx`. Hardware estimate only used as fallback. NOTE: user's
    ctx must be baked into the model (Modelfile / `ollama run <m> --ctx N`) to be detected.
  - **Load Folder button fixed**: Windows "Copy as Path" pastes quoted paths (`"C:\..."`) which
    broke `existsSync` AND the drive-letter regex → always errored. Both client
    (`CodeWorkspace.tsx handleTriggerLoadDirectory`) and server (`load-directory` route) now strip
    surrounding quotes/whitespace. Empty path input now falls back to opening the native folder
    picker instead of silently doing nothing.
  - **Standalone "Code Workspace" tab REMOVED** (Header nav button + render block + `'workspace'`
    tab type variant). Only ONE CodeWorkspace remains — the sidebar inside Agent Chat.
  - **Resizable split added**: draggable divider between Agent Chat and Code Workspace sidebar
    (`App.tsx`: `workspaceWidth` state + `handleSplitterMouseDown`; min 320px, chat keeps ≥480px).
    Sidebar defaults to 460px on xl so chat is visible on first load (earlier iteration of this fix
    accidentally made the sidebar fill the window — fixed with `xl:w-[460px]` fallback class).
  - Tests: 69 passing across 10 suites; `tsc --noEmit` clean.
- **Earlier sessions**: built benchmark suite (`benchmark/run-benchmark.ts`, non-invasive by design);
  ran full sweep on 34 real projects → 93.1/100; live-edit runs → 91.3/100 with 5/6 perfect agent
  edit+revert cycles. Found & fixed real perf bug: import-graph had no file cap (120s timeout on
  largest repo → capped at 3000 files/512KB, now 330ms). Added per-file Diff/Revert buttons in
  CodeWorkspace (+ `/api/workspace/file-diff`, `/api/workspace/revert-file`). Added GitHub Actions
  CI (`.github/workflows/ci.yml`: lint+test on ubuntu+windows). Discussed & deferred git
  write-ops plan (§5.5). Decided to keep benchmark results as marketing proof (§6).
- **Initial sessions**: Phases 0–7 implemented per plan.md. Highlights: security fixes (localhost bind, path guard, fake seeds removed), real FS workspace + gitignore scanning, tool-calling loop
  with streaming + permissions, atomic writes + backups + revert + conflicts, tsc/ruff verification
  with self-correction round, import graph, task/hardware-aware parameter tuning, markdown chat,
  real diffs, CodeMirror editor, no-op guard, persistence + run logs. Live-verified against local
  Ollama (RTX 5090).

## 9. Run / verify commands
- `npm run dev` → http://127.0.0.1:3000 (server + Vite)
- `npm run lint && npm test` (69 tests)
- Local model probe: `curl http://127.0.0.1:11434/api/tags`
- Streaming smoke: POST `/api/agent/stream` with `{prompt, modelId, sessionId}` → read NDJSON lines
- Ownership models (current scan): qwen3.8:27b(+backup), qwen3.6-64k, qwen3.6(:latest/:27b),
  gpt-oss:20b, gemma4:12b, qwen3-coder-next, deepseek-r1:8b, nomic-embed-text (embedding)
