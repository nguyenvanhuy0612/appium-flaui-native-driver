# Internal Changelog — "what we did and why"

A running log of work sessions, written so anyone (incl. a "not very familiar" reader) can follow the
project's evolution. Newest first.

---

## 2026-06-03 (cont.) — Phase A: FlaUI-native full attribute/property resolution (NOT published)

`getAttribute`/`getProperty`/`getAttributes` now resolve the full UIA surface the FlaUI way (no PowerShell
port). Verified on .44 to match `inspect.exe`'s Start-button dump property-by-property:
- **Is<Pattern>PatternAvailable** flags — generic via `PatternLibrary.AllForCurrentFramework` +
  `el.IsPatternSupported` (Invoke=true, LegacyIAccessible=true, rest false).
- **LegacyIAccessible.\*** (+ `legacy*` aliases, UIA-empty→Legacy fallback) via `el.Patterns.LegacyIAccessible`;
  Role/State formatted `"push button (0x2B)"` / `"focusable (0x100000)"` (Oleacc text + hex).
- **pattern dot-notation** (`Value.Value`, `Toggle.ToggleState`, `Window.CanMaximize`, RangeValue/Scroll/
  Grid…) via reflection over `el.Patterns`; unsupported → null (never 500).
- **direct props** incl. `ProviderDescription`, `IsDialog`; **fixed `BoundingRectangle`** → `{x,y,width,height}`
  (was `"[object Object]"`). `setValue` gained a keyboard-typing fallback for controls without ValuePattern.
- New: `sidecar/PropertyResolver.cs` + FlaUI-free `PropertyResolverLogic.cs` (18 unit tests). TS unit 116,
  C# unit 37, e2e 75, smoke 1.
- **Value format (please confirm):** per-name `getAttribute` coerces to W3C strings (`"true"`, `"0"`, rect
  as JSON string); the `all` dump keeps native JSON. Matches inspect's values, W3C-correct.
- **Not published** (per user — review behavior first). Committed to git/GitHub only.

---

## 2026-06-03 (cont.) — v0.1.0-beta.3: bring-on-top click + escalating setWindowForeground

