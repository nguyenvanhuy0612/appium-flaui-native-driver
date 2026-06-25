import { expect } from 'chai';
import * as xpathRef from 'xpath';
import { DOMParser } from '@xmldom/xmldom';
import { xpathToElementIds, AUTOMATION_ROOT_ID, type FoundElement } from '../../lib/xpath/core';
import type { BackendOp, Condition, TreeScopeName } from '../../lib/backend/ops';

/**
 * Differential conformance: every expression is evaluated by BOTH the repo engine and a reference
 * XPath 1.0 engine (`xpath` npm) over the IDENTICAL tree, and the (document-ordered) results must
 * match exactly. This is the safety net that catches the whole class of semantic divergences — the
 * kind that unit tests asserting "this op compiles to that condition" miss. Add an expression here and
 * the reference computes the expected answer for free; any future engine regression fails loudly.
 *
 * Modeling note: the repo engine treats the session root (the Window) as the automation root — a real
 * element analogous to the reference's document ELEMENT, whereas the reference also exposes a document
 * NODE above it. `//*`, `/Window`, and ancestor axes self-include differently by that model, so the
 * root id is dropped from BOTH sides before comparing.
 *
 * Tags = ControlTypes; no text nodes (UIA has none), so element string-value is '' on both engines.
 */
interface Spec { id: string; tag: string; attrs?: Record<string, string>; children?: Spec[] }
interface Node { id: string; tag: string; props: Record<string, string>; children: Node[]; parent?: Node }

