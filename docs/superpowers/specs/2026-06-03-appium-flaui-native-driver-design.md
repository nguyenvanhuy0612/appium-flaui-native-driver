# Design Spec — Appium FlaUI Native Driver

- **Date:** 2026-06-03
- **Status:** Draft for review
- **Author:** vanhuan.nguyen@secureage.com (with Claude as senior dev)
- **Working name:** `appium-flaui-native-driver` / automationName `FlaUINative` *(placeholder — rename freely)*

---

## 1. Overview

A new Appium 2 driver for Windows desktop UI automation. It forks the proven architecture of
[`appium-novawindows2-driver`](https://github.com/nguyenvanhuy0612/appium-novawindows2-driver) (TypeScript)
but **replaces the PowerShell backend with a compiled C#/.NET sidecar built on
[FlaUI](https://github.com/FlaUI/FlaUI) core** (UIA3 / UIA2 + MSAA legacy pattern).

The TypeScript layer keeps almost all of nova2's high-level logic (W3C/Appium protocol, `windows:`
extension routing, the XPath AST engine, the page-source XML schema). What changes is the **seam**: the
backend builders stop emitting PowerShell command strings and instead emit **structured JSON operations**
that the C# sidecar executes natively against FlaUI.

This driver lives **alongside** nova2, not as a replacement. nova2 remains the zero-install PowerShell
option; this driver is the higher-stability, broader-framework option.

### 1.1 Goals (priority order)

1. **Stability above all.** The user's #1 requirement. A hung/unresponsive target app must never freeze
   the driver. Hangs must be *bounded* (timeout) and *isolated* (one operation fails, the session lives).
2. **Broadest framework coverage.** UIA3 (default), UIA2 (opt-in), and MSAA data via the
   `LegacyIAccessiblePattern`. Win32/WinForms/WPF/UWP all reachable.
3. **W3C WebDriver compliance + rich `windows:` extensions** — at parity with nova2's command surface.
4. **Drop-in test compatibility with nova2.** Identical page-source XML schema, identical locator
   strategies, identical element-id semantics → existing XPath and tests carry over.

### 1.2 Non-goals (YAGNI)

- Not a full WebDriver server in C# (we are **not** forking/extending `FlaUI.WebDriver`).
- No browser-web concepts (frames, shadow DOM, cookies).
- Not optimizing for raw speed at the cost of stability. Speed is a "nice to have," explicitly secondary.
- Cross-platform: Windows only.

### 1.3 Why C# + FlaUI over the PowerShell backend

| Concern | PowerShell backend (nova2) | C# + FlaUI (this driver) |
|---|---|---|
| Per-op hang control | `System.Windows.Automation` (UIA2 managed) has **no transaction timeout** → a call can hang forever | UIA3 exposes `ConnectionTimeout` + `TransactionTimeout` → bounded failure |
| Hang isolation | Single STA runspace → one hang freezes the whole session | UIA work on a dedicated, **cancellable** worker thread; RPC thread never blocked |
| Tree/property reads | One COM round-trip per property | `CacheRequest` batches a whole subtree + N properties into **one** call |
| Framework coverage | UIA2-managed only; MSAA awkward | UIA3 **and** UIA2 backends + `LegacyIAccessiblePattern` for MSAA |

> Honest caveat: **no UIA solution is immune to hangs** — a frozen target app can still block a COM call.
> FlaUI does not change that. What changes is our *control*: UIA3 timeouts + a dedicated cancellable
> thread turn an unbounded global freeze into a bounded, isolated, recoverable failure.

---

## 2. Architecture

### 2.1 Component diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Appium 2 Server                                                            │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ TypeScript Driver  (fork of nova2 structure)                          │ │
│  │                                                                        │ │
│  │  driver.ts ............ session lifecycle, locator strategies          │ │
│  │  commands/ ............ W3C + `windows:` extension routing             │ │
│  │  xpath/ ............... XPath AST → UIA Condition tree (REUSED)        │ │
│  │  backend/ (NEW) ....... structured-op builders + HTTP RPC client       │ │
│  │  constraints.ts ....... capabilities schema                            │ │
│  │                                                                        │ │
│  │  Serial commandQueue + depth cap + per-command timeout (REUSED)        │ │
│  └───────────────────────────────┬────────────────────────────────────────┘ │
└──────────────────────────────────┼────────────────────────────────────────┘
                                   │  HTTP/JSON RPC on 127.0.0.1:<auto-port>
                                   │  (coarse-grained: 1 call ≈ 1 logical op)
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ FlaUI Sidecar  (C#/.NET, self-contained .exe, one process per session)     │
│                                                                            │
│  ┌───────────────────┐   enqueue   ┌──────────────────────────────────┐    │
│  │ HTTP/RPC host      │ ──────────► │ UIA Work Scheduler                │    │
│  │ (Kestrel minimal)  │             │  • dedicated STA worker thread    │    │
│  │  • never blocked   │ ◄────────── │  • CancellationToken per op       │    │
│  │    by UIA          │  result/err │  • wall-clock watchdog            │    │
│  └───────────────────┘             │  • thread "poisoning" isolation   │    │
│                                     ├──────────────────────────────────┤    │
│   Op interpreter ──────────────────►│ FlaUI core                        │    │
│   (JSON op → FlaUI call)            │  • UIA3Automation (default)       │    │
│                                     │  • UIA2Automation (opt-in)        │    │
│   Element registry (RuntimeId→AE)   │  • LegacyIAccessiblePattern (MSAA)│    │
│   Page-source builder (CacheRequest)│  • Connection/TransactionTimeout  │    │
│                                     └──────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Request flow (example: `findElement` by accessibility id)

```
client → Appium → driver.findElement('accessibility id','saveBtn')
  → driver.findElOrEls() builds a structured op:
      { op:"find", startId:<root|ctx>, multiple:false,
        condition:{ kind:"property", prop:"AutomationId", value:"saveBtn" } }
  → enqueued on serial commandQueue (depth-capped)
  → HTTP POST /op  → sidecar
       → scheduler runs FlaUI FindFirst on UIA worker thread (watchdog armed)
       → on success: register element, return { runtimeId, basicProps }
       → on timeout:  return { error:"timeout" } (W3C-mapped), session lives
  → driver maps to { "element-6066-...": runtimeId }
```

### 2.3 The seam being replaced

nova2's `lib/powershell/*` builders emit **PowerShell script strings** consumed by
`sendPowerShellCommand(cmd: string): Promise<string>`.

We redefine the seam as **structured JSON ops** consumed by
`sendBackendOp(op: BackendOp): Promise<BackendResult>`. Everything above the seam (driver.ts orchestration,
extension routing, the XPath `Condition` model, page-source consumption) is preserved; everything at/below
the seam (op builders, transport, execution) is rewritten for the C# sidecar.

The XPath engine already models conditions as structured objects (`PropertyCondition`, `AndCondition`,
`OrCondition`, `NotCondition`) — these serialize 1:1 to JSON and map directly to FlaUI's `ConditionFactory`.

---

## 3. Components

### 3.1 TypeScript driver (reused from nova2, adapted)

| Module | Status | Notes |
|---|---|---|
| `driver.ts` | Adapt | Swap `startPowerShellSession`/`sendPowerShellCommand` for sidecar lifecycle/RPC client. Keep locator strategies, `findElOrEls`, session lifecycle. |
| `commands/extension.ts` | Reuse | `windows:` command map unchanged; each handler now emits a JSON op instead of PS text. |
| `commands/*` (actions, element, app, device, file) | Adapt | Re-point builders to JSON ops. |
| `xpath/*` | Reuse | AST walker unchanged; `XPathExecutor` calls `sendBackendOp` instead of `sendPowerShellCommand`. |
| `backend/` | **New** | Op type definitions, op builders, HTTP RPC client, sidecar process manager. |
| `constraints.ts` | Adapt | Drop PowerShell-only caps; add backend-selection + sidecar caps (§7). |
| `winapi/` (koffi) | Reuse | Win32 input (mouse/keyboard) can stay client-side, or move into sidecar — see §11 open question. |

### 3.2 C# FlaUI sidecar (new)

| Sub-component | Responsibility |
|---|---|
| RPC host | Minimal Kestrel HTTP server on `127.0.0.1`, auto-selected free port, reported to TS via first stdout line. Health endpoint `GET /status`. Heartbeat watchdog (self-exit if parent gone). |
| UIA work scheduler | Single dedicated STA worker thread with a work queue; each op runs under a `CancellationToken` + wall-clock watchdog. Thread-poisoning isolation (§6). |
| Op interpreter | Maps each JSON op to FlaUI calls. |
| Element registry | `Dictionary<runtimeId, AutomationElement>` with FIFO eviction (port nova2's 10k cap + `Marshal.ReleaseComObject`). Stale-id → re-resolve by runtime id, else W3C `stale element`. |
| Page-source builder | One `CacheRequest` pass, iterative BFS, emits XML identical to nova2's schema. |
| Backend factory | Instantiates `UIA3Automation` (default) or `UIA2Automation` (opt-in); sets `ConnectionTimeout`/`TransactionTimeout`. |

---

## 4. RPC protocol (TS ↔ sidecar)

- **Transport:** HTTP/JSON over `127.0.0.1:<auto-port>` (chosen for debuggability + natural thread decoupling).
- **Granularity:** coarse — one HTTP call per logical operation. No chatty per-property calls.
- **Shape:** a single `POST /op` taking `{ op, ...params }`, plus lifecycle endpoints.

| Endpoint | Purpose |
|---|---|
| `GET /status` | Health check / readiness probe |
| `POST /session` | Open or attach app; choose backend (uia3/uia2); set timeouts → returns root element id |
| `POST /op` | The workhorse. `op ∈ {find, attributes, action, source, input, ...}` |
| `DELETE /session` | Release elements, dispose automation, close app per `shouldCloseApp` |

Representative ops carried by `POST /op`:

- `find` — `{ startId, multiple, scope, condition }` → element id(s) + cached basic props
- `attributes` — `{ id, names[] | "all" }` → bulk property fetch via `CacheRequest`
- `action` — `{ id, action, args }` → invoke/setValue/toggle/expand/collapse/select/focus/window ops
- `source` — `{ startId, rawView? }` → page-source XML string
- `input` — `{ kind: click|hover|keys|scroll|clickAndDrag, ... }` → Win32/UIA input

Every result is `{ ok: true, value }` or `{ ok: false, error: { type, message } }` where `type`
maps to a W3C error (`timeout`, `stale element reference`, `no such element`, `invalid selector`,
`unknown error`). The TS layer translates `type` into the matching Appium/`base-driver` exception.

---

## 5. Element model & page source

### 5.1 Element identity
Element id = UIA **RuntimeId** as dot-separated integers (e.g. `42.333896.3.1`) — **identical to nova2**,
so element semantics and any persisted references behave the same. Registry maps id → live
`AutomationElement`. On a stale id, the sidecar attempts re-resolution by runtime id before raising
`stale element reference`.

### 5.2 Page source
Built in C# in a single pass:
1. Construct a `CacheRequest` pre-loading all schema properties + pattern availability.
2. Iterative BFS over `Children` (no recursion → no stack issues on deep trees).
3. Emit XML with the **exact tag/attribute schema nova2 uses** (tag = `ControlType.ProgrammaticName`
   leaf; attributes: Name, AutomationId, ClassName, ControlType, RuntimeId, LocalizedControlType,
   IsEnabled, IsOffscreen, ProcessId, FrameworkId, HelpText, x/y/width/height relative to root,
   plus pattern-specific CanMaximize/IsModal/WindowVisualState/etc.).

This is both **faster** (one cached pass vs N round-trips) and **more stable** (fewer COM calls, each
bounded by the watchdog) than nova2's PowerShell BFS. `rawView` honored via `TreeFilter`.

### 5.3 Find / XPath
- **Direct strategies** (`accessibility id`, `name`, `class name`, `tag name`, RuntimeId,
  `-windows uiautomation`): build a FlaUI `Condition` and `FindFirst`/`FindAll` natively.
- **XPath**: keep nova2's TS `XPathExecutor`. It walks the parsed AST and, per step, emits a `find` op
  carrying a structured condition + axis/scope. Single-element queries keep nova2's `FindFirst`
  optimization. Multi-step XPath = a few coarse RPC calls (each a native FlaUI find — far cheaper than
  the PowerShell equivalent). We deliberately **reuse the proven engine** rather than re-evaluate XPath
  over a serialized tree.

---

## 6. Stability / anti-hang design *(delegated to me; layered)*

This is the heart of the driver. Five layers, outermost (cheapest/fastest) first. Layers 1–4 reuse and
extend nova2's existing anti-hang machinery; layer 3's thread-poisoning is the new C#-only capability.

1. **Bounded UIA (global).** On the FlaUI automation object set `ConnectionTimeout` and
   `TransactionTimeout` (default 60s, configurable). No COM call waits forever at the UIA layer.
2. **Per-operation watchdog.** Every op runs on the dedicated UIA worker thread under a
   `CancellationToken` plus a wall-clock timeout (`operationTimeout`, default 30s, configurable). On
   expiry → **fail fast**: return a W3C-mapped `timeout` error to TS immediately. **The Appium session
   stays alive** (the user's chosen behavior).
3. **Thread-poisoning isolation (C#-only).** If a UIA call ignores cancellation (COM genuinely frozen),
   the worker thread is marked *poisoned*; a fresh STA worker is spun up for subsequent ops and the
   frozen thread is abandoned (it dies when the COM call eventually returns or on process exit). This is
   exactly what a single-runspace PowerShell backend cannot do.
4. **Serial queue + depth cap + per-command timeout (reused from nova2).** TS keeps the serial
   `commandQueue`, the `MAX_QUEUE_DEPTH` cap, and per-command timeouts. Backpressure prevents pile-ups.
5. **Sidecar recycle (circuit breaker).** If poisoned threads exceed a threshold, or `/status` stops
   responding, or the root element becomes unreachable, the TS layer recycles the sidecar process and
   **re-attaches to the same app/window** (by `appTopLevelWindow`/HWND), preserving the Appium session.
   Mirrors nova2's `ensurePowerShellSession` auto-restart, deduped via a single restart promise.

Net effect: a hang is **bounded** (layers 1–2), **isolated** (layer 3), **rate-limited** (layer 4), and
**recoverable** (layer 5) — never an unbounded global freeze.

---

## 7. Capabilities

Carried over from nova2 where still meaningful, minus PowerShell-only ones, plus new backend/sidecar caps.

**Reused:** `platformName` (=Windows), `app`, `appArguments`, `appWorkingDir`, `appTopLevelWindow`,
`shouldCloseApp`, `ms:waitForAppLaunch`, `ms:forcequit`, `convertAbsoluteXPathToRelativeFromElement`,
`includeContextElementInSearch`, `delayBeforeClick`, `delayAfterClick`, `smoothPointerMove`, `typeDelay`,
`releaseModifierKeys`.

**New / changed:**
- `flaui:backend` — `"uia3"` (default) | `"uia2"`.
- `flaui:connectionTimeout` / `flaui:transactionTimeout` — UIA timeouts (ms).
- `flaui:operationTimeout` — per-op wall-clock watchdog (ms, default 30000).
- `flaui:sidecarPort` — pin the RPC port (default: auto).
- `flaui:elementTableMax` — registry cap (default 10000).
- `flaui:autoRecycle` — enable sidecar recycle circuit breaker (default true).

**Dropped:** `powerShellCommandTimeout`, `isolatedScriptExecution`, `prerun`/`postrun` (PS), `treatStderrAsError`.
*(If the user still wants a `windows: powershell` extension command, it can be reintroduced as a thin
convenience that shells out — but it is no longer the execution backbone.)*

---

## 8. Packaging & distribution

- The sidecar ships as a **self-contained, single-file .NET publish** (`dotnet publish -r win-x64`
  and `-r win-arm64`, `--self-contained`), so end users need **no .NET SDK and no Developer Mode**.
- Both arch binaries are bundled in the npm package (or fetched on `appium driver install` via a
  postinstall step, mirroring how picakia's driver downloads `FlaUI.WebDriver`). **Decision: bundle**
  for offline reliability (stability priority); revisit if package size becomes a problem.
- TS picks the binary matching `process.arch` at session start.

---

## 9. Error handling

- Sidecar returns structured `{ ok:false, error:{ type, message } }`; `type` ∈ the W3C set.
- TS maps `type` → `@appium/base-driver` error classes (`errors.TimeoutError`,
  `errors.StaleElementReferenceError`, `errors.NoSuchElementError`, `errors.InvalidSelectorError`,
  `errors.UnknownError`).
- Transport failures (sidecar dead / connection refused) trigger the layer-5 health-check → recycle path,
  then the command is retried once against the fresh sidecar; a second failure surfaces as `UnknownError`.
- All sidecar-side exceptions are caught at the op-interpreter boundary; an unhandled exception never
  takes down the RPC host.

---

## 10. Testing strategy

Port nova2's suites and add sidecar-specific coverage.

- **C# unit tests** (xUnit): op interpreter, condition→FlaUI mapping, page-source XML schema, element
  registry eviction, watchdog/cancellation behavior (with a deliberately-blocking fake automation).
- **TS unit tests** (mocha): op builders, XPath→op translation, RPC client, error mapping, sidecar
  process manager (spawn/health/recycle) against a mock HTTP sidecar.
- **E2E** (mocha, real apps — Notepad/WinForms/WPF/UWP samples): smoke, xpath, pagesource, click,
  **session-stress** (carry over nova2's 30-min stability test), and a dedicated **hang-injection** test
  (drive an app that intentionally freezes its UI thread; assert fail-fast + session survival + recycle).
- **Schema-compat test:** assert the page-source XML for a reference app matches nova2's output, proving
  drop-in compatibility.

---

## 11. Risks & open questions

1. **Input location** — should mouse/keyboard input (`windows: click/hover/keys/scroll`) stay in the TS
   `winapi`/koffi layer, or move into the sidecar? Moving it in unifies timing/focus with UIA state but
   enlarges the sidecar. *Proposed default:* keep in TS initially (max reuse), revisit if focus races appear.
2. **STA vs MTA worker** — UIA generally prefers STA; confirm FlaUI behavior under our dedicated-thread
   model. To be validated in a spike.
3. **Self-contained binary size** — single-file .NET ~30–70MB/arch. Acceptable for stability/offline;
   monitor.
4. **`-windows uiautomation` raw condition strategy** — nova2 supports C#/PowerShell condition syntax;
   for this driver it becomes a structured-condition syntax. Need to define the exact accepted grammar.
5. **MSAA depth** — `LegacyIAccessiblePattern` exposes MSAA *data*, not a full IAccessible navigation
   tree. If true IAccessible tree-walking is ever required, that's a separate effort. Scope: legacy
   pattern only for v1.

---

## 12. Phased roadmap (SDLC)

A standard incremental lifecycle: each phase ends with working, tested, demoable software.

- **Phase 0 — Spikes (de-risk).** Prove: (a) self-contained sidecar launches & serves HTTP from npm;
  (b) FlaUI UIA3 find + CacheRequest page source works; (c) the watchdog cancels a deliberately-hung op
  and the session survives. Throwaway code; validates the riskiest assumptions first.
- **Phase 1 — Skeleton end-to-end.** TS driver forked + sidecar process manager + `/session` +
  `find` by accessibility id + element registry. One green E2E: open Notepad, find an element.
- **Phase 2 — Core command surface.** Page source (schema-compat), attributes (bulk/CacheRequest),
  actions (invoke/setValue/toggle/expand/window), all direct locator strategies.
- **Phase 3 — XPath.** Wire `XPathExecutor` to `find` ops; pass nova2's xpath E2E suite.
- **Phase 4 — Stability hardening.** Layers 1–5 fully implemented; hang-injection + 30-min stress tests green.
- **Phase 5 — Input & extensions.** `windows:` input commands, clipboard, screen recording, file ops.
- **Phase 6 — Backend selection & packaging.** UIA2 opt-in + MSAA legacy; arch-aware binary bundling;
  docs; release pipeline (semantic-release, mirroring nova2).

Each phase will get its own implementation plan (via the writing-plans workflow) when we reach it.

---

## 13. Summary

Fork nova2's battle-tested TypeScript orchestration; replace only the backend seam — from emitting
PowerShell strings to emitting structured JSON ops executed by a compiled FlaUI (UIA3/UIA2 + MSAA-legacy)
sidecar. Communicate over localhost HTTP/JSON, one coarse call per operation. Make stability the spine via
a five-layer anti-hang design that turns unbounded global freezes into bounded, isolated, recoverable
failures. Keep the page-source XML schema and locator semantics identical to nova2 so existing tests and
XPath transfer unchanged.
