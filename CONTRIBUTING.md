# Contributing

`appium-flaui-native-driver` is an Appium 3 Windows UI-automation driver built as two
processes: a **TypeScript Appium driver** and a compiled **C#/.NET 8 FlaUI sidecar** that
talk over loopback HTTP with structured JSON ops. Start with the [docs](./docs/README.md) —
especially the [architecture overview](./docs/02-architecture/overview.md) and the
[RPC protocol](./docs/03-reference/rpc-protocol.md) — before changing anything.

## Repo layout

| Path | What |
|---|---|
| `lib/` | TypeScript driver. `driver.ts` (W3C/Appium surface), `backend/` (sidecar process + RPC client + op builders), `commands/` (`windows:` extension commands), `xpath/` (XPath → UIA condition compilation). |
| `sidecar/` | C# FlaUI sidecar (`net8.0-windows`). See [sidecar internals](./docs/02-architecture/sidecar-internals.md) for the file-by-file tour. `sidecar/tests/` holds the C# xUnit tests. |
| `tests/` | TypeScript tests: `unit/` (any OS), `smoke/` + `e2e/` (need a Windows box). |
| `scripts/` | Build/publish + e2e helper scripts (e.g. `publish-sidecar.mjs`). |
| `prebuilt/` | Published `win-x64`/`win-arm64` `FlaUiSidecar.exe`. **gitignored** — produced on the Windows build box, included in the npm package via the `files` allowlist. |
| `build/` | `tsc` output (`build/**/*.js`), also gitignored and packaged. |
| `docs/` | All documentation. See [`docs/README.md`](./docs/README.md). |

## Building

**TypeScript driver** (any OS):

```bash
npm install
npm run build      # tsc -b → build/**/*.js
```

**C# sidecar** — builds and runs **only on Windows** (FlaUI/UIA is Windows-only). The npm
package ships a self-contained single-file exe per architecture:

```bash
# run on the Windows build box:
npm run publish:sidecar
# = dotnet publish sidecar/FlaUiSidecar.csproj -c Release -r <rid>
#     --self-contained true -p:PublishSingleFile=true
#     -p:IncludeNativeLibrariesForSelfExtract=true -o prebuilt/<rid>
# for rid in win-x64, win-arm64
```

> **Never publish from the Mac.** The sidecar will not even compile off Windows, `prebuilt/`
> is gitignored, and the published package must carry the Windows exes. Build/publish always
> runs on the Windows build box. (TypeScript `npm run build`, by contrast, is fine anywhere.)

## Running tests

| Suite | Command | Where |
|---|---|---|
| TS unit | `npm run test:unit` | any OS (no sidecar/UIA) |
| TS smoke | `npm run test:smoke` | Windows box, real session |
| TS e2e (W3C) | `npm run test:e2e:w3c` | Windows box |
| C# xUnit | `dotnet test sidecar/tests` | any OS for the FlaUI-free logic; full suite on Windows |

End-to-end tests need a Windows machine with the driver installed and Appium started with
**`appium --relaxed-security`** (the file-transfer / PowerShell features are insecure and
gated behind it). The cross-platform C# tests deliberately exercise only the FlaUI-free logic
(`UiaScheduler`, `PropertyResolverLogic`); real UIA behavior is verified on Windows.

## How to add a `windows:` command

The `windows:` extension surface lives in `lib/commands/extensions.ts` and its C# handler in
`sidecar/OpInterpreter.cs`. Two flavors:

**Element-action command** (operates on one element via a UIA pattern — invoke/toggle/…):

1. Add the name to `ACTION_COMMANDS` in `lib/commands/extensions.ts` (maps the `windows:`
   name → the sidecar action string).
2. Add the matching `case` to the `Action(...)` switch in `sidecar/OpInterpreter.cs`. Use the
   relevant FlaUI pattern; write-style actions return `{ done = true }`, read-style return data.
3. Wire it through `driver.ts` if it needs new args, and add unit + e2e coverage.

**Input command** (real mouse/keyboard, per-command param list — click/hover/scroll/…):

1. Add an entry to `INPUT_COMMANDS` in `lib/commands/extensions.ts` declaring its
   `params.required`/`params.optional` (declaration order is how positional executeMethod args
   are mapped to named args).
2. Add the matching `case` to the `Input(...)` switch in `sidecar/OpInterpreter.cs`.

Keep the op shape in `lib/backend/ops.ts` (`BackendOp`) in sync, and reflect new commands in
[`docs/03-reference/`](./docs/03-reference/).

## How to add an attribute

Attribute resolution lives in `sidecar/PropertyResolver.cs` (with FlaUI-free helpers in
`PropertyResolverLogic.cs`):

- **Direct UIA property** → add a `case` in `TryResolveDirect`, and add the name to
  `DirectAttributeNames` in `PropertyResolverLogic.cs` so it appears in the `all` dump and
  page source.
- **Pattern property** (`<Pattern>.<Prop>`) → usually resolves automatically via reflection;
  to include it in the `all` dump, add it to the `PatternProperties` table.
- `Is<Pattern>PatternAvailable` flags come from FlaUI's pattern table automatically.

Pure name-classification/formatting logic belongs in `PropertyResolverLogic.cs` so it stays
unit-testable cross-platform. Add or update tests in `sidecar/tests/`.

## Conventions

- Stability > coverage > speed. Don't let a single op hang a session — keep UIA work inside
  the scheduler and bounded by the watchdog.
- The seam is **structured JSON ops, never PowerShell strings** (ADR-003). New capabilities
  get a typed op in `lib/backend/ops.ts` and a handler in `OpInterpreter.cs`.
- When a change makes a doc stale, update the doc in the same pass.
- Record non-obvious choices as ADRs in [`docs/04-design/decisions.md`](./docs/04-design/decisions.md).
