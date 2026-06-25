import { expect } from 'chai';
import { xpathToElementIds, type FoundElement } from '../../lib/xpath/core';
import type { BackendOp, Condition, TreeScopeName } from '../../lib/backend/ops';

/**
 * Broad XPath-condition coverage, expected values cross-checked against a reference XPath 1.0 engine
 * (the `xpath` npm package) over the identical tree. Covers axes, node tests, attribute predicates,
 * node-set existence predicates, nested predicates, positional predicates, string/number/boolean
 * functions, and unions. A separate block pins document-order deviations that are currently known gaps.
 *
 * Tree (tag = ControlType, root Window = the automation root of an app session):
 *   Window#root
 *     ToolBar#tb
 *       Button#ok      (Name=OK,     AutomationId=ok,     IsEnabled=true)
 *       Button#cancel  (Name=Cancel, AutomationId=cancel, IsEnabled=false)
 *     List#list1 (Name=files)
 *       Header#hdr
 *         HeaderItem#h1 (Name=col1)
 *         HeaderItem#h2 (Name=col2)
 *       ListItem#li_a (Name=a)
 *       ListItem#li_b (Name=b)
 *     List#list2 (Name=empty)
 *       ListItem#li_c (Name=c)
 *     Pane#p1
 *       Pane#p2
 *         Button#deep (Name=deep)
 *     Edit#edit (Name=search, AutomationId=q)
 */
interface Spec { id: string; tag: string; attrs?: Record<string, string>; children?: Spec[] }
interface Node { id: string; tag: string; props: Record<string, string>; children: Node[]; parent?: Node }

const TREE: Spec = {
  id: 'root', tag: 'Window', attrs: { Name: 'root' }, children: [
    { id: 'tb', tag: 'ToolBar', attrs: { Name: 'main' }, children: [
      { id: 'ok', tag: 'Button', attrs: { Name: 'OK', AutomationId: 'ok', IsEnabled: 'true' } },
      { id: 'cancel', tag: 'Button', attrs: { Name: 'Cancel', AutomationId: 'cancel', IsEnabled: 'false' } },
    ]},
    { id: 'list1', tag: 'List', attrs: { Name: 'files' }, children: [
      { id: 'hdr', tag: 'Header', children: [
        { id: 'h1', tag: 'HeaderItem', attrs: { Name: 'col1' } },
        { id: 'h2', tag: 'HeaderItem', attrs: { Name: 'col2' } },
      ]},
      { id: 'li_a', tag: 'ListItem', attrs: { Name: 'a' } },
      { id: 'li_b', tag: 'ListItem', attrs: { Name: 'b' } },
    ]},
    { id: 'list2', tag: 'List', attrs: { Name: 'empty' }, children: [
      { id: 'li_c', tag: 'ListItem', attrs: { Name: 'c' } },
    ]},
    { id: 'p1', tag: 'Pane', children: [
      { id: 'p2', tag: 'Pane', children: [
        { id: 'deep', tag: 'Button', attrs: { Name: 'deep' } },
      ]},
    ]},
    { id: 'edit', tag: 'Edit', attrs: { Name: 'search', AutomationId: 'q' } },
  ],
};

function build(spec: Spec, parent?: Node): Node {
  const node: Node = { id: spec.id, tag: spec.tag, props: { ...(spec.attrs ?? {}), ControlType: spec.tag }, children: [], parent };
  node.children = (spec.children ?? []).map((c) => build(c, node));
  return node;
}
const ROOT = build(TREE);
const byId = new Map<string, Node>();
(function idx(n: Node) { byId.set(n.id, n); n.children.forEach(idx); })(ROOT);

function matchCond(node: Node, cond: Condition): boolean {
  switch (cond.kind) {
    case 'true': return true;
    case 'and': return cond.children.every((c) => matchCond(node, c));
    case 'or': return cond.children.some((c) => matchCond(node, c));
    case 'not': return !matchCond(node, cond.child);
    case 'property': return String(node.props[cond.prop] ?? '') === String(cond.value);
    default: return false;
  }
}
function collectScope(start: Node, scope: TreeScopeName): Node[] {
  if (scope === 'children') return [...start.children];
  if (scope === 'element') return [start];
  const out: Node[] = scope === 'subtree' ? [start] : [];
  const visit = (x: Node) => { for (const c of x.children) { out.push(c); visit(c); } };
  visit(start);
  return out;
}
function toFound(n: Node): FoundElement { return { runtimeId: n.id, controlType: n.tag }; }
const ancestors = (n: Node): Node[] => { const o: Node[] = []; let c = n.parent; while (c) { o.push(c); c = c.parent; } return o; };
function siblings(n: Node, dir: 'following' | 'preceding'): Node[] {
  if (!n.parent) return [];
  const s = n.parent.children; const i = s.indexOf(n);
  return dir === 'following' ? s.slice(i + 1) : s.slice(0, i).reverse();
}

