// §11 Contexts (Window) — title, handle(s), rect get/set roundtrip, maximize/minimize.
import { expect } from 'chai';
import { w3c, SessionPool, requireAppium } from '../lib/helpers.js';

describe('§11 Window commands', function () {
  this.timeout(120_000);
  before(requireAppium);
  const pool = new SessionPool();
  let sid: string;
  before(async () => { sid = await pool.open(); });
  after(async () => { await pool.cleanup(); });

  it('§11.1 Get Title returns a non-empty string', async () => {
    const t = await w3c.getTitle(sid);
    expect(t.status).to.equal(200);
    expect(t.value, 'title').to.be.a('string').and.have.length.greaterThan(0);
  });

  it('§11.2 Get Window Handle returns a handle', async () => {
    const h = await w3c.getWindowHandle(sid);
    expect(h.status).to.equal(200);
    expect(h.value, 'handle').to.be.a('string').and.have.length.greaterThan(0);
  });

  it('§11.5 Get Window Handles returns an array including the current handle', async () => {
    const cur = await w3c.getWindowHandle(sid);
    const hs = await w3c.getWindowHandles(sid);
    expect(hs.status).to.equal(200);
    expect(hs.value, 'handles').to.be.an('array').with.length.greaterThan(0);
    expect(hs.value).to.include(cur.value);
  });

  it('§11.7 Get Window Rect returns a sane rectangle', async () => {
    const r = await w3c.getWindowRect(sid);
    expect(r.status).to.equal(200);
    expect(r.value.width).to.be.greaterThan(0);
    expect(r.value.height).to.be.greaterThan(0);
  });

  it('§11.8 Set Window Rect — move + resize roundtrip', async () => {
    // Ensure a normal (non-maximized) state by setting a known rect first.
    const target = { x: 120, y: 90, width: 760, height: 560 };
    const set = await w3c.setWindowRect(sid, target);
    expect(set.status, `setRect: ${set.raw?.slice(0, 200)}`).to.equal(200);
    const got = await w3c.getWindowRect(sid);
    // Allow small WM-imposed deltas (snap/min-size); assert we moved/resized toward the target.
    const near = (a: number, b: number, tol = 60) => Math.abs(a - b) <= tol;
    expect(near(got.value.x, target.x), `x ${got.value.x}~${target.x}`).to.equal(true);
    expect(near(got.value.y, target.y), `y ${got.value.y}~${target.y}`).to.equal(true);
    expect(near(got.value.width, target.width), `w ${got.value.width}~${target.width}`).to.equal(true);
    expect(near(got.value.height, target.height), `h ${got.value.height}~${target.height}`).to.equal(true);
  });

  it('§11.9 Maximize Window enlarges the window', async () => {
    await w3c.setWindowRect(sid, { x: 100, y: 100, width: 500, height: 400 });
    const before = await w3c.getWindowRect(sid);
    const max = await w3c.maximizeWindow(sid);
    expect(max.status, `maximize: ${max.raw?.slice(0, 200)}`).to.equal(200);
    const after = await w3c.getWindowRect(sid);
    expect(after.value.width * after.value.height,
      'maximized area should be >= pre-maximize area').to.be.greaterThanOrEqual(before.value.width * before.value.height);
  });

  it('§11.10 Minimize Window returns 200', async () => {
    const min = await w3c.minimizeWindow(sid);
    expect(min.status, `minimize: ${min.raw?.slice(0, 200)}`).to.equal(200);
    // Restore to a normal rect so later tests in other files are unaffected (separate session anyway).
    await w3c.setWindowRect(sid, { x: 100, y: 100, width: 700, height: 500 });
  });
});
