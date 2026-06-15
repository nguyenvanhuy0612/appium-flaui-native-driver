import { expect } from 'chai';
import { xpathToElementIds, InvalidSelectorError, type XPathBackend, type FoundElement } from '../../lib/xpath/core';
import type { BackendOp, Condition, TreeScopeName } from '../../lib/backend/ops';

/**
 * Regression coverage for the XPath 1.0 conformance fixes (see docs/internal/xpath-conformance-audit.md).
 * These construct the exact conditions the older fixtures masked:
 *   - multiple same-type siblings,
 *   - a genuinely-absent attribute (getProp → undefined) AND a present-but-empty one (Name=""),
 *   - a backend that returns booleans as the "True"/"False" strings the production driver emits.
 *
 *   root(Pane) > win(Window ProcessId=4321) >
 *     grp(Group) > [ bOk(Button Name="ok" IsEnabled=true),
 *                    bCancel(Button Name="cancel" IsEnabled=false),
 *                    bNoName(Button IsEnabled=true),          // Name ABSENT
 *                    bEmpty(Button Name="" IsEnabled=true) ], // Name present-but-empty
 *     ed(Edit Name="editor")
 */
interface Node { id: string; controlType: string; props: Record<string, unknown>; children: Node[]; parent?: Node; }
function n(id: string, ct: string, props: Record<string, unknown> = {}, children: Node[] = []): Node {
  const node: Node = { id, controlType: ct, props: { ...props, ControlType: ct }, children };
  for (const c of children) c.parent = node;
  return node;
}
const ROOT = n('root', 'Pane', {}, [
  n('win', 'Window', { ProcessId: 4321, IsEnabled: true }, [
    n('grp', 'Group', {}, [
      n('bOk', 'Button', { Name: 'ok', IsEnabled: true }),
      n('bCancel', 'Button', { Name: 'cancel', IsEnabled: false }),
      n('bNoName', 'Button', { IsEnabled: true }), // Name absent
      n('bEmpty', 'Button', { Name: '', IsEnabled: true }), // Name present-but-empty
    ]),
    n('ed', 'Edit', { Name: 'editor', IsEnabled: true }),
  ]),
]);
const byId = new Map<string, Node>();
(function idx(x: Node) { byId.set(x.id, x); x.children.forEach(idx); })(ROOT);

function matchCond(node: Node, c: Condition): boolean {
  switch (c.kind) {
    case 'true': return true;
    case 'and': return c.children.every((k) => matchCond(node, k));
    case 'or': return c.children.some((k) => matchCond(node, k));
    case 'not': return !matchCond(node, c.child);
    case 'property': {
      const a = node.props[c.prop];
      if (typeof c.value === 'boolean') return Boolean(a) === c.value; // backend compares the real bool
      return String(a ?? '') === String(c.value);
    }
    default: return false;
  }
}
function scope(start: Node, s: TreeScopeName): Node[] {
  if (s === 'children') return [...start.children];
  if (s === 'element') return [start];
  const out: Node[] = s === 'subtree' ? [start] : [];
  const v = (x: Node) => { for (const k of x.children) { out.push(k); v(k); } };
  v(start); return out;
}
function found(node: Node): FoundElement {
  return { runtimeId: node.id, name: node.props.Name === undefined ? undefined : String(node.props.Name),
    automationId: undefined, className: undefined, controlType: node.controlType };
}
// attributes() mimics the driver: booleans -> "True"/"False"; an ABSENT prop is omitted (undefined).
const backend: XPathBackend = {
  async find(op: BackendOp): Promise<FoundElement[]> {
    if (op.op !== 'find') throw new Error('not find');
    const start = byId.get(op.startId); if (!start) return [];
    const m = scope(start, op.scope).filter((nd) => matchCond(nd, op.condition));
    return (op.multiple ? m : m.slice(0, 1)).map(found);
  },
  async walk(id, dir): Promise<FoundElement[]> {
    const node = byId.get(id); if (!node) return [];
    if (dir === 'parent') return node.parent ? [found(node.parent)] : [];
    if (dir === 'ancestors') { const o: FoundElement[] = []; let p = node.parent; while (p) { o.push(found(p)); p = p.parent; } return o; }
    if (dir === 'following-siblings') { if (!node.parent) return []; const s = node.parent.children; return s.slice(s.indexOf(node) + 1).map(found); }
    if (dir === 'preceding-siblings') { if (!node.parent) return []; const s = node.parent.children; return s.slice(0, s.indexOf(node)).map(found); }
    return [];
  },
  async attributes(id, names): Promise<Record<string, unknown>> {
    const node = byId.get(id); if (!node) return {};
    const conv = (v: unknown) => (typeof v === 'boolean' ? (v ? 'True' : 'False') : v);
    if (names === 'all') { const o: Record<string, unknown> = {}; for (const [k, v] of Object.entries(node.props)) o[k] = conv(v); return o; }
    const o: Record<string, unknown> = {}; for (const nm of names) if (node.props[nm] !== undefined) o[nm] = conv(node.props[nm]); return o;
  },
};
const ids = (xp: string) => xpathToElementIds(xp, true, undefined, backend);
async function threw(xp: string): Promise<boolean> {
  try { await ids(xp); return false; } catch { return true; }
}

