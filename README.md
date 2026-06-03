# appium-flaui-native-driver

An **Appium 3** driver for **Windows desktop UI automation**, backed by a compiled **C#/.NET FlaUI
sidecar** (UIA3 by default, UIA2 opt-in). Designed **W3C-first** and **stability-first**.

- **automationName:** `FlaUINative` · **driverName / feature-flag scope:** `flauinative`
- **Platform:** Windows 10/11 and Windows Server 2016+ **with Desktop Experience** (x64 + arm64)

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

**Operating system (one of):**

- **Windows 10 / 11** — x64 or arm64.
- **Windows Server 2016, 2019, or 2022 — with the _Desktop Experience_ feature** (x64 or arm64).

The driver requires only `platformName=Windows`; there is **no OS-version gate** in the code — it runs on
any Windows that provides UI Automation (UIA3) and .NET 8, which both Windows 10/11 and Windows Server with
Desktop Experience do.

> **Server Core (no GUI) is NOT supported.** UI automation needs a desktop/window manager; Server Core has
> none, so there is nothing to automate. Use **Server with Desktop Experience** instead.
>
> **Interactive session required for input.** Real mouse/keyboard input (`click`, `keys`, Actions) uses
> SendInput, which only reaches a window on an **active, interactive desktop**. Running Appium in Windows
> Session 0 (e.g. as a service or over SSH) can find/read/set values via UIA, but interactive input and
> foreground-dependent focus need an interactive logon session (e.g. an autologon console, or launch via a
> Task Scheduler task with an interactive logon type). This applies equally to client Windows and Server.

**Architecture binaries:** the self-contained sidecar ships for both `win-x64` and `win-arm64`; the driver
picks the matching one at session start via `process.arch`. The **arm64 binary is cross-built and produced
clean, but has not yet been run-verified on real ARM hardware** — x64 is fully verified end-to-end. See the
size note below.

**Other:**

- **Appium 3** (`appium@^3.0.0`) · Node ≥ 20.19, npm ≥ 10.
- End users need **no .NET** (the sidecar is self-contained). Contributors rebuilding the sidecar need the
  .NET 8 SDK.

> **Package size note (ADR-013):** because each sidecar is a self-contained single-file exe (the .NET
> runtime is embedded), the prebuilt binaries are ~180 MB (x64) and ~195 MB (arm64) — ~375 MB bundled.
> This is the deliberate cost of zero end-user setup and offline reliability; per-arch splitting is planned
> for the first public npm publish (see `docs/DECISIONS.md` ADR-013).

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
typeDelay/smooth-pointer effects, frozen-app stress E2E. The **win-arm64 prebuilt is now produced**
(cross-built on x64) but not yet run-verified on ARM hardware. Screen recording is **out of scope**
(ADR-012).
