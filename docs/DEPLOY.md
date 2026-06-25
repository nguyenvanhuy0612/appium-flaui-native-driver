# Deploying appium-flaui-native-driver to a Windows host

Build the driver on your dev machine, ship it to a remote Windows host over SSH, and run an Appium
server there **in an interactive desktop session** so UIA automation actually works.

This driver ships a **compiled C# FlaUI sidecar** (`prebuilt/<rid>/FlaUiSidecar.exe`), so the package
must be built (TypeScript + sidecar) before install.

> **Recommended: build everything on the client, ship a complete package.** On hardened / EDR-managed
> Windows hosts, *host-side* `npm install` and source builds are unreliable — package extraction
> produces 0-byte/missing files, build dirs vanish between SSH sessions, and `%TEMP%` writes are denied.
> Building on the client and shipping a self-contained package (with `node_modules` already populated)
> sidesteps all of that. The host then only extracts + links — no host `npm install` of dependencies.
> This is the flow proven end-to-end below; a host-side build fallback is noted at the end.

---

## Prerequisites

**Client (Mac/Linux)**
- `ssh`, `scp`, `tar`, `iconv`, Node ≥ 20 / npm, and passwordless SSH to the host.
- **.NET 10 SDK** to build the sidecar. Per-user, no sudo:
  ```bash
  curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 10.0 --install-dir "$HOME/.dotnet"
  "$HOME/.dotnet/dotnet" --version   # 10.0.x
  ```
  The sidecar TFM is `net10.0-windows`; build it cross-platform with **`-p:EnableWindowsTargeting=true`**.

**Remote Windows host**
- OpenSSH Server with key-based auth (see the `ssh` skill).
- Node ≥ 20 and Appium 3 (`npm i -g appium`).
- **An interactive logon session** — a logged-in console or RDP user. UIA + synthetic input need a real
  desktop; they do **not** work from the SSH Session 0. Verify with `query user` (an `Active` session).
- No .NET SDK needed on the host (the sidecar is self-contained).

All remote PowerShell below is sent **base64-encoded** over SSH (`powershell -EncodedCommand`) to avoid
quoting hell, with `ssh ... 2>$null` (OpenSSH-on-Windows emits PowerShell CLIXML on stderr — drop it).
Use `Write-Output`, never `Write-Host`, in remote scripts.

---

## 1. Build on the client

```bash
npm run build                              # tsc -b → build/

# sidecar → prebuilt/win-x64/  (a FOLDER: FlaUiSidecar.exe + runtime DLLs; x64 host, use win-arm64 for arm64)
# NON-single-file (ADR-019): no runtime self-extraction, which security products block. Clean the dir first
# so a stale single-file exe can't linger.
rm -rf prebuilt/win-x64
"$HOME/.dotnet/dotnet" publish sidecar/FlaUiSidecar.csproj -c Release -r win-x64 --self-contained true \
  -p:PublishSingleFile=false -p:SatelliteResourceLanguages=en -p:EnableWindowsTargeting=true -o prebuilt/win-x64
```
`SatelliteResourceLanguages=en` drops the unused WinForms/WPF localized satellite DLLs (13 culture folders).
Build only the RID the host runs (`node -p process.arch` → `x64`→`win-x64`, `arm64`→`win-arm64`); the
driver picks the matching exe at runtime.

## 2. Assemble a COMPLETE package (with production node_modules)

`npm pack` only includes the `files` globs (`build/**`, `prebuilt/*/**`) — not
`node_modules`. Populate the runtime deps on the client (reliable) so the host never has to:
```bash
npm pack                                                   # → appium-flaui-native-driver-<ver>.tgz
rm -rf /tmp/flaui-stage && mkdir /tmp/flaui-stage
tar -xzf appium-flaui-native-driver-*.tgz -C /tmp/flaui-stage --strip-components=1
( cd /tmp/flaui-stage && npm install --omit=dev --no-audit --no-fund )   # complete production node_modules
tar -czf /tmp/flaui-complete.tgz -C /tmp/flaui-stage .
```

## 3. Transfer + install (host extracts + links — no host npm)

```bash
scp /tmp/flaui-complete.tgz admin@<host>:flaui-complete.tgz   # relative path → SSH home (C:\Users\admin)
```
Then, in ONE remote session (uninstall old → extract → link-install):
```powershell
$env:PATH = "$env:ProgramFiles\nodejs;$env:APPDATA\npm;$env:PATH"
taskkill /f /im node.exe /t 2>$null | Out-Null              # STOP Appium FIRST. A running server holds file
                                                            # handles in ~/.appium/node_modules AND the linked
                                                            # ~/flaui-driver, so the deletes below silently fail
                                                            # (stale files linger / a 0-byte swap looks "done").
                                                            # Same ordering as nova2's build_deploy_restart.sh.
& appium driver uninstall flauinative 2>&1 | Out-Null        # clears the manifest (cheap)
$dir = "$env:USERPROFILE\flaui-driver"
Remove-Item $dir -Recurse -Force -EA SilentlyContinue
New-Item $dir -ItemType Directory -Force | Out-Null
tar -xf "$env:USERPROFILE\flaui-complete.tgz" -C $dir        # ONE extraction (no per-file npm churn)
& appium driver install --source=local $dir                 # links; uses the dir's complete node_modules
& appium driver list --installed                            # → flauinative@<ver> [installed (linked …)]
```
- Deploy under the **user profile** (`$env:USERPROFILE\…`), not `C:\…` root — SSH Session 0 isn't
  elevated and can't create dirs at the drive root.
