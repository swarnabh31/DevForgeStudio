# DevForge Studio

> **Your Local-First AI Software Engineering Studio.**

A **local-first, in-browser AI coding agent**. It reads, searches, edits, and verifies **real files on your disk** using **your own locally-downloaded models** (Ollama or any OpenAI-compatible local server). No cloud APIs, no telemetry, no subscriptions — your code never leaves your machine.

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
- **Private by design** — localhost-only server, no cloud calls, no telemetry.
- **Hardware-aware** — detects your GPU/VRAM/RAM and tunes context windows and sampling accordingly.
- **Model-agnostic** — auto-detects every model served by Ollama, LM Studio, or any OpenAI-compatible endpoint.
- **Transparent** — you see every tool call, every file change, every diff, live.

---

## Feature Guide

### 1. Agent Chat
The main interface. Type a request ("add input validation to `server.ts`", "fix the failing test") and watch the agent work in real time:

- **Live token streaming** — replies appear as they're generated.
- **Visible tool use** — every `list_files`, `search`, `read_file`, `write_file`, `apply_patch`, and `run_command` is shown as it happens.
- **Markdown replies** with syntax-highlighted code blocks and color-coded unified diffs inline.
- **Slash commands**: `/test`, `/fix`, `/explain`, `/new-session`. Send with Ctrl/Cmd+Enter; stop a run with Esc or the Stop button.
- **Thinking capability selector** — choose *No thinking* (default), *Low*, *Medium*, or *High*. With "No thinking", qwen3-family models skip their reasoning phase entirely (`/no_think`), saving tokens and time; any leaked `<think>` blocks are stripped from replies.
- **Permission prompts** — depending on your write policy (`ask`/`allow`/`deny`), the agent pauses and asks before writing files, applying patches, or running commands.

### 2. Code Workspace sidebar
Docked beside the chat (drag the divider between them to resize):

- **Load Folder** — paste an absolute path (e.g. `C:\Users\you\MyProject`) and press Enter to make it the active workspace. Quoted paths from Windows "Copy as Path" are handled automatically. If you leave the field empty, your native folder picker opens instead.
- **Import Folder / Files** — import folders directly from your PC into the workspace.
- **File tree + CodeMirror 6 editor** — open and edit any workspace file with syntax highlighting for JS/TS/Python/JSON/HTML.
- **Per-file Diff & Revert** — hover a file to see its diff against the last agent edit, or revert it to the pre-edit snapshot.
- **Refresh Workspace** — re-scan the folder on disk (external changes are picked up).
- **Terminal view** — run allowlisted commands (`npm start`, tests) and see output.
- **LSP diagnostics footer** — real `tsc --noEmit` / `ruff check` errors shown under the open file.

### 3. Task Modes
Pick a mode in the header; the app tunes temperature, top-p, repeat penalty, iteration budget, context window, and a persona prompt per task:

| Mode | Best for |
|---|---|
| General Q&A | Explanations, quick questions |
| Coding | Implementing features |
| Debugging | Reproduce → locate → minimal fix |
| Test Running | Run tests, interpret failures |
| Test Creation | Write unit/integration tests |
| Refactoring | Restructure without behavior change |
| App Development | Build whole features end-to-end |
| Complex Task | Multi-step, multi-file engineering (largest iteration budget) |

### 4. Model Detection & Context Control
- Auto-scans Ollama (`:11434`), LM Studio (`:1234`) and common ports; press **Rescan** if none appear.
- Your model's own context setting (`PARAMETER num_ctx` baked into the Ollama model, e.g. `ollama run qwen3:27b --ctx 62720`) is detected via `/api/show` and respected — not clamped.
- Without an explicit setting, a hardware-aware estimate (~2k tokens/GB VRAM, halved for large models) is used.

### 5. Agent Pipeline visualizer
The "Agent Pipeline" tab shows the agent's plan and progress as a live node graph driven by real loop events — not a canned animation.

### 6. Multi-session management
Run multiple named agent sessions with isolated chats; sessions persist locally across restarts.

---

## Safety by default

