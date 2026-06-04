# Security

This page documents the driver's threat model and security posture. The short version: the posture
is **permissive by design**, because the driver targets isolated, low-value VM environments. See
[ADR-015](./decisions.md#adr-015--security-posture-permissive-by-default-never-trade-a-feature-for-strictness).

## Posture (ADR-015)

The driver targets **isolated, throwaway VM environments** with little or no sensitive data. Security
is deliberately **not strict**, and **no feature is ever removed, disabled-by-default, or sandboxed
for security reasons** — the value proposition is capability, not lock-down. Friction from security
gating would cost more than it protects in this setting.

- **Recommended (dev/test):** `appium --relaxed-security`. This enables every insecure feature
  (PowerShell, file transfer) with no per-feature flags.
- **Locked-down alternative:** scope only the features you need with `allow-insecure`. The
  `--allow-insecure` CLI flag does not parse multiple scoped features reliably, so use a config file:

  ```jsonc
  // appium-config.json
  { "server": { "allow-insecure": [
    "flauinative:power_shell", "flauinative:pull_file", "flauinative:push_file"
  ] } }
  ```
  ```bash
  appium --config appium-config.json
  ```

The two postures coexist cleanly: the feature gates (below) stay in the code regardless. Under
`--relaxed-security` base-driver returns `true` for every feature, so the gates pass and nothing is
blocked; under scoped lock-down they give a clean W3C feature error *only* for features the operator
chose to disable. The gates never sacrifice a feature — they only fail loud when an operator opts out.

## Trust boundary

Two capability groups cross the trust boundary. Once enabled, **any client that can reach the Appium
endpoint can use them with the Appium server's privileges.** Both are feature-gated via
`this.assertFeatureEnabled(...)`, which runs *before* any work and fails loud (clean W3C feature
error) when the feature is off.

| Capability | Scope | Power once enabled |
| :--- | :--- | :--- |
| `power_shell` (the `powershell` script + `appium:prerun`) | `flauinative:power_shell` | **Arbitrary code execution** on the host, with the server's privileges. Runs out-of-process (not on the UIA watchdog) but is otherwise unrestricted; bounded only by `powerShellCommandTimeout`. |
| `pull_file` / `push_file` / `pull_folder` | `flauinative:pull_file` / `push_file` | **Unsandboxed filesystem read/write** to any path the server account can reach. |

## Deliberate non-mitigations

These are conscious omissions, consistent with ADR-015 — not oversights:

- **No path sandbox** on the file-transfer commands. They read/write any path by design.
- **No allow-list** of permitted PowerShell commands or scripts. PowerShell input runs as-is.

The mitigation is operational, not in-code: **only enable these features on a trusted server with
trusted clients, inside an isolated VM.** Feature gating exists so an operator who wants lock-down
can disable individual features — it is not a sandbox.

## Threats

| Threat | Vector | Mitigation |
| :--- | :--- | :--- |
| Arbitrary code execution on the host | `execute('powershell', …)` or `appium:prerun` when `power_shell` is enabled | Feature-gated (`assertFeatureEnabled('power_shell')`); off unless `--relaxed-security` or scoped `flauinative:power_shell`. Time-bounded + process-tree kill via `powerShellCommandTimeout`. **Operational:** isolated VM, trusted clients only. |
| Exfiltration of host files | `execute('pullFile' / 'pullFolder', …)` when `pull_file` is enabled | Feature-gated (`assertFeatureEnabled('pull_file')`); off by default. **Operational:** isolated VM, trusted clients. No path sandbox (deliberate). |
| Tampering / planting files on the host | `execute('pushFile', …)` when `push_file` is enabled | Feature-gated (`assertFeatureEnabled('push_file')`); off by default. **Operational:** isolated VM, trusted clients. No path sandbox (deliberate). |
| Unauthorized network access to the endpoint | Any client reaching the Appium HTTP server | Out of the driver's scope — bind/firewall the Appium server (the sidecar itself listens only on `127.0.0.1`). |

## See also

- [Appium API reference](../03-reference/appium-api.md) — the gated `powershell`, `pullFile`,
  `pushFile`, and `pullFolder` commands.
- [Decisions](./decisions.md) — ADR-008 (feature flags), ADR-014 (PowerShell as a gated feature),
  ADR-015 (security posture).
