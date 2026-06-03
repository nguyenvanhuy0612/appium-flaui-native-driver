import { expect } from 'chai';
import {
  xpathToElementIds,
  InvalidSelectorError,
  AUTOMATION_ROOT_ID,
  type FoundElement,
} from '../../lib/xpath/core';
import type { BackendOp } from '../../lib/backend/ops';

/**
 * A recording fake for `findViaBackend`. Records every op it receives and returns canned
 * element ids per call. The `responder` maps each find op to the ids it should resolve to.
 */
function makeFake(responder: (op: BackendOp, callIndex: number) => string[]) {
  const ops: Extract<BackendOp, { op: 'find' }>[] = [];
  const find = async (op: BackendOp): Promise<FoundElement[]> => {
    if (op.op !== 'find') {
      throw new Error(`expected find op, got ${op.op}`);
    }
    const ids = responder(op, ops.length);
    ops.push(op);
    return ids.map((runtimeId) => ({ runtimeId }));
  };
  return { ops, find };
}

describe('xpath engine', () => {
  it('//Button[@Name="OK"] => single descendant find with And(ControlType, Name)', async () => {
    const { ops, find } = makeFake(() => ['7.1']);
    const result = await xpathToElementIds('//Button[@Name="OK"]', true, undefined, find);

    expect(result).to.deep.equal(['7.1']);
    expect(ops).to.have.length(1);
    expect(ops[0]).to.deep.equal({
      op: 'find',
      startId: AUTOMATION_ROOT_ID,
      multiple: true,
      scope: 'descendants',
      condition: {
        kind: 'and',
        children: [
          { kind: 'property', prop: 'ControlType', value: 'Button' },
          { kind: 'property', prop: 'Name', value: 'OK' },
        ],
      },
    });
  });

  it('uses findFirst (multiple:false) for a single-element leaf query', async () => {
    const { ops, find } = makeFake(() => ['9.9']);
    const result = await xpathToElementIds('//Button[@Name="OK"]', false, undefined, find);

    expect(result).to.deep.equal(['9.9']);
    expect(ops).to.have.length(1);
    expect(ops[0].multiple).to.equal(false);
    expect(ops[0].scope).to.equal('descendants');
  });

  it('/Window/Edit => child find from root (+ child-or-self self check) then Edit', async () => {
    const { ops, find } = makeFake((op) => {
      // first step resolves the Window, second resolves the Edit
      if (op.condition.kind === 'property' && op.condition.value === 'Window') {
        return op.scope === 'element' ? [] : ['win.1'];
      }
      return ['edit.1'];
    });

    const result = await xpathToElementIds('/Window/Edit', true, undefined, find);

    expect(result).to.deep.equal(['edit.1']);
    // An absolute path's first child step is matched as child-or-self (nova2 parity), so the
    // engine also emits an element-scope self-check find on the root.
    const childFinds = ops.filter((o) => o.scope === 'children');
    expect(childFinds[0]).to.deep.equal({
      op: 'find',
      startId: AUTOMATION_ROOT_ID,
      multiple: true,
      scope: 'children',
      condition: { kind: 'property', prop: 'ControlType', value: 'Window' },
    });
    expect(ops.some((o) => o.scope === 'element' && o.startId === AUTOMATION_ROOT_ID)).to.equal(
      true,
    );
    expect(childFinds[childFinds.length - 1]).to.deep.equal({
      op: 'find',
      startId: 'win.1',
      multiple: true,
      scope: 'children',
      condition: { kind: 'property', prop: 'ControlType', value: 'Edit' },
    });
  });

  it('(//ListItem)[1] => find all ListItems then pick the first in TS', async () => {
    const { ops, find } = makeFake(() => ['li.1', 'li.2', 'li.3']);
    const result = await xpathToElementIds('(//ListItem)[1]', true, undefined, find);

    expect(result).to.deep.equal(['li.1']);
    expect(ops).to.have.length(1);
    // ListItem maps to (ListItem OR DataItem); positional [1] is applied in TS, not the backend.
    expect(ops[0]).to.deep.equal({
      op: 'find',
      startId: AUTOMATION_ROOT_ID,
      multiple: true,
      scope: 'descendants',
      condition: {
        kind: 'or',
        children: [
          { kind: 'property', prop: 'ControlType', value: 'ListItem' },
          { kind: 'property', prop: 'ControlType', value: 'DataItem' },
        ],
      },
    });
  });

  it('positional [last()] picks the final element', async () => {
    const { find } = makeFake(() => ['a', 'b', 'c']);
    const result = await xpathToElementIds('//Edit[last()]', true, undefined, find);
    expect(result).to.deep.equal(['c']);
  });

  it('bare positional //Edit[2] picks the second element', async () => {
    const { find } = makeFake(() => ['a', 'b', 'c']);
    const result = await xpathToElementIds('//Edit[2]', true, undefined, find);
    expect(result).to.deep.equal(['b']);
  });

  it('@AutomationId predicate maps to the AutomationId property', async () => {
    const { ops, find } = makeFake(() => ['id.1']);
    await xpathToElementIds("//Edit[@AutomationId='userField']", true, undefined, find);
    expect(ops[0].condition).to.deep.equal({
      kind: 'and',
      children: [
        { kind: 'property', prop: 'ControlType', value: 'Edit' },
        { kind: 'property', prop: 'AutomationId', value: 'userField' },
      ],
    });
  });

  it('and-of-attributes builds a nested And condition', async () => {
    const { ops, find } = makeFake(() => ['x']);
    await xpathToElementIds('//Edit[@AutomationId="x" and @ClassName="y"]', true, undefined, find);
    expect(ops[0].condition).to.deep.equal({
      kind: 'and',
      children: [
        { kind: 'property', prop: 'ControlType', value: 'Edit' },
        {
          kind: 'and',
          children: [
            { kind: 'property', prop: 'AutomationId', value: 'x' },
            { kind: 'property', prop: 'ClassName', value: 'y' },
          ],
        },
      ],
    });
  });

  it('inequality predicate builds a Not(property) condition', async () => {
    const { ops, find } = makeFake(() => ['x']);
    await xpathToElementIds('//Edit[@Name!="skip"]', true, undefined, find);
    expect(ops[0].condition).to.deep.equal({
      kind: 'and',
      children: [
        { kind: 'property', prop: 'ControlType', value: 'Edit' },
        { kind: 'not', child: { kind: 'property', prop: 'Name', value: 'skip' } },
      ],
    });
  });

  it('wildcard node test //* uses a match-anything condition', async () => {
    const { ops, find } = makeFake(() => ['any.1']);
    await xpathToElementIds('//*[@Name="z"]', true, undefined, find);
    expect(ops[0].condition).to.deep.equal({
      kind: 'and',
      children: [
        { kind: 'true' },
        { kind: 'property', prop: 'Name', value: 'z' },
      ],
    });
  });

  it('union merges both branches and dedupes', async () => {
    const { ops, find } = makeFake((op) =>
      op.condition.kind === 'property' && op.condition.value === 'Button'
        ? ['shared', 'b1']
        : ['shared', 'e1'],
    );
    const result = await xpathToElementIds('//Button | //Edit', true, undefined, find);
    expect(ops).to.have.length(2);
    expect(result).to.deep.equal(['shared', 'b1', 'e1']);
  });

  it('relative path starts from the provided context element', async () => {
    const { ops, find } = makeFake(() => ['child.1']);
    await xpathToElementIds('Button', true, 'ctx.42', find);
    expect(ops[0].startId).to.equal('ctx.42');
    expect(ops[0].scope).to.equal('children');
  });

  it('throws InvalidSelectorError on malformed XPath', async () => {
    const { find } = makeFake(() => []);
    let threw: unknown;
    try {
      await xpathToElementIds('//[[[', true, undefined, find);
    } catch (e) {
      threw = e;
    }
    expect(threw).to.be.instanceOf(InvalidSelectorError);
  });

  it('throws InvalidSelectorError when a reverse axis is used without a walk() backend', async () => {
    // The legacy bare-find shim cannot satisfy parent:: (needs walk()); it surfaces as invalid.
    const { find } = makeFake(() => ['btn.1']);
    let threw: unknown;
    try {
      await xpathToElementIds('//Button/parent::Window', true, undefined, find);
    } catch (e) {
      threw = e;
    }
    expect(threw).to.be.instanceOf(InvalidSelectorError);
  });
});
