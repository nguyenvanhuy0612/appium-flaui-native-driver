# Architecture Decision Records (ADR)

*Design · ADR log (append-only) · updated 2026-06-05*

Decisions locked by Claude (acting as senior dev) on 2026-06-03, per the user's delegation
("you decide, implement, and document thoroughly"). Each can be revisited; revisions append a new
dated entry rather than rewriting history.

Related: [`design spec`](../superpowers/specs/2026-06-03-appium-flaui-native-driver-design.md) · [`known-issues`](./known-issues.md)

---

## ADR-001 — Driver name & identifiers
**Decision:** npm package `appium-flaui-native-driver`; `automationName` = **`FlaUINative`**;
`driverName` = **`flauinative`**.

**Why:** Must not collide with existing `FlaUI` automationName (FlaUI.WebDriver / picakia driver) nor with
`NovaWindows2`. `driverName` also becomes the mandatory feature-flag scope prefix in Appium 3
(`--allow-insecure=flauinative:<feature>`), so it must be short, lowercase, and unique.

**Consequences:** All manifest fields, capability examples, and docs use these names. Renaming later means
touching the manifest + feature-flag prefixes + published package name.

---

## ADR-002 — Backend = compiled C# FlaUI sidecar (not PowerShell, not FlaUI.WebDriver fork)
**Decision:** A self-contained C#/.NET sidecar built on **FlaUI core** (UIA3 default, UIA2 opt-in, MSAA via
`LegacyIAccessiblePattern`), communicating with the TS driver over **localhost HTTP/JSON**, one coarse call
per logical operation.

**Why:** Stability is the #1 requirement. UIA3 in C# gives bounded timeouts (`ConnectionTimeout`/
`TransactionTimeout`), a dedicated cancellable worker thread, and `CacheRequest` batching — none of which
a PowerShell/UIA2-managed backend can offer. We do **not** fork FlaUI.WebDriver: keeping the orchestration
(driver, routing, XPath engine, page-source consumption) in TypeScript lets us own that surface directly
rather than re-implement it in C#.

**Consequences:** Requires a Windows build/test environment and a .NET toolchain. Ships per-arch binaries.

---

## ADR-003 — The seam = structured JSON ops (not PowerShell strings)
**Decision:** The TS↔sidecar seam is `sendBackendOp(op: BackendOp): Promise<BackendResult>` — the TS
backend builders emit structured JSON ops and the sidecar interprets them — rather than shipping
PowerShell command *strings* across the boundary.

**Why:** PowerShell *text* is meaningless to a C# sidecar. A structured op contract decouples the two
layers cleanly and maps 1:1 onto FlaUI's `ConditionFactory`. The XPath engine models conditions as
structured objects already, so it slots straight onto this seam.

**Consequences:** the backend lives under `lib/backend/*` (op types + builders); everything above the seam
(driver, routing, xpath AST, page-source consumption) is plain TypeScript and independent of the backend
transport.

---

## ADR-004 — Transport = localhost HTTP/JSON
**Decision:** Kestrel HTTP server in the sidecar on `127.0.0.1:<auto-port>`; TS is the HTTP client.

**Why:** Easiest to debug (curl/logs), naturally decouples the RPC-accepting thread from the UIA worker
thread (critical for the anti-hang design), and proven viable by FlaUI.WebDriver. Speed overhead of HTTP is
acceptable because speed is explicitly secondary to stability.

**Consequences:** Need free-port selection + handshake (sidecar prints port on stdout line 1) and a health
endpoint. No TCP port is hard-coded.

---

## ADR-005 — Input (mouse/keyboard) stays in the TS layer for v1
**Decision:** Keep Win32 input (`winapi`/koffi) in TypeScript initially; do not move it into the sidecar yet.

**Why:** Keeps the sidecar smaller and the input path easy to iterate on. Moving input into the sidecar (to
unify timing with UIA focus state) is a later optimization, only if focus-race bugs appear.

**Consequences:** Input timing and UIA state live in two processes; acceptable for v1. Revisit per spec §11.1.

**Revision 1 (2026-06-03): input moved INTO the sidecar via `FlaUI.Core.Input`.** When implementing Phase 5
we found FlaUI ships native `Mouse`/`Keyboard` (SendInput wrappers) — far less code than a TS koffi/Win32
layer, the same library already in use, and input timing now lives next to UIA state. Verified on
Windows: pointer click focuses the target (HasKeyboardFocus=true) and `Keyboard.Type` text reads back via
ValuePattern. The TS `winapi` path is no longer planned.

---

