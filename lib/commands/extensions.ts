// Pure mapping of `windows:` extension commands → backend ops (the Phase 2 command surface).
// Kept free of @appium/base-driver so it is unit-testable on any OS. driver.ts wires these into
// Appium 3's `executeMethodMap` and calls into here.
import { actionOp, type BackendOp } from '../backend/ops.js';

/**
 * `windows:` command name → sidecar element-action name. These all operate on a single element via a
 * UIA pattern (Invoke/ExpandCollapse/Toggle/Selection/Window/etc.) handled by the C# OpInterpreter.
 */
const ACTION_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  invoke: 'invoke',
  expand: 'expand',
  collapse: 'collapse',
  toggle: 'toggle',
  select: 'select',
  addToSelection: 'addToSelection',
  removeFromSelection: 'removeFromSelection',
  setFocus: 'setFocus',
  scrollIntoView: 'scrollIntoView',
  setValue: 'setValue',
  maximize: 'maximize',
  minimize: 'minimize',
  restore: 'restore',
  close: 'close',
});

export const SUPPORTED_WINDOWS_COMMANDS: readonly string[] = Object.freeze(Object.keys(ACTION_COMMANDS));

export function isSupportedWindowsCommand(name: string): boolean {
  return name in ACTION_COMMANDS;
}

/**
 * Build the backend op for a `windows:<name>` element command.
 * @param name   command name without the `windows: ` prefix (e.g. "invoke", "setValue")
 * @param elementId  the target element's runtime id
 * @param args   command arguments (e.g. { value } for setValue)
 */
export function buildWindowsCommandOp(
  name: string,
  elementId: string,
  args: Record<string, unknown> = {},
): BackendOp {
  const action = ACTION_COMMANDS[name];
  if (!action) throw new Error(`unsupported windows: command: ${name}`);
  return actionOp(elementId, action, args);
}
