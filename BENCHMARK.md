# DevForge Studio — Real-World Benchmark Results

> **Transparency note:** We publish our benchmark *results and methodology* so you can judge
> DevForge Studio on real evidence. The test harness itself is internal — this page explains
> exactly what was measured, how, and what the numbers mean.

## Headline results

Tested against **real open-source repositories** (not toy fixtures) on a single consumer GPU
(RTX 5090) running **qwen3-coder-next** via Ollama — no cloud APIs involved.

| Test | Result |
|---|---|
| **34 real projects** — read-only agent analysis | **93.1 / 100** |
| **6 real projects** — live agent edits on temp copies | **91.3 / 100** |
| Live edit success rate | **5 / 6 perfect cycles** (edit → code preserved → diff tracked → clean revert) |

## What was tested

Each project was put through seven graded checks (weighted):

| Check | Weight | What it proves |
|---|---|---|
| **Workspace Scan** | 15% | Gitignore-aware indexing of the whole repo — respects `.gitignore`, skips binaries/junk |
| **Ranged Read** | 10% | Byte-accurate file reads verified against disk content |
| **Search** | 15% | Ripgrep-backed search across the repo with JS fallback |
| **Code Outlines** | 10% | Symbol extraction (functions/classes/imports) from source files |
| **Import Graph** | 10% | Dependency + blast-radius analysis ("what breaks if I change this?") |
| **Diagnostics** | 15% | Real compiler/linter integration (`tsc --noEmit` for TypeScript, `ruff` for Python) |
| **Live Agent Edit** | 20% | The full agentic cycle: the agent edits a file in a temp copy of the repo, all other files must remain untouched, the change must appear as a tracked diff, and revert must restore the original byte-for-byte |
| **Infra & Security** | 5% | Hardware detection, persistence, and path-traversal attack blocking (HTTP 403) |

## How it was run

1. Real public repos of varying sizes (5–264 files) were used as-is.
2. Read-only checks scanned/searched/analyzed the actual repositories.
3. For live-edit tests, each repo was copied to a **temporary directory first** — original
   repositories were never modified.
4. Every check was scored automatically: content compared against ground truth from disk,
   diffs verified, reverts confirmed byte-for-byte identical to the originals.
5. Security checks included active path-traversal attempts against every filesystem endpoint.

## Highlights

- **Perfect 100% workspace scans on all 6 live-edit projects**, including a 264-file repo indexed
  in 1.7s.
- **Sub-second searches**: 30+ ripgrep hits in ~15ms on typical repos.
- **Flawless edit-and-revert on 5/6 projects** — including a React/TypeScript app where the agent
  edited `src/tools/text/text-cleaner/index.tsx` while preserving all 263 other files, tracking
  the diff, and reverting cleanly.
- **Security held**: traversal attacks blocked with HTTP 403; persistence stores verified intact.

## Reproducibility

The methodology above is fully described so anyone can construct an equivalent harness. The
benchmark suite itself is kept internal while DevForge Studio is under active development.
Numbers shown are unedited outputs from automated scoring — no manual adjustments.

---

*Generated from the automated run of 2026-08-24 · model `qwen3-coder-next` · CUDA, RTX 5090 (32GB VRAM)*
