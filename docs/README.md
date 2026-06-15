# Documentation

*Index · reading map · updated 2026-06-05*

**FlaUINative** is a standalone, W3C-first Appium 3 driver for Windows UI automation. A thin
**TypeScript driver** speaks the WebDriver/Appium protocol and forwards **structured JSON ops**
over loopback HTTP to a compiled **C#/.NET 10 FlaUI sidecar**, which does all UI Automation
(UIA3/UIA2 + MSAA legacy) on a dedicated, watchdog-bounded STA worker — so a frozen target app
fails one command fast instead of hanging the session. It is not a port of any other driver;
where an API matches another Windows driver, that's a deliberate compatibility alias.

These docs read **top-down**: start with what the driver is, then how it's built, then the
exact contracts. Read in the order below.

## Start here (reading order)

1. **Overview** — what it is and how to run it: `01-overview/`
2. **Architecture** — how it works, from the big picture down to the C# files: `02-architecture/`
3. **Reference** — the exact contracts you code against: `03-reference/`

Then dip into `04-design/` for *why*, and `05-operations/` for day-to-day tasks.

## Authority order (source of truth)

When two docs disagree, trust in this order:

**code** → `03-reference/` (current contracts) → `04-design/decisions.md` (ADRs / rationale)
→ `02-architecture/` (explanatory) → `archive/` (historical, may be stale).

## The map

### 01-overview/ — what it is, how to start
- `introduction.md` — what FlaUINative is, the two-process model, design priorities (stability > coverage > speed).
- `quickstart.md` — install the driver, set capabilities, run a first session.

### 02-architecture/ — how it works
- `overview.md` — the big picture: the two processes, the JSON-op seam, C4 context/container.
- `request-flow.md` — the life of one command, from a W3C request down to a FlaUI call and back.
- `stability.md` — the multi-layer anti-hang model: UIA timeouts, the op watchdog, thread poisoning, sidecar recycle, idle/heartbeat self-exit.
- `backend-flaui.md` — what the FlaUI engine can and can't do (patterns, MSAA legacy, capabilities the driver builds on).
- `sidecar-internals.md` — file-by-file tour of the C# sidecar and the STA worker model.

### 03-reference/ — the exact contracts
- `capabilities.md` — every session capability (`appium:app`, `flaui:*` knobs, attach-vs-launch).
- `appium-api.md` — the W3C/Appium command surface and the `windows:` extension commands.
- `rpc-protocol.md` — the loopback HTTP/JSON seam: endpoints, op shapes, error envelopes.
- `locators-xpath.md` — supported locator strategies and how XPath compiles to UIA conditions.

### 04-design/ — why it's built this way
- `decisions.md` — Architecture Decision Records (ADR-001…); revisions append, never rewrite.
- `known-issues.md` — current limitations, sharp edges, and workarounds.
- `security.md` — the security model and the insecure features gated behind `--relaxed-security`.

### 05-operations/ — running it day to day
- `clean-reinstall.md` — the fast/clean driver reinstall recipe (avoids `appium driver uninstall`).

### internal/ — working notes (not for end users)
- `changelog-internal.md` — dated work log; separates **verified** (real output) from **authored**.
- `audit-2026-06-03.md` — adversarial code-review findings + remediation tracker.
- `subagents.md` — how the project is built by orchestrating subagents.

### archive/ — frozen historical material
- `parity-nova2.md` — historical analysis vs an older PowerShell-based UIA driver (frozen reference).
- `attribute-parity-startbtn.md` — attribute-parity investigation against inspect.exe (Start button case study).
- `phase0-1-plan.md` — the original Phase 0–1 spikes-and-skeleton implementation plan (completed).
- `release-0.1.0-beta.1.md` — the first beta release notes.

> When in doubt, follow the **authority order** above and fall back to the code.
