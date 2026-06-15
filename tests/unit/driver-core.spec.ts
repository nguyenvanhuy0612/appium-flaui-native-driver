// Unit coverage for the FlaUINativeDriver "core" logic: the session-dead state machine
// (ensureHealthyAndOp/markDead — policy C), RpcError→W3C error mapping in op(), the per-op RPC
// timeout derivation (rpcTimeoutFor), the idle-timeout derivation written into sessionBody, and the
// createSession capability guard.
//
// Like feature-gate.spec.ts: the driver class transitively imports @appium/base-driver, whose ESM
// deep-deps (unicorn-magic './node') trip tsx's loader, so we cannot `import` the driver inside this
// tsx-run spec. Instead we drive a PLAIN-node child process that imports the BUILT driver, exercises
// the real methods against in-memory stubs (no live sidecar), and reports JSON we assert on here.
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
import { errors } from '@appium/base-driver';
import { RpcError } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'build/lib/backend/rpc-client.js')).href)};

// A fake Sidecar: just the surface ensureHealthyAndOp touches.
function fakeSidecar(opImpl) {
  const s = {
    hasExited: false,
    exitReason: 'running',
    stopCalls: 0,
    async stop() { this.stopCalls++; },
    client: { op: opImpl },
  };
  return s;
}
function mk() {
  const d = new FlaUINativeDriver({}, false);
  d.opts.automationName = 'FlaUINative';
  return d;
}
async function cap(fn) {
  try { const value = await fn(); return { threw: false, value }; }
  catch (e) { return { threw: true, name: e && e.constructor && e.constructor.name, msg: String(e && e.message || e) }; }
}

const out = {};

// ── 1. state machine (policy C) ──────────────────────────────────────────────────────────────
// (a) clean RpcError rethrows and the session stays alive (a later op still reaches the client).
{
  const d = mk();
  let calls = 0;
  d.sidecar = fakeSidecar(async () => { calls++; if (calls === 1) throw new RpcError('no such element', 'nope'); return { ok: 1 }; });
  const first = await cap(() => d.ensureHealthyAndOp({ op: 'source', startId: 'root' }));
  const second = await cap(() => d.ensureHealthyAndOp({ op: 'source', startId: 'root' }));
  out.cleanRpc = { first, second, sessionDead: d.sessionDead, stopCalls: d.sidecar.stopCalls };
}

// (b) transport (non-RpcError) error, autoRecycle OFF → stop() called, sessionDead latched, throws
//     NoSuchDriverError; a later op fails fast WITHOUT touching the client.
{
  const d = mk();
  let clientCalls = 0;
  d.sidecar = fakeSidecar(async () => { clientCalls++; throw new Error('connect ECONNREFUSED'); });
  const first = await cap(() => d.ensureHealthyAndOp({ op: 'source', startId: 'root' }));
  const callsAfterFirst = clientCalls;
  const stopAfterFirst = d.sidecar.stopCalls;
  const deadAfterFirst = d.sessionDead;
  const second = await cap(() => d.ensureHealthyAndOp({ op: 'source', startId: 'root' }));
  out.transportNoRecycle = {
    first, second,
    callsAfterFirst, stopAfterFirst, deadAfterFirst,
    clientCallsTotal: clientCalls, // must stay == callsAfterFirst (second op never hit the client)
    deadReasonHasReason: /became unresponsive|exited/.test(d.deadReason),
  };
}

// (c) autoRecycle ON → tryRecycle attempted then retry-once. We stub tryRecycle so no real process
//     spawns; first client call throws transport, recycle "succeeds", retry returns a value.
{
  const d = mk();
  d.opts['flaui:autoRecycle'] = true;
  let calls = 0;
  d.sidecar = fakeSidecar(async () => { calls++; if (calls === 1) throw new Error('boom transport'); return { recovered: true }; });
  let recycleCalls = 0;
  d.tryRecycle = async () => { recycleCalls++; return true; };
  const res = await cap(() => d.ensureHealthyAndOp({ op: 'source', startId: 'root' }));
  out.autoRecycle = { res, recycleCalls, clientCalls: calls, sessionDead: d.sessionDead };
}

