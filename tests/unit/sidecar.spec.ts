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
});
