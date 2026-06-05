appium-flaui-native-driver
==========================

A custom **Appium 3** driver for **Windows desktop UI automation**, built directly on
**[FlaUI](https://github.com/FlaUI/FlaUI) (UI Automation / UIA3)** through a compiled, self-contained
**C#/.NET sidecar**. It automates Universal Windows Platform (UWP), Windows Forms (WinForms), Windows
Presentation Foundation (WPF), and Classic Windows (Win32) apps on Windows 10 and later.

Designed **W3C-first** and **stability-first**, it offers:

- **Native FlaUI backend** — every interaction goes through FlaUI's UIA3 layer (patterns, conditions, real
  `SendInput` mouse/keyboard), not PowerShell string-scraping. This unlocks the full UIA surface and is
  faster and more reliable for traditional desktop apps.
- **Crash- and hang-resistant** — UIA runs in a separate sidecar process behind five anti-hang layers. A
  frozen target app fails *that one command* in seconds; the session and the Appium server survive.
- **Rich attribute retrieval** — every direct UIA property, pattern dot-notation (`Value.Value`,
  `Toggle.ToggleState`, …), `LegacyIAccessible.*` (MSAA) with shorthand aliases, `Is*PatternAvailable`
  flags, and a single `"all"` dump — matching what `inspect.exe` shows.
- **Full XPath 1.0 engine** — 13 axes, all core functions, `@*`, ControlType aliases, correct positional
  semantics, with structural parts pushed down to native UIA conditions.
- **Platform-specific commands** — direct window manipulation, real input gestures, clipboard (text +
  image), file transfer, and more, via `windows: <command>`.
- **Zero end-user setup** — the sidecar ships as a self-contained single-file `.exe`. No .NET install, no
  Developer Mode, no separate WinAppDriver server.

> **Status: BETA** (`appium-flaui-native-driver@beta`, win-x64). The command surface below is implemented
> and verified end-to-end on real Windows machines. Canonical, always-current API/status:
> [`docs/03-reference/appium-api.md`](docs/03-reference/appium-api.md).

---

