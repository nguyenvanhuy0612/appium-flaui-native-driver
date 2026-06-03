// §15 Actions — pointer click (focus proof), key typing (value proof), pause, releaseActions.
import { expect } from 'chai';
import { w3c, SessionPool, findEditable, bringToFront, W3C_ELEMENT_KEY } from '../lib/helpers.js';

describe('§15 Actions', function () {
  this.timeout(120_000);
  const pool = new SessionPool();
  let sid: string;
  let edId: string;
  before(async () => { sid = await pool.open(); edId = await findEditable(sid); });
  beforeEach(async () => { await w3c.clear(sid, edId); });
  after(async () => { await pool.cleanup(); });

  it('§15.7 Perform Actions: pointer move+down+up over the editor focuses it', async () => {
    await bringToFront(sid);
    const res = await w3c.performActions(sid, [
      {
        type: 'pointer', id: 'mouse1', parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', origin: { [W3C_ELEMENT_KEY]: edId }, x: 0, y: 0 },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 30 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
    expect(res.status, `actions: ${res.raw?.slice(0, 200)}`).to.equal(200);
    const focus = await w3c.getAttribute(sid, edId, 'HasKeyboardFocus');
    expect(String(focus.value).toLowerCase()).to.equal('true');
  });

  it('§15.7 Perform Actions: key down/up types into the focused editor', async () => {
    await bringToFront(sid);
    // Focus via pointer first, then type "xyz" via key actions.
    await w3c.performActions(sid, [
      {
        type: 'pointer', id: 'mouse1', parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', origin: { [W3C_ELEMENT_KEY]: edId }, x: 0, y: 0 },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      },
      {
        type: 'key', id: 'kb1', actions: [
          { type: 'keyDown', value: 'x' }, { type: 'keyUp', value: 'x' },
          { type: 'keyDown', value: 'y' }, { type: 'keyUp', value: 'y' },
          { type: 'keyDown', value: 'z' }, { type: 'keyUp', value: 'z' },
        ],
      },
    ]);
    const v = await w3c.getAttribute(sid, edId, 'Value');
    expect(v.value, 'typed value').to.equal('xyz');
  });

  it('§15.7 Perform Actions: a pure pause sequence is accepted', async () => {
    const res = await w3c.performActions(sid, [
      { type: 'none', id: 'none1', actions: [{ type: 'pause', duration: 50 }] },
    ]);
    expect(res.status).to.equal(200);
  });

  it('§15.8 Release Actions returns 200', async () => {
    const res = await w3c.releaseActions(sid);
    expect(res.status, `release: ${res.raw?.slice(0, 200)}`).to.equal(200);
  });
});
