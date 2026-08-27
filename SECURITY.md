# Security

DevForge Studio is a **local-first** AI coding assistant. By default it binds to
`127.0.0.1`, makes **no cloud calls**, and sends no telemetry. Your code and your
models stay on your machine.

## Threat model we defend against

| Threat | Defense |
|---|---|
| Path traversal in any filesystem API | `resolveSafePath` in `server/lib.ts` — null-byte + `..` guarded, tested in `tests/safety.test.ts` |
| Arbitrary shell command execution by the agent | `isCommandAllowed` — 9-verb prefix allowlist **plus** a shell-metacharacter blocklist (`;`, `&`, `\|`, `<`, `>`, backtick, `$(`, etc.). Smuggling attacks are tested. |
| Binary / executable writes | Write path rejects binary extensions; only text writes are permitted through the agent. |
| Concurrent-edit corruption (you edit while the agent holds stale content) | mtime+size+sha1 conflict registry (`server/fsTools.ts`) — the agent must re-read before writing. |
| CSRF on the LAN-mode endpoints | `X-DevForge-Csrf` header is **required** on every mutating request from non-loopback clients (`server/lanAccess.ts`, `src/main.tsx`). Custom headers trigger a preflight, so cross-site fetch/form cannot pass it. |
| LAN token brute-forcing from the network | Per-IP sliding-window rate limiting — 10 failures per minute per IP is the default lockout threshold. |
| Token timing attacks | `timingSafeEqual` for every token comparison. |
| Token leakage via `?token=` in URLs/logs | The boot-time cookie only — after the cookie is set, the token is only accepted in an `x-devforge-token` header, `Authorization: Bearer`, or the `devforge_token` cookie. The LAN URL printed to the server log is a one-time bootstrap link. |
| LAN cookie leakage over unencrypted transport | Optional `Secure` cookie flag (`LAN_COOKIE_SECURE=1`) for HTTPS-fronted deployments. |
| State loss on crash / mid-run kill | Snapshot-per-iteration run state (`.opencode/runs/`) with `POST /api/agent/resume`. |

## Localhost mode (default)

The server binds to `127.0.0.1`. Nothing is reachable from your network.
Loopback clients bypass the token gate entirely, by design.

## LAN mode (opt-in)

To enable:

```
set DEVFORGE_HOST=lan          # Windows
# or
export DEVFORGE_HOST=lan       # macOS / Linux
npm run dev
```

Behavior:

1. The server binds `0.0.0.0` and prints a one-time URL with `?token=…`.
2. The **first** browser navigation with `?token=…` sets an `HttpOnly` session
   cookie (`devforge_token`) and the `?token=` parameter stops being needed.
3. Every mutating API call from a non-loopback client must also send
   `X-DevForge-Csrf: devforge` — the UI does this automatically (`src/main.tsx`).
   Your own scripts/automation must send both the token **and** this header.
4. After 10 failed attempts from a single IP inside a 60-second window, that
   IP is locked out for 60 seconds regardless of whether it later presents a
   valid token.
5. Set `LAN_COOKIE_SECURE=1` if you front DevForge with HTTPS.

## Reporting a vulnerability

Please do **not** open a public issue for security bugs. Instead:

- **Email the maintainer** directly (find the address on the GitHub profile)
  with a subject of `[SECURITY] DevForge Studio — <short summary>` and a
  minimal reproduction.
- Response target: acknowledgment within 3 business days, a patch within a
  realistic window for the severity you describe.
- After the fix ships, we'll credit you in the CHANGELOG unless you prefer
  anonymity.

## Not in this project's security scope

- Multi-tenant isolation (there are no tenants — one machine, one user, by
  design).
- Malicious local user with filesystem access to your workspace (at that
  point, we've lost already).
- Side-channels in local model inference (not our attack surface).
