# Release Notes — v0.1.0-beta.1 (2026-06-03)

First beta of **FlaUINative**, a standalone, W3C-first Appium 3 driver for Windows UI automation backed by a
compiled C# FlaUI (UIA3) sidecar. **→ Start here: [`BETA.md`](./BETA.md).**

## Highlights

- **Full W3C surface** — session/find/element/source/screenshots/window/**Actions**/execute/**file transfer**.
- **Locators** — `accessibility id` · `id` · `name` · `class name` · `tag name` · **full XPath 1.0**
  (13 axes, 24 functions, operators, `@*`, positional semantics).
- **30 `windows:` commands** — UIA patterns, **real mouse/keyboard input**, **clipboard (text + PNG image)**,
  app/session control. Plus `execute('powershell' | 'pullFile' | 'pushFile' | 'pullFolder', …)`.
- **Stability is the headline** — every UIA call runs in the sidecar on a watchdog-bounded, serialized
  worker. **Proven on Windows:** against an app whose UI thread is frozen for 60 s, a command returns a W3C
  `timeout` in ~5 s, the server stays responsive, and the session recovers. Five-layer anti-hang
  (UIA3 timeouts → per-op watchdog → STA worker poisoning → serialization/backpressure → sidecar recycle).
- **Zero end-user setup** — self-contained sidecar exe; no .NET, no Developer Mode, no separate server.
- **Permissive by design (ADR-015)** — built for isolated VMs; run `appium --relaxed-security`; no feature
  sacrificed for security.

## Verified on a real Windows machine (Appium 3.5, `--relaxed-security`)

- W3C conformance suite: **e2e 75/75 + smoke 1/1**.
- Unit: **116 mocha + 5 C# scheduler**.
- Clean install from this tarball + first session: green.
- A third-party PowerShell-based driver's own e2e suite (kept as a benchmark): FlaUINative scored
  equal-or-better on every suite.

## Platforms

Windows 10/11 and Windows Server 2016+ **with Desktop Experience**, **x64** (fully verified) and **arm64**
(binary cross-built; not yet run-verified on ARM hardware). Server Core not supported.

## How to try it

The beta is packaged as `appium-flaui-native-driver-0.1.0-beta.1.tgz` (~147 MB; embeds the self-contained
sidecars). Install with `appium driver install --source=local <tgz>`, then follow [`BETA.md`](./BETA.md).
On the project test box it is already installed and runnable via `appium --relaxed-security`.

## Known limitations

`-windows uiautomation` raw-condition locator, rawView page source, active-element, getDeviceTime,
`typeDelay`/`smoothPointerMove`/`delay*` effects are not implemented yet. `uia2` backend is experimental.
Page source uses live traversal (a single-pass cache optimization is planned). Screen recording is out of
scope (ADR-012). 30-minute soak/stress is deferred.

## Feedback

Capture the capabilities, the command/selector, and the Appium debug log (`appium --log-level debug`).
A hang is a bug — the driver is built to fail-fast and keep the session alive; report the timing if it doesn't.
