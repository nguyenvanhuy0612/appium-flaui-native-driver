# The FlaUI Backend — what the sidecar can do, and why it's powerful

This driver's automation engine is **[FlaUI](https://github.com/FlaUI/FlaUI)**, a .NET library over Windows
**UI Automation (UIA)**. It runs inside the **C# sidecar** (`sidecar/`); the TypeScript driver speaks W3C and
forwards **structured JSON ops** to it (the seam, ADR-003). This document is a tour of the backend: what
FlaUI gives us, how the sidecar maps onto it, and why it beats a PowerShell/UIA2-managed backend.

> **Legend** — ✅ = wired into the sidecar today · ▫ = available in FlaUI, **not yet** wired (feature idea).
> Capability lists below are grounded in FlaUI source (`github.com/FlaUI/FlaUI`, branch `main`, ~v4.x);
> a few members the research couldn't fully quote are tagged _(verify)_.

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
| App lifecycle | `Start-Process` + window guesswork | **`Application`** (launch/attach/store-app/close/kill/wait) |
| Legacy/MSAA | manual | first-class `LegacyIAccessiblePattern` + control-type wrappers |

The sidecar wraps every UIA call in a watchdog on a dedicated STA worker (see `docs/...design.md` §6), so a
frozen app fails one command fast instead of wedging the session — proven by the hang-injection E2E.

## 2. The building blocks FlaUI exposes

### 2.1 Automation roots — `UIA3Automation` / `UIA2Automation`
- ✅ `automation.GetDesktop()` — the root of the whole UI tree (our `app:'Root'` session).
- ✅ `automation.FromHandle(hwnd)` — attach to an existing window (our `appium:appTopLevelWindow`).
- ▫ `automation.FromPoint(pt)`, ▫ `automation.FocusedElement()` — element under a point / the focused element.
- ✅ `ConnectionTimeout` / `TransactionTimeout` (UIA3) — the anti-hang knobs.
- Libraries: `PatternLibrary` (all pattern ids + availability props ✅), `PropertyLibrary` (all UIA properties),
  `ConditionFactory`, `TreeWalkerFactory`.

### 2.2 Application lifecycle — `FlaUI.Core.Application` (launch / attach / stop)
The process/app layer. The sidecar uses Launch + GetMainWindow + Close/Kill for sessions today; the rest are
ready-made building blocks for features like quick start/stop, kill-when-stuck, attach-to-running, and UWP.
_Source: `src/FlaUI.Core/Application.cs`._
- ✅ `static Application Launch(string exe, string args = "")` / `Launch(ProcessStartInfo)` — launch an exe
  (our `app:<path>` sessions; the PSI overload carries `appArguments`/`appWorkingDir`). _Feature:_ fast app start.
- ▫ `static Application LaunchStoreApp(string appUserModelId, string args = "")` — launch a **UWP/Store app by
  AUMID**. _Feature:_ support `app:<AUMID>` (e.g. `Microsoft.WindowsCalculator_…!App`) — the gap noted in §5.
- ▫ `static Application Attach(int pid)` / `Attach(Process)` / `Attach(string exe, int index = 0)` — connect to
  an **already-running** app (by pid / Process / exe name, Nth instance). _Feature:_ attach without relaunch.
- ▫ `static Application AttachOrLaunch(ProcessStartInfo)` — attach if running else launch. _Feature:_ idempotent
  "ensure app is up".
- ✅ `Window? GetMainWindow(automation, TimeSpan? waitTimeout = null)` — the app's main window, waited-for; may
  be null. _Feature:_ robust post-launch root resolution.
- ▫ `Window[] GetAllTopLevelWindows(automation)` — all top-level windows of the process. _Feature:_ multi-window
  / dialog handling.
- ✅ `bool Close(bool killIfCloseFails = true)` — graceful close, force-kill after `CloseTimeout`. _Feature:_
  clean stop with fallback (`shouldCloseApp`).
