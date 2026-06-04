# The FlaUI / UIA3 Engine

> **Layer:** backend internals — what the C# sidecar actually uses to drive Windows UI.
> For the high-level two-process picture see [architecture overview](./overview.md); for the wire-level
> op/action names this engine is reached through see [RPC protocol](../03-reference/rpc-protocol.md)
> (this doc does not restate op shapes); for not-yet-wired gaps see
> [known issues](../04-design/known-issues.md).

The sidecar's automation engine is **[FlaUI](https://github.com/FlaUI/FlaUI)** on **UI Automation v3
(UIA3)**. This doc is a reference for the engine surface the sidecar relies on: which attributes
`getAttribute` can resolve, which UIA patterns are wired for reads/actions, how `find` builds
conditions and walks the tree, the input/capture/clipboard/Win32 escapes, and what remains unwired.
Grounded in `sidecar/OpInterpreter.cs`, `sidecar/PropertyResolver.cs`,
`sidecar/PropertyResolverLogic.cs`, and `sidecar/PageSourceBuilder.cs`.

**Legend:** ✅ wired · 🟡 partial (read-only, or actioned only as a side effect) · ⬜ not wired.

---

## Why FlaUI / UIA3

A reference driver like nova2 drives UIA through **PowerShell + `System.Windows.Automation`** (the
managed **UIA2** client). FlaUI on **UIA3** (the COM `UIAutomationCore` client) is strictly more
capable: a **strongly-typed** C# API (`el.Patterns.Value.Pattern.Value`, `el.Properties.Name`), the
`ConnectionTimeout` / `TransactionTimeout` anti-hang knobs that UIA2-managed lacks, first-class support
for modern WPF / UWP / touch controls, `CacheRequest` batching, and the full typed UIA pattern set —
all in-process on a dedicated STA worker instead of per-call PowerShell marshaling. (UIA2 is still
selectable via `flaui:backend:uia2` but is experimental — the layer-1 timeouts don't apply.)

---

## Attributes resolvable via getAttribute

`PropertyResolver.Resolve` routes one requested name through four resolution stages, in order. It is
permissive: a plausible-but-unsupported name returns `null` (200 + null), only genuinely malformed
input throws. The same machinery backs `getAttribute`, `getProperty`, and the `"all"` dump.

### Category 1 — Direct UIA element properties (~29 names)

`PropertyResolverLogic.DirectAttributeNames` lists the directly-exposed properties. Most map straight
to `el.Properties.<X>.ValueOrDefault`; a few are formatted for inspect.exe parity.

| Representative name | Notes |
|---|---|
| `Name`, `ControlType`, `LocalizedControlType`, `ClassName`, `AutomationId`, `FrameworkId` | Identity/classification; enums stringified |
| `IsEnabled`, `IsOffscreen`, `IsKeyboardFocusable`, `HasKeyboardFocus`, `IsPassword`, `IsContentElement`, `IsControlElement`, `IsRequiredForForm`, `IsDialog` | Boolean state (`IsDialog` is `SafeBool`-guarded) |
| `ProcessId`, `RuntimeId`, `AccessKey`, `AcceleratorKey`, `HelpText`, `ItemStatus`, `ItemType`, `Orientation`, `ProviderDescription` | Misc metadata |
| `BoundingRectangle` | Returned as structured `{x,y,width,height}` (not `[object Object]`) |
| `NativeWindowHandle` | Formatted as `0x…` hex string |
| `ClickablePoint` | `{x,y}` via UIA `TryGetClickablePoint`, else null |

### Category 2 — Synthetic / precedence properties

These are not a single UIA read; the resolver composes them.

| Name | Resolution |
|---|---|
| `Value` | `ValuePattern.Value`, falling back to `LegacyIAccessible.Value` when UIA value is empty |
| `Name` | `Properties.Name`, falling back to `LegacyIAccessible.Name` when empty |
| `Text` | Precedence: `TextPattern.DocumentRange.GetText(-1)` → `ValuePattern.Value` → `Name` → `LegacyIAccessible.Value`; always returns a string |
| `IsSelected` | `SelectionItemPattern.IsSelected` |

### Category 3 — LegacyIAccessible (MSAA bridge, 9 props)

`PropertyResolverLogic.LegacyProps`: `ChildId`, `DefaultAction`, `Description`, `Help`,
`KeyboardShortcut`, `Name`, `Role`, `State`, `Value`. Accepted as the dotted `LegacyIAccessible.<Prop>`
form **or** the case-insensitive `legacy<Prop>` shorthand (e.g. `legacyValue`, `legacy.role`). `Role`
and `State` are stringified inspect-style as `"text (0xHEX)"` via Oleacc text + raw hex. The `"all"`
dump keys these as `LegacyIAccessible.<Prop>`.

### Category 4 — `Is*PatternAvailable` flags (generic)

Resolved generically, not from a hand-maintained list: the resolver enumerates
`automation.PatternLibrary.AllForCurrentFramework`, and each `PatternId.AvailabilityProperty.Name` **is**
the inspect flag name (e.g. `IsInvokePatternAvailable`, `IsTextPattern2Available`), then reads
`el.IsPatternSupported(pid)`. inspect's transposed `"2"` spellings (`IsTransform2PatternAvailable` vs
FlaUI's `IsTransformPattern2Available`) are normalized to compare equal. Unknown-but-plausible flags →
`false`. Two flags FlaUI's table omits are force-added as `false` for parity:
`IsCustomNavigationPatternAvailable`, `IsSelectionPattern2Available`.

### Category 5 — Pattern dot-notation (`<Pattern>.<Prop>`)

Any supported pattern's property is readable as `<Pattern>.<Prop>` (e.g. `Value.Value`,
`Toggle.ToggleState`, `Window.CanMaximize`, `RangeValue.Maximum`, `Grid.RowCount`, `GridItem.Row`).
Resolved by reflection: locate the pattern via `el.Patterns.<Pattern>.PatternOrDefault`, reflect the
named `AutomationProperty<T>`, unwrap `.ValueOrDefault`. Enums are stringified; rects become
`{x,y,width,height}`; element-reference props (`GridItem.ContainingGrid`, `SelectionItem.SelectionContainer`)
surface as the target element's `Name`. The `"all"` dump expands these only for **supported** patterns,
over the set in `PropertyResolver.PatternProperties`: Value, RangeValue, Toggle, ExpandCollapse, Scroll,
Window, Grid, GridItem, Selection, SelectionItem, Transform, Dock.

