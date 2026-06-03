# Next Steps — Appium FlaUI Native Driver

Working roadmap. Superseded items live in [`CHANGELOG-internal.md`](./CHANGELOG-internal.md) (full history)
and [`FUNCTIONS.md`](./FUNCTIONS.md) (current API status). _Refreshed 2026-06-03 (evening)._

## Where we are

Phases 0–5 of the original plan are **done and verified on the real Windows box** (`172.16.10.44`):
spikes, skeleton, command surface, XPath 1.0, attach/Root sessions, input layer, Actions API, screenshots,
clipboard (text+image), file transfer, window commands, powershell escape hatch, W3C error contract.
Benchmarked equal-or-better against a third-party driver's own e2e suite. 110 unit tests green.

🔄 **In flight:** the driver's own W3C-first test suite (`tests/smoke` + `tests/e2e`, raw-protocol client) —
subagent building & verifying.

## Remaining roadmap (priority order)

1. **Stability proof (Phase 4 — the headline promise):**
   - Frozen-app E2E: drive an app whose UI thread is deliberately blocked; assert fail-fast + session
     survival + worker poisoning + recovery (unit-proven; needs the live run).
   - Long-run stress: 30-min create/use/delete loop; memory/handle leak watch; flat per-iteration timing.
   - TS-side sidecar recycle (anti-hang layer 5) wiring + test.
2. **Packaging & release:**
   - `win-arm64` publish (script ready; needs a run + smoke on ARM hardware eventually).
   - CI (build TS + sidecar, unit tests; release pipeline; npm publish).
   - Page-source single-pass `CacheRequest` optimization (perf, correctness preserved).
3. **API gaps (small):** `-windows uiautomation` raw JSON condition locator (ADR-006 grammar), rawView
   page source, active element, getDeviceTime, typeDelay/smoothPointerMove effects, scopeSession/
   resetSessionRoot equivalents if demand appears.
4. **Quality of life:** structured sidecar logging surfaced into the Appium log; configurable
   `flaui:*` timeouts already designed in spec §7 — wire the remaining ones.

## Out of scope (decided)

Screen recording (ADR-012) · PowerShell-as-backbone and PS-specific caps (ADR-007).
