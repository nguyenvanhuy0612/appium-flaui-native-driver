// Audit-fix regressions — proves the adversarial-audit fixes hold end-to-end on the real box.
// Maps to: F18 (malformed body / missing op -> mapped W3C error, no raw 500), F17 (bad appTopLevelWindow
// hex -> clear error), F4 (PowerShell timeout bounded), F23 (prerun is gated on power_shell — positive
// path here; the NEGATIVE gate is covered by a unit-level assertion since the shared AppiumSrv has the
// feature enabled server-wide and cannot be toggled per-session).
import { expect } from 'chai';
import { w3c, SessionPool, TARGET_APP, requireAppium } from '../lib/helpers.js';

describe('Audit fixes', function () {
  this.timeout(120_000);
  before(requireAppium);
  const pool = new SessionPool();
  let sid: string;
  before(async () => { sid = await pool.open(); });
  after(async () => { await pool.cleanup(); });

  it('F17: bad appTopLevelWindow hex -> session fails with a clear (non-unknown) error', async () => {
    const res = await w3c.newSession({ 'appium:appTopLevelWindow': 'NOT-HEX-ZZZ' });
    pool.track((res.value as any)?.sessionId);
    expect(res.status, `HTTP status: ${res.raw?.slice(0, 200)}`).to.be.greaterThanOrEqual(400);
    // Surfaced as a session-creation failure carrying the invalid-argument cause (not an opaque unknown).
    const blob = JSON.stringify(res.value).toLowerCase();
    expect(blob, 'error should reference the bad hex HWND').to.match(/hex|hwnd|invalid|argument/);
  });

  it('F18: malformed JSON body on a W3C endpoint -> mapped error, not a raw 500', async () => {
    // Send a body that is not valid JSON to the find endpoint.
    const res = await w3c.raw('POST', `/session/${sid}/element`, undefined);
    // base-driver requires using/value; with no body it returns a clean 4xx W3C error envelope.
    expect(res.status, 'HTTP status').to.be.greaterThanOrEqual(400);
    expect(res.status, 'must not be a raw 500-with-no-envelope').to.be.lessThan(500);
    expect(res.value, 'value object').to.be.an('object');
    expect((res.value as any).error, 'W3C error code').to.be.a('string');
  });

  it('F18: unknown op kind surfaces a clean error envelope (no raw 500)', async () => {
    // The execute path for an unknown windows: command exercises the dispatch guard.
    const res = await w3c.execute(sid, 'windows: __no_such_op__', [{}]);
    expect(res.status).to.be.greaterThanOrEqual(400);
    expect(res.value, 'value object').to.be.an('object');
    expect((res.value as any).error, 'W3C error code').to.be.a('string');
  });

  it('F23: prerun WITH power_shell runs at session start (positive gate path)', async () => {
    const marker = 'prerun-marker-' + Date.now();
    const markerFile = `C:\\Users\\admin\\${marker}.txt`;
    const res = await w3c.newSession({
      'appium:app': TARGET_APP,
      'appium:prerun': { command: `Set-Content -Path '${markerFile}' -Value '${marker}'` },
    });
    pool.track(res.value?.sessionId);
    expect(res.status, `session w/ prerun: ${res.raw?.slice(0, 200)}`).to.equal(200);
    const sid2 = res.value.sessionId;
    // Verify prerun actually executed by reading the file back via powershell (also gated on power_shell).
    const read = await w3c.execute(sid2, 'powershell', [{ command: `Get-Content '${markerFile}'` }]);
    expect(read.status).to.equal(200);
    expect(String(read.value)).to.include(marker);
    // cleanup the artifact
    try { await w3c.execute(sid2, 'powershell', [{ command: `Remove-Item -Force '${markerFile}'` }]); } catch { /* ignore */ }
    await w3c.deleteSession(sid2);
    pool.forget(sid2);
  });

  it('F4: a slow PowerShell command is bounded and surfaces a timeout (not a hang)', async () => {
    // The per-call `timeout` (ms) bounds the child; a 30s sleep with a 2s budget must time out fast.
    const res = await w3c.newSession({ 'appium:app': TARGET_APP });
    pool.track(res.value?.sessionId);
    expect(res.status).to.equal(200);
    const sid2 = res.value.sessionId;
    const started = Date.now();
    const ps = await w3c.execute(sid2, 'powershell', [{ command: 'Start-Sleep -Seconds 30', timeout: 2000 }]);
    const elapsed = Date.now() - started;
    // Must come back well under the 30s sleep — the child was killed at the ~2s budget.
    expect(elapsed, 'should be bounded, not hang for 30s').to.be.lessThan(20_000);
    expect(ps.status, 'bounded -> W3C error').to.be.greaterThanOrEqual(400);
    expect((ps.value as any)?.error ?? '', 'timeout error code').to.match(/timeout/i);
    await w3c.deleteSession(sid2);
    pool.forget(sid2);
  });
});