- ✅ `void Kill()` — force-terminate + wait. _Feature:_ **force-quit a stuck app** (`ms:forcequit`).
- ▫ `bool WaitWhileBusy(TimeSpan?)` — block while the app is input-busy. _Feature:_ "wait until ready" / stuck-detection.
- ▫ `bool WaitWhileMainHandleIsMissing(TimeSpan?)` — block until the main window exists. _Feature:_ avoid racing a
  not-yet-shown UI right after launch (a sturdier `ms:waitForAppLaunch`).
- ▫ Properties: `ProcessId`, `Name`, `MainWindowHandle`, `HasExited`, `ExitCode`, `IsStoreApp`,
  `CloseTimeout {get;set;}` (default 5s). _Feature:_ health checks (`HasExited`/`ExitCode` → detect a crash),
  targeted kill by pid, branch logic for Store apps.

### 2.3 `AutomationElement` — the unit of automation
_Sources: `AutomationElement.cs`, `.Find.cs`, `.AsMethods.cs`, `AutomationElementExtensions.cs`._
- **Properties** (typed `AutomationProperty<T>` with `.Value`/`.ValueOrDefault`): ✅ `Name|AutomationId|ClassName|
  ControlType|BoundingRectangle|ProcessId|FrameworkId|NativeWindowHandle|IsEnabled|IsOffscreen|IsKeyboardFocusable|
  HasKeyboardFocus|HelpText|ProviderDescription|IsDialog|…`; also `ActualWidth/Height`, ▫ `IsAvailable`
  (stale-element detection), ▫ `Parent`, and the `Patterns` / `Properties` accessors.
- **Actions** (instance methods): ▫ `Click(bool moveMouse=false)`, ▫ `DoubleClick(…)`, ▫ `RightClick(…)`,
  ▫ `RightDoubleClick(…)` — element-level clicks (we currently click via `Mouse` + ClickablePoint instead);
  ✅ `Focus()` (windows→`SetForeground`, controls→`FocusNative`), ✅ `FocusNative()`, ✅ `SetForeground()`;
  ✅ `GetClickablePoint()` / `TryGetClickablePoint(out Point)`; ✅ `Capture():Bitmap`, ▫ `CaptureToFile(path)`,
  ▫ `CaptureWpf():BitmapImage`.
- **Highlight & waits** (extensions): ▫ `DrawHighlight()` / `DrawHighlight(Color)` /
  `DrawHighlight(bool blocking, Color, TimeSpan?)` — _Feature:_ visual debugging overlay; ▫ `WaitUntilEnabled(timeout?)`,
  ▫ `WaitUntilClickable(timeout?)` — _Feature:_ robust pre-action waits.
- **Find** (`.Find.cs`): ✅ `FindFirst(scope,cond)` / `FindAll(...)`, ✅ `FindFirstChild/FindAllChildren`,
  ✅ `FindFirstDescendant/FindAllDescendants`, ✅ `FindAt(scope,index,cond)` / `FindChildAt(index,…)` (Appium
  "instance" semantics), ✅ `FindFirstByXPath/FindAllByXPath` (our XPath strategy can lean on this),
  ▫ `FindFirstNested/FindAllNested(...)` (chained relative locators), ▫ `FindFirstWithOptions/FindAllWithOptions`
  (traversal order + re-root → perf/ordering control). Scopes: Element / Children / Descendants / Subtree.
- **Typed wrappers** (`AsXxx()`): ✅ used selectively; full set ▫ `AsButton/AsCheckBox/AsToggleButton/AsRadioButton/
  AsComboBox/AsTextBox/AsLabel/AsSlider/AsSpinner/AsProgressBar/AsMenu/AsMenuItem/AsGrid/AsGridRow/AsGridCell/
  AsGridHeader/AsDataGridView/AsTree/AsTreeItem/AsTab/AsTabItem/AsListBox/AsListBoxItem/AsWindow/AsTitleBar/
  AsCalendar/AsDateTimePicker/AsThumb/AsHorizontal|VerticalScrollBar`, plus `As<T>()`/`AsType(Type)`. _Feature:_
  high-level helpers (e.g. `AsComboBox().Select(...)`, `AsTextBox().Text`, `AsGrid().Rows`).