const TREE: Spec = {
  id: AUTOMATION_ROOT_ID, tag: 'Window', attrs: { Name: 'root' }, children: [
    { id: 'tb', tag: 'ToolBar', attrs: { Name: 'main' }, children: [
      { id: 'ok', tag: 'Button', attrs: { Name: 'OK', AutomationId: 'ok', IsEnabled: 'true' } },
      { id: 'cancel', tag: 'Button', attrs: { Name: 'Cancel', AutomationId: 'cancel', IsEnabled: 'false' } },
      { id: 'split', tag: 'SplitButton', attrs: { Name: 'More' } },
    ]},
    { id: 'list1', tag: 'List', attrs: { Name: 'files' }, children: [
      { id: 'hdr', tag: 'Header', children: [
        { id: 'h1', tag: 'HeaderItem', attrs: { Name: 'col1' } },
        { id: 'h2', tag: 'HeaderItem', attrs: { Name: 'col2' } },
      ]},
      { id: 'li_a', tag: 'ListItem', attrs: { Name: 'a', AutomationId: 'r0' } },
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

// --- reference engine over XML (rid carries identity) ---
function toXml(n: Node): string {
  const attrs = Object.entries(n.props)
    .filter(([k]) => k !== 'ControlType')
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  const head = `<${n.tag} rid="${n.id}"${attrs ? ' ' + attrs : ''}`;
  return n.children.length === 0 ? `${head}/>` : `${head}>${n.children.map(toXml).join('')}</${n.tag}>`;
}
const doc = new DOMParser().parseFromString(toXml(ROOT), 'text/xml');
function refIds(expr: string): string[] {
  const r = xpathRef.select(expr, doc as unknown as Node) as unknown[];
  return (Array.isArray(r) ? r : [r])
    .filter(Boolean)
    .map((n) => (n as { getAttribute?: (k: string) => string }).getAttribute?.('rid') ?? String(n))
    .filter((x) => x !== AUTOMATION_ROOT_ID);
}

// --- repo engine over the equivalent tree-fake backend ---
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
async function engineIds(expr: string): Promise<string[]> {
  return (await xpathToElementIds(expr, true, undefined, backend)).filter((x) => x !== AUTOMATION_ROOT_ID);
}

const CORPUS: string[] = [
  // axes
  '//Button', '/Window/ToolBar', '//List/ListItem', '//List//ListItem', '//Header/HeaderItem',
  '//Pane/Pane/Button', '//Pane//Button', '/Window/*', '//Header/*', '//*',
  '//ListItem/..', '//ListItem/parent::List', '//HeaderItem/ancestor::List', '//HeaderItem/ancestor::*',
  '//Button/ancestor::Window', '//HeaderItem/ancestor-or-self::*', '//List/self::List',
  '//List/descendant-or-self::ListItem', '//ListItem/following-sibling::ListItem',
  '//ListItem/preceding-sibling::*', '//Header/following-sibling::ListItem',
  '//Edit/preceding::Button', '//Edit/preceding::*',
  '//ListItem[@Name="a"]/following::ListItem', '//HeaderItem[@Name="col1"]/following::ListItem',
  // NOTE: `following::` is exercised only from childless contexts (li_a, h1). The reference `xpath` lib
  // mis-evaluates `following::` when the context node HAS children (e.g. `//ToolBar/following::*`
  // wrongly returns a child of ToolBar) — the repo engine is correct there, so such cases are omitted
  // to avoid asserting against a buggy oracle.
  // node tests
  '//List/node()', '//*[1]',
  // attribute predicates
  '//Button[@Name="OK"]', '//Button[@Name!="OK"]', '//*[@AutomationId]', '//*[not(@AutomationId)]',
  '//Button[@IsEnabled="true"]', '//*[@Name="files"]', '//ListItem[@AutomationId="r0"]',
  // node-set existence predicates
  '//List[Header]', '//List[./Header]', '//List[.//HeaderItem]', '//List[not(Header)]',
  '//List[ListItem]', '//Pane[Pane]', '//Pane[Button]', '//*[Button]', '//*[.//Button]',
  // nested predicates
  '//List[Header/HeaderItem]', '//List[Header[HeaderItem]]', '//*[List[Header]]',
  '//ToolBar[Button[@Name="OK"]]', '//List[ListItem[@Name="b"]]',
  // positional
  '//Button[1]', '//Button[2]', '//Button[last()]', '(//Button)[1]', '(//Button)[2]', '(//Button)[last()]',
  '//List[1]', '//List[2]', '//HeaderItem[position()=2]', '//ListItem[position()<2]',
  '//ListItem[position()>1]', '//List/ListItem[1]', '//List/ListItem[last()]',
  // functions
  '//Button[contains(@Name,"anc")]', '//*[starts-with(@Name,"col")]', '//List[count(ListItem)=2]',
  '//List[count(ListItem)>1]', '//*[count(Button)=1]', '//*[string-length(@AutomationId)=2]',
  '//*[normalize-space(@Name)="OK"]', '//*[name()="Button"]', '//*[local-name()="List"]',
  // boolean combinations
  '//Button[@Name="OK" or @Name="Cancel"]', '//Button[@IsEnabled="true" and @Name="OK"]',
  '//*[@Name="OK" or @Name="deep"]', '//List[Header or not(Header)]',
  // unions (order must be document order regardless of branch order)
  '//Button | //Edit', '//Edit | //Button', '//Header | //ListItem', '//Edit | //ToolBar',
  '//ToolBar | //Edit', '(//Edit | //ToolBar)[1]', '(//Button | //ListItem)[last()]',
  // compound predicates + trailing positional
  '//ListItem[../Header]', '//ListItem[../Header][last()]', '//ListItem[../Header and not(@Name="a")]',
  '//List[Header and not(ListItem[@Name="z"])]', '//List[Header or ListItem][last()]',
  '//*[./../* and not(self::Window)]', '//HeaderItem[../../ListItem]',
  '//Button[../Button and @IsEnabled="true"]', '//List[count(ListItem)>=1][last()]',
  '//ListItem[@Name][position()=last()]', '//Pane[.//Button][1]', '//*[not(@AutomationId) and ListItem]',
  '//List[.//HeaderItem and not(.//Button)]', '//ListItem[preceding-sibling::Header][last()]',
  '//Button[last()][@Name="deep"]', '//*[self::List or self::Header][.//HeaderItem]',
  // mixed
  '//List[Header]/ListItem', '//ToolBar/Button[@IsEnabled="false"]', '//Pane[Pane/Button]',
];

describe('xpath differential conformance (repo engine vs reference XPath 1.0)', () => {
  for (const expr of CORPUS) {
    it(`${expr}`, async () => {
      const ref = refIds(expr);
      const mine = await engineIds(expr);
      expect(mine, `engine result for ${expr}`).to.deep.equal(ref);
    });
  }
});
