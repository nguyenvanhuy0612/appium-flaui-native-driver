# Next Steps — Appium FlaUI Native Driver

Working roadmap. Full history: [`CHANGELOG-internal.md`](./CHANGELOG-internal.md); current API status:
[`FUNCTIONS.md`](./FUNCTIONS.md). _Refreshed 2026-06-03 (late)._

## Where we are

Functional, pre-release. Verified on the real Windows box (`172.16.10.44`, Appium 3.5, `--relaxed-security`):
full W3C command surface, XPath 1.0, 30 `windows:` commands (incl. real input, clipboard text+image), file
transfer, attach/Root sessions, window commands, PowerShell escape hatch. **W3C e2e 74/74 + smoke 1/1; 116
unit + 5 C# tests.** The adversarial audit (26 findings) has been **fully remediated** (security/stability/
protocol/docs). Platforms declared: Win 10/11 + Server 2016+ Desktop Experience, x64 + arm64.

## Remaining roadmap (priority order)

1. **Stability — finish the live proofs (code already in place):**
   - Frozen-app hang-injection **E2E** on Windows: assert watchdog fail-fast + session survival + worker
     poisoning + layer-5 sidecar recycle/re-attach end-to-end (the code paths exist and are unit-covered;
     this is the live proof). _Note: 30-min session-stress is **deferred** per the user._
2. **Packaging & release:**
   - CI: build TS + sidecar (both arches), run unit + C# tests; release pipeline.
   - First npm publish → split the two ~190 MB self-contained binaries via per-arch `optionalDependencies`
     (`os`/`cpu` filters) so each consumer pulls only its own (ADR-013).
   - Run-verify the **arm64** binary on real ARM Windows hardware.
3. **API gaps (small):** `-windows uiautomation` raw JSON-condition locator (ADR-006), rawView page source
   (raw TreeWalker), active-element, getDeviceTime, `typeDelay`/`smoothPointerMove`/`delay*` effects.
4. **Performance (correctness-preserving):** single-pass `CacheRequest` page-source builder (currently live
   traversal — correct and watchdog-bounded, just chattier).
5. **Quality of life:** surface structured sidecar logs into the Appium log; wire any remaining `flaui:*`
   knobs from spec §7.

## Posture & out of scope (decided)

- **Security: permissive by default (ADR-015)** — isolated-VM target, `--relaxed-security` recommended,
  no feature sacrificed, no sandbox. Scoped `allow-insecure` is the optional locked-down alternative.
- **Out of scope:** screen recording (ADR-012); PowerShell-as-backbone / PS-specific caps (ADR-007,
  partially reversed by ADR-014 which makes PowerShell an opt-in gated *feature*).