### 2.4 Patterns — the heart of UIA (each `.IsSupported` + `.PatternOrDefault`)
`el.Patterns.<X>` — the full typed pattern set. ✅ = the sidecar already maps it (find/attributes/actions);
▫ = available for new features. _Source: `src/FlaUI.Core/Patterns/*.cs`._
- ✅ **Invoke** — `Invoke()` (button/menu/link default action).
- ✅ **Value** — `Value`, `IsReadOnly`, `SetValue(string)`.
- ▫ **RangeValue** — `Value/Minimum/Maximum/SmallChange/LargeChange`, `IsReadOnly`, `SetValue(double)`. _Feature:_
  set sliders/spinners/progress to an exact value.
- ✅ **Toggle** — `ToggleState`, `Toggle()`.
- ✅ **ExpandCollapse** — `ExpandCollapseState`, `Expand()`, `Collapse()`.
- ✅ **Selection** / **SelectionItem** — `Select()/AddToSelection()/RemoveFromSelection()`, `IsSelected`,
  `SelectionContainer`; **Selection2** adds first/last-selected + counts ▫.
- ✅ **Scroll** — `Horizontal/VerticalScrollPercent`, `…ViewSize`, `…Scrollable`, `Scroll(h,v)`,
  ▫ `SetScrollPercent(h,v)`; ✅ **ScrollItem** — `ScrollIntoView()`.
- ✅ **Grid** — `RowCount`, `ColumnCount`, ▫ `GetItem(row,col)`; ✅ **GridItem** — `Row/Column/RowSpan/ColumnSpan/
  ContainingGrid`.
- ▫ **Table** / **TableItem** — `RowOrColumnMajor`, row/column header associations. _Feature:_ table header extraction.
- ▫ **Text** / **Text2** — `DocumentRange`, `GetSelection()`, `GetVisibleRanges()`, `RangeFromPoint(pt)`,
  `RangeFromChild(el)`; Text2 adds caret/annotation ranges _(verify)_. _Feature:_ rich-text reading, selection
  capture, hit-test text at a point. (We use `DocumentRange.GetText` for `getText` ✅.)
- ▫ **TextChild** / **TextEdit** — embedded-text parent lookup; IME composition/conversion ranges.
- ✅ **Window** — `CanMaximize/CanMinimize/IsModal/IsTopmost`, `WindowVisualState/WindowInteractionState`,
  `SetWindowVisualState(...)`, `Close()`, ▫ `WaitForInputIdle(ms)`.
- ▫ **Transform** / **Transform2** — `CanMove/CanResize/CanRotate`, `Move(x,y)`, `Resize(w,h)`, `Rotate(deg)`;
  Transform2 adds `Zoom`. _Feature:_ move/resize windows & elements, zoom.
- ▫ **Dock** — `DockPosition`, `SetDockPosition` _(verify)_. ▫ **MultipleView** — `CurrentView/SupportedViews`,
  `SetCurrentView`, `GetViewName`. _Feature:_ switch list/details views.
- ▫ **VirtualizedItem** — `Realize()`; ▫ **ItemContainer** — `FindItemByProperty(...)`. _Feature:_ materialize &
  locate items in **virtualized** lists/trees (big for long lists).
- ✅ **LegacyIAccessible** — `Name/Value/Role/State/DefaultAction/Description/Help/KeyboardShortcut/ChildId`,
  ▫ `DoDefaultAction()`, `Select(flags)`, `SetValue(string)` (MSAA bridge).
- ▫ **Annotation** (`AnnotationTypeName/Author/DateTime/Target`), **Drag**/**DropTarget** (`IsGrabbed/GrabbedItems`,
  drop effects), **SynchronizedInput**, **Spreadsheet**/**SpreadsheetItem**, **Styles** (`StyleName/FillColor/Shape`),
  **ObjectModel** (`GetUnderlyingObjectModel()`), **CustomNavigation** (`Navigate(dir)` _(verify)_).

