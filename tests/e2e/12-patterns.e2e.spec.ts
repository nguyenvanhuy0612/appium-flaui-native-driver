// SKIPPED (beta): fixture-based pattern coverage is paused — during beta these six verbs are verified
// against real apps and issues raised there, rather than maintaining a dedicated fixture + build/ship
// pipeline. Last run on .37 / beta.16 (2026-06-05): 4/5 PASS — expand, collapse,
// addToSelection+allSelectedItems (reports both items), close. The ONE not-yet-confirmed verb is
// `removeFromSelection` (the item stayed selected on the ListView fixture) — verify on a real app; it may
// be a driver bug or a control/UIA-provider quirk. To re-enable: build the fixture (see below), set
// CONTROLS_APP, run an interactive Appium, and change `describe.skip` back to `describe`.
//
// §5/§6 UIA pattern commands — real e2e coverage for the six pattern verbs that 07-extensions only
// exercises as graceful-degrade no-ops (because Notepad exposes no tree/multi-select/closable-child):
//   expand, collapse, addToSelection, removeFromSelection, allSelectedItems, close.
//
// TARGET: ControlsApp (sidecar/fixtures/ControlsApp) — a WinForms window purpose-built to support these
// patterns. In WinForms UIA a control's .Name becomes its AutomationId, so the named controls are found
// by `accessibility id` and the tree/list ITEMS (which have no AutomationId, only a Name) by `name`:
//   - TreeView "treeMain" with a COLLAPSED "RootNode" (children ChildA/ChildB)   → ExpandCollapsePattern
//   - multi-select ListView "listMulti" with "Item 1".."Item 5", nothing selected → Selection/SelectionItem
//   - Button "btnOpenDialog" opens a NON-modal child Window "Controls Dialog"     → WindowPattern.Close
//
// ControlsApp must be published to CONTROLS_APP (default C:\Users\admin\ControlsApp\ControlsApp.exe), and
// Appium must run in an interactive desktop session so the synthetic click that opens the dialog lands.
import { expect } from 'chai';
import { w3c, SessionPool, bringToFront, sleep } from '../lib/helpers.js';

const CONTROLS_APP = process.env.CONTROLS_APP ?? 'C:\\Users\\admin\\ControlsApp\\ControlsApp.exe';

/** Resolve a single element id by strategy, asserting the find succeeded. */
async function findId(sid: string, using: w3c.Using, value: string): Promise<string> {
  const res = await w3c.findElement(sid, using, value);
  expect(res.status, `find ${using}=${value}: ${res.raw?.slice(0, 200)}`).to.equal(200);
  const id = w3c.elementId(res.value);
  expect(id, `element id for ${using}=${value}`).to.be.a('string').and.have.length.greaterThan(0);
  return id!;
}

/** The `name` field of every element returned by `windows: allSelectedItems` (shape: { elements: [Basic…] }). */
function selectedNames(value: unknown): string[] {
  const els = (value as { elements?: Array<{ name?: string }> })?.elements ?? [];
  return els.map((e) => e.name ?? '');
}