// (c2) autoRecycle ON but recycle FAILS → UnknownError, session not latched dead.
{
  const d = mk();
  d.opts['flaui:autoRecycle'] = true;
  d.sidecar = fakeSidecar(async () => { throw new Error('boom transport'); });
  d.tryRecycle = async () => false;
  const res = await cap(() => d.ensureHealthyAndOp({ op: 'source', startId: 'root' }));
  out.autoRecycleFailed = { res, sessionDead: d.sessionDead };
}

// (d) markDead directly: latches state and throws NoSuchDriverError; a pre-dead session fails fast.
{
  const d = mk();
  let clientCalls = 0;
  d.sidecar = fakeSidecar(async () => { clientCalls++; return { v: 1 }; });
  d.sessionDead = true;
  d.deadReason = 'preset reason';
  const res = await cap(() => d.ensureHealthyAndOp({ op: 'source', startId: 'root' }));
  out.preDead = { res, clientCalls };
}

// (e) sidecar.hasExited true + autoRecycle off → markDead before any client call.
{
  const d = mk();
  let clientCalls = 0;
  d.sidecar = fakeSidecar(async () => { clientCalls++; return { v: 1 }; });
  d.sidecar.hasExited = true;
  d.sidecar.exitReason = 'code 3';
  const res = await cap(() => d.ensureHealthyAndOp({ op: 'source', startId: 'root' }));
  out.exitedFailsFast = { res, clientCalls, sessionDead: d.sessionDead };
}

// (f) backend-fatal RpcError, autoRecycle OFF → routed as a TRANSPORT failure (NOT a live RpcError):
//     stop() called, sessionDead latched, throws NoSuchDriverError. (P1-4)
{
  const d = mk();
  d.sidecar = fakeSidecar(async () => { throw new RpcError('backend fatal', 'UIA scheduler unrecoverable: 5 poisoned worker threads'); });
  const res = await cap(() => d.ensureHealthyAndOp({ op: 'source', startId: 'root' }));
  out.backendFatalNoRecycle = { res, stopCalls: d.sidecar.stopCalls, sessionDead: d.sessionDead };
}

// (g) backend-fatal RpcError, autoRecycle ON → tryRecycle + retry once (does NOT propagate as RpcError). (P1-4)
{
  const d = mk();
  d.opts['flaui:autoRecycle'] = true;
  let calls = 0;
  d.sidecar = fakeSidecar(async () => { calls++; if (calls === 1) throw new RpcError('backend fatal', 'unrecoverable'); return { revived: true }; });
  let recycleCalls = 0;
  d.tryRecycle = async () => { recycleCalls++; return true; };
  const res = await cap(() => d.ensureHealthyAndOp({ op: 'source', startId: 'root' }));
  out.backendFatalRecycle = { res, recycleCalls, clientCalls: calls, sessionDead: d.sessionDead };
}

// ── 2. op() RpcError.type → W3C error class mapping ───────────────────────────────────────────
{
  const types = {
    'stale element reference': 'StaleElementReferenceError',
    'no such element': 'NoSuchElementError',
    'invalid selector': 'InvalidSelectorError',
    'invalid argument': 'InvalidArgumentError',
    'timeout': 'TimeoutError',
    'something weird': 'UnknownError', // default
  };
  out.opMapping = {};
  for (const t of Object.keys(types)) {
    const d = mk();
    // Make ensureHealthyAndOp throw a clean RpcError so op()'s catch maps it.
    d.ensureHealthyAndOp = async () => { throw new RpcError(t, 'msg-' + t); };
    const r = await cap(() => d.op({ op: 'source', startId: 'root' }));
    out.opMapping[t] = { name: r.name, msg: r.msg, expected: types[t] };
  }
  // non-RpcError passes through unchanged.
  const d2 = mk();
  d2.ensureHealthyAndOp = async () => { throw new errors.NoSuchDriverError('latched'); };
  out.opMappingPassthrough = await cap(() => d2.op({ op: 'source', startId: 'root' }));
}

// ── 3. rpcTimeoutFor ──────────────────────────────────────────────────────────────────────────
{
  out.rpcTimeout = {};
  // powershell: op.timeoutMs wins
  let d = mk();
  out.rpcTimeout.psOpTimeout = d.rpcTimeoutFor({ op: 'powershell', script: 'x', timeoutMs: 1000 }); // 6000
  // powershell: default 60000 (no session-level cap any more)
  d = mk();
  out.rpcTimeout.psDefault = d.rpcTimeoutFor({ op: 'powershell', script: 'x' }); // 65000
  // non-PS: operationTimeoutMs
  d = mk(); d.operationTimeoutMs = 12000;
  out.rpcTimeout.nonPsOpTimeout = d.rpcTimeoutFor({ op: 'source', startId: 'root' }); // 17000
  // non-PS: default 30000
  d = mk();
  out.rpcTimeout.nonPsDefault = d.rpcTimeoutFor({ op: 'source', startId: 'root' }); // 35000
}