## ADR-006 — `-windows uiautomation` strategy = structured-condition JSON grammar
**Decision:** The raw UIA condition locator accepts a **JSON condition object** mirroring the internal
`Condition` model (`{kind:"property"|"and"|"or"|"not", ...}`), not C#/PowerShell condition syntax.

**Why:** A JSON grammar is safe (no code injection), maps directly to `ConditionFactory`, and reuses the
exact model the XPath engine already produces. A C#/PowerShell condition syntax would only make sense if
PowerShell *were* the backend — it isn't.

**Consequences:** Grammar to be documented in the driver README.

---

## ADR-007 — No PowerShell-execution command in v1
**Decision:** Do **not** ship a `windows: powershell` command or `prerun`/`postrun` PowerShell features in v1.

**Why:** This driver's entire premise is escaping PowerShell's instability. Adding a PS-exec path
reintroduces the failure mode and an insecure feature to maintain.

**Consequences:** Drop related capabilities (`powerShellCommandTimeout`, `isolatedScriptExecution`,
`prerun`, `postrun`, `treatStderrAsError`). If demand appears later, add it back as a scoped insecure feature.

> **REVERSED by ADR-014 (2026-06-03):** PowerShell is reintroduced as a scoped, gated insecure feature
> (`flauinative:power_shell`). It is an opt-in convenience, **not** the execution backbone. See ADR-014.

---

## ADR-008 — Insecure feature flags to scope (Appium 3)
**Decision:** Scope exactly these under the `flauinative:` prefix: `record_screen`, `pull_file`, `push_file`.

**Why:** Appium 3 makes the scope prefix mandatory and throws on unscoped flags. Screen recording and file
transfer are the only genuinely "insecure" capabilities we ship in v1 (ADR-007 removed PowerShell).

**Consequences:** Guard each with `this.assertFeatureEnabled('<feature>')`; document the
`--allow-insecure=flauinative:<feature>` usage in the README.

---

## ADR-009 — Ship sidecar as bundled self-contained binaries
**Decision:** Bundle `dotnet publish --self-contained` single-file binaries for `win-x64` and `win-arm64`
inside the npm package; TS picks by `process.arch` at session start.

