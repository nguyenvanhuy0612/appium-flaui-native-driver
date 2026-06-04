# Stability — Anti-Hang & Timeouts

> **This file is the single source of truth for every timeout value and the anti-hang design.**
> Other docs link here instead of restating numbers. For the op path through the layers see
> [request flow](./request-flow.md); for open gaps and the OPEN item B see
> [known issues](../04-design/known-issues.md).

All UIA work runs on **one serialized STA worker** inside the C# sidecar, so a frozen target app (or its UIA
provider) must never wedge the session or the Appium server. This page maps the layered protection, every
timeout, the failure modes, and what shipped in beta.15. **Design priority: stability > coverage > speed** —
stability here means *no hangs and clear errors*, not magic auto-recovery.

## Principle — nested deadlines

The most graceful layer fires first; each outer layer is strictly longer so it only acts as a backstop:

```
UIA (≈20s)  <  watchdog (30s)  <  RpcClient (35s)  <  hard-deadline (40s)
```

- The **UIA timeout below the watchdog** lets the COM call bail on its own — the op returns an error
  *without* poisoning or leaking an STA thread; poison/replace is the backstop.
- The **RpcClient timeout above the server-op timeout** avoids orphaned work (client never gives up before
  the server's own deadline). Follows gRPC / Google-SRE deadline-nesting guidance.
- The **TS hard-deadline** is the one bound that never fails: `op()` always settles ≤ ~40s even if the
  AbortController *and* the watchdog both fail, so the per-session command lock always releases.

## Timeouts (defaults, beta.15)

| # | Layer | Default | Cap (capability) | Where |
|---|---|---|---|---|
| 1 | UIA Connection / Transaction timeout | **min(20s, opTimeout−5s)** | `flaui:connectionTimeout` / `flaui:transactionTimeout` | `Program.cs` (UIA3) |
| 2 | Sidecar per-op watchdog | **30s** | `flaui:operationTimeout` | `UiaScheduler.RunAsync` |
| 2b | Worker-responsive probe | 2s | — | `UiaScheduler` |
| 2c | Poison budget | 5 threads → fatal | — | `UiaScheduler` |
| 3 | RpcClient AbortController (per-op) | **operationTimeout + 5s** (35s); PowerShell: its own + 5s | wired to `flaui:operationTimeout` | `rpc-client.ts` / `driver.rpcTimeoutFor` |
| 3b | RpcClient hard-deadline (backstop) | **perOpTimeout + 5s** (40s) | — | `rpc-client.ts` |
| 4 | `Sidecar.start` handshake | 15s PORT + 5s `/status` | `startupTimeoutMs` | `sidecar.ts` |
| 4b | `Sidecar.stop` SIGKILL fallback | 2s | — | `sidecar.ts` |
| 5 | Sidecar idle self-exit (orphan guard) | **`newCommandTimeout + 120s`** (sits above Appium's reap; `newCommandTimeout:0` disables) | `flaui:idleTimeout` (override) | `driver.ts` → `Program.cs` |
| 6 | Appium `newCommandTimeout` | 300s | client capability | appium |

## The 5 layers

1. **UIA3 (COM)** — `ConnectionTimeout` / `TransactionTimeout`, set *below* the watchdog so a frozen COM call
   self-aborts first and returns an error without leaking an STA thread.
2. **Sidecar watchdog** (`UiaScheduler.RunAsync`) — one op at a time via a `SemaphoreSlim(1,1)`. On timeout it
   cancels and probes the worker (2s no-op): if the worker responds it just throws `TimeoutException`; if the
   worker is frozen it **poisons and replaces** the STA worker so only that op fails and the session survives.
   After 5 poisoned threads it escalates to a fatal → recycle.
3. **RpcClient** (`rpc-client.ts`) — per-op `AbortController` at `operationTimeout + 5s`, plus the **TS
   hard-deadline** `Promise.race` at `perOpTimeout + 5s` (the guaranteed bound). PowerShell ops get their own
   larger budget.
4. **Sidecar lifecycle** (`sidecar.ts`) — bounded `start` handshake (PORT + `/status`) and a `stop` with a
   2s SIGKILL fallback.
5. **Orphan guards** — a stdin-EOF **heartbeat** (parent dies → sidecar self-exits instantly) and an **idle
   self-exit** timer (E) for the "client alive but session forgotten / SIGKILLed" case. The idle bound defaults
   to `newCommandTimeout + 120s` so it sits just *above* Appium's own session reaping; `newCommandTimeout: 0`
   disables it.

## Failure modes — expected vs the 2026-06-04 incident

| Situation | What should happen | SecureAge incident (beta.9) |
|---|---|---|
| Op slow but app alive | watchdog 30s → `"timeout"` envelope → W3C `TimeoutError` (no recycle) | — |
| **UIA frozen** (STA stuck) | watchdog 30s → poison + replace worker → that op `"timeout"`, later ops use the fresh worker; session survives | ❌ **no layer fired**; op never settled; command queue jammed to 80+ for >1h |
| **Sidecar process dies / wedges** | transport failure → **fail the session** (`NoSuchDriverError`), no silent recycle (C); the wedged process is `stop()`ed so it can't orphan | ❌ op hung; AbortController did not reject; no recycle; sidecar later gone |

The watchdog **non-fire** seen in the incident is the open root cause — **item B** — tracked in
[known issues](../04-design/known-issues.md). Until it is solved, the TS hard-deadline (40s) is the guaranteed
bound: the op always settles and the session then fails honestly (C). The HangApp test fixture freezes the UI
thread differently (there the watchdog *does* fire), so it does not reproduce this mode.

## Shipped in beta.15 — C / D / E

Principle: **one outermost bound that never fails + predictable recovery + honest failures.**

- ✅ **C. Sidecar death/wedge → FAIL the session.** A persistent `proc.on('exit')` listener records the death;
  a transport failure (or a known-dead process) `stop()`s the sidecar and throws `NoSuchDriverError`
  (W3C "invalid session id", 404), and **latches** so every later op fails fast too. The client decides to
  restart, with full knowledge. Silent auto-recycle/re-attach is now **opt-in** (`flaui:autoRecycle: true`,
  default off). Matches the W3C/ChromeDriver/Appium contract (dead session → 404, never auto-restart).
- ✅ **D. Nest the timeouts** — `UIA (≈20s) < watchdog (30s) < RpcClient (35s) < hard-deadline (40s)`. The UIA
  timeout below the watchdog lets COM bail without poisoning a thread; RpcClient is per-op
  (`operationTimeout + 5s`; PowerShell its own).
- ✅ **E. Sidecar idle self-exit** — self-exits after `flaui:idleTimeout` with no `/op`/`/session`,
  independent of the heartbeat. Dual-mechanism (pipe-EOF heartbeat + idle timer) bounds the lingering-sidecar
  leak. Defaults to `newCommandTimeout + 120s`; `newCommandTimeout: 0` disables.

The beta.13 **TS hard-deadline** (layer 3b) remains the one guaranteed bound and, when it fires, C ends the
session rather than retrying into a still-wedged backend.

### End-state (beta.15; item B still pending)

```
op freeze    → UIA bail (≈20s) ─── fail this op, session stays alive ──┐  (in-process, graceful)  [B hardens this]
              └ else → watchdog 30s → poison + replace STA worker ─────┘
any cause    → TS hard-deadline (40s) ── op ALWAYS settles                (the guarantee)
death/wedge  → session DEAD (404 invalid session id) ── fail fast, NO silent re-attach   (honest, C)
idle 5 min   → sidecar self-exits                                         (orphan guard, E)
```

## Industry references

[W3C WebDriver §errors](https://w3c.github.io/webdriver/#errors) (dead session → 404 "invalid session id");
[gRPC deadlines](https://grpc.io/docs/guides/deadlines/) +
[Google SRE — cascading failures](https://sre.google/sre-book/addressing-cascading-failures/) (nested
deadline propagation, client > server ordering); [Bazel client-server](https://bazel.build/run/client-server)
& [TypeScript tsserver #51100](https://github.com/microsoft/TypeScript/issues/51100) (pipe-EOF + idle-timer
dual orphan guard).

## Reference

- Code: `sidecar/UiaScheduler.cs`, `sidecar/Program.cs` (`RunOp`, idle watcher, UIA-timeout nesting),
  `lib/backend/rpc-client.ts` (per-op timeout), `lib/backend/sidecar.ts` (exit tracking),
  `lib/driver.ts` (`op` / `ensureHealthyAndOp` / `markDead` / `rpcTimeoutFor` / `tryRecycle`).
- Op path: [request flow](./request-flow.md). Open gaps: [known issues](../04-design/known-issues.md).
  Incident + fix log: `internal/CHANGELOG-internal.md`.
