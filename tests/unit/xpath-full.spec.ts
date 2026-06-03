import { expect } from 'chai';
import {
  xpathToElementIds,
  InvalidSelectorError,
  type XPathBackend,
  type FoundElement,
} from '../../lib/xpath/core';
import type { BackendOp, Condition, TreeScopeName } from '../../lib/backend/ops';

/**
 * In-memory UIA-like tree fixture (a Notepad-ish hierarchy) and a fake XPathBackend implementing
 * find / walk / attributes over it. This lets the full XPath engine be exercised end-to-end on
 * macOS with no sidecar.
 */

interface Node {
  id: string;
  controlType: string;
  props: Record<string, unknown>;
  children: Node[];
  parent?: Node;
}

function n(
  id: string,
  controlType: string,
  props: Record<string, unknown>,
  children: Node[] = [],
): Node {
  const node: Node = { id, controlType, props: { ...props, ControlType: controlType }, children };
  for (const c of children) c.parent = node;
  return node;
}

/**
 * root
 *  └─ Window#win (Name="Untitled - Notepad", ProcessId=4321, IsEnabled=true, IsOffscreen=false)
 *      ├─ MenuBar#menu
 *      │    ├─ MenuItem#mi-file (Name="File")
 *      │    └─ MenuItem#mi-edit (Name="Edit")
 *      ├─ Edit#editor (Name="Text Editor", AutomationId="15", ClassName="RichEditD2DPT", IsEnabled=true)
 *      ├─ Pane#statusbar
 *      │    ├─ Text#t-ln  (Name="Ln 1, Col 1")
 *      │    └─ Text#t-zoom(Name="100%")
 *      └─ List#list  (List)
 *           ├─ ListItem#li1 (Name="Alpha")
 *           ├─ ListItem#li2 (Name="Beta")
 *           └─ DataItem#di3 (Name="Gamma")
 */
const win = n(
  'win',
  'Window',
  { Name: 'Untitled - Notepad', ProcessId: 4321, IsEnabled: true, IsOffscreen: false },
  [
    n('menu', 'MenuBar', { Name: '' }, [
      n('mi-file', 'MenuItem', { Name: 'File' }),
      n('mi-edit', 'MenuItem', { Name: 'Edit' }),
    ]),
    n('editor', 'Edit', {
      Name: 'Text Editor',
      AutomationId: '15',
      ClassName: 'RichEditD2DPT',
      IsEnabled: true,
    }),
    n('statusbar', 'Pane', { Name: '' }, [
      n('t-ln', 'Text', { Name: 'Ln 1, Col 1' }),
      n('t-zoom', 'Text', { Name: '100%' }),
    ]),
    n('list', 'List', { Name: '' }, [
      n('li1', 'ListItem', { Name: 'Alpha' }),
      n('li2', 'ListItem', { Name: 'Beta' }),
      n('di3', 'DataItem', { Name: 'Gamma' }),
    ]),
  ],
);
const ROOT = n('root', 'Pane', { Name: 'Desktop' }, [win]);

const byId = new Map<string, Node>();
(function index(node: Node) {
  byId.set(node.id, node);
  node.children.forEach(index);
})(ROOT);

// --- condition matching over the fixture -----------------------------------

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
    case 'property': {
      const actual = node.props[cond.prop];
      if (typeof cond.value === 'boolean') return Boolean(actual) === cond.value;
      return String(actual ?? '') === String(cond.value);
    }
    default:
      return false;
  }
}

function collectScope(start: Node, scope: TreeScopeName): Node[] {
  switch (scope) {
    case 'element':
      return [start];
    case 'children':
      return [...start.children];
    case 'descendants': {
      const out: Node[] = [];
      const visit = (x: Node) => {
        for (const c of x.children) {
          out.push(c);
          visit(c);
        }
      };
      visit(start);
      return out;
    }
    case 'subtree': {
      const out: Node[] = [start];
      const visit = (x: Node) => {
        for (const c of x.children) {
          out.push(c);
          visit(c);
        }
      };
      visit(start);
      return out;
    }
    default:
      return [];
  }
}

function toFound(node: Node): FoundElement {
  return {
    runtimeId: node.id,
    name: node.props.Name === undefined ? undefined : String(node.props.Name),
    automationId: node.props.AutomationId === undefined ? undefined : String(node.props.AutomationId),
    className: node.props.ClassName === undefined ? undefined : String(node.props.ClassName),
    controlType: node.controlType,
  };
}

