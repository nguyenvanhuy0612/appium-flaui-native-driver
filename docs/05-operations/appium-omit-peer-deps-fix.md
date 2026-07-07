# Driver fails to load: `Cannot find module '@appium/logger'`

## Symptom

When the Appium server starts, the driver fails to load:

```
[Appium] Attempting to load driver flauinative...
[Appium] Could not load driver 'flauinative', so it will not be available.
         Error in loading the driver was: Cannot find module '@appium/logger'
Require stack:
- .../appium-flaui-native-driver/node_modules/@appium/support/build/lib/logging.js
- .../appium-flaui-native-driver/node_modules/@appium/base-driver/build/lib/index.js
```

`appium driver list --installed` shows the driver as installed, but it never becomes available. Reinstalling, clearing the npm cache, or wiping `~/.appium` does **not** help — a fresh `appium driver install` reproduces it on a clean machine.

## Root cause

Two things combine:

1. **Appium omits peer deps on install.** Appium 3's bootstrap (`node_modules/appium/build/lib/bootstrap/node-helpers.js`) sets `process.env.APPIUM_OMIT_PEER_DEPS = '1'` and wires `NODE_PATH` to Appium's own `node_modules`. `@appium/support`'s installer then runs:

   ```
   npm install --save-dev --omit=peer --save-exact --global-style --no-package-lock <driver> --json
   ```

   Under npm 11, `--omit=peer` **over-prunes**: it drops `@appium/logger` even though `@appium/logger` is a normal (non-peer) dependency of `@appium/support`. Isolation test: a plain `npm install` keeps `@appium/logger`; adding `--omit=peer` deletes it; `--global-style` alone is harmless. This is present in **every** Appium 3.x (3.0.0–3.5.x), so a different Appium 3 version does not avoid it.

2. **The driver bundled `@appium/base-driver` and imported it directly.** Listing `@appium/base-driver` in `dependencies` created a nested `@appium/support` whose transitive `@appium/logger` was the one `--omit=peer` dropped, and importing `@appium/base-driver` as a bare scoped package relied on a location Appium's `NODE_PATH` does not cover.

### Why bundling is wrong for Appium 3

Appium 3 **provides** `@appium/base-driver`, `@appium/support`, and `@appium/logger` to extensions at runtime via `NODE_PATH` (pointed at the directory containing the `appium` package). Extensions must **not** bundle them; `--omit=peer` is intentional to avoid duplicate copies. Because `NODE_PATH` points at the *parent* of the `appium` package, a bare `import ... from '@appium/base-driver'` does not resolve, but `import ... from 'appium/driver.js'` does — Appium ships a shim:

```js
// appium/driver.js
module.exports = require('@appium/base-driver'); // runs inside the appium package, where it resolves
```

The official `appium-windows-driver` (also ESM) does exactly this — zero `@appium/*` runtime deps, `import { BaseDriver } from 'appium/driver.js'` — and loads cleanly.

## The fix (two parts — package.json alone is not enough)

1. **`package.json`**
   - Remove `@appium/base-driver` and `@appium/logger` from `dependencies`.
   - Add `@appium/base-driver` and `appium` to `devDependencies` (alongside `@appium/types`) so the TypeScript build can resolve `appium/driver.js` and its types. `appium` stays a `peerDependency` (optional) for runtime. Note: because the `appium` peer is marked `optional`, npm will **not** auto-install it — it must be an explicit devDependency or the build cannot resolve `appium/driver.js` (BaseDriver loses its type and the driver class errors).

2. **Imports** — this package is ESM (`"type": "module"`), so change `from '@appium/base-driver'` to `from 'appium/driver.js'` (with the `.js` extension). Only `lib/driver.ts` imports it (`BaseDriver`, `errors`). `@appium/types` stays as-is — type-only, erased at build.

At runtime the driver resolves `@appium/*` from the running Appium via `NODE_PATH`, so all of `base-driver`/`support`/`logger` are the single consistent set Appium ships.

## Verification

The sibling driver `appium-novawindows2-driver` (CommonJS, identical fix using `appium/driver`) was published under a `test` dist-tag and verified end-to-end: installed via `appium driver install --source=npm`, the Appium server logged `successfully loaded` with no error. This driver uses the same pattern (ESM `appium/driver.js`) and `tsc -b` passes. Confirm at release via the normal CI build (which produces the win-x64/win-x86/win-arm64 sidecars required by `scripts/assert-package-contents.mjs`).

Note: `--source=local` is not a valid test — it symlinks the driver and runs build scripts, which does not represent `--source=npm` module resolution.

## Interim workaround (no code change, older releases)

After `appium driver install`, run a full reconcile once:

```powershell
npm install --prefix "$env:USERPROFILE\.appium"
```

A plain `npm install` ignores `--omit=peer` and hoists `@appium/logger` to the top level, so the driver loads. Not needed once the fix above is released.
