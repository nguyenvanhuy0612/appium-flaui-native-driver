import { expect } from 'chai';
import path from 'node:path';
import { Sidecar } from '../../lib/backend/sidecar';

const FAKE = path.resolve(import.meta.dirname, '../fixtures/fake-sidecar.mjs');

describe('Sidecar process manager', () => {
  it('spawns, reads the port, and reports healthy', async () => {
    const sc = new Sidecar({ command: process.execPath, args: [FAKE] });
    await sc.start();
    expect(sc.baseUrl).to.match(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await sc.client.health()).to.equal(true);
    await sc.stop();
  });

  it('stop() terminates the process', async () => {
    const sc = new Sidecar({ command: process.execPath, args: [FAKE] });
    await sc.start();
    await sc.stop();
    expect(sc.isRunning).to.equal(false);
  });

  it('stop() does not hang when the process already exited (deleteSession wedge guard)', async () => {
    const sc = new Sidecar({ command: process.execPath, args: [FAKE] });
    await sc.start();
    // The sidecar dies on its OWN (idle self-exit / crash) — not via stdin/stop() — so the persistent
    // 'exit' listener fires while `proc` is still set. stop() must not then await an 'exit' that already happened.
    try { await fetch(sc.baseUrl + '/__die'); } catch { /* connection may drop as it exits */ }
    const deadline = Date.now() + 3_000;
    while (!sc.hasExited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(sc.hasExited, 'process should have exited on its own').to.equal(true);
    const t0 = Date.now();
    await sc.stop(); // BUG (pre-fix): awaited a never-firing 'exit' → hung forever
    expect(Date.now() - t0, 'stop() must return promptly on an already-exited process').to.be.lessThan(1_500);
  });

  it('C: tracks process death (hasExited / exitReason)', async () => {
    const sc = new Sidecar({ command: process.execPath, args: [FAKE] });
    await sc.start();
    expect(sc.hasExited, 'alive after start').to.equal(false);
    expect(sc.exitReason).to.equal('running');
    await sc.stop();
    expect(sc.hasExited, 'dead after stop').to.equal(true);
    expect(sc.exitReason).to.match(/code|signal/);
  });
});
