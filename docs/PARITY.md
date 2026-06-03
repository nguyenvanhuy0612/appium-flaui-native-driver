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
| getPageSource | ✅ | XML nests correctly; schema parity w/ nova2 still pending |
| getAttribute | ✅ | UIA props + `Value` (ValuePattern) |
| setValue | ✅ | ValuePattern.SetValue |
| clear | ✅ | setValue "" |
| click | 🟡 | maps to UIA Invoke (real pointer click = Phase 5) |
| execute | ✅ | routes `windows:` via executeMethodMap |
| getText | ⬜ | → ValuePattern.Value ?? Name (next batch) |
| getName | ⬜ | → Name (next batch) |
| getElementRect | ⬜ | → BoundingRectangle (next batch) |
| elementEnabled | ⬜ | → IsEnabled (next batch) |
| elementDisplayed | ⬜ | → !IsOffscreen (next batch) |
| elementSelected | ⬜ | → SelectionItem.IsSelected (next batch) |
| getProperty | ⬜ | alias of getAttribute |
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
| id | ⬜ (alias of AutomationId — next batch) |
| tag name | ⬜ (→ ControlType — next batch) |
| -windows uiautomation | ⬜ (raw JSON condition, ADR-006 — later) |

## `windows:` execute commands (nova2 has 35)

**Implemented (14, 🟡 except setValue ✅):** invoke, expand, collapse, toggle, select, addToSelection,
removeFromSelection, setFocus, scrollIntoView, **setValue ✅**, maximize, minimize, restore, close.

**Not yet (21):**
- *Reads (easy, next batch):* getValue, isMultiple, selectedItem, allSelectedItems, getAttributes.
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
| appTopLevelWindow | ⬜ | attach-to-window (next batch — sidecar supports the idea) |
| appArguments / appWorkingDir | ⬜ | next batch |
| shouldCloseApp | ⬜ | next batch |
| ms:waitForAppLaunch / ms:forcequit | ⬜ | later |
| convertAbsoluteXPathToRelativeFromElement | ⬜ | xpath option (later) |
| includeContextElementInSearch | ⬜ | xpath option (later) |
| releaseModifierKeys / typeDelay / smoothPointerMove / delayBeforeClick / delayAfterClick | ⬜ | input-related (Phase 5) |
| prerun / postrun / isolatedScriptExecution / powerShellCommandTimeout / treatStderrAsError | ⛔ | PowerShell-specific (ADR-007) |
| flaui:backend | ✅ (new) | uia3/uia2 |

## Summary

Core session + find + page source + read/setValue/clear are **verified on real Windows**. The biggest gaps
are: (a) the common W3C read commands (getText/getElementRect/element{Enabled,Displayed,Selected}); (b) the
`id`/`tag name` locator strategies; (c) the read-style `windows:` commands (getValue/isMultiple/selection);
(d) input (keys/click/hover/scroll — Phase 5); (e) clipboard/app-lifecycle/recording. PowerShell-only
features are intentionally not ported.

**Next batch (decided):** close (a)+(b)+(c) — all map directly to UIA properties/patterns, are high-value,
and are verifiable on Notepad without the Win32 input layer.
