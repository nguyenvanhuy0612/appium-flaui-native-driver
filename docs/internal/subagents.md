# Subagent Orchestration

This project is built largely by **orchestrating subagents** (the Claude `Agent` tool) rather than one long
linear session. This document explains the roles, the conventions that keep parallel agents from colliding,
and the non-negotiable verification rule. It reflects how the work is *actually* run, not an aspiration.

---

## 1. Roles

Two kinds of roles are used. **Role definitions** live in [`.claude/agents/`](../../.claude/agents/) and can be
invoked via `subagent_type`. In practice most work is dispatched as **task-scoped background agents** with an
explicit, self-contained brief (the role file's spirit, inlined) — because each agent must carry its own
context and the Windows build/run recipe.

| Role | Owns (write scope) | Typical task |
|---|---|---|
| **ts-driver-engineer** | `lib/**` — `driver.ts`, `backend/*` (op contract, RPC client, sidecar process mgr), `commands/*`, `xpath/*`, capabilities, Appium-3 manifest | TypeScript driver work |
| **csharp-sidecar-engineer** | `sidecar/**` — Kestrel host, `UiaScheduler`, `OpInterpreter`, `ElementRegistry`, `PageSourceBuilder`, `ClipboardImage`, `Win32`, anti-hang machinery | C#/FlaUI sidecar work |
| **test-engineer** | `tests/**` — mocha unit, W3C smoke + e2e suites, the nova2 compatibility benchmark | Test authoring / verification |
| **docs-scribe** | `docs/**`, `README.md` | Keep docs in lockstep with code (this project requires thorough, honest docs) |
| **spec-reviewer** | read-only | Adversarial audit against the spec/ADRs before declaring a phase done |

## 2. How a phase is run

```
orchestrator scopes the work
      │
      ├── fan out independent agents IN PARALLEL (background) ── each with: required-reading,
      │     write-scope, the Windows recipe, and crisp acceptance criteria
      │
      ├── agents implement → build → VERIFY on the real Windows box → report
      │
      └── orchestrator reviews each report, reconciles, COMMITS, updates docs + the audit/changelog
```

Adversarial review (`spec-reviewer`) is run after substantive batches; its findings become the next
remediation brief (see [`audit-2026-06-03.md`](./audit-2026-06-03.md)).

## 3. Conventions that prevent collisions

These are enforced by how briefs are written, and are the difference between clean parallelism and clobbered files:

- **Disjoint write scopes.** Two concurrent agents never own the same files. The hard split is
  `lib/**` (TypeScript) vs `sidecar/**` (C#) vs `tests/**` vs `docs/**`. `package.json` is treated as
  single-owner per batch.
- **One driver of the Windows box at a time.** The box (`172.16.10.44`) has a single Appium install, one
  `AppiumSrv` Task Scheduler task, and one linked driver checkout. Only one box-using agent runs at once;
  Mac-only work (unit tests, docs, read-only audit) may run alongside it.
- **Agents do not commit.** They leave changes in the working tree and report. The orchestrator reviews,
  reconciles across agents, and makes the commits — so history stays curated and nothing half-finished lands.
- **The orchestrator owns `CHANGELOG-internal.md`** (written from agent reports) to avoid merge contention.

## 4. The verification rule (non-negotiable)

**Claim only what was actually run.** Every brief instructs the agent to mark results as one of:
**verified** (real command output on the real target), **authored-but-unverified**, or **deferred** (with a
reason) — and to never fake a pass. The Windows test box makes real verification the default for
Windows-only behavior; only genuinely unreachable cases (e.g. ARM hardware) stay "declared, not run-verified",
and they are labelled as such in [`appium-api.md`](../03-reference/appium-api.md).

## 5. The Windows verification recipe (what every box-using brief includes)

- `ssh admin@172.16.10.44` (passwordless, x64). Repo checkout at `~/flaui-driver` (the installed Appium
  driver is linked to it, so a rebuilt `build/` + republished sidecar are live immediately).
- `.NET 8` SDK at `C:\Users\admin\.dotnet\dotnet.exe` (not on PATH). PowerShell over SSH is **base64-encoded**
  (`iconv -t UTF-16LE | base64`) to avoid quoting/CLIXML noise.
- Appium runs via the `AppiumSrv` Task Scheduler task (interactive session, required for real input) →
  `run-appium.ps1` → `appium --config C:\Users\admin\appium-config.json` (binds `0.0.0.0`; the config file
  holds the `allow-insecure` array). Suites run **from the Mac** with `APPIUM_URL=http://172.16.10.44:4723`.
- Single-file `dotnet publish` locks the output exe → `taskkill /F /IM FlaUiSidecar.exe` before republishing.