---

## UIA patterns — wiring status

"Wired" = reachable through the sidecar's `action` / `attributes` / `find` / `source` ops. Reads are via
`PropertyResolver` dot-notation (any supported pattern's props are readable); the **action** columns below
reflect what `OpInterpreter.Action` / `Window` / `Input` actually call. See
[RPC protocol](../03-reference/rpc-protocol.md) for the exact action names.

| Pattern | Wired actions | Wired reads | Status |
|---|---|---|---|
| **Invoke** | `Invoke()` | — | ✅ |
| **Toggle** | `Toggle()` | `ToggleState` | ✅ |
| **ExpandCollapse** | `Expand()`, `Collapse()` | `ExpandCollapseState` | ✅ |
| **Value** | `SetValue(string)` (keyboard fallback when read-only/absent) | `Value`, `IsReadOnly` | ✅ |
| **RangeValue** | none | `Value`, `Minimum`, `Maximum`, `SmallChange`, `LargeChange`, `IsReadOnly` | 🟡 |
| **Selection** | — | `CanSelectMultiple`(`isMultiple`), `Selection`(`selectedItem`/`allSelectedItems`), `IsSelectionRequired` | ✅ |
| **SelectionItem** | `Select()`, `AddToSelection()`, `RemoveFromSelection()` | `IsSelected`, `SelectionContainer` | ✅ |
| **Scroll** | none (only as input side-effect, below) | `Horizontal/VerticalScrollPercent`, `…ViewSize`, `Horizontally/VerticallyScrollable` | 🟡 |
| **ScrollItem** | `ScrollIntoView()` (explicit action + auto before point-resolve) | — | ✅ |
| **Window** | `SetWindowVisualState(Max/Min/Normal)`, `Close()` | `CanMaximize`, `CanMinimize`, `IsModal`, `IsTopmost`, `WindowVisualState`, `WindowInteractionState` | ✅ |
| **Transform** | `Move(x,y)`, `Resize(w,h)` (in `window setRect`, with Win32 fallback) | `CanMove`, `CanResize`, `CanRotate` | ✅ |
| **Dock** | none | `DockPosition` | 🟡 |
| **Grid** | none | `RowCount`, `ColumnCount` | 🟡 |
| **GridItem** | none | `Row`, `Column`, `RowSpan`, `ColumnSpan`, `ContainingGrid` | 🟡 |
| **Text** | none | `DocumentRange.GetText(-1)` (powers `getText` / `Text` attr) | 🟡 |
| **LegacyIAccessible** | none (`DoDefaultAction`/`SetValue` unused) | 9 props incl. Role/State (see Category 3) | 🟡 |
| **Table / TableItem** | none | none (header arrays not serialised) | ⬜ |
| **MultipleView** | none | none | ⬜ |
| **VirtualizedItem** | none (`Realize()` unused) | none | ⬜ |
| **ItemContainer** | none | none | ⬜ |
| **RangeValue.SetValue / Text2 / Transform.Rotate / Annotation / Drag / Spreadsheet / …** | none | none | ⬜ |

---

## Conditions & tree scopes

`find` compiles a JSON condition tree into native UIA conditions via `ConditionFactory` +
`new PropertyCondition(...)`, composed with `.And()` / `.Or()` / `.Not()`. A `"true"` kind maps to
`TrueCondition.Default`. XPath is not on the factory — it is handled separately by the driver's XPath
engine (which can lean on FlaUI `FindFirstByXPath` and the tree walker).

**Condition properties usable in `find`** (`OpInterpreter.BuildProperty`, ~21): `AutomationId`, `Name`,
`ClassName`, `ControlType`, `LocalizedControlType`, `FrameworkId`, `HelpText`, `ItemStatus`, `ItemType`,
`AcceleratorKey`, `AccessKey`, `IsEnabled`, `IsOffscreen`, `IsKeyboardFocusable`, `IsPassword`,
`IsRequiredForForm`, `HasKeyboardFocus`, `IsContentElement`, `IsControlElement`, `ProcessId`, `RuntimeId`.
Values are coerced to the property's native type (bool for `Is*`/`HasKeyboardFocus`, int for `ProcessId`,
`ControlType` enum parse, `RuntimeId` as `int[]` from a dotted string).

