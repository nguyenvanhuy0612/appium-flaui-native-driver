// §17/§19 Document Source & Screenshots — well-formed nested XML containing the found element's RuntimeId,
// element-scoped source via `windows: getPageSource`, valid PNG screenshots (root + element).
import { expect } from 'chai';
import { w3c, SessionPool, findEditable, findWindow, assertPng, parseXml, W3C_ELEMENT_KEY, requireAppium } from '../lib/helpers.js';

describe('§17/§19 Source & Screenshots', function () {
  this.timeout(120_000);
  before(requireAppium);
  const pool = new SessionPool();
  let sid: string;
  before(async () => { sid = await pool.open(); });
  after(async () => { await pool.cleanup(); });

  it('§17.1 Get Page Source is well-formed, nested XML', async () => {
    const src = await w3c.getPageSource(sid);
    expect(src.status).to.equal(200);
    const xml = parseXml(src.value);
    expect(xml.tagCount, 'tag count').to.be.greaterThan(1);
    expect(xml.depthOk, 'nested').to.equal(true);
    // Full UIA schema markers (per docs §4 page source contract).
    expect(xml.text).to.include('LocalizedControlType="');
    expect(xml.text).to.include(' width="');
  });

  it('§17.1 source contains the found element\'s RuntimeId', async () => {
    const winId = await findWindow(sid);
    const src = await w3c.getPageSource(sid);
    // The window element id is its RuntimeId; it must appear as a RuntimeId attribute in the tree.
    expect(src.value as string).to.include(`RuntimeId="${winId}"`);
  });

  it('windows: getPageSource returns element-scoped source', async () => {
    const winId = await findWindow(sid);
    const scoped = await w3c.execute(sid, 'windows: getPageSource', [{ elementId: winId }]);
    expect(scoped.status, `scoped source: ${scoped.raw?.slice(0, 200)}`).to.equal(200);
    const xml = parseXml(scoped.value);
    expect(xml.text.length, 'scoped source length').to.be.greaterThan(0);
    // Scoped source should be no larger than (and typically subset of) the full source.
    const full = await w3c.getPageSource(sid);
    expect((scoped.value as string).length).to.be.lessThanOrEqual((full.value as string).length + 1);
  });

  it('§19.1 Take Screenshot returns a valid PNG', async () => {
    const shot = await w3c.screenshot(sid);
    expect(shot.status).to.equal(200);
    assertPng(shot.value, 'root screenshot');
  });

  it('§19.2 Take Element Screenshot — valid PNG smaller than the root shot', async () => {
    const edId = await findEditable(sid);
    const root = await w3c.screenshot(sid);
    const el = await w3c.elementScreenshot(sid, edId);
    expect(el.status).to.equal(200);
    const rootBuf = assertPng(root.value, 'root screenshot');
    const elBuf = assertPng(el.value, 'element screenshot');
    expect(elBuf.length, 'element shot should be smaller than root shot').to.be.lessThan(rootBuf.length);
  });
});
