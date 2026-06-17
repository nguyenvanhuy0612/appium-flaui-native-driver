// §13/§14 Element State & Interaction — click/focus, setValue/clear/getText, attributes, properties,
// name=tag, rect sanity, enabled/displayed/selected.
import { expect } from 'chai';
import { w3c, SessionPool, findEditable, bringToFront, requireAppium } from '../lib/helpers.js';

describe('§13/§14 Element State & Interaction', function () {
  this.timeout(120_000);
  before(requireAppium);
  const pool = new SessionPool();
  let sid: string;
  let edId: string;
  before(async () => { sid = await pool.open(); edId = await findEditable(sid); });
  beforeEach(async () => { await w3c.clear(sid, edId); });
  after(async () => { await pool.cleanup(); });

  it('§14.1 Element Click focuses the control (real pointer click)', async () => {
    await bringToFront(sid); // ensure our window is foreground so the real click lands on it
    const res = await w3c.click(sid, edId);
    expect(res.status, 'click').to.equal(200);
    const focus = await w3c.getAttribute(sid, edId, 'HasKeyboardFocus');
    expect(focus.status).to.equal(200);
    // sidecar reports UIA bools as the strings "true"/"false".
    expect(String(focus.value).toLowerCase()).to.equal('true');
  });

  it('§14.2 Element Send Keys (setValue) sets the Value', async () => {
    const sv = await w3c.setValue(sid, edId, 'value-set-123');
    expect(sv.status).to.equal(200);
    const v = await w3c.getAttribute(sid, edId, 'Value');
    expect(v.value).to.equal('value-set-123');
  });

  it('§14.3 Element Clear empties the Value', async () => {
    await w3c.setValue(sid, edId, 'to-be-cleared');
    const cl = await w3c.clear(sid, edId);
    expect(cl.status).to.equal(200);
    const v = await w3c.getAttribute(sid, edId, 'Value');
    expect(v.value).to.equal('');
  });

  it('§13.5 Get Element Text reflects the typed value', async () => {
    await w3c.setValue(sid, edId, 'text-roundtrip');
    const t = await w3c.getText(sid, edId);
    expect(t.status).to.equal(200);
    expect(t.value).to.equal('text-roundtrip');
  });

  it('§13.4 Get Element Attribute — Value/ClassName/BoundingRectangle/HasKeyboardFocus', async () => {
    await w3c.setValue(sid, edId, 'attr-check');
    const value = await w3c.getAttribute(sid, edId, 'Value');
    expect(value.value).to.equal('attr-check');

    const cn = await w3c.getAttribute(sid, edId, 'ClassName');
    expect(cn.status).to.equal(200);
    expect(cn.value, 'ClassName').to.be.a('string').and.have.length.greaterThan(0);

    const br = await w3c.getAttribute(sid, edId, 'BoundingRectangle');
    expect(br.status).to.equal(200);
    expect(br.value, 'BoundingRectangle').to.satisfy((v: unknown) => v !== null && v !== undefined);

    const hkf = await w3c.getAttribute(sid, edId, 'HasKeyboardFocus');
    expect(hkf.status).to.equal(200);
    expect(['true', 'false']).to.include(String(hkf.value).toLowerCase());
  });

  it('§13.6 Get Element Property returns a value for a known property', async () => {
    const p = await w3c.getProperty(sid, edId, 'ClassName');
    expect(p.status).to.equal(200);
    expect(p.value, 'property value').to.satisfy((v: unknown) => v !== undefined);
  });

  it('§13.2 Get Element Tag Name returns the ControlType', async () => {
    const n = await w3c.getName(sid, edId);
    expect(n.status).to.equal(200);
    expect(n.value, 'tag name').to.be.a('string').and.have.length.greaterThan(0);
    // Editable surface is a Document or Edit control type.
    expect(['Document', 'Edit', 'Pane']).to.include(n.value as string);
  });

  it('§13.7 Get Element Rect returns a sane rectangle', async () => {
    const r = await w3c.getRect(sid, edId);
    expect(r.status).to.equal(200);
    expect(r.value.width, 'width').to.be.greaterThan(0);
    expect(r.value.height, 'height').to.be.greaterThan(0);
    expect(r.value.x, 'x').to.be.a('number');
    expect(r.value.y, 'y').to.be.a('number');
  });

  it('§13.1/§13.3 enabled / displayed / selected booleans', async () => {
    const en = await w3c.isEnabled(sid, edId);
    const dis = await w3c.isDisplayed(sid, edId);
    const sel = await w3c.isSelected(sid, edId);
    expect(en.status).to.equal(200);
    expect(en.value, 'enabled').to.equal(true);
    expect(dis.status).to.equal(200);
    expect(dis.value, 'displayed').to.equal(true);
    expect(sel.status).to.equal(200);
    expect(sel.value, 'selected (editor is not selectable)').to.equal(false);
  });
});