### 2.5 Conditions — `ConditionFactory`
_Source: `Conditions/ConditionFactory.cs`._ ✅ `ByAutomationId`, `ByName`, `ByText`, `ByValue`, `ByClassName`,
`ByControlType`, `ByLocalizedControlType`, `ByHelpText`, `ByProcessId`, `ByFrameworkId`, ▫ `ByFrameworkType`
(WPF/Win32/WinForms), each with `PropertyConditionFlags` (case-insensitive/substring); prebuilt composites
▫ `Menu()/Grid()/Horizontal|VerticalScrollBar()`. Compose on `ConditionBase` via `.And()/.Or()/.Not()`. (XPath is
**not** on the factory — it's `AutomationElement.FindFirstByXPath/FindAllByXPath` ✅.) This is what our XPath engine
compiles structural steps into (pushed down to native UIA).

### 2.6 Tree walking — `TreeWalkerFactory` / `ITreeWalker`
✅ `GetControlViewWalker()`, ▫ `GetContentViewWalker()` (data-bearing only → concise source), ▫ `GetRawViewWalker()`
(**see hidden/structural elements** other views hide — needed for rawView page source), ▫ `GetCustomTreeWalker(cond)`.
`ITreeWalker`: `GetParent / GetFirstChild / GetLastChild / GetNextSibling / GetPreviousSibling`. Powers XPath
reverse/sibling axes (`parent::`, `ancestor::`, `following-sibling::`, …).

### 2.7 Caching — `CacheRequest`
_Source: `CacheRequest.cs`._ ▫ Pre-declare `Properties` (`Add(PropertyId)`) + `Patterns` (`Add(PatternId)`) + a
`TreeScope`, `AutomationElementMode` (Full/None) and `TreeFilter`, then `Activate():IDisposable` and read a whole
subtree from **one cross-process snapshot** (`CacheRequest.Current`, `IsCachingActive`). _Feature:_ the intended fast
path for page source (currently live traversal; cached pass is the planned perf win).

### 2.8 Input — `FlaUI.Core.Input` (real SendInput)
_Sources: `Input/Mouse.cs`, `Keyboard.cs`, `Wait.cs`, `Touch.cs`._
- **Mouse** ✅: `Position {get;set}`, `MoveTo(x,y)/MoveTo(Point)/MoveBy(dx,dy)`, `Click(button)/Click(Point,button)`,
  `LeftClick/RightClick`, `DoubleClick/LeftDoubleClick/RightDoubleClick`, `Down/Up(button)`,
  `Drag(start,end,button)/DragHorizontally/DragVertically`, `Scroll(lines)/HorizontalScroll(lines)`; tunables
  `MovePixelsPerMillisecond/PerStep`, `AreButtonsSwapped`.
- **Keyboard** ✅: `Type(string|char|VirtualKeyShort[])`, ▫ `TypeSimultaneously(keys)` (chords), `Press/Release(key)`,
  ▫ `Pressing(keys):IDisposable` (`using` auto-releases held modifiers), ▫ `TypeScanCode/TypeVirtualKeyCode`.
- **Wait** ▫: `UntilInputIsProcessed(timeout?)` (drain the input queue before asserting),
  `UntilResponsive(element|hWnd, timeout?)` (wait for a window to stop being busy).
- **Touch** ▫: `Tap(points)`, `Hold(duration, points)`, `Drag(duration, start, end)`,
  `Pinch(center, startR, endR, duration, angle)`, `Rotate(center, radius, startAngle, endAngle, duration)`,
  `Transition(duration, (from,to)[])`. _Feature:_ multi-touch gestures (tap, long-press, **pinch-zoom**, rotate).
- Real OS input → needs an interactive desktop (vs UIA pattern actions which don't).

### 2.9 Capture / overlay / video — `FlaUI.Core.Capturing`
_Source: `Capturing/Capture.cs`, `CaptureImage.cs`, `VideoRecorder.cs`._
- ✅ `Capture.Element(el)` → image (our element/root screenshots, PNG→base64). ▫ `Capture.MainScreen()`,
  `Screen(index)`, `Rectangle(bounds)`, `ElementRectangle(el,rect)`, `ScreensWithElement(el)` (multi-monitor).
- `CaptureImage`: `Bitmap`, `OriginalBounds`, `ToFile(path)`, ▫ `ApplyOverlays(ICaptureOverlay[])` (e.g. a
  `MouseOverlay` _(verify)_ → annotate cursor/clicks), `Dispose()`.
- ▫ `VideoRecorder(settings, captureMethod)` + `Stop()/Dispose()`, static `DownloadFFMpeg(folder)` — **ffmpeg-backed
  screen recording** (can auto-download ffmpeg; recording starts on construction). _Note:_ screen recording is
  currently **out of scope** by decision (ADR-012) — this is what it would build on if revisited.

## 3. How the sidecar maps ops → FlaUI

| JSON op (from TS) | FlaUI used |
|---|---|
| session create | `Application.Launch` / `automation.FromHandle` / `automation.GetDesktop` + `GetMainWindow` |
| `app` (launchApp/closeApp/activate) | `Application.Launch` (re-root), `Close`/`Kill`, `Process` activate + `Focus` |
| `find` | `ConditionFactory` + `FindFirst/FindAll(scope, condition)`; XPath → `FindFirstByXPath` / engine |
| `attributes` / `getAttributes` | `el.Properties.*`, `el.Patterns.<X>.IsSupported`, `LegacyIAccessible`, **supported-pattern dot-notation + ClickablePoint** (Phase A / beta.8) |
| `action` (invoke/toggle/expand/setValue/window-state/…) | the matching `el.Patterns.<X>.Pattern.<Method>()` |
| `source` | `TreeWalker`/`FindAllChildren` DFS → XML (CacheRequest pass planned; rawView walker available) |
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

## 5. What FlaUI does NOT give us (and how we fill it / could)
- **Foreground guarantees**: UIA `Focus()` isn't always enough → we add Win32 `SetForegroundWindow` +
  `AttachThreadInput`, with a topmost/minimize-restore **escalation** in `windows: setWindowForeground`.
- **`SetWindowPos` move/resize** when a window lacks `TransformPattern` → Win32 fallback.
- **Clipboard images** → Win32 CF_DIB P/Invoke (FlaUI/TextCopy are text-only).
- **inspect.exe-style value formatting** (e.g. `Role` as `"push button (0x2B)"`) → formatting layer on top.
- **UWP/Store launch by AUMID**: not wired — `app` goes through `ProcessStartInfo`. FlaUI's
  `Application.LaunchStoreApp(aumid)` (§2.2) is the building block to add it.

## 6. Feature ideas already buildable on the backend (not yet wired)
These map directly to the ▫ members above — quick wins if demand appears:
- **Lifecycle commands**: `windows: killApp` (`Application.Kill`), `relaunch` (`Close`+`Launch`), `isAppRunning`
  (`HasExited`), `waitUntilReady` (`WaitWhileBusy`), attach-to-running (`Attach`), UWP launch (`LaunchStoreApp`).
- **Robust waits**: `WaitUntilClickable/Enabled`, `Wait.UntilInputIsProcessed`, `Window.WaitForInputIdle`.
- **Rich controls**: `RangeValue.SetValue` (sliders), `VirtualizedItem.Realize` + `ItemContainer.FindItemByProperty`
  (long virtualized lists), `Transform.Move/Resize` (window geometry), typed `AsXxx()` helpers.
- **Visibility/debug**: `DrawHighlight` overlays, `CaptureImage.ApplyOverlays`, rawView page source (`GetRawViewWalker`).
- **Perf**: single-pass `CacheRequest` page source.
- **Touch**: `Touch.Pinch/Rotate/Tap` multi-touch gestures.

## 7. Reference
- FlaUI source: <https://github.com/FlaUI/FlaUI> (branch `main`; `src/FlaUI.Core/Application.cs`,
  `.../AutomationElements`, `.../Patterns`, `.../Conditions`, `.../Capturing`, `.../Input`).
- UIA pattern/property model: Microsoft UI Automation docs.
- Our usage & status: [`FUNCTIONS.md`](./FUNCTIONS.md); architecture & anti-hang: the design spec §2/§6.
