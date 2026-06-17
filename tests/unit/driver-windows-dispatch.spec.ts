// Characterization coverage for the prototype-generated `windows:` command methods and the
// performActions multi-source / edge cases NOT already covered by driver-translation.spec.ts.
//
//   - windowsCmd_* generation (lib/driver.ts:908-937): ACTION commands accept either positional element
//     style (elementId OR the W3C element key) and throw a clear error when neither is supplied; INPUT
//     commands rebuild the named-args object from positional args in the declared required+optional order.
//   - executeMethod dispatch (lib/driver.ts:880-906 + lib/commands/extensions.ts): a `windows: <name>`
//     script reaches the right prototype method and produces the right backend op.
//   - performActions: empty actions array = clean no-op; multi-source (key + pointer) sequences translate;
//     an unsupported source type is rejected.
//
// Same loader constraint as the other driver specs: drive a PLAIN-node child process that imports the
// BUILT driver, stubs op()/executeMethod, captures emitted ops, and reports JSON we assert on.
import { expect } from 'chai';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const builtDriver = path.join(repoRoot, 'build/lib/driver.js');
const builtDriverUrl = pathToFileURL(builtDriver).href;
const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

const PROBE = `
import { FlaUINativeDriver } from ${JSON.stringify(builtDriverUrl)};

const W3C = ${JSON.stringify(W3C_ELEMENT_KEY)};

function mk() {
  const d = new FlaUINativeDriver({}, false);
  d.opts.automationName = 'FlaUINative';
  return d;
}
// captures the single op the method emits.
function capturing() {
  const d = mk();
  d.lastOp = undefined;
  d.op = async (o) => { d.lastOp = o; return { ok: 1 }; };
  return d;
}
async function cap(fn) {
  try { const value = await fn(); return { threw: false, value }; }
  catch (e) { return { threw: true, name: e && e.constructor && e.constructor.name, msg: String(e && e.message || e) }; }
}

const out = {};

// ── ACTION command: positional elementId ───────────────────────────────────────────────────────
{
  const d = capturing();
  const res = await cap(() => d.windowsCmd_invoke('42.1'));
  out.actionByElementId = { res, op: d.lastOp };
}
// ACTION command: W3C element key in the SECOND positional slot (elementId omitted/undefined).
{
  const d = capturing();
  const res = await cap(() => d.windowsCmd_invoke(undefined, 'rt-9'));
  out.actionByW3cKey = { res, op: d.lastOp };
}
// ACTION command: setValue carries the value arg through into op args.
{
  const d = capturing();
  const res = await cap(() => d.windowsCmd_setValue('42.1', undefined, 'hello'));
  out.actionWithValue = { res, op: d.lastOp };
}
// ACTION command: NO element id at all → clear "requires an elementId" error, op never emitted.
{
  const d = capturing();
  const res = await cap(() => d.windowsCmd_invoke());
  out.actionNoId = { res, op: d.lastOp };
}

// ── INPUT command: positional → named arg rebuild ───────────────────────────────────────────────
// click params order = [elementId, x, y, button, times, modifierKeys, durationMs, interClickDelayMs, bringToFront]
{
  const d = capturing();
  // elementId='e', x=undefined, y=undefined, button='right', times=2
  const res = await cap(() => d.windowsCmd_click('e', undefined, undefined, 'right', 2));
  out.inputClick = { res, op: d.lastOp };
}
// scroll params order = [elementId, x, y, deltaX, deltaY, amount, modifierKeys, bringToFront]
{
  const d = capturing();
  const res = await cap(() => d.windowsCmd_scroll('e', 10, 20, 0, -120));
  out.inputScroll = { res, op: d.lastOp };
}
// undefined positional args are dropped (not set to undefined keys).
{
  const d = capturing();
  const res = await cap(() => d.windowsCmd_click(undefined, 5, 6));
  out.inputSparse = { res, op: d.lastOp };
}

// ── executeMethod dispatch end-to-end: 'windows: invoke' → windowsCmd_invoke → op ──────────────
{
  const d = capturing();
  // base-driver's executeMethod resolves the script via the static map → calls this[command](...params).
  const res = await cap(() => d.executeMethod('windows: invoke', [{ elementId: '42.1' }]));
  out.dispatchInvoke = { res, op: d.lastOp };
}
// executeMethod dispatch with the W3C element key as the named param.
{
  const d = capturing();
  const args = {}; args[W3C] = 'rt-7';
  const res = await cap(() => d.executeMethod('windows: invoke', [args]));
  out.dispatchInvokeW3c = { res, op: d.lastOp };
}
// executeMethod dispatch missing the element id → the same "requires an elementId" error surfaces.
{
  const d = capturing();
  const res = await cap(() => d.executeMethod('windows: invoke', [{}]));
  out.dispatchNoId = { res, op: d.lastOp };
}

// ── performActions multi-source + edge cases ────────────────────────────────────────────────────
function recordingDriver() {
  const d = mk();
  d.ops = [];
  d.op = async (op) => { d.ops.push(op); return {}; };
  d.getWindowRect = async () => ({ x: 100, y: 50, width: 800, height: 600 });
  d.getElementRect = async () => ({ x: 200, y: 300, width: 40, height: 20 });
  return d;
}
// empty actions array → clean no-op, no ops emitted, resolves.
{
  const d = recordingDriver();
  const res = await cap(() => d.performActions([]));
  out.emptyActions = { res, opCount: d.ops.length };
}
// undefined actions → also a clean no-op (actions ?? []).
{
  const d = recordingDriver();
  const res = await cap(() => d.performActions(undefined));
  out.undefinedActions = { res, opCount: d.ops.length };
}
// a source with an empty action list → no-op, no ops.
{
  const d = recordingDriver();
  const res = await cap(() => d.performActions([{ type: 'pointer', id: 'm', actions: [] }]));
  out.emptySourceActions = { res, opCount: d.ops.length };
}
// multi-source: a key source THEN a pointer source, each translated in order.
{
  const d = recordingDriver();
  const res = await cap(() => d.performActions([
    { type: 'key', id: 'k', actions: [{ type: 'keyDown', value: 'a' }, { type: 'keyUp', value: 'a' }] },
    { type: 'pointer', id: 'm', actions: [{ type: 'pointerMove', origin: 'viewport', x: 1, y: 2 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] },
  ]));
  out.multiSource = { res, ops: d.ops };
}
// an unsupported source type rejects.
{
  const d = recordingDriver();
  out.unsupportedSource = await cap(() => d.performActions([{ type: 'gamepad', id: 'g', actions: [] }]));
}

process.stdout.write(JSON.stringify(out));
`;

