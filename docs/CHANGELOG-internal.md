# Internal Changelog — "what we did and why"

A running log of work sessions, written so anyone (incl. a "not very familiar" reader) can follow the
project's evolution. Newest first.

---

## 2026-06-03 (cont.) — nova2-suite compatibility batch (goal: run the user's real nova2 E2E suite)

Analyzed nova2's full e2e suite (11+ test files; webdriverio v9; Notepad + `app:'Root'` desktop sessions;
13 xpath axes + 24 functions; ~20 windows: commands; `powershell` execute used heavily for verification).
Spawned a background subagent to bring `lib/xpath` to FULL nova2 parity (axes/functions/numeric ops/@*/
aliases) against a new `XPathBackend` contract (find + walk + attributes).

Implemented + verified (regression E2E still fully green):
- **`app: 'Root'`** → desktop session (`automation.GetDesktop()`).
- **`walk` op** (parent/ancestors/following-siblings/preceding-siblings via TreeWalker) — for reverse axes.
- **W3C window commands**: getTitle, getWindowHandle(s), getWindowRect, setWindowRect (TransformPattern),
  maximizeWindow, minimizeWindow — all on the session root window via the new `window` op.
- **windows:**: launchApp (re-roots session), closeApp, setProcessForeground (by process name),
  typeDelay (advisory), cacheRequest (accepted no-op), getPageSource (element-scoped).