- **Faster old-install removal:** `appium driver uninstall` updates the manifest; if you also want to
  scrub the cached package, `Remove-Item` `~/.appium/node_modules/appium-flaui-native-driver`, `.cache`,
  and `.package-lock.json` directly (filesystem delete beats a slow npm uninstall).
- **`@`-folder junk / fully clean tree:** repeated `appium driver uninstall`/`install` cycles leave orphaned
  `@scope/*` dependency folders in `~/.appium/node_modules`. For a truly clean tree, stop Appium (above) then
  delete `~/.appium/node_modules` + `~/.appium/package-lock.json` wholesale and re-install from the manifest
  (`appium driver install --source=local $dir` for this driver; reinstall any *other* drivers too, since a
  full wipe removes them as well — e.g. `appium driver install --source=npm appium-novawindows2-driver@<ver>`).
  A clean tree keeps deps nested per driver: top-level `node_modules` ends up with just `.cache`, the driver
  dirs, and `.package-lock.json`.

## 4. Start Appium in an INTERACTIVE session (Session 1, not Session 0)

`Start-Process`/SSH land in non-interactive Session 0 where UIA can't drive the desktop. Launch via a
Scheduled Task with `LogonType Interactive` as the logged-in user. **Write the launch logic to a `.ps1`
file and run it with `-File`** — inline `-Command` over SSH mangles nested quotes.

```powershell
# write the launcher.
# Do NOT redirect (`*>`/`>`) the appium call — let it print live in the AppiumServer window so you can
# watch the session on the interactive desktop. `--log` writes the same output to a file on the Desktop as
# a copy (scp it back to inspect). `--log-level debug:debug` for full detail.
$launcher = @'
$env:PATH += ';' + $env:APPDATA + '\npm'
$Host.UI.RawUI.WindowTitle = 'AppiumServer'
Set-Location "$env:USERPROFILE\Desktop"
& appium --address 0.0.0.0 -p 4723 --relaxed-security --log-level debug:debug --log "$env:USERPROFILE\Desktop\appium_server.log"
'@
[IO.File]::WriteAllText("$env:USERPROFILE\start-appium.ps1", $launcher)

taskkill /f /im node.exe /t 2>$null | Out-Null
$u = (Get-Process explorer -IncludeUserName | Select-Object -First 1).UserName.Split('\')[-1]
$action    = New-ScheduledTaskAction -Execute 'powershell.exe' `
             -Argument "-NoExit -ExecutionPolicy Bypass -File `"$env:USERPROFILE\start-appium.ps1`""
$principal = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName 'AppiumVisible' -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'AppiumVisible'
Start-Sleep 16
Unregister-ScheduledTask -TaskName 'AppiumVisible' -Confirm:$false   # task only needs to launch the process
# verify: node runs in SessionId 1 and TCP 4723 is listening
```
`--address 0.0.0.0` makes it reachable from the client; ensure the firewall allows TCP 4723
(`New-NetFirewallRule -DisplayName Appium4723 -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4723`).

> **Sidecar self-extraction (historical).** The sidecar used to be a compressed single-file exe that
> self-extracted its runtime to disk on launch; on hardened / security-product hosts that write was blocked
> (symptom: **`sidecar exited early: <code>`**, no session, `.NET: I/O failure when writing decompressed
> file`). It is now a **non-single-file folder** (ADR-019) that performs no runtime extraction — the DLLs
> are copied to disk by the deploy above and only read at runtime — so `DOTNET_BUNDLE_EXTRACT_BASE_DIR` /
> a writable `%TEMP%` are no longer needed. (A locked-down `%TEMP%` can still break host-side `npm
> install`/`dotnet`, which is why we build on the client and ship a complete package.)

## 5. Verify + run tests from the client

```bash
curl -s http://<host>:4723/status                          # {"value":{"ready":true,...}}
APPIUM_URL=http://<host>:4723 npm run test:e2e             # or a single file:
APPIUM_URL=http://<host>:4723 npx mocha --import=tsx --timeout 180000 'tests/e2e/13-*.e2e.spec.ts'
```

---

## Stop / restart / logs
```powershell
taskkill /f /im node.exe /t                                # stop
# log: C:\Users\admin\Desktop\appium_server.log  (scp back to inspect)
```
Redeploy a code change: rebuild (step 1–2), re-transfer + re-install (step 3), then re-run step 4.

## Fallback: build on the host
Only if the host is a clean dev box (writable `%TEMP%`, no aggressive AV) **and** has the .NET 10 SDK.
`git archive HEAD | scp`, extract, `npm install && npm run build && dotnet publish …`, then
`appium driver install --source=local <dir>`. Expect to redirect `$env:TEMP` to a writable dir for
`npm`/`dotnet`. On hardened hosts this is unreliable — prefer the client-build flow above.

## Notes
- **Exact code vs npm:** npm-published releases can lag the repo (e.g. an unpublished version bump).
  Building on the client from your working tree ships exactly the code you're testing.
- **Reversibility:** client `.NET` SDK is just `~/.dotnet`; the host driver install lives under
  `~/.appium` (+ the linked `~/flaui-driver`); the bundle-extract dir is `C:\dnettmp`.
- **Skip the sidecar rebuild when only TS/`package.json` changed.** Step 1's `dotnet publish` is only needed
  when the C# sidecar (`sidecar/**`) changed. For a TS-only or dependency-only change, reuse the existing
  `prebuilt/<rid>/FlaUiSidecar.exe` and just `npm run build` + repack — much faster.