**Why:** Offline reliability and zero end-user setup (no .NET SDK, no Developer Mode) — aligns with the
stability priority. Download-on-install (picakia's approach) adds a network failure point.

**Consequences:** Larger package (~30–70 MB/arch). CI must run `dotnet publish` for both arches and commit
artifacts to `prebuilt/` (or attach to releases). Monitor size; revisit if it becomes a problem.

---

## ADR-010 — Command surface via Appium 3 `executeMethodMap`
**Decision:** Declare the `windows:` command surface using `static executeMethodMap` + `this.executeMethod`,
rather than a hand-rolled `EXTENSION_COMMANDS` string map.

**Why:** Appium 3 can introspect/validate manifest-declared execute methods, and the built-in Inspector can
list them. Cleaner, safer, and future-proof.

**Consequences:** The command map is declared once in `executeMethodMap` and validated by base-driver.

---

## ADR-011 — Target Appium 3, drop Appium 2 compatibility
**Decision:** `engines.node` = `^20.19.0 || ^22.12.0 || >=24.0.0`, `engines.npm` = `>=10`,
`peerDependencies.appium` = `^3.0.0`; bump `@appium/base-driver`/`@appium/types` to the Appium-3 line.

**Why:** The user is integrating with Appium 3. Supporting both 2 and 3 doubles the test matrix for no
stated benefit (YAGNI).

**Consequences:** Users must be on Appium 3. Documented as a hard requirement.

---

## ADR-012 — Screen recording dropped from scope (for now)
**Decision (user, 2026-06-03):** `windows: startRecordingScreen` / `stopRecordingScreen` are removed from
the roadmap ("recording tạm thời sẽ bỏ đi"). They would require shipping/locating ffmpeg.

**Consequences:** documented as ⏸ in PARITY/FUNCTIONS; revisit only on explicit request.

---

## ADR-013 — Keep bundled self-contained binaries; revisit per-arch split at first npm publish
**Decision (2026-06-03):** Keep ADR-009's bundled approach — ship both `prebuilt/win-x64/FlaUiSidecar.exe`
and `prebuilt/win-arm64/FlaUiSidecar.exe` inside the package — but acknowledge the real measured size and
set a concrete trigger for switching. Do **not** move to download-on-install or build-on-install.

**Measured reality (this session, on the Windows box, .NET 8.0.421, self-contained single-file):**
win-x64 = 188,927,419 bytes (~180 MB), win-arm64 = 204,733,758 bytes (~195 MB) → **~375 MB packaged**,
roughly 5–6× the ~30–70 MB/arch ADR-009 guessed at. The size comes from `--self-contained` (the whole .NET
runtime is embedded per exe), which is exactly what buys the zero-setup / offline guarantee.

**Options weighed:**
- **(a) Keep both bundled (chosen).** Pros: honors the stability-first, offline, zero-end-user-setup
  premise (no network failure point, no .NET SDK, no Developer Mode); install is a plain file copy; works
  air-gapped. Cons: ~375 MB on disk/registry; a user only ever runs one arch, so half is dead weight.
- **(b) Download-on-install.** Pulls the matching arch from a release asset in a postinstall step. Pros:
  ~190 MB on the wire, only the needed arch. Cons: reintroduces the exact network failure point ADR-009
  rejected; breaks air-gapped/offline installs; postinstall scripts are often disabled in hardened CI.
- **(c) Build-on-install.** Run `dotnet publish` at install time. Pros: smallest package. Cons: requires the
  .NET 8 SDK on **every** end-user machine — directly contradicts the "end users need no .NET" promise and
  the stability priority; slow, and fails where the SDK/toolchain is absent.

**Why (a):** The driver's whole reason to exist is stability and predictability (ADR-002). Trading a hard
network/toolchain dependency for a smaller download is a bad trade for a desktop-automation driver that is
frequently run on locked-down / offline lab and CI machines. Disk is cheaper than a flaky install.

**Mitigation already in place:** TS selects the single arch at session start (`process.arch`), so only one
exe is ever executed; the unused one is inert. `npm pack` ships exactly what's in `files`
(`build` + `prebuilt`).

**Revisit trigger (explicit):** when we first `npm publish` to the public registry, split per-arch so each
consumer downloads only its own ~190 MB. The clean mechanism is two thin platform packages
(`@…/sidecar-win32-x64`, `@…/sidecar-win32-arm64`) referenced as `optionalDependencies` with
`os`/`cpu` filters, the main package falling back to whichever resolved — npm then installs only the
matching arch. We defer that packaging work because (1) distribution today is `appium driver
install --source=local` (a local checkout, where both arches are wanted anyway for cross-arch testing),
(2) the arm64 binary is cross-built but **not yet run-verified on ARM hardware**, so coupling it into a
published sub-package now would be premature. No `package.json` change this session.

**Consequences:** Package stays ~375 MB until first public publish. `prebuilt/` remains in `files`.
Documented honestly in the README size note.

---

## ADR-014 — PowerShell as a scoped, gated insecure feature (reverses ADR-007)

**Decision (2026-06-03):** Support PowerShell execution as an **opt-in, scoped insecure feature**
`flauinative:power_shell`, exposed via the `execute('powershell', [{script|command}])` script **and** the
`appium:prerun` capability. This explicitly **reverses ADR-007** ("No PowerShell-execution command in v1").
PowerShell is **not** the execution backbone (the structured-op C# sidecar remains the backbone, ADR-002/003);
it is a convenience escape hatch for the rare cases where a client needs to run a host command.

**Why this is acceptable now (it wasn't the design's premise):**
- **Opt-in + gated.** Off by default; only available when the operator scopes
  `--allow-insecure=flauinative:power_shell` (config file). The driver calls `this.assertFeatureEnabled('power_shell')`
  **before** running anything — both the `powershell` script path and `appium:prerun` (F23) — so it fails
  **loud** (a clean W3C feature error) rather than silently. base-driver 10.6 provides `assertFeatureEnabled`,
  so the gate is a direct call, never an optional-chained no-op (F22).
- **Runs OUTSIDE the UIA watchdog.** PowerShell executes on its own child process, not on the STA UIA
  worker, so a slow script never occupies or freezes the UIA scheduler. The anti-hang design is unaffected.
- **Bounded (F4).** The child is wrapped in a `CancellationTokenSource` (timeout = `powerShellCommandTimeout`
  ms, default 60s); on expiry it is `Kill(entireProcessTree:true)`ed and mapped to a W3C `timeout` error.
  stdin write + stdout/stderr reads run concurrently to avoid the redirect-pipe deadlock.

**`prerun` note:** `appium:prerun` runs arbitrary PowerShell at session create, so it requires the **same**
`power_shell` feature; a `prerun` request without the feature **fails session creation** with the feature error.

**Trust boundary:** with this feature enabled, any client reaching the endpoint can run arbitrary code with
the Appium server's privileges. Documented as an insecure feature in appium-api.md/README (F24). Same applies
to `pull_file`/`push_file` (whole-filesystem read/write, no sandbox).

**Consequences:** `powerShellCommandTimeout` and `prerun`/`postrun` capabilities are re-honored
(`powerShellCommandTimeout` now actually bounds the child; `postrun` remains accepted/advisory). The feature
set scoped under `flauinative:` (ADR-008) is extended with `power_shell`.

---

**Resolved 2026-06-03 (on the test machine, Appium 3.5.0):** the running Appium bundles
`@appium/base-driver@10.6.0` and `@appium/types@1.5.0`. Pin the driver to these exact versions so the
driver and the server share one base-driver copy. Node 24.16 / npm 11.13 confirmed on the Windows target.

---

## ADR-015 — Security posture: permissive by default, never trade a feature for strictness
**Decision (user, 2026-06-03):** the driver targets **isolated, low-value VM environments**. Security is
**not** strict and **no feature is ever removed, disabled-by-default, or sandboxed for security reasons**.
The recommended dev/test posture is **`appium --relaxed-security`**, which enables every insecure feature
(PowerShell, file transfer) with no per-feature flags.

**Why:** automation runs in throwaway VMs with little/no sensitive data; friction from security gating
costs more than it protects. The value proposition is capability, not lock-down.

**No contradiction with the audit fixes:** the ADR-008/ADR-014 feature gates stay in the code — they are
*standard Appium* and base-driver returns `true` for every feature when `--relaxed-security` is on, so the
gates pass and nothing is blocked. They matter only to an operator who deliberately wants lock-down (who
then uses scoped `allow-insecure`). Permissive default and loud-failing gates coexist: the gates never
sacrifice a feature; they give a clean error *only if* an operator chose to disable one.

**Consequences:** docs recommend `--relaxed-security` first; scoped `allow-insecure` is the optional
locked-down alternative. No path allow-list / no PowerShell sandbox (F24 is documentation, not a
restriction). Verified 2026-06-03: full W3C e2e **74/74** + smoke **1/1** under `appium --relaxed-security`.

---

## ADR-016 — Capability-surface redesign & standalone framing
**Decision (2026-06-05):** Treat this as a **standalone driver in its own right** — a FlaUI-native Appium 3
Windows driver — not "a previous driver with a new backend." Where its API happens to match another Windows
driver, that is a deliberate compatibility alias, not inheritance. Alongside the framing, rework the
attach/launch and PowerShell capability surface:

- **`appName`** now means a **regex matched case-insensitively against the window TITLE** (e.g.
  `SecureAge.*`), not an executable name.
- **`processName`** is **new**: an exact executable name, case-insensitive (accepts with or without `.exe`),
  attaching to that process's outermost window.
- **`appProcessId`** is **removed** (attach by PID); `appName`/`processName`/`appTopLevelWindow` cover the
  attach cases.
- **`createSessionTimeout`** is **new**: ms, default **60000** — the poll budget to wait for an attach
  target (`appTopLevelWindow`/`appName`/`processName`) to appear before failing. This is a standard
  appium-windows-driver capability.
- **Attach precedence** is fixed and documented: `appTopLevelWindow` → `appName` → `processName` →
  `app` (launch-or-attach) → `Root`.
- **`powerShellCommandTimeout` is dropped as a capability.** Instead `execute('powershell',
  [{script|command, timeout?}])` takes a **per-call `timeout`** (ms, default **60000**). This supersedes
  ADR-014's consequence that the cap is re-honored.
- **Dropped no-op caps:** `delayBeforeClick`, `delayAfterClick`, `smoothPointerMove`, `releaseModifierKeys`,
  `isolatedScriptExecution` — they were accepted but never did anything, so they are gone rather than
  pretending to be tunables. `typeDelay` is still **accepted** but its per-character delay is **not yet
  applied** (kept because the cap is harmless and may be wired later).
- **`convertAbsoluteXPathToRelativeFromElement`** is now **implemented**: when `true`, a find-from-element
  whose XPath starts with `//` is rewritten to `.//`, giving the legacy "absolute = from the context
  element" semantics. **`postrun`** is now **implemented** (PowerShell on session teardown, gated by the
  same `power_shell` feature as `prerun`).

**Why:** The driver stands on its own — FlaUI-native UIA3, the C# sidecar, and the anti-hang model are the
value, not lineage. The cap surface is realigned with **appium-windows-driver** conventions
(`createSessionTimeout`, title-regex `appName`, `processName`) so clients written for the standard Windows
driver transfer cleanly, and per-call PowerShell timeouts are more honest than a session-wide cap for an
out-of-scheduler escape hatch. Removing no-op caps avoids advertising knobs that do nothing.

**Consequences:** Clients using `appProcessId` or `powerShellCommandTimeout` must migrate
(`processName`/`appName` for attach; per-call `timeout` for PowerShell). Docs (`capabilities.md`,
`appium-api.md`, README) updated to match.