const backend = {
  async find(op: BackendOp): Promise<FoundElement[]> {
    if (op.op !== 'find') throw new Error('not find');
    const start = byId.get(op.startId); if (!start) return [];
    const m = collectScope(start, op.scope).filter((n) => matchCond(n, op.condition));
    return (op.multiple ? m : m.slice(0, 1)).map(toFound);
  },
  async walk(id: string, dir: string): Promise<FoundElement[]> {
    const n = byId.get(id); if (!n) return [];
    if (dir === 'parent') return n.parent ? [toFound(n.parent)] : [];
    if (dir === 'ancestors') return ancestors(n).map(toFound);
    if (dir === 'following-siblings') return siblings(n, 'following').map(toFound);
    if (dir === 'preceding-siblings') return siblings(n, 'preceding').map(toFound);
    return [];
  },
  async attributes(id: string, names: string[] | 'all'): Promise<Record<string, unknown>> {
    const n = byId.get(id); if (!n) return {};
    if (names === 'all') return { ...n.props };
    const out: Record<string, unknown> = {};
    for (const k of names) if (k in n.props) out[k] = n.props[k];
    return out;
  },
};

const ids = (xpath: string) => xpathToElementIds(xpath, true, undefined, backend);

// [expression, expected ids in document order] — cross-checked against the reference engine.
const CASES: Array<[string, string[]]> = [
  // ── axes ──
  ['//Button', ['ok', 'cancel', 'deep']],
  ['//List/ListItem', ['li_a', 'li_b', 'li_c']],
  ['//List//ListItem', ['li_a', 'li_b', 'li_c']],
  ['//Header/HeaderItem', ['h1', 'h2']],
  ['//Pane/Pane/Button', ['deep']],
  ['//Pane//Button', ['deep']],
  ['/Window/*', ['tb', 'list1', 'list2', 'p1', 'edit']],
  ['//Header/*', ['h1', 'h2']],
  ['//ListItem/..', ['list1', 'list2']],
  ['//ListItem/parent::List', ['list1', 'list2']],
  ['//HeaderItem/ancestor::List', ['list1']],
  ['//Button/ancestor::Window', ['root']], // the root Window is a real element with an id; ancestor:: reaches it
  ['//ListItem/following-sibling::ListItem', ['li_b']],
  ['//Header/following-sibling::ListItem', ['li_a', 'li_b']],
  ['//List/descendant-or-self::ListItem', ['li_a', 'li_b', 'li_c']],

  // ── attribute predicates ──
  ['//Button[@Name="OK"]', ['ok']],
  ['//Button[@Name!="OK"]', ['cancel', 'deep']],
  ['//*[@AutomationId]', ['ok', 'cancel', 'edit']],
  ['//*[not(@AutomationId)]', ['tb', 'list1', 'hdr', 'h1', 'h2', 'li_a', 'li_b', 'list2', 'li_c', 'p1', 'p2', 'deep']],
  ['//Button[@IsEnabled="true"]', ['ok']],
  ['//*[@Name="files"]', ['list1']],

  // ── node-set existence predicates (the class that regressed) ──
  ['//List[Header]', ['list1']],
  ['//List[./Header]', ['list1']],
  ['//List[.//HeaderItem]', ['list1']],
  ['//List[not(Header)]', ['list2']],
  ['//List[ListItem]', ['list1', 'list2']],
  ['//Pane[Pane]', ['p1']],
  ['//Pane[Button]', ['p2']],

  // ── nested predicates ──
  ['//List[Header/HeaderItem]', ['list1']],
  ['//List[Header[HeaderItem]]', ['list1']],
  ['//ToolBar[Button[@Name="OK"]]', ['tb']],
  ['//List[ListItem[@Name="b"]]', ['list1']],

  // ── positional ──
  ['//Button[1]', ['ok', 'deep']],         // per-parent: 1st Button of each parent
  ['//Button[2]', ['cancel']],
  ['//Button[last()]', ['cancel', 'deep']],
  ['(//Button)[1]', ['ok']],               // grouped: global index
  ['(//Button)[2]', ['cancel']],
  ['(//Button)[last()]', ['deep']],
  ['//List[1]', ['list1']],
  ['//HeaderItem[position()=2]', ['h2']],
  ['//ListItem[position()<2]', ['li_a', 'li_c']],
  ['//List/ListItem[1]', ['li_a', 'li_c']],
  ['//List/ListItem[last()]', ['li_b', 'li_c']],

  // ── functions in predicates ──
  ['//Button[contains(@Name,"anc")]', ['cancel']],
  ['//*[starts-with(@Name,"col")]', ['h1', 'h2']],
  ['//List[count(ListItem)=2]', ['list1']],
  ['//List[count(ListItem)>1]', ['list1']],
  ['//*[string-length(@AutomationId)=2]', ['ok']],
  ['//*[normalize-space(@Name)="OK"]', ['ok']],
  ['//*[name()="Button"]', ['ok', 'cancel', 'deep']],
  ['//*[local-name()="List"]', ['list1', 'list2']],

  // ── boolean combinations ──
  ['//Button[@Name="OK" or @Name="Cancel"]', ['ok', 'cancel']],
  ['//Button[@IsEnabled="true" and @Name="OK"]', ['ok']],
  ['//*[@Name="OK" or @Name="deep"]', ['ok', 'deep']],

  // ── unions ──
  ['//Button | //Edit', ['ok', 'cancel', 'deep', 'edit']],
  ['//Header | //ListItem', ['hdr', 'li_a', 'li_b', 'li_c']],

  // ── mixed ──
  ['//List[Header]/ListItem', ['li_a', 'li_b']],
  ['//ToolBar/Button[@IsEnabled="false"]', ['cancel']],
  ['//Pane[Pane/Button]', ['p1']],
  ['//*[.//Button]', ['tb', 'p1', 'p2']],
];

