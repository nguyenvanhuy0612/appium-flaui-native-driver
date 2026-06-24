# Appium / FlaUINative — clean & reinstall

Windows PowerShell (run as user). Captured 2026-06-24.
Driver package `appium-flaui-native-driver` · short name `flauinative`.

## 1. Nuke — wipe appium + npm global + cache

Strongest reset. Removes appium itself, so it reinstalls appium then the driver.

```powershell
"$env:APPDATA\npm","$env:LOCALAPPDATA\npm-cache","$env:USERPROFILE\.npm","$env:USERPROFILE\.appium","$env:USERPROFILE\node_modules","C:\Windows\System32\node_modules","C:\Windows\System32\package.json","C:\Windows\System32\package-lock.json" | % { ri $_ -r -fo -ea 0 }
npm cache clean --force; npm i -g appium; appium driver install --source=npm appium-flaui-native-driver@beta
```

> `.npmrc` is intentionally NOT deleted (holds corp registry/proxy/auth). To reset it too, append `"$env:USERPROFILE\.npmrc"` to the array — back it up first.

## 2. All drivers — keep appium

Fast: deletes the whole `.appium` extension tree (drivers *and* plugins); the appium binary in `%APPDATA%\npm` stays.

```powershell
ri -r -fo -ea 0 "$env:USERPROFILE\.appium"; npm cache clean --force; appium driver install --source=npm appium-flaui-native-driver@beta
```

Surgical (drivers only, keep plugins) — appium-native loop:

```powershell
appium driver list --installed --json | ConvertFrom-Json | % { $_.PSObject.Properties.Name } | % { appium driver uninstall $_ }
```

## 3. One driver

Proper way (use when appium still runs):

```powershell
appium driver uninstall flauinative; appium driver install --source=npm appium-flaui-native-driver@beta
```

Force (when uninstall fails or deps are broken, e.g. missing `@appium/logger`):

```powershell
$p="$env:USERPROFILE\.appium\node_modules"; $pkg="appium-flaui-native-driver"
"$p\$pkg","$p\.cache","$p\.package-lock.json" | % { ri $_ -r -fo -ea 0 }; npm cache clean --force; appium driver install --source=npm "$pkg@beta"
```

## Naming — the common trap

| Context | Use |
| --- | --- |
| `appium driver uninstall` / `list` | short name `flauinative` |
| `appium driver install` + folder in `.appium\node_modules` | package name `appium-flaui-native-driver` |

`@beta` follows the dist-tag (currently `0.1.0-beta.24`) — pin a version like `@0.1.0-beta.24` if you need it fixed.

## "Cannot find module '@appium/logger'" on driver load

Symptom: `Could not load driver 'flauinative' ... Cannot find module '@appium/logger'` even after a full nuke + reinstall.

Root cause: `@appium/support` (pulled via `@appium/base-driver`) lists `@appium/logger` as **both** a `dependency` and a `peerDependency`. npm 11.6.x then treats the peer as already satisfied and never lays the real copy onto disk — the lock records it, the folder is absent. Deterministic, so reinstalling does not help.

Fixed in driver `0.1.0-beta.25+`, which declares `@appium/logger` as a direct dependency. On an older build, patch in place:

```powershell
cd %USERPROFILE%\.appium\node_modules\appium-flaui-native-driver
npm install @appium/logger@2.0.9 --no-save
```

(The `--no-save` patch is wiped by any later `appium driver install/update` or nuke — re-run it, or move to beta.25+.)

## Verify after

```powershell
appium driver list --installed
appium   # start server, confirm "Could not load driver" is gone
```

---
FlaUINative driver ops notes. Re-verify commands if Appium major version changes.
