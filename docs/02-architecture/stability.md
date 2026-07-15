# Stability — Anti-Hang & Timeouts

*Architecture · single source of truth for timeouts & anti-hang · updated 2026-07-15*

> **This file is the single source of truth for every timeout value and the anti-hang design.**
> Other docs — [capabilities](../03-reference/capabilities.md),
> [known issues](../04-design/known-issues.md), [request flow](./request-flow.md) — link here instead
> of restating numbers; when a value changes it changes HERE. For the op path through the layers see
> [request flow](./request-flow.md); for open gaps and the OPEN item B see
> [known issues](../04-design/known-issues.md).

All UIA work runs on **one serialized STA worker** inside the C# sidecar, so a frozen target app (or its UIA
provider) must never wedge the session or the Appium server. This page maps the layered protection, every
timeout, the failure modes, and what shipped in beta.15. **Design priority: stability > coverage > speed** —
stability here means *no hangs and clear errors*, not magic auto-recovery.

## Principle — nested deadlines

The most graceful layer fires first; each outer layer is strictly longer so it only acts as a backstop:

```
UIA (op−5s)  <  watchdog (op = 300s default)  <  RpcClient (op+5s)  <  hard-deadline (op+10s)
```

- The **UIA timeout below the watchdog** lets the COM call bail on its own — the op returns an error
  *without* poisoning or leaking an STA thread; poison/replace is the backstop.
