# The FlaUI Backend — what the sidecar can do, and why it's powerful

This driver's automation engine is **[FlaUI](https://github.com/FlaUI/FlaUI)**, a .NET library over Windows
**UI Automation (UIA)**. It runs inside the **C# sidecar** (`sidecar/`); the TypeScript driver speaks W3C and
forwards **structured JSON ops** to it (the seam, ADR-003). This document is a tour of the backend: what
FlaUI gives us, how the sidecar maps onto it, and why it beats a PowerShell/UIA2-managed backend.

---

## 1. Why FlaUI / UIA3 (vs PowerShell + System.Windows.Automation)

A reference driver like nova2 drives UIA through **PowerShell + `System.Windows.Automation`** (the managed
**UIA2** client). That works but is limited; FlaUI on **UIA3** is strictly more capable:

| Concern | PowerShell + UIA2-managed | **FlaUI on UIA3 (this backend)** |
|---|---|---|
| API surface | string commands marshaled to PS; reflection for patterns | **strongly-typed** C# — `el.Patterns.Value.Pattern.Value`, `el.Properties.Name` |
| Bounded hangs | UIA2-managed has **no transaction timeout** → a call can hang forever | UIA3 `ConnectionTimeout` + `TransactionTimeout` → calls fail in bounded time |
| Modern controls | UIA2 weak on WPF/Store/touch | UIA3 (COM `UIAutomationCore`) supports modern WPF, UWP/Store, touch |
| Batching | one COM round-trip per property | **`CacheRequest`** — a whole subtree + N properties/patterns in one call |
| Throughput | per-call PS process marshaling | in-process COM on a dedicated worker thread |
| Pattern coverage | whatever you hand-roll | the **full UIA pattern set**, typed (below) |
| Legacy/MSAA | manual | first-class `LegacyIAccessiblePattern` + control-type wrappers |

The sidecar wraps every UIA call in a watchdog on a dedicated STA worker (see `docs/...design.md` §6), so a
frozen app fails one command fast instead of wedging the session — proven by the hang-injection E2E.

## 2. The building blocks FlaUI exposes

### 2.1 Automation roots — `UIA3Automation` / `UIA2Automation`
- `automation.GetDesktop()` — the root of the whole UI tree (our `app:'Root'` session).
- `automation.FromHandle(hwnd)` — attach to an existing window (our `appium:appTopLevelWindow`).
- `automation.FromPoint(pt)`, `automation.FocusedElement()`.
- `ConnectionTimeout` / `TransactionTimeout` (UIA3) — the anti-hang knobs.
- Libraries: `PatternLibrary` (all pattern ids + availability props), `PropertyLibrary` (all UIA properties),
  `ConditionFactory`, `TreeWalkerFactory`.

### 2.2 `AutomationElement` — the unit of automation
- **Properties** (typed): `el.Properties.Name|AutomationId|ClassName|ControlType|BoundingRectangle|
  ProcessId|FrameworkId|NativeWindowHandle|IsEnabled|IsOffscreen|IsKeyboardFocusable|HasKeyboardFocus|
  HelpText|ProviderDescription|IsDialog|…` — each an `AutomationProperty<T>` with `.Value`/`.ValueOrDefault`.
- **Find**: `FindFirst(scope, condition)`, `FindAll(...)`, `FindFirstChild/FindAllChildren`,
  `FindFirstDescendant`, `FindAt`. Scopes: Element / Children / Descendants / Subtree.
- **Focus/foreground**: `Focus()` (smart: windows → `SetForeground()`, controls → `FocusNative()`),
  `FocusNative()`, `SetForeground()`, `DrawHighlight()`.
- **Geometry**: `GetClickablePoint()` / `TryGetClickablePoint()`, `BoundingRectangle`.
- **Introspection**: `GetSupportedPatterns()`, `GetSupportedProperties()`.
- **Control-type wrappers**: `AsButton()`, `AsTextBox()`, `AsWindow()`, `AsComboBox()`, `AsCheckBox()`,
  `AsGrid()`, `AsTree()`, `AsMenu()`, `AsTab()`, … — typed convenience over the raw element.

### 2.3 Patterns — the heart of UIA (all typed, each `.IsSupported` + `.PatternOrDefault`)
`el.Patterns.<X>` gives: **Invoke**, **Toggle**, **ExpandCollapse**, **Selection** / **SelectionItem**,
**Value**, **RangeValue**, **Scroll** / **ScrollItem**, **Grid** / **GridItem**, **Table** / **TableItem**,
**Text** / **Text2**, **Window**, **Transform** / **Transform2**, **Dock**, **MultipleView**,
**ItemContainer**, **VirtualizedItem**, **SynchronizedInput**, **Annotation**, **Drag** / **DropTarget**,
**Styles**, **Spreadsheet** / **SpreadsheetItem**, **TextChild**, **CustomNavigation**, and
**LegacyIAccessible** (the MSAA bridge: `Name/Value/Role/State/DefaultAction/Description/Help/
KeyboardShortcut/ChildId`).

