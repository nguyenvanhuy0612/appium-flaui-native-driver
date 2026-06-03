// Hang-injection E2E — the driver's HEADLINE stability proof (design §6 / §1.1, audit F1).
//
// A genuinely frozen target app MUST fail ONE command fast (bounded by flaui:operationTimeout) while the
// Appium SERVER and the SESSION both SURVIVE. We prove this against a real frozen UI, not a mock:
//
//   - TARGET: HangApp (sidecar/fixtures/HangApp) — a WinForms window whose "Freeze" button blocks its own
//     UI thread for 60s. Once blocked, the window stops pumping messages and any cross-process UIA query
//     against it (find / attributes / getText) hangs — the canonical hung-app condition.
//   - TRIGGER: a REAL pointer click via `windows: click`, which sends synthetic mouse input and returns
//     (it does NOT call InvokePattern, which would block on the frozen Click handler).
//
// Assertions:
//   1. BOUNDED FAIL-FAST: after the freeze, an op touching the window returns a W3C `timeout` error in
//      ~flaui:operationTimeout (3s here), NOT the full 60s freeze.
//   2. SESSION/SERVER SURVIVAL: GET /status stays fast; DELETE /session succeeds cleanly; a brand-new
//      session can be created and DRIVEN against a fresh (responsive) app.
//
// HangApp must be published to HANG_APP (default C:\Users\admin\HangApp\HangApp.exe). The suite runs from
// the Mac against APPIUM_URL on the box; Appium must run in an interactive desktop session so synthetic
// input lands.
import { expect } from 'chai';
import { w3c, SessionPool, sleep } from '../lib/helpers.js';

const HANG_APP = process.env.HANG_APP ?? 'C:\\Users\\admin\\HangApp\\HangApp.exe';
const OP_TIMEOUT_MS = 3000;

describe('Hang injection — frozen app fails fast, server + session survive (F1)', function () {
  this.timeout(120_000);
  const pool = new SessionPool();
  after(async () => { await pool.cleanup(); });

  it('a frozen UI thread -> ONE op times out fast; server + session survive', async () => {
    // ── Arrange: a session on the freezable app with a LOW per-op watchdog. ─────────────────────────
    const sid = await pool.open({
      'appium:app': HANG_APP,
      'flaui:operationTimeout': OP_TIMEOUT_MS,
      // Keep layer-5 off for the headline proof: we assert pure fail-fast + survival, not a recycle.
      'flaui:autoRecycle': false,
    });

    // Bring the window forward so the synthetic click lands on it.
    await w3c.execute(sid, 'windows: setWindowForeground', []);
    await sleep(300);

    // Locate the Freeze button (WinForms control Name -> UIA AutomationId). Resolve its rect now, while
    // the app is still responsive, so the click op itself does not need to query a frozen window.
    const find = await w3c.findElement(sid, 'accessibility id', 'FreezeButton');
    expect(find.status, `find FreezeButton: ${find.raw?.slice(0, 200)}`).to.equal(200);
    const btnId = w3c.elementId(find.value)!;
    expect(btnId, 'FreezeButton element id').to.be.a('string').and.have.length.greaterThan(0);

    // ── Act 1: inject the freeze with a REAL pointer click (returns after sending input). ───────────
    const clicked = await w3c.execute(sid, 'windows: click', [{ elementId: btnId }]);
    expect(clicked.status, `windows: click: ${clicked.raw?.slice(0, 200)}`).to.equal(200);

    // Give the click time to land and the Click handler to wedge the UI thread.
    await sleep(800);

    // ── Assert 1: BOUNDED FAIL-FAST. An op that queries the now-frozen window must return a W3C
    // `timeout` in ~OP_TIMEOUT_MS, NOT block for the full 60s freeze. getText reads the button's
    // ValuePattern/Name — a cross-process UIA call that hangs against a non-pumping window. ──────────
    const started = Date.now();
    const hung = await w3c.getText(sid, btnId);
    const elapsed = Date.now() - started;

    expect(hung.status, `frozen op HTTP status: ${hung.raw?.slice(0, 200)}`).to.be.greaterThanOrEqual(400);
    expect(hung.error, 'frozen op should map to W3C timeout').to.match(/timeout/i);
    // Fast: comfortably above the 3s budget's watchdog+probe, far below the 60s freeze.
    expect(elapsed, `should fail fast (~${OP_TIMEOUT_MS}ms), not hang ~60s`).to.be.lessThan(15_000);
    expect(elapsed, 'should not return instantly (the watchdog actually waited the budget)')
      .to.be.greaterThanOrEqual(OP_TIMEOUT_MS - 500);

    // ── Assert 2a: SERVER SURVIVAL — /status is still fast right after the hang. ────────────────────
    const stStart = Date.now();
    const st = await w3c.status();
    const stElapsed = Date.now() - stStart;
    expect(st.status, 'GET /status after hang').to.equal(200);
    expect(st.value?.ready, 'server still ready').to.not.equal(false);
    expect(stElapsed, 'GET /status must be fast (server not blocked by the frozen app)').to.be.lessThan(5_000);

    // ── Assert 2b: SESSION SURVIVAL — DELETE /session succeeds cleanly (no hang on teardown). ───────
    const delStart = Date.now();
    const del = await w3c.deleteSession(sid);
    const delElapsed = Date.now() - delStart;
    pool.forget(sid);
    expect(del.status, `DELETE /session after hang: ${del.raw?.slice(0, 200)}`).to.equal(200);
    expect(delElapsed, 'DELETE /session should be bounded, not hang').to.be.lessThan(20_000);

    // ── Assert 2c: a brand-new session can be created AND driven against a fresh, responsive app. ───
    const sid2 = await pool.open({ 'appium:app': HANG_APP, 'flaui:operationTimeout': OP_TIMEOUT_MS });
    const find2 = await w3c.findElement(sid2, 'accessibility id', 'FreezeButton');
    expect(find2.status, `find on new session: ${find2.raw?.slice(0, 200)}`).to.equal(200);
    const btn2 = w3c.elementId(find2.value)!;
    // Drive a real op on the fresh app — must succeed quickly (not frozen).
    const txt2 = await w3c.getText(sid2, btn2);
    expect(txt2.status, 'getText on fresh session').to.equal(200);
    expect(String(txt2.value), 'fresh button text').to.match(/freeze/i);

    const del2 = await w3c.deleteSession(sid2);
    expect(del2.status, 'DELETE new session').to.equal(200);
    pool.forget(sid2);
  });
});
