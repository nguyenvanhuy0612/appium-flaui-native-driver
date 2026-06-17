// Unit coverage for the FlaUINativeDriver "translation" logic: locator-strategy → backend condition
// mapping in findElOrEls (incl. the no-match NoSuchElementError guard — the bug fix), the W3C Actions
// → backend input op translation (viewport-origin coord fix, pointer/element origins, button mapping,
// key sequences), and getAttribute serialization.
//
// Same constraint as feature-gate.spec.ts: we cannot `import` the driver under tsx (base-driver ESM
// deep-deps), so a PLAIN-node child process imports the BUILT driver, stubs `this.op` /
// `this.getWindowRect` / `this.getElementRect`, captures the ops it emits, and reports JSON.
import { expect } from 'chai';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const builtDriver = path.join(repoRoot, 'build/lib/driver.js');
const builtDriverUrl = pathToFileURL(builtDriver).href;

const PROBE = `
import { FlaUINativeDriver } from ${JSON.stringify(builtDriverUrl)};

function mk() {
  const d = new FlaUINativeDriver({}, false);
  d.opts.automationName = 'FlaUINative';
  return d;
}
async function cap(fn) {
  try { const value = await fn(); return { threw: false, value }; }
  catch (e) { return { threw: true, name: e && e.constructor && e.constructor.name, msg: String(e && e.message || e) }; }
}

const out = {};

// ── 6. locator-strategy → condition mapping in findElOrEls ────────────────────────────────────
// Stub op() to capture the find op (and return one element so single-find succeeds).
{
  out.strategy = {};
  for (const [strategy, expectedProp] of [
    ['accessibility id', 'AutomationId'],
    ['id', 'AutomationId'],
    ['name', 'Name'],
    ['class name', 'ClassName'],
    ['tag name', 'ControlType'],
  ]) {
    const d = mk();
    let captured;
    d.op = async (op) => { captured = op; return { runtimeId: 'rt-1' }; };
    const res = await cap(() => d.findElOrEls(strategy, 'theValue', false));
    out.strategy[strategy] = {
      threw: res.threw,
      element: res.value,
      op: captured,
    };
  }
  // multiple:true returns the mapped element array.
  {
    const d = mk();
    let captured;
    d.op = async (op) => { captured = op; return { elements: [{ runtimeId: 'a' }, { runtimeId: 'b' }] }; };
    const res = await cap(() => d.findElOrEls('name', 'x', true));
    out.strategyMultiple = { value: res.value, scope: captured.scope };
  }
  // unknown strategy → "unsupported strategy" error.
  {
    const d = mk();
    d.op = async () => ({ runtimeId: 'rt' });
    out.strategyUnknown = await cap(() => d.findElOrEls('css selector', 'x', false));
  }
  // BUG FIX: single (multiple:false) non-xpath find with NO match → NoSuchElementError, not an
  // element wrapping undefined.
  {
    const d = mk();
    d.op = async () => ({}); // no runtimeId
    out.singleNoMatch = await cap(() => d.findElOrEls('name', 'ghost', false));
  }
  // ...and an empty-string runtimeId is also treated as no-match.
  {
    const d = mk();
    d.op = async () => ({ runtimeId: '' });
    out.singleEmptyRuntimeId = await cap(() => d.findElOrEls('accessibility id', 'ghost', false));
  }
}

// ── 6b. convertAbsoluteXPathToRelativeFromElement (from-element xpath rewrite) ────────────────
// With a context element id present and the cap on, a leading // is rewritten to .// so the search
// is scoped to the context subtree. The real XPath engine resolves an absolute // from the tree
// root (find startId='root') but a relative .// from the context (startId=ctx id), so we distinguish
// the two by the startId of the first find op the engine emits.
{
  // Capture the startId of the first find op the xpath engine pushes to the backend.
  function xpathDriver(opts) {
    const d = mk();
    Object.assign(d.opts, opts);
    d.firstFindStartId = undefined;
    d.op = async (op) => {
      if (op.op === 'find' && d.firstFindStartId === undefined) d.firstFindStartId = op.startId;
      return { elements: [] };
    };
    return d;
  }
  out.xpathRewrite = {};
  // (a) cap ON + leading // + context → rewritten to .// → resolves from the context element.
  {
    const d = xpathDriver({ convertAbsoluteXPathToRelativeFromElement: true });
    await cap(() => d.findElOrEls('xpath', '//Button', true, 'ctx-9'));
    out.xpathRewrite.onLeadingSlashes = d.firstFindStartId; // expect 'ctx-9'
  }
  // (b) cap OFF + leading // + context → NOT rewritten → W3C absolute, resolves from root.
  {
    const d = xpathDriver({});
    await cap(() => d.findElOrEls('xpath', '//Button', true, 'ctx-9'));
    out.xpathRewrite.offLeadingSlashes = d.firstFindStartId; // expect 'root'
  }
  // (c) cap ON but selector is already .// → left untouched (still resolves from the context).
  {
    const d = xpathDriver({ convertAbsoluteXPathToRelativeFromElement: true });
    await cap(() => d.findElOrEls('xpath', './/Button', true, 'ctx-9'));
    out.xpathRewrite.onAlreadyRelative = d.firstFindStartId; // expect 'ctx-9'
  }
  // (d) cap ON but a single leading / (absolute, not //) → NOT rewritten → resolves from root.
  {
    const d = xpathDriver({ convertAbsoluteXPathToRelativeFromElement: true });
    await cap(() => d.findElOrEls('xpath', '/Button', true, 'ctx-9'));
    out.xpathRewrite.onSingleSlash = d.firstFindStartId; // expect 'root'
  }
  // (e) cap ON + leading // but NO context element → no rewrite path → resolves from root.
  {
    const d = xpathDriver({ convertAbsoluteXPathToRelativeFromElement: true });
    await cap(() => d.findElOrEls('xpath', '//Button', true));
    out.xpathRewrite.onNoContext = d.firstFindStartId; // expect 'root'
  }
}

// ── 7. performActions translation ─────────────────────────────────────────────────────────────
// Stub op() to record every input op; stub getWindowRect (viewport origin) and getElementRect.
function recordingDriver() {
  const d = mk();
  d.ops = [];
  d.op = async (op) => { d.ops.push(op); return {}; };
  d.getWindowRect = async () => ({ x: 100, y: 50, width: 800, height: 600 });
  d.getElementRect = async () => ({ x: 200, y: 300, width: 40, height: 20 });
  return d;
}
{
  // viewport-origin pointerMove adds the cached window top-left (100,50).
  {
    const d = recordingDriver();
    await d.performActions([
      { type: 'pointer', id: 'm', actions: [
        { type: 'pointerMove', origin: 'viewport', x: 10, y: 20 },
      ] },
    ]);
    out.moveViewport = d.ops;
  }
  // default origin (omitted) == viewport.
  {
    const d = recordingDriver();
    await d.performActions([
      { type: 'pointer', id: 'm', actions: [{ type: 'pointerMove', x: 5, y: 6 }] },
    ]);
    out.moveDefaultOrigin = d.ops;
  }
  // pointer origin: relative to the previous pointer position.
  {
    const d = recordingDriver();
    await d.performActions([
      { type: 'pointer', id: 'm', actions: [
        { type: 'pointerMove', origin: 'viewport', x: 10, y: 20 }, // → (110,70)
        { type: 'pointerMove', origin: 'pointer', x: 3, y: 4 },    // → (113,74)
      ] },
    ]);
    out.movePointer = d.ops;
  }
  // element origin: offset from element CENTER (200+40/2=220, 300+20/2=310).
  {
    const d = recordingDriver();
    const ELEM_KEY = 'element-6066-11e4-a52e-4f735466cecf';
    await d.performActions([
      { type: 'pointer', id: 'm', actions: [
        { type: 'pointerMove', origin: { [ELEM_KEY]: 'el-1' }, x: 1, y: 2 }, // → (221,312)
      ] },
    ]);
    out.moveElement = d.ops;
  }
  // pointerDown / pointerUp button mapping: 2 → right, else left.
  {
    const d = recordingDriver();
    await d.performActions([
      { type: 'pointer', id: 'm', actions: [
        { type: 'pointerDown', button: 0 },
        { type: 'pointerUp', button: 0 },
        { type: 'pointerDown', button: 2 },
        { type: 'pointerUp', button: 2 },
      ] },
    ]);
    out.buttons = d.ops;
  }
  // key sequence: special key → {virtualKeyCode, down}; printable keyDown → {text}; printable keyUp no-op.
  {
    const d = recordingDriver();
    await d.performActions([
      { type: 'key', id: 'k', actions: [
        { type: 'keyDown', value: '\\uE007' }, // Enter → vk 0x0d down:true
        { type: 'keyUp', value: '\\uE007' },   // Enter → vk 0x0d down:false
        { type: 'keyDown', value: 'a' },        // printable → {text:'a'}
        { type: 'keyUp', value: 'a' },          // printable keyUp → NO op
      ] },
    ]);
    out.keys = d.ops;
  }
  // unsupported source type throws.
  {
    const d = recordingDriver();
    out.unsupportedSource = await cap(() => d.performActions([{ type: 'wheel', id: 'w', actions: [] }]));
  }
  // unsupported pointer action throws.
  {
    const d = recordingDriver();
    out.unsupportedPointer = await cap(() => d.performActions([
      { type: 'pointer', id: 'm', actions: [{ type: 'pointerCancel' }] },
    ]));
  }
}

// ── 8. getAttribute serialization ─────────────────────────────────────────────────────────────
{
  out.attr = {};
  // 'all' → JSON string of the full dump; op uses names:'all'.
  {
    const d = mk();
    let captured;
    d.op = async (op) => { captured = op; return { Name: 'X', IsEnabled: true }; };
    const v = await d.getAttribute('all', 'el-1');
    out.attr.all = { value: v, opNames: captured.names };
  }
  // object value (BoundingRectangle) → JSON.stringify.
  {
    const d = mk();
    d.op = async () => ({ BoundingRectangle: { x: 1, y: 2, width: 3, height: 4 } });
    out.attr.object = await d.getAttribute('BoundingRectangle', 'el-1');
  }
  // null/missing → null.
  {
    const d = mk();
    d.op = async () => ({ Name: null });
    out.attr.nullValue = await d.getAttribute('Name', 'el-1');
    const d2 = mk();
    d2.op = async () => ({}); // missing key → undefined → null
    out.attr.missing = await d2.getAttribute('Name', 'el-1');
  }
  // scalar → String().
  {
    const d = mk();
    d.op = async () => ({ IsEnabled: true });
    out.attr.boolScalar = await d.getAttribute('IsEnabled', 'el-1');
    const d2 = mk();
    d2.op = async () => ({ Count: 42 });
    out.attr.numScalar = await d2.getAttribute('Count', 'el-1');
  }
}

// ── 9. getProperty returns the JSON-TYPED value (W3C §12.4.3), not the string coercion ─────────
{
  out.prop = {};
  // boolean stays a boolean (getAttribute would give the string "true").
  {
    const d = mk();
    let captured;
    d.op = async (op) => { captured = op; return { IsEnabled: true }; };
    out.prop.bool = await d.getProperty('IsEnabled', 'el-1');
    out.prop.boolType = typeof out.prop.bool;
    out.prop.opNames = captured.names; // ['IsEnabled']
  }
  // number stays a number.
  {
    const d = mk();
    d.op = async () => ({ Count: 42 });
    out.prop.num = await d.getProperty('Count', 'el-1');
    out.prop.numType = typeof out.prop.num;
  }
  // object stays an object (NOT a JSON string).
  {
    const d = mk();
    d.op = async () => ({ BoundingRectangle: { x: 1, y: 2, width: 3, height: 4 } });
    out.prop.object = await d.getProperty('BoundingRectangle', 'el-1');
    out.prop.objectType = typeof out.prop.object;
  }
  // string stays a string.
  {
    const d = mk();
    d.op = async () => ({ Name: 'hello' });
    out.prop.str = await d.getProperty('Name', 'el-1');
  }
  // null / missing → null.
  {
    const d = mk();
    d.op = async () => ({ Name: null });
    out.prop.nullValue = await d.getProperty('Name', 'el-1');
    const d2 = mk();
    d2.op = async () => ({});
    out.prop.missing = await d2.getProperty('Name', 'el-1');
  }
}

// ── 6c. Find-From-Element validates the context element FIRST (W3C §12.3.4) ────────────────────
// A context id must be validated before the search runs, even for an absolute //… selector. We record
// the ops in order; the first op for a from-element find MUST be an attributes op on the context.
{
  out.ctxValidate = {};
  // absolute //… with context → attributes op on the context BEFORE any find.
  {
    const d = mk();
    d.ops = [];
    d.op = async (op) => { d.ops.push(op); return op.op === 'find' ? { elements: [] } : { ControlType: 'Window' }; };
    await cap(() => d.findElOrEls('xpath', '//Button', true, 'ctx-9'));
    out.ctxValidate.absolute = d.ops.map((o) => ({ op: o.op, id: o.id, startId: o.startId }));
  }
  // relative .//… with context → still validates the context first (behaviour unchanged otherwise).
  {
    const d = mk();
    d.ops = [];
    d.op = async (op) => { d.ops.push(op); return op.op === 'find' ? { elements: [] } : { ControlType: 'Window' }; };
    await cap(() => d.findElOrEls('xpath', './/Button', true, 'ctx-9'));
    out.ctxValidate.relative = d.ops.map((o) => ({ op: o.op, id: o.id, startId: o.startId }));
  }
  // NO context → no validation op; the engine starts straight away from root.
  {
    const d = mk();
    d.ops = [];
    d.op = async (op) => { d.ops.push(op); return { elements: [] }; };
    await cap(() => d.findElOrEls('xpath', '//Button', true));
    out.ctxValidate.noContext = d.ops.map((o) => ({ op: o.op, id: o.id, startId: o.startId }));
  }
}

// ── 6c-stale. A stale/invalid context propagates the validation-op error (no find attempted) ───
{
  const { errors } = await import('@appium/base-driver');
  const d = mk();
  d.ops = [];
  d.op = async (op) => {
    d.ops.push(op);
    if (op.op === 'attributes') throw new errors.StaleElementReferenceError('context gone');
    return { elements: [] };
  };
  const res = await cap(() => d.findElOrEls('xpath', '//Button', true, 'ctx-stale'));
  out.ctxStale = { res, opsKinds: d.ops.map((o) => o.op) };
}

process.stdout.write(JSON.stringify(out));
`;

