# Sidecar internals — a file-by-file tour

*Architecture · updated 2026-06-05*

> **Layer:** low-level (C# implementation). For the high-level picture see
> [overview](./overview.md); for the wire contract and op shapes see
> [RPC protocol](../03-reference/rpc-protocol.md); for the watchdog / poison / recycle
> story see [stability](./stability.md).

The sidecar is a self-contained .NET 8 (`net8.0-windows`) console app that hosts a minimal
Kestrel server on loopback and does all UI Automation through [FlaUI](https://github.com/FlaUI/FlaUI)
(UIA3 by default, UIA2 selectable). It ships as a single-file, self-contained
`prebuilt/<arch>/FlaUiSidecar.exe`. The TypeScript driver spawns it, reads its port off
stdout, and drives it with structured JSON ops over HTTP.

Source lives in `sidecar/`. The pieces:

| File | Responsibility |
|---|---|
| `Program.cs` | Kestrel host on `127.0.0.1:0` (OS-chosen port, printed as `PORT=<n>` on stdout line 1). Maps the HTTP endpoints (`GET /status`, `POST`/`DELETE /session`, `POST /op`). Owns session lifecycle: app **attach-or-launch**, app-root resolution (the "outermost window" selection, `ResolveAppRoot`/`PickOutermost`), per-op watchdog timeout config, the stdin-EOF parent heartbeat (self-exit on parent death), and the idle/orphan-guard self-exit. Dispatches each op kind to `OpInterpreter` via `RunOp` (which maps exceptions → W3C error envelopes) and runs `powershell` out-of-scheduler with its own bounded child-process path. |
| `OpInterpreter.cs` | The op → FlaUI mapping (the seam, ADR-003). One method per op kind: `Find` (condition tree → `FindFirst`/`FindAll`), `Attributes`, `Action` (element pattern actions: invoke/toggle/expand/select/setValue/window-state/…), `Source`, `Input` (real mouse/keyboard via `FlaUI.Core.Input` — click/hover/scroll/keys/drag, modifier keys, bring-to-front), `Screenshot`, `Clipboard`, `File`, `Walk` (XPath axis tree-walking), `Window`. Builds `BasicProps` from elements and translates "not found"/"stale" into sidecar exceptions. |
| `UiaScheduler.cs` | The STA worker model + watchdog. Runs UIA work one op at a time on a dedicated STA thread, each bounded by a wall-clock timeout. On timeout it cancels, probes worker responsiveness, and — if the COM call is truly frozen — **poisons** the thread (abandons it, spins a fresh one on the same queue). Past `MaxPoisonedThreads` (5) it raises `SchedulerFatalException` so the TS layer recycles the whole sidecar. FlaUI-free so its stability logic is unit-testable cross-platform. |
| `ElementRegistry.cs` | `RuntimeId → AutomationElement` map with **FIFO eviction** at a configurable cap (`flaui:elementTableMax`). On eviction it explicitly **releases the underlying COM/RCW** (via reflection onto `NativeElement`) so long sessions don't leak native UIA handles. `TryGet` misses are surfaced so callers map them to stale/no-such-element. |
| `PropertyResolver.cs` | Attribute/property resolution for `getAttribute`/`getAttributes`/`source`. One `Resolve(name)` entry point covering: direct UIA element properties, `Is<Pattern>PatternAvailable` flags (derived generically from FlaUI's pattern table), `LegacyIAccessible.*` (+ `legacy*` aliases, inspect-style Role/State text with hex), and `<Pattern>.<Prop>` dot-notation via reflection. `All()` builds the full inspect-comparable attribute dump. Permissive: unknown-but-plausible names return null, not an error. |
| `PropertyResolverLogic.cs` | FlaUI-free pure helpers split out of `PropertyResolver` for cross-platform unit testing: the direct-attribute name list, legacy-name normalization, availability-flag normalization (reconcile inspect vs FlaUI "2"-pattern spellings), plausible-token classification, and inspect-style `"text (0xHEX)"` formatting. |
| `PageSourceBuilder.cs` | Builds the page-source XML. Iterative stack-based DFS (no recursion → safe on deep trees) producing a correctly nested tree; tag = ControlType leaf; the attribute set is the full UIA property list, x/y relative to the start element, and Window/Transform pattern attrs — the same schema the XPath engine matches against. |
| `Win32.cs` | Minimal `user32`/`kernel32` P/Invoke for reliable window foregrounding (the `AttachThreadInput` trick that beats the foreground lock), an escalating strong-foreground path (topmost toggle → minimize/restore), and a `MoveWindow` fallback when a window has no usable UIA `TransformPattern`. |
| `ClipboardImage.cs` | Image clipboard get/set via Win32 clipboard P/Invoke (no WinForms, keeps the Web SDK build clean). Driver exchanges images as PNG bytes; on the Windows clipboard they live as **CF_DIB**, with PNG↔DIB conversion via `System.Drawing.Bitmap`. Must run on an STA thread — the scheduler worker already is. |
| `FlaUiSidecar.csproj` | The project: `Microsoft.NET.Sdk.Web`, `net8.0-windows`, `FlaUI.UIA3`/`FlaUI.UIA2` 4.0, `TextCopy` for plaintext clipboard. Tests/spikes are excluded from the exe. |

## STA worker model

UIA/COM strongly prefers a single-threaded apartment, and a frozen provider can wedge a COM
call indefinitely. The sidecar therefore funnels **every** UIA-touching op through one
`UiaScheduler` worker thread (STA on Windows), serialized so exactly one op runs at a time
(`SemaphoreSlim(1,1)`). Kestrel may dispatch overlapping HTTP requests, but they queue behind
the gate. Each op runs under a wall-clock watchdog (`flaui:operationTimeout`, default 30s);
FlaUI's own `ConnectionTimeout`/`TransactionTimeout` are nested just below it so a frozen
provider's COM call usually self-aborts and returns an error *before* the watchdog has to act.
When it doesn't, the watchdog poisons the worker (abandons the frozen STA thread, starts a
fresh one) so the session keeps moving; runaway poisoning escalates to a fatal signal that the
TypeScript side turns into a full sidecar recycle. PowerShell ops are the one exception — they
run off the scheduler (no UIA involved) under their own bounded child-process timeout.

See [stability](./stability.md) for the full multi-layer anti-hang model and the
TS-side recycle/circuit-breaker that sits above this worker.