User asked the click to **bring the target on top first** (nova2's idea — focus the Window/Pane ancestor —
but implemented the FlaUI way, not raw PowerShell/Win32), and made `windows: setWindowForeground` the
**stronger, escalating** raise.
- `click`/`hover`/`clickAndDrag`: **basic bring-on-top** = `FlaUI Focus()` on the nearest Window/Pane
  ancestor (FlaUI's `Focus()` natively does `SetForeground()` + thread-attach for windows); Win32 fallback
  only if it throws. Raw W3C-Actions `move` left untouched (caller controls foreground).
- `windows: setWindowForeground`: FlaUI `Focus()` first, then **escalate** via Win32 (HWND_TOPMOST toggle →
  minimize/restore) only if still not foreground; now takes an **elementId** to target that element's
  top-level window. Returns `{ok}`. **Verified on .44:** restored a minimized Notepad → `{ok:true}`.
- Build-from-source restored on the .44 box (its checkout had been wiped) → tsc 0, 116 unit, sidecar publish 0.

> **npm incident:** beta.2 was published from the wiped .44 (empty/stale build) → **deprecated**; use
> **beta.3** (`appium driver install --source=npm appium-flaui-native-driver@beta`). Published from a clean
> from-source build. GitHub tag `v0.1.0-beta.3`. Re-verify a driver upgrade by **restarting Appium**.

---

## 2026-06-03 (cont.) — 🏁 v0.1.0-beta.1 (stability proven, packaged, install-verified)

> **Published to npm 2026-06-03:** `appium-flaui-native-driver@0.1.0-beta.1` (dist-tags `beta` + `latest`),
> **win-x64 only** (~180 MB unpacked; arm64 omitted from the npm tarball to keep it light — local-build for
> arm64, per-arch split at GA per ADR-013). Install: `appium driver install --source=npm
> appium-flaui-native-driver@beta`. Published under npm user `nguyenvanhuy0612`. NOTE: the first publish
> token lacked write scope (E404 on PUT); a write-enabled token succeeded. Token kept only in a local,
> gitignored `.npmrc` (never committed) — rotate the one pasted in chat.

- **Headline stability PROVEN on Windows** via `tests/e2e/11-hang-injection.e2e.spec.ts` (WinForms HangApp,
  UI thread frozen 60 s): op → W3C `timeout` in ~5 s (watchdog), `/status` 200/43 ms, `DELETE` bounded
  (~5 s, app-Kill fallback), fresh session recovers. **No driver changes needed.** e2e now **75/75**.
- **Beta packaged & install-verified:** version → `0.1.0-beta.1`; `npm pack` → ~147 MB tarball (embeds
  self-contained sidecars). `appium driver install --source=local <tgz>` from scratch → manifest reads
  `0.1.0-beta.1`; **smoke green against the freshly-installed driver** under `appium --relaxed-security`.
- Docs: `BETA.md` (try-it guide) + `RELEASE-0.1.0-beta.1.md`; FUNCTIONS §7 stability marked ✅ proven;
  README/docs index point at the beta. Tagged `v0.1.0-beta.1`.

---

## 2026-06-03 (cont.) — audit remediation + arm64/Server + permissive security posture

- **Adversarial audit remediated** (all 26 findings; details in [`AUDIT-2026-06-03.md`](./AUDIT-2026-06-03.md)):
  security gates made loud + prerun gated (F22/F23), scheduler concurrency-safe + fatal budget (F3),
  bounded PowerShell child (F4), TS layer-5 recycle+reattach+retry (F1), COM release on eviction (F7),
  app Kill fallback + ms:forcequit (F10), `flaui:*` caps threaded (F5), mapped W3C errors for malformed
  input (F16/F17/F18/F20), docs-honesty pass (F14/F15/F19/F26). **W3C e2e 74/74** (+5 audit tests), smoke
  1/1, Mac 116 unit + 5 C# scheduler.
- **win-arm64 + Windows Server** declared/supported (ADR-013): arm64 cross-builds clean (~195MB, not yet
  ARM-run-verified); no OS-version gate; Server 2016+ Desktop Experience supported, Server Core not.
- **Security posture set to permissive (ADR-015):** isolated-VM target, never sacrifice a feature. Box
  switched to `appium --relaxed-security`; **re-verified e2e 74/74 + smoke 1/1 under relaxed-security** —
  every feature (powershell/file) usable with one flag, gates pass, nothing blocked.
- **Docs pass:** added `docs/README.md` index; rewrote `SUBAGENTS.md` to the real orchestration model;
  marked the Phase 0–1 plan completed; `PARITY.md` flagged historical.

---

## 2026-06-03 (cont.) — W3C suite 69/69 GREEN + Win32 robust window foregrounding

Closed the 5 input/focus failures with a real capability (not a test hack): a new `window action:
"foreground"` in the sidecar using **Win32 `SetForegroundWindow` + `AttachThreadInput`** (beats the
foreground-lock) on the SESSION's own HWND (`sidecar/Win32.cs`), exposed as `windows: setWindowForeground`
and `driver.windowsCmd_setWindowForeground()`. The test helper `bringToFront` now uses it (HWND-based,
unambiguous) instead of process-name activation. **Full W3C e2e suite: 69 passing / 0 failing** on the
Windows box; smoke 1/1; 110 unit tests. (Also: clean-publish must kill any running FlaUiSidecar.exe first —
single-file publish locks on the output exe → MSB4018.)

---

## 2026-06-03 (cont.) — own W3C-first conformance suite (smoke + e2e) + title() routing fix

Built the driver's OWN test suite (subagent; cut off by a session limit mid-run, work preserved & verified
by the orchestrator):
- `tests/lib/w3c-client.ts` (raw fetch W3C client, returns `{status,value,error}`) + `helpers.ts`
  (SessionPool self-cleanup, OS-independent `findEditable`/`findWindow`, PNG/XML assert helpers).
- `tests/smoke/smoke.e2e.spec.ts` — critical path (status→session→find→source→screenshot→value→delete).
- `tests/e2e/01..09` — W3C-conformance-checklist titles: session, find, element, source+screenshot,
  window, actions, extensions, files+powershell, errors. Env-driven (`APPIUM_URL`/`TARGET_APP`),
  no OS-version selectors, protocol-exact (HTTP status + `value.error`).
- npm scripts `test:smoke`, `test:e2e:w3c`.
- **Driver fix:** W3C `GET /session/:id/title` routes to command name `title` (not `getTitle`) — added
  `title()` (getTitle kept as alias).

**Verified on the Windows box:** smoke **1/1**; e2e **64 passing**. The 5 "failures" are all input/focus
assertions (click/actions/keys → HasKeyboardFocus/value) — they **PASS when their files run in isolation
right after a fresh Appium start**, and fail only in the full back-to-back run. Root cause is the
interactive-desktop foreground contention across sequential sessions (real SendInput needs the target
window foregrounded on an active desktop), NOT a driver defect — UIA-only ops (find/setValue/source) pass
throughout. Hardening the input specs to foreground the window before asserting focus is the follow-up.

---

## 2026-06-03 (cont.) — pullFile/pushFile/pullFolder + image clipboard (subagent, all VERIFIED)