## 📑 Table of Contents
- [Getting Started](#-getting-started)
- [Configuration](#-configuration)
- [Example Usage](#-example-usage)
- [Key Features](#-key-features)
  - [Element Location](#element-location)
  - [Attribute Retrieval](#attribute-retrieval)
  - [Stability & Anti-Hang](#stability--anti-hang)
  - [PowerShell Execution](#powershell-execution)
- [Platform-Specific Extensions](#-platform-specific-extensions)
  - [Mouse & Pointer](#mouse--pointer)
  - [Keyboard](#keyboard)
  - [Element Operations](#element-operations)
  - [Selection Management](#selection-management)
  - [Window Management](#window-management)
  - [System & State](#system--state)
- [Security / Insecure Features](#-security--insecure-features)
- [Development](#-development)

---

## 🚀 Getting Started

### Installation
The driver is built for Appium 3. Install it from npm:
```bash
appium driver install --source=npm appium-flaui-native-driver@beta
```
Or from a local checkout/tarball containing `prebuilt/<arch>/FlaUiSidecar.exe`:
```bash
appium driver install --source=local /path/to/appium-flaui-native-driver
```

### Prerequisites
- **Host OS**: Windows 10 / 11, or Windows Server 2016+ **with the Desktop Experience** feature (x64; arm64
  is cross-built but not yet run-verified). Server Core has no desktop and is not supported.
- **No .NET install** — the sidecar is self-contained. **No Developer Mode** or extra software.
- **Appium 3** (`appium@^3.0.0`), Node ≥ 20.19, npm ≥ 10.

> [!NOTE]
> **Package size.** Each sidecar embeds the .NET runtime, so the prebuilt binary is ~180 MB (x64). This is
> the deliberate cost of zero end-user setup and offline reliability (see `docs/04-design/decisions.md` ADR-013).

---

## ⚙️ Configuration

The driver supports the following capabilities, grouped by prefix in order — **`appium:`** (session & app)
→ **`ms:`** (Windows-compat) → **`flaui:`** (engine tuning):

| Capability | Description | Default | Example |
| :--- | :--- | :--- | :--- |
| `platformName` | Must be `Windows` (case-insensitive). | (Required) | `Windows` |
| `appium:automationName` | Must be `FlaUINative` (case-insensitive). | (Required) | `FlaUINative` |
| `appium:app` | Path to the executable to **launch** (or `Root` for the whole desktop). The driver owns a launched app and closes it on session end. | (None) | `C:\Windows\System32\notepad.exe` |
| `appium:appTopLevelWindow` | Attach to an existing window by hex HWND. | (None) | `0x40344` |
| `appium:appName` | Attach to a running app whose **window TITLE** matches this **regex** (case-insensitive). | (None) | `.*Notepad` |
| `appium:processName` | Attach to a running app by **exact exe name** (case-insensitive, `.exe` optional). | (None) | `notepad.exe` |
| `appium:createSessionTimeout` | Poll budget (ms) to wait for an attach target to appear before failing. | `60000` | `30000` |
| `appium:appArguments` | Arguments passed to the app on launch. | (None) | `--debug` |
| `appium:appWorkingDir` | Working directory for the launched app. | (None) | `C:\Temp` |
| `appium:shouldCloseApp` | On session end, close the app **started via `app`** (incl. a single-instance app `app` fell back to attaching). Apps reached via `appTopLevelWindow`/`appName`/`processName` are **never** closed. | `true` | `false` |
| `appium:prerun` | `{ script }` — PowerShell to run before the session starts (requires the `power_shell` feature). | (None) | `{script: '...'}` |
| `appium:postrun` | `{ script }` — PowerShell to run on session teardown (requires the `power_shell` feature). | (None) | `{script: '...'}` |
| `appium:typeDelay` | Per-character delay (ms). **Accepted but not yet applied.** | `0` | `100` |
| `appium:includeContextElementInSearch` | Find-from-element searches include the context element itself. | `true` | `false` |
| `appium:convertAbsoluteXPathToRelativeFromElement` | When `true`, a find-from-element XPath starting with `//` is rewritten to `.//` (treat a leading `//` as "from this context element"). | `false` | `true` |
| `ms:waitForAppLaunch` | Seconds to wait after **launch** for the app's window to appear. | `0` | `3` |
| `ms:forcequit` | Kill the app process (instead of a graceful close) on session deletion. | `false` | `true` |
| `flaui:backend` | UI Automation API: `uia3` = modern COM UIA (full pattern set, recommended); `uia2` = managed wrapper — try only if a legacy control misbehaves under UIA3. | `uia3` | `uia2` |
| `flaui:operationTimeout` | **Main per-op watchdog (ms)** — every UIA op must finish within this or it's aborted as `timeout` and the worker recycled (the core anti-hang bound). Raise for legitimately slow ops. | `30000` | `30000` |
| `flaui:connectionTimeout` / `flaui:transactionTimeout` | Low-level UIA COM timeouts (ms), kept *below* the watchdog so a stuck COM call bails on its own first. Rarely tuned. | `min(20000, opTimeout−5000)` | `5000` |
| `flaui:elementTableMax` | Size of the sidecar's RuntimeId→element cache (FIFO). Bump for huge trees / very long sessions. | (sidecar default) | `5000` |
| `flaui:idleTimeout` | Sidecar self-exits after this idle time (orphan guard). Defaults to `newCommandTimeout + 120s`, so setting `newCommandTimeout` alone suffices; `newCommandTimeout: 0` disables it. | `newCommandTimeout + 120000` | `600000` |
| `flaui:autoRecycle` | **Opt-in.** `true` = silently recycle the sidecar on a transport failure. `false` (default) = a dead sidecar **fails the session** (`invalid session id`) so you start a fresh one. | `false` | `true` |

> [!NOTE]
> - **A target is required** — exactly one of `app` / `appTopLevelWindow` / `appName` / `processName`. When
>   several are given, the attach target resolves **`appTopLevelWindow` → `processName` → `appName` → `app`
>   → `Root`** (exact identifiers before fuzzy patterns).
> - **App lifecycle** — `app` *launches* the app and **closes it** on session end (the driver owns it; unless
>   `shouldCloseApp: false`, and `ms:forcequit` kills instead of closing). `appTopLevelWindow` / `appName` /
>   `processName` *attach* to a running app and **leave it running**.
> - **PowerShell timeout is per-call**, not a capability: `execute('powershell', [{script\|command, timeout?}])`
>   (default `60000` ms). PowerShell runs out-of-scheduler, so `flaui:operationTimeout` does **not** bound it.
> - **`flaui:` caps tune the sidecar** — most sessions never set any. The timeout ones form the nested
>   anti-hang chain (**UIA < watchdog < RPC < hard-deadline**), see
>   [`docs/02-architecture/stability.md`](docs/02-architecture/stability.md).
> - **Prefixes:** `ms:` = WinAppDriver-compatible names · `flaui:` = engine tuning · `appium:` = standard/session.

---

## 💡 Example Usage

### Python (Appium-Python-Client)
```python
from appium import webdriver
from appium.options.common import AppiumOptions

options = AppiumOptions()
options.set_capability('platformName', 'Windows')
options.set_capability('appium:automationName', 'FlaUINative')
options.set_capability('appium:app', 'C:\\Windows\\System32\\notepad.exe')

driver = webdriver.Remote('http://127.0.0.1:4723', options=options)
try:
    el = driver.find_element('name', 'Text Editor')
    el.send_keys('Hello from FlaUI')
finally:
    driver.quit()
```

### JavaScript (WebdriverIO)
```js
const { remote } = require('webdriverio');

const driver = await remote({
  hostname: '127.0.0.1', port: 4723,
  capabilities: {
    platformName: 'Windows',
    'appium:automationName': 'FlaUINative',
    'appium:app': 'C:\\Windows\\System32\\notepad.exe',
    // attach instead: 'appium:appTopLevelWindow': '0x40344'
    // whole desktop:  'appium:app': 'Root'
  },
});
```

---

## ✨ Key Features

### Element Location
The driver supports the standard Appium/WinAppDriver location strategies, mapped to UIA attributes as shown
in `inspect.exe`:

| Strategy | Description | Example |
| :--- | :--- | :--- |
| `accessibility id` | The `AutomationId` attribute. | `CalculatorResults` |
| `class name` | The `ClassName` attribute. | `TextBlock` |
| `id` | Alias of `accessibility id` (matches `AutomationId`). The dotted `RuntimeId` (e.g. `42.333896.3.1`) is what the driver returns as each element's identity. | `CalculatorResults` |
| `name` | The `Name` attribute. | `Calculator` |
| `tag name` | The `ControlType` short name (e.g. `Button`, `Text`). | `Text` |
| `xpath` | Full XPath 1.0 over any inspect-visible attribute; structural parts run as native UIA conditions. | `(//Button)[2]` |

Finding from an element (scoped/descendant search) is supported.

### Attribute Retrieval
Retrieve element details with `get_attribute` / `get_property`. Resolution is done **natively in FlaUI**:

#### Supported Attributes
- **Standard UIA Properties** — `AutomationId`, `Name`, `ClassName`, `RuntimeId`, `ControlType`,
  `IsEnabled`, `IsOffscreen`, `BoundingRectangle`, `ProviderDescription`, `IsDialog`, and any other direct
  UIA property by name.
- **Pattern-Specific Properties** — dot-notation `Pattern.Property` resolved via FlaUI's pattern objects:
    - `Value.Value`, `Value.IsReadOnly`
    - `Toggle.ToggleState`
    - `ExpandCollapse.ExpandCollapseState`
    - `RangeValue.Value` / `.Minimum` / `.Maximum` / `.SmallChange`
    - `Window.CanMaximize` / `.CanMinimize` / `.IsModal` / `.WindowVisualState`
    - `Selection.CanSelectMultiple`, `Grid.RowCount` / `.ColumnCount`, and other patterns.
- **Pattern-availability flags** — `Is<Pattern>PatternAvailable` (e.g. `IsInvokePatternAvailable`,
  `IsTogglePatternAvailable`), derived from FlaUI's pattern library for the current framework.
- **Legacy / MSAA Properties** —
    - **Dot-notation**: `LegacyIAccessible.Name`, `LegacyIAccessible.Role`, `LegacyIAccessible.Value`,
      `.State`, `.Description`, `.Help`, `.KeyboardShortcut`, `.DefaultAction`, `.ChildId`.
    - **Shorthand aliases**: `legacyname`, `legacyvalue`, `legacyrole`, `legacystate`, `legacydescription`,
      `legacyhelp`, `legacykeyboardshortcut`, `legacydefaultaction`, `legacychildid`.
- **Special keyword** — `"all"`: returns **every resolvable attribute** as a JSON string (per W3C, single
  attributes are returned as strings; the `"all"` dump is JSON). The same data is available as a native
  object via `execute('windows: getAttributes', el)`.
- **Synthetic `Text`** — a best-effort text value (TextPattern → ValuePattern → Name → LegacyIAccessible).

```python
# A single pattern/legacy attribute (returned as a string)
value      = element.get_attribute('Value.Value')
legacy_name = element.get_attribute('LegacyIAccessible.Name')
can_invoke  = element.get_attribute('IsInvokePatternAvailable')

# Everything at once, as a JSON string
all_attributes = element.get_attribute('all')
```

> [!NOTE]
> **Page source** is available via the standard `driver.page_source` and via
> `execute('windows: getPageSource', { elementId })` for a subtree.

### Stability & Anti-Hang
Unlike in-process drivers, every UIA call runs inside a separate sidecar process on a dedicated, cancellable
STA worker. The timeouts are **nested** so the gentlest layer fires first
(`UIA ≈20s < watchdog 30s < RPC 35s < hard-deadline 40s`; see [`docs/02-architecture/stability.md`](docs/02-architecture/stability.md)):

1. **UIA `ConnectionTimeout` / `TransactionTimeout`** (`flaui:connectionTimeout` / `flaui:transactionTimeout`) —
   defaulted *below* the watchdog so a frozen COM call self-aborts before a thread needs poisoning.
2. **Per-operation wall-clock watchdog** (`flaui:operationTimeout`).
3. **STA worker poisoning** — a hung worker thread is abandoned and replaced.
4. **Serialized operation queue** — one UIA call at a time, no cross-talk.
5. **Hard-deadline + honest failure** — every RPC settles within the hard-deadline even if the inner layers
   fail; a dead/unresponsive sidecar then **fails the session** with `invalid session id` (kill the wedged
   process, tell the client to create a new session). Opt into silent recycle/re-attach with
   `flaui:autoRecycle: true`.

Orphan guard: the sidecar self-exits on parent (Appium) death (stdin-EOF heartbeat) **and** after
`flaui:idleTimeout` (default 5 min) with no command — so a forgotten session can't leave a ~180 MB process behind.

The net effect: a frozen target app fails *that command* in seconds (not a 60 s hang), the session and Appium
server keep working, and a truly dead backend ends the session cleanly instead of hanging or silently lying.

### PowerShell Execution
Run PowerShell directly from a test. Requires the `power_shell` insecure feature (see
[Security](#-security--insecure-features)). PowerShell is an opt-in convenience here — it is **not** the
backend (the backend is FlaUI).

```python
# Execute a command string
driver.execute_script('powershell', {'command': 'Get-Process Notepad'})

# Execute a script string
driver.execute_script('powershell', {'script': '$p = Get-Process Notepad; $p.Kill()'})

# Set the timeout for this call (ms); defaults to 60000 if omitted
driver.execute_script('powershell', {'command': 'Start-Sleep 5; "done"', 'timeout': 10000})
```

---

## 🛠 Platform-Specific Extensions

All extensions are invoked via `driver.execute_script("windows: <methodName>", args)`, where `args` is a
**single object** of named parameters (this driver uses Appium 3's `executeMethodMap`).

- To target an element, pass `{ 'elementId': element.id }`. As a convenience you may also pass the
  `WebElement` itself as the sole argument (`driver.execute_script('windows: invoke', element)`) — it
  serializes to the W3C element key, which the command accepts.
- Extra parameters go in the same object, e.g. `{ 'elementId': element.id, 'value': 'New Value' }`. (Unlike
  some Windows drivers, a trailing positional `value` argument is **not** read — put it in the object.)

### Mouse & Pointer

#### `windows: click`
A single (or repeated) mouse click via real `SendInput`.

| Name | Type | Required | Description | Default |
| :--- | :--- | :--- | :--- | :--- |
| `elementId` | `string` | no | Element to click. With no `x`/`y`, clicks the element's clickable point (falls back to rect center, with `scrollIntoView`). With `x`/`y`, treats them as an offset from the element's top-left. | — |
| `x`, `y` | `number` | no | Click coordinates. Without `elementId`, absolute screen coordinates; with `elementId`, an offset. If both are omitted with no element, uses the current cursor position. | cursor pos |
| `button` | `string` | no | `left`, `middle`, `right`. | `left` |
| `times` | `number` | no | Number of clicks (e.g. `2` for double-click). | `1` |
| `modifierKeys` | `string[] \| string` | no | Keys held during the click: `Shift`, `Ctrl`, `Alt`, `Win`. | — |
| `durationMs` | `number` | no | Hold time between press and release. | `0` |
| `interClickDelayMs` | `number` | no | Pause between clicks when `times > 1`. | `100` |

```python
driver.execute_script('windows: click', {'elementId': element.id, 'button': 'right', 'times': 2})
driver.execute_script('windows: click', {'x': 500, 'y': 300})
```

#### `windows: clickAndDrag`
A click-and-drag gesture.

| Name | Type | Required | Description | Default |
| :--- | :--- | :--- | :--- | :--- |
| `startElementId` / `startX` / `startY` | `string` / `number` | no | Drag start (element center, element-relative offset, or absolute / cursor). | cursor pos |
| `endElementId` / `endX` / `endY` | `string` / `number` | no | Drag end (same semantics as start). | cursor pos |
| `button` | `string` | no | `left`, `middle`, `right`. | `left` |
| `durationMs` | `number` | no | Drag duration; `0` does an instant drag. | `0` |
| `modifierKeys` | `string[] \| string` | no | Keys held during the drag. | — |

```python
driver.execute_script('windows: clickAndDrag', {
    'startElementId': src.id, 'endElementId': dst.id, 'durationMs': 2000})
```

#### `windows: hover`
Moves the cursor from a start point to an end point.

| Name | Type | Required | Description | Default |
| :--- | :--- | :--- | :--- | :--- |
| `elementId` / `x` / `y` | `string` / `number` | no | Target point (element center, element-relative offset, or absolute / cursor). | cursor pos |
| `modifierKeys` | `string[] \| string` | no | Keys held during the move. | — |
| `durationMs` | `number` | no | Move duration; `0` moves instantly. | `0` |

#### `windows: scroll`
A mouse-wheel scroll gesture.

| Name | Type | Required | Description | Default |
| :--- | :--- | :--- | :--- | :--- |
| `elementId` / `x` / `y` | `string` / `number` | no | Scroll anchor point. | cursor pos |
| `deltaX` | `number` | no | Horizontal wheel movement (positive = right). | `0` |
| `deltaY` | `number` | no | Vertical wheel movement (positive = forward/away). | `0` |
| `amount` | `number` | no | Wheel-click amount (alternative to deltas). | `1` |
| `modifierKeys` | `string[] \| string` | no | Keys held during the scroll. | — |

```python
driver.execute_script('windows: scroll', {'elementId': element.id, 'deltaY': -120})
```

### Keyboard

#### `windows: keys`
Customized keyboard input via real `SendInput`.

| Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `actions` | `KeyAction[] \| KeyAction` | yes | One or more key actions. |

**`KeyAction`** — `{ text }` to type a string, `{ virtualKeyCode, down }` for explicit key down/up, and
`{ pause }` to insert a delay (ms) between actions.

```python
driver.execute_script('windows: keys', {'actions': [
    {'virtualKeyCode': 0x10, 'down': True},   # Shift down
    {'text': 'Hello World'},
    {'virtualKeyCode': 0x10, 'down': False},  # Shift up
]})
```

#### `windows: typeDelay`
Sets the per-character delay (ms) for the session.

| Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `delay` | `number` | yes | Delay in milliseconds. |

```python
driver.execute_script('windows: typeDelay', {'delay': 100})
```

### Element Operations
Each targets an element (`{ elementId }`, or the element passed as the sole argument) and calls the
corresponding UIA pattern in FlaUI.

| Command | UIA Pattern | Description |
| :--- | :--- | :--- |
| `windows: invoke` | Invoke | Activate the element (button press, link, etc.). |
| `windows: setValue` | Value | Set the element's value: `{ elementId, value }`. Falls back to keyboard typing for controls without ValuePattern. |
| `windows: getValue` | Value | Read the element's value. |
| `windows: toggle` | Toggle | Toggle a checkbox/toggle control. |
| `windows: expand` | ExpandCollapse | Expand the element. |
| `windows: collapse` | ExpandCollapse | Collapse the element. |
| `windows: scrollIntoView` | ScrollItem | Scroll the element into view. |
| `windows: setFocus` | (UIA SetFocus) | Set keyboard focus to the element. |
| `windows: getAttributes` | — | Return the full attribute set as a native object (object form of `get_attribute('all')`). |

```python
driver.execute_script('windows: invoke', element)                                  # element as sole arg
driver.execute_script('windows: setValue', {'elementId': element.id, 'value': 'New Value'})
driver.execute_script('windows: toggle', {'elementId': element.id})
```

### Selection Management
For controls supporting the Selection / SelectionItem patterns. Each targets an element (`{ elementId }`).

| Command | Description |
| :--- | :--- |
| `windows: select` | Select the element. |
| `windows: addToSelection` | Add the element to the current selection. |
| `windows: removeFromSelection` | Remove the element from the current selection. |
| `windows: isMultiple` | Whether the container supports multiple selection. |
| `windows: selectedItem` | The currently selected item. |
| `windows: allSelectedItems` | All currently selected items. |

### Window Management
Window-state commands (WindowPattern) target the window element (`{ elementId }`):

| Command | Description |
| :--- | :--- |
| `windows: maximize` | Maximize the window. |
| `windows: minimize` | Minimize the window. |
| `windows: restore` | Restore the window to normal state. |
| `windows: close` | Close the window. |

Bringing a window to the front:

#### `windows: setWindowForeground`
Brings a window to the foreground using an **escalating** strategy — basic foreground first, then stronger
methods (topmost toggle, minimize/restore) if needed. This is the robust counterpart to a plain `setFocus`.

| Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `elementId` | `string` | no | The window element to bring forward. |

> `windows: click` already performs a basic bring-on-top before clicking. Use `setWindowForeground` when a
> window needs stronger foregrounding (e.g. it stays behind another window).

#### `windows: setProcessForeground`
Brings the main window of a named process to the foreground.

| Name | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `process` | `string` | yes | Process name, e.g. `notepad.exe`. |

### System & State

#### `windows: setClipboard` / `windows: getClipboard`
Get or set the Windows clipboard as plaintext **or** a PNG image.

| Name | Type | Required | Description | Default |
| :--- | :--- | :--- | :--- | :--- |
| `b64Content` (set only) | `string` | yes | Base64-encoded content to set. | — |
| `contentType` | `string` | no | `plaintext` or `image`. | `plaintext` |

```python
driver.execute_script('windows: setClipboard', {'b64Content': 'SGVsbG8=', 'contentType': 'plaintext'})
text = driver.execute_script('windows: getClipboard', {'contentType': 'plaintext'})
```

#### `windows: launchApp` / `windows: closeApp`
Launch or close the app under test within the current session.

#### `windows: getPageSource`
Returns the UIA page source. With `{ elementId }`, returns the subtree rooted at that element.

#### File transfer
Standard Appium file commands (insecure features): `execute('pushFile', {...})`,
`execute('pullFile', {...})`, `execute('pullFolder', {...})`.

#### Actions API
The standard **W3C Actions** API (pointer + key) is fully supported via `driver.perform_actions(...)` /
`driver.release_actions()`.

---

## 🔒 Security / Insecure Features

`powershell` (incl. `appium:prerun`), `pullFile`/`pullFolder`, and `pushFile` are Appium *insecure
features*. This driver targets **isolated VM environments** and never trades a feature for security
(ADR-015).

**Recommended (dev/test, isolated VM) — enable everything with one flag:**
```bash
appium --relaxed-security
```

**Locked-down alternative — enable only specific features** (the `--allow-insecure` CLI flag does not parse
multiple scoped features reliably, so use a config file):
```jsonc
// appium-config.json
{ "server": { "allow-insecure": [
  "flauinative:power_shell", "flauinative:pull_file", "flauinative:push_file"
] } }
```
```bash
appium --config appium-config.json
```

> **Trust boundary (no sandbox):** once enabled, `power_shell` runs arbitrary code and the file commands
> read/write any path — by design. Enable only when the server and all clients are trusted.

---

## 🛠 Development

```bash
npm install          # install dependencies
npm run build        # transpile TypeScript -> JS
npm run test:unit    # cross-platform unit tests (no Windows needed)
```

Rebuilding the sidecar requires the **.NET 8 SDK** (end users do not — the prebuilt exe is self-contained):
```bash
dotnet publish sidecar -r win-x64 --self-contained -p:PublishSingleFile=true
```

### Project docs

Start at [`docs/README.md`](docs/README.md) — a top-down reading map (overview → architecture → reference).

| Doc | What |
|---|---|
| [`docs/01-overview/`](docs/01-overview/) | Introduction & quickstart |
| [`docs/02-architecture/`](docs/02-architecture/) | Overview (C4), request-flow, **stability** (timeouts/anti-hang), backend-flaui, sidecar-internals |
| [`docs/03-reference/appium-api.md`](docs/03-reference/appium-api.md) | **Canonical API reference** — W3C + `windows:` commands & status |
| [`docs/03-reference/rpc-protocol.md`](docs/03-reference/rpc-protocol.md) | The TS↔C# JSON seam (ops, envelope, errors) |
| [`docs/03-reference/capabilities.md`](docs/03-reference/capabilities.md) · [`locators-xpath.md`](docs/03-reference/locators-xpath.md) | Capabilities; locators & XPath |
| [`docs/04-design/`](docs/04-design/) | ADRs, known-issues, security |
| [`docs/05-operations/clean-reinstall.md`](docs/05-operations/clean-reinstall.md) | Fast clean wipe-and-reinstall on Windows test boxes |
| [`docs/internal/`](docs/internal/) | Maintainer notes (changelog, audit, subagents) |

### Known gaps / roadmap
`-windows uiautomation` raw-condition locator, rawView page source, active-element / `getDeviceTime`,
the `typeDelay` per-character delay (the cap is accepted but not yet applied), and
run-verification of the **win-arm64** prebuilt on real ARM hardware. Screen recording is **out of scope**
(ADR-012). See [`docs/04-design/known-issues.md`](docs/04-design/known-issues.md).
