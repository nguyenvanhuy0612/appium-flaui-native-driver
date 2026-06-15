# Introduction

*Overview · updated 2026-06-04*

**appium-flaui-native-driver** is an [Appium 3](https://appium.io) driver for **Windows desktop
UI automation**. It drives Universal Windows Platform (UWP), Windows Forms, WPF, and classic Win32
apps on Windows 10 and later. The driver itself is TypeScript; the actual UI Automation runs in a
compiled, self-contained **C#/.NET 10 FlaUI sidecar** ([FlaUI](https://github.com/FlaUI/FlaUI),
UIA3 engine) that the driver talks to over `localhost` HTTP/JSON. Published to npm as
`appium-flaui-native-driver` (currently `0.1.0-beta.15`); the automation name is **`FlaUINative`**.

Everything goes through FlaUI's UIA3 layer — patterns, conditions, and real `SendInput`
mouse/keyboard — never PowerShell string-scraping. This unlocks the full UI Automation surface,
a complete XPath 1.0 engine, and rich attribute retrieval matching what `inspect.exe` shows.

## Why a FlaUI sidecar

Two architectural choices define the driver, both in service of stability:

- **UIA3 isolated in a separate process.** UIA COM calls can freeze when a target app hangs. By
  running the engine in its own sidecar behind a cancellable worker and nested timeouts, a frozen
  app fails *that one command* in seconds — the session and the Appium server survive instead of
  hanging.
- **A structured-JSON seam, not PowerShell.** The driver and sidecar communicate via structured
  JSON ops that map 1:1 onto FlaUI's `ConditionFactory`, not PowerShell text. This is faster, more
  reliable, and injection-safe. (PowerShell exists only as an opt-in convenience escape hatch, not
  the backend.)

## Who it's for

Teams automating Windows desktop applications under Appium 3 — functional UI tests, smoke suites,
and CI on Windows lab/VM machines. It is a natural fit where you would otherwise reach for
WinAppDriver or a PowerShell-backed Windows driver but want better reliability against hangs.

## Design priority

**Stability > coverage > speed.** When these conflict, the more stable choice wins, even at the cost
of a feature or some latency. This ordering explains the out-of-process sidecar, the nested
anti-hang timeouts, the bundled self-contained binary (offline, zero end-user setup), and the
fail-fast "a dead backend ends the session cleanly rather than hanging or silently lying" behavior.

## Platform support

**Windows only.** Verified on **win-x64** (Windows 10/11, or Windows Server 2016+ with the Desktop
Experience feature — Server Core is not supported). The **win-arm64** binary is cross-built but
**not yet run-verified** on ARM hardware.

## Next

- [Architecture overview](../02-architecture/overview.md) — how the driver, sidecar, and seam fit together.
- [Quickstart](./quickstart.md) — install, start Appium, and run your first session.
