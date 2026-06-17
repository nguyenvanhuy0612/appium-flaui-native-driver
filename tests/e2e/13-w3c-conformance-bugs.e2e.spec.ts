// §W3C CONFORMANCE — bug-demonstration suite.
//
// Each test asserts the CORRECT W3C WebDriver behaviour for a Core command that static review found to
// deviate (see docs/reference/w3c-conformance-and-test-gaps.md). These bugs were CONFIRMED on a real
// Windows host (8 failing) and then FIXED in 0.1.0-beta.24 — all 9 now pass. They stand as REGRESSION
// GUARDS: a failure here means a Core W3C conformance regression, not a new bug to triage.
//
// Run on the deployed Windows host:  APPIUM_URL=http://<host>:4723 npm run test:e2e
// Off-Windows / no server they skip cleanly via requireAppium.
import { expect } from 'chai';
import { w3c, SessionPool, requireAppium, findEditable, findWindow } from '../lib/helpers.js';

// W3C key codepoints (Unicode PUA) — https://www.w3.org/TR/webdriver2/#keyboard-actions
const KEY = {
  BACKSPACE: '\uE003',
  TAB: '\uE004',
  RETURN: '\uE006',
  ENTER: '\uE007',
  DELETE: '\uE017',
};

describe('§W3C conformance (bug demonstrations — RED until fixed)', function () {
  before(requireAppium);
  this.timeout(120_000);
  const pool = new SessionPool();
  afterEach(async () => { await pool.cleanup(); });

  // ── BUG #1 — Element Send Keys must translate W3C key codepoints (Enter/Backspace/...) ──────────
  // lib/driver.ts:567 setValue → OpInterpreter.SetValue → TypeText → Keyboard.Type(raw). The
  // W3C_KEY_TO_VK table is only wired into performActions, so  etc. are typed as literal glyphs.
  // W3C §12.5.3 "Element Send Keys" requires control codepoints to be emulated as key presses.
  describe('BUG #1: Element Send Keys key codepoints', function () {
    it('ENTER (\\uE007) inserts a newline, not a literal glyph', async function () {
      const sid = await pool.open();
      const edit = await findEditable(sid);
      await w3c.clear(sid, edit);
      const r = await w3c.setValue(sid, edit, `a${KEY.ENTER}b`);
      expect(r.status, 'send_keys status').to.equal(200);
      const text = (await w3c.getText(sid, edit)).value as string;
      // Correct: "a", newline, "b". Buggy: "ab" or "a<glyph>b" with no line break.
      expect(text, 'editor text after a+ENTER+b').to.match(/a[\r\n]+b/);
    });

    it('BACKSPACE (\\uE003) deletes the previous character', async function () {
      const sid = await pool.open();
      const edit = await findEditable(sid);
      await w3c.clear(sid, edit);
      await w3c.setValue(sid, edit, 'abc');
      await w3c.setValue(sid, edit, KEY.BACKSPACE); // send_keys appends → backspace edits existing content
      const text = (await w3c.getText(sid, edit)).value as string;
      expect(text, 'text after "abc" then BACKSPACE').to.equal('ab');
    });
  });

  // ── BUG #2 — New Session capability failure must be `session not created`, not `unknown error` ──
  // lib/driver.ts:181 throws a plain Error when no launch/attach target cap is given; base-driver maps
  // a bare Error to UnknownError (HTTP 500). W3C §8.2 requires a capabilities failure to surface as
  // `session not created`.
  describe('BUG #2: New Session error class for missing target capability', function () {
    it('no app/appTopLevelWindow/appName/processName → "session not created"', async function () {
      // platformName + automationName are valid (Appium negotiation passes); the DRIVER rejects for
      // lack of a target. No session is created, so nothing to clean up.
      const r = await w3c.newSession({});
      expect(r.status, 'must be a client/negotiation error').to.be.greaterThanOrEqual(400);
      expect(r.error, 'W3C error code').to.equal('session not created');
    });
  });

  // ── BUG #3 — Get Element Property must return the typed value, not a stringified one ────────────
  // lib/driver.ts:598 getProperty delegates wholesale to getAttribute (Promise<string|null>), so every
  // property comes back coerced to a string. W3C §12.4.3 returns the JSON-serialized actual value:
  // a boolean property → true/false, a numeric property → a number.
  describe('BUG #3: Get Element Property value typing', function () {
    it('a boolean property is returned as a JSON boolean, not the string "true"', async function () {
      const sid = await pool.open();
      const edit = await findEditable(sid);
      const r = await w3c.getProperty(sid, edit, 'IsEnabled');
      expect(r.status).to.equal(200);
      expect(typeof r.value, `IsEnabled property type (got ${JSON.stringify(r.value)})`).to.equal('boolean');
    });

    it('a numeric property is returned as a JSON number, not a numeric string', async function () {
      const sid = await pool.open();
      const edit = await findEditable(sid);
      const r = await w3c.getProperty(sid, edit, 'ProcessId');
      expect(r.status).to.equal(200);
      expect(typeof r.value, `ProcessId property type (got ${JSON.stringify(r.value)})`).to.equal('number');
    });
  });

  // ── BUG #5 — Element Clear on a non-editable element must error `invalid element state` ─────────
  // OpInterpreter.SetValue replace-path falls back to Ctrl+A/Delete/type for any element without a
  // writable ValuePattern and returns success. W3C §12.5.2 requires: not editable → `invalid element state`.
  describe('BUG #5: Element Clear editability check', function () {
    it('clear() on a non-editable element does not silently succeed', async function () {
      const sid = await pool.open();
      const win = await findWindow(sid); // a Window element: no writable ValuePattern, not editable
      const r = await w3c.clear(sid, win);
      expect(r.status, 'clear on non-editable must not be 200').to.not.equal(200);
      expect(r.error, 'W3C error code').to.equal('invalid element state');
    });
  });

  // ── BUG #6 — Find From Element must validate the context element even for an absolute XPath ─────
  // lib/xpath/core.ts:1380-1383 resolves absolute paths (`//...`) from the automation root and never
  // touches the context id, so a stale/invalid context with an absolute selector silently searches the
  // whole tree. W3C §12.3.4 requires resolving the known element first (→ stale/no such element).
  describe('BUG #6: Find From Element validates an absolute-XPath context', function () {
    it('invalid context id + absolute xpath → an element error, not a root search', async function () {
      const sid = await pool.open();
      const r = await w3c.findElementFromElement(sid, 'not-a-real-element-id', 'xpath', '//Window');
      expect(r.status, 'must reject the bad context').to.be.greaterThanOrEqual(400);
      expect(r.error).to.be.oneOf(['no such element', 'stale element reference', 'invalid argument']);
    });
  });

  // ── BUG #8 — `tag name` with an unknown control type must be a non-match, not `invalid argument` ──
  // OpLogic.ParseEnum<ControlType> throws InvalidArgumentException for an unrecognised name, surfacing
  // a 4xx. For Find Elements, a syntactically valid selector that matches nothing must return 200 [].
  describe('BUG #8: tag name with an unknown control type', function () {
    it('findElements("tag name", <unknown>) returns 200 with an empty array', async function () {
      const sid = await pool.open();
      const r = await w3c.findElements(sid, 'tag name', 'NotARealControlType');
      expect(r.status, `status (got error=${r.error})`).to.equal(200);
      expect(r.value, 'result').to.be.an('array').that.is.empty;
    });
  });

  // ── BUG #4 (DEBATABLE) — `includeContextElementInSearch` corrupts the XPath descendant:: axis ────
  // lib/driver.ts:435 promotes EVERY descendants-scoped find to subtree (includes self), so an explicit
  // `descendant::` step matches the context node. XPath 1.0 says descendant:: never includes self.
  // NOTE: this may be considered intended Appium "include context" behaviour — a failure here is a
  // design decision to confirm, not necessarily a defect.
  describe('BUG #4: XPath descendant:: axis excludes self', function () {
    it('descendant::Edit from an Edit does not return that same Edit', async function () {
      const sid = await pool.open();
      const edit = await findEditable(sid);
      const r = await w3c.findElementsFromElement(sid, edit, 'xpath', 'descendant::Edit');
      expect(r.status).to.equal(200);
      const ids = (r.value as Array<Record<string, string>>).map((e) => w3c.elementId(e));
      expect(ids, 'descendant axis must not include the context element').to.not.include(edit);
    });
  });
});
