# Architecture Decision Records (ADR)

Decisions locked by Claude (acting as senior dev) on 2026-06-03, per the user's delegation
("you decide, implement, and document thoroughly"). Each can be revisited; revisions append a new
dated entry rather than rewriting history.

Related: [`design spec`](./superpowers/specs/2026-06-03-appium-flaui-native-driver-design.md) · [`NEXT-STEPS`](./NEXT-STEPS.md)

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
the PowerShell/UIA2-managed backend can offer. We do **not** fork FlaUI.WebDriver because we want to reuse
nova2's rich TS orchestration rather than re-implement it in C#.

**Consequences:** Requires a Windows build/test environment and a .NET toolchain. Ships per-arch binaries.

---

## ADR-003 — The seam = structured JSON ops (not PowerShell strings)
**Decision:** Replace nova2's `sendPowerShellCommand(cmd: string)` with `sendBackendOp(op: BackendOp):
Promise<BackendResult>`. The TS backend builders emit structured JSON ops; the sidecar interprets them.

**Why:** nova2's builders emit PowerShell *text*, which is meaningless to a C# sidecar. A structured op
contract decouples the two layers cleanly and maps 1:1 onto FlaUI's `ConditionFactory`. The XPath engine
already models conditions as structured objects, so it ports with minimal change.

**Consequences:** `lib/powershell/*` is rewritten as `lib/backend/*` (op types + builders). Everything above
the seam (driver, routing, xpath AST, page-source consumption) is preserved.

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
**Decision:** Keep nova2's `winapi`/koffi Win32 input in TypeScript initially; do not move it into the sidecar yet.

**Why:** Maximizes reuse of working code and keeps the sidecar smaller. Moving input into the sidecar (to
unify timing with UIA focus state) is a later optimization, only if focus-race bugs appear.

**Consequences:** Input timing and UIA state live in two processes; acceptable for v1. Revisit per spec §11.1.

---

## ADR-006 — `-windows uiautomation` strategy = structured-condition JSON grammar
**Decision:** The raw UIA condition locator accepts a **JSON condition object** mirroring the internal
`Condition` model (`{kind:"property"|"and"|"or"|"not", ...}`), not C#/PowerShell condition syntax.

**Why:** A JSON grammar is safe (no code injection), maps directly to `ConditionFactory`, and reuses the
exact model the XPath engine already produces. nova2's C#/PS syntax made sense only because PowerShell
*was* the backend; that rationale is gone.

**Consequences:** A small migration note for users coming from nova2's raw-condition syntax. Grammar to be
documented in the driver README.

---

## ADR-007 — No PowerShell-execution command in v1
**Decision:** Do **not** carry over nova2's `windows: powershell` / `prerun`/`postrun` PowerShell features.

**Why:** This driver's entire premise is escaping PowerShell's instability. Re-adding a PS-exec path
reintroduces the failure mode and an insecure feature to maintain. Users who need PS can still use nova2.

**Consequences:** Drop related capabilities (`powerShellCommandTimeout`, `isolatedScriptExecution`,
`prerun`, `postrun`, `treatStderrAsError`). If demand appears later, add it back as a scoped insecure feature.

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
rather than nova2's hand-rolled `EXTENSION_COMMANDS` string map.

**Why:** Appium 3 can introspect/validate manifest-declared execute methods, and the built-in Inspector can
list them. Cleaner, safer, and future-proof.

**Consequences:** A mechanical migration of the command map during Phase 2/5.

---

## ADR-011 — Target Appium 3, drop Appium 2 compatibility
**Decision:** `engines.node` = `^20.19.0 || ^22.12.0 || >=24.0.0`, `engines.npm` = `>=10`,
`peerDependencies.appium` = `^3.0.0`; bump `@appium/base-driver`/`@appium/types` to the Appium-3 line.

**Why:** The user is integrating with Appium 3. Supporting both 2 and 3 doubles the test matrix for no
stated benefit (YAGNI). nova2 already covers the Appium-2 era.

**Consequences:** Users must be on Appium 3. Documented as a hard requirement.
