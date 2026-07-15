// Pure timeout-derivation helpers (no Appium/Node deps) so they can be unit-tested directly without the
// tsx-unfriendly base-driver import chain (see driver-core.spec.ts for why the driver can't be imported).

/**
 * Default per-op timeout (ms) when `flaui:operationTimeout` is not set. MUST match the sidecar's own
 * default operationTimeout (L1 UIA / L2 watchdog) — everything in the L1<L2<L3<L4 stack derives from
 * this one knob: L3 (RPC abort) = operationTimeout + RPC_GRACE_MS, L4 (hard backstop) = L3 + 5s.
 */
export const DEFAULT_OPERATION_TIMEOUT_MS = 300_000;

/** Transport grace ABOVE the sidecar's per-op watchdog, so L3 never aborts an op L2 is still timing. */
export const RPC_GRACE_MS = 5_000;

/**
 * Default per-call timeout (ms) for the `powershell` op when the caller passes no `timeoutMs`. MUST match
 * the sidecar's own default in RunPowerShell (Program.cs) — the sidecar kills the process tree at this
 * deadline, and the TS RPC timeout sits RPC_GRACE_MS above it. PowerShell runs outside the UIA scheduler,
 * so `flaui:operationTimeout` does NOT bound it; this is its own axis-C default (same 300s scale so a
 * slow-host prerun is not cut short).
 */
export const DEFAULT_POWERSHELL_TIMEOUT_MS = 300_000;

/**
 * L3 per-op RPC timeout (ms): the sidecar's per-op watchdog (`flaui:operationTimeout`, default
 * DEFAULT_OPERATION_TIMEOUT_MS) plus a transport grace, so the RPC abort sits just ABOVE the watchdog.
 */
export function opRpcTimeoutMs(operationTimeoutMs?: number): number {
  return (operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS) + RPC_GRACE_MS;
}

/**
 * L4 hard-backstop deadline (ms) for a given L3 call timeout — the Promise.race timer in RpcClient that
 * guarantees an RPC settles even when fetch ignores its abort signal (half-open connection).
 */
export function rpcHardBackstopMs(callTimeoutMs: number): number {
  return callTimeoutMs + 5_000;
}

/**
 * RPC timeout (ms) for the POST /session call (P0-1).
 *
 * /session setup runs far longer than the attach poll alone: the sidecar polls for an attach target up to
 * `createSessionTimeout` (default 60s) and waits up to the app-launch root wait (max(waitForAppLaunch,10s))
 * for the top-level window to surface, so /session gets its own budget scaled from those knobs instead of
 * the per-op timeout. This sits ABOVE the sidecar's own session-setup watchdog
 * (OpLogic.SessionSetupTimeout); the RpcClient adds a further +5s hard backstop.
 */
export function sessionRpcTimeoutMs(opts: {
  waitForAppLaunchSec?: number;
  createSessionTimeoutMs?: number;
  graceMs?: number;
}): number {
  const launchWaitMs = Math.max((opts.waitForAppLaunchSec ?? 0) * 1000, 10_000);
  const createSessionTimeoutMs = opts.createSessionTimeoutMs ?? 60_000;
  return launchWaitMs + createSessionTimeoutMs + (opts.graceMs ?? 30_000);
}
