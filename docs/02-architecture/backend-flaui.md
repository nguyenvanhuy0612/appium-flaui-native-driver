# The FlaUI / UIA3 Engine

*Architecture · updated 2026-06-05*

> **Layer:** the backend automation library. This doc (1) introduces FlaUI, (2) catalogs what FlaUI
> provides and how much of it this driver uses, and (3) details how the sidecar wires it. For the
> two-process picture see [architecture overview](./overview.md); for the wire-level op/action names see
> [RPC protocol](../03-reference/rpc-protocol.md); for the open gaps see [known issues](../04-design/known-issues.md).
>
> **Utilization legend:** ✅ used by the driver · 🟡 partial (read-only, or only as a side effect) · ⬜ available in FlaUI, not used.

---

## 1. What is FlaUI

[**FlaUI**](https://github.com/FlaUI/FlaUI) is an open-source **.NET wrapper around Microsoft UI Automation
(UIA)** — the Windows accessibility/automation API every modern Windows app exposes. It is the maintained
successor to the older *White* project and is the de-facto library for native Windows UI automation in .NET.

FlaUI speaks **both UIA backends** and the legacy bridge:

- **UIA3** — the modern **COM** `UIAutomationCore` client. **The sidecar's default** (`flaui:backend: uia3`):
  strongly typed, supports modern WPF/UWP/WinUI/touch controls, has the `ConnectionTimeout` /
  `TransactionTimeout` anti-hang knobs and `CacheRequest` batching.
- **UIA2** — the managed `System.Windows.Automation` client (what a PowerShell `System.Windows.Automation`
  script uses). Selectable via `flaui:backend: uia2`, but experimental here — the layer-1 timeouts don't apply.
- **MSAA / IAccessible** — older accessibility API, reached through the `LegacyIAccessible` pattern (so very
  old Win32 controls still expose `Role`/`State`/`Value`).

### Core objects (FlaUI's vocabulary)

| Object | What it is |
|---|---|
| `AutomationBase` (`UIA3Automation` / `UIA2Automation`) | The engine/entry point. Owns `GetDesktop()`, `FromHandle()`, `FromPoint()`, `FocusedElement()`, the `PropertyLibrary`/`PatternLibrary`, `TreeWalkerFactory`, `ConditionFactory`, and the `ConnectionTimeout`/`TransactionTimeout` settings. |
| `AutomationElement` | One node in the UIA tree. Exposes `.Properties.*` (Name, ControlType, …), `.Patterns.*` (typed control behaviours), `.FindFirst/FindAll[…]`, convenience clicks, `.Focus()`, `.Capture()`, `.DrawHighlight()`. |
| **Patterns** | Typed *control behaviours* a UIA element may support — Invoke (press), Value (get/set text), Window (min/max/close), Selection, ExpandCollapse, etc. You ask an element for a pattern; `null` if unsupported. |
| `ConditionFactory` + `TreeScope` | The search language: build a condition (by name/type/id/…) and a scope (element/children/descendants/subtree), pass to `FindFirst`/`FindAll`. |
| `TreeWalkerFactory` | Navigate the tree in a chosen *view* — Control / Content / Raw — for parent/child/sibling moves UIA's `TreeScope` can't express. |
| `Input` (`Mouse`, `Keyboard`, `Touch`) | Real OS-level input via `SendInput`. |
| `Capture`, `VideoRecorder` | Screenshots (element / screen / region) and ffmpeg-backed screen recording. |
| `Application` | Launch / attach to a process and find its windows (`Launch`, `LaunchStoreApp`, `Attach`, `GetMainWindow`, `Close`, `Kill`). |
| `CacheRequest` | Batch many property/pattern reads of a subtree into one cross-process call. |

The sidecar instantiates **one `UIA3Automation`** and runs every call on a **single serialized STA worker**
(so a frozen app can be bounded/killed without wedging the server — see [stability](./stability.md)).

---

## 2. What FlaUI provides — capability catalog

Everything FlaUI offers, grouped, with this driver's **utilization** (✅ / 🟡 / ⬜). The detailed mechanics of
the ✅/🟡 rows are in [§3](#3-how-the-driver-uses-it-details).

### 2.1 Automation entry points
| FlaUI | Purpose | Driver |
|---|---|---|
| `GetDesktop()` | the root desktop element | ✅ `app:'Root'` + outermost-window resolution |
| `FromHandle(hwnd)` | element from a window handle | ✅ `appTopLevelWindow` |
| `FromPoint(x,y)` | element under a screen point | ⬜ |
| `FocusedElement()` | the currently-focused element | ⬜ |
| `ConnectionTimeout` / `TransactionTimeout` | bound a single UIA COM call | ✅ anti-hang layer 1 (UIA3 only) |
| `PropertyLibrary` / `PatternLibrary` | enumerate available properties/patterns | ✅ (drives the generic `Is*PatternAvailable`) |

### 2.2 Finding elements & conditions
| FlaUI | Purpose | Driver |
|---|---|---|
| `FindFirst` / `FindAll(scope, condition)` | search by condition + scope | ✅ the `find` op |
| `FindFirstChild` / `FindAllChildren` | direct-child search | ✅ page source + walk |
| `ConditionFactory` (`ByName`, `ByControlType`, `ByAutomationId`, `ByClassName`, `ByText`, `ByProcessId`, …) | typed property conditions | ✅ ~21 properties (see §3.2) |
| `.And()` / `.Or()` / `.Not()` / `TrueCondition` | boolean composition | ✅ |
| `FindFirstByXPath` / `FindAllByXPath` | FlaUI's built-in XPath | 🟡 the driver ships its **own** XPath 1.0 engine (13 axes/24 functions) compiled down to conditions + the tree walker, so FlaUI's XPath is not used directly |
| `TreeScope` (`Element`, `Children`, `Descendants`, `Subtree`, `Parent`, `Ancestors`) | search breadth | ✅ first four (`ParseScope`) |

### 2.3 Tree navigation (views)
| FlaUI `TreeWalkerFactory` | Driver |
|---|---|
| `GetControlViewWalker()` | ✅ walk (parent/ancestors/siblings) + page source + top-level-window |
| `GetContentViewWalker()` | ⬜ (would give a more concise page source) |
| `GetRawViewWalker()` | ⬜ (would back `source rawView:true` — accepted but currently ignored) |
| `GetCustomTreeWalker(condition)` | ⬜ |

### 2.4 UIA patterns
FlaUI exposes the full UIA pattern set; this driver's wiring is in the table in [§3.1](#31-uia-patterns--wiring-status).
At a glance: **wired ✅** Invoke, Toggle, ExpandCollapse, Value, Selection, SelectionItem, ScrollItem, Window,
Transform; **read-only 🟡** RangeValue, Scroll, Dock, Grid, GridItem, Text, LegacyIAccessible; **unused ⬜**
Table/TableItem, MultipleView, VirtualizedItem, ItemContainer, Text2/TextChild/TextEdit, Annotation, Drag/
DropTarget, Spreadsheet/SpreadsheetItem, Styles, SynchronizedInput, CustomNavigation, ObjectModel, Transform2.

### 2.5 Input
| FlaUI `FlaUI.Core.Input` | Driver |
|---|---|
| `Mouse` (`MoveTo`, `Click`, `DoubleClick`, `Down`/`Up`, `Drag`, `Scroll`/`HorizontalScroll`) | ✅ (click/hover/scroll/clickAndDrag/down/up/move) |
| `Keyboard` (`Type`, `Press`/`Release` by `VirtualKeyShort`) | ✅ (keys + modifier handling + setValue fallback) |
| `Touch` (`Tap`, `Hold`, `Drag`, `Pinch`, `Rotate`) | ⬜ multi-touch gestures |

### 2.6 Capture
| FlaUI | Driver |
|---|---|
| `Capture.Element(el)` | ✅ element + (whole-root) screenshots |
| `Capture.Screen` / `MainScreen` / `Rectangle` / `ScreensWithElement` | ⬜ multi-monitor / arbitrary-region |
| `CaptureImage.ApplyOverlays(...)` (cursor/highlight overlays) | ⬜ |
| `VideoRecorder` (ffmpeg screen recording) | ⬜ **out of scope** (ADR-012) |

### 2.7 Application lifecycle
| FlaUI `Application` | Driver |
|---|---|
| `Launch(psi)` | ✅ `app:<path>` |
| `Attach(pid)` / `Attach(Process)` | ✅ single-instance fallback + `processName` resolution |
| `GetMainWindow()` / `GetAllTopLevelWindows()` | ✅ (root resolution) |
| `Close(killIfFails)` / `Kill()` | ✅ teardown (bounded grace→Kill) |
| `LaunchStoreApp(aumid)` | ⬜ UWP-by-AUMID launch |
| `WaitWhileBusy()` / `WaitWhileMainHandleIsMissing()` | ⬜ (we poll for the window ourselves) |

### 2.8 Performance & debugging helpers
| FlaUI | Driver |
|---|---|
| `CacheRequest` (+ `AutomationElementMode`, `Activate()`, `CachedChildren`) | ⬜ a property-only cache was tried for page source and **reverted (no speedup)** — the real win needs `CachedChildren` navigation; see [known issues](../04-design/known-issues.md) |
| `el.DrawHighlight(color, duration)` | ⬜ visual debug overlay |
| `el.WaitUntilEnabled()` / `WaitUntilClickable()` | ⬜ |
| Control wrappers (`el.AsButton()`, `AsTextBox()`, `AsComboBox()`, …) | ⬜ the sidecar uses patterns directly rather than the typed wrappers |

---

## 3. How the driver uses it (details)

This is the precise wiring, grounded in `sidecar/OpInterpreter.cs`, `PropertyResolver.cs`,
`PropertyResolverLogic.cs`, and `PageSourceBuilder.cs`.

### 3.1 UIA patterns — wiring status
"Wired" = reachable through the `action` / `attributes` / `find` / `source` ops. Reads are via
`PropertyResolver` dot-notation (any supported pattern's props are readable); the **action** columns reflect
what `OpInterpreter.Action` / `Window` / `Input` actually call. See [RPC protocol](../03-reference/rpc-protocol.md)
for the exact action names.

| Pattern | Wired actions | Wired reads | Status |
|---|---|---|---|
| **Invoke** | `Invoke()` | — | ✅ |
| **Toggle** | `Toggle()` | `ToggleState` | ✅ |
| **ExpandCollapse** | `Expand()`, `Collapse()` | `ExpandCollapseState` | ✅ |
| **Value** | `SetValue(string)` (keyboard fallback when read-only/absent) | `Value`, `IsReadOnly` | ✅ |
| **RangeValue** | none | `Value`, `Minimum`, `Maximum`, `SmallChange`, `LargeChange`, `IsReadOnly` | 🟡 |
| **Selection** | — | `CanSelectMultiple` (`isMultiple`), `Selection` (`selectedItem`/`allSelectedItems`), `IsSelectionRequired` | ✅ |
| **SelectionItem** | `Select()`, `AddToSelection()`, `RemoveFromSelection()` | `IsSelected`, `SelectionContainer` | ✅ |
| **Scroll** | none (only as an input side-effect) | `Horizontal/VerticalScrollPercent`, `…ViewSize`, `Horizontally/VerticallyScrollable` | 🟡 |
| **ScrollItem** | `ScrollIntoView()` (explicit + auto before point-resolve) | — | ✅ |
| **Window** | `SetWindowVisualState(Max/Min/Normal)`, `Close()` | `CanMaximize`, `CanMinimize`, `IsModal`, `IsTopmost`, `WindowVisualState`, `WindowInteractionState` | ✅ |
| **Transform** | `Move(x,y)`, `Resize(w,h)` (in `window setRect`, Win32 fallback) | `CanMove`, `CanResize`, `CanRotate` | ✅ |
| **Dock** | none | `DockPosition` | 🟡 |
| **Grid** | none | `RowCount`, `ColumnCount` | 🟡 |
| **GridItem** | none | `Row`, `Column`, `RowSpan`, `ColumnSpan`, `ContainingGrid` | 🟡 |
| **Text** | none | `DocumentRange.GetText(-1)` (powers `getText` / `Text`) | 🟡 |
| **LegacyIAccessible** | none (`DoDefaultAction`/`SetValue` unused) | 9 props incl. Role/State (§3.3) | 🟡 |
| **Table / TableItem** | none | none | ⬜ |
| **MultipleView**, **VirtualizedItem**, **ItemContainer** | none | none | ⬜ |
| **Text2 / TextChild / TextEdit / Annotation / Drag / DropTarget / Spreadsheet / Styles / SynchronizedInput / CustomNavigation / ObjectModel / Transform2** | none | none | ⬜ |

### 3.2 Conditions & tree scopes
`find` compiles a JSON condition tree into native UIA conditions via `ConditionFactory` +
`new PropertyCondition(...)`, composed with `.And()` / `.Or()` / `.Not()`; `"true"` → `TrueCondition.Default`.

**Condition properties usable in `find`** (`OpInterpreter.BuildProperty`, ~21): `AutomationId`, `Name`,
`ClassName`, `ControlType`, `LocalizedControlType`, `FrameworkId`, `HelpText`, `ItemStatus`, `ItemType`,
`AcceleratorKey`, `AccessKey`, `IsEnabled`, `IsOffscreen`, `IsKeyboardFocusable`, `IsPassword`,
`IsRequiredForForm`, `HasKeyboardFocus`, `IsContentElement`, `IsControlElement`, `ProcessId`, `RuntimeId`.
Values are coerced to the property's native type (bool, int, `ControlType` enum, `RuntimeId` as `int[]`).

**Tree scopes** (`ParseScope`): `element`→Element, `children`→Children, `descendants`→Descendants (default),
`subtree`→Subtree. **Walking** uses the **control-view** walker for `parent`/`ancestors`/`following-siblings`/
`preceding-siblings` (XPath reverse/sibling axes) and to climb to the nearest Window/Pane ancestor.
**Page source** is a **live** iterative DFS over `FindAllChildren()` (control view): tag = `ControlType`, the
full UIA property set + start-relative `x`/`y` + Window/Transform attributes.

### 3.3 Attributes resolvable via getAttribute
`PropertyResolver.Resolve` routes one name through four stages; permissive (unknown plausible name → `null`,
only malformed input throws). Backs `getAttribute`, `getProperty`, and the `"all"` dump.

- **Direct UIA properties (~29)** — `PropertyResolverLogic.DirectAttributeNames`: identity (`Name`,
  `ControlType`, `ClassName`, `AutomationId`, `FrameworkId`, `LocalizedControlType`), boolean state
  (`IsEnabled`, `IsOffscreen`, `HasKeyboardFocus`, `IsPassword`, `IsContentElement`, `IsControlElement`,
  `IsKeyboardFocusable`, `IsRequiredForForm`, `IsDialog`), metadata (`ProcessId`, `RuntimeId`, `AccessKey`,
  `AcceleratorKey`, `HelpText`, `ItemStatus`, `ItemType`, `Orientation`, `ProviderDescription`),
  `BoundingRectangle` → `{x,y,width,height}`, `NativeWindowHandle` → `0x…`, `ClickablePoint` → `{x,y}`.
- **Synthetic / precedence** — `Value` (Value pattern → Legacy), `Name` (→ Legacy when empty), `Text`
  (TextPattern → ValuePattern → Name → Legacy; always a string), `IsSelected` (SelectionItem).
- **LegacyIAccessible (MSAA, 9)** — `ChildId`, `DefaultAction`, `Description`, `Help`, `KeyboardShortcut`,
  `Name`, `Role`, `State`, `Value`; as `LegacyIAccessible.<Prop>` or `legacy<Prop>`. `Role`/`State` are
  inspect-style `"text (0xHEX)"`.
- **`Is*PatternAvailable` flags** — generic, from `automation.PatternLibrary.AllForCurrentFramework` +
  `el.IsPatternSupported(pid)`; inspect's transposed `"2"` spellings normalized.
- **Pattern dot-notation** — `<Pattern>.<Prop>` (e.g. `Value.Value`, `Window.CanMaximize`, `Grid.RowCount`)
  via reflection over the supported patterns in `PropertyResolver.PatternProperties`.

### 3.4 Input / Capture / Clipboard / Win32 escapes
| Concern | How |
|---|---|
| **Mouse** | `FlaUI.Core.Input.Mouse` — `MoveTo`/`Click`/`Down`/`Up`/`Scroll`/`Drag`; modifiers held around the op; point = clickable point or rect center (real SendInput → needs an interactive desktop) |
| **Keyboard** | `FlaUI.Core.Input.Keyboard` — `Type`/`Press`/`Release` by `VirtualKeyShort`; `setValue` keyboard fallback = Ctrl+A, Delete, type |
| **Capture** | `Capture.Element(el)` → PNG → base64 (element capture brings the window forward + 200 ms settle) |
| **Clipboard text / image** | `TextCopy.ClipboardService` (UTF-8) / `ClipboardImage` Win32 CF_DIB (PNG) — FlaUI/TextCopy are text-only |
| **Foreground / move-resize** | `Win32` P/Invoke — `Focus()` first, then `ForceForegroundStrong` (topmost toggle → min/restore); `Win32.MoveResize` when no `TransformPattern` |

---

## 4. Not yet wired (gaps)

FlaUI supports these; the driver does not (yet). Tracked + prioritized in
[known issues](../04-design/known-issues.md).

- **RangeValue.SetValue** — set sliders/spinners (read-only today).
- **Scroll pattern action** — `Scroll(h,v)` / `SetScrollPercent` (only mouse-wheel input scrolls).
- **Text selection / Text2** — `GetSelection`, `GetVisibleRanges`, `RangeFromPoint`, caret/annotation ranges.
- **Table/TableItem & Grid/GridItem actions** — `Grid.GetItem(row,col)`, headers, `RowOrColumnMajor`.
- **VirtualizedItem.Realize** / **ItemContainer.FindItemByProperty** — virtualized lists/grids.
- **MultipleView** — `SetCurrentView` (list↔details).
- **Dock action** (`SetDockPosition`), **Transform.Rotate / Transform2.Zoom**.
- **Touch gestures** — `Touch.Tap`/`Hold`/`Drag`/`Pinch`/`Rotate`.
- **CachedChildren page source** — the real page-source perf fix (a property-only `CacheRequest` was tried + reverted; see known issues).
- **Content / Raw view walkers** — concise source + `rawView`.
- **Store-app launch by AUMID**, **`FromPoint` / `FocusedElement`**, **DrawHighlight**, **multi-monitor `Capture`**.
