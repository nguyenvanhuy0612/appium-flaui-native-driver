# appium-flaui-native-driver

An Appium 3 driver for **Windows desktop UI automation**, backed by a compiled **C# / .NET FlaUI sidecar**
(UIA3 by default, UIA2 opt-in, plus MSAA data via `LegacyIAccessiblePattern`).

- **automationName:** `FlaUINative`
- **driverName** (feature-flag scope prefix): `flauinative`
- **Platform:** Windows only

> **Status: early / work in progress (v0.0.1).** The full stack has been run end-to-end on real Windows
> (session → find → page source against Notepad), but many commands are authored-but-not-yet-verified or
> still planned. See [Status & limitations](#status--limitations) before relying on any feature.

---

## What it is (and why)

This driver forks the proven TypeScript orchestration of
[`appium-novawindows2-driver`](https://github.com/nguyenvanhuy0612/appium-novawindows2-driver) (nova2) but
**replaces nova2's PowerShell backend with a compiled C# FlaUI sidecar** speaking structured JSON over
localhost HTTP. The design priority is **stability first** (then framework coverage, then speed). Unlike a
PowerShell/UIA2-managed backend — where a single hung COM call can freeze the whole session forever — the
C#/UIA3 sidecar gives bounded `ConnectionTimeout`/`TransactionTimeout`, runs every UIA operation on a
dedicated **cancellable** worker thread (so a frozen target app fails fast and the session survives), and
batches subtree/property reads through `CacheRequest`. Compared to Microsoft's WinAppDriver, it tracks
current Appium 3 conventions, ships a self-contained sidecar (no separate server install), and exposes a
structured-op seam plus a richer `windows:` command surface. No `FlaUI.WebDriver` fork is involved — the
high-level logic stays in TypeScript.

---

## Requirements

- **Windows 10 or newer** (x64; `win-arm64` is planned — see limitations).
- **Appium 3** — declared as a peer dependency (`appium@^3.0.0`).
- **Node.js ≥ 20.19** (`^20.19.0 || ^22.12.0 || >=24.0.0`) and **npm ≥ 10**.
- **No .NET install required for end users.** The sidecar ships as a **self-contained, single-file .NET
  publish** — no .NET SDK and no Windows Developer Mode needed on the target machine.

> .NET is only needed by *contributors* who rebuild the sidecar from source.

---

## Install

This driver is not yet published to npm. Install from a local checkout (which must already contain a built
sidecar under `prebuilt/<arch>/FlaUiSidecar.exe`):

```bash
appium driver install --source=local /path/to/appium-flaui-native-driver
```

Planned (once published to npm):

```bash
# Not available yet
appium driver install --source=npm appium-flaui-native-driver
```

---

## Capabilities

`platformName` must be `Windows` and `appium:automationName` must be `FlaUINative`.

| Capability | Required | Values / default | Status |
|---|---|---|---|
| `platformName` | yes | `Windows` | implemented |
| `appium:automationName` | yes | `FlaUINative` | implemented |
| `appium:app` | no | path / launch target for the app under test | implemented |
| `flaui:backend` | no | `uia3` (default) \| `uia2` | implemented |
| `flaui:connectionTimeout` | no | UIA connection timeout, ms | **planned** |
| `flaui:transactionTimeout` | no | UIA transaction timeout, ms | **planned** |
| `flaui:operationTimeout` | no | per-op watchdog, ms (default `30000`) | **planned** |
| `flaui:sidecarPort` | no | pin the RPC port (default: auto) | **planned** |
| `flaui:elementTableMax` | no | element registry cap (default `10000`) | **planned** |
| `flaui:autoRecycle` | no | sidecar recycle circuit breaker (default `true`) | **planned** |

> Only `platformName`, `appium:app`, and `flaui:backend` are currently enforced by the driver's capability
> constraints. The remaining `flaui:*` capabilities are specified in the design but **not yet wired up**;
> passing them today has no effect.

Additional capabilities are planned to carry over from nova2 (e.g. `appium:appArguments`,
`appium:appWorkingDir`, `appium:appTopLevelWindow`, `appium:shouldCloseApp`, `ms:waitForAppLaunch`,
`ms:forcequit`, `delayBeforeClick`, `typeDelay`, etc.) but are **not yet implemented** in this driver.

### Example (JSON capabilities)

```json
{
  "platformName": "Windows",
  "appium:automationName": "FlaUINative",
  "appium:app": "C:\\Windows\\System32\\notepad.exe",
  "flaui:backend": "uia3"
}
```

---

## Locator strategies

| Strategy | Maps to (UIA) |
|---|---|
| `accessibility id` | `AutomationId` property |
| `name` | `Name` property |
| `class name` | `ClassName` property |
| `xpath` | parsed XPath → structured UIA condition tree (see subset below) |

Element IDs are the UIA **RuntimeId** as dot-separated integers (e.g. `42.333896.3.1`) — identical to
nova2, so element references behave the same.

### XPath subset

The XPath engine walks the parsed AST one location step at a time and emits native FlaUI finds. The
following subset is **supported**:

- Absolute and relative location paths (`/Window/Edit`, `Pane/Button`)
- Descendant shorthand `//` (`//Button`, `Window//Edit`)
- Axes: `child`, `descendant`, `descendant-or-self`, `self`, `attribute` (terminal `@x` returns values)
- Node-name tests, `*` wildcard, `node()`
- Attribute equality / inequality predicates (`[@Name="OK"]`, `[@Name!="OK"]`)
- Conjunction / disjunction predicates (`[@Name="a" and @ClassName="b"]`, `... or ...`)
- Positional predicates (`[1]`, `[last()]`, `(//ListItem)[1]`)
- Union of paths (`//A | //B`)

**Not yet supported** (these throw a clear `InvalidSelectorError` rather than misbehaving):

- Reverse / sibling axes: `parent`, `ancestor(-or-self)`, `following(-sibling)`, `preceding(-sibling)`, `namespace`
- XPath string functions in predicates: `contains()`, `starts-with()`, `normalize-space()`, etc.
- Arithmetic / relational numeric predicates beyond a bare `[n]` / `[last()]`
- `@*` wildcard-attribute comparisons

---

## `windows:` commands

These are exposed via Appium 3's execute-method mechanism. Each operates on a single element (passed as
`elementId`) through the corresponding UIA pattern, and maps to a structured action op handled by the C#
sidecar. Invoke them as execute methods, e.g. `windows: invoke` with args `{ "elementId": "<id>" }`.

| Command | Description |
|---|---|
| `windows: invoke` | Invoke the element (Invoke pattern) — the default "click". |
| `windows: expand` | Expand the element (ExpandCollapse pattern). |
| `windows: collapse` | Collapse the element (ExpandCollapse pattern). |
| `windows: toggle` | Toggle the element's state (Toggle pattern). |
| `windows: select` | Select the element (Selection pattern). |
| `windows: addToSelection` | Add the element to the current selection. |
| `windows: removeFromSelection` | Remove the element from the current selection. |
| `windows: setFocus` | Move keyboard focus to the element. |
| `windows: scrollIntoView` | Scroll the element into view. |
| `windows: setValue` | Set the element's value (Value pattern); pass `value` in args. |
| `windows: maximize` | Maximize the window (Window pattern). |
| `windows: minimize` | Minimize the window (Window pattern). |
| `windows: restore` | Restore the window (Window pattern). |
| `windows: close` | Close the window (Window pattern). |

> These `windows:` command builders are unit-verified, but their execution against live applications has
> **not yet been verified end-to-end** on Windows. Treat them as work-in-progress.

Standard W3C commands currently implemented in the driver: `getPageSource`, `getAttribute`, `click`
(maps to UIA Invoke), `setValue`, and `clear`. W3C Actions-based pointer/keyboard input is planned for a
later phase.

---

## Security / feature flags (Appium 3)

Appium 3 requires every *insecure* feature to be scoped by the driver name. The features reserved by this
driver (per ADR-008) are:

```bash
# Enable a specific insecure feature
appium --allow-insecure=flauinative:record_screen
appium --allow-insecure=flauinative:pull_file
appium --allow-insecure=flauinative:push_file

# Wildcard form (any driver)
appium --allow-insecure='*:record_screen'
```

Reserved feature names: `record_screen`, `pull_file`, `push_file`.

> **Not yet implemented.** Screen recording and file pull/push are reserved by name only; the underlying
> commands do not exist in v0.0.1. There is intentionally **no PowerShell-execution command** in this
> driver (use nova2 if you need that).

---

## Status & limitations

This is an early build. Be honest with yourself about what works:

**Verified end-to-end on real Windows (Appium 3.5.0 → driver → sidecar UIA3 → Notepad):**

- Session creation (`POST /session`), sidecar spawn and lifecycle
- Find by direct strategy (e.g. `class name`)
- Page source (`getPageSource`) returning correctly-nested XML

**Verified off-device only (unit tests on macOS):**

- Structured op builders, the `windows:` command mapping, the XPath engine (30/30), the RPC client, and
  the sidecar process manager
- The anti-hang scheduler core (watchdog cancel + worker-thread poisoning/replacement) via xUnit

**In progress / not yet verified or implemented:**

- Page-source **schema parity with nova2** (tag = `ControlType` programmatic name, relative `x/y/width/height`,
  pattern-specific attributes) — the current XML is correctly nested but not yet schema-matched
- `rawView` page source (the `TreeFilter` is currently always-true)
- Live verification of **attributes, actions, the `windows:` commands, and `setValue`/`clear`/`click`** against real apps
- **W3C Actions** pointer/keyboard input
- The remaining `flaui:*` capabilities (timeouts, recycle, registry cap, pinned port)
- The full **anti-hang behavior** against a genuinely frozen app (only simulated so far)
- Screen recording and file pull/push (feature flags reserved, commands not built)
- **`win-arm64`** binary (only `win-x64` has been built/run)
- npm publication

---

## Relation to nova2

This driver lives **alongside** [`appium-novawindows2-driver`](https://github.com/nguyenvanhuy0612/appium-novawindows2-driver),
not as a replacement. nova2 remains the zero-install PowerShell option; this driver is the higher-stability,
broader-framework option. It deliberately keeps the **same element-id semantics** (UIA RuntimeId) and aims
for an **identical page-source XML schema and locator strategies**, so existing nova2 XPath and tests are
intended to carry over (schema parity is still being finished — see limitations).
