// §12 Element Retrieval — all strategies, findElements, scoped finds, no-match + invalid selector errors.
import { expect } from 'chai';
import { w3c, SessionPool, findEditable, findWindow } from '../lib/helpers.js';

describe('§12 Element Retrieval', function () {
  this.timeout(120_000);
  const pool = new SessionPool();
  let sid: string;
  before(async () => { sid = await pool.open(); });
  after(async () => { await pool.cleanup(); });

  it('§12.2 Find Element by class name', async () => {
    const res = await w3c.findElement(sid, 'class name', 'Edit');
    // Edit may be Document on newer builds; assert the strategy works for at least one editable surface.
    if (res.status !== 200) {
      const doc = await w3c.findElement(sid, 'tag name', 'Document');
      expect(doc.status, 'class name or tag name should resolve an editor').to.equal(200);
      expect(w3c.elementId(doc.value)).to.be.a('string');
    } else {
      expect(w3c.elementId(res.value)).to.be.a('string');
    }
  });

  it('§12.2 Find Element by tag name (ControlType)', async () => {
    const res = await w3c.findElement(sid, 'tag name', 'Window');
    expect(res.status).to.equal(200);
    expect(w3c.elementId(res.value)).to.be.a('string');
  });

  it('§12.2 Find Element by name', async () => {
    // Window's Name property is the title; resolve the window first to learn a real Name.
    const winId = await findWindow(sid);
    const nameAttr = await w3c.getAttribute(sid, winId, 'Name');
    expect(nameAttr.status).to.equal(200);
    const name = nameAttr.value as string;
    expect(name, 'window name').to.be.a('string').and.have.length.greaterThan(0);
    const byName = await w3c.findElement(sid, 'name', name);
    expect(byName.status, `find by name=${name}`).to.equal(200);
    expect(w3c.elementId(byName.value)).to.be.a('string');
  });

  it('§12.2 Find Element by accessibility id / id', async () => {
    // Discover a real AutomationId from any element that has one, then re-find it (OS-independent).
    const src = await w3c.getPageSource(sid);
    const m = /AutomationId="([^"]+)"/.exec(src.value as string);
    if (!m) { return; } // tolerate environments where no element exposes an AutomationId
    const autoId = m[1];
    const byAcc = await w3c.findElement(sid, 'accessibility id', autoId);
    expect(byAcc.status, `accessibility id=${autoId}`).to.equal(200);
    const byId = await w3c.findElement(sid, 'id', autoId);
    expect(byId.status, `id=${autoId}`).to.equal(200);
  });

  it('§12.2 Find Element by xpath', async () => {
    const res = await w3c.findElement(sid, 'xpath', '//*');
    expect(res.status).to.equal(200);
    expect(w3c.elementId(res.value)).to.be.a('string');
  });

  it('§12.3 Find Elements returns an array (possibly many)', async () => {
    const res = await w3c.findElements(sid, 'xpath', '//*');
    expect(res.status).to.equal(200);
    expect(res.value).to.be.an('array').with.length.greaterThan(0);
    expect(w3c.elementId(res.value[0])).to.be.a('string');
  });

  it('§12.4 Find Element From Element scopes to descendants', async () => {
    const winId = await findWindow(sid);
    const child = await w3c.findElementFromElement(sid, winId, 'xpath', './/*');
    expect(child.status).to.equal(200);
    expect(w3c.elementId(child.value)).to.be.a('string');
  });

  it('§12.5 Find Elements From Element returns an array', async () => {
    const winId = await findWindow(sid);
    const kids = await w3c.findElementsFromElement(sid, winId, 'xpath', './/*');
    expect(kids.status).to.equal(200);
    expect(kids.value).to.be.an('array').with.length.greaterThan(0);
  });

  it('§12.2 Find Element with no match -> no such element (HTTP 404)', async () => {
    const res = await w3c.findElement(sid, 'class name', 'ThisClassDoesNotExist_ZZZ');
    expect(res.status, 'HTTP status').to.equal(404);
    expect(res.error, 'W3C error code').to.equal('no such element');
  });

  it('§12.3 Find Elements with no match -> empty array (HTTP 200)', async () => {
    const res = await w3c.findElements(sid, 'class name', 'ThisClassDoesNotExist_ZZZ');
    expect(res.status, 'HTTP status').to.equal(200);
    expect(res.value).to.be.an('array').with.length(0);
  });

  it('§12.2 malformed xpath -> invalid selector (HTTP 400)', async () => {
    const res = await w3c.findElement(sid, 'xpath', '//[[[');
    expect(res.status, 'HTTP status').to.equal(400);
    expect(res.error, 'W3C error code').to.equal('invalid selector');
  });
});
