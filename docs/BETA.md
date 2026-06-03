# FlaUINative — Beta Try-It Guide

A short, practical guide to installing the beta and driving your first session. For the full API see
[`FUNCTIONS.md`](./FUNCTIONS.md).

## 1. Prerequisites (on the Windows machine)

- **Windows 10/11** or **Windows Server 2016+ with Desktop Experience** (x64 or arm64). _Server Core is not
  supported — no desktop = nothing to automate._
- **Node ≥ 20.19** and **Appium 3** (`npm i -g appium`, verify `appium -v` → 3.x).
- **An interactive desktop session** must be logged in. Real mouse/keyboard input and focus need an active
  desktop (not Session 0). If you drive headless/over-RDP-disconnected, UIA reads/finds/`setValue` still
  work, but `click`/`keys`/Actions focus may not land — run Appium from a logged-in console or an
  interactive-logon Task Scheduler task.
- **No .NET install needed** — the FlaUI sidecar ships self-contained.

## 2. Install the driver

```bash
# from the beta tarball (or a local checkout that contains prebuilt/<arch>/FlaUiSidecar.exe):
appium driver install --source=local C:\path\to\appium-flaui-native-driver        # folder
# or
appium driver install --source=local C:\path\to\appium-flaui-native-driver-<ver>.tgz   # packed tarball

appium driver list --installed     # should show: flauinative@<ver>
```

## 3. Start Appium

For an isolated VM (recommended — enables PowerShell + file transfer with one flag):

```bash
appium --relaxed-security
```

> Lock-down alternative: instead of `--relaxed-security`, pass a config file enabling only specific
> features — see [`FUNCTIONS.md`](./FUNCTIONS.md) §6.

## 4. Your first session

Capabilities:

```jsonc
{
  "platformName": "Windows",
  "appium:automationName": "FlaUINative",
  "appium:app": "C:\\Windows\\System32\\notepad.exe"
  // alternatives:
  //   "appium:app": "Root"                       // whole-desktop session
  //   "appium:appTopLevelWindow": "0x00040344"   // attach to an existing window (hex HWND)
}
```

Useful extra caps: `appium:shouldCloseApp` (default true), `appium:appArguments`, `appium:appWorkingDir`,
`flaui:backend` (`uia3` default | `uia2` experimental), `ms:waitForAppLaunch` (seconds),
`flaui:operationTimeout` (ms, per-op watchdog).

## 5. Quick example (raw W3C over HTTP — no client lib needed)

```bash
SID=$(curl -s -XPOST localhost:4723/session -H 'content-type: application/json' \
  -d '{"capabilities":{"alwaysMatch":{"platformName":"Windows","appium:automationName":"FlaUINative","appium:app":"notepad.exe"}}}' \
  | jq -r .value.sessionId)

# find the editor, type into it, read the page source, screenshot
EL=$(curl -s -XPOST localhost:4723/session/$SID/element -H 'content-type: application/json' \
  -d '{"using":"class name","value":"Edit"}' | jq -r '.value["element-6066-11e4-a52e-4f735466cecf"]')
curl -s -XPOST localhost:4723/session/$SID/element/$EL/value -H 'content-type: application/json' -d '{"text":"hello FlaUINative"}'
curl -s localhost:4723/session/$SID/source | jq -r .value | head -c 300
curl -s -XDELETE localhost:4723/session/$SID
```

WebdriverIO / Appium clients work the same way — set the caps above.

## 6. What works in this beta

Locators (`accessibility id`/`id`/`name`/`class name`/`tag name`/`xpath` full 1.0); element read/write
(click, send keys, clear, getText/attribute/rect/enabled/displayed/selected); page source; screenshots
(screen + element); window commands; **W3C Actions**; **30 `windows:` commands** (UIA patterns, real
input, clipboard text+image, app/session); `execute('powershell'|'pullFile'|'pushFile'|'pullFolder', …)`.
Verified end-to-end on Windows (W3C e2e suite 74/74). See [`FUNCTIONS.md`](./FUNCTIONS.md) for per-feature
status.

## 7. Known limitations

- arm64 binary is cross-built but **not yet run-verified on ARM hardware**.
- `uia2` backend is experimental (UIA3 timeouts don't apply).
- Not yet implemented: `-windows uiautomation` raw-condition locator, rawView page source, active-element,
  getDeviceTime. Screen recording is out of scope.
- Page source uses live traversal (correct, watchdog-bounded; a single-pass cache optimization is planned).

## 8. Reporting issues

Please include: the capabilities used, the exact command/selector, the Appium server log
(`appium --log appium.log --log-level debug`), and — if it's a sidecar/UIA issue — note the target app and
control. If a command hangs, that's exactly what we want to see (it shouldn't): the driver is built to
fail-fast and keep the session alive, so capture the timing.