describe.skip('§5/§6 UIA pattern commands (expand/collapse/selection/close)', function () {
  this.timeout(120_000);
  const pool = new SessionPool();
  let sid: string;
  before(async () => { sid = await pool.open({ 'appium:app': CONTROLS_APP }); });
  after(async () => { await pool.cleanup(); });

  // ── ExpandCollapsePattern on the TreeView's RootNode ───────────────────────────────────────────
  it('windows: expand sets ExpandCollapseState to Expanded', async () => {
    // TreeItem has only a Name (no AutomationId) → find by `name`.
    const nodeId = await findId(sid, 'name', 'RootNode');

    // Sanity: starts collapsed (the fixture calls root.Collapse()).
    const before = await w3c.getAttribute(sid, nodeId, 'ExpandCollapse.ExpandCollapseState');
    expect(before.status, `read state: ${before.raw?.slice(0, 200)}`).to.equal(200);
    expect(String(before.value)).to.equal('Collapsed');

    const exp = await w3c.execute(sid, 'windows: expand', [{ elementId: nodeId }]);
    expect(exp.status, `expand: ${exp.raw?.slice(0, 200)}`).to.equal(200);

    // ExpandCollapseState is a UIA enum; the resolver stringifies it (inspect-style) → "Expanded".
    const after = await w3c.getAttribute(sid, nodeId, 'ExpandCollapse.ExpandCollapseState');
    expect(after.status).to.equal(200);
    expect(String(after.value), 'state after expand').to.equal('Expanded');
  });

  it('windows: collapse sets ExpandCollapseState back to Collapsed', async () => {
    const nodeId = await findId(sid, 'name', 'RootNode');
    const col = await w3c.execute(sid, 'windows: collapse', [{ elementId: nodeId }]);
    expect(col.status, `collapse: ${col.raw?.slice(0, 200)}`).to.equal(200);

    const after = await w3c.getAttribute(sid, nodeId, 'ExpandCollapse.ExpandCollapseState');
    expect(after.status).to.equal(200);
    expect(String(after.value), 'state after collapse').to.equal('Collapsed');
  });

  // ── Selection / SelectionItemPattern on the multi-select ListBox ───────────────────────────────
  it('windows: select + addToSelection + allSelectedItems reports BOTH items', async () => {
    const listId = await findId(sid, 'accessibility id', 'listMulti');
    // ListItems carry only a Name → find by `name`.
    const item1 = await findId(sid, 'name', 'Item 1');
    const item3 = await findId(sid, 'name', 'Item 3');

    // `select` replaces the selection with just Item 1; `addToSelection` adds Item 3 (multi-extended box).
    const sel1 = await w3c.execute(sid, 'windows: select', [{ elementId: item1 }]);
    expect(sel1.status, `select Item 1: ${sel1.raw?.slice(0, 200)}`).to.equal(200);
    const add3 = await w3c.execute(sid, 'windows: addToSelection', [{ elementId: item3 }]);
    expect(add3.status, `addToSelection Item 3: ${add3.raw?.slice(0, 200)}`).to.equal(200);

    // allSelectedItems is a read on the SELECTION CONTAINER (the ListBox), not on an item.
    // Shape (per OpInterpreter.Basic): { elements: [ { runtimeId, name, automationId, … }, … ] }.
    const all = await w3c.execute(sid, 'windows: allSelectedItems', [{ elementId: listId }]);
    expect(all.status, `allSelectedItems: ${all.raw?.slice(0, 200)}`).to.equal(200);
    const names = selectedNames(all.value);
    expect(names.length, `selected count (names=${names.join(',')})`).to.equal(2);
    expect(names, 'selected names').to.include.members(['Item 1', 'Item 3']);
  });

  it('windows: removeFromSelection leaves only the remaining item', async () => {
    const listId = await findId(sid, 'accessibility id', 'listMulti');
    const item1 = await findId(sid, 'name', 'Item 1');

    const rem = await w3c.execute(sid, 'windows: removeFromSelection', [{ elementId: item1 }]);
    expect(rem.status, `removeFromSelection Item 1: ${rem.raw?.slice(0, 200)}`).to.equal(200);

    const all = await w3c.execute(sid, 'windows: allSelectedItems', [{ elementId: listId }]);
    expect(all.status, `allSelectedItems: ${all.raw?.slice(0, 200)}`).to.equal(200);
    const names = selectedNames(all.value);
    expect(names.length, `selected count (names=${names.join(',')})`).to.equal(1);
    expect(names, 'remaining selection').to.deep.equal(['Item 3']);
  });

  // ── WindowPattern.Close on a non-modal child window ────────────────────────────────────────────
  it('windows: close shuts the child dialog (re-find then 404 no such element)', async () => {
    // Open the child window with a REAL pointer click on the button (its handler calls dialog.Show()).
    await bringToFront(sid);
    const btnId = await findId(sid, 'accessibility id', 'btnOpenDialog');
    const click = await w3c.execute(sid, 'windows: click', [{ elementId: btnId }]);
    expect(click.status, `click btnOpenDialog: ${click.raw?.slice(0, 200)}`).to.equal(200);
    await sleep(800); // let the child Form show + register in the UIA tree

    // The child Form's Text "Controls Dialog" is its UIA Name → find the Window by `name`.
    const dlg = await w3c.findElement(sid, 'name', 'Controls Dialog');
    expect(dlg.status, `find dialog: ${dlg.raw?.slice(0, 200)}`).to.equal(200);
    const dlgId = w3c.elementId(dlg.value);
    expect(dlgId, 'dialog element id').to.be.a('string').and.have.length.greaterThan(0);

    const close = await w3c.execute(sid, 'windows: close', [{ elementId: dlgId }]);
    expect(close.status, `close: ${close.raw?.slice(0, 200)}`).to.equal(200);
    await sleep(500); // let the window tear down

    // Gone: a fresh find for the same Name must fail with the W3C no-such-element error (404).
    const gone = await w3c.findElement(sid, 'name', 'Controls Dialog');
    expect(gone.status, `re-find after close: ${gone.raw?.slice(0, 200)}`).to.equal(404);
    expect(gone.error, 'W3C error code').to.equal('no such element');
  });
});
