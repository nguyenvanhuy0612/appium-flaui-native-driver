# FlaUINative — API Reference & Support Status

The canonical list of everything this driver supports. FlaUINative is a **standalone Appium 3 driver**
designed W3C-first on a C# FlaUI (UIA3) sidecar — it is *not* a port of any other driver; where an API
matches another Windows driver, that is a deliberate compatibility alias, noted as such.

Status: ✅ implemented & **verified on a real Windows machine** · 🟡 implemented, not yet individually
verified · ⬜ planned · ⏸ out of scope by decision.

_Last updated 2026-06-03._

---

## 0. Supported platforms

| Platform | Arch | Status |
|---|---|---|
| Windows 10 / 11 | x64 | ✅ verified end-to-end |
| Windows 10 / 11 | arm64 | 🟡 binary cross-built clean; **not yet run-verified on ARM hardware** |
| Windows Server 2016 / 2019 / 2022 **with Desktop Experience** | x64 | 🟡 declared supported (UIA3 + .NET 8 present; no OS-version gate) |
| Windows Server 2016 / 2019 / 2022 **with Desktop Experience** | arm64 | 🟡 declared; arm64 binary not yet ARM-run-verified |
| Windows **Server Core** (no GUI) | any | ⏸ **unsupported** — no desktop means no UI to automate |

The driver gates **only** on `platformName=Windows` (`inclusionCaseInsensitive:['Windows']`) — there is **no
OS-version check** anywhere in the TS or C# layers, so it runs on any Windows providing UI Automation (UIA3)
and .NET 8. Both Windows 10/11 and Windows Server with Desktop Experience qualify. **Interactive input**
(real click/keys/Actions via SendInput) and foreground-dependent focus require an **active interactive
desktop session** (not Windows Session 0); UIA-only reads/finds/setValue work regardless. arm64 binaries are
selected automatically (`process.arch`) but are cross-built on x64 — declared, not yet hardware-verified.

---

## 1. Session capabilities

| Capability | Status | Behavior |
|---|---|---|
| `platformName` | ✅ | `Windows` (required; no OS-version gate — see §0) |
| `appium:automationName` | ✅ | `FlaUINative` (required) |
| `appium:app` | ✅ | path of the app to launch, or **`Root`** for a whole-desktop session |
| `appium:appTopLevelWindow` | ✅ | attach to a running window by hex HWND |
| `appium:appArguments` | 🟡 | command-line arguments for the launched app |
| `appium:appWorkingDir` | 🟡 | working directory for the launched app |
| `appium:shouldCloseApp` | ✅ | default `true`; on session end close the launched app (or the attached window) |
| `flaui:backend` | ✅ uia3 / 🟡 uia2 (experimental) | UIA backend selection. **uia2 is experimental:** the anti-hang layer-1 timeouts (`ConnectionTimeout`/`TransactionTimeout`) are a UIA3-only property surface; under uia2 they do not apply, so uia2 falls back on layers 2–5 only. |
| `flaui:connectionTimeout` / `flaui:transactionTimeout` | 🟡 | UIA timeouts (ms); UIA3 only. Defaults 60000. |
| `flaui:operationTimeout` | 🟡 | per-op watchdog (ms); default 30000. |
| `flaui:elementTableMax` | 🟡 | element registry cap; default 10000. |
| `flaui:autoRecycle` | 🟡 | layer-5 sidecar recycle on transport failure; default `true`. |
| `ms:waitForAppLaunch` | ✅ | settle delay (seconds) after launch |
| `appium:prerun` | 🟡 | `{script}`/`{command}` PowerShell at session start. **Gated** — requires the `flauinative:power_shell` insecure feature, or session creation fails with a feature error (ADR-014). |
| `appium:includeContextElementInSearch` | ✅ | default `true`: searches include the context element itself |
| Misc compat caps | ✅ accepted | `powerShellCommandTimeout`, `treatStderrAsError`, `postrun`, `typeDelay`, `smoothPointerMove`, `delayBeforeClick/AfterClick`, `releaseModifierKeys`, `convertAbsoluteXPathToRelativeFromElement`, `isolatedScriptExecution`, `ms:forcequit` — accepted (no rejection), currently advisory no-ops |

## 2. Locator strategies

| Strategy | Status | Resolves against |
|---|---|---|
| `accessibility id` / `id` | ✅ | UIA `AutomationId` |
| `name` | ✅ | UIA `Name` |
| `class name` | ✅ | UIA `ClassName` |
| `tag name` | ✅ | UIA `ControlType` (`Button`, `Document`, …) |
| `xpath` | ✅ | full XPath 1.0 (§3) |
| `-windows uiautomation` | ⬜ | raw JSON condition grammar (ADR-006) |