describe('FlaUINativeDriver windows: dispatch + performActions edge cases', function () {
  let out: any;
  before(function () {
    if (!fs.existsSync(builtDriver)) this.skip();
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', PROBE], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    out = JSON.parse(raw);
  });

  describe('windows: ACTION command generation (windowsCmd_*)', () => {
    it('accepts a positional elementId → actionOp on that element', () => {
      expect(out.actionByElementId.res.threw, out.actionByElementId.res.msg).to.equal(false);
      expect(out.actionByElementId.op).to.deep.equal({ op: 'action', id: '42.1', action: 'invoke', args: {} });
    });
    it('accepts the W3C element key in the second positional slot when elementId is undefined', () => {
      expect(out.actionByW3cKey.res.threw).to.equal(false);
      expect(out.actionByW3cKey.op).to.deep.equal({ op: 'action', id: 'rt-9', action: 'invoke', args: {} });
    });
    it('passes a value arg through (setValue → args.value)', () => {
      expect(out.actionWithValue.res.threw).to.equal(false);
      expect(out.actionWithValue.op).to.deep.equal({ op: 'action', id: '42.1', action: 'setValue', args: { value: 'hello' } });
    });
    it('throws a clear "requires an elementId" error when no element is supplied (no op emitted)', () => {
      expect(out.actionNoId.res.threw).to.equal(true);
      expect(out.actionNoId.res.msg).to.match(/windows: invoke requires an elementId/);
      expect(out.actionNoId.op).to.equal(undefined);
    });
  });

  describe('windows: INPUT command generation (positional → named rebuild)', () => {
    it('rebuilds named args from positional click params in declared order', () => {
      expect(out.inputClick.res.threw, out.inputClick.res.msg).to.equal(false);
      expect(out.inputClick.op).to.deep.equal({
        op: 'input',
        kind: 'click',
        args: { elementId: 'e', button: 'right', times: 2 },
      });
    });
    it('rebuilds named args from positional scroll params in declared order', () => {
      expect(out.inputScroll.res.threw).to.equal(false);
      expect(out.inputScroll.op).to.deep.equal({
        op: 'input',
        kind: 'scroll',
        args: { elementId: 'e', x: 10, y: 20, deltaX: 0, deltaY: -120 },
      });
    });
    it('drops undefined positional args (no undefined-valued keys)', () => {
      expect(out.inputSparse.res.threw).to.equal(false);
      expect(out.inputSparse.op).to.deep.equal({ op: 'input', kind: 'click', args: { x: 5, y: 6 } });
      expect(out.inputSparse.op.args).to.not.have.property('elementId');
    });
  });

  describe('executeMethod dispatch (windows: <name>)', () => {
    it('dispatches `windows: invoke` with a named elementId to the right op', () => {
      expect(out.dispatchInvoke.res.threw, out.dispatchInvoke.res.msg).to.equal(false);
      expect(out.dispatchInvoke.op).to.deep.equal({ op: 'action', id: '42.1', action: 'invoke', args: {} });
    });
    it('dispatches `windows: invoke` with the W3C element key param', () => {
      expect(out.dispatchInvokeW3c.res.threw).to.equal(false);
      expect(out.dispatchInvokeW3c.op).to.deep.equal({ op: 'action', id: 'rt-7', action: 'invoke', args: {} });
    });
    it('surfaces the "requires an elementId" error through executeMethod when no id is given', () => {
      expect(out.dispatchNoId.res.threw).to.equal(true);
      expect(out.dispatchNoId.res.msg).to.match(/windows: invoke requires an elementId/);
      expect(out.dispatchNoId.op).to.equal(undefined);
    });
  });

  describe('performActions edge cases (beyond driver-translation.spec.ts)', () => {
    it('an empty actions array is a clean no-op (no ops emitted)', () => {
      expect(out.emptyActions.res.threw).to.equal(false);
      expect(out.emptyActions.opCount).to.equal(0);
    });
    it('undefined actions is a clean no-op', () => {
      expect(out.undefinedActions.res.threw).to.equal(false);
      expect(out.undefinedActions.opCount).to.equal(0);
    });
    it('a source with an empty action list emits no ops', () => {
      expect(out.emptySourceActions.res.threw).to.equal(false);
      expect(out.emptySourceActions.opCount).to.equal(0);
    });
    it('a multi-source (key then pointer) sequence translates each source in order', () => {
      expect(out.multiSource.res.threw, out.multiSource.res.msg).to.equal(false);
      expect(out.multiSource.ops).to.deep.equal([
        // key source first: printable keyDown → text; printable keyUp → no-op
        { op: 'input', kind: 'keys', args: { actions: [{ text: 'a' }] } },
        // pointer source: move (viewport origin → +100,+50), down(left), up(left)
        { op: 'input', kind: 'move', args: { x: 101, y: 52 } },
        { op: 'input', kind: 'down', args: { button: 'left' } },
        { op: 'input', kind: 'up', args: { button: 'left' } },
      ]);
    });
    it('an unsupported action source type is rejected', () => {
      expect(out.unsupportedSource.threw).to.equal(true);
      expect(out.unsupportedSource.msg).to.match(/unsupported action source type: gamepad/);
    });
  });
});
