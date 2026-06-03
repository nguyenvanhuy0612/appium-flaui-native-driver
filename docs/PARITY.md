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
| click | ✅ | REAL pointer click at element center (verified: focuses the target); UIA Invoke stays as `windows: invoke` |
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

**Implemented (24):** invoke, expand, collapse, toggle, select, addToSelection, removeFromSelection,
setFocus, scrollIntoView, **setValue ✅**, maximize, minimize, restore, close (🟡), reads:
**getValue ✅**, isMultiple 🟡, selectedItem 🟡, allSelectedItems 🟡, getAttributes 🟡, and input
(FlaUI.Core.Input, ADR-005 rev.1): **keys ✅**, **click ✅**, **hover ✅**, **scroll ✅**, clickAndDrag 🟡.

**Not yet (11):**
- *Input options:* typeDelay.
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

**Done since:** (d) attach caps + (e) page-source schema parity + **the input layer** (windows: keys/click/
hover/scroll/clickAndDrag via FlaUI.Core.Input, and W3C `click` as a real pointer click) — all E2E-verified
except clickAndDrag (implemented, needs an observable scenario).

**Next (decided):** W3C `performActions` (Actions API), screenshots (`getScreenshot`/element), clipboard,
app-lifecycle (`launchApp`/`closeApp`/`setProcessForeground`), then rawView, `-windows uiautomation`,
recording, the real frozen-app anti-hang test (Phase 4), and win-arm64.
