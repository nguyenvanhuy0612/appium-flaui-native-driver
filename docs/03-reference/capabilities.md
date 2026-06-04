# Capabilities — session reference

*Reference · updated 2026-06-04*

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

One of `app`, `appTopLevelWindow`, `appProcessId`, or `appName` is required; session creation fails otherwise.

## Attach modes

Attach to an already-running app instead of launching one. Use exactly one.

| Capability | Type | Default | Description |
|---|---|---|---|
| `appTopLevelWindow` | string | — | Attach to a running window by hex HWND (e.g. `0x000A1234`). |
| `appProcessId` | number | — | Attach by PID; roots the session at the process's outermost window. |
| `appName` | string | — | Attach by executable name (e.g. `SecureAge`). |

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

## nova2-compat / `appium:*`

Accepted for compatibility. Several are currently advisory no-ops (noted below); they are accepted, not rejected.

| Capability | Type | Default | Description |
|---|---|---|---|
| `appium:newCommandTimeout` | number (s) | base-driver default | Idle-command reaping. Drives the sidecar idle bound (`flaui:idleTimeout`) — see [stability](../02-architecture/stability.md). |
| `ms:waitForAppLaunch` | number (s) | — | Settle delay after launch; also extends the `/session` launch wait. |
| `ms:forcequit` | boolean | `false` | Force-quit the app on teardown (advisory). |
| `powerShellCommandTimeout` | number (ms) | `60000` | Bound for `powershell` / `prerun`; runs out-of-scheduler, so `flaui:operationTimeout` does not bound it. |
| `treatStderrAsError` | boolean | — | Compat flag (advisory no-op). |
| `typeDelay` | number (ms) | — | Per-keystroke delay (advisory no-op). |
| `smoothPointerMove` | string | — | Smooth pointer movement (advisory no-op). |
| `delayBeforeClick` | number (ms) | — | Delay before click (advisory no-op). |
| `delayAfterClick` | number (ms) | — | Delay after click (advisory no-op). |
| `releaseModifierKeys` | boolean | — | Release modifier keys after input (advisory no-op). |
| `includeContextElementInSearch` | boolean | `true` | Searches include the context element itself (e.g. `//Window` matches the session root). |
| `convertAbsoluteXPathToRelativeFromElement` | boolean | — | XPath rewrite compat flag (advisory no-op). |
| `isolatedScriptExecution` | boolean | — | Script isolation compat flag (advisory no-op). |
| `prerun` | object | — | `{script}`/`{command}` PowerShell run at session start. Gated by the `flauinative:power_shell` insecure feature. |
| `postrun` | object | — | `{script}`/`{command}` PowerShell run at session end (advisory no-op). |
