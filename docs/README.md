# Documentation Index

Map of the project's docs, what each is for, and which is authoritative when two disagree.

## Start here

| If you want to… | Read |
|---|---|
| **Try the beta** (install + first session) | **[`BETA.md`](./BETA.md)** · [`RELEASE-0.1.0-beta.1.md`](./RELEASE-0.1.0-beta.1.md) |
| Use the driver (install, caps, commands) | [`../README.md`](../README.md) → [`FUNCTIONS.md`](./FUNCTIONS.md) |
| Know exactly what's supported and its verification status | **[`FUNCTIONS.md`](./FUNCTIONS.md)** — canonical API/status |
| Understand the architecture & the stability design | [`superpowers/specs/2026-06-03-appium-flaui-native-driver-design.md`](./superpowers/specs/2026-06-03-appium-flaui-native-driver-design.md) |
| Understand the **FlaUI backend** (what the engine can do) | [`BACKEND-FLAUI.md`](./BACKEND-FLAUI.md) |
| Know *why* a choice was made | [`DECISIONS.md`](./DECISIONS.md) (ADRs) |
| See what changed and what's verified vs authored | [`CHANGELOG-internal.md`](./CHANGELOG-internal.md) |
| See what's next | [`NEXT-STEPS.md`](./NEXT-STEPS.md) |

## Authority order (source of truth)

When docs disagree, trust in this order: **code** → `FUNCTIONS.md` (current API/status) → `DECISIONS.md`
(rationale) → the design spec (intended architecture; may describe not-yet-built parts) → everything else.

## All docs

| Doc | Purpose | Lifecycle |
|---|---|---|
| [`FUNCTIONS.md`](./FUNCTIONS.md) | Canonical API reference + per-feature support/verification status | living |
| [`DECISIONS.md`](./DECISIONS.md) | Architecture Decision Records (ADR-001…); revisions append, never rewrite | living, append-only |
| [`superpowers/specs/…design.md`](./superpowers/specs/2026-06-03-appium-flaui-native-driver-design.md) | The design: architecture, the JSON-op seam, the five-layer anti-hang model | reference (intent) |
| [`CHANGELOG-internal.md`](./CHANGELOG-internal.md) | Dated work log, separating **verified** (real output) from **authored** | living, newest-first |
| [`NEXT-STEPS.md`](./NEXT-STEPS.md) | Current roadmap | living |
| [`AUDIT-2026-06-03.md`](./AUDIT-2026-06-03.md) | Adversarial code-review findings + remediation tracker | dated snapshot |
| [`SUBAGENTS.md`](./SUBAGENTS.md) | How the project is built by orchestrating subagents | living |
| [`PARITY.md`](./PARITY.md) | Historical compatibility analysis vs a PowerShell-based driver | frozen (historical) |
| [`superpowers/plans/…phase0-1…md`](./superpowers/plans/2026-06-03-phase0-1-spikes-and-skeleton.md) | The original Phase 0–1 implementation plan | frozen (completed) |

## One-paragraph orientation

**FlaUINative** is a standalone, W3C-first Appium 3 driver for Windows UI automation. A thin TypeScript
driver speaks the WebDriver/Appium protocol and forwards **structured JSON ops** over loopback HTTP to a
compiled **C# FlaUI (UIA3) sidecar**, which does all UI Automation on a dedicated, watchdog-bounded worker —
so a frozen target app fails one command fast instead of hanging the session. It is not a port of any other
driver; where an API matches another Windows driver, that's a deliberate compatibility alias.
