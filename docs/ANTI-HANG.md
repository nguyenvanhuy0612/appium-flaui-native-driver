# Anti-Hang & Timeouts — how a stuck UIA call is bounded

This driver is a **TypeScript driver + C# FlaUI sidecar**. All UIA work runs on **one serialized STA worker**
inside the sidecar, so a frozen target app (or its UIA provider) must never wedge the session or the Appium
server. This document maps the layered protection, every timeout, the failure modes, the known gaps, and the
proposed direction. Architecture/anti-hang background: the design spec §6.

> Status note: a real incident on 2026-06-04 (attached to a frozen SecureAge dialog) exposed that the inner
> layers did **not** all fire — see [Failure modes](#failure-modes) and [Known gaps](#known-gaps). beta.13
> added the TS hard-deadline backstop. **beta.15 shipped C + D + E** ([below](#proposed-direction)):
> sidecar-death/wedge now **fails the session** (no silent recycle), the timeouts are **nested**
> (UIA < watchdog < RPC < hard-deadline), and the sidecar **self-exits when idle** (orphan guard). The one
> open item is **B** — making the in-process watchdog fire reliably for the SecureAge-style freeze.

## Request flow — one op through every layer

```
CLIENT (WebdriverIO / Python)
  │  HTTP   (appium session newCommandTimeout = 300s)
  ▼
APPIUM ─ per-session command queue (AsyncLock)  ◄── one in-flight op holds the lock; later cmds QUEUE
  │
  ▼  driver.op(o)
TS DRIVER ── ensureHealthyAndOp(o)
  │   └─ RpcClient.fetchJson(POST /op, perOpTimeout)   ◄── D: perOp = operationTimeout + 5s (35s);
  │        ├─ AbortController        → abort after  perOpTimeout (35s)      PowerShell uses its own + 5s
  │        └─ Promise.race vs HARD DEADLINE = perOpTimeout + 5s (40s)   ◄── BACKSTOP (beta.13)
  │             • fetch settles normally → return value / RpcError
  │             • fetch hangs (abort failed) → reject Error("transport") @ hard-deadline
  │   ┌─ RpcError ({ok:false} envelope = backend is alive, incl. "timeout") → map to W3C error; session lives
  │   └─ NON-RpcError (ECONNREFUSED / abort / hard-deadline / sidecar dead)  ◄── C: TRANSPORT failure
  │          → autoRecycle (opt-in, default OFF)? recycle + retry once
  │          → else (default): stop() the dead/wedged sidecar → markDead → throw NoSuchDriverError
  │                            (W3C "invalid session id", 404) ; every later op also fails fast
  │  HTTP /op
  ▼
SIDECAR (C#) ── RunOp(work)
  │   └─ UiaScheduler.RunAsync(work, opTimeout = 30s)
  │        ├─ _gate SemaphoreSlim(1,1)  ── one op at a time (serialize)
  │        ├─ enqueue → STA worker ;  Task.WhenAny(Tcs, Task.Delay(30s))
  │        └─ on timeout → cts.Cancel() → probe worker (2s no-op)
  │              • worker responds  → throw TimeoutException only
  │              • worker frozen    → PoisonAndReplaceWorker (abandon stuck STA, start fresh) ;
  │                                    ≥5 poisoned → SchedulerFatalException → recycle
  │   exception map: Timeout→"timeout" · Fatal→"unknown error" · Stale/NotFound/InvalidArg/…
  ▼
UIA3 (COM)  ── ConnectionTimeout / TransactionTimeout (≈20s)  ◄── D: default min(20s, opTimeout−5s), i.e.
  ▼                                                                BELOW the watchdog → COM self-aborts first
TARGET APP (UIA provider)   ← where it actually freezes (e.g. SecureAge dialog)

Heartbeat: parent (appium) dies → stdin EOF → sidecar self-exits (no orphan).
Idle guard (E): no /op or /session for idleTimeout (default newCommandTimeout+120s) → self-exits (bounds orphans).
```

## Timeouts (defaults, beta.15)

Nested so the most graceful layer fires first (D): **UIA (≈20s) < watchdog (30s) < RpcClient (35s) < hard-deadline (40s)**.

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

## Failure modes — expected vs the 2026-06-04 incident

| Situation | What should happen | SecureAge incident (beta.9) |
|---|---|---|
| Op slow but app alive | watchdog 30s → `"timeout"` envelope → W3C `TimeoutError` (no recycle) | — |
| **UIA frozen** (STA stuck) | watchdog 30s → poison + replace worker → that op `"timeout"`, later ops use the fresh worker; session survives | ❌ **no layer fired**; op never settled; command queue jammed to 80+ for >1h |
| **Sidecar process dies / wedges** | transport failure → **fail the session** (`NoSuchDriverError`), no silent recycle (C, beta.15); the wedged process is `stop()`ed so it can't orphan | ❌ op hung; AbortController did not reject; no recycle; sidecar later gone |

## Known gaps

1. **Watchdog non-fire (root cause OPEN — item B):** for the SecureAge freeze, neither the op-watchdog nor the
   UIA timeout fired. Needs reproduction with instrumentation; the HangApp fixture freezes the UI thread
   differently (there the watchdog *does* fire), so it doesn't reproduce this mode. Until B is solved, the
   TS hard-deadline (40s) is the guaranteed bound and the session then fails honestly (C).

Resolved in **beta.15**:
2. ~~RpcClient timeout fixed at 30s, not wired to `operationTimeout`~~ → **D**: per-op RPC timeout =
   `operationTimeout + 5s`; PowerShell gets its own. Nesting now holds.
3. ~~Sidecar death silently auto-recycles + re-attaches~~ → **C**: default is fail-fast (`NoSuchDriverError`);
   auto-recycle is now opt-in (`flaui:autoRecycle: true`, default off).
4. ~~No sidecar-side idle bound (orphan leak)~~ → **E**: sidecar self-exits after `flaui:idleTimeout`
   (default 5 min) of no `/op`/`/session`. (A concurrency cap + reaper, item F, is still optional/future.)

The beta.13 **TS hard-deadline** (layer 3b) remains the one guaranteed bound: `op()` always settles ≤ ~40s even
when the AbortController and the sidecar watchdog both fail, so the per-session command lock always releases
and the queue can never wedge indefinitely. When it fires, C now ends the session rather than retrying into a
still-wedged backend.

## Proposed direction

Principle: **one outermost bound that never fails + predictable recovery + honest failures** (stability ≠
magic auto-recovery; it = no hangs and clear errors).

- ⏳ **B. Make the in-process watchdog reliable** — a frozen op must hit the watchdog → poison/replace the STA
  worker → only that op fails (`"timeout"`), the session survives, the queue drains on the fresh worker.
  This is the real fix (needs the repro from gap #1). The TS hard-deadline stays as the guarantee. **OPEN.**
- ✅ **C. Sidecar death/wedge → FAIL the session** (beta.15). A persistent `proc.on('exit')` listener records
  the death; a transport failure (or a known-dead process) `stop()`s the sidecar and throws
  `NoSuchDriverError` (W3C "invalid session id", 404) — and latches, so every later op fails fast too. The
  client decides to restart, with full knowledge. Silent auto-recycle/re-attach is now **opt-in**
  (`flaui:autoRecycle: true`, default off). Matches the W3C/ChromeDriver/Appium contract (dead session → 404
  "invalid session id", never auto-restart).
- ✅ **D. Nest the timeouts** (beta.15): `UIA (≈20s) < watchdog (30s) < RpcClient (35s) < hard-deadline (40s)`.
  The UIA timeout *below* the watchdog lets the COM call bail on its own — the op returns an error **without**
  poisoning/leaking an STA thread; poison/replace is the backstop. RpcClient is per-op (`operationTimeout+5s`;
  PowerShell gets its own larger budget). Follows gRPC/Google-SRE deadline-nesting guidance (each outer layer
  strictly longer; client timeout above server-op timeout to avoid orphaned work).
- ✅ **E. Sidecar idle self-exit** (beta.15): self-exits after `flaui:idleTimeout` with no `/op`/`/session`,
  independent of the heartbeat. This is the Bazel/tsserver dual-mechanism — pipe-EOF heartbeat for instant
  parent-death + an idle timer for the "client alive but session forgotten / SIGKILLed" orphan case. The idle
  bound **defaults to `newCommandTimeout + 120s`** so it sits just ABOVE Appium's own session reaping — a long
  inter-command wait the user keeps alive via a large `newCommandTimeout` is never cut by the sidecar (just set
  `newCommandTimeout`, nothing else). `newCommandTimeout: 0` (infinite) disables the idle guard. Bounds the
  "many sessions opened, never closed → many lingering `FlaUiSidecar.exe`" leak when `newCommandTimeout` is set.
- 📋 **F. (optional) Concurrency cap + reaper.** Cap concurrent sidecars and reject new sessions past it; a
  startup/periodic reaper kills stray `FlaUiSidecar.exe` with no live parent.

End-state (beta.15; B still pending):

```
op freeze    → UIA bail (≈20s) ─── fail this op, session stays alive ──┐  (in-process, graceful)  [B hardens this]
              └ else → watchdog 30s → poison + replace STA worker ─────┘
any cause    → TS hard-deadline (40s) ── op ALWAYS settles                (the guarantee)
death/wedge  → session DEAD (404 invalid session id) ── fail fast, NO silent re-attach   (honest, C)
idle 5 min   → sidecar self-exits                                         (orphan guard, E)
```

Industry references behind C/D/E: [W3C WebDriver §errors](https://w3c.github.io/webdriver/#errors) (dead
session → 404 "invalid session id"); [gRPC deadlines](https://grpc.io/docs/guides/deadlines/) +
[Google SRE — cascading failures](https://sre.google/sre-book/addressing-cascading-failures/) (nested
deadline propagation, client>server ordering); [Bazel client-server](https://bazel.build/run/client-server)
& [TypeScript tsserver #51100](https://github.com/microsoft/TypeScript/issues/51100) (pipe-EOF + idle-timer
dual orphan guard).

## Reference
- Code: `sidecar/UiaScheduler.cs`, `sidecar/Program.cs` (`RunOp`, idle watcher, UIA-timeout nesting),
  `lib/backend/rpc-client.ts` (per-op timeout), `lib/backend/sidecar.ts` (exit tracking),
  `lib/driver.ts` (`op` / `ensureHealthyAndOp` / `markDead` / `rpcTimeoutFor` / `tryRecycle`).
- Design/anti-hang background: the design spec §2/§6. Incident + fix log: `CHANGELOG-internal.md`.