// ── 4 + 5. Real createSession: capability guard AND idle-timeout derivation ────────────────────
// Both are exercised through the REAL createSession. super.createSession() runs first, so we stub it
// on BaseDriver.prototype to skip base-driver session machinery. The body builds sessionBody, then
// reaches Sidecar.start() — we stub start() to throw a sentinel, by which point sessionBody is fully
// built. We then read back the actual sessionBody.idleTimeout the driver computed (true coverage of
// the derivation expression), and inspect whether the capability guard threw.
{
  const SENTINEL = '__past_guard__';
  const { Sidecar } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'build/lib/backend/sidecar.js')).href)});
  // runReal(opts, newCmdMs): set opts + the (instance-level) newCommandTimeoutMs the driver reads,
  // run createSession to the sentinel, return { result, sessionBody }.
  async function runReal(opts, newCmdMs) {
    const d = mk();
    Object.assign(d.opts, opts);
    if (newCmdMs !== undefined) d.newCommandTimeoutMs = newCmdMs;
    const baseProto = Object.getPrototypeOf(Object.getPrototypeOf(d)); // BaseDriver.prototype
    const origSuper = baseProto.createSession;
    baseProto.createSession = async () => ['sid', {}];
    const origStart = Sidecar.prototype.start;
    Sidecar.prototype.start = async function () { throw new Error(SENTINEL); };
    try {
      const result = await cap(() => d.createSession({}, undefined, undefined, []));
      return { result, sessionBody: d.sessionBody };
    } finally {
      baseProto.createSession = origSuper;
      Sidecar.prototype.start = origStart;
    }
  }

  // 5. capability guard
  out.caps = {};
  for (const [label, opts] of [
    ['app', { app: 'C:/x.exe' }],
    ['appTopLevelWindow', { appTopLevelWindow: '0x1234' }],
    ['appName', { appName: 'SecureAge' }],
    ['processName', { processName: 'SecureAge.exe' }],
  ]) {
    const { result } = await runReal(opts);
    // Guard passed iff createSession got PAST it (threw the later sentinel), not the guard message.
    out.caps[label] = { threw: result.threw, msg: result.msg, pastGuard: result.threw && result.msg.includes(SENTINEL) };
  }
  const none = await runReal({});
  out.caps.none = {
    threw: none.result.threw,
    msg: none.result.msg,
    isGuardError: none.result.threw && /must be provided/.test(none.result.msg),
  };
  // appProcessId is no longer a recognised attach capability: alone it must NOT satisfy the guard.
  const onlyPid = await runReal({ appProcessId: 4321 });
  out.caps.appProcessIdAlone = {
    threw: onlyPid.result.threw,
    msg: onlyPid.result.msg,
    isGuardError: onlyPid.result.threw && /must be provided/.test(onlyPid.result.msg),
  };

  // 5b. sessionBody field coverage: with processName + createSessionTimeout default, and NOT appProcessId.
  out.sessionBody = {
    withProcessName: (await runReal({ processName: 'SecureAge.exe' })).sessionBody,
    defaultCreateTimeout: (await runReal({ app: 'C:/x.exe' })).sessionBody,
    explicitCreateTimeout: (await runReal({ app: 'C:/x.exe', createSessionTimeout: 12345 })).sessionBody,
  };

  // 4. idle-timeout derivation read back from the real sessionBody (with app set so the guard passes).
  const base = { app: 'C:/x.exe' };
  out.idle = {
    override: (await runReal({ ...base, 'flaui:idleTimeout': 99999 }, 50000)).sessionBody.idleTimeout,       // 99999
    overrideZero: (await runReal({ ...base, 'flaui:idleTimeout': 0 }, 50000)).sessionBody.idleTimeout,       // 0
    derived: (await runReal(base, 60000)).sessionBody.idleTimeout,                                           // 180000
    disabledZero: (await runReal(base, 0)).sessionBody.idleTimeout,                                          // 0
    disabledUndef: (await runReal(base, 0)).sessionBody.idleTimeout,                                         // 0 (no newCommandTimeout)
  };
}

