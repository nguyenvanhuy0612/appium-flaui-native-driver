import { expect } from 'chai';
import { w3cPointerButtonName } from '../../lib/backend/ops';

describe('w3cPointerButtonName (P2-7c W3C Actions button map)', () => {
  it('maps 0 → left', () => {
    expect(w3cPointerButtonName(0)).to.equal('left');
  });

  it('maps 1 → middle (the bug: middle used to collapse to left)', () => {
    expect(w3cPointerButtonName(1)).to.equal('middle');
  });

  it('maps 2 → right', () => {
    expect(w3cPointerButtonName(2)).to.equal('right');
  });

  it('defaults an absent/unknown button to left', () => {
    expect(w3cPointerButtonName(undefined)).to.equal('left');
    expect(w3cPointerButtonName(5)).to.equal('left');
  });
});
