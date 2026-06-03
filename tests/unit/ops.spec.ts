import { expect } from 'chai';
import { propertyCondition, andCondition, findOp, attributesOp, actionOp, sourceOp, fileOp } from '../../lib/backend/ops';

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

  it('builds an attributes op (bulk)', () => {
    expect(attributesOp('42.1', ['Name', 'AutomationId'])).to.deep.equal({
      op: 'attributes',
      id: '42.1',
      names: ['Name', 'AutomationId'],
    });
    expect(attributesOp('42.1', 'all')).to.deep.equal({ op: 'attributes', id: '42.1', names: 'all' });
  });

  it('builds an action op', () => {
    expect(actionOp('42.1', 'setValue', { value: 'x' })).to.deep.equal({
      op: 'action',
      id: '42.1',
      action: 'setValue',
      args: { value: 'x' },
    });
  });

  it('builds a source op', () => {
    expect(sourceOp('root', true)).to.deep.equal({ op: 'source', startId: 'root', rawView: true });
  });

  it('builds a pull file op (no data)', () => {
    expect(fileOp('pull', 'C:\\tmp\\a.txt')).to.deep.equal({
      op: 'file',
      action: 'pull',
      path: 'C:\\tmp\\a.txt',
    });
  });

  it('builds a push file op (with base64 data)', () => {
    expect(fileOp('push', 'C:\\tmp\\a.txt', 'aGk=')).to.deep.equal({
      op: 'file',
      action: 'push',
      path: 'C:\\tmp\\a.txt',
      data: 'aGk=',
    });
  });

  it('builds a pullFolder op (no data key when data omitted)', () => {
    const op = fileOp('pullFolder', 'C:\\tmp\\dir');
    expect(op).to.deep.equal({ op: 'file', action: 'pullFolder', path: 'C:\\tmp\\dir' });
    expect(Object.prototype.hasOwnProperty.call(op, 'data')).to.equal(false);
  });
});
