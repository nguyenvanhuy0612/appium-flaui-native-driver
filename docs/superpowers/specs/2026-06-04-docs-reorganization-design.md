# Docs Reorganization — Design Spec

**Date:** 2026-06-04 · **Status:** ✅ migrated (full tree built, links verified) · **Driver:** beta.15

## Goal

Reorganize the project's documentation from a flat 17-file `docs/` directory into a
**top-down information architecture** that reads from high-level design down to implementation,
matching what a complete, professional software project ships. Eliminate content drift by giving
every fact exactly one home.

## Why (problems with the current docs)

Well-authored, accurate, honest status tracking — but **flat and mixing three time/audience layers
in one directory**:

1. **No high-level → implementation spine.** 17 files flat; `docs/README.md` is a flat index, not a
   reading order.
2. **Architecture is split across 4–5 files and drifts.** Architecture lives in the design spec
   §2–6, `BACKEND-FLAUI.md`, `ANTI-HANG.md`, `FUNCTIONS.md §7`, README. **Nested timeouts** are
   repeated in 4 places — changing one default means editing 4 files.
3. **Three doc kinds in one folder:** living/canonical (FUNCTIONS, DECISIONS, ANTI-HANG,
   BACKEND-FLAUI), frozen-historical (PARITY, attribute-parity-startbtn, phase0-1 plan,
   RELEASE-beta.1), one-off scratch (`inspect.startbtn.md` — a 64-line inspect.exe dump, dead weight).
4. **Missing docs a complete project must have:**
   - **RPC protocol spec** — the JSON seam between the TS driver and C# sidecar (envelope, 12 ops,
     condition grammar, error-type map). The heart of the architecture, currently undocumented as a
     unit (only sketched in design spec §4 + the code). **Highest-value gap.**
   - Real architecture diagrams (only scattered ASCII today) — C4 context/container/flow.
   - `CONTRIBUTING.md` — build TS + sidecar, where unit vs e2e tests run, how to add a `windows:`
     command / attribute.
   - Sidecar codebase tour — `BACKEND-FLAUI.md` says what FlaUI *can* do, not what our 11 `.cs`
     files *do*.
   - `KNOWN-ISSUES.md` standalone (item B, arm64 unverified, rawView pending) — currently buried in
     ANTI-HANG.
   - `SECURITY.md` / threat model — only ADR-015 + FUNCTIONS §6 mention it.

## Decisions (locked 2026-06-04)

1. **Framework: Diátaxis + C4.** Split by need (overview / architecture / reference / design / ops);
   use C4 (context → container → component) for the architecture layer. De-facto standard.
2. **History: archive + delete scratch.** Frozen files → `docs/archive/`; `inspect.startbtn.md` is
   deleted (one-off dump).
3. **Rollout: POC two files, then review, then migrate.** No big-bang. POC
   `02-architecture/overview.md` + `03-reference/rpc-protocol.md` as the format/depth template;
   migrate the rest only after the user approves the POC.

## Target structure

```
README.md            ← intro: pitch + quickstart + link into docs/ (keep, trim)
CONTRIBUTING.md      ← 🆕 build/test/add-a-command (contributor onboarding)
CHANGELOG.md         ← public release notes (from RELEASE-beta.1 + summary)

docs/
  README.md          ← top-down reading map (rewrite: narrative, not a flat list)

  01-overview/
    introduction.md   ← 🆕 what it is, why a FlaUI sidecar, who it's for
    quickstart.md     ← install + first session (absorbs BETA.md)

  02-architecture/    ← 🆕 HIGH-LEVEL (C4)
    overview.md       ← C4 context + container diagram                       [POC]
    request-flow.md   ← one op through every layer (flow diagram, from ANTI-HANG)
    stability.md      ← ANTI-HANG.md cleaned up (5-layer, nested timeouts — SINGLE SOURCE)
    backend-flaui.md  ← BACKEND-FLAUI.md (FlaUI as the engine)
    sidecar-internals.md ← 🆕 tour of the 11 .cs files

  03-reference/       ← API layer (lookup)
    capabilities.md   ← 🆕 split from FUNCTIONS §1 (flaui:* / appium:* / ms:*)
    appium-api.md     ← W3C + windows: commands (FUNCTIONS §2-6) — canonical
    rpc-protocol.md   ← 🆕🔑 the JSON seam: envelope, 12 ops, condition, error-map   [POC]
    locators-xpath.md ← XPath 1.0 (FUNCTIONS §3)

  04-design/
    decisions.md      ← DECISIONS.md (ADR 001-015, append-only)
    known-issues.md   ← 🆕 item B, arm64, rawView…
    security.md       ← 🆕 threat model + ADR-015

  05-operations/
    clean-reinstall.md ← CLEAN-REINSTALL.md
    windows-test-box.md ← 🆕 .38 build / .37 test (optional)

  internal/           ← maintainer notes (not product docs)
    changelog-internal.md ← CHANGELOG-internal.md (unchanged)
    audit-2026-06-03.md
    subagents.md

  archive/            ← frozen, clearly historical
    parity-nova2.md
    attribute-parity-startbtn.md
    phase0-1-plan.md  (moved from superpowers/plans)
    release-0.1.0-beta.1.md
    # inspect.startbtn.md → DELETED
```

