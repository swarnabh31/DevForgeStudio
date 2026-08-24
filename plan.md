# plan.md — Making DevForge Studio a Dependable Coding Agent

> Working execution plan derived from `Memory.md` (§4 gap analysis, §5 roadmap).
> Goal: turn the current UI + mock-agent into an agent that can genuinely
> **read → analyse → write → edit** real code in **large repos**, with a real
> tool-calling loop, streaming, safety guards, and persistence.
>
> Each phase ends in a shippable, verifiable state. Work top-down; do not start
> a phase until the previous phase's exit criteria pass.

---

## Decisions (locked in before Phase 1)

| # | Decision | Choice |
|---|---|---|
| D1 | Default workspace | App's own directory (`process.cwd()`); "Load Folder" overrides |
| D2 | Permissions | Ask-before-write & ask-before-non-allowlisted-command (OpenCode-style), with session-scoped "always allow" |
| D3 | Tool calling | OpenAI-style `tools` when model supports it; structured-JSON action fallback otherwise |
| D4 | State location | Single `.opencode/` store at workspace root (sessions, LTM, backups, logs) |
| D5 | Visualizer label | Relabel to "Agent Pipeline"; wire it to real loop steps later (L4) |
| D6 | Streaming protocol | NDJSON over POST (`/api/agent/stream`) — simplest with Express, no SSE headers hassle |
| D7 | Safety boundary | All FS ops confined to resolved workspace root (RE5). Reads outside = denied. |
| D8 | Context strategy | System prompt carries file index + outlines only; contents via tools; history trimmed to ~10 turns |

---

## Phase 0 — Foundations & hygiene (small, unblocks everything)

1. **P0.1 Security fixes now**
   - Bind server to `127.0.0.1` instead of `0.0.0.0`.
   - Add `resolveSafePath(root, userPath)` guard; use on every FS route.
   - Remove fictional seeded "CodeAtlas" LTM entries.
2. **P0.2 Repo hygiene**
   - Check `.env` contents; ensure gitignored; rename package to `opencode-agent-studio`.
   - Extract shared helpers module `server/lib.ts`: language map, ignore list, path guard.
3. **P0.3 Test scaffold**
   - Add Vitest; tests for path guard, language detection, ignore matching.
   - CI gate script: `npm run lint && npm test`.

**Exit criteria:** `npm run lint && npm test` green; no LAN exposure; path guard tested.

---

## Phase 1 — REAL filesystem workspace (Read)

1. **R1 Real disk workspace**: workspace root = real directory; in-memory copy becomes a cache only. All reads/writes go through guarded fs calls.
2. **R2 Gitignore-aware scan**: parse `.gitignore` + `.git/info/exclude` + defaults (`node_modules`, `.git`, `dist`, …) using `ignore` npm package.
3. **R3 Ranged read API**: `GET /api/workspace/read?path&offset&limit` → content, size, mtime, language. Never return binary as text (detect by NUL byte / extension list).
4. **R4 Central language map** in `server/lib.ts`.
5. **R5 Search tool**: wrap ripgrep if available, fallback to JS walker grep: `POST /api/tools/search {query, glob, maxResults}` with result caps.
6. **R6 File outline**: regex-based extraction of top-level functions/classes/exports/interfaces per file → served via `GET /api/workspace/outline?path=` and bulk index endpoint.
7. **Folder tree API** for UI: `GET /api/workspace/tree` (lazy per-directory, capped depth).

**Exit criteria:** Agent can list/search/read any file in a large repo (test on this repo + node_modules-heavy project) within token budget; UI file tree reflects disk.

---

## Phase 2 — Tool-calling agent loop (the core)

1. **L1 Tools schema**: define tools — `list_files`, `search`, `read_file`, `file_outline`, `write_file`, `apply_patch`, `run_command` (gated), `git_diff`. Pass as OpenAI-style `tools` to Ollama/LM Studio.
2. **L2 Loop**: `runAgentLoop()` — max 8 iterations: model → tool call(s) → execute server-side → append results → repeat. Final turn returns summary + files-changed list.
3. **L3 JSON-action fallback** for non-tool models: same loop driven by parsed `{actions:[...]}` blocks.
4. **RE7 Context management**: system prompt = rules + memory + file index w/ outlines (capped); contents arrive via tools; trim history >10 turns; rough token counter per model context size.
5. **L5 Cancellation**: AbortController per run; Stop kills fetch + loop + subprocesses.

**Exit criteria:** Given a task like "add a util and its test in src/", the agent finds files, reads them, writes correct edits across multiple steps, and reports what changed — verified manually against 2 local models.

---

## Phase 3 — Write/Edit safely on disk

