import { expect } from 'chai';
import { xpathToElementIds, type XPathBackend, type FoundElement } from '../../lib/xpath/core';
import type { BackendOp, Condition, TreeScopeName } from '../../lib/backend/ops';

/**
 * XPath positional semantics for `//Tag[n]` (RELEASE-FIXES P1-5). The decisive case the Notepad fixture in
 * xpath-full.spec.ts can't express: TWO sibling parents that EACH hold two same-typed children. Existing
 * tests do NOT distinguish the two readings — "//ListItem[1]" has only one parent, and the "first child of
 * each parent" case uses an explicit two-step child path — neither exposes the difference, which is why the
 * bug went unnoticed.
 *
 *   root (Pane)
 *    └─ Window#win
 *        ├─ Pane#p1 ─ Button#b1a, Button#b1b
 *        └─ Pane#p2 ─ Button#b2a, Button#b2b
 *
 * Document order of all Buttons: b1a, b1b, b2a, b2b.
 *
 * P1-5 (FIXED): `//Button[n]` is now PER-PARENT per XPath 1.0 — the nth Button of each parent.
 * collapseDoubleSlash re-expands `//Button[n]` to `descendant::Button` → `parent::node()` →
 * `child::Button[n]` so the positional predicate applies within each parent context. The grouped form
 * `(//Button)[n]` remains a single GLOBAL index over the whole flattened set.
 */

interface Node {
  id: string;
  controlType: string;
  props: Record<string, unknown>;
  children: Node[];
  parent?: Node;
}

function n(id: string, controlType: string, children: Node[] = [], props: Record<string, unknown> = {}): Node {
  const node: Node = { id, controlType, props: { ...props, ControlType: controlType }, children };
  for (const c of children) c.parent = node;
  return node;
}

const ROOT = n('root', 'Pane', [
  n('win', 'Window', [
    n('p1', 'Pane', [n('b1a', 'Button'), n('b1b', 'Button')]),
    n('p2', 'Pane', [n('b2a', 'Button'), n('b2b', 'Button')]),
  ]),
]);

const byId = new Map<string, Node>();
(function index(node: Node) {
  byId.set(node.id, node);
  node.children.forEach(index);
})(ROOT);

function matchCond(node: Node, cond: Condition): boolean {
  switch (cond.kind) {
    case 'true':
      return true;
    case 'and':
      return cond.children.every((c) => matchCond(node, c));
    case 'or':
      return cond.children.some((c) => matchCond(node, c));
    case 'not':
      return !matchCond(node, cond.child);
    case 'property':
      return String(node.props[cond.prop] ?? '') === String(cond.value);
    default:
      return false;
  }
}

function collectScope(start: Node, scope: TreeScopeName): Node[] {
  if (scope === 'children') return [...start.children];
  if (scope === 'element') return [start];
  const out: Node[] = scope === 'subtree' ? [start] : [];
  const visit = (x: Node) => {
    for (const c of x.children) {
      out.push(c);
      visit(c);
    }
  };
  visit(start);
  return out;
}

function toFound(node: Node): FoundElement {
  return { runtimeId: node.id, name: undefined, automationId: undefined, className: undefined, controlType: node.controlType };
}

const backend: XPathBackend = {
  async find(op: BackendOp): Promise<FoundElement[]> {
    if (op.op !== 'find') throw new Error('not a find op');
    const start = byId.get(op.startId);
    if (!start) return [];
    const matched = collectScope(start, op.scope).filter((nd) => matchCond(nd, op.condition));
    return (op.multiple ? matched : matched.slice(0, 1)).map(toFound);
  },
  async walk(id, direction): Promise<FoundElement[]> {
    const node = byId.get(id);
    if (!node) return [];
    if (direction === 'parent') return node.parent ? [toFound(node.parent)] : [];
    return [];
  },
  async attributes(): Promise<Record<string, unknown>> {
    return {};
  },
};

const ids = (xpath: string) => xpathToElementIds(xpath, true, undefined, backend);

describe('xpath positional semantics (P1-5)', () => {
  // Grouped `(...)[n]` is unambiguous and correct in either reading — pins the global index.
  describe('grouped (//Button)[n] — global index (correct today)', () => {
    it('(//Button)[1] is the first Button in document order', async () => {
      expect(await ids('(//Button)[1]')).to.deep.equal(['b1a']);
    });
    it('(//Button)[2] is the second Button in document order', async () => {
      expect(await ids('(//Button)[2]')).to.deep.equal(['b1b']);
    });
    it('(//Button)[last()] is the last Button in document order', async () => {
      expect(await ids('(//Button)[last()]')).to.deep.equal(['b2b']);
    });
  });

  // `//Button[n]` is PER-PARENT (XPath 1.0): the nth Button of EACH parent (P1-5 fix).
  describe('//Button[n] — per-parent (XPath 1.0)', () => {
    it('//Button[2] is the 2nd Button of EACH parent', async () => {
      expect(await ids('//Button[2]')).to.deep.equal(['b1b', 'b2b']);
    });
    it('//Button[1] is the 1st Button of EACH parent', async () => {
      expect(await ids('//Button[1]')).to.deep.equal(['b1a', 'b2a']);
    });
    it('//Button[last()] is the last Button of EACH parent', async () => {
      expect(await ids('//Button[last()]')).to.deep.equal(['b1b', 'b2b']);
    });
    it('//Button[position()=1] is per-parent', async () => {
      expect(await ids('//Button[position()=1]')).to.deep.equal(['b1a', 'b2a']);
    });
  });
});
