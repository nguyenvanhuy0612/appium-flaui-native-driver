// Pure mapping of `windows:` extension commands → backend ops (the Phase 2 command surface).
// Kept free of @appium/base-driver so it is unit-testable on any OS. driver.ts wires these into
// Appium 3's `executeMethodMap` and calls into here.
import { actionOp, type BackendOp } from '../backend/ops.js';

/**
 * `windows:` command name → sidecar element-action name. These all operate on a single element via a
 * UIA pattern (Invoke/ExpandCollapse/Toggle/Selection/Window/etc.) handled by the C# OpInterpreter.
 */
const ACTION_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  // read-style (return data)
  getValue: 'getValue',
  isMultiple: 'isMultiple',
  selectedItem: 'selectedItem',
  allSelectedItems: 'allSelectedItems',
  getAttributes: 'getAttributes',
  // write-style
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

/**
 * `windows:` INPUT commands (real mouse/keyboard via FlaUI.Core.Input in the sidecar — ADR-005 rev.1).
 * Unlike action commands these have per-command parameter lists; the driver turns the positional
 * executeMethod args back into a named-args object in this declared order.
 */
export const INPUT_COMMANDS: Readonly<Record<string, { params: { required: string[]; optional: string[] } }>> =
  Object.freeze({
    click: {
      params: {
        required: [],
        optional: ['elementId', 'x', 'y', 'button', 'times', 'modifierKeys', 'durationMs', 'interClickDelayMs', 'bringToFront'],
      },
    },
    hover: { params: { required: [], optional: ['elementId', 'x', 'y', 'modifierKeys', 'durationMs', 'bringToFront'] } },
    scroll: {
      params: {
        required: [],
        optional: ['elementId', 'x', 'y', 'deltaX', 'deltaY', 'amount', 'modifierKeys', 'bringToFront'],
      },
    },
    keys: { params: { required: ['actions'], optional: [] } },
    clickAndDrag: {
      params: {
        required: [],
        optional: [
          'startElementId', 'startX', 'startY', 'endElementId', 'endX', 'endY',
          'button', 'durationMs', 'modifierKeys', 'bringToFront',
        ],
      },
    },
  });

export function isSupportedInputCommand(name: string): boolean {
  return name in INPUT_COMMANDS;
}