- **`powershell` execute** (ADR-007 revised: optional convenience, gated as `flauinative:power_shell`
  insecure feature; runs OUT of the UIA scheduler so long scripts don't hit the watchdog).
- **nova2-compat caps accepted**: ms:waitForAppLaunch (sleeps), prerun (runs via powershell), plus
  powerShellCommandTimeout/treatStderrAsError/typeDelay/smoothPointerMove/delays/etc. (advisory).
- `windows:` element commands now accept BOTH `{elementId}` and the W3C element-key object (nova2 style);
  setClipboard accepts nova2's `b64Content`. **Fix:** W3C `getName` (Get Element TAG Name) now returns the
  ControlType tag, not the Name property.

---

## 2026-06-03 (cont.) — W3C Actions API + screenshots + clipboard (E2E PASS)

**All verified on Windows in one run (Notepad E2E):**
- **`performActions` ✅** — W3C Actions subset: sequential input sources; mouse pointer with
  move/down/up (element-origin offsets computed from the element CENTER in TS, positions tracked for
  `pointer` origin); key actions (specials → VK press/release via the `W3C_KEY_TO_VK` map, printables typed
  on keyDown). E2E: pointer-click the Edit + key-type → Value `"xyz"`. `releaseActions` = no-op (no
  persistent pressed state yet).
- **Screenshots ✅** — new `screenshot` op (FlaUI `Capture.Element` → PNG → base64); W3C `getScreenshot`
  (session root) + `getElementScreenshot`. E2E asserts `iVBOR…` PNG payloads.
- **Clipboard ✅** — new `clipboard` op using **TextCopy** (no WinForms needed under the Web SDK);
  `windows: setClipboard` / `windows: getClipboard` (plaintext base64, nova2-style). E2E roundtrip green.
- Sidecar input gained raw `move`/`down`/`up` kinds (for Actions).

`windows:` surface now **24/35 + clipboard**; remaining: typeDelay, app-lifecycle ×3, session-scoping ×3,
recording ×2.

---

## 2026-06-03 (cont.) — Phase 5 input layer via FlaUI.Core.Input (E2E PASS)

**ADR-005 revised:** instead of porting nova2's koffi/Win32 input layer to TS, input is implemented in the
**sidecar** with FlaUI's native `Mouse`/`Keyboard` (SendInput wrappers) — far less code, same trusted
library, input timing next to UIA state. Compiled first try on Windows.

**New:** `input` op (click/hover/scroll/keys/clickAndDrag) in OpInterpreter; element-targeted points default
to center; `windows:` input commands with per-command param lists (INPUT_COMMANDS) and positional-args
reconstruction in the generated prototype methods; W3C `click` now performs a REAL pointer click (UIA Invoke
remains as `windows: invoke`); `HasKeyboardFocus` readable as attribute.

**E2E verified on Windows:** real click → `HasKeyboardFocus="true"` ✅; real typing (`windows: keys`,
`Keyboard.Type`) → Value reads back `typed-via-keys` ✅; scroll/hover 200 ✅; everything previous (incl.
attach flow) still green. clickAndDrag implemented but needs an observable scenario to verify.

---

## 2026-06-03 (cont.) — Parity batch 2: attach-to-window + page-source schema parity (E2E PASS)

**Both E2E phases green on Windows:**
- **Attach flow ✅:** launch Notepad with `shouldCloseApp:false` → read the window's `NativeWindowHandle`
  (`0x40344`) via getAttribute → delete session (app SURVIVES) → create a new session with
  `appium:appTopLevelWindow` (no `app`) → find Edit → setValue `attached-ok` reads back ✅ → delete session
  closes the attached window (WindowPattern).
- **Page-source schema parity ✅:** `PageSourceBuilder` now emits the full nova2 attribute set
  (AcceleratorKey…ProcessId, RuntimeId), **x/y relative to the start element**, and pattern attributes
  (CanMaximize/CanMinimize/IsModal/WindowVisualState, CanRotate/CanResize/CanMove). Notepad source grew
  4.6 KB → 13.9 KB; schema markers asserted in E2E. `rawView` + CacheRequest single-pass remain TODO.

**New caps:** `appTopLevelWindow` (hex HWND attach), `appArguments`, `appWorkingDir`, `shouldCloseApp`
(default true). Sidecar `/session` handles attach-vs-launch (ProcessStartInfo for args/cwd); new
`DELETE /session` closes the app per `shouldCloseApp` (launched → `app.Close()`, attached → WindowPattern
close); TS `deleteSession` calls it before stopping the sidecar. `ReadAttribute` gained
`NativeWindowHandle` (hex).

**Bug found & fixed via the live run:** finding the root window by its own ClassName failed — direct-strategy
find used `descendants` scope, which excludes the start element. Switched to `subtree` (matches nova2's
default `includeContextElementInSearch:true`).

---

## 2026-06-03 (cont.) — Parity batch 1: W3C reads + locators + windows: reads (E2E PASS)

Built `docs/PARITY.md` (full nova2 → FlaUINative matrix) per the user's request, then closed the first gap
batch. **All E2E green on Windows** (Notepad):
- New W3C commands: `getText` ✅ ("gamma-789" read back), `getElementRect` ✅ ({x,y,width,height} real
  coords), `elementEnabled`/`elementDisplayed`/`elementSelected` ✅ (true/true/false), plus `getName`/
  `getProperty` (implemented, same paths).
- Locator strategies: `tag name` ✅ (ControlType — found Notepad's Document), `id` (AutomationId alias, 🟡).
- `windows:` read commands: `getValue` ✅ (echoes typed text), `isMultiple`/`selectedItem`/
  `allSelectedItems`/`getAttributes` implemented 🟡.
- Sidecar: `Action` now supports read-style actions returning data; `ReadAttribute` gained `IsSelected`
  (SelectionItem) and `BoundingRectangle` (rect object).

Next per PARITY: attach-to-window caps (`appTopLevelWindow` etc.) + page-source schema parity, then input.

---

## 2026-06-03 (cont.) — Command surface verified on Windows (setValue/clear/getAttribute/execute)

Extended the Notepad E2E (`scripts/e2e-notepad.mjs`) to exercise the action/attribute surface — **all green**:
- `setValue` (W3C send-keys) → `getAttribute("Value")` reads back `alpha-123` ✅
- `windows: setValue` via the **execute method** → reads back `beta-456` ✅ (verifies executeMethodMap routing)
- `clear` → `Value` is `""` ✅
- `getAttribute("ClassName")` → `Edit` ✅ (plus find + page source still ✅)

**Two real bugs found & fixed via the live run:**
1. **`windows: setValue` returned 405.** base-driver provides no default `execute`, so the W3C execute
   endpoint 405'd. Re-added `execute(script, args)` on the driver delegating to `this.executeMethod`.
2. **executeMethodMap routing was broken.** base-driver's `executeMethod` calls `this[command](...args)`
   WITHOUT the script name, so mapping every `windows:*` to one generic `windowsCommand` couldn't tell them
   apart. Fixed: generate a distinct `windowsCmd_<name>` method per command on the prototype; each calls the
   shared `runWindowsAction(<name>, elementId, value)`. (Confirmed by reading base-driver's
   `executeMethod`/`validateExecuteMethodParams`: params arrive positional as `[elementId, value]`.)

Sidecar: `OpInterpreter.ReadAttribute` gained a `"Value"` case (reads `ValuePattern.Value`) so typed text is
readable via `getAttribute("Value")`. README.md authored (honest implemented-vs-planned).

---

## 2026-06-03 (cont.) — 🎉 FULL E2E PASS on real Windows (Notepad)

The whole stack runs for real: **Appium 3.5.0 → FlaUINativeDriver → localhost HTTP RPC → C# FlaUI sidecar
(UIA3) → Notepad**.

**How it was run:** synced source to `C:\Users\admin\flaui-driver`, `npm install` + `npm run build`,
published the sidecar (`prebuilt/win-x64/FlaUiSidecar.exe`, self-contained ~189 MB), `appium driver install
--source=local` (driver `flauinative@0.0.1` linked, alongside `windows@5.4.1` and `novawindows2@1.1.21`).
Appium server started in the INTERACTIVE session via a Task Scheduler task (LogonType Interactive) so the
sidecar can launch/automate a visible Notepad; the test client (`scripts/e2e-notepad.mjs`, raw HTTP, no
webdriverio) drove it from the SSH (Session 0) side.

**Result (`scripts/e2e-notepad.mjs`):**
- `POST /session` → 200, sessionId returned; appium log confirms BaseDriver 10.6.0 on both sides, sidecar
  spawned, session created in ~2.4 s.
- `POST /element {class name: Edit}` → 200, element `42.393566` (real UIA find).
- `GET /source` → 200, **4611 bytes of correctly-nested XML**:
  `<Window Name="Untitled - Notepad" ClassName="Notepad" ControlType="Window" ...><Document ...>`.
- **E2E_PASS**, exit 0.

**Bug found & fixed during the run:** first attempt, `/source` returned 500 — `PageSourceBuilder` used
`CachedChildren` on the root element, which was obtained OUTSIDE the `CacheRequest`, so FlaUI threw.
Fixed by switching the DFS to LIVE traversal (`FindAllChildren()` + live property reads). Correct now;
re-introducing a single-pass CacheRequest (re-fetch start under the active cache) is a logged perf TODO.

**This validates spec §2–§5 end-to-end on the real target.** Remaining for later phases: page-source schema
parity with nova2 (tag = ProgrammaticName, relative coords, pattern attrs), rawView, actions/attributes/
input against live apps, the real anti-hang test against a frozen app, win-arm64 binary, README.

---

## 2026-06-03 (cont.) — TS build GREEN + base-driver wired (verified on Mac)

A subagent made the TypeScript layer build and load cleanly:
- `npm run build` → 0 errors; `npm run test:unit` → 30/30; `node -e import('./build/lib/driver.js')` → `function`.
- Pinned `@appium/base-driver@10.6.0` (dep) + `@appium/types@1.5.0` (devDep); removed the temporary `_notes`.
- **Module strategy:** kept ESM + NodeNext and added `.js` extensions to all relative imports (Bundler
  resolution would emit extensionless specifiers that Node's ESM loader can't resolve at runtime).
- **`driver.ts` rewired to the real base-driver 10.6 API:** correct `createSession`/`deleteSession`/
  `findElOrEls` signatures and W3C types, `ExecuteMethodMap<FlaUINativeDriver>`, removed the redundant
  `execute` override. **XPath now wired into `findElOrEls`** via `xpathToElementIds` + a `findViaBackend` RPC.
- Known harness quirk: importing `driver.ts` under `tsx` hits `ERR_PACKAGE_PATH_NOT_EXPORTED` from a
  transitive dep (`unicorn-magic`); the real Node ESM loader resolves it (proven by the `node -e` gate), so
  unit tests cover the xpath logic via `xpathToElementIds` directly rather than importing the driver.

**Still needs the real Appium/Windows run:** createSession → sidecar spawn → find/source/attribute/action
round-trips.

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
