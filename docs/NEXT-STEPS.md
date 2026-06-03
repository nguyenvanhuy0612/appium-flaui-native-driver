# Next Steps — Appium FlaUI Native Driver

Companion to [`docs/superpowers/specs/2026-06-03-appium-flaui-native-driver-design.md`](./superpowers/specs/2026-06-03-appium-flaui-native-driver-design.md).
This is the actionable "what to do next" working doc. Updated 2026-06-03.

---

## 0. Where we are

- ✅ Design spec written, reviewed, committed.
- ✅ Appium 3 impact assessed (spec §12).
- ⏳ **Now:** lock the open decisions below, set up environments, then write the Phase 0/1 implementation plan.

---

## 1. Decisions to lock before coding

These are the only things blocking a clean implementation plan. Defaults proposed — confirm or change.

| # | Decision | Proposed default | Why it matters |
|---|---|---|---|
| 1 | **Driver name / automationName** | `appium-flaui-native-driver` / `FlaUINative` / driverName `flauinative` | Avoid clash with `FlaUI` (FlaUI.WebDriver) and with `NovaWindows2`. Affects manifest, feature-flag prefix, npm name. |
| 2 | **Input location** (mouse/keyboard) | Keep in TS `winapi`/koffi at first (max reuse); revisit if focus races | Spec §11.1. Moving into the sidecar unifies timing with UIA but enlarges it. |
| 3 | **`-windows uiautomation` grammar** | Structured-condition JSON (mirrors XPath `Condition` model) | nova2 accepted C#/PS condition syntax; here it becomes a JSON grammar we must define. |
| 4 | **Insecure feature flags to scope** | `record_screen`, `pull_file`/`push_file`, optional `power_shell` | Appium 3 requires `flauinative:<feature>`; an unscoped flag now throws (spec §12.3). |
| 5 | **Bundle vs download sidecar binary** | Bundle self-contained per-arch `.exe` in the npm package | Offline reliability (stability priority). Revisit only if size hurts (spec §8). |

---

## 2. Environment prerequisites

> ⚠️ **Cross-platform reality.** This is a **Windows-only** driver. The dev box here is macOS.
> - The **TypeScript layer** can be developed/unit-tested on macOS.
> - The **C# sidecar (FlaUI/UIA)** and **all E2E tests** require **Windows** (a physical machine or a
>   Windows VM with the target apps). Plan a Windows dev/CI environment early — it gates Phase 0.

**On the Windows dev machine:**
- Node `≥ 20.19.0` (or 22 LTS), npm `≥ 10`  — required by Appium 3.
- .NET SDK `8.0` or `9.0` (LTS) — to build/publish the sidecar.
- Appium 3: `npm i -g appium`  → verify `appium -v` reports `3.x`.
- A few sample apps for E2E: Notepad (Win32), a WinForms app, a WPF app, a UWP/Store app.

**Appium 3 sanity check (once the driver exists locally):**
```bash
appium driver install --source=local /path/to/appium-flaui-native-driver
appium driver list --installed
# launch a session with capabilities { platformName: "Windows", "appium:automationName": "FlaUINative", "appium:app": "notepad.exe" }
```

---

## 3. Repo scaffolding plan (created in Phase 1, not yet)

```
appium-flaui-native-driver/
├── package.json            # appium manifest: driverName/automationName/platformNames/mainClass
│                           # engines: node ^20.19, npm >=10 ; peerDep appium ^3.0.0
├── lib/                    # TypeScript driver (forked & adapted from nova2)
│   ├── driver.ts           # session lifecycle, locator strategies, executeMethodMap
│   ├── commands/           # W3C + windows: handlers (re-pointed to JSON ops)
│   ├── xpath/              # REUSED from nova2
│   ├── backend/            # NEW: op types, op builders, HTTP RPC client, sidecar process manager
│   ├── winapi/             # REUSED (koffi) — input, unless moved to sidecar
│   └── constraints.ts      # capabilities (+ flaui:* caps, − PowerShell caps)
├── sidecar/                # NEW: C#/.NET FlaUI sidecar
│   ├── src/                # RPC host (Kestrel), UIA scheduler, op interpreter,
│   │                       # element registry, page-source builder, backend factory
│   └── tests/              # xUnit
├── prebuilt/               # bundled self-contained win-x64 / win-arm64 binaries (CI-produced)
├── scripts/                # prebuild: dotnet publish → prebuilt/
├── tests/                  # mocha unit + e2e (ported from nova2 + hang-injection)
└── docs/
```

---

## 4. Phase 0 — De-risking spikes (DO FIRST)

Throwaway code. Goal: prove the three riskiest assumptions before committing to the full build. Each has a
binary pass/fail.

- [ ] **Spike A — Sidecar launch from npm.** A self-contained .NET `.exe` (`dotnet publish -r win-x64
      --self-contained`) launches from a Node child process, serves `GET /status` over localhost HTTP,
      and is killed cleanly on parent exit. *Pass:* Node spawns it, reads the auto-port from stdout,
      gets `200` on `/status`, no orphan process after parent dies.
- [ ] **Spike B — FlaUI core works for our needs.** A C# console using FlaUI UIA3 launches Notepad,
      `FindFirst` an element by AutomationId, and builds a page-source XML subtree via a single
      `CacheRequest` pass. *Pass:* XML matches nova2's schema for the same app; one cached pass, no
      per-property round-trips.
- [ ] **Spike C — Anti-hang actually works.** Drive an app whose UI thread is deliberately frozen; confirm
      (1) UIA3 `TransactionTimeout` bounds the call, (2) the per-op watchdog returns a `timeout` error,
      (3) the RPC host stays responsive, (4) a fresh op on a new worker thread succeeds. *Pass:* session
      survives a hang; no global freeze. **This is the make-or-break spike for the whole premise.**

---

## 5. Phase 1 — Skeleton end-to-end (after spikes pass)

- [ ] Fork nova2 structure into this repo; strip the PowerShell backend.
- [ ] Define the `BackendOp` / `BackendResult` TypeScript types (the new seam).
- [ ] Implement the sidecar process manager (spawn, auto-port handshake, `/status` health, heartbeat, kill).
- [ ] Implement the HTTP RPC client (TS) + `POST /session`, `POST /op{find}`, `DELETE /session` (C#).
- [ ] Element registry in the sidecar (RuntimeId map + FIFO eviction).
- [ ] Update manifest for Appium 3 (engines, peerDep, `executeMethodMap` skeleton).
- [ ] **Green E2E:** open Notepad, find an element by accessibility id, assert its id. (Windows only.)

Phases 2–6 are detailed in spec §13; each gets its own implementation plan when reached.

---

## 6. How we proceed

1. **You review** the spec + this doc; confirm/adjust the §1 decisions.
2. We run the **writing-plans** workflow to turn **Phase 0 (spikes)** and **Phase 1 (skeleton)** into a
   concrete, step-by-step implementation plan.
3. Execute Phase 0 on a Windows environment. If Spike C fails, we revisit the architecture *before*
   building further (cheap to pivot now, expensive later).
4. Iterate phase by phase, each ending with tested, demoable software.

---

## 7. Open questions still parked (spec §11)

- STA vs MTA for the UIA worker thread — validate in Spike C.
- Self-contained binary size (~30–70MB/arch) — monitor; acceptable for now.
- Depth of MSAA support — `LegacyIAccessiblePattern` only for v1; full IAccessible tree-walking is a
  separate future effort if ever needed.
