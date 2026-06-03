# Internal Changelog — "what we did and why"

A running log of work sessions, written so anyone (incl. a "not very familiar" reader) can follow the
project's evolution. Newest first.

---

## 2026-06-03 (cont.) — C# sidecar GREEN on Windows (verified)

A subagent took the sidecar from "authored" to **compiling green + unit tests passing on the real Windows
box**: `dotnet build sidecar/FlaUiSidecar.csproj` → 0 errors; `dotnet test` → 3/3 UiaScheduler tests pass
(incl. the hang/poison/recover test, now on a real STA thread).

**FlaUI 4.x API corrections made (valuable reference):**
- `new TrueCondition()` → `TrueCondition.Default` (match-all is a singleton; ctor is private). `FlaUI.Core.Conditions`.
- `CacheRequest.TreeFilterCondition` → `CacheRequest.TreeFilter` (`ConditionBase`). `CacheRequest` ∈ `FlaUI.Core`.
- `FlaUI.Core.Exceptions.ElementNotFoundException` does NOT exist → use a sidecar-local exception; `FindFirst`
  returning `null` is how "not found" is signaled. Mapped to W3C `no such element` in Program.cs.
- Pattern chain `el.Patterns.<X>.Pattern.<Method>()`, `WindowVisualState` ∈ `FlaUI.Core.Definitions`,
  `ValuePattern.SetValue(string)` — all confirmed correct.
- csproj: switched to `Microsoft.NET.Sdk.Web` (Kestrel/minimal API), excluded `tests/**`; test csproj
  retargeted net9.0 → net8.0 (box has SDK 8 only).
- `PageSourceBuilder`: rewrote flat BFS → **stack-based DFS** so the XML nests correctly for XPath.

**Still needs a real UI run to verify (flagged):** `/session`+`/op` against a live app; page-source schema
parity with nova2 (tag names, relative x/y/w/h, pattern attrs); `rawView` TreeFilter is currently always-true.

---

## 2026-06-03 (cont.) — Windows machine online + Phase 3 XPath (parallel subagents)

**Windows test target connected:** `admin@172.16.10.44` (Win 10, 64-bit), SSH passwordless from the Mac.
Found: Node 24.16, npm 11.13, **Appium 3.5.0** present; `.NET SDK` and `git` were NOT installed.
Installed **.NET SDK 8.0.421** to the user dir via `dotnet-install` (no admin needed). Discovered the
running Appium bundles **@appium/base-driver@10.6.0 / @appium/types@1.5.0** → pinned (ADR-011 resolved).
Repo copied to `C:\Users\admin\flaui-driver` via `git archive` zip + scp (no git needed on the box).

**First Windows build of the sidecar surfaced real errors** (the point of testing for real):
1. `Microsoft.AspNetCore` missing → main csproj must use `Microsoft.NET.Sdk.Web`.
2. Main project was globbing `sidecar/tests/*.cs` → must exclude `tests/**`.
3. Test csproj targeted net9.0 but the box has SDK 8 → retarget net8.0.
4. FlaUI 4.x symbol fixes pending (TrueCondition, pattern accessors, page-source nesting).
→ Delegated the full "make C# build+tests green on Windows" loop to a background subagent.

**Phase 3 — XPath engine (DONE, verified on Mac):** a subagent ported nova2's XPath engine onto our
structured op contract: `lib/xpath/core.ts` exposes `xpathToElementIds(selector, multiple, contextId,
findViaBackend)` and emits `findOp` calls (no PowerShell). **30/30 mocha pass** (16 prior + 14 new).
Supports absolute/relative paths, `//`, child/descendant/self axes, attribute eq/neq + and/or predicates,
positional `[n]`/`[last()]`, `(...)[1]`, unions, and findFirst optimization. Not yet: reverse/sibling axes,
predicate functions (contains/starts-with), numeric relational predicates — documented in the header.

**Known follow-up:** `tsc -b` build is red (NodeNext needs `.js` import extensions; driver.ts needs the
@appium deps) — delegated to a "TS build green" subagent. Tests (via tsx) are green.

---

## 2026-06-03 (cont.) — Phase 2 command surface (TS verified, C# authored)

**VERIFIED ON macOS (15/15 mocha green):**
- `lib/backend/ops.ts` — added `attributesOp`, `actionOp`, `sourceOp` builders (+ tests).
- `lib/commands/extensions.ts` — pure `windows:` command → action-op mapping
  (`buildWindowsCommandOp`, `isSupportedWindowsCommand`, `SUPPORTED_WINDOWS_COMMANDS`) (+ tests).
