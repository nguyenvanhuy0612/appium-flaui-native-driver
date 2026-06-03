# Implemented Functions — appium-flaui-native-driver

Complete inventory of what the driver implements today.
Legend: ✅ implemented & **verified on the real Windows box** (own E2E and/or nova2's real suite) ·
🟡 implemented, not yet individually verified · ⏸ deferred by decision.

_Last updated 2026-06-03. Source of truth for gaps: [PARITY.md](./PARITY.md)._

---

## 1. Capabilities

| Capability | Status | Behavior |
|---|---|---|
| `platformName` | ✅ | must be `Windows` |
| `appium:automationName` | ✅ | `FlaUINative` |
| `appium:app` | ✅ | exe path to launch, or **`Root`** for a desktop-tree session |
| `appium:appTopLevelWindow` | ✅ | attach to an existing window by hex HWND (verified detach/re-attach flow) |
| `appium:appArguments` / `appium:appWorkingDir` | 🟡 | passed to `ProcessStartInfo` |
| `appium:shouldCloseApp` | ✅ | default `true`; `false` keeps the app alive across sessions; close works for launched apps (Close()) and attached windows (WindowPattern) |
| `flaui:backend` | ✅/🟡 | `uia3` (default, verified) / `uia2` (wired, not yet verified) |
| `ms:waitForAppLaunch` | ✅ | sleeps N seconds after launch |
| `appium:prerun` | ✅ | `{script}` runs via PowerShell at session start (needs `--allow-insecure=flauinative:power_shell`) |
| nova2 advisory caps | ✅ accepted | `powerShellCommandTimeout`, `treatStderrAsError`, `postrun`, `typeDelay`, `smoothPointerMove`, `delayBeforeClick/AfterClick`, `releaseModifierKeys`, `convertAbsoluteXPathToRelativeFromElement`, `isolatedScriptExecution`, `ms:forcequit` — accepted so nova2 suites run; currently no-ops |
| `appium:includeContextElementInSearch` | ✅ | default `true` — finds include the context element itself (nova2 semantics) |

## 2. Locator strategies

| Strategy | Status | Maps to |
|---|---|---|
| `accessibility id` | ✅ | AutomationId |
| `id` | ✅ | AutomationId (nova2 alias) |
| `name` | ✅ | Name |
| `class name` | ✅ | ClassName |
| `tag name` | ✅ | ControlType (e.g. `Button`, `Document`) |
| `xpath` | ✅ | **Full XPath 1.0** (below) |
| `-windows uiautomation` | ⬜ | raw JSON condition — not yet |

### XPath 1.0 engine (93/98 on nova2's own xpath suite vs nova2's 85/98)
- **Axes (13):** child, descendant, descendant-or-self, self, parent, ancestor, ancestor-or-self,
  following-sibling, preceding-sibling, following, preceding, attribute, namespace(∅).
- **Functions (24):** contains, starts-with, string, concat, substring, substring-before/-after,
  string-length, normalize-space, translate, count, last, position, name, local-name, boolean, not,
  true, false, number, floor, ceiling, round, sum.
- **Operators:** `= != < <= > >=`, `+ - * div mod`, `and/or/not()`, `@*` wildcard, unions `|`.
- **21 attribute predicates** (Name, AutomationId, ClassName, IsEnabled, IsOffscreen, ProcessId, …) pushed
  to native UIA conditions with typed values; function predicates evaluated TS-side over bulk attributes.
- Positional semantics (`//X[1]` per-parent vs `(//X)[1]` grouped, `last()`, `position()`),
  lowercase/control-type aliases (`//button`, `list`→List|DataGrid, appbar/semanticzoom),
  `//text()`→empty, malformed → W3C `invalid selector`.

## 3. W3C standard commands

| Group | Commands | Status |
|---|---|---|
| Session | createSession, deleteSession, /status | ✅ |
| Find | findElement, findElements, findElementFromElement, findElementsFromElement (context-scoped) | ✅ |
| Element write | click (**real pointer click** at center), setValue/sendKeys (ValuePattern), clear | ✅ |
| Element read | getText (Value??Name), getAttribute (UIA props + `Value`, `IsSelected`, `BoundingRectangle`, `NativeWindowHandle`, `HasKeyboardFocus`…), getProperty, getName (**tag**/ControlType), getElementRect | ✅ |
| Element state | elementEnabled, elementDisplayed, elementSelected | ✅ |
| Source | getPageSource — **full nova2 XML schema** (all UIA attrs, x/y relative to root, Window/Transform pattern attrs), correctly nested DFS | ✅ |
| Screenshots | getScreenshot (session root), getElementScreenshot — PNG base64 via FlaUI Capture | ✅ |
| Window | getTitle, getWindowHandle, getWindowHandles, getWindowRect, setWindowRect (TransformPattern), maximizeWindow, minimizeWindow | ✅ |
| Actions | performActions — pointer (move/down/up; viewport/pointer/element-center origins) + key (specials→VK map, printables on keyDown) + pause; releaseActions | ✅ |
| Execute | execute(script, args) → `windows:` commands & `powershell` | ✅ |

**Error surface (W3C-correct):** `no such element` (incl. never-seen/malformed ids), `stale element
reference` (aged-out runtime ids), `invalid selector`, `timeout`, `unknown error` — all mapped from the
sidecar through appium error classes (proper 404/400 status codes).

## 4. `windows:` execute commands (30)

| Group | Commands | Status |
|---|---|---|
| UIA patterns (write) | invoke, expand, collapse, toggle, select, addToSelection, removeFromSelection, setFocus, scrollIntoView, **setValue ✅**, maximize, minimize, restore, close | ✅ setValue; others 🟡 |
| UIA patterns (read) | **getValue ✅**, isMultiple, selectedItem, allSelectedItems, getAttributes | ✅/🟡 |
| Real input (FlaUI.Core.Input) | **keys ✅** (text + virtualKeyCode down/up + pause), **click ✅** (element/coords, button, times), **hover ✅**, **scroll ✅** (deltaX/Y), clickAndDrag 🟡 | ✅ |
| Clipboard | **setClipboard ✅ / getClipboard ✅** (plaintext base64; accepts nova2's `b64Content`) | ✅ |
| App / session | launchApp (re-roots session), closeApp, setProcessForeground (by process name), typeDelay (advisory), cacheRequest (accepted no-op), getPageSource (element-scoped) | 🟡 |

All element commands accept both `{elementId}` and the W3C element-key object (nova2 client style).

## 5. Special execute scripts

| Script | Status | Notes |
|---|---|---|
| `powershell` | ✅ | `execute('powershell', {script})` → stdout. Gated as insecure feature `flauinative:power_shell`; runs outside the UIA watchdog so long scripts don't time out |
| pullFile / pushFile / pullFolder | ⬜ | later (scoped insecure) |

## 6. Stability architecture (the driver's core promise)

- Five-layer anti-hang: UIA3 Connection/TransactionTimeout → per-op watchdog (fail fast, session lives) →
  worker-thread poisoning & replacement → serial queue/backpressure → sidecar recycle. Watchdog + poisoning
  proven by unit tests; full frozen-app E2E still planned (Phase 4).
- Self-contained sidecar exe (no .NET/SDK/Dev-Mode for end users), stdout port handshake, stdin-EOF
  heartbeat (no orphan processes), W3C error envelopes at every boundary.

## 7. Verified against the user's REAL nova2 e2e suite (head-to-head, same box & server)

| suite | novawindows2 | FlaUINative |
|---|---|---|
| smoke (5) | 4/1 | 4/1 (same client-bug fail) |
| pagesource (1) | – | 1/0 |
| xpath (98) | 85/13 (~3 min) | **93/5 (25 s)** |
| smoke_more (20) | 18/1 | **19/1** |
| click (14) | 6/6 (+2 pending) | 6/6 (+2) — identical failure set |

## 8. Not implemented (and why)

| Item | Status |
|---|---|
| startRecordingScreen / stopRecordingScreen | ⏸ **dropped for now — user decision 2026-06-03** (would need ffmpeg) |
| `powershell`-based nova2 internals (`$elementTable` scripts) | ⛔ impossible by design (no PS backend) |
| prerun/postrun-as-backbone, PS-specific caps | ⛔ ADR-007 |
| `-windows uiautomation` raw-condition strategy | ⬜ |
| pull/pushFile/pullFolder | ⬜ |
| rawView page source | ⬜ |
| `active` (focused element), getDeviceTime | ⬜ |
| win-arm64 prebuilt binary | ⬜ (publish script ready; needs an ARM build run) |
| typeDelay/smoothPointerMove/delay* effects | ⬜ (caps accepted, no effect yet) |
| Real frozen-app anti-hang E2E + 30-min session-stress | ⬜ (Phase 4 / stable suites) |
