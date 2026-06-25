import { expect } from 'chai';
import { xpathToElementIds, type FoundElement } from '../../lib/xpath/core';
import type { BackendOp, Condition, TreeScopeName } from '../../lib/backend/ops';

/**
 * Node-set predicates — `[child]`, `[./child]`, `[.//descendant]` — are true iff the node-set is
 * NON-EMPTY (XPath 1.0 boolean(node-set)), not the string-value of its first node. Regression for a
 * bug where predicateTruth reduced an element node-set to a scalar, which is always '' in this
 * text-node-free UIA world, so every "has a child element" predicate wrongly matched nothing.
 *
 * Tree: two Lists — one WITH a Header child, one WITHOUT.
 */
interface Node {
  id: string;
  controlType: string;
  props: Record<string, unknown>;
  children: Node[];
  parent?: Node;
}

function n(id: string, controlType: string, children: Node[] = []): Node {
  const node: Node = { id, controlType, props: { ControlType: controlType }, children };
  for (const c of children) c.parent = node;
  return node;
}

const ROOT = n('root', 'Pane', [
  n('listWith', 'List', [n('hdr', 'Header', [n('hi', 'HeaderItem')]), n('li1', 'ListItem')]),
  n('listWithout', 'List', [n('li2', 'ListItem')]),
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
  return { runtimeId: node.id, controlType: node.controlType };
}

const backend = {
  async find(op: BackendOp): Promise<FoundElement[]> {
    if (op.op !== 'find') throw new Error('not a find op');
    const start = byId.get(op.startId);
    if (!start) return [];
    const matched = collectScope(start, op.scope).filter((nd) => matchCond(nd, op.condition));
    return (op.multiple ? matched : matched.slice(0, 1)).map(toFound);
  },
  async walk(id: string, direction: string): Promise<FoundElement[]> {
    const node = byId.get(id);
    if (!node) return [];
    if (direction === 'parent') return node.parent ? [toFound(node.parent)] : [];
    if (direction === 'ancestors') {
      const out: FoundElement[] = [];
      let cur = node.parent;
      while (cur) {
        out.push(toFound(cur));
        cur = cur.parent;
      }
      return out;
    }
    return [];
  },
  async attributes(): Promise<Record<string, unknown>> {
    return {};
  },
};

const ids = (xpath: string) => xpathToElementIds(xpath, true, undefined, backend);

describe('xpath node-set existence predicates', () => {
  it('//List/Header selects the Header (the path form works)', async () => {
    expect(await ids('//List/Header')).to.deep.equal(['hdr']);
  });

  it('//List[Header] keeps only the List that has a direct Header child', async () => {
    expect(await ids('//List[Header]')).to.deep.equal(['listWith']);
  });

  it('//List[./Header] (explicit self-axis) behaves identically to //List[Header]', async () => {
    expect(await ids('//List[./Header]')).to.deep.equal(['listWith']);
  });

  it('//List[.//Header] matches on a descendant Header', async () => {
    expect(await ids('//List[.//Header]')).to.deep.equal(['listWith']);
  });

  it('//List[not(Header)] keeps only the List WITHOUT a Header child', async () => {
    expect(await ids('//List[not(Header)]')).to.deep.equal(['listWithout']);
  });

  it('//List with no predicate still selects both Lists', async () => {
    expect(await ids('//List')).to.deep.equal(['listWith', 'listWithout']);
  });
});