// Compound predicates: AND/OR of node-set sub-expressions, `../` navigation inside a predicate, and
// MULTIPLE chained predicates including a trailing positional (e.g. `[...][last()]`). These exercise
// the interplay of structural filtering and per-context positions.
const COMPOUND: Array<[string, string[]]> = [
  ['//ListItem[../Header]', ['li_a', 'li_b']],                              // parent has a Header sibling
  ['//ListItem[../Header][last()]', ['li_b']],                             // ...then last per parent
  ['//ListItem[../Header and not(@Name="a")]', ['li_b']],                  // node-set AND not(attr)
  ['//List[Header and not(ListItem[@Name="z"])]', ['list1']],             // node-set AND not(nested)
  ['//List[Header or ListItem][last()]', ['list2']],                       // OR predicate then positional
  ['//*[./../* and not(self::Window)]', ['tb', 'ok', 'cancel', 'list1', 'hdr', 'h1', 'h2', 'li_a', 'li_b', 'list2', 'li_c', 'p1', 'p2', 'deep', 'edit']],
  ['//HeaderItem[../../ListItem]', ['h1', 'h2']],                          // grandparent has ListItem
  ['//Button[../Button and @IsEnabled="true"]', ['ok']],                  // sibling Button AND enabled
  ['//List[count(ListItem)>=1][last()]', ['list2']],                       // count predicate then last
  ['//ListItem[@Name][position()=last()]', ['li_b', 'li_c']],             // attr predicate then position
  ['//Pane[.//Button][1]', ['p1', 'p2']],                                  // descendant predicate then [1] per parent
  ['//*[not(@AutomationId) and ListItem]', ['list1', 'list2']],           // not(attr) AND node-set
  ['//List[.//HeaderItem and not(.//Button)]', ['list1']],                // two descendant node-sets
  ['//ListItem[preceding-sibling::Header][last()]', ['li_b']],            // reverse-axis predicate then last
  ['//Button[last()][@Name="deep"]', ['deep']],                           // positional then attr predicate
  ['//*[self::List or self::Header][.//HeaderItem]', ['list1', 'hdr']],   // self-axis OR then node-set
];

describe('xpath condition coverage (vs reference XPath 1.0)', () => {
  for (const [expr, expected] of CASES) {
    it(`${expr} => ${JSON.stringify(expected)}`, async () => {
      expect(await ids(expr)).to.deep.equal(expected);
    });
  }
});

describe('xpath compound predicates (vs reference XPath 1.0)', () => {
  for (const [expr, expected] of COMPOUND) {
    it(`${expr} => ${JSON.stringify(expected)}`, async () => {
      expect(await ids(expr)).to.deep.equal(expected);
    });
  }
});

// Document order: reverse axes (ancestor, ancestor-or-self, preceding, preceding-sibling, following)
// are walked in proximity order, and a union concatenates its branches — both can leave the result
// out of document order. The engine re-sorts the final node-set (and unions at production time) so the
// XPath 1.0 contract holds: a location path yields a document-ordered node-set, and findElement
// returns the document-first match.
describe('xpath document order', () => {
  const ORDER_CASES: Array<[string, string[]]> = [
    ['//HeaderItem/ancestor-or-self::*', ['root', 'list1', 'hdr', 'h1', 'h2']],
    ['//HeaderItem/ancestor::*', ['root', 'list1', 'hdr']],
    ['//Edit/preceding::Button', ['ok', 'cancel', 'deep']],
    ['//Edit | //ToolBar', ['tb', 'edit']],
    ['//ToolBar | //Edit', ['tb', 'edit']],          // branch order must not affect result order
    ['(//Edit | //ToolBar)[1]', ['tb']],             // positional over a union indexes document order
    ['//ListItem/preceding-sibling::*', ['hdr', 'li_a']],
  ];
  for (const [expr, expected] of ORDER_CASES) {
    it(`${expr} => ${JSON.stringify(expected)}`, async () => {
      expect(await ids(expr)).to.deep.equal(expected);
    });
  }
});