## 3. XPath 1.0 engine

✅ **Axes (13):** child, descendant(-or-self), self, parent, ancestor(-or-self), following(-sibling),
preceding(-sibling), attribute, namespace(∅).
✅ **Functions (24):** contains, starts-with, string, concat, substring(-before/-after), string-length,
normalize-space, translate, count, last, position, name, local-name, boolean, not, true, false, number,
floor, ceiling, round, sum.
✅ **Operators:** `= != < <= > >=`, `+ - * div mod`, `and or not()`, `@*`, unions.
✅ Structural predicates push down to native UIA conditions (21 typed properties); function predicates
evaluate in TS over bulk-fetched attributes. Positional semantics (`//X[1]` vs `(//X)[1]`, `last()`,
`position()`), case-insensitive tags + control-type aliases, `//text()`→empty, malformed → `invalid selector`.
⬜ `id()` function, attribute-value extraction (`…/@Name` as the result).

## 4. W3C WebDriver endpoints

| Endpoint (method) | Driver command | Status |
|---|---|---|
| `POST /session` · `DELETE /session/:id` | createSession / deleteSession | ✅ |
| `GET /status` | server status | ✅ |
| `POST /session/:id/element` (+ `/elements`, from-element variants) | find | ✅ |
| `POST /element/:id/click` | click — **real pointer click** at center | ✅ |
| `POST /element/:id/value` | setValue (ValuePattern) | ✅ |
| `POST /element/:id/clear` | clear | ✅ |
| `GET /element/:id/text` | getText (Value ?? Name) | ✅ |
| `GET /element/:id/attribute/:name` · `/property/:name` | getAttribute / getProperty (UIA props + `Value`, `IsSelected`, `BoundingRectangle`, `NativeWindowHandle`, `HasKeyboardFocus`, …) | ✅ |
| `GET /element/:id/name` | getName → tag (ControlType) | ✅ |
| `GET /element/:id/rect` | getElementRect | ✅ |
| `GET /element/:id/enabled` · `/displayed` · `/selected` | element state | ✅ |
| `GET /session/:id/source` | getPageSource — nested XML, full UIA attribute schema, relative coords, pattern attrs. **Live traversal** (one COM read per property), bounded by the per-op watchdog; a single-`CacheRequest` pass is a planned optimization, not yet shipped. `rawView` is accepted but ignored (control view only). | ✅ |
| `GET /session/:id/screenshot` · `/element/:id/screenshot` | PNG base64 (FlaUI Capture) | ✅ |
| `GET /session/:id/title` | getTitle (root window) | ✅ |
| `GET /window` · `/window/handles` | getWindowHandle(s) | ✅ |
| `GET/POST /window/rect` | get/setWindowRect (TransformPattern) | ✅ |
| `POST /window/maximize` · `/minimize` | maximize/minimizeWindow | ✅ |
| `POST /session/:id/actions` · `DELETE` | performActions / releaseActions — pointer (move/down/up; viewport/pointer/element origins) + key (specials→VK, printables) + pause | ✅ |
| `POST /session/:id/execute/sync` | execute → extension commands (§5) & scripts (§6) | ✅ |
| `POST /appium/device/push_file` · `pull_file` · `pull_folder` | pushFile / pullFile / pullFolder (base64; folder → ZIP) | ✅ |
| `GET /window_handle` (focused el), `getDeviceTime` | — | ⬜ |

**Error contract (W3C):** `no such element` (404, incl. never-seen/malformed ids) · `stale element
reference` (404, aged-out ids) · `invalid selector` (400) · `timeout` · `invalid session id` · `unknown
error` — mapped end-to-end from the sidecar through appium error classes.

## 5. Extension commands (`execute('windows: <cmd>', [args])`)

Element args accept `{elementId}` or the W3C element object.

