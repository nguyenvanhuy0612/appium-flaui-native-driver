import { expect } from 'chai';
import {
  DEFAULT_OPERATION_TIMEOUT_MS,
  DEFAULT_POWERSHELL_TIMEOUT_MS,
  opRpcTimeoutMs,
  rpcHardBackstopMs,
  sessionRpcTimeoutMs,
} from '../../lib/backend/timeouts';

describe('per-op timeout derivation (L1<L2<L3<L4, single knob)', () => {
  it('default operationTimeout is 300000 ms (MUST match the sidecar default)', () => {
    expect(DEFAULT_OPERATION_TIMEOUT_MS).to.equal(300_000);
  });

  it('default powershell per-call timeout is 300000 ms (MUST match RunPowerShell in Program.cs)', () => {
    expect(DEFAULT_POWERSHELL_TIMEOUT_MS).to.equal(300_000);
  });

  it('defaults: L3 (RPC abort) = 300000 + 5000 = 305000', () => {
    expect(opRpcTimeoutMs(undefined)).to.equal(305_000);
    expect(opRpcTimeoutMs()).to.equal(305_000);
  });

  it('defaults: L4 (hard backstop) = L3 + 5000 = 310000', () => {
    expect(rpcHardBackstopMs(opRpcTimeoutMs())).to.equal(310_000);
  });

  it('flaui:operationTimeout: 20000 overrides the knob → L3 25000, L4 30000', () => {
    const l3 = opRpcTimeoutMs(20_000);
    expect(l3).to.equal(25_000);
    expect(rpcHardBackstopMs(l3)).to.equal(30_000);
  });

  it('ordering invariant: watchdog < L3 < L4 for any cap', () => {
    for (const cap of [1_000, 20_000, 300_000, 600_000]) {
      const l3 = opRpcTimeoutMs(cap);
      expect(cap).to.be.lessThan(l3);
      expect(l3).to.be.lessThan(rpcHardBackstopMs(l3));
    }
  });
});

describe('sessionRpcTimeoutMs (P0-1 /session RPC budget)', () => {
  it('defaults: 10s root wait + 60s attach budget + 30s grace', () => {
    // No waitForAppLaunch, no createSessionTimeout → 10_000 + 60_000 + 30_000.
    expect(sessionRpcTimeoutMs({})).to.equal(100_000);
  });

  it('includes createSessionTimeout (the attach poll budget)', () => {
    // The bug this fixes: a custom attach budget must extend the RPC timeout, else the transport aborts a
    // slow attach the sidecar is still polling for.
    expect(sessionRpcTimeoutMs({ createSessionTimeoutMs: 90_000 })).to.equal(10_000 + 90_000 + 30_000);
  });

  it('honours a long app-launch wait (seconds → ms, floored at 10s)', () => {
    expect(sessionRpcTimeoutMs({ waitForAppLaunchSec: 25 })).to.equal(25_000 + 60_000 + 30_000);
    // Below the 10s floor still uses 10s.
    expect(sessionRpcTimeoutMs({ waitForAppLaunchSec: 2 })).to.equal(10_000 + 60_000 + 30_000);
  });

  it('always exceeds the attach budget alone (the transport sits above the sidecar watchdog)', () => {
    const createSessionTimeoutMs = 120_000;
    expect(sessionRpcTimeoutMs({ createSessionTimeoutMs })).to.be.greaterThan(createSessionTimeoutMs);
  });

  it('grace is overridable', () => {
    expect(sessionRpcTimeoutMs({ graceMs: 5_000 })).to.equal(10_000 + 60_000 + 5_000);
  });
});