function makeBackend(): { backend: XPathBackend; finds: Extract<BackendOp, { op: 'find' }>[] } {
  const finds: Extract<BackendOp, { op: 'find' }>[] = [];
  const backend: XPathBackend = {
    async find(op: BackendOp): Promise<FoundElement[]> {
      if (op.op !== 'find') throw new Error('not a find op');
      finds.push(op);
      const start = byId.get(op.startId === 'root' ? 'root' : op.startId);
      if (!start) return [];
      const matched = collectScope(start, op.scope).filter((nd) => matchCond(nd, op.condition));
      const limited = op.multiple ? matched : matched.slice(0, 1);
      return limited.map(toFound);
    },
    async walk(id, direction): Promise<FoundElement[]> {
      const node = byId.get(id);
      if (!node) return [];
      switch (direction) {
        case 'parent':
          return node.parent ? [toFound(node.parent)] : [];
        case 'ancestors': {
          const out: FoundElement[] = [];
          let p = node.parent;
          while (p) {
            out.push(toFound(p));
            p = p.parent;
          }
          return out; // nearest-first
        }
        case 'following-siblings': {
          if (!node.parent) return [];
          const sibs = node.parent.children;
          const idx = sibs.indexOf(node);
          return sibs.slice(idx + 1).map(toFound);
        }
        case 'preceding-siblings': {
          if (!node.parent) return [];
          const sibs = node.parent.children;
          const idx = sibs.indexOf(node);
          // document order
          return sibs.slice(0, idx).map(toFound);
        }
        default:
          return [];
      }
    },
    async attributes(id, names): Promise<Record<string, unknown>> {
      const node = byId.get(id);
      if (!node) return {};
      if (names === 'all') return { ...node.props };
      const out: Record<string, unknown> = {};
      for (const name of names) out[name] = node.props[name];
      return out;
    },
  };
  return { backend, finds };
}

async function ids(xpath: string, multiple = true, ctx?: string): Promise<string[]> {
  const { backend } = makeBackend();
  return xpathToElementIds(xpath, multiple, ctx, backend);
}

async function expectInvalid(xpath: string): Promise<void> {
  const { backend } = makeBackend();
  let threw: unknown;
  try {
    await xpathToElementIds(xpath, true, undefined, backend);
  } catch (e) {
    threw = e;
  }
  expect(threw, `expected InvalidSelectorError for ${xpath}`).to.be.instanceOf(InvalidSelectorError);
}