describe('FlaUINativeDriver translation (find mapping, performActions, getAttribute)', function () {
  let out: any;
  before(function () {
    if (!fs.existsSync(builtDriver)) this.skip(); // run `npm run build` first
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', PROBE], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    out = JSON.parse(raw);
  });

  const ELEM_KEY = 'element-6066-11e4-a52e-4f735466cecf';

  describe('6. locator-strategy → condition mapping (findElOrEls)', () => {
    const cases: Array<[string, string]> = [
      ['accessibility id', 'AutomationId'],
      ['id', 'AutomationId'],
      ['name', 'Name'],
      ['class name', 'ClassName'],
      ['tag name', 'ControlType'],
    ];
    for (const [strategy, prop] of cases) {
      it(`'${strategy}' → property condition on ${prop}`, () => {
        const s = out.strategy[strategy];
        expect(s.threw).to.equal(false);
        expect(s.op.op).to.equal('find');
        expect(s.op.multiple).to.equal(false);
        expect(s.op.scope).to.equal('subtree');
        expect(s.op.startId).to.equal('root');
        expect(s.op.condition).to.deep.equal({ kind: 'property', prop, value: 'theValue' });
        expect(s.element).to.deep.equal({ [ELEM_KEY]: 'rt-1' });
      });
    }

    it('multiple:true maps every returned element to a W3C element object', () => {
      expect(out.strategyMultiple.scope).to.equal('subtree');
      expect(out.strategyMultiple.value).to.deep.equal([
        { [ELEM_KEY]: 'a' },
        { [ELEM_KEY]: 'b' },
      ]);
    });

    it('an unknown strategy throws "unsupported strategy"', () => {
      expect(out.strategyUnknown.threw).to.equal(true);
      expect(out.strategyUnknown.msg).to.match(/unsupported strategy: css selector/);
    });

    it('BUG FIX: single non-xpath find with NO match throws NoSuchElementError (not an undefined element)', () => {
      expect(out.singleNoMatch.threw).to.equal(true);
      expect(out.singleNoMatch.name).to.equal('NoSuchElementError');
      expect(out.singleNoMatch.msg).to.match(/unable to find an element using name 'ghost'/);
    });

    it('BUG FIX: an empty-string runtimeId is also treated as no-match (NoSuchElementError)', () => {
      expect(out.singleEmptyRuntimeId.threw).to.equal(true);
      expect(out.singleEmptyRuntimeId.name).to.equal('NoSuchElementError');
      expect(out.singleEmptyRuntimeId.msg).to.match(/accessibility id 'ghost'/);
    });
  });

  describe('6b. convertAbsoluteXPathToRelativeFromElement (from-element xpath rewrite)', () => {
    it('cap ON: leading // with a context element is rewritten to .// (scoped to the context)', () => {
      expect(out.xpathRewrite.onLeadingSlashes).to.equal('ctx-9');
    });
    it('cap OFF (default): leading // stays W3C-absolute (resolves from the tree root)', () => {
      expect(out.xpathRewrite.offLeadingSlashes).to.equal('root');
    });
    it('cap ON: an already-relative .// selector is left untouched (still from the context)', () => {
      expect(out.xpathRewrite.onAlreadyRelative).to.equal('ctx-9');
    });
    it('cap ON: a single leading / (not //) is NOT rewritten (resolves from root)', () => {
      expect(out.xpathRewrite.onSingleSlash).to.equal('root');
    });
    it('cap ON but no context element: nothing is rewritten (resolves from root)', () => {
      expect(out.xpathRewrite.onNoContext).to.equal('root');
    });
  });

  describe('7. performActions translation', () => {
    it('pointerMove viewport origin adds the cached window top-left (100,50)', () => {
      expect(out.moveViewport).to.deep.equal([{ op: 'input', kind: 'move', args: { x: 110, y: 70 } }]);
    });

    it('an omitted origin defaults to viewport', () => {
      expect(out.moveDefaultOrigin).to.deep.equal([{ op: 'input', kind: 'move', args: { x: 105, y: 56 } }]);
    });

    it('pointer origin is relative to the previous pointer position', () => {
      expect(out.movePointer).to.deep.equal([
        { op: 'input', kind: 'move', args: { x: 110, y: 70 } },
        { op: 'input', kind: 'move', args: { x: 113, y: 74 } },
      ]);
    });

    it('element origin offsets from the element CENTER (screen coords)', () => {
      expect(out.moveElement).to.deep.equal([{ op: 'input', kind: 'move', args: { x: 221, y: 312 } }]);
    });

    it('pointerDown/Up button: 2 → right, else left', () => {
      expect(out.buttons).to.deep.equal([
        { op: 'input', kind: 'down', args: { button: 'left' } },
        { op: 'input', kind: 'up', args: { button: 'left' } },
        { op: 'input', kind: 'down', args: { button: 'right' } },
        { op: 'input', kind: 'up', args: { button: 'right' } },
      ]);
    });

    it('key sequence: special → {virtualKeyCode,down}; printable keyDown → {text}; printable keyUp is a no-op', () => {
      expect(out.keys).to.deep.equal([
        { op: 'input', kind: 'keys', args: { actions: [{ virtualKeyCode: 0x0d, down: true }] } },
        { op: 'input', kind: 'keys', args: { actions: [{ virtualKeyCode: 0x0d, down: false }] } },
        { op: 'input', kind: 'keys', args: { actions: [{ text: 'a' }] } },
        // the printable keyUp emitted NO op (only 3 ops total)
      ]);
    });

    it('an unsupported action source type throws', () => {
      expect(out.unsupportedSource.threw).to.equal(true);
      expect(out.unsupportedSource.msg).to.match(/unsupported action source type: wheel/);
    });

    it('an unsupported pointer action throws', () => {
      expect(out.unsupportedPointer.threw).to.equal(true);
      expect(out.unsupportedPointer.msg).to.match(/unsupported pointer action: pointerCancel/);
    });
  });

  describe('8. getAttribute serialization', () => {
    it("'all' → JSON string of the full dump (op requests names:'all')", () => {
      expect(out.attr.all.opNames).to.equal('all');
      expect(out.attr.all.value).to.equal(JSON.stringify({ Name: 'X', IsEnabled: true }));
    });

    it('an object value (BoundingRectangle) → JSON.stringify', () => {
      expect(out.attr.object).to.equal(JSON.stringify({ x: 1, y: 2, width: 3, height: 4 }));
    });

    it('a null or missing value → null', () => {
      expect(out.attr.nullValue).to.equal(null);
      expect(out.attr.missing).to.equal(null);
    });

    it('a scalar value → String()', () => {
      expect(out.attr.boolScalar).to.equal('true');
      expect(out.attr.numScalar).to.equal('42');
    });
  });

  describe('9. getProperty returns the JSON-typed value (W3C §12.4.3)', () => {
    it('requests the named attribute from the backend', () => {
      expect(out.prop.opNames).to.deep.equal(['IsEnabled']);
    });
    it('a boolean stays a boolean (true), NOT the string "true"', () => {
      expect(out.prop.bool).to.equal(true);
      expect(out.prop.boolType).to.equal('boolean');
    });
    it('a number stays a number (42), NOT the string "42"', () => {
      expect(out.prop.num).to.equal(42);
      expect(out.prop.numType).to.equal('number');
    });
    it('an object stays an object, NOT a JSON string', () => {
      expect(out.prop.object).to.deep.equal({ x: 1, y: 2, width: 3, height: 4 });
      expect(out.prop.objectType).to.equal('object');
    });
    it('a string stays a string', () => {
      expect(out.prop.str).to.equal('hello');
    });
    it('a null or missing value → null', () => {
      expect(out.prop.nullValue).to.equal(null);
      expect(out.prop.missing).to.equal(null);
    });
  });

  describe('6c. Find-From-Element validates the context element first (W3C §12.3.4)', () => {
    it('an absolute //… selector still validates the context with an attributes op BEFORE any find', () => {
      const ops = out.ctxValidate.absolute;
      expect(ops[0]).to.deep.include({ op: 'attributes', id: 'ctx-9' });
      // a find only runs after the context is validated.
      expect(ops.some((o: any) => o.op === 'find')).to.equal(true);
      expect(ops.findIndex((o: any) => o.op === 'attributes')).to.be.lessThan(
        ops.findIndex((o: any) => o.op === 'find'),
      );
    });
    it('a relative .//… selector also validates the context first (otherwise unchanged)', () => {
      const ops = out.ctxValidate.relative;
      expect(ops[0]).to.deep.include({ op: 'attributes', id: 'ctx-9' });
    });
    it('with NO context element, no validation op is emitted', () => {
      const ops = out.ctxValidate.noContext;
      expect(ops.every((o: any) => o.op !== 'attributes')).to.equal(true);
    });
    it('a stale context propagates the validation error and never attempts a find', () => {
      expect(out.ctxStale.res.threw).to.equal(true);
      expect(out.ctxStale.res.name).to.equal('StaleElementReferenceError');
      expect(out.ctxStale.opsKinds).to.deep.equal(['attributes']); // no find ran
    });
  });
});