1. **W1 Atomic writes**: temp file + rename; preserve permissions.
2. **E1 Patch-based edits**: implement `apply_patch` (exact string replace → fuzzy fallback → error with context hints). Deprecate full-file rewrites for existing files.
3. **E2 Checksum compare**: skip write when unchanged.
4. **W2 Backups**: copy to `.opencode/backups/<ts>/` before each edit batch; `POST /api/workspace/revert` restores last snapshot; UI button.
5. **W3/W4 New-file + binary safety**: mkdir -p parents; refuse binary overwrite; traversal-guarded paths.
6. **RE5 Enforcement**: every write/edit re-validates root containment.
7. **E5 Conflict detection**: track mtime at read; refuse write if changed externally since.

**Exit criteria:** Agent edits survive restarts; a deliberately broken patch fails gracefully without corrupting the file; revert works.

---

## Phase 4 — Real analysis & verification

1. **A1 Real diagnostics**: run `tsc --noEmit` (TS/JS workspaces), `ruff`/`pyright` (Python) as background processes; parse `file:line:col: message`; replace regex LSP.
2. **A2 Post-edit verification hook**: after each write, run diagnostics on touched files; feed failures back into loop (max 2 self-correct rounds).
3. **A3 Test runner**: `run_command` allowlist (`npm test`, `vitest run`, `pytest`, `tsc --noEmit`, `git diff/status/log`); capture stdout/stderr/exit code; summarize pass/fail for the model.
4. **A4 Import graph**: regex import/export parsing → dependency map endpoint; used to prioritize regression checks after edits.

**Exit criteria:** Agent that breaks types gets real tsc errors back and fixes them within the same run.

---

## Phase 5 — Streaming, persistence, permissions

1. **RE2 Streaming**: `/api/agent/stream` (NDJSON events: `token`, `tool_call`, `tool_result`, `diagnostics`, `done`); client renders incrementally; wire Stop.
2. **RE1 Persistence**: `.opencode/store.json` (or SQLite later) — sessions, messages, LTM, model prefs, permission grants. Load on boot; merge with localStorage client cache.
3. **RE4 Permission prompts**: before first write / non-allowlisted command per session, pause loop, emit `permission_request` event; UI Allow once / Always / Deny; Deny returns refusal to model as tool result.
4. **RE3 LLM hardening**: per-call timeout, 2 retries w/ backoff, per-model options (`num_ctx`, `temperature`), clear unreachable-model errors.
5. **RE6 Run log**: append structured JSONL per run (prompt sizes, tool calls, durations, files touched) under `.opencode/logs/`.

**Exit criteria:** Refresh mid-run keeps history; streaming visible token-by-token; write/command triggers a prompt unless allowed.

---

## Phase 6 — Large-repo scale & UX polish

1. **U1 Markdown rendering** in chat (react-markdown or marked + highlight.js) — code fences with copy buttons.
2. **U3 Real diff view**: unified diffs in chat + CodeWorkspace (compute server-side vs backup).
3. **U4 Real editor**: CodeMirror 6 with TS/Python highlighting; diagnostics gutter; tree from disk API.
4. **U5 Wired controls**: Stop/Pause truly abort; Revert/Diff/Test buttons per file.
5. **U6 Commands & shortcuts**: `/fix`, `/test`, `/explain`, `/new-session`; Ctrl+Enter send, Esc stop.
6. **Scale items**: lazy tree, search caps, outline caching with mtime invalidation, parallel tool-call execution where safe.
7. **Relabel visualizer** to "Agent Pipeline" fed by real loop steps (D5).

**Exit criteria:** Comfortable 30-minute real coding session on a repo ≥500 files without context blowups or stale UI.

---

## Phase 7 — Reliability hardening (ongoing)

- **RE8 Tests**: unit tests for tools, patch engine, path guard, context trimming, diagnostics parsers; one e2e scripted agent run against a mock LLM server.
- **No-op guard**: stop loop when model repeats identical failed actions.
- **Multi-file transactions**: all-or-nothing batches (build on backups).
- Later/P2: embeddings-based project memory (`nomic-embed-text` + local vector store), file watching, plan-then-act mode (L4).

---

## Suggested working order

```
Phase 0 → 1 → 2 → 3   (core dependable agent)
Phase 4, 5            (verification + trust)
Phase 6, 7            (polish + hardening)
```

Phases 4–6 can partially interleave once Phase 3 is done (e.g., U1 markdown early since chat UX pain is immediate).

## Verification after every phase

```bash
npm run lint        # tsc --noEmit
npm test            # Vitest (from P0.3 onward)
npm run dev         # manual smoke: detect models → multi-step task → check disk edits
```