describe('xpath full engine (in-memory tree)', () => {
  // --- A. basic paths ------------------------------------------------------
  describe('basic paths', () => {
    it('//Window finds the window', async () => {
      expect(await ids('//Window')).to.deep.equal(['win']);
    });
    it('//* finds every element under root', async () => {
      const all = await ids('//*');
      expect(all).to.include.members(['win', 'editor', 'list', 'li1', 'di3']);
      expect(all).to.not.include('root');
    });
    it('absolute child path /Pane/Window', async () => {
      // root is a Pane (the sidecar root sentinel); window is its only child.
      expect(await ids('/Pane/Window')).to.deep.equal(['win']);
    });
    it('relative path from context (ListItem alias also matches DataItem)', async () => {
      expect(await ids('ListItem', true, 'list')).to.deep.equal(['li1', 'li2', 'di3']);
    });
    it('union dedupes', async () => {
      const r = await ids('//Edit | //Window');
      expect(r).to.deep.equal(['editor', 'win']);
    });
    it('no match returns empty', async () => {
      expect(await ids('//Button[@Name="nope"]')).to.deep.equal([]);
    });
  });

  // --- B. axes -------------------------------------------------------------
  describe('axes', () => {
    it('child:: via /', async () => {
      expect(await ids('//Window/child::Edit')).to.deep.equal(['editor']);
    });
    it('descendant::', async () => {
      expect(await ids('//Window/descendant::Text')).to.deep.equal(['t-ln', 't-zoom']);
    });
    it('descendant-or-self::', async () => {
      expect(await ids('//List/descendant-or-self::*')).to.deep.equal(['list', 'li1', 'li2', 'di3']);
    });
    it('self::', async () => {
      expect(await ids('//Window/self::Window')).to.deep.equal(['win']);
      expect(await ids('//Window/self::Edit')).to.deep.equal([]);
    });
    it('parent::', async () => {
      expect(await ids('//Edit/parent::Window')).to.deep.equal(['win']);
    });
    it('ancestor::', async () => {
      expect(await ids('//ListItem[@Name="Alpha"]/ancestor::Window')).to.deep.equal(['win']);
      // nearest-first ordering of ancestor::*
      expect(await ids('//ListItem[@Name="Alpha"]/ancestor::*')).to.deep.equal([
        'list',
        'win',
        'root',
      ]);
    });
    it('ancestor-or-self::', async () => {
      const r = await ids('//List/ancestor-or-self::*');
      expect(r).to.include.members(['list', 'win']);
      expect(r[0]).to.equal('list');
    });
    it('following-sibling::', async () => {
      // editor's following siblings under window: statusbar, list
      expect(await ids('//Edit/following-sibling::*')).to.deep.equal(['statusbar', 'list']);
    });
    it('preceding-sibling::', async () => {
      expect(await ids('//List/preceding-sibling::*')).to.deep.equal(['menu', 'editor', 'statusbar']);
    });
    it('following::', async () => {
      const r = await ids('//Edit/following::*');
      // everything after editor in doc order, excluding its descendants: statusbar subtree, list subtree
      expect(r).to.include.members(['statusbar', 't-ln', 't-zoom', 'list', 'li1', 'di3']);
      expect(r).to.not.include('editor');
      expect(r).to.not.include('menu');
    });
    it('preceding::', async () => {
      const r = await ids('//List/preceding::*');
      expect(r).to.include.members(['menu', 'mi-file', 'editor', 'statusbar', 't-ln']);
      expect(r).to.not.include('win'); // ancestor excluded
      expect(r).to.not.include('list');
    });
    it('attribute predicate //*[@AutomationId]', async () => {
      expect(await ids('//*[@AutomationId]')).to.deep.equal(['editor']);
    });
  });

  // --- C. node tests -------------------------------------------------------
  describe('node tests', () => {
    it('node() matches elements', async () => {
      expect(await ids('//Window/node()')).to.deep.equal(['menu', 'editor', 'statusbar', 'list']);
    });
    it('text() matches nothing (empty, not error)', async () => {
      expect(await ids('//text()')).to.deep.equal([]);
    });
    it('comment() matches nothing', async () => {
      expect(await ids('//comment()')).to.deep.equal([]);
    });
  });

  // --- D. attribute predicates --------------------------------------------
  describe('attribute predicates', () => {
    it('equality', async () => {
      expect(await ids('//*[@Name="Alpha"]')).to.deep.equal(['li1']);
    });
    it('inequality', async () => {
      expect(await ids('//ListItem[@Name!="Alpha"]')).to.deep.equal(['li2', 'di3']);
    });
    it('boolean True literal', async () => {
      const r = await ids('//*[@IsEnabled="True"]');
      expect(r).to.include.members(['win', 'editor']);
    });
    it('boolean False literal matches the window', async () => {
      // Only `win` has IsOffscreen set in the fixture; sparse-prop nodes also coerce to false,
      // so just assert the window is present.
      expect(await ids('//*[@IsOffscreen="False"]')).to.include('win');
    });
    it('and', async () => {
      expect(await ids('//Edit[@AutomationId="15" and @ClassName="RichEditD2DPT"]')).to.deep.equal([
        'editor',
      ]);
    });
    it('or', async () => {
      const r = await ids('//*[@Name="Alpha" or @Name="Beta"]');
      expect(r).to.deep.equal(['li1', 'li2']);
    });
    it('wildcard attribute @*="Alpha"', async () => {
      expect(await ids('//*[@*="Alpha"]')).to.deep.equal(['li1']);
    });
    it('wildcard attribute @* matches ProcessId number', async () => {
      expect(await ids('//*[@*="4321"]')).to.deep.equal(['win']);
    });
  });

  // --- E. operators --------------------------------------------------------
  describe('operators', () => {
    it('not()', async () => {
      const r = await ids('//ListItem[not(@Name="Alpha")]');
      expect(r).to.deep.equal(['li2', 'di3']);
    });
    it('numeric > ', async () => {
      expect(await ids('//*[@ProcessId > 0]')).to.deep.equal(['win']);
    });
    it('numeric < via string-length', async () => {
      const r = await ids('//*[string-length(@Name) < 1000]');
      expect(r.length).to.be.greaterThan(0);
    });
    it('numeric >= and <=', async () => {
      expect(await ids('//*[@ProcessId >= 4321]')).to.deep.equal(['win']);
      expect(await ids('//*[@ProcessId <= 4321]')).to.deep.equal(['win']);
    });
    it('arithmetic + in predicate', async () => {
      expect(await ids('//*[@ProcessId = 4320 + 1]')).to.deep.equal(['win']);
    });
    it('mod / div', async () => {
      expect(await ids('//*[@ProcessId mod 2 = 1]')).to.deep.equal(['win']);
      expect(await ids('//*[@ProcessId div 4321 = 1]')).to.deep.equal(['win']);
    });
  });

  // --- F. position ---------------------------------------------------------
  describe('position & indexing', () => {
    it('//ListItem[1] is per-parent positional', async () => {
      expect(await ids('//ListItem[1]')).to.deep.equal(['li1']);
    });
    it('(//ListItem)[1] is grouped positional', async () => {
      expect(await ids('(//ListItem)[1]')).to.deep.equal(['li1']);
    });
    it('distinction: //Text[1] per-parent vs (//Text)[1]', async () => {
      // Both status-bar texts share one parent, so [1] yields the first only.
      expect(await ids('//Text[1]')).to.deep.equal(['t-ln']);
      expect(await ids('(//Text)[1]')).to.deep.equal(['t-ln']);
    });
    it('per-parent positional really is per-parent', async () => {
      // menu's first MenuItem and ... there's only one List parent, so craft a multi-parent case:
      // first child Text of statusbar; first ListItem of list — //*/Text[1] would pick per parent.
      const r = await ids('//*/*[1]');
      // first child of each parent that has children: win(menu), menu(mi-file), statusbar(t-ln),
      // list(li1), root(win)
      expect(r).to.include.members(['menu', 'mi-file', 't-ln', 'li1']);
    });
    it('[last()]', async () => {
      // per-parent: all three list items share parent `list`, so last() is di3.
      expect(await ids('//ListItem[last()]')).to.deep.equal(['di3']);
      expect(await ids('(//Text)[last()]')).to.deep.equal(['t-zoom']);
    });
    it('[position()=2]', async () => {
      expect(await ids('(//ListItem)[position()=2]')).to.deep.equal(['li2']);
    });
    it('[position()>1]', async () => {
      expect(await ids('(//Text)[position()>1]')).to.deep.equal(['t-zoom']);
    });
  });

  // --- G. core functions ---------------------------------------------------
  describe('core functions', () => {
    it('contains()', async () => {
      expect(await ids("//*[contains(@Name, 'Editor')]")).to.deep.equal(['editor']);
    });
    it('starts-with()', async () => {
      expect(await ids("//*[starts-with(@Name, 'Ln')]")).to.deep.equal(['t-ln']);
    });
    it('starts-with() empty needle matches all (XPath 1.0)', async () => {
      const r = await ids("//ListItem[starts-with(@Name, '')]");
      expect(r).to.deep.equal(['li1', 'li2', 'di3']);
    });
    it('string()', async () => {
      expect(await ids("//ListItem[string(@Name)!='']")).to.deep.equal(['li1', 'li2', 'di3']);
    });
    it('concat()', async () => {
      expect(await ids("//ListItem[concat(@Name,'!')='Alpha!']")).to.deep.equal(['li1']);
    });
    it('substring()', async () => {
      expect(await ids("//ListItem[substring(@Name,1,2)='Al']")).to.deep.equal(['li1']);
    });
    it('substring-before()', async () => {
      expect(await ids("//Text[substring-before(@Name,',')='Ln 1']")).to.deep.equal(['t-ln']);
    });
    it('substring-after()', async () => {
      expect(await ids("//Text[substring-after(@Name,', ')='Col 1']")).to.deep.equal(['t-ln']);
    });
    it('string-length()', async () => {
      // Alpha (5) and Gamma (5) match; Beta (4) does not.
      expect(await ids('//ListItem[string-length(@Name) = 5]')).to.deep.equal(['li1', 'di3']);
    });
    it('normalize-space()', async () => {
      expect(await ids("//ListItem[normalize-space(@Name)='Alpha']")).to.deep.equal(['li1']);
    });
    it('translate()', async () => {
      // translate Alpha A->a etc, compare lowercased
      expect(await ids("//ListItem[translate(@Name,'ABG','abg')='alpha']")).to.deep.equal(['li1']);
    });
    it('count(@*) > 0', async () => {
      const r = await ids('//*[count(@*) > 0]');
      expect(r.length).to.be.greaterThan(0);
    });
    it('count of children node-set', async () => {
      // list has 3 ListItem/DataItem children (ListItem alias includes DataItem).
      expect(await ids('//*[count(ListItem) = 3]')).to.deep.equal(['list']);
    });
    it('last() in predicate', async () => {
      expect((await ids('//*[last() > 0]')).length).to.be.greaterThan(0);
    });
    it('position() in predicate', async () => {
      expect((await ids('//*[position() >= 1]')).length).to.be.greaterThan(0);
    });
    it('name() / local-name()', async () => {
      expect(await ids("//*[name()='Edit']")).to.deep.equal(['editor']);
      expect(await ids("//*[local-name()='Window']")).to.deep.equal(['win']);
    });
    it('boolean()', async () => {
      expect((await ids('//ListItem[boolean(@Name)]')).length).to.equal(3);
    });
    it('not()/true()/false()', async () => {
      expect((await ids('//ListItem[true()]')).length).to.equal(3);
      expect(await ids('//ListItem[false()]')).to.deep.equal([]);
      expect((await ids("//ListItem[not(@Name='Alpha')]")).length).to.equal(2);
    });
    it('number()/floor()/ceiling()/round()', async () => {
      expect(await ids('//*[number(@ProcessId) > 0]')).to.deep.equal(['win']);
      expect(await ids('//*[floor(@ProcessId) = 4321]')).to.deep.equal(['win']);
      expect(await ids('//*[ceiling(@ProcessId) = 4321]')).to.deep.equal(['win']);
      expect(await ids('//*[round(@ProcessId) = 4321]')).to.deep.equal(['win']);
    });
    it('sum() over node-set', async () => {
      expect(await ids('//*[sum(@ProcessId) > 0]')).to.deep.equal(['win']);
    });
  });

  // --- H. aliases ----------------------------------------------------------
  describe('tag-name aliases & case', () => {
    it('lowercase //window', async () => {
      expect(await ids('//window')).to.deep.equal(['win']);
    });
    it('lowercase //edit', async () => {
      expect(await ids('//edit')).to.deep.equal(['editor']);
    });
    it('//list -> List|DataGrid', async () => {
      expect(await ids('//list')).to.deep.equal(['list']);
    });
    it('//listitem -> ListItem|DataItem', async () => {
      expect(await ids('//listitem')).to.deep.equal(['li1', 'li2', 'di3']);
    });
    it('ListItem name test also matches DataItem grouping', async () => {
      expect(await ids('//ListItem')).to.deep.equal(['li1', 'li2', 'di3']);
    });
  });

  // --- I. findFirst optimization ------------------------------------------
  describe('findFirst optimization', () => {
    it('single-element query emits multiple:false on the leaf find', async () => {
      const { backend, finds } = makeBackend();
      const r = await xpathToElementIds('//Edit', false, undefined, backend);
      expect(r).to.deep.equal(['editor']);
      expect(finds[finds.length - 1].multiple).to.equal(false);
    });
    it('multiple query emits multiple:true', async () => {
      const { backend, finds } = makeBackend();
      await xpathToElementIds('//ListItem', true, undefined, backend);
      expect(finds.every((f) => f.multiple)).to.equal(true);
    });
    it('positional query does not findFirst', async () => {
      const { backend, finds } = makeBackend();
      await xpathToElementIds('//ListItem[1]', false, undefined, backend);
      expect(finds[finds.length - 1].multiple).to.equal(true);
    });
  });

  // --- J. errors -----------------------------------------------------------
  describe('error behavior', () => {
    it('malformed XPath -> InvalidSelectorError', async () => {
      await expectInvalid('//Button[@Name=');
    });
    it('unclosed predicate -> InvalidSelectorError', async () => {
      await expectInvalid('//Button[1');
    });
    it('garbage -> InvalidSelectorError', async () => {
      await expectInvalid('//[[[');
    });
    it('unknown function (ends-with) -> InvalidSelectorError', async () => {
      await expectInvalid("//*[ends-with(@Name,'x')]");
    });
    it('terminal attribute locator -> InvalidSelectorError', async () => {
      await expectInvalid('//Edit/@Name');
    });
    it('id() unsupported -> InvalidSelectorError', async () => {
      await expectInvalid("//*[id('x')]");
    });
  });

  // --- K. context-relative -------------------------------------------------
  describe('context-relative search', () => {
    it('relative ./* from a context element', async () => {
      expect(await ids('./*', true, 'list')).to.deep.equal(['li1', 'li2', 'di3']);
    });
    it('absolute path ignores the context element', async () => {
      expect(await ids('//Window', true, 'editor')).to.deep.equal(['win']);
    });
  });
});
