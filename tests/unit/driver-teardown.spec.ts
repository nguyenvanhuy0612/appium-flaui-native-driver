// Characterization coverage for the FlaUINativeDriver teardown + actions-release surface:
//   - deleteSession ordering (lib/driver.ts:255-283): postrun PowerShell → client.deleteSession()
//     → sidecar.stop() → super.deleteSession(); a postrun failure is SWALLOWED (teardown completes);
//     postrun runs only when postrun.script|command is set; postrun is feature-gated (power_shell).
//   - releaseActions (lib/driver.ts:684): a documented no-op stub that resolves and never throws.
//
// Same loader constraint as driver-core.spec.ts: the driver transitively imports @appium/base-driver
// whose ESM deep-deps trip tsx, so we drive a PLAIN-node child process that imports the BUILT driver,
// records the order of teardown side-effects against in-memory stubs, and reports JSON we assert on.
import { expect } from 'chai';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const builtDriver = path.join(repoRoot, 'build/lib/driver.js');
const builtDriverUrl = pathToFileURL(builtDriver).href;

const PROBE = `
import { FlaUINativeDriver } from ${JSON.stringify(builtDriverUrl)};

function mk() {
  const d = new FlaUINativeDriver({}, false);
  d.opts.automationName = 'FlaUINative';
  return d;
}
async function cap(fn) {
  try { const value = await fn(); return { threw: false, value }; }
  catch (e) { return { threw: true, name: e && e.constructor && e.constructor.name, msg: String(e && e.message || e) }; }
}

// A driver wired for teardown: records the global ORDER of every teardown side-effect into \`order\`.
// We stub super.deleteSession on BaseDriver.prototype (skips base-driver session machinery), op()
// (the postrun PowerShell path) and the sidecar's client.deleteSession + stop.
function teardownDriver({ postrun, featureEnabled = true, postrunThrows = false, deleteSessionThrows = false } = {}) {
  const d = mk();
  const order = [];
  d.order = order;
  if (postrun !== undefined) d.opts.postrun = postrun;

  // assertFeatureEnabled gate (mirrors the real power_shell gate): record the gate call; optionally throw.
  d.featureCalls = [];
  d.assertFeatureEnabled = (f) => {
    d.featureCalls.push(f);
    if (!featureEnabled) throw new Error("Potentially insecure feature 'power_shell' has not been enabled");
  };

  // op() is the postrun PowerShell path.
  d.op = async (o) => {
    order.push({ op: o.op, script: o.script });
    if (postrunThrows) throw new Error('postrun boom');
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  d.sidecar = {
    stopCalls: 0,
    client: {
      async deleteSession() { order.push('client.deleteSession'); if (deleteSessionThrows) throw new Error('client gone'); },
    },
    async stop() { this.stopCalls++; order.push('sidecar.stop'); },
  };

  // Stub BaseDriver.prototype.deleteSession (super) so it records last and skips real teardown.
  const baseProto = Object.getPrototypeOf(Object.getPrototypeOf(d));
  d.__baseProto = baseProto;
  d.__origSuperDelete = baseProto.deleteSession;
  baseProto.deleteSession = async function () { order.push('super.deleteSession'); };
  return d;
}
function restore(d) { d.__baseProto.deleteSession = d.__origSuperDelete; }

const out = {};

// (1) Full happy-path ordering with a postrun script set + feature enabled.
{
  const d = teardownDriver({ postrun: { script: 'Write-Host hi' } });
  const res = await cap(() => d.deleteSession('sid'));
  restore(d);
  out.fullOrder = { res, order: d.order, featureCalls: d.featureCalls, stopCalls: d.sidecar.stopCalls };
}

// (2) postrun via { command } (alias for script) also runs.
{
  const d = teardownDriver({ postrun: { command: 'Get-Date' } });
  const res = await cap(() => d.deleteSession('sid'));
  restore(d);
  out.postrunCommand = { res, order: d.order };
}

// (3) NO postrun configured → op() (the powershell path) is NEVER invoked, gate NEVER called.
{
  const d = teardownDriver({});
  const res = await cap(() => d.deleteSession('sid'));
  restore(d);
  out.noPostrun = { res, order: d.order, featureCalls: d.featureCalls };
}

// (3b) postrun present but empty (no script, no command) → treated as no postrun.
{
  const d = teardownDriver({ postrun: { script: '' } });
  const res = await cap(() => d.deleteSession('sid'));
  restore(d);
  out.emptyPostrun = { res, order: d.order, featureCalls: d.featureCalls };
}

// (4) A postrun FAILURE is swallowed — teardown still completes (client.deleteSession → stop → super).
{
  const d = teardownDriver({ postrun: { script: 'boom' }, postrunThrows: true });
  const res = await cap(() => d.deleteSession('sid'));
  restore(d);
  out.postrunFails = { res, order: d.order, stopCalls: d.sidecar.stopCalls };
}

// (5) postrun is FEATURE-GATED: feature disabled → assertFeatureEnabled throws, but that throw is
//     swallowed (best-effort), op() (powershell) NEVER runs, and teardown still completes.
{
  const d = teardownDriver({ postrun: { script: 'boom' }, featureEnabled: false });
  const res = await cap(() => d.deleteSession('sid'));
  restore(d);
  out.featureGated = { res, order: d.order, featureCalls: d.featureCalls, stopCalls: d.sidecar.stopCalls };
}

// (6) A client.deleteSession failure is swallowed; stop() + super still run.
{
  const d = teardownDriver({ deleteSessionThrows: true });
  const res = await cap(() => d.deleteSession('sid'));
  restore(d);
  out.clientDeleteFails = { res, order: d.order, stopCalls: d.sidecar.stopCalls };
}

// (7) releaseActions: a no-op that resolves to undefined and never throws.
{
  const d = mk();
  out.releaseActions = await cap(() => d.releaseActions());
}
// (7b) releaseActions does not depend on any sidecar/op wiring (truly inert).
{
  const d = mk();
  // No sidecar, no op stub at all.
  const res = await cap(() => d.releaseActions());
  out.releaseActionsNoWiring = res;
}

process.stdout.write(JSON.stringify(out));
`;

