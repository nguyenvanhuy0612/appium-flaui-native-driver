# Clean reinstall (Windows test boxes)

*Operations · updated 2026-06-04*

How to wipe and reinstall the driver cleanly. This is **faster and cleaner than
`appium driver uninstall`**, which is slow and leaves extra files behind in `.appium`.

## Where things live

| Thing | Location |
|---|---|
| **Appium server** (global npm) | `C:\Users\<user>\AppData\Roaming\npm\node_modules\appium` |
| **Installed drivers** | `C:\Users\<user>\.appium\node_modules\<driver-pkg>\` |
| This driver | `C:\Users\<user>\.appium\node_modules\appium-flaui-native-driver\` |
| The driver's runtime deps | `…\appium-flaui-native-driver\node_modules\` (its own nested tree) |
| Extension manifest (cache) | `C:\Users\<user>\.appium\node_modules\.cache\appium\extensions.yaml` |

> The Appium server and the drivers live in **two different trees**: the server is a global npm package
> under `AppData\Roaming\npm`; the drivers are under `~/.appium`.

## Recipe — targeted clean reinstall (preferred)

Delete just the driver dir + the manifest cache + the lockfile, clear the npm cache, then reinstall:

```powershell
$p = "$env:USERPROFILE\.appium\node_modules"
ri -r -fo -ea 0 "$p\appium-flaui-native-driver", "$p\.cache", "$p\.package-lock.json"
npm cache clean --force
appium driver install --source=npm appium-flaui-native-driver@beta
```

(`ri` = `Remove-Item`; `-r -fo -ea 0` = `-Recurse -Force -ErrorAction SilentlyContinue`.) Removing
`.cache` (the manifest) and `.package-lock.json` forces Appium/npm to rebuild state fresh, so the new
install is deterministic. Swap the package/tag for any other driver, e.g.
`appium-novawindows2-driver@latest`.

## Full wipe (clean slate for ALL drivers)

Heavier, but resets everything — every installed driver is removed:

```powershell
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.appium\node_modules" -Recurse -Force -ErrorAction SilentlyContinue
appium driver install --source=npm appium-flaui-native-driver@beta
```

## About the `appium` entry inside the driver's `node_modules`

After install you will see `…\appium-flaui-native-driver\node_modules\appium`. **This is not bloat.** It is a
**0-byte Windows junction** (reparse point) pointing to the global server
(`AppData\Roaming\npm\node_modules\appium`). The Appium CLI creates it during install; it is **not** declared
by this package and **cannot** be removed via `package.json` (dropping the `appium` peerDependency had no
effect on it).

The driver's **real** footprint is its own nested `node_modules` (the `@appium/base-driver` dependency tree,
~43.7 MB — of which `sharp`/libvips is ~19.5 MB) plus the self-contained sidecar exe (`prebuilt/win-x64/
FlaUiSidecar.exe`, ~180 MB). A nested `node_modules` under the driver is expected and required — that is
where the driver's runtime dependencies live.
