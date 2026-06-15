# Final Changes — Pre-Release Pass

> Consolidated record of the pre-release work (bug fixes + .NET 10 migration + multi-arch).
> Supersedes the working drafts `RELEASE-FIXES.md` and `docs/internal/xpath-conformance-audit.md` (removed).
> Date: 2026-06-15.

## Verification status

| Suite | Result |
| :-- | :-- |
| TypeScript build (`npm run build`) | ✅ clean |
| TypeScript unit (`npm run test:unit`) | ✅ **213 passing** |
| C# build (`dotnet build sidecar/FlaUiSidecar.csproj`, net10.0-windows) | ✅ 0 errors |
| C# unit (`dotnet test sidecar/tests`, net10.0) | ✅ **184 passing** |
| Self-contained publish + run | ✅ x64 & x86 boot + serve `/status` HTTP 200; arm64 builds (PE ARM64), runtime needs real ARM hardware |

> .NET SDKs installed locally: 8.0.422 + **10.0.301** (`C:\Program Files\dotnet`). End users need no .NET — the sidecar exe is self-contained.

---

## 1. Anti-hang / lifecycle (P0)

- **P0-1 — `/session` watchdog budget.** `/session` setup legitimately runs far longer than a per-op (attach poll up to `createSessionTimeout`, plus the app-launch root wait). The 30s per-op watchdog was killing slow attaches and poisoning the worker.
  - C#: `OpLogic.SessionSetupTimeout(attachBudget, rootWait, grace)`; `Program.cs` passes a dedicated `setupTimeout` into `RunOp`.
  - TS: `lib/backend/timeouts.ts::sessionRpcTimeoutMs()`, used by **both** `createSession()` and the recycle path (`doRecycle`).
- **P0-2 — idle guard never cuts a live op.** Added an `inFlight` counter (Interlocked, bumped around every `RunOp`/`RunPowerShell`), `Touch()` moved to `finally`, and `OpLogic.ShouldSelfExit(inFlight, idle, idleTimeout)` — self-exit only when `inFlight == 0`.
- **P0-3 — spawn failure no longer crashes Appium.** `lib/backend/sidecar.ts` attaches a persistent `proc.on('error', …)`; a spawn-level failure (ENOENT / blocked exe) now rejects the handshake with a path-bearing message instead of escalating to an `uncaughtException`. `isRunning`/`exitReason` reflect `spawnError`.

## 2. Correctness / compatibility (P1)

- **P1-4 — "backend fatal" routing + worker generation token.**
  - New error type `"backend fatal"` (`OpLogic.W3C.BackendFatal`, `W3CErrorType` in `ops.ts`). `SchedulerFatalException` now classifies to it (was `"unknown error"`).
  - `driver.ts::ensureHealthyAndOp` routes a `"backend fatal"` `RpcError` through the **transport-failure** path — `markDead` by default, `tryRecycle` when `flaui:autoRecycle` — instead of treating it as "backend alive".
  - `UiaScheduler` gained a generation token: a poisoned worker whose frozen COM call later returns hands the item back and stops consuming, so no op runs on a previously-wedged thread.
- **P1-5 — XPath `//Tag[n]` per-parent** (XPath 1.0) for walk-capable backends, plus conformance fixes #2 (non-integer positional crash), #3 (empty node-set `=`/`!=`), #4 (multi-step `@attr` comparison), #5 (boolean predicate on reverse/sibling axes). Tests: `tests/unit/xpath-conformance.spec.ts`, `tests/unit/xpath-positional.spec.ts`.
- **P1-6 — `send_keys` appends, `windows: setValue` replaces.** `SetValue(el, value, append, typeDelayMs)`: `append=true` (driver `setValue`/W3C send_keys) focuses + types into existing content; `append=false` (`windows: setValue`, `clear()`) keeps ValuePattern-replace / select-all-delete-type.

## 3. Input edge-cases (P2-7) + page source (P2-8)

- **P2-7a** click/hover with no element and no x/y → current cursor position (`Win32.CursorPos()`), was a `KeyNotFoundException`.
- **P2-7b** scroll with only `amount` → vertical notches via `OpLogic.ScrollDelta` (was a silent 0 no-op).
- **P2-7c** W3C Actions button map `0→left, 1→middle, 2→right` (`ops.ts::w3cPointerButtonName`); middle no longer collapses to left.
- **P2-7d** `clickAndDrag` timed drag interpolates the path (`OpLogic.DragPath`) instead of jumping; final step lands exactly on the destination.
- **P2-8** page-source XML sanitization (`OpLogic.SanitizeXmlText`, used by `PageSourceBuilder.WriteAttr`): strips XML-1.0-illegal control chars / lone surrogates, keeps tab/LF/CR and valid surrogate pairs — a legacy Win32 control char no longer blows up `page_source`.
- **P2-9** flaky `rpc-client.spec.ts` close fixed (`closeAllConnections`).

## 4. `appium:typeDelay` now applied (was a silent no-op)

- Read from the session cap at `createSession`; `windows: typeDelay` overrides at runtime.
- Threaded into `send_keys`/`setValue` and `windows: keys` ops; sidecar `TypeText(text, delayMs)` paces characters when `delayMs > 0`.

## 5. .NET 10 LTS migration + multi-arch (x64 / x86 / arm64)

- **Why .NET 10 over 8:** identical Windows OS floor (Windows 10 **1607** / **Server 2016**, archs x64/x86/arm64) but supported to ~2028. .NET 9 is STS and already EOL (May 2026). Sources: [.NET 10 supported OS](https://github.com/dotnet/core/blob/main/release-notes/10.0/supported-os.md), [.NET 8 supported OS](https://github.com/dotnet/core/blob/main/release-notes/8.0/supported-os.md).
- TFM bumped: `FlaUiSidecar.csproj` → `net10.0-windows`, tests → `net10.0`. FlaUI 4.0.0 compiles cleanly.
- **32-bit added:** `publish-sidecar.mjs` publishes `win-x64`, `win-x86`, `win-arm64`; `driver.ts` selects the RID by `process.arch` (`arm64→win-arm64`, `ia32→win-x86`, else `win-x64`); `assert-package-contents.mjs` warns on missing x86/arm64.

---

## Still open (deferred — needs a decision or hardware)

- **XPath #6 union document order** and **#7 right-associative arithmetic** — parser-level / architectural; shared with the released nova2 engine. Deferred.
- **XPath element string-value → `Name`** (`//*[. = 'x']`, `contains(., 'x')` currently never match) — product decision.
- **XPath reverse-axis order (#C)** — confirm the C# sidecar `walk` order for `ancestors`/`preceding-siblings`/`following-siblings`, then normalize in the engine or document the contract.
- Minor XPath: `substring(NaN)→''`, `namespace-uri()→''`, `appbar`/`semanticzoom` English-only locale aliases.
- **NU1904** — `System.Drawing.Common 5.0.2` (transitive via FlaUI) flagged critical by the .NET 10 NuGet audit. DoS-on-malicious-image class; not a functional issue for automation. Override with a patched `System.Drawing.Common` `PackageReference` if a clean audit is required.
- **arm64 runtime smoke-test** on real ARM hardware (build + PE verified; can't execute arm64 on an x64 host).
- **First-release packaging decision:** ship all three arches or x64 + experimental x86/arm64.
