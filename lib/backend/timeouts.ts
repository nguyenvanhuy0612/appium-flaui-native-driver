// Pure timeout-derivation helpers (no Appium/Node deps) so they can be unit-tested directly without the
// tsx-unfriendly base-driver import chain (see driver-core.spec.ts for why the driver can't be imported).

/**
 * RPC timeout (ms) for the POST /session call (P0-1).
 *
 * /session setup runs far longer than a per-op: the sidecar polls for an attach target up to
 * `createSessionTimeout` (default 60s) and waits up to the app-launch root wait (max(waitForAppLaunch,10s))
 * for the top-level window to surface. The default 30s per-op RPC timeout aborts the transport before the
 * sidecar can legitimately finish, so /session needs its own budget. This sits ABOVE the sidecar's own
 * session-setup watchdog (OpLogic.SessionSetupTimeout); the RpcClient adds a further +5s hard backstop.
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
