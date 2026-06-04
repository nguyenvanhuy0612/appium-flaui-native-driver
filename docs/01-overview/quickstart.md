# Quickstart

*Overview · how-to · updated 2026-06-04*

Get from zero to a first automated interaction. For the full capability list see
[capabilities](../03-reference/capabilities.md); for the command surface see
[Appium API reference](../03-reference/appium-api.md).

## 1. Prerequisites (on the Windows machine)

- **Windows 10/11**, or **Windows Server 2016+ with the Desktop Experience** feature (x64 — Server
  Core has no desktop and is unsupported; arm64 is cross-built but not yet run-verified).
- **Node ≥ 20.19** and **Appium 3** (`npm i -g appium`; verify `appium -v` → 3.x).
- **An interactive desktop session must be logged in.** Real mouse/keyboard input and focus need an
  active desktop (not Session 0). UIA reads/finds work without it, but `click`/`keys`/Actions focus
  may not land — run Appium from a logged-in console or an interactive-logon Task Scheduler task.
- **No .NET install needed** — the FlaUI sidecar ships self-contained.

## 2. Install the driver

```bash
appium driver install --source=npm appium-flaui-native-driver@beta

appium driver list --installed     # should show: flauinative@<ver>
```

(You can also install from a local checkout or tarball with `--source=local <path>`.)

## 3. Start Appium

PowerShell and file transfer are Appium *insecure features*, off by default. For an isolated
dev/test VM the recommended posture enables them all with one flag:

```bash
appium --relaxed-security
```

If you instead need a locked-down setup that enables only specific features, see
[Security](../04-design/security.md). If you use no insecure features, plain `appium` is fine.

## 4. Your first session — capabilities

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

Common extra caps: `appium:shouldCloseApp` (default `true`), `appium:appArguments`,
`appium:appWorkingDir`, `flaui:backend` (`uia3` default | `uia2` experimental),
`ms:waitForAppLaunch` (seconds), `flaui:operationTimeout` (ms, per-op watchdog). Full list in
[capabilities](../03-reference/capabilities.md).

## 5. A minimal first interaction (find + click)

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
    el = driver.find_element('class name', 'Edit')   # find the editor
    el.send_keys('Hello from FlaUI')                 # type into it
    # or a real click via SendInput:
    driver.execute_script('windows: click', {'elementId': el.id})
finally:
    driver.quit()
```

### Raw W3C over HTTP (no client lib)

```bash
SID=$(curl -s -XPOST localhost:4723/session -H 'content-type: application/json' \
  -d '{"capabilities":{"alwaysMatch":{"platformName":"Windows","appium:automationName":"FlaUINative","appium:app":"notepad.exe"}}}' \
  | jq -r .value.sessionId)

EL=$(curl -s -XPOST localhost:4723/session/$SID/element -H 'content-type: application/json' \
  -d '{"using":"class name","value":"Edit"}' | jq -r '.value["element-6066-11e4-a52e-4f735466cecf"]')
curl -s -XPOST localhost:4723/session/$SID/element/$EL/value -H 'content-type: application/json' \
  -d '{"text":"hello FlaUINative"}'
curl -s -XDELETE localhost:4723/session/$SID
```

## Next

- [Appium API reference](../03-reference/appium-api.md) — locators, attributes, and the
  `windows:` command surface (click, keys, patterns, clipboard, file transfer).
- [Capabilities](../03-reference/capabilities.md) — every capability and its default.