- These pure modules carry the Phase 2 logic and are OS-independent, so they test on Mac.

**AUTHORED, WINDOWS-VERIFICATION-PENDING:**
- `sidecar/OpInterpreter.cs` — `Attributes` (bulk), `Action` (invoke/toggle/expand/collapse/select/
  setFocus/scrollIntoView/setValue/window-state), `Source`; `Program.cs` `/op` routes them.
- `sidecar/PageSourceBuilder.cs` — CacheRequest-based XML builder.
- `lib/driver.ts` — `getPageSource`, `getAttribute`, `click` (→Invoke), `setValue`, `clear`,
  `windowsCommand` generic handler, and Appium-3 `executeMethodMap` for every `windows:` command.

**New open items for the Windows pass:**
- `PageSourceBuilder.Build` currently writes a FLAT BFS list — replace with stack-based DFS for faithful
  nesting, then diff XML against nova2 for schema parity (this is required before XPath/Phase 3).
- Confirm FlaUI 4.x pattern accessor symbols used in `OpInterpreter.Action`.
- Confirm `TrueCondition`/`TreeFilterCondition` usage in `PageSourceBuilder`.

---

## 2026-06-03 — Project bootstrap: design → decisions → plan → verified foundation

**Context.** Goal: a new Appium 3 Windows driver backed by a compiled C# FlaUI sidecar, living alongside
the user's `appium-novawindows2-driver`. Priority order locked: **stability > framework coverage > speed**.

**What was produced (docs):**
- `docs/superpowers/specs/2026-06-03-...-design.md` — full design (architecture, seam, anti-hang, Appium 3).
- `docs/DECISIONS.md` — ADR-001..011 (names, C# FlaUI backend, JSON-op seam, HTTP transport, no-PowerShell,
  bundled binaries, Appium-3-only, etc.).
- `docs/NEXT-STEPS.md`, `docs/SUBAGENTS.md` (+ `.claude/agents/*`), and the Phase 0–1 plan.

**What was BUILT and VERIFIED on macOS (real green tests):**
- `sidecar/UiaScheduler.cs` + tests — the anti-hang core (**Spike C**). Proven: a frozen work item
  fails fast via the watchdog, the worker thread is poisoned & replaced, and the scheduler stays usable;
  cooperative cancellation does not poison. **3/3 xUnit pass** (`net9.0`, cross-platform).
- `lib/backend/ops.ts` — the structured JSON op contract (the seam).
- `lib/backend/rpc-client.ts` — localhost HTTP/JSON client with `BackendResult` unwrap + `RpcError`.
- `lib/backend/sidecar.ts` — sidecar process manager (spawn → read `PORT=` → health → clean stop). This is
  the Node half of **Spike A**, tested against `tests/fixtures/fake-sidecar.mjs`.
- **8/8 mocha unit tests pass.**

**What was AUTHORED but is WINDOWS-VERIFICATION-PENDING (do not assume working):**
- `sidecar/FlaUiSidecar.csproj` (net8.0-windows, FlaUI.UIA3/UIA2), `sidecar/Program.cs` (Kestrel host,
  `/status`+`/session`+`/op`, port handshake, stdin heartbeat), `sidecar/ElementRegistry.cs`,
  `sidecar/OpInterpreter.cs` (find op), `scripts/publish-sidecar.mjs`, `lib/driver.ts`.
- These reference FlaUI (Windows-only) and `@appium/base-driver` (not yet installed), so they do **not**
  build here by design.

**Open items flagged inline for the Windows pass:**
1. Reconcile `@appium/base-driver`/`@appium/types` versions to the Appium-3 line; add to `package.json`.
2. `OpInterpreter.BuildCondition`: confirm FlaUI's real true-condition symbol (used `new TrueCondition()`).
3. `ElementRegistry`: refactor to a FlaUI-free seam so eviction logic is unit-testable.
4. Spike B (FlaUI find + CacheRequest page source) — run on Windows; record findings.
5. Real anti-hang against a genuinely frozen app (Phase 4) — the macOS test simulates it with a blocking work item.

**Why this sequencing.** The two riskiest assumptions (anti-hang works; sidecar-from-Node works) were the
ones provable without Windows — so they were proven first. Everything Windows-only was authored with clear
"verify on Windows" markers rather than claimed as done.
