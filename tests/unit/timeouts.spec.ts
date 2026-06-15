import { expect } from 'chai';
import { sessionRpcTimeoutMs } from '../../lib/backend/timeouts';

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
