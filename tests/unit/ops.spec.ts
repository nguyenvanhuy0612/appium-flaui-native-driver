import { expect } from 'chai';
import { propertyCondition, andCondition, findOp } from '../../lib/backend/ops';

describe('backend ops', () => {
  it('builds a property condition', () => {
    expect(propertyCondition('AutomationId', 'saveBtn')).to.deep.equal({
      kind: 'property',
      prop: 'AutomationId',
      value: 'saveBtn',
    });
  });

  it('builds an and condition', () => {
    const c = andCondition(propertyCondition('Name', 'OK'), propertyCondition('ControlType', 'Button'));
    expect(c.kind).to.equal('and');
    if (c.kind === 'and') expect(c.children).to.have.length(2);
  });

  it('builds a find op', () => {
    const op = findOp({
      startId: 'root',
      multiple: false,
      scope: 'descendants',
      condition: propertyCondition('Name', 'OK'),
    });
    expect(op).to.deep.equal({
      op: 'find',
      startId: 'root',
      multiple: false,
      scope: 'descendants',
      condition: { kind: 'property', prop: 'Name', value: 'OK' },
    });
  });
});
