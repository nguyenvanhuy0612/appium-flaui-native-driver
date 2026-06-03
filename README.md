# appium-flaui-native-driver

An **Appium 3** driver for **Windows desktop UI automation**, backed by a compiled **C#/.NET FlaUI
sidecar** (UIA3 by default, UIA2 opt-in). Designed **W3C-first** and **stability-first**.

- **automationName:** `FlaUINative` · **driverName / feature-flag scope:** `flauinative`
- **Platform:** Windows 10+ (x64; arm64 planned)

> **Status: functional, pre-release (v0.0.1).** The full command surface below is implemented; the core
> paths are verified end-to-end on a real Windows machine — including a head-to-head run of a third-party
> driver's e2e suite where FlaUINative scored equal-or-better on every suite. Canonical API/status table:
> [`docs/FUNCTIONS.md`](docs/FUNCTIONS.md).

---

## Why this driver

- **Stability first.** Every UIA call runs in a separate sidecar process on a dedicated, cancellable STA
  worker bounded by watchdogs (UIA3 `ConnectionTimeout`/`TransactionTimeout` + per-op wall clock). A frozen
  target app fails *that one command* fast — the session and the server survive. Five anti-hang layers in
  total (see `docs/superpowers/specs/...design.md` §6).
- **W3C-first.** Pure W3C WebDriver protocol with exact error semantics (`no such element` vs
  `stale element reference`, `invalid selector`, proper HTTP codes), Appium 3 `executeMethodMap`, scoped
  insecure features.
- **Zero end-user setup.** The sidecar ships as a self-contained single-file exe — no .NET install, no
  Developer Mode, no separate server (unlike WinAppDriver-based setups).
- **Full XPath 1.0** engine: 13 axes, all 24 core functions, operators/arithmetic, `@*`, control-type
  aliases, correct positional semantics — structural parts pushed down to native UIA conditions.

## Requirements

- Windows 10+ (x64) · **Appium 3** (`appium@^3.0.0`) · Node ≥ 20.19, npm ≥ 10.
- End users need **no .NET**. Contributors rebuilding the sidecar need the .NET 8 SDK.

## Install

```bash
# from a local checkout containing prebuilt/<arch>/FlaUiSidecar.exe
appium driver install --source=local /path/to/appium-flaui-native-driver
# (npm publish planned)
```

## Quick start

```js
const caps = {
  platformName: 'Windows',
  'appium:automationName': 'FlaUINative',
  'appium:app': 'C:\\Windows\\System32\\notepad.exe',
  // or attach: 'appium:appTopLevelWindow': '0x40344'
  // or whole desktop: 'appium:app': 'Root'
};
```

Common capabilities: `appium:shouldCloseApp` (default true), `appium:appArguments`, `appium:appWorkingDir`,
`flaui:backend` (`uia3`|`uia2`), `ms:waitForAppLaunch` (seconds), `appium:prerun` ({script} PowerShell).
Full table: [`docs/FUNCTIONS.md`](docs/FUNCTIONS.md) §1.

## Supported API (summary — full status table in [`docs/FUNCTIONS.md`](docs/FUNCTIONS.md))

- **Locators:** `accessibility id`, `id`, `name`, `class name`, `tag name` (ControlType), `xpath`
  (full XPath 1.0).
- **W3C commands:** session, find (incl. from-element), click (real pointer), send keys/clear,
  getText/getAttribute/getProperty/getName/rect/enabled/displayed/selected, page source (full UIA attribute
  schema, nested), screenshots (root + element), window (title/handles/rect/setRect/maximize/minimize),
  **Actions API** (pointer + key), execute, **file push/pull/pull-folder**.
- **`windows:` extension commands (30):** UIA patterns (invoke/toggle/expand/collapse/select/…/setValue/
  getValue/getAttributes/window-state), real input (keys/click/hover/scroll/clickAndDrag), clipboard
  (**plaintext + PNG image**), app/session (launchApp/closeApp/setProcessForeground/getPageSource/...).
- **Scripts:** `execute('powershell', {script})`, `execute('pullFile'|'pushFile'|'pullFolder', {...})`.

## Security / insecure features (Appium 3)

`powershell`, `pullFile`/`pullFolder`, `pushFile` are gated behind scoped insecure features. **Note:** the
`--allow-insecure` CLI flag does not parse multiple scoped features reliably — use a config file:

```jsonc
// appium-config.json
{ "server": { "allow-insecure": [
  "flauinative:power_shell", "flauinative:pull_file", "flauinative:push_file"
] } }
```

```bash
appium --config appium-config.json
```

## Testing

- `npm run test:unit` — 110 mocha unit tests (cross-platform).
- W3C-first smoke + e2e conformance suites (raw-protocol client, env-driven via `APPIUM_URL` /
  `TARGET_APP`) — being finalized under `tests/smoke` + `tests/e2e`.
- `tests/nova2-compat/` — a third-party driver's real e2e suite kept as a compatibility benchmark.

## Project docs

| Doc | What |
|---|---|
| [`docs/FUNCTIONS.md`](docs/FUNCTIONS.md) | **Canonical API reference & support status** |
| [`docs/superpowers/specs/…design.md`](docs/superpowers/specs/2026-06-03-appium-flaui-native-driver-design.md) | Architecture & anti-hang design |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | ADRs (incl. ADR-012: screen recording out of scope) |
| [`docs/CHANGELOG-internal.md`](docs/CHANGELOG-internal.md) | Verified-vs-authored work log |
| [`docs/PARITY.md`](docs/PARITY.md) | Historical comparison snapshot vs a PowerShell-based driver |

## Known gaps

`-windows uiautomation` raw-condition locator, rawView page source, active-element/getDeviceTime,
win-arm64 prebuilt, typeDelay/smooth-pointer effects, frozen-app stress E2E. Screen recording is **out of
scope** (ADR-012).