describe('xpath conformance regressions', () => {
  // #2 — non-integer positional must select nothing, NOT crash on els[1.7].runtimeId
  describe('#2 non-integer / out-of-range positional', () => {
    it('//Button[2.7] returns [] (not a crash)', async () => {
      expect(await ids('//Button[2.7]')).to.deep.equal([]);
    });
    it('(//Button)[2.7] returns [] (not a crash)', async () => {
      expect(await ids('(//Button)[2.7]')).to.deep.equal([]);
    });
    it('//Button[0] returns []', async () => {
      expect(await ids('//Button[0]')).to.deep.equal([]);
    });
  });

  // #3 — comparison with an EMPTY node-set is always false (= AND !=). This is only reachable on the
  // TS-side comparison path (a non-pushable predicate); a simple `@x!=v` is pushed to the backend as a
  // Not(property) condition instead. Use a multi-step path to a GENUINELY-absent attribute so the node-set
  // is truly empty (standard UIA props are always present as "", so this mainly affects custom attributes).
  describe('#3 empty node-set comparison (TS-side, non-pushable)', () => {
    it('//Group[Button/@Missing="x"] is empty (= on an empty node-set is false)', async () => {
      expect(await ids('//Group[Button/@Missing="x"]')).to.deep.equal([]);
    });
    it('//Group[Button/@Missing!="x"] is empty (!= on an empty node-set is ALSO false — the fix)', async () => {
      expect(await ids('//Group[Button/@Missing!="x"]')).to.deep.equal([]);
    });
    it('non-empty multi-step comparison still matches existentially', async () => {
      expect(await ids('//Group[Button/@Name="cancel"]')).to.deep.equal(['grp']);
    });
  });

  // #4 — multi-step node-set comparison inside a predicate must evaluate, not throw
  describe('#4 multi-step node-set comparison in predicate', () => {
    it('//Group[Button/@Name="ok"] resolves (does not throw)', async () => {
      expect(await ids('//Group[Button/@Name="ok"]')).to.deep.equal(['grp']);
    });
    it('//Group[Button/@Name="nope"] is empty (no throw)', async () => {
      expect(await threw('//Group[Button/@Name="nope"]')).to.equal(false);
      expect(await ids('//Group[Button/@Name="nope"]')).to.deep.equal([]);
    });
    it('terminal /@attr as a LOCATOR still throws InvalidSelectorError', async () => {
      let err: unknown;
      try { await ids('//Button/@Name'); } catch (e) { err = e; }
      expect(err).to.be.instanceOf(InvalidSelectorError);
    });
  });

  // #5 — boolean attribute predicate on a reverse/sibling axis (TS-side matchesCondition with "True"/"False")
  describe('#5 boolean attribute predicate on TS-side axes', () => {
    it('forward axis (sanity): //Group/Button[@IsEnabled="false"]', async () => {
      expect(await ids('//Group/Button[@IsEnabled="false"]')).to.deep.equal(['bCancel']);
    });
    it('following-sibling::Button[@IsEnabled="false"] finds the disabled one', async () => {
      expect(await ids('//Button[@Name="ok"]/following-sibling::Button[@IsEnabled="false"]')).to.deep.equal(['bCancel']);
    });
    it('following-sibling::Button[@IsEnabled="true"] excludes the disabled one', async () => {
      expect(await ids('//Button[@Name="ok"]/following-sibling::Button[@IsEnabled="true"]')).to.deep.equal(['bNoName', 'bEmpty']);
    });
  });
});
