# Known Issues & Open Items

*Design · open-issue tracker · updated 2026-06-04*

Standalone tracker for open anti-hang items, capability gaps, and roadmap work. Timeout values and the full
anti-hang design live in [stability](../02-architecture/stability.md) — this page only tracks what is *not*
yet done and links there for detail.

## Open anti-hang items

### Item B — watchdog non-fire for SecureAge-style freeze (OPEN)

For the 2026-06-04 SecureAge freeze, **neither the sidecar op-watchdog nor the UIA timeout fired** — the op
never settled and the per-session command queue jammed to 80+ for over an hour. The HangApp fixture freezes
the UI thread differently (there the watchdog *does* fire), so it does not reproduce this mode; a real repro
with instrumentation is needed.

The real fix is to make a frozen op reliably hit the watchdog → poison/replace the STA worker → only that op
fails (`"timeout"`), the session survives, the queue drains on the fresh worker.

**Current guaranteed bound:** the TS **hard-deadline (L4, `operationTimeout+10s` — 310s at defaults)**
always settles the op and then C fails the session honestly (`NoSuchDriverError`), so the queue can never
wedge indefinitely. Values: [stability — timeout reference](../02-architecture/stability.md#timeout-reference).
Full failure-mode table and the layer design:
[stability — failure modes](../02-architecture/stability.md#failure-modes--expected-vs-the-2026-06-04-incident).

### Item F — concurrency cap + stray-process reaper (optional / future)

Cap concurrent sidecars and reject new sessions past the cap; add a startup/periodic reaper that kills stray
`FlaUiSidecar.exe` with no live parent. Optional hardening on top of the heartbeat + idle-exit orphan guards
already shipped (E).

## FlaUI capability gaps

The full ✅/🟡/⬜ utilization matrix is in
[backend (FlaUI) — not yet wired](../02-architecture/backend-flaui.md#not-yet-wired-gaps). The **core
interaction surface is fully wired** (invoke/toggle/expand/value/selection/window/scrollIntoView/transform,
real mouse+keyboard input, conditions + all four tree scopes, capture, clipboard, attach/launch, UIA2+UIA3)
— enough to ship beta. The unwired items below are **post-release**, ordered by value:

| # | Item | Why it matters | Task |
|---|---|---|---|
| 1 | Page source via **CachedChildren navigation** | source is a live per-node walk → ~13s on a desktop-root tree (~1MB). NOTE: a property-only CacheRequest was tried (beta.22) and **reverted — no speedup**; the cost is the per-node `FindAllChildren` navigation, not the property reads. The real fix is one `FindAll(TreeScope.Subtree, cacheRequest)` then walking `.CachedChildren` (no per-node FindAllChildren). (Contrast: the **find path** DOES use a property-only CacheRequest since 2026-07-10 — there the per-element property reads ARE the cost, and live reads on a churning tree caused `UIA_E_TIMEOUT` 0x80131505; see `OpInterpreter.Find`.) | #3 |
| 2 | **RangeValue.SetValue** | sliders / spinners / progress are read-only today — a real functional gap | #4 |
| 3 | **VirtualizedItem.Realize** + **ItemContainer.FindItemByProperty** | long virtualized lists/grids can miss off-screen items | #5 |
| 4 | **RawView / ContentView** walkers | the `rawView` source flag is accepted but ignored; content view = more concise source (also helps perf) | #6 |
| 5 | **FromPoint / FocusedElement** | element-under-point and focused-element locators (low effort) | #7 |

Niche / nice-to-have (not tracked as tasks): Scroll-pattern action, Text selection/Text2, Table/Grid cell
actions, MultipleView, Dock `SetDockPosition`, Transform.Rotate/Zoom, Touch gestures, Store-app launch by
AUMID, multi-monitor `Capture`, `DrawHighlight`. Screen recording is out of scope (ADR-012).

## Dropdown / ComboBox page-source parity (PENDING FIX)

flaui page source does **not** include a ComboBox's child ListItems while the dropdown is CLOSED; the nova
(NovaWindows2) driver does. Desired: parity — surface the collapsed items, always-on (no new capability),
by reading the tree the way nova does (Control View walk, **no real expand**).

**Verified 2026-07-09** on host `172.16.10.37` (both drivers via `--source=npm`) using Character Map
`charmap.exe`, Font ComboBox, dropdown CLOSED:
- flaui: ComboBox exposes only `<Text>` + `<Button AutomationId="DropDown">` — **0 List, 0 ListItem**.
- nova: ComboBox contains `<List ClassName="ComboLBox" AutomationId="ListBox" IsOffscreen="True">` with
  **146 `<ListItem>`** (Arial, Arial Black, Bahnschrift, …).

**Root cause (pinned):** the dropdown listbox is a *separate* HWND (window class `ComboLBox`) that UIA nests
under the ComboBox **only in the Control view**. nova recurses `FindAll(Children, ControlViewCondition)` so it
appears; flaui `sidecar/PageSourceBuilder.cs` walks children via FlaUI `FindAllChildren()` (raw / TrueCondition)
in `PushChildrenReversed`, so the `ComboLBox` is not a child there. Same reason the `rawView` flag is a no-op
(see capability-gap #4 above) — the builder never uses a Control-view walker.

**Fix (not yet implemented):** switch `PageSourceBuilder`'s child enumeration from `FindAllChildren()` to a
**Control-view `TreeWalker`** (sidecar already has `GetControlViewWalker()`); wire the `rawView` flag to select
Raw vs Control walker. No expand, no `IsOffscreen` filtering. This closes both this parity gap and gap #4.

**Blocked on:** a working local-code deploy — `--source=local` is broken since `3ce589f`
(`docs/05-operations/`), so an unreleased build can't be pushed to a test host to verify the fix. Decide a
deploy method before shipping. Full context: `docs/internal/2026-07-09-session-handoff.md`, memory
`dropdown-pagesource-parity`.

## Pattern-command verification (beta)

The six `windows:` pattern verbs without prior e2e coverage were spot-checked on beta.16 against a WinForms
fixture (`tests/e2e/12-patterns.e2e.spec.ts`, currently `describe.skip` — fixture pipeline paused for beta;
real-app issues raised as found). Result 2026-06-05: **expand, collapse, addToSelection, allSelectedItems,
close — verified PASS**. **`removeFromSelection`** did not deselect the item on a multi-select ListView —
**unconfirmed**: could be a driver bug or a UIA-provider quirk; verify on a real multi-select control during
beta before claiming it as supported.

## Roadmap

Outstanding roadmap items (absorbed from the former NEXT-STEPS):

| Item | Status | Notes |
|---|---|---|
| win-arm64 binary | Built, **unverified** | Needs run-verify on real ARM Windows hardware (per-arch npm split via `optionalDependencies`, ADR-013). |
| rawView page source | Planned | Raw-view `TreeWalker` page source (Phase D). |
| Page-source `CacheRequest` perf | Planned | Single-pass `CacheRequest` instead of the current live traversal (correct but chattier). |
| CI / automated publish | Planned | CI to build TS + sidecar (both arches), run unit + C# + a Windows E2E gate, and automate release (Phase C). |

Phase A is complete; phases B–E remain. Work log: [`../internal/changelog-internal.md`](../internal/changelog-internal.md).