describe('FlaUINativeDriver teardown ordering + releaseActions', function () {
  let out: any;
  before(function () {
    if (!fs.existsSync(builtDriver)) this.skip();
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', PROBE], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    out = JSON.parse(raw);
  });

  describe('deleteSession ordering', () => {
    it('runs postrun PowerShell → client.deleteSession() → sidecar.stop() → super.deleteSession()', () => {
      expect(out.fullOrder.res.threw, out.fullOrder.res.msg).to.equal(false);
      expect(out.fullOrder.order).to.deep.equal([
        { op: 'powershell', script: 'Write-Host hi' },
        'client.deleteSession',
        'sidecar.stop',
        'super.deleteSession',
      ]);
      // postrun ran BEFORE the sidecar was stopped (must reach a still-running backend).
      const psIdx = out.fullOrder.order.findIndex((s: any) => s && s.op === 'powershell');
      const stopIdx = out.fullOrder.order.indexOf('sidecar.stop');
      expect(psIdx).to.be.lessThan(stopIdx);
      expect(out.fullOrder.stopCalls).to.equal(1);
    });

    it('postrun is feature-gated by assertFeatureEnabled("power_shell") before running', () => {
      expect(out.fullOrder.featureCalls).to.deep.equal(['power_shell']);
    });

    it('accepts postrun via { command } as an alias for { script }', () => {
      expect(out.postrunCommand.res.threw).to.equal(false);
      expect(out.postrunCommand.order[0]).to.deep.equal({ op: 'powershell', script: 'Get-Date' });
    });

    it('with NO postrun configured, the PowerShell op never runs and the gate is never called', () => {
      expect(out.noPostrun.res.threw).to.equal(false);
      expect(out.noPostrun.order).to.deep.equal([
        'client.deleteSession',
        'sidecar.stop',
        'super.deleteSession',
      ]);
      expect(out.noPostrun.featureCalls).to.deep.equal([]);
    });

    it('an empty postrun ({ script: "" }) is treated as no postrun', () => {
      expect(out.emptyPostrun.res.threw).to.equal(false);
      expect(out.emptyPostrun.order).to.deep.equal([
        'client.deleteSession',
        'sidecar.stop',
        'super.deleteSession',
      ]);
      expect(out.emptyPostrun.featureCalls).to.deep.equal([]);
    });

    it('a postrun FAILURE is swallowed — teardown still completes through super.deleteSession()', () => {
      expect(out.postrunFails.res.threw, out.postrunFails.res.msg).to.equal(false);
      expect(out.postrunFails.order).to.deep.equal([
        { op: 'powershell', script: 'boom' }, // attempted, then threw
        'client.deleteSession',
        'sidecar.stop',
        'super.deleteSession',
      ]);
      expect(out.postrunFails.stopCalls).to.equal(1);
    });

    it('postrun feature-gate failure is swallowed: the PowerShell op never runs, teardown still completes', () => {
      expect(out.featureGated.res.threw, out.featureGated.res.msg).to.equal(false);
      expect(out.featureGated.featureCalls).to.deep.equal(['power_shell']); // gate WAS consulted
      // The gate threw before op() — so no 'powershell' op was emitted.
      expect(out.featureGated.order).to.deep.equal([
        'client.deleteSession',
        'sidecar.stop',
        'super.deleteSession',
      ]);
      expect(out.featureGated.stopCalls).to.equal(1);
    });

    it('a client.deleteSession failure is swallowed; stop() + super still run', () => {
      expect(out.clientDeleteFails.res.threw, out.clientDeleteFails.res.msg).to.equal(false);
      expect(out.clientDeleteFails.order).to.deep.equal([
        'client.deleteSession', // attempted, then threw
        'sidecar.stop',
        'super.deleteSession',
      ]);
      expect(out.clientDeleteFails.stopCalls).to.equal(1);
    });
  });

  describe('releaseActions (documented no-op stub)', () => {
    it('resolves without throwing and returns undefined (no pressed-state tracking)', () => {
      expect(out.releaseActions.threw).to.equal(false);
      expect(out.releaseActions.value).to.equal(undefined);
    });
    it('is inert: needs no sidecar/op wiring to succeed', () => {
      expect(out.releaseActionsNoWiring.threw).to.equal(false);
      expect(out.releaseActionsNoWiring.value).to.equal(undefined);
    });
  });
});
