import { expect } from 'chai';
import {
  buildWindowsCommandOp,
  isSupportedWindowsCommand,
  SUPPORTED_WINDOWS_COMMANDS,
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
