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
| getScreenshot | ✅ | FlaUI Capture → PNG base64 |
| getElementScreenshot | ✅ | FlaUI Capture.Element → PNG base64 |
| getWindowRect | ⬜ | later |
| active (activeElement) | ⬜ | → FocusedElement (later) |
| performActions / releaseActions | ✅ | subset: sequential sources, mouse pointer (move/down/up, element-center origin), keys (specials via VK, printables typed on keyDown) |
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
(FlaUI.Core.Input, ADR-005 rev.1): **keys ✅**, **click ✅**, **hover ✅**, **scroll ✅**, clickAndDrag 🟡,
plus **getClipboard ✅ / setClipboard ✅** (plaintext base64; image content: later).

**Implemented since (app/session):** launchApp 🟡, closeApp 🟡, setProcessForeground 🟡, typeDelay 🟡
(advisory), cacheRequest 🟡 (accepted no-op), getPageSource(element) 🟡.

**Not yet (2):** scopeSession, resetSessionRoot.

**⏸ Dropped for now (user decision 2026-06-03):** startRecordingScreen, stopRecordingScreen (ffmpeg).

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

**Verified on real Windows:** session lifecycle (launch + attach/`shouldCloseApp`), find (a11y id/class/
tag/xpath), page source (full nova2 schema), element read/write (setValue/clear/getAttribute/getText/rect/
enabled/displayed/selected), real input (click/keys/scroll/hover), **W3C Actions API** (pointer + key
subset), **screenshots** (root + element, PNG base64), **clipboard** (plaintext), and the `windows:`
execute surface (setValue/getValue verified; 24/35 commands implemented).

**Remaining gaps:** (a) `windows:` typeDelay, app-lifecycle (launchApp/closeApp/setProcessForeground),
session scoping (cacheRequest/scopeSession/resetSessionRoot), recording ×2; (b) W3C getWindowRect, active,
pull/pushFile; (c) rawView page source + `-windows uiautomation` raw-condition strategy; (d) input-related
caps (typeDelay/smoothPointerMove/delays); (e) the real frozen-app anti-hang test (Phase 4) and win-arm64
binary. PowerShell-only features are intentionally not ported (ADR-007).
