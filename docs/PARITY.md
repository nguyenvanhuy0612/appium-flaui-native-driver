# Parity Matrix — novawindows2 → FlaUINative

What `appium-novawindows2-driver` exposes vs what `appium-flaui-native-driver` implements today.
Legend: ✅ implemented & **verified on real Windows** · 🟡 implemented, not yet live-verified · ⬜ not yet · ⛔ intentionally dropped (ADR).

_Last updated 2026-06-03._

## W3C / standard driver commands

| nova2 command | FlaUINative | Notes |
|---|---|---|
| createSession | ✅ | spawns C# sidecar, attaches app |
| deleteSession | ✅ | stops sidecar |
| findElOrEls | ✅ | strategies below |
| getPageSource | ✅ | full nova2 schema: all UIA attrs, x/y relative to root, Window/Transform pattern attrs; rawView pending |
| getAttribute | ✅ | UIA props + `Value` (ValuePattern) |
| setValue | ✅ | ValuePattern.SetValue |
| clear | ✅ | setValue "" |
| click | 🟡 | maps to UIA Invoke (real pointer click = Phase 5) |
| execute | ✅ | routes `windows:` via executeMethodMap |
| getText | ✅ | ValuePattern.Value ?? Name |
| getName | 🟡 | → Name |
| getElementRect | ✅ | BoundingRectangle |
| elementEnabled | ✅ | IsEnabled |
| elementDisplayed | ✅ | !IsOffscreen |
| elementSelected | ✅ | SelectionItem.IsSelected (false when pattern unsupported) |
| getProperty | 🟡 | alias of getAttribute |
| getScreenshot | ⬜ | UIA/GDI capture (later) |
| getElementScreenshot | ⬜ | later |
| getWindowRect | ⬜ | later |
| active (activeElement) | ⬜ | → FocusedElement (later) |
| performActions / releaseActions | ⬜ | W3C Actions / input (Phase 5) |
| pullFile / pushFile / pullFolder | ⬜ | scoped insecure feature (ADR-008), later |

## Locator strategies

| nova2 | FlaUINative |
|---|---|
| accessibility id | ✅ |
| name | 🟡 (implemented) |
| class name | ✅ |
| xpath | ✅ (subset; reverse axes & predicate fns pending) |
| id | 🟡 (alias of AutomationId; same backend path as accessibility id) |
| tag name | ✅ (→ ControlType) |
| -windows uiautomation | ⬜ (raw JSON condition, ADR-006 — later) |

## `windows:` execute commands (nova2 has 35)

**Implemented (19):** invoke, expand, collapse, toggle, select, addToSelection, removeFromSelection,
setFocus, scrollIntoView, **setValue ✅**, maximize, minimize, restore, close (🟡), plus reads:
**getValue ✅**, isMultiple 🟡, selectedItem 🟡, allSelectedItems 🟡, getAttributes 🟡.

**Not yet (16):**
- *Input (Phase 5, needs Win32/koffi or sidecar input):* keys, click, hover, scroll, clickAndDrag, typeDelay.
- *Clipboard:* getClipboard, setClipboard.
- *App/window/process:* launchApp, closeApp, setProcessForeground.
- *Session scoping:* cacheRequest, scopeSession, resetSessionRoot.
- *Recording (scoped insecure):* startRecordingScreen, stopRecordingScreen.

## execute() special scripts (nova2)

| nova2 | FlaUINative |
|---|---|
| `powershell` | ⛔ dropped (ADR-007 — this driver's whole point is no PowerShell) |
| pullFile / pushFile / pullFolder | ⬜ later (scoped insecure) |

## Capabilities

| nova2 cap | FlaUINative | Notes |
|---|---|---|
| platformName | ✅ | |
| app (implicit) | ✅ | |
| appTopLevelWindow | ✅ | attach by hex HWND — verified via detach/re-attach E2E flow |
| appArguments / appWorkingDir | 🟡 | passed to ProcessStartInfo |
| shouldCloseApp | ✅ | verified: false keeps app open across sessions; true closes (launched app or attached window) |
| ms:waitForAppLaunch / ms:forcequit | ⬜ | later |
| convertAbsoluteXPathToRelativeFromElement | ⬜ | xpath option (later) |
| includeContextElementInSearch | ⬜ | xpath option (later) |
| releaseModifierKeys / typeDelay / smoothPointerMove / delayBeforeClick / delayAfterClick | ⬜ | input-related (Phase 5) |
| prerun / postrun / isolatedScriptExecution / powerShellCommandTimeout / treatStderrAsError | ⛔ | PowerShell-specific (ADR-007) |
| flaui:backend | ✅ (new) | uia3/uia2 |

## Summary

Core session + find (incl. tag name) + page source + the read/write element surface (setValue/clear/
getAttribute/getText/rect/enabled/displayed/selected) + execute (`windows:` setValue/getValue) are
**verified on real Windows**. Remaining gaps: (a) input (keys/click/hover/scroll/clickAndDrag — Phase 5);
(b) clipboard, app-lifecycle (launchApp/closeApp/setProcessForeground), session scoping (cacheRequest/
scopeSession/resetSessionRoot); (c) screenshots + recording; (d) attach-to-window capabilities
(`appTopLevelWindow`, `appArguments`, `shouldCloseApp`, ...); (e) page-source schema parity + rawView;
(f) `-windows uiautomation` raw-condition strategy. PowerShell-only features are intentionally not ported.

**Done since:** (d) attach caps (`appTopLevelWindow` ✅, `shouldCloseApp` ✅, `appArguments`/`appWorkingDir` 🟡)
and (e) page-source schema parity (full attribute set, relative coords, pattern attrs) — both E2E-verified.

**Next (decided):** the input layer (Phase 5: keys/click/hover/scroll/clickAndDrag + W3C Actions), then
screenshots, rawView, `-windows uiautomation`, win-arm64, and the real frozen-app anti-hang test (Phase 4).