- **Localhost-only** — the server binds to `127.0.0.1`; nothing is exposed to your network.
- **Path guard** — every filesystem operation blocks traversal attacks (extensively tested).
- **Permission gate** — write/patch/command tools respect `ask` / `allow` / `deny`.
- **Command allowlist** — only `npm test/lint/build`, `tsc --noEmit`, `vitest run`, `pytest`, `ruff check`, `git status/diff` can execute.
- **Atomic writes + backups** — every overwrite snapshots to `.opencode/backups/`; revert per-file or whole-run.
- **Conflict detection** — if you edit a file externally while the agent holds stale contents, writes refuse until the model re-reads.
- **Real verification loop** — after file-changing runs, compiler errors are fed back to the model for self-correction.

## Benchmark results

Tested against real repositories on the developer's machine (RTX 5090 + qwen3-coder-next):

| Test | Score |
|---|---|
| 34 real projects, read-only analysis | **93.1 / 100** |
| 6 projects with live agent edits | **91.3 / 100** (5/6 perfect edit → preserve → revert cycles) |

Tested against real repositories with an automated, non-invasive harness � read-only checks never modify repos; live-edit tests run on temporary copies only. Full methodology and results: **[BENCHMARK.md](BENCHMARK.md)**.

---

## Getting Started

### Prerequisites

1. **Node.js 20+** — https://nodejs.org
2. **Ollama** (or LM Studio / any OpenAI-compatible local server) — https://ollama.com/download
3. A local model, e.g.:

```bash
ollama pull qwen2.5-coder:7b
```

Optional: bake in a bigger context window so the app picks it up automatically:

```bash
ollama run qwen2.5-coder:7b --ctx 32768
```

### Quickstart

```bash
git clone <this-repo>
cd opencode-agent-studio
npm install

# start Ollama in another terminal (if not already running):
ollama serve

npm run dev
```

Open **http://127.0.0.1:3000**. Then:

1. Pick a model from the header dropdown (press **Rescan** if empty).
2. Choose a task mode.
3. Set your target directory in the Code Workspace sidebar (**Load Folder**) — or just start chatting and let the agent explore the default workspace.
4. Prompt away. Approve permission prompts as they appear.

### First-run tips

- If no models are detected, follow the in-app guided panel: start Ollama → pull a model → Rescan.
- Use **No thinking** for fast Q&A; switch to higher thinking levels for hard debugging.
- Every agent edit is backed up — use the per-file Revert button if you don't like a change.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server (Express + Vite middleware) at http://127.0.0.1:3000 |
| `npm test` | Vitest suite (69 tests across 10 suites) |
| `npm run lint` | TypeScript check (`tsc --noEmit`) |
| `npm run build` | Production build |
| `npm start` | Run production server |

## How it works

```
server.ts                Express backend + Vite middleware + all routes
server/
├── lib.ts               resolveSafePath guard, language map, ignored dirs
├── fsTools.ts           gitignore-aware walker, ranged reads, search, outlines
├── agentLoop.ts         tool schemas + executeTool + runAgentLoop (streaming,
│                        permissions, thinking control, JSON-action fallback)
├── backups.ts           snapshot engine + list/revert
├── diffUtil.ts          unified diffs from backup-vs-disk
├── diagnostics.ts       tsc --noEmit + ruff runners/parsers, import graph
├── systemProfile.ts     GPU/VRAM/RAM/CPU detection
├── taskProfiles.ts      8 task modes → sampling params + personas
└── persistence.ts       .opencode/store.json + logs/runs.jsonl
src/
├── App.tsx              state engine; NDJSON streaming client; resizable split;
│                        slash commands
└── components/          chat UI, diffs, CodeMirror workspace, pipeline view…
tests/                   69 Vitest tests
BENCHMARK.md             benchmark methodology + published results
```

The agent streams over `POST /api/agent/stream` as newline-delimited JSON events (`iteration`, `token`, `tool_call`, `tool_result`, `files_changed`, `permission_request`, `done`). Sessions persist locally; `/test`, `/fix`, `/explain`, and `/new-session` slash commands are available in chat.

## Security posture

- Localhost-only binding (`127.0.0.1`)
- Path traversal protection on every filesystem route
- Binary-extension write blocking; text-only atomic writes
- Command allowlist; permission gating for side-effecting tools
- Automatic backups before every overwrite, with revert support

## License

MIT — see [LICENSE](LICENSE).