| Group | Command | Status | Notes |
|---|---|---|---|
| UIA patterns | `invoke` | 🟡 | InvokePattern |
| | `toggle`, `expand`, `collapse` | 🟡 | Toggle/ExpandCollapse |
| | `select`, `addToSelection`, `removeFromSelection` | 🟡 | SelectionItem |
| | `setFocus`, `scrollIntoView` | 🟡 | Focus / ScrollItem |
| | `setValue` | ✅ | ValuePattern.SetValue |
| | `getValue` | ✅ | ValuePattern read |
| | `isMultiple`, `selectedItem`, `allSelectedItems` | 🟡 | SelectionPattern reads |
| | `getAttributes` | 🟡 | all UIA props as JSON |
| | `maximize`, `minimize`, `restore`, `close` | 🟡 | WindowPattern |
| Real input | `keys` | ✅ | text + virtualKeyCode down/up + pause (SendInput) |
| | `click` | ✅ | element/coords, left/right, times |
| | `hover`, `scroll` | ✅ | pointer move / wheel (deltaX/Y) |
| | `clickAndDrag` | 🟡 | start/end element or coords |
| Clipboard | `setClipboard`, `getClipboard` | ✅ | `plaintext` AND `image` (PNG) — both verified |
| App/session | `launchApp`, `closeApp` | 🟡 | relaunch (re-roots session) / close |
| | `setProcessForeground` | 🟡 | by process name |
| | `getPageSource` | 🟡 | element-scoped source |
| | `setWindowForeground` | ✅ | Win32 SetForegroundWindow+AttachThreadInput on the session window |
| | `typeDelay`, `cacheRequest` | 🟡 | accepted (advisory no-ops) |

## 6. Script pass-throughs (`execute('<script>', [args])`)

| Script | Status | Security |
|---|---|---|
| `powershell` `{script}` → stdout | ✅ | requires `flauinative:power_shell`. Bounded: child process killed (whole tree) after `powerShellCommandTimeout` ms (default 60000) → W3C `timeout`. |
| `pullFile` `{path}` / `pushFile` `{path,data}` / `pullFolder` `{path}` | ✅ | `flauinative:pull_file` / `push_file` |

**Enabling insecure features (Appium 3).** Recommended for isolated VMs (ADR-015): enable everything with
one flag — `appium --relaxed-security`. To lock down to specific features instead, use a config file (the
`--allow-insecure` CLI flag can't take multiple scoped features):
```json
{ "server": { "allow-insecure": ["flauinative:power_shell", "flauinative:pull_file", "flauinative:push_file"] } }
```
`appium --config <file>`.

**⚠ Trust boundary (no sandbox).** These are *insecure features* by design:
- **`power_shell`** (incl. `appium:prerun`) runs **arbitrary** PowerShell on the host with the Appium
  server's privileges. Anyone who can reach the Appium endpoint with this feature enabled can run any code.
- **`pull_file` / `push_file` / `pull_folder`** expose the **entire filesystem**: ANY absolute path is
  readable (pull) or writable (push). There is **no path allow-list and no sandbox**.

Enable these only when the Appium server and every connecting client are fully trusted (e.g. a local CI
box you own). They are OFF unless explicitly scoped via the config above.

## 7. Stability architecture

Five-layer anti-hang:
1. **UIA3 Connection/TransactionTimeout** (UIA3 only; see uia2 note in §1).
2. **Per-op watchdog** — wall-clock timeout on the UIA worker; fail-fast, the Appium session survives.
3. **STA worker poisoning & replacement** — a frozen COM call abandons its thread; a fresh STA worker
   takes over. Past a small budget of poisoned threads the scheduler raises a fatal signal → layer 5.
4. **Serial queue / backpressure** — the scheduler serializes in-flight ops (`SemaphoreSlim(1,1)`), so
   only one op runs at a time as designed.
5. **Sidecar recycle (circuit breaker)** — on a **transport failure** (sidecar dead / connection refused),
   the TS layer recycles the sidecar process (deduped via a single restart promise), replays the stored
   `/session` body to **re-attach** (relaunch the app, or re-attach by `appTopLevelWindow`), then retries
   the failed op **once**; a second failure surfaces a clear `unknown error`. Toggle with `flaui:autoRecycle`.

Plus: self-contained sidecar exe (no .NET/Dev-Mode for users), stdout port handshake + stdin-EOF heartbeat
(no orphans). Layers 1–4 + the scheduler are unit-tested; layer-5 recycle is unit-tested at the transport
seam. The dedicated **frozen-app E2E + 30-min stress remain planned** (not yet run).

## 8. Out of scope / planned

| Item | Status |
|---|---|
| Screen recording | ⏸ dropped (ADR-012, user decision) |
| PowerShell-backend internals of other drivers | ⏸ N/A by design |
| `-windows uiautomation` raw condition | ⬜ |
| rawView page source (flag accepted but ignored — control view only) · active element · getDeviceTime | ⬜ |
| win-arm64 prebuilt | 🟡 cross-built clean (~195 MB); not yet run-verified on ARM hardware |
| Windows Server (Desktop Experience) support | 🟡 declared (no OS-version gate); Server Core ⏸ unsupported |
| typeDelay/smoothPointerMove/delay* effects | ⬜ |
| W3C-first own test suite | ✅ unit 110, smoke 1/1, **e2e 69/69** on the Windows box |
