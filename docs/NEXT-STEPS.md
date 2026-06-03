# Roadmap — Remaining Phases

Current API status: [`FUNCTIONS.md`](./FUNCTIONS.md). History: [`CHANGELOG-internal.md`](./CHANGELOG-internal.md).
_Refreshed 2026-06-03 (post beta.3)._

## Done (shipped in beta, verified on Windows)

Session lifecycle (launch / attach / `Root`), find (a11y id/id/name/class/tag/**XPath 1.0**), element
read/write, page source (nova2 schema), screenshots, window commands, **W3C Actions**, **30 `windows:`
commands** (incl. real input, clipboard text+image, file transfer, bring-on-top click + escalating
foreground), W3C error contract, five-layer anti-hang (**frozen-app hang-injection E2E proven**). Published:
`appium-flaui-native-driver@0.1.0-beta.3` (npm, win-x64) + private GitHub repo.

---

## Phase A — Function-behavior parity & correctness  ← **NEXT (user-flagged)**

Go function-by-function; compare exact semantics with nova2 (reference only — implement the FlaUI-idiomatic
way, not PowerShell). The gap today is that reads expose only a flat fixed property set.

- **`getProperty` / `getAttribute` — full property resolution** (the headline of this phase):
  - **UIA pattern dot-notation**: `Value.Value`, `Toggle.ToggleState`, `RangeValue.Value|Minimum|Maximum|
    SmallChange`, `ExpandCollapse.ExpandCollapseState`, `Scroll.HorizontalScrollPercent|…`, `Window.CanMaximize|
    CanMinimize|IsModal|WindowVisualState`, `Selection.*`, `Grid.RowCount|ColumnCount`, `Table.*`, etc. →
    via FlaUI `el.Patterns.<X>.PatternOrDefault?.<Prop>`.
  - **Legacy / MSAA**: `LegacyIAccessible.Name|Value|Role|State|Description|Help|KeyboardShortcut|
    DefaultAction|ChildId`, the `legacy*` shorthand aliases, and the **UIA-empty → LegacyIAccessible
    fallback** (FlaUI `el.Patterns.LegacyIAccessible`); MSAA last-resort where feasible.
  - **Any direct UIA property by name** + the `getAttributes` "all" dump, with boolean/enum **string
    formatting consistent with the page-source schema** ("True"/"False", ControlType leaf names).
- **`setValue`**: SetFocus → `ValuePattern.SetValue`; **fallback to keyboard typing** (`Keyboard.Type`) for
  controls without ValuePattern; review metachar escaping, multi-line / `\n`→RETURN handling, and `clear`.
- **`getText`**: refine precedence (ValuePattern.Value → Name → LegacyIAccessible.Value → text aggregation).
- **click semantics**: use **ClickablePoint** when available (fallback to rect center, as nova2), and
  optional **scrollIntoView before click**; review `windows: click` args (`button`/`times`/`modifierKeys`/
  `durationMs`/`interClickDelayMs`) and `keys`/`scroll`/`clickAndDrag` arg parity.
- **Return-shape & error audit** for every command vs Appium client expectations.
- Land as unit tests (pure resolution logic) + Windows E2E for the pattern/legacy reads.

## Phase B — Robustness & resilience (live proofs)

- Layer-5 **sidecar recycle** live demo (kill the sidecar mid-session → auto-recycle + re-attach + retry).
- Element **staleness/re-resolve** behavior under churn; large-tree page source within the watchdog budget;
  concurrent-op serialization under load.
- (Deferred per user) 30-minute session-stress / leak watch.

## Phase C — Packaging & release engineering

- **CI**: build TS + sidecar (both arches), run unit + C# + a Windows E2E gate; automated release.
- **Per-arch npm split** via `optionalDependencies` (`os`/`cpu` filters) so each install pulls only its
  ~180–195 MB binary (ADR-013); **run-verify arm64** on real ARM Windows hardware.
- **Page-source single-pass `CacheRequest`** optimization (currently live traversal — correct but chattier).

## Phase D — Coverage completion (remaining API)

- `-windows uiautomation` **raw JSON-condition locator** (ADR-006 grammar).
- **rawView** page source (raw-view TreeWalker).
- `active` (focused element), `getDeviceTime`, real multi-window `getWindowHandles`.
- `typeDelay` / `smoothPointerMove` / `delayBeforeClick|AfterClick` actual effects (currently accepted no-ops).
- `scopeSession` / `resetSessionRoot` equivalents if demand appears.

## Phase E — GA hardening & docs

- Structured sidecar logging surfaced into the Appium log; wire remaining `flaui:*` knobs (spec §7).
- Built-in **Inspector** integration polish; (optional) BiDi.
- Finalize user docs/README/API reference; **GA release** (promote off `beta` tag, real version), confirm
  the permissive security posture (ADR-015) is clearly stated.

## Out of scope (decided)

Screen recording (ADR-012). PowerShell-as-backbone (ADR-007; PowerShell remains an opt-in gated feature per
ADR-014). Strict security / sandboxing (ADR-015 — permissive by design for isolated VMs).