process.stdout.write(JSON.stringify(out));
`;

describe('FlaUINativeDriver core (state machine, op mapping, timeouts, caps)', function () {
  let out: any;
  before(function () {
    if (!fs.existsSync(builtDriver)) this.skip(); // run `npm run build` first
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', PROBE], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    out = JSON.parse(raw);
  });

  describe('1. ensureHealthyAndOp / markDead state machine (policy C)', () => {
    it('a clean RpcError rethrows and the session stays ALIVE (a later op still reaches the client)', () => {
      expect(out.cleanRpc.first.threw).to.equal(true);
      expect(out.cleanRpc.first.name).to.equal('RpcError');
      expect(out.cleanRpc.sessionDead).to.equal(false);
      expect(out.cleanRpc.stopCalls).to.equal(0);
      // Second op succeeded → session was never killed.
      expect(out.cleanRpc.second.threw).to.equal(false);
      expect(out.cleanRpc.second.value).to.deep.equal({ ok: 1 });
    });

    it('a transport error (autoRecycle off) calls stop(), latches sessionDead, throws NoSuchDriverError', () => {
      const r = out.transportNoRecycle;
      expect(r.first.threw).to.equal(true);
      expect(r.first.name).to.equal('NoSuchDriverError');
      expect(r.stopAfterFirst).to.equal(1);
      expect(r.deadAfterFirst).to.equal(true);
      expect(r.deadReasonHasReason).to.equal(true);
    });

    it('once latched dead, a later op fails fast with NoSuchDriverError WITHOUT touching the client', () => {
      const r = out.transportNoRecycle;
      expect(r.second.threw).to.equal(true);
      expect(r.second.name).to.equal('NoSuchDriverError');
      // The client was hit exactly once (the first op); the latched op never reached it.
      expect(r.clientCallsTotal).to.equal(r.callsAfterFirst);
      expect(r.clientCallsTotal).to.equal(1);
    });

    it('a pre-latched dead session fails fast with the stored reason, never touching the client', () => {
      expect(out.preDead.res.threw).to.equal(true);
      expect(out.preDead.res.name).to.equal('NoSuchDriverError');
      expect(out.preDead.res.msg).to.equal('preset reason');
      expect(out.preDead.clientCalls).to.equal(0);
    });

    it('a sidecar that already exited (autoRecycle off) fails fast before any client call', () => {
      expect(out.exitedFailsFast.res.threw).to.equal(true);
      expect(out.exitedFailsFast.res.name).to.equal('NoSuchDriverError');
      expect(out.exitedFailsFast.res.msg).to.match(/exited \(code 3\)/);
      expect(out.exitedFailsFast.clientCalls).to.equal(0);
      expect(out.exitedFailsFast.sessionDead).to.equal(true);
    });

    it('autoRecycle on: a transport failure triggers tryRecycle then retries the op once', () => {
      expect(out.autoRecycle.recycleCalls).to.equal(1);
      expect(out.autoRecycle.clientCalls).to.equal(2); // initial failure + retry
      expect(out.autoRecycle.res.threw).to.equal(false);
      expect(out.autoRecycle.res.value).to.deep.equal({ recovered: true });
      expect(out.autoRecycle.sessionDead).to.equal(false);
    });

    it('autoRecycle on but recycle fails: throws UnknownError, session not latched dead', () => {
      expect(out.autoRecycleFailed.res.threw).to.equal(true);
      expect(out.autoRecycleFailed.res.name).to.equal('UnknownError');
      expect(out.autoRecycleFailed.res.msg).to.match(/could not be recycled/);
      expect(out.autoRecycleFailed.sessionDead).to.equal(false);
    });

    it('a "backend fatal" RpcError (autoRecycle off) is treated as TRANSPORT failure: stop(), latched dead, NoSuchDriverError', () => {
      const r = out.backendFatalNoRecycle;
      expect(r.res.threw).to.equal(true);
      expect(r.res.name).to.equal('NoSuchDriverError'); // NOT rethrown as a live RpcError
      expect(r.stopCalls).to.equal(1);
      expect(r.sessionDead).to.equal(true);
    });

    it('a "backend fatal" RpcError (autoRecycle on) recycles then retries the op once', () => {
      const r = out.backendFatalRecycle;
      expect(r.recycleCalls).to.equal(1);
      expect(r.clientCalls).to.equal(2); // initial fatal + retry
      expect(r.res.threw).to.equal(false);
      expect(r.res.value).to.deep.equal({ revived: true });
      expect(r.sessionDead).to.equal(false);
    });
  });

  describe('2. op() RpcError.type → W3C error class mapping', () => {
    const cases: Array<[string, string]> = [
      ['stale element reference', 'StaleElementReferenceError'],
      ['no such element', 'NoSuchElementError'],
      ['invalid selector', 'InvalidSelectorError'],
      ['invalid argument', 'InvalidArgumentError'],
      ['timeout', 'TimeoutError'],
      ['something weird', 'UnknownError'],
    ];
    for (const [type, klass] of cases) {
      it(`'${type}' → ${klass} (message preserved)`, () => {
        const m = out.opMapping[type];
        expect(m.name).to.equal(klass);
        expect(m.msg).to.equal('msg-' + type);
      });
    }
    it('a non-RpcError (e.g. latched NoSuchDriverError) passes through unchanged', () => {
      expect(out.opMappingPassthrough.name).to.equal('NoSuchDriverError');
      expect(out.opMappingPassthrough.msg).to.equal('latched');
    });
  });

  describe('3. rpcTimeoutFor', () => {
    it('powershell op.timeoutMs wins: timeoutMs + 5000', () => {
      expect(out.rpcTimeout.psOpTimeout).to.equal(6000);
    });
    it('powershell default 60000 + 5000 (no session-level cap)', () => {
      expect(out.rpcTimeout.psDefault).to.equal(65000);
    });
    it('non-PS uses operationTimeoutMs + 5000', () => {
      expect(out.rpcTimeout.nonPsOpTimeout).to.equal(17000);
    });
    it('non-PS default 30000 + 5000', () => {
      expect(out.rpcTimeout.nonPsDefault).to.equal(35000);
    });
  });

  describe('4. idle-timeout derivation (sessionBody.idleTimeout)', () => {
    it('flaui:idleTimeout override wins over newCommandTimeout', () => {
      expect(out.idle.override).to.equal(99999);
    });
    it('an explicit idleTimeout of 0 wins (disables, even with a positive newCommandTimeout)', () => {
      expect(out.idle.overrideZero).to.equal(0);
    });
    it('no override + newCommandTimeout>0 → newCommandTimeoutMs + 120000', () => {
      expect(out.idle.derived).to.equal(180000);
    });
    it('newCommandTimeoutMs 0 (infinite) disables the idle guard → 0', () => {
      expect(out.idle.disabledZero).to.equal(0);
      expect(out.idle.disabledUndef).to.equal(0);
    });
  });

  describe('5. createSession capability guard', () => {
    for (const cap of ['app', 'appTopLevelWindow', 'appName', 'processName']) {
      it(`'${cap}' alone satisfies the guard (createSession proceeds past it)`, () => {
        expect(out.caps[cap].pastGuard, JSON.stringify(out.caps[cap])).to.equal(true);
      });
    }
    it('none of app/appTopLevelWindow/appName/processName → throws the "must be provided" error', () => {
      expect(out.caps.none.threw).to.equal(true);
      expect(out.caps.none.isGuardError, out.caps.none.msg).to.equal(true);
    });
    it('appProcessId is no longer recognised: alone it does NOT satisfy the guard', () => {
      expect(out.caps.appProcessIdAlone.threw).to.equal(true);
      expect(out.caps.appProcessIdAlone.isGuardError, out.caps.appProcessIdAlone.msg).to.equal(true);
    });
  });

  describe('5b. sessionBody fields (shared contract with the C# sidecar)', () => {
    it('includes processName when the processName capability is set', () => {
      expect(out.sessionBody.withProcessName.processName).to.equal('SecureAge.exe');
    });
    it('createSessionTimeout defaults to 60000 when not provided', () => {
      expect(out.sessionBody.defaultCreateTimeout.createSessionTimeout).to.equal(60000);
    });
    it('createSessionTimeout passes an explicit value through', () => {
      expect(out.sessionBody.explicitCreateTimeout.createSessionTimeout).to.equal(12345);
    });
    it('does NOT include the removed appProcessId field', () => {
      expect(out.sessionBody.defaultCreateTimeout).to.not.have.property('appProcessId');
      expect(out.sessionBody.withProcessName).to.not.have.property('appProcessId');
    });
  });
});
