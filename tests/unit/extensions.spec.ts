import { expect } from 'chai';
import {
  buildWindowsCommandOp,
  isSupportedWindowsCommand,
  isSupportedInputCommand,
  SUPPORTED_WINDOWS_COMMANDS,
  INPUT_COMMANDS,
} from '../../lib/commands/extensions';

describe('windows: extension command mapping', () => {
  it('builds an action op for invoke', () => {
    expect(buildWindowsCommandOp('invoke', '42.1')).to.deep.equal({
      op: 'action',
      id: '42.1',
      action: 'invoke',
      args: {},
    });
  });

  it('passes args through for setValue', () => {
    expect(buildWindowsCommandOp('setValue', '42.1', { value: 'hello' })).to.deep.equal({
      op: 'action',
      id: '42.1',
      action: 'setValue',
      args: { value: 'hello' },
    });
  });

  it('recognizes supported commands', () => {
    expect(isSupportedWindowsCommand('toggle')).to.equal(true);
    expect(isSupportedWindowsCommand('nope')).to.equal(false);
    expect(SUPPORTED_WINDOWS_COMMANDS).to.include('maximize');
  });

  it('throws on an unsupported command', () => {
    expect(() => buildWindowsCommandOp('fly', '42.1')).to.throw(/unsupported windows: command/);
  });
});

describe('windows: INPUT command param parity', () => {
  it('recognizes the input commands', () => {
    expect(isSupportedInputCommand('click')).to.equal(true);
    expect(isSupportedInputCommand('clickAndDrag')).to.equal(true);
    expect(isSupportedInputCommand('nope')).to.equal(false);
  });

  it('click accepts the full arg set (button/times/modifierKeys/durationMs/interClickDelayMs/bringToFront)', () => {
    const opt = INPUT_COMMANDS.click.params.optional;
    for (const p of [
      'elementId', 'x', 'y', 'button', 'times', 'modifierKeys', 'durationMs', 'interClickDelayMs', 'bringToFront',
    ]) {
      expect(opt, `click missing ${p}`).to.include(p);
    }
  });

  it('hover accepts modifierKeys + durationMs + bringToFront', () => {
    const opt = INPUT_COMMANDS.hover.params.optional;
    expect(opt).to.include.members(['modifierKeys', 'durationMs', 'bringToFront']);
  });

  it('scroll accepts deltaX/deltaY/amount/modifierKeys/bringToFront', () => {
    const opt = INPUT_COMMANDS.scroll.params.optional;
    expect(opt).to.include.members(['deltaX', 'deltaY', 'amount', 'modifierKeys', 'bringToFront']);
  });

  it('clickAndDrag accepts start/end targets + button/durationMs/modifierKeys/bringToFront', () => {
    const opt = INPUT_COMMANDS.clickAndDrag.params.optional;
    expect(opt).to.include.members([
      'startElementId', 'startX', 'startY', 'endElementId', 'endX', 'endY',
      'button', 'durationMs', 'modifierKeys', 'bringToFront',
    ]);
  });
});
