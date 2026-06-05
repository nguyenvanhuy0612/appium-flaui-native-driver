# Capabilities — session reference

*Reference · updated 2026-06-05*

> Complete list of every capability the FlaUINative driver accepts, defined in code by the
> `constraints` object in [`lib/driver.ts`](../../lib/driver.ts) — the single source of truth for
> capability names and types. W3C clients prefix non-standard caps with the `appium:` vendor
> namespace (e.g. `appium:app`); the `flaui:` and `ms:` caps are already vendor-namespaced and pass
> through as written.
>
> Timeout caps below are deliberately **nested** so the most graceful layer fires first. This doc
> does **not** restate the nesting values — see [stability](../02-architecture/stability.md) for the
> single-source map.

## Standard / launch

| Capability | Type | Default | Description |
|---|---|---|---|
| `platformName` | string | — (required) | Must be `Windows` (case-insensitive). No OS-version gate. |
| `app` | string | — | Path of the app to launch, or `Root` for a whole-desktop session. |
| `appArguments` | string | — | Command-line arguments for the launched app. |
| `appWorkingDir` | string | — | Working directory for the launched app. |
| `shouldCloseApp` | boolean | `true` | On session end, close the launched app (or the attached window). |
| `createSessionTimeout` | number (ms) | `60000` | Poll budget to wait for an attach target (`appTopLevelWindow` / `appName` / `processName`) to appear before failing session creation. |

One of `app`, `appTopLevelWindow`, `appName`, or `processName` is required; session creation fails otherwise.

## Attach modes

Attach to an already-running app instead of launching one. Use exactly one.

| Capability | Type | Default | Description |
|---|---|---|---|
| `appTopLevelWindow` | string | — | Attach to a running window by hex HWND (e.g. `0x000A1234`). |
| `appName` | string | — | Regex matched **case-insensitively against the window TITLE** (e.g. `SecureAge.*`); attaches to the first matching top-level window. |
| `processName` | string | — | Exact executable name, case-insensitive (with or without `.exe`, e.g. `SecureAge` / `SecureAge.exe`); attaches to that process's outermost window. |

### Attach precedence

When multiple attach/launch caps are present, the session root is resolved in this order:

`appTopLevelWindow` → `appName` → `processName` → `app` (launch-or-attach) → `Root` (whole desktop).

If none resolves within `createSessionTimeout`, session creation fails.

## `flaui:*` tuning

| Capability | Type | Default | Description |
|---|---|---|---|
| `flaui:backend` | string | `uia3` | UIA backend: `uia3` or `uia2`. uia2 is experimental — the layer-1 UIA timeouts don't apply under it (UIA3-only property surface). |
| `flaui:connectionTimeout` | number (ms) | derived | UIA `ConnectionTimeout`. UIA3 only. Nested below the watchdog — see [stability](../02-architecture/stability.md). |
| `flaui:transactionTimeout` | number (ms) | derived | UIA `TransactionTimeout`. UIA3 only. Nested below the watchdog — see [stability](../02-architecture/stability.md). |
| `flaui:operationTimeout` | number (ms) | `30000` | Per-op watchdog. Also sets the per-op RPC client timeout (`+grace`) — see [stability](../02-architecture/stability.md). |
| `flaui:elementTableMax` | number | `10000` | Element registry cap in the sidecar. |
| `flaui:idleTimeout` | number (ms) | `newCommandTimeout + 120000` | Sidecar idle self-exit (orphan guard). `newCommandTimeout: 0` disables it; override only for power users — see [stability](../02-architecture/stability.md). |
| `flaui:autoRecycle` | boolean | `false` | Opt-in silent sidecar recycle + re-attach on transport failure. When off, a dead/wedged sidecar fails the session (`invalid session id`). |

## Behaviour / `appium:*`

The standard appium-windows-driver caps the driver honours, plus a few advisory flags it accepts (rather than rejects) without yet acting on.

| Capability | Type | Default | Description |
|---|---|---|---|
| `appium:newCommandTimeout` | number (s) | base-driver default | Idle-command reaping. Drives the sidecar idle bound (`flaui:idleTimeout`) — see [stability](../02-architecture/stability.md). |
| `ms:waitForAppLaunch` | number (s) | — | Settle delay after launch; also extends the `/session` launch wait. |
| `ms:forcequit` | boolean | `false` | Force-quit the app on teardown (advisory). |
| `typeDelay` | number (ms) | — | Per-keystroke delay. **Accepted but not yet applied** — keystrokes are sent without an inter-character delay. |
| `includeContextElementInSearch` | boolean | `true` | Searches include the context element itself (e.g. `//Window` matches the session root). |
| `convertAbsoluteXPathToRelativeFromElement` | boolean | `false` | When `true`, a find-from-element whose XPath starts with `//` is rewritten to `.//`, so a leading `//` means "from this context element" rather than "from the document root". |
| `prerun` | object | — | `{script}`/`{command}` PowerShell run at session start. Gated by the `flauinative:power_shell` insecure feature. |
| `postrun` | object | — | `{script}`/`{command}` PowerShell run at session teardown. Gated by the `flauinative:power_shell` insecure feature. |

> **PowerShell timeout:** there is no `powerShellCommandTimeout` capability. Each `execute('powershell', [{script|command, timeout?}])` call takes a per-call `timeout` (ms, default **60000**); PowerShell runs out-of-scheduler, so `flaui:operationTimeout` does not bound it.
