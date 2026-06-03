// §8 Sessions — create/delete, capability negotiation, attach flow, desktop session, shouldCloseApp.
import { expect } from 'chai';
import { w3c, SessionPool, TARGET_APP, findEditable, findWindow } from '../lib/helpers.js';

describe('§8 Sessions', function () {
  this.timeout(120_000);
  const pool = new SessionPool();
  afterEach(async () => { await pool.cleanup(); });

  it('§8.1 New Session creates a session and returns a capabilities object', async () => {
    const res = await w3c.newSession({ 'appium:app': TARGET_APP });
    expect(res.status).to.equal(200);
    const sid = res.value.sessionId;
    pool.track(sid);
    expect(sid).to.be.a('string').and.have.length.greaterThan(0);
    expect(res.value.capabilities, 'capabilities').to.be.an('object');
    expect(res.value.capabilities.platformName).to.match(/Windows/i);
  });

  it('§8.2 Delete Session returns 200 and ends the session', async () => {
    const sid = await pool.open();
    const del = await w3c.deleteSession(sid);
    pool.forget(sid);
    expect(del.status).to.equal(200);
    expect(del.value).to.satisfy((v: unknown) => v === null || v === undefined);
  });

  it('§8.1 invalid capabilities -> a W3C session-negotiation error', async () => {
    // Missing required automationName / unknown platform => negotiation failure. Appium's own capability
    // validation runs before the driver and surfaces `invalid argument` (400) when a required cap is
    // missing; a driver-level rejection surfaces `session not created` (500). Both are W3C-correct.
    const res = await w3c.newSessionRaw({
      capabilities: { alwaysMatch: { platformName: 'NotARealOS' }, firstMatch: [{}] },
    });
    pool.track((res.value as any)?.sessionId);
    expect(res.status, 'HTTP status').to.be.greaterThanOrEqual(400);
    expect(res.error, 'W3C error code').to.be.oneOf(['session not created', 'invalid argument']);
  });

  it('§8.2 command after delete -> invalid session id (HTTP 404)', async () => {
    const sid = await pool.open();
    const del = await w3c.deleteSession(sid);
    pool.forget(sid);
    expect(del.status).to.equal(200);
    const after = await w3c.getPageSource(sid);
    expect(after.status, 'HTTP status').to.equal(404);
    expect(after.error, 'W3C error code').to.equal('invalid session id');
  });

  it('attach flow: NativeWindowHandle -> appTopLevelWindow re-attaches to a live window', async () => {
    // Launch with shouldCloseApp:false so the app survives the first session.
    const sidA = await pool.open({ 'appium:app': TARGET_APP, 'appium:shouldCloseApp': false });
    const winId = await findWindow(sidA);
    const hw = await w3c.getAttribute(sidA, winId, 'NativeWindowHandle');
    expect(hw.status).to.equal(200);
    const hwnd = hw.value;
    expect(hwnd, 'HWND').to.match(/^0x[0-9A-Fa-f]+$/);
    await w3c.deleteSession(sidA);
    pool.forget(sidA);

    // Re-attach by HWND (no app capability).
    const attach = await w3c.newSession({ 'appium:appTopLevelWindow': hwnd });
    pool.track(attach.value?.sessionId);
    expect(attach.status, `attach: ${attach.raw?.slice(0, 200)}`).to.equal(200);
    const sidB = attach.value.sessionId;
    const edId = await findEditable(sidB);
    const sv = await w3c.setValue(sidB, edId, 'attached-ok');
    expect(sv.status).to.equal(200);
    const v = await w3c.getAttribute(sidB, edId, 'Value');
    expect(v.value).to.equal('attached-ok');
    // shouldCloseApp defaults true -> deleting B closes the attached window.
    const del = await w3c.deleteSession(sidB);
    expect(del.status).to.equal(200);
    pool.forget(sidB);
  });

  it("app:'Root' creates a whole-desktop session", async () => {
    const res = await w3c.newSession({ 'appium:app': 'Root' });
    pool.track(res.value?.sessionId);
    expect(res.status, `Root: ${res.raw?.slice(0, 200)}`).to.equal(200);
    const sid = res.value.sessionId;
    // The desktop has a page source and at least one child window.
    const src = await w3c.getPageSource(sid);
    expect(src.status).to.equal(200);
    expect((src.value as string).length).to.be.greaterThan(0);
  });

  it('shouldCloseApp:false leaves the app running; a follow-up session can attach and close it', async () => {
    const sidA = await pool.open({ 'appium:app': TARGET_APP, 'appium:shouldCloseApp': false });
    const winId = await findWindow(sidA);
    const hwnd = (await w3c.getAttribute(sidA, winId, 'NativeWindowHandle')).value;
    await w3c.deleteSession(sidA);
    pool.forget(sidA);

    // App is still alive: attach succeeds.
    const attach = await w3c.newSession({ 'appium:appTopLevelWindow': hwnd, 'appium:shouldCloseApp': true });
    pool.track(attach.value?.sessionId);
    expect(attach.status, 'attach to surviving app').to.equal(200);
    const sidB = attach.value.sessionId;
    // shouldCloseApp:true -> deleting B closes the window.
    await w3c.deleteSession(sidB);
    pool.forget(sidB);
    // Re-attaching to the now-closed HWND should fail to create a session.
    const reattach = await w3c.newSession({ 'appium:appTopLevelWindow': hwnd });
    pool.track(reattach.value?.sessionId);
    expect(reattach.status, 'attach to a closed window should fail').to.be.greaterThanOrEqual(400);
  });
});