- **File transfer** (insecure features `flauinative:pull_file`/`push_file`): new `file` op — pull→base64,
  push→write+mkdirs, pullFolder→ZIP(base64). Exposed via the standard appium endpoints
  (`/appium/device/pull_file` etc.) AND `execute('pullFile'|...)`. Verified roundtrip + PK-zip magic +
  clean missing-file error on the Windows box.
- **Image clipboard is REAL**: `sidecar/ClipboardImage.cs` — Win32 P/Invoke (CF_DIB) + System.Drawing
  PNG↔DIB, no WinForms (works under the Web SDK), runs on the STA worker. Plaintext + image roundtrips PASS.
- Unit tests 107 → **110**; `e2e-notepad.mjs` regression: PASS.
- **Operational finding:** Appium 3's `--allow-insecure` CLI flag does NOT parse multiple scoped features
  (comma/space forms break; repeated flags keep only the last). Use an Appium **config file** instead —
  the box now runs `appium --config C:\Users\admin\appium-config.json` with
  `"allow-insecure": ["flauinative:power_shell","flauinative:pull_file","flauinative:push_file"]`.

---

## 2026-06-03 (cont.) — Head-to-head COMPLETE on core nova2 suites: parity or better on every one

Two more real bugs found & fixed via the suites:
1. **Error-type mapping was missing**: sidecar `RpcError`s surfaced as 500 UnknownError. Added a central
   `op()` helper in the driver converting backend error types → appium error classes (stale element / no
   such element / invalid selector / timeout). smoke_more jumped 7→19 passing.
2. **Unknown vs stale element ids**: never-seen/malformed ids now raise `no such element`; well-formed
   runtime ids that aged out raise `stale element reference` (nova2 semantics; fixes click C3).

**Final head-to-head (same box, same Appium 3.5 server, the user's real nova2 specs):**
| suite | novawindows2 | FlaUINative |
|---|---|---|
| smoke (5) | 4 pass / 1 fail | 4 / 1 (same wdio client-bug test) |
| pagesource (1) | – | **1 / 0** |
| xpath (98) | 85 / 13 (~3 min) | **93 / 5 (25 s)** |
| smoke_more (20) | 18 / 1 (+1 pending) | **19 / 1** (same Win11-Notepad selector fail) |
| click (14) | 6 / 6 (+2 pending) | **6 / 6 (+2)** — identical failure set (Win11 Notepad UI) |

FlaUINative ≥ nova2 on every suite; every remaining failure is shared (test/client/environment, not the
driver). The user can now run their real nova2 e2e suite against FlaUINative via
`tests/nova2-compat/` with `APPIUM_URL=<server>`. Remaining unrun: the stable/* suites (desktop, stress,
session-stress, unicode, ...) — next session.

---

## 2026-06-03 (cont.) — 🏆 nova2's REAL e2e suite runs — FlaUINative BEATS nova2 on its own tests

The user's actual nova2 e2e suite was copied into `tests/nova2-compat/` (automationName → FlaUINative,
ESM `__dirname` shim) and run FROM THE MAC against Appium on the Windows box (appium bound to 0.0.0.0,
firewall 4723 opened, run via Task Scheduler interactive session).

**XPath engine completed by subagent (full nova2 parity):** 13 axes, all 24 core functions, numeric/
arithmetic operators, `@*`, aliases, positional semantics, `(x)[n]` vs `x[n]` — 107/107 unit tests.
Wired into the driver via the new `XPathBackend` (find + walk + attributes), with nova2's
`includeContextElementInSearch:true` semantics (descendants→subtree) and C#-style `"True"/"False"`
attribute strings. Sidecar `BuildProperty` extended to all 21 allowlisted UIA properties (typed values);
engine `InvalidSelectorError` now maps to the W3C invalid-selector error.

**Results (same server, same tests, head-to-head):**
| suite | novawindows2 | FlaUINative |
|---|---|---|
| smoke (5) | 4 pass / 1 fail | 4 pass / 1 fail (same failing test = wdio v9 `.elementId` client bug) |
| xpath (98) | 85 pass / 13 fail, ~3 min | **93 pass / 5 fail, 25 s** |

All 5 FlaUINative xpath failures are in nova2's failure set too (test/client/env issues: page-source
`Name=` regex hitting `ClassName=`, wdio `.elementId`, `'InvalidSelector'` substring check that even
nova2's own error message fails). Every test where the drivers differ: FlaUINative passes, nova2 fails
(`@IsOffscreen="False"`, `@ProcessId > 0`, `>`, `>=`, `[1]`, `[last()]`, `[position()=1]`, NoSuchElement).

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