Examples the sidecar uses or can use directly:
- `el.Patterns.Invoke.Pattern.Invoke()` — press a button/menu item.
- `el.Patterns.Value.Pattern.SetValue("x")` / `.Value` — set/read a text value.
- `el.Patterns.Toggle.Pattern.Toggle()` / `.ToggleState`.
- `el.Patterns.Window.Pattern.SetWindowVisualState(Maximized|Minimized|Normal)` / `.Close()`.
- `el.Patterns.RangeValue.Pattern.Value|Minimum|Maximum`, `el.Patterns.Grid.Pattern.RowCount`, …
- `el.Patterns.LegacyIAccessible.Pattern.Role|State|DefaultAction` — MSAA data even when UIA props are empty.

### 2.4 Conditions — `ConditionFactory`
`ByAutomationId`, `ByName`, `ByClassName`, `ByControlType`, `ByText`, `ByFrameworkId`, `ByProcessId`, …,
plus boolean composition `.And()`, `.Or()`, `.Not()`, `PropertyCondition`, and `TrueCondition.Default`.
This is what our XPath engine compiles structural steps into (pushed down to native UIA).

### 2.5 Tree walking — `TreeWalkerFactory`
Control-view / content-view / raw-view walkers: `GetParent`, `GetFirstChild`, `GetNextSibling`,
`GetPreviousSibling`. Powers XPath reverse/sibling axes (`parent::`, `ancestor::`, `following-sibling::`, …).

### 2.6 Caching — `CacheRequest`
Pre-declare properties/patterns + a `TreeScope`, `Activate()`, then read a whole subtree from a single
cross-process snapshot. The intended fast path for page source (currently live traversal; cached pass is a
planned optimization).

### 2.7 Input — `FlaUI.Core.Input` (real SendInput)
- `Mouse.MoveTo(pt)`, `Mouse.Click(button)`, `Mouse.Down/Up`, `Mouse.Drag(from,to)`, `Mouse.Scroll(delta)`,
  `Mouse.HorizontalScroll`.
- `Keyboard.Type("text")`, `Keyboard.Press/Release(VirtualKeyShort)`, key combos.
- Real OS input → needs an interactive desktop (vs UIA pattern actions which don't).

### 2.8 Capture — `FlaUI.Core.Capturing`
`Capture.Screen()`, `Capture.Element(el)`, `Capture.Rectangle(...)` → bitmaps (we encode PNG → base64 for
W3C screenshots).

## 3. How the sidecar maps ops → FlaUI

| JSON op (from TS) | FlaUI used |
|---|---|
| `find` | `ConditionFactory` + `FindFirst/FindAll(scope, condition)` |
| `attributes` / `getAttributes` | `el.Properties.*`, `el.Patterns.<X>.IsSupported`, `el.Patterns.LegacyIAccessible`, pattern dot-notation (Phase A) |
| `action` (invoke/toggle/expand/setValue/window-state/…) | the matching `el.Patterns.<X>.Pattern.<Method>()` |
| `source` | `TreeWalker`/`FindAllChildren` DFS → XML (CacheRequest pass planned) |
| `input` (click/hover/scroll/keys/drag/move/down/up) | `Mouse` / `Keyboard`; bring-on-top via `Focus()` |
| `window` (title/handle/rect/setRect/max/min/foreground) | `Window` pattern + `Transform` + Win32 fallback (`Win32.cs`) |
| `screenshot` | `Capture.Element` → PNG |
| `walk` | `TreeWalkerFactory` control-view walker |
| `clipboard` | TextCopy (text) + Win32 CF_DIB (image, `ClipboardImage.cs`) |
| `file` / `powershell` | .NET IO / a bounded `powershell.exe` child (gated insecure feature) |

Every UIA-touching op runs on the **`UiaScheduler`** (serialized STA worker + watchdog + poison/recycle).

## 4. Backends: UIA3 (default) vs UIA2 (experimental)
- **UIA3** (`FlaUI.UIA3`, COM `Interop.UIAutomationClient`) — default; modern controls, touch, and the
  `ConnectionTimeout`/`TransactionTimeout` anti-hang knobs.
- **UIA2** (`FlaUI.UIA2`, `System.Windows.Automation`) — `flaui:backend:uia2`, experimental; good for some
  legacy WinForms quirks, but the layer-1 timeouts don't apply, so it's not recommended.

## 5. What FlaUI does NOT give us (and how we fill it)
- **Foreground guarantees**: UIA `Focus()` isn't always enough → we add Win32 `SetForegroundWindow` +
  `AttachThreadInput`, with a topmost/minimize-restore **escalation** in `windows: setWindowForeground`.
- **`SetWindowPos` move/resize** when a window lacks `TransformPattern` → Win32 fallback.
- **Clipboard images** → Win32 CF_DIB P/Invoke (FlaUI/TextCopy are text-only).
- **inspect.exe-style value formatting** (e.g. `Role` as `"push button (0x2B)"`) → formatting layer on top.

## 6. Reference
- FlaUI source: <https://github.com/FlaUI/FlaUI> (`src/FlaUI.Core/AutomationElements`, `.../Patterns`,
  `.../Conditions`, `.../Capturing`, `.../Input`).
- UIA pattern/property model: Microsoft UI Automation docs.
- Our usage & status: [`FUNCTIONS.md`](./FUNCTIONS.md); architecture & anti-hang: the design spec §2/§6.