**Tree scopes** (`ParseScope`) map to UIA `TreeScope`:

| Scope string | TreeScope | Meaning |
|---|---|---|
| `element` | Element | the start node only |
| `children` | Children | direct children |
| `descendants` | Descendants | all descendants (default) |
| `subtree` | Subtree | start node + all descendants |

**Tree walking** uses the **control-view** walker (`TreeWalkerFactory.GetControlViewWalker()`):
`OpInterpreter.Walk` exposes `parent` / `ancestors` / `following-siblings` / `preceding-siblings` for
XPath reverse/sibling axes, and `TopLevelWindow` walks parents to the nearest Window/Pane ancestor for
foreground/bring-on-top. `PageSourceBuilder` builds page source by **live** iterative DFS over
`FindAllChildren()` (control view), tag = `ControlType`, attributes mirroring the nova2 schema plus
start-relative `x`/`y` and Window/Transform pattern attributes.

---

## Input / Capture / Clipboard / Win32 escapes

| Concern | How | Notes |
|---|---|---|
| **Mouse** | `FlaUI.Core.Input.Mouse` | `MoveTo`, `Click`, `Down`/`Up`, `Scroll`/`HorizontalScroll`, `Drag` (fast path for left-button); modifier keys held around the op; point = clickable point or rect center; real SendInput → needs an interactive desktop |
| **Keyboard** | `FlaUI.Core.Input.Keyboard` | `Type`, `Press`/`Release` by `VirtualKeyShort`; modifiers ctrl/shift/alt/win; `setValue` keyboard fallback does Ctrl+A, Delete, type |
| **Capture** | `Capture.Element(el)` → PNG → base64 | element screenshot brings window to front first (+200 ms settle); root screenshot captures only |
| **Clipboard (text)** | `TextCopy.ClipboardService` | UTF-8, base64 over the wire |
| **Clipboard (image)** | `ClipboardImage` (Win32 CF_DIB P/Invoke) | base64 PNG; FlaUI/TextCopy are text-only |
| **Foreground escalation** | `Win32` P/Invoke | `Focus()` first (FlaUI window Focus == SetForegroundWindow + thread-attach); if still not foreground, `ForceForegroundStrong` (topmost toggle → minimize/restore) |
| **Move/resize fallback** | `Win32.MoveResize` (MoveWindow) | used when no `TransformPattern` satisfies a `window setRect` |

---

## Not yet wired (gaps)

- **RangeValue.SetValue** — set sliders/spinners to an exact value (read-only today).
- **Scroll pattern action** — `Scroll(h,v)` / `SetScrollPercent`; only real mouse-wheel input scrolls.
- **Text selection / Text2** — `GetSelection`, `GetVisibleRanges`, `RangeFromPoint`, caret/annotation ranges (only `DocumentRange.GetText` is used).
- **Table / TableItem & Grid/GridItem actions** — `Grid.GetItem(row,col)`, header associations, `RowOrColumnMajor` (Grid is read-only).
- **VirtualizedItem.Realize** — materialize items in virtualized lists/trees.
- **ItemContainer.FindItemByProperty** — locate items in virtualized containers.
- **MultipleView** — `CurrentView` / `SetCurrentView` / `GetViewName` (list↔details switching).
- **Dock action** — `SetDockPosition` (position is read-only).
- **Transform.Rotate / Transform2.Zoom** — only Move/Resize are wired.
- **Touch gestures** — `Touch.Tap`/`Hold`/`Drag`/`Pinch`/`Rotate` multi-touch.
- **CacheRequest perf page-source** — single-snapshot pass; page source is currently live per-node traversal.
- **Content / Raw view walkers** — only control-view; `rawView` page source and content-only concise source are unimplemented.
- **Store-app launch by AUMID** — `Application.LaunchStoreApp`; `app` goes through `ProcessStartInfo` only.
- **`FromPoint` / `FocusedElement`** — element-under-point and focused-element roots.
- **DrawHighlight** — visual debugging overlay.

Tracked in [../04-design/known-issues.md](../04-design/known-issues.md).
