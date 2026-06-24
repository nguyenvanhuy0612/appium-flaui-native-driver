// §5/§6 Extension commands — `windows:` command groups against real Notepad elements where possible.
// UIA patterns, real input (keys/click/hover/scroll), clipboard (plaintext + image), app lifecycle,
// typeDelay/cacheRequest acceptance. Unsupported-on-this-element patterns must fail GRACEFULLY (no 500
// crash that kills the session) — asserted via "session survives" checks.
import { expect } from 'chai';
import {
  w3c, SessionPool, findEditable, findWindow, bringToFront, TARGET_APP, TEST_PNG_B64, b64, unb64, requireAppium,
} from '../lib/helpers.js';

describe('§5/§6 Extension commands (windows:)', function () {
  this.timeout(180_000);
  before(requireAppium);
  const pool = new SessionPool();
  let sid: string;
  let edId: string;
  before(async () => { sid = await pool.open(); edId = await findEditable(sid); });
  beforeEach(async () => { await w3c.clear(sid, edId); });
  after(async () => { await pool.cleanup(); });

  /** A command "fails gracefully" if it returns a clean W3C error (4xx/5xx with an error code) OR succeeds,
   *  but in either case the session is still alive afterward (a follow-up read works). */
  async function sessionAlive(): Promise<boolean> {
    const t = await w3c.getTitle(sid);
    return t.status === 200;
  }

  // ── UIA pattern reads/writes ──────────────────────────────────────────────────────────────────
  it('windows: setValue / getValue roundtrip on the editor (✅ path)', async () => {
    const set = await w3c.execute(sid, 'windows: setValue', [{ elementId: edId, value: 'win-set-val' }]);
    expect(set.status, `setValue: ${set.raw?.slice(0, 200)}`).to.equal(200);
    const got = await w3c.execute(sid, 'windows: getValue', [{ elementId: edId }]);
    expect(got.status).to.equal(200);
    // getValue returns { value } per the sidecar ValuePattern read.
    const gv = (got.value as any)?.value ?? got.value;
    expect(gv).to.equal('win-set-val');
  });

  it('windows: getAttributes returns a JSON map of UIA properties', async () => {
    const res = await w3c.execute(sid, 'windows: getAttributes', [{ elementId: edId }]);
    expect(res.status, `getAttributes: ${res.raw?.slice(0, 200)}`).to.equal(200);
    expect(res.value, 'attributes').to.be.an('object');
    // Should contain at least ClassName or ControlType among the UIA props.
    const keys = Object.keys(res.value as object).map((k) => k.toLowerCase());
    expect(keys.some((k) => k.includes('classname') || k.includes('controltype') || k.includes('name')),
      `keys: ${keys.join(',')}`).to.equal(true);
  });

  it('windows: setFocus on the editor (InvokePattern/Focus); session survives', async () => {
    const res = await w3c.execute(sid, 'windows: setFocus', [{ elementId: edId }]);
    // setFocus is supported on a focusable editor; tolerate either success or a clean unsupported error.
    expect([200, 400, 405, 500]).to.include(res.status);
    if (res.status !== 200) expect(res.error, 'clean W3C error').to.be.a('string');
    expect(await sessionAlive(), 'session alive after setFocus').to.equal(true);
  });

  it('windows: invoke on the window; session survives whether or not InvokePattern is supported', async () => {
    const winId = await findWindow(sid);
    const res = await w3c.execute(sid, 'windows: invoke', [{ elementId: winId }]);
    expect([200, 400, 405, 500]).to.include(res.status);
    if (res.status !== 200) expect(res.error, 'clean W3C error').to.be.a('string');
    expect(await sessionAlive(), 'session alive after invoke').to.equal(true);
  });

  it('windows: isMultiple / selectedItem degrade gracefully on a non-selection element', async () => {
    for (const cmd of ['isMultiple', 'selectedItem']) {
      const res = await w3c.execute(sid, `windows: ${cmd}`, [{ elementId: edId }]);
      expect([200, 400, 405, 500], `${cmd} status ${res.status}`).to.include(res.status);
      if (res.status !== 200) expect(res.error, `${cmd} clean error`).to.be.a('string');
    }
    expect(await sessionAlive(), 'session alive after selection reads').to.equal(true);
  });

  // ── Window pattern via windows: on the top-level window ──────────────────────────────────────
  it('windows: maximize / restore / minimize on the window', async () => {
    const winId = await findWindow(sid);
    for (const cmd of ['maximize', 'restore', 'minimize', 'restore']) {
      const res = await w3c.execute(sid, `windows: ${cmd}`, [{ elementId: winId }]);
      expect([200, 400, 405, 500], `${cmd} status ${res.status}`).to.include(res.status);
      if (res.status !== 200) expect(res.error, `${cmd} clean error`).to.be.a('string');
    }
    expect(await sessionAlive(), 'session alive after window patterns').to.equal(true);
  });

  // ── Real input ─────────────────────────────────────────────────────────────────────────────────
  it('windows: keys types text into the focused editor', async () => {
    await bringToFront(sid);
    await w3c.click(sid, edId);
    const res = await w3c.execute(sid, 'windows: keys', [{ actions: [{ text: 'typed-via-keys' }] }]);
    expect(res.status, `keys: ${res.raw?.slice(0, 200)}`).to.equal(200);
    const v = await w3c.getAttribute(sid, edId, 'Value');
    expect(v.value).to.equal('typed-via-keys');
  });

  it('windows: click on the editor focuses it', async () => {
    await bringToFront(sid);
    const res = await w3c.execute(sid, 'windows: click', [{ elementId: edId }]);
    expect(res.status, `click: ${res.raw?.slice(0, 200)}`).to.equal(200);
    const focus = await w3c.getAttribute(sid, edId, 'HasKeyboardFocus');
    expect(String(focus.value).toLowerCase()).to.equal('true');
  });

  it('windows: hover and scroll on the editor return 200', async () => {
    const hov = await w3c.execute(sid, 'windows: hover', [{ elementId: edId }]);
    expect(hov.status, `hover: ${hov.raw?.slice(0, 200)}`).to.equal(200);
    const scr = await w3c.execute(sid, 'windows: scroll', [{ elementId: edId, deltaY: -2 }]);
    expect(scr.status, `scroll: ${scr.raw?.slice(0, 200)}`).to.equal(200);
  });

  // ── Clipboard ────────────────────────────────────────────────────────────────────────────────
  it('windows: setClipboard / getClipboard plaintext roundtrip', async () => {
    const payload = b64('clip-plain-' + Date.now());
    const set = await w3c.execute(sid, 'windows: setClipboard', [{ b64: payload, contentType: 'plaintext' }]);
    expect(set.status, `setClipboard: ${set.raw?.slice(0, 200)}`).to.equal(200);
    const get = await w3c.execute(sid, 'windows: getClipboard', [{ contentType: 'plaintext' }]);
    expect(get.status).to.equal(200);
    expect(get.value).to.equal(payload);
    expect(unb64(get.value as string)).to.match(/^clip-plain-/);
  });

  it('windows: setClipboard / getClipboard image roundtrip returns a valid PNG', async () => {
    const set = await w3c.execute(sid, 'windows: setClipboard', [{ b64: TEST_PNG_B64, contentType: 'image' }]);
    expect(set.status, `setClipboard image: ${set.raw?.slice(0, 200)}`).to.equal(200);
    const get = await w3c.execute(sid, 'windows: getClipboard', [{ contentType: 'image' }]);
    expect(get.status).to.equal(200);
    const back = get.value as string;
    expect(back, 'image b64').to.be.a('string').and.have.length.greaterThan(0);
    const head = Buffer.from(back, 'base64').subarray(0, 4);
    expect([head[0], head[1], head[2], head[3]]).to.deep.equal([0x89, 0x50, 0x4e, 0x47]);
  });

  // ── Chord modifiers in Element Send Keys (ADR-020) ───────────────────────────────────────────────
  // '' = the W3C CONTROL code point. A modifier is HELD over the NEXT key (chord), then released.
  // Regression guard for "only the bare key appears" (Ctrl tapped, not held) — Ctrl+V used to type just 'v'.
  it('send_keys CONTROL+V pastes the clipboard (chord modifier held over v)', async () => {
    const payload = 'chord-paste-' + Date.now();
    const set = await w3c.execute(sid, 'windows: setClipboard', [{ b64: b64(payload), contentType: 'plaintext' }]);
    expect(set.status, `setClipboard: ${set.raw?.slice(0, 200)}`).to.equal(200);
    const sv = await w3c.setValue(sid, edId, 'v');      // Ctrl held over 'v' → paste into the empty editor
    expect(sv.status, `paste: ${sv.raw?.slice(0, 200)}`).to.equal(200);
    const txt = await w3c.getText(sid, edId);
    expect(txt.status).to.equal(200);
    expect(txt.value, 'pasted clipboard text (NOT a bare "v")').to.equal(payload);
  });

  it('send_keys CONTROL+A then literal replaces content (chord ends after the one key)', async () => {
    const r0 = await w3c.setValue(sid, edId, 'OLD');          // existing content
    expect(r0.status).to.equal(200);
    const sv = await w3c.setValue(sid, edId, 'aNEW');    // Ctrl+A (select all), release, type NEW → replace
    expect(sv.status, `ctrl+a then type: ${sv.raw?.slice(0, 200)}`).to.equal(200);
    const txt = await w3c.getText(sid, edId);
    expect(txt.value, 'Ctrl+A selected OLD, NEW replaced it').to.equal('NEW');
  });

  // ── App lifecycle ───────────────────────────────────────────────────────────────────────────────
  it('windows: setProcessForeground brings the process foreground (or clean error)', async () => {
    const res = await w3c.execute(sid, 'windows: setProcessForeground', [{ process: 'notepad' }]);
    expect([200, 400, 404, 500]).to.include(res.status);
    if (res.status !== 200) expect(res.error, 'clean error').to.be.a('string');
    expect(await sessionAlive(), 'session alive').to.equal(true);
  });

  it('windows: launchApp / closeApp re-roots the session (session survives)', async () => {
    // Use a dedicated session so a relaunch does not disturb the shared editor.
    const s = await pool.open();
    const launch = await w3c.execute(s, 'windows: launchApp', [{}]);
    expect([200, 400, 500], `launchApp ${launch.status}`).to.include(launch.status);
    const title = await w3c.getTitle(s);
    expect(title.status, 'session alive after launchApp').to.equal(200);
    const close = await w3c.execute(s, 'windows: closeApp', [{}]);
    expect([200, 400, 500], `closeApp ${close.status}`).to.include(close.status);
  });

  // ── Advisory no-ops ──────────────────────────────────────────────────────────────────────────────
  it('windows: typeDelay is accepted', async () => {
    const res = await w3c.execute(sid, 'windows: typeDelay', [{ delay: 5 }]);
    expect(res.status, `typeDelay: ${res.raw?.slice(0, 200)}`).to.equal(200);
  });

  it('windows: cacheRequest is accepted', async () => {
    const res = await w3c.execute(sid, 'windows: cacheRequest', [{}]);
    expect(res.status, `cacheRequest: ${res.raw?.slice(0, 200)}`).to.equal(200);
  });
});