- The **RpcClient timeout above the server-op timeout** avoids orphaned work (client never gives up before
  the server's own deadline). Follows gRPC / Google-SRE deadline-nesting guidance.
- The **TS hard-deadline** is the one bound that never fails: `op()` always settles ≤ operationTimeout+10s
  even if the AbortController *and* the watchdog both fail, so the per-session command lock always releases.

## Timeout reference

> **Every timeout knob in the driver, in one place.** The values here are the single source of truth —
> [capabilities](../03-reference/capabilities.md) and [known issues](../04-design/known-issues.md) link
> here instead of restating them.

### Design rationale — one reference knob per AXIS

The driver deliberately has exactly **one reference knob per axis**; everything else on that axis is
either *derived* from it (fixed offsets, so the nesting invariant can never be misconfigured) or a
narrow *local override*:

- **Execution axis** — `flaui:operationTimeout` bounds a single UIA command. The whole L1<L2<L3<L4
  anti-hang chain derives from it.
- **Session-setup axis** — `appium:createSessionTimeout` (with `ms:waitForAppLaunch`) budgets the
  `/session` call, which legitimately runs far longer than any single op (attach poll + window-surface
  waits).
- **PowerShell axis** — a per-call `timeout` on the `execute('powershell', …)` op. PowerShell runs
  *outside* the UIA scheduler, so `flaui:operationTimeout` does not bound it.
- **Idle / lifecycle axis** — `appium:newCommandTimeout` measures the gap *between* commands; the
  sidecar's idle self-exit derives from it.

The axes are deliberately **not merged** into a single knob because they measure different things: how
long one command may run, how long session setup may take, how long a script may run, and how long a
session may sit idle. Deriving one from another would couple unrelated budgets — e.g. raising
`operationTimeout` for a slow app must not make an abandoned session linger longer, and a long attach
poll must not poison the per-op worker (P0-1).

### The timeout logic at a glance

```
EXECUTION AXIS -- per op, nested L1 < L2 < L3 < L4 (one knob)

                    flaui:operationTimeout (THE knob, default 300s)
                                 |
        +------------------------+---------------------------+
        | derived (overridable)  | direct                    | derived (fixed offsets, no caps)
        v                        v                           v
  L1 UIA Conn/Transaction    L2 sidecar op watchdog      L3 TS RPC abort    = op+5s (305s)
     = op-5s (295s)             = op (300s)              L4 TS hard backstop = L3+5s (310s)

SESSION-SETUP AXIS -- /session only, deliberately NOT bounded by operationTimeout

  appium:createSessionTimeout (60s) ------+--> sidecar setup watchdog
  ms:waitForAppLaunch (s) -> rootWait     |      = max(attach + rootWait, 2*rootWait) + 15s
     = max(waitForAppLaunch, 10s) --------+--> TS /session RPC = rootWait + attach + 30s  (+5s backstop)

POWERSHELL AXIS -- outside the UIA scheduler

  per-call timeout (default 300s) --> sidecar kills the WHOLE process tree at the deadline
                                  --> TS RPC abort = per-call + 5s  (+5s backstop)

IDLE / LIFECYCLE AXIS -- measures idle time BETWEEN commands, not command time

  appium:newCommandTimeout (Appium reaps idle sessions)
        --> flaui:idleTimeout = newCommandTimeout + 120s  (newCommandTimeout: 0 -> disabled)
  stdin heartbeat: parent (driver) dies --> sidecar self-exits immediately
```

### A — execution axis (per-op path)

**Single knob:** `flaui:operationTimeout` (default **300 000 ms**) drives the whole nested chain.
Invariant: **L1 < L2 < L3 < L4**, guaranteed by construction (L1/L3/L4 are derived offsets). There are
**no independent caps**: the old 20s cap on L1 was removed because it aborted long-but-legitimate UIA
transactions (slow/churning trees, e.g. an animated progress bar) with `UIA_E_TIMEOUT` long before the
operationTimeout the user asked for.

| # | Layer | Value (default) | Knob | When it fires | Where |
|---|---|---|---|---|---|
| L1 | UIA Connection / Transaction timeout | **op−5s**, floor 1s (295s) | derived (`OpLogic.UiaDefault`); `flaui:connectionTimeout` / `flaui:transactionTimeout` are explicit overrides | COM call bails on its own → clean W3C `timeout` error, **session lives**, no thread poisoned | `OpLogic.UiaDefault` → `Program.cs` (UIA3 only) |
| L2 | Sidecar per-op watchdog | **op** (300s) | `flaui:operationTimeout` — **THE knob** | cooperative cancel (a frozen COM call ignores it) + 2s worker probe: responsive → op fails `timeout`, session lives; frozen → **poison + replace** the STA worker | `UiaScheduler.RunAsync` |
| L2b | Worker-responsive probe | 2s | — | decides "slow op" vs "frozen worker" after an L2 fire | `UiaScheduler` |
| L2c | Poison budget | 5 threads | — | ≥5 poisoned workers → `SchedulerFatalException` (`backend fatal`) → TS treats it like a transport failure (markDead, or recycle with `flaui:autoRecycle`) | `UiaScheduler` |
| L3 | TS RPC abort (per-op `AbortController`) | **op+5s** (305s) | derived, no cap | fetch aborts → transport-failure path (markDead / recycle) | `timeouts.ts opRpcTimeoutMs` → `rpc-client.ts` |
| L4 | TS hard backstop (`Promise.race`) | **L3+5s** (310s) | derived, no cap | last resort when even the abort fails (half-open connection): op settles → markDead → `NoSuchDriverError` | `timeouts.ts rpcHardBackstopMs` → `rpc-client.ts` |

### B — session-setup axis (`/session` only)

`/session` gets its **own budget**, deliberately **not** bounded by `operationTimeout`: the attach poll
alone may take `createSessionTimeout`, and each resolve may wait `rootWait` for the top-level window —
a per-op watchdog would poison the worker on a perfectly healthy slow attach/launch (P0-1).

| Knob | Value (default) | Role | Where |
|---|---|---|---|
| `appium:createSessionTimeout` | **60 000 ms** | poll budget for an attach target (`appTopLevelWindow` / `processName` / `appName`) to appear | `OpLogic.CreateSessionTimeout` |
| `ms:waitForAppLaunch` (seconds) | rootWait = **max(waitForAppLaunch, 10s)** | how long each resolve waits for the app's top-level window to surface | `Program.cs` |
| Sidecar setup watchdog | **max(attach + rootWait, 2·rootWait) + 15s** | bounds the whole `/session` setup (worst of attach path vs launch path incl. single-instance hand-off retry) | `OpLogic.SessionSetupTimeout` |
| TS `/session` RPC timeout | **rootWait + createSessionTimeout + 30s** (+5s L4 backstop on top) | transport sits above the sidecar's setup watchdog; shared by createSession and the recycle re-attach | `timeouts.ts sessionRpcTimeoutMs` → `driver.sessionSetupRpcTimeout` |

### C — PowerShell axis (outside the UIA scheduler)

| Knob | Value (default) | Role | Where |
|---|---|---|---|
| per-call `timeout` on `execute('powershell', [{script\|command, timeout?}])` | **300 000 ms** | on expiry the sidecar kills the **entire process tree** and maps it to a W3C `timeout` error | `Program.cs RunPowerShell` |
| TS RPC abort for the powershell op | **per-call + 5s** (+5s L4 backstop) | transport sits above the sidecar's own deadline | `driver.rpcTimeoutFor` (`DEFAULT_POWERSHELL_TIMEOUT_MS`, `timeouts.ts`) |

There is **no** `powerShellCommandTimeout` capability — the per-call `timeout` is the only cap.
`flaui:operationTimeout` does **not** bound PowerShell (it never enters the UIA scheduler). The default
was raised from 60s to the same 300s scale as the execution axis so a slow-host `prerun`/`postrun`
script is not cut short; `prerun`/`postrun` use this same default.

### D — idle / lifecycle axis (idle time, not command time)

| Knob | Value (default) | Role | Where |
|---|---|---|---|
| `appium:newCommandTimeout` | 60s (base-driver default) | Appium-level idle-session reaper — the **reference knob** for this axis | appium base driver |
| `flaui:idleTimeout` | derived: **newCommandTimeout + 120s** when newCommandTimeout > 0; `newCommandTimeout: 0` → **0 = disabled**; explicit cap value wins | sidecar orphan self-exit — sits just *above* Appium's reap so it only fires when Appium itself failed to; never fires while an op is in flight (P0-2) | `driver.ts` → `Program.cs` idle watcher |
| — sidecar standalone fallback | 300s (5 min) | only when the `/session` caps carry **no** `idleTimeout` field at all (direct sidecar use / testing) — the TS driver always sends the derived value | `Program.cs` |
| stdin heartbeat | immediate | parent (driver) process dies → pipe EOF → sidecar self-exits instantly | `Program.cs` |
| `Sidecar.start` handshake | 15s PORT + ~5s `/status` (2s per probe) | bounds sidecar startup; failure kills the child (never leaks it) | `sidecar.ts` (`startupTimeoutMs`) |
| `Sidecar.stop` SIGKILL fallback | 2s | bounds sidecar shutdown | `sidecar.ts` |

## The 5 layers

1. **UIA3 (COM)** — `ConnectionTimeout` / `TransactionTimeout`, set *below* the watchdog so a frozen COM call
   self-aborts first and returns an error without leaking an STA thread.
2. **Sidecar watchdog** (`UiaScheduler.RunAsync`) — one op at a time via a `SemaphoreSlim(1,1)`. On timeout it
   cancels and probes the worker (2s no-op): if the worker responds it just throws `TimeoutException`; if the
   worker is frozen it **poisons and replaces** the STA worker so only that op fails and the session survives.
   After 5 poisoned threads it escalates to a fatal → recycle.
3. **RpcClient** (`rpc-client.ts`) — per-op `AbortController` at `operationTimeout + 5s`, plus the **TS
   hard-deadline** `Promise.race` at `perOpTimeout + 5s` (the guaranteed bound). PowerShell ops get their own
   budget (per-call `timeout`, default 300s — axis C above) + the same +5s grace.
4. **Sidecar lifecycle** (`sidecar.ts`) — bounded `start` handshake (PORT + `/status`) and a `stop` with a
   2s SIGKILL fallback.
5. **Orphan guards** — a stdin-EOF **heartbeat** (parent dies → sidecar self-exits instantly) and an **idle
   self-exit** timer (E) for the "client alive but session forgotten / SIGKILLed" case. The idle bound defaults
   to `newCommandTimeout + 120s` so it sits just *above* Appium's own session reaping; `newCommandTimeout: 0`
   disables it.

## Failure modes — expected vs the 2026-06-04 incident

| Situation | What should happen | SecureAge incident (beta.9) |
|---|---|---|
| Op slow but app alive | watchdog (operationTimeout) → `"timeout"` envelope → W3C `TimeoutError` (no recycle) | — |
| **UIA frozen** (STA stuck) | watchdog (operationTimeout) → poison + replace worker → that op `"timeout"`, later ops use the fresh worker; session survives | ❌ **no layer fired**; op never settled; command queue jammed to 80+ for >1h |
| **Sidecar process dies / wedges** | transport failure → **fail the session** (`NoSuchDriverError`), no silent recycle (C); the wedged process is `stop()`ed so it can't orphan | ❌ op hung; AbortController did not reject; no recycle; sidecar later gone |

The watchdog **non-fire** seen in the incident is the open root cause — **item B** — tracked in
[known issues](../04-design/known-issues.md). Until it is solved, the TS hard-deadline (operationTimeout+10s) is the guaranteed
bound: the op always settles and the session then fails honestly (C). The HangApp test fixture freezes the UI
thread differently (there the watchdog *does* fire), so it does not reproduce this mode.

## Shipped in beta.15 — C / D / E

Principle: **one outermost bound that never fails + predictable recovery + honest failures.**

- ✅ **C. Sidecar death/wedge → FAIL the session.** A persistent `proc.on('exit')` listener records the death;
  a transport failure (or a known-dead process) `stop()`s the sidecar and throws `NoSuchDriverError`
  (W3C "invalid session id", 404), and **latches** so every later op fails fast too. The client decides to
  restart, with full knowledge. Silent auto-recycle/re-attach is now **opt-in** (`flaui:autoRecycle: true`,
  default off). Matches the W3C/ChromeDriver/Appium contract (dead session → 404, never auto-restart).
- ✅ **D. Nest the timeouts** — `UIA (op−5s) < watchdog (op) < RpcClient (op+5s) < hard-deadline (op+10s)`,
  all derived from the single `flaui:operationTimeout` knob (default 300s). The UIA timeout below the
  watchdog lets COM bail without poisoning a thread; RpcClient is per-op (`operationTimeout + 5s`;
  PowerShell its own).
- ✅ **E. Sidecar idle self-exit** — self-exits after `flaui:idleTimeout` with no `/op`/`/session`,
  independent of the heartbeat. Dual-mechanism (pipe-EOF heartbeat + idle timer) bounds the lingering-sidecar
  leak. Defaults to `newCommandTimeout + 120s`; `newCommandTimeout: 0` disables.

The beta.13 **TS hard-deadline** (layer 3b) remains the one guaranteed bound and, when it fires, C ends the
session rather than retrying into a still-wedged backend.

### End-state (beta.15; item B still pending)

```
op freeze    → UIA bail (op−5s) ── fail this op, session stays alive ──┐  (in-process, graceful)  [B hardens this]
              └ else → watchdog (op) → poison + replace STA worker ────┘
any cause    → TS hard-deadline (op+10s) ── op ALWAYS settles             (the guarantee)
death/wedge  → session DEAD (404 invalid session id) ── fail fast, NO silent re-attach   (honest, C)
idle (newCommandTimeout+120s) → sidecar self-exits                        (orphan guard, E)
```

## Industry references

[W3C WebDriver §errors](https://w3c.github.io/webdriver/#errors) (dead session → 404 "invalid session id");
[gRPC deadlines](https://grpc.io/docs/guides/deadlines/) +
[Google SRE — cascading failures](https://sre.google/sre-book/addressing-cascading-failures/) (nested
deadline propagation, client > server ordering); [Bazel client-server](https://bazel.build/run/client-server)
& [TypeScript tsserver #51100](https://github.com/microsoft/TypeScript/issues/51100) (pipe-EOF + idle-timer
dual orphan guard).

## Reference

- Code: `lib/backend/timeouts.ts` (all TS-side derivations: `DEFAULT_OPERATION_TIMEOUT_MS`,
  `DEFAULT_POWERSHELL_TIMEOUT_MS`, `opRpcTimeoutMs`, `rpcHardBackstopMs`, `sessionRpcTimeoutMs`),
  `sidecar/OpLogic.cs` (`UiaDefault`, `SessionSetupTimeout`, `CreateSessionTimeout`, `ShouldSelfExit`),
  `sidecar/UiaScheduler.cs`, `sidecar/Program.cs` (`RunOp`, `RunPowerShell`, idle watcher, UIA-timeout
  nesting), `lib/backend/rpc-client.ts` (per-op timeout), `lib/backend/sidecar.ts` (exit tracking),
  `lib/driver.ts` (`op` / `ensureHealthyAndOp` / `markDead` / `rpcTimeoutFor` / `tryRecycle`).
- Op path: [request flow](./request-flow.md). Open gaps: [known issues](../04-design/known-issues.md).
  Incident + fix log: [internal changelog](../internal/changelog-internal.md).