## Single-source rules (anti-drift)

Every fact has exactly one home; everywhere else links to it.

| Fact | Single home | Others must |
|---|---|---|
| Timeouts / nesting / watchdog | `02-architecture/stability.md` | link, never restate values |
| W3C + `windows:` command surface + status | `03-reference/appium-api.md` | link |
| Capabilities | `03-reference/capabilities.md` | link |
| RPC op shapes / envelope / errors | `03-reference/rpc-protocol.md` | link |
| Design rationale | `04-design/decisions.md` (ADRs) | link |
| Open bugs | `04-design/known-issues.md` | link |

Authority order (unchanged, restated in `docs/README.md`):
**code → reference/ → decisions.md → architecture/ → archive/**.

## File migration map

| Current | Action | New home |
|---|---|---|
| `README.md` (root) | keep, trim | `README.md` |
| `docs/README.md` | rewrite as narrative map | `docs/README.md` |
| `docs/FUNCTIONS.md` | split | `03-reference/{capabilities,appium-api,locators-xpath}.md` + §7 → `architecture/stability.md` |
| `docs/ANTI-HANG.md` | split | `02-architecture/{request-flow,stability}.md` + open item → `04-design/known-issues.md` |
| `docs/BACKEND-FLAUI.md` | move | `02-architecture/backend-flaui.md` |
| `docs/DECISIONS.md` | move | `04-design/decisions.md` |
| `docs/BETA.md` | merge | `01-overview/quickstart.md` |
| `docs/CLEAN-REINSTALL.md` | move | `05-operations/clean-reinstall.md` |
| `docs/CHANGELOG-internal.md` | move | `internal/changelog-internal.md` |
| `docs/AUDIT-2026-06-03.md` | move | `internal/audit-2026-06-03.md` |
| `docs/SUBAGENTS.md` | move | `internal/subagents.md` |
| `docs/PARITY.md` | archive | `archive/parity-nova2.md` |
| `docs/attribute-parity-startbtn.md` | archive | `archive/attribute-parity-startbtn.md` |
| `docs/RELEASE-0.1.0-beta.1.md` | archive | `archive/release-0.1.0-beta.1.md` |
| `docs/superpowers/plans/2026-06-03-*.md` | archive | `archive/phase0-1-plan.md` |
| `docs/inspect.startbtn.md` | **delete** | — |
| `docs/NEXT-STEPS.md` | split | roadmap → `04-design/known-issues.md` (or keep as roadmap.md) |
| — | create | `CONTRIBUTING.md`, `01-overview/introduction.md`, `02-architecture/{overview,sidecar-internals}.md`, `03-reference/rpc-protocol.md`, `04-design/{known-issues,security}.md` |

## New content sources (factual basis)

- **rpc-protocol.md** ← `lib/backend/ops.ts` (BackendOp/Condition/W3CErrorType/BackendResult),
  `sidecar/Program.cs` (`/status` `/session` `/op` handlers, error map `Program.cs:376-384`,
  `Err()` envelope `Program.cs:384`), `lib/backend/rpc-client.ts` (transport, per-op timeout).
- **overview.md** ← driver.ts (FlaUINativeDriver), backend/{sidecar,rpc-client}.ts, sidecar/*.cs.
- **sidecar-internals.md** ← the 11 `.cs` files: Program, OpInterpreter, UiaScheduler,
  ElementRegistry, PropertyResolver(+Logic), PageSourceBuilder, Win32, ClipboardImage.

## Rollout

1. Write this spec (done) + a bite-sized implementation plan.
2. **POC:** write `02-architecture/overview.md` + `03-reference/rpc-protocol.md` as the template.
3. **Review gate:** user approves format + depth.
4. Migrate the rest per the map (parallel subagents per directory), applying single-source rules and
   fixing cross-links. Verify no broken links; keep `keep-docs-current` discipline.
