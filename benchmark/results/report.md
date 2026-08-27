# OpenCode Agent Studio — Real-World Benchmark Report

_Generated: 2026-08-24T08:54:17.525Z_

**Projects tested:** 6 · **Model:** qwen3-coder-next:latest · **Agent edit tests:** ON (temp copies)

## Overall Score: 91.3 / 100

| Category | Score | Detail |
|---|---|---|
| Workspace Scan (15%) | 100% | 13 files indexed, gitignore respected, sample=organizer/config_manager.py |
| Ranged Read (10%) | 100% | content verified vs disk (77 lines) |
| Search (15%) | 100% | 30+ hits via ripgrep in 15ms |
| Outlines (10%) | 100% | 9 symbols extracted from organizer/config_manager.py |
| Import Graph (10%) | 83% | 0 direct deps, 0 total edges touching this file |
| Diagnostics (15%) | 75% | python project — ruff path only |
| Live Agent Edit (20%) | 83% | edit applied, rest preserved, diff tracked, revert clean (0 tokens streamed) |
| Infra/Security (5%) | 100% | cuda, 32607MB VRAM, ctx budget 65536 |

## Per-Project Results

| Project | Files | A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|---|---|
| BulkFileOrganizer | 13 | 100% | 100% | 100% | 100% | 100% | 70% | 100% |
| CodeBenchAgent | 52 | 100% | 100% | 100% | 100% | 0% | 70% | 100% |
| DevToolBox | 264 | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| DocuMindAI | 5 | 100% | 100% | 100% | 100% | 100% | 70% | 100% |
| FlowNote | 119 | 100% | 100% | 100% | 100% | 100% | 70% | 0% |
| Github_QnA_bot | 17 | 100% | 100% | 100% | 100% | 100% | 70% | 100% |

## Detailed Findings

### BulkFileOrganizer

- ✅ **A. workspace-scan** (3ms): 13 files indexed, gitignore respected, sample=organizer/config_manager.py
- ✅ **B. ranged-read** (1ms): content verified vs disk (77 lines)
- ✅ **C. search** (15ms): 30+ hits via ripgrep in 15ms
- ✅ **D. outline** (1ms): 9 symbols extracted from organizer/config_manager.py
- ✅ **E. import-graph** (1ms): 0 direct deps, 0 total edges touching this file
- 🟡 **F. diagnostics** (0ms): python project — ruff path only
- ✅ **G. live-agent-edit** (51980ms): edit applied, rest preserved, diff tracked, revert clean (0 tokens streamed)

### CodeBenchAgent

- ✅ **A. workspace-scan** (219ms): 52 files indexed, gitignore respected, sample=core/ingestion/manifest.py
- ✅ **B. ranged-read** (1ms): content verified vs disk (98 lines)
- ✅ **C. search** (15135ms): 30+ hits via js in 15134ms
- ✅ **D. outline** (1ms): 5 symbols extracted from core/ingestion/manifest.py
- ❌ **E. import-graph** (120004ms): graph failed: 0
- 🟡 **F. diagnostics** (0ms): python project — ruff path only
- ✅ **G. live-agent-edit** (205781ms): edit applied, rest preserved, diff tracked, revert clean (0 tokens streamed)

### DevToolBox

- ✅ **A. workspace-scan** (1712ms): 264 files indexed, gitignore respected, sample=src/tools/text/text-cleaner/index.tsx
- ✅ **B. ranged-read** (1ms): content verified vs disk (101 lines)
- ✅ **C. search** (158ms): 30+ hits via ripgrep in 157ms
- ✅ **D. outline** (1ms): 1 symbols extracted from src/tools/text/text-cleaner/index.tsx
- ✅ **E. import-graph** (13ms): 4 direct deps, 583 total edges touching this file
- ✅ **F. diagnostics** (2ms): tsconfig present; tsc via local node_modules
- ✅ **G. live-agent-edit** (53484ms): edit applied, rest preserved, diff tracked, revert clean (0 tokens streamed)

### DocuMindAI

- ✅ **A. workspace-scan** (35ms): 5 files indexed, gitignore respected, sample=chat.py
- ✅ **B. ranged-read** (0ms): content verified vs disk (83 lines)
- ✅ **C. search** (132ms): 23+ hits via ripgrep in 131ms
- ✅ **D. outline** (0ms): 2 symbols extracted from chat.py
- ✅ **E. import-graph** (1ms): 0 direct deps, 0 total edges touching this file
- 🟡 **F. diagnostics** (0ms): python project — ruff path only
- ✅ **G. live-agent-edit** (49625ms): edit applied, rest preserved, diff tracked, revert clean (0 tokens streamed)

### FlowNote

- ✅ **A. workspace-scan** (522ms): 119 files indexed, gitignore respected, sample=services/settings_service.py
- ✅ **B. ranged-read** (1ms): content verified vs disk (72 lines)
- ✅ **C. search** (144ms): 30+ hits via ripgrep in 144ms
- ✅ **D. outline** (1ms): 10 symbols extracted from services/settings_service.py
- ✅ **E. import-graph** (21581ms): 2 direct deps, 4072 total edges touching this file
- 🟡 **F. diagnostics** (0ms): python project — ruff path only
- ❌ **G. live-agent-edit** (9207ms): failed to load temp copy: Error: read ECONNRESET

### Github_QnA_bot

- ✅ **A. workspace-scan** (100ms): 17 files indexed, gitignore respected, sample=repository_intelligence/hierarchical_retriever.py
- ✅ **B. ranged-read** (1ms): content verified vs disk (174 lines)
- ✅ **C. search** (61ms): 30+ hits via ripgrep in 61ms
- ✅ **D. outline** (1ms): 4 symbols extracted from repository_intelligence/hierarchical_retriever.py
- ✅ **E. import-graph** (2ms): 0 direct deps, 11 total edges touching this file
- 🟡 **F. diagnostics** (0ms): python project — ruff path only
- ✅ **G. live-agent-edit** (53132ms): edit applied, rest preserved, diff tracked, revert clean (0 tokens streamed)

### Infrastructure / Security

- ✅ **H1. system-profile**: cuda, 32607MB VRAM, ctx budget 65536
- ✅ **H2. persistence-store**: store.json=present, runs.jsonl=present
- ✅ **H3. security-traversal-block**: blocked with HTTP 403

## Analysis

- ✅ **Workspace Scan (15%): working well.**
- ✅ **Ranged Read (10%): working well.**
- ✅ **Search (15%): working well.**
- ✅ **Outlines (10%): working well.**
- 🟡 **Import Graph (10%): mostly working** — review individual failures above.
- 🟡 **Diagnostics (15%): mostly working** — review individual failures above.
- 🟡 **Live Agent Edit (20%): mostly working** — review individual failures above.
- ✅ **Infra/Security (5%): working well.**