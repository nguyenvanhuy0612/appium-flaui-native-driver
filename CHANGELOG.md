# Changelog

All notable changes to **appium-flaui-native-driver** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-beta.24] - 2026-06-17

### Fixed
- **Core W3C conformance bugs** (found by a spec review, confirmed on a real Windows host, fixed,
  and re-verified on-host — `tests/e2e/13-w3c-conformance-bugs.e2e.spec.ts` 8 failing → 9 passing):
  - **Element Send Keys** now translates W3C key codepoints (Enter, Backspace, Tab, arrows, F-keys,
    …) into key presses instead of typing them as literal glyphs (§12.5.3).
  - **New Session** with no launch/attach target capability now returns `session not created`
    instead of `unknown error` (§8.2).
  - **Get Element Property** now returns the JSON-typed value (boolean/number/object) instead of a
    stringified one (§12.4.3).
  - **Element Clear** on a non-editable element now errors `invalid element state` instead of
    silently succeeding (§12.5.2).
  - **Find From Element** now validates the context element for an absolute XPath (stale/invalid
    context → the correct W3C error) instead of silently searching from the root (§12.3.4).
  - **`tag name`** with an unknown control type is now a non-match (Find Elements → `[]`) instead of
    `invalid argument`.

### Added
- W3C conformance regression suite (`tests/e2e/13-*`) and an end-to-end deploy guide
  (`docs/DEPLOY.md`) for building + shipping the driver to a Windows host over SSH.
- Expanded unit coverage: TypeScript 238 → 251, C# 353 → 403.
- CI workflow running the TypeScript unit suite + C# logic suite on every push/PR; E2E/regression
  suites now skip cleanly when no Appium server is reachable.

### Changed
- Documentation reorganized into a numbered, topic-based tree (overview, architecture,
  reference, design, operations) with a docs index; historical notes moved to an archive.

### Added
- Project-wide test and packaging hardening: a W3C-first conformance suite (unit + smoke +
  e2e), and publish safety nets (`prepublishOnly`/`prepack` guards that refuse to publish a
  tarball missing the compiled driver or the self-contained sidecar exe).
- First-release metadata: `LICENSE` (Apache-2.0), repository/bugs/homepage/author/keywords,
  and this public changelog.

## [0.1.0-beta.1] - 2026-06-03

First beta of **FlaUINative**, a standalone, W3C-first Appium 3 driver for Windows UI
automation backed by a compiled C# FlaUI (UIA3) sidecar.

### Added
- **Full W3C surface** — session, find, element reads, page source, screenshots, window
  commands, W3C Actions, `execute`, and file transfer (pull/push file and folder).
- **Locators** — `accessibility id`, `id`, `name`, `class name`, `tag name`, and full
  XPath 1.0 (13 axes, 24 functions, operators, `@*`, positional semantics).
- **30 `windows:` commands** — UIA patterns, real mouse/keyboard input, clipboard
  (text and PNG image), and app/session control, plus PowerShell and file `execute` shortcuts.
- **Zero end-user setup** — a self-contained sidecar exe; no .NET, Developer Mode, or
  separate server required.

### Stability
- Five-layer anti-hang design: every UIA call runs in the sidecar on a watchdog-bounded,
  serialized worker (UIA3 timeouts, per-op watchdog, STA worker poisoning, serialization/
  backpressure, and sidecar recycle). Proven on Windows: against an app whose UI thread is
  frozen for 60 s, a command returns a W3C `timeout` in ~5 s, the server stays responsive,
  and the session recovers.

### Platforms
- Windows 10/11 and Windows Server 2016+ with Desktop Experience. x64 fully verified;
  arm64 cross-built but not yet run-verified on ARM hardware. Server Core is not supported.

### Known limitations
- `-windows uiautomation` raw-condition locator, rawView page source, active-element, and
  `getDeviceTime` are not implemented. The `uia2` backend is experimental. Page source uses
  live traversal. Screen recording is out of scope.

[Unreleased]: https://github.com/nguyenvanhuy0612/appium-flaui-native-driver/compare/v0.1.0-beta.1...HEAD
[0.1.0-beta.1]: https://github.com/nguyenvanhuy0612/appium-flaui-native-driver/releases/tag/v0.1.0-beta.1
