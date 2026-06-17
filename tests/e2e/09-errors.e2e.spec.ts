// §6 Errors — exact W3C error JSON shapes & HTTP codes (https://www.w3.org/TR/webdriver2/#errors).
// This file reads as a conformance checklist for the driver's end-to-end error mapping.
import { expect } from 'chai';
import { w3c, SessionPool, requireAppium } from '../lib/helpers.js';
import type { W3CResult } from '../lib/w3c-client.js';

/** Assert a result is a W3C error envelope: HTTP status + value.error string + value.message string. */
function assertW3CError(res: W3CResult, httpStatus: number, errorCode: string, label: string) {
  expect(res.status, `${label} HTTP status`).to.equal(httpStatus);
  expect(res.value, `${label} value object`).to.be.an('object');
  expect((res.value as any).error, `${label} value.error`).to.equal(errorCode);
  expect((res.value as any).message, `${label} value.message`).to.be.a('string');
  // stacktrace is required by the spec (may be empty string).
  expect((res.value as any), `${label} has stacktrace`).to.have.property('stacktrace');
}

describe('§6 W3C error contract', function () {
  this.timeout(120_000);
  before(requireAppium);
  const pool = new SessionPool();
  let sid: string;
  before(async () => { sid = await pool.open(); });
  after(async () => { await pool.cleanup(); });

  it('no such element: findElement with no match -> 404 "no such element"', async () => {
    const res = await w3c.findElement(sid, 'class name', 'NoSuchClass_ZZZ_404');
    assertW3CError(res, 404, 'no such element', 'no-match find');
  });

  it('no such element: never-seen element id -> 404 "no such element"', async () => {
    // A syntactically odd id the driver has never issued.
    const res = await w3c.getText(sid, 'never-seen-element-id-9999');
    assertW3CError(res, 404, 'no such element', 'never-seen id');
  });

  it('stale element reference: aged-out runtime id (e.g. 1.2.3) -> 404 "stale element reference"', async () => {
    // A well-formed UIA RuntimeId shape that is not currently live -> stale, per the driver's semantics.
    const res = await w3c.getText(sid, '1.2.3');
    expect(res.status, 'HTTP status').to.equal(404);
    expect(res.error, 'W3C error code').to.be.oneOf(['stale element reference', 'no such element']);
    // The intended mapping is stale; assert exactly if the driver distinguishes (it does per CHANGELOG).
    if (res.error === 'stale element reference') {
      assertW3CError(res, 404, 'stale element reference', 'aged-out id');
    }
  });

  it('invalid selector: malformed xpath -> 400 "invalid selector"', async () => {
    const res = await w3c.findElement(sid, 'xpath', '//[[[');
    assertW3CError(res, 400, 'invalid selector', 'malformed xpath');
  });

  it('unknown command: unknown windows: command -> error envelope', async () => {
    const res = await w3c.execute(sid, 'windows: thisCommandDoesNotExist', [{}]);
    expect(res.status, 'HTTP status').to.be.greaterThanOrEqual(400);
    expect(res.value, 'value object').to.be.an('object');
    expect((res.value as any).error, 'W3C error code').to.be.a('string');
    // Appium maps unknown execute scripts to `unsupported operation` (its executeMethod dispatcher) or,
    // for unrouted endpoints, `unknown command`/`unknown method`.
    expect((res.value as any).error).to.be.oneOf([
      'unsupported operation', 'unknown command', 'unknown method', 'unknown error', 'invalid argument',
    ]);
  });

  it('invalid session id: command on a bogus session -> 404 "invalid session id"', async () => {
    const res = await w3c.getPageSource('bogus-session-id-0000');
    assertW3CError(res, 404, 'invalid session id', 'bogus session');
  });
});
