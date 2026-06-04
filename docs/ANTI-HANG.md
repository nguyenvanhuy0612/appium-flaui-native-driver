# Anti-Hang & Timeouts — how a stuck UIA call is bounded

This driver is a **TypeScript driver + C# FlaUI sidecar**. All UIA work runs on **one serialized STA worker**
inside the sidecar, so a frozen target app (or its UIA provider) must never wedge the session or the Appium
server. This document maps the layered protection, every timeout, the failure modes, the known gaps, and the
proposed direction. Architecture/anti-hang background: the design spec §6.

> Status note: a real incident on 2026-06-04 (attached to a frozen SecureAge dialog) exposed that the inner
> layers did **not** all fire — see [Failure modes](#failure-modes) and [Known gaps](#known-gaps). beta.13
> added the TS hard-deadline backstop; the deeper fixes are [proposed below](#proposed-direction--under-review).

## Request flow — one op through every layer

```
CLIENT (WebdriverIO / Python)
  │  HTTP   (appium session newCommandTimeout = 300s)
  ▼
APPIUM ─ per-session command queue (AsyncLock)  ◄── one in-flight op holds the lock; later cmds QUEUE
  │
  ▼  driver.op(o)
TS DRIVER ── ensureHealthyAndOp(o)
  │   └─ RpcClient.fetchJson(POST /op)
  │        ├─ AbortController        → abort after  timeoutMs (30s)
  │        └─ Promise.race vs HARD DEADLINE = timeoutMs + 5s (35s)   ◄── BACKSTOP (beta.13)
  │             • fetch settles normally → return value / RpcError
  │             • fetch hangs (abort failed) → reject Error("transport") @ hard-deadline
  │   ┌─ RpcError ({ok:false} envelope = backend is alive) → NO recycle → map to W3C error
  │   └─ NON-RpcError (ECONNREFUSED / abort / hard-deadline / sidecar dead)
  │          → autoRecycle? → tryRecycle() (deduped to a single restart promise)
  │               doRecycle: stop old (stdin EOF → heartbeat exit, else SIGKILL @2s)
  │                          → new Sidecar.start (PORT handshake 15s + /status 5s)
  │                          → client.session(sessionBody)  ← RE-ATTACH (again bounded by 30s/35s)
  │               → success: RETRY op ONCE ; failure: throw UnknownError
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
UIA3 (COM)  ── ConnectionTimeout / TransactionTimeout (60s)   ◄── bounds the cross-process COM call
  ▼
TARGET APP (UIA provider)   ← where it actually freezes (e.g. SecureAge dialog)

Heartbeat: parent (appium) dies → stdin EOF → sidecar self-exits (no orphan).
```

## Timeouts (current defaults)

| # | Layer | Default | Cap (capability) | Where |
|---|---|---|---|---|
| 1 | UIA Connection / Transaction timeout | **60s** | `flaui:connectionTimeout` / `flaui:transactionTimeout` | `Program.cs` (UIA3) |
| 2 | Sidecar per-op watchdog | **30s** | `flaui:operationTimeout` | `UiaScheduler.RunAsync` |
| 2b | Worker-responsive probe | 2s | — | `UiaScheduler` |
| 2c | Poison budget | 5 threads → fatal | — | `UiaScheduler` |
| 3 | RpcClient AbortController | **30s** (fixed) | ⚠️ not wired to `operationTimeout` | `rpc-client.ts` |
| 3b | RpcClient hard-deadline (backstop) | **35s** (timeoutMs + 5s) | — | `rpc-client.ts` |
| 4 | `Sidecar.start` handshake | 15s PORT + 5s `/status` | `startupTimeoutMs` | `sidecar.ts` |
| 4b | `Sidecar.stop` SIGKILL fallback | 2s | — | `sidecar.ts` |
| 5 | Appium `newCommandTimeout` | 300s | client capability | appium |

## Failure modes — expected vs the 2026-06-04 incident

| Situation | What should happen | SecureAge incident (beta.9) |
|---|---|---|
| Op slow but app alive | watchdog 30s → `"timeout"` envelope → W3C `TimeoutError` (no recycle) | — |
| **UIA frozen** (STA stuck) | watchdog 30s → poison + replace worker → that op `"timeout"`, later ops use the fresh worker; session survives | ❌ **no layer fired**; op never settled; command queue jammed to 80+ for >1h |
| **Sidecar process dies** | next op: ECONNREFUSED / hang → transport failure → (today) recycle + re-attach | ❌ op hung; AbortController did not reject; no recycle; sidecar later gone |

## Known gaps (as of beta.14)

1. **Watchdog non-fire (root cause OPEN):** for the SecureAge freeze, neither the 30s op-watchdog nor the 60s
   UIA timeout fired. Needs reproduction with instrumentation; the HangApp fixture freezes the UI thread
   differently (there the watchdog *does* fire), so it doesn't reproduce this mode.
2. **RpcClient timeout is a fixed 30s**, not wired to `operationTimeout` — if `operationTimeout` > 30s the
   client times out before the sidecar watchdog can answer (premature transport-recycle).
3. **Sidecar death currently auto-recycles + re-attaches** silently — unsound for *attached* apps (window
   handle may be gone, app state moved on, app may still be frozen → re-hang).

The beta.13 **TS hard-deadline** (layer 3b) is the one guaranteed bound: `op()` always settles ≤ ~35s even
when the AbortController and the sidecar watchdog both fail, so the per-session command lock always releases
and the queue can never wedge indefinitely.

## Proposed direction — UNDER REVIEW (not yet implemented)

Principle: **one outermost bound that never fails + predictable recovery + honest failures** (stability ≠
magic auto-recovery; it = no hangs and clear errors).

1. **Make the in-process watchdog reliable** — a frozen op must hit the watchdog → poison/replace the STA
   worker → only that op fails (`"timeout"`), the session survives, the queue drains on the fresh worker.
   This is the real fix (needs the repro from gap #1). The TS hard-deadline stays as the guarantee.
2. **Sidecar process death → FAIL the session** (drop silent auto-recycle/re-attach): a `proc.on('exit')`
   listener marks the session dead immediately; subsequent ops fail fast with a clear terminal error
   ("sidecar process exited — session invalid, create a new session"). The client decides to restart, with
   full knowledge. (Auto-recycle could return as an opt-in capability, default off.)
3. **Nest the timeouts** so the most graceful layer fires first and there are no races:
   `UIA Connection/Transaction  <  operationTimeout (watchdog)  <  RpcClient  <  hard-deadline`
   (e.g. 20s < 30s < 35s < 40s). A UIA timeout *below* the watchdog lets the COM call bail on its own — the op
   returns an error **without** poisoning/leaking an STA thread; poison/replace becomes a backstop. Wire the
   RpcClient timeout to `operationTimeout + grace`.

Proposed end-state:

```
op freeze    → UIA bail (20s) ──── fail this op, session stays alive ──┐  (in-process, graceful)
              └ else → watchdog 30s → poison + replace STA worker ─────┘
any cause    → TS hard-deadline (40s) ── op ALWAYS settles                (the guarantee)
sidecar exit → session DEAD ── fail fast, NO silent re-attach             (honest)
```

## Reference
- Code: `sidecar/UiaScheduler.cs`, `sidecar/Program.cs` (`RunOp`), `lib/backend/rpc-client.ts`,
  `lib/backend/sidecar.ts`, `lib/driver.ts` (`op` / `ensureHealthyAndOp` / `tryRecycle` / `doRecycle`).
- Design/anti-hang background: the design spec §2/§6. Incident + fix log: `CHANGELOG-internal.md`.
