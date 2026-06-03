// FlaUINative smoke suite — a single, fast (~<30s) end-to-end pass over the critical path:
//   status -> newSession -> find -> source -> screenshot -> setValue/getText roundtrip -> deleteSession
// W3C-first: raw protocol client, generic OS-independent selectors, self-cleaning.
import { expect } from 'chai';
import { w3c, SessionPool, findEditable, assertPng, parseXml } from '../lib/helpers.js';

describe('FlaUINative — smoke (critical path)', function () {
  this.timeout(60_000);
  const pool = new SessionPool();
  afterEach(async () => { await pool.cleanup(); });

  it('walks status -> session -> find -> source -> screenshot -> value roundtrip -> delete', async () => {
    // GET /status — server is ready.
    const st = await w3c.status();
    expect(st.status, 'GET /status').to.equal(200);
    expect(st.value, 'status value').to.be.an('object');
    expect(st.value.ready, 'status.ready').to.not.equal(false);

    // POST /session
    const sessionId = await pool.open();
    expect(sessionId, 'sessionId').to.be.a('string').and.have.length.greaterThan(0);

    // POST /element — find the editable control generically.
    const edId = await findEditable(sessionId);
    expect(edId, 'editable element id').to.be.a('string').and.have.length.greaterThan(0);

    // GET /source — well-formed, nested XML.
    const src = await w3c.getPageSource(sessionId);
    expect(src.status, 'GET /source').to.equal(200);
    const xml = parseXml(src.value);
    expect(xml.depthOk, 'source should be nested').to.equal(true);

    // GET /screenshot — valid PNG base64.
    const shot = await w3c.screenshot(sessionId);
    expect(shot.status, 'GET /screenshot').to.equal(200);
    assertPng(shot.value, 'root screenshot');

    // setValue -> getText roundtrip.
    const payload = 'smoke-roundtrip';
    const sv = await w3c.setValue(sessionId, edId, payload);
    expect(sv.status, 'setValue').to.equal(200);
    const txt = await w3c.getText(sessionId, edId);
    expect(txt.status, 'getText').to.equal(200);
    expect(txt.value, 'getText value').to.equal(payload);

    // DELETE /session
    const del = await w3c.deleteSession(sessionId);
    expect(del.status, 'deleteSession').to.equal(200);
    pool.forget(sessionId);
  });
});
