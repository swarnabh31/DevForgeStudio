# Why Local? — DevForge vs cloud coding agents

DevForge competes with Claude Code, opencode, Cursor, and Antigravity on its
own terms: **fully local + best-in-class GUI**. Here is why that matters.

## 1. Privacy is structural, not a policy

- Your code never leaves the machine. Not "we don't train on your data" —
  it physically cannot leave.
- No account, no telemetry, no terms-of-service changes to worry about.
- Works on air-gapped machines, client NDA code, proprietary IP.

## 2. No per-token economics

- A long agentic run can burn hundreds of LLM calls. Locally that costs
  electricity; in the cloud it costs a subscription or metered tokens.
- Iterate as much as the task needs — the auto-verify loop, self-heal, and
  research subagents exist precisely because local runs are cheap to retry.

## 3. Latency you control

- Prompt-eval time dominates agent loops on repeated context. DevForge keeps
  prompts prefix-stable where possible, measures prompt-eval per iteration,
  and compacts context proactively at 75% of budget — all tunable locally.

## 4. Hardware empathy

- Context windows sized to YOUR VRAM (`server/systemProfile.ts`), not to a
  pricing tier. Model recommendations matched to your GPU.

## The honest trade-offs

| | Local (DevForge) | Cloud agents |
|---|---|---|
| Peak capability | 7B–32B open models | Frontier models |
| Privacy | Absolute | Policy-based |
| Cost at scale | ~Free | Metered |
| Offline / air-gapped | Yes | No |
| Auditability | Full (everything on disk) | Limited |

If your tasks genuinely need frontier-model reasoning, a cloud tool may win
today. If you need privacy, predictability, offline operation, and unlimited
iteration on real repositories — that intersection is what DevForge owns.
