// FlaUINativeDriver — the Appium 3 driver entry point.
// AUTHORED ON macOS. Builds against @appium/base-driver@10.6.0 (Appium-3 line); requires
// Windows + a published sidecar to run. See docs/NEXT-STEPS.md.
import { BaseDriver } from '@appium/base-driver';
import type {
  DriverCaps,
  W3CDriverCaps,
  DefaultCreateSessionResult,
  DriverData,
  Element as W3CElement,
  ExecuteMethodMap,
} from '@appium/types';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sidecar } from './backend/sidecar.js';
import {
  findOp,
  propertyCondition,
  attributesOp,
  actionOp,
  sourceOp,
  inputOp,
  type BackendOp,
  type BasicProps,
} from './backend/ops.js';
import {
  buildWindowsCommandOp,
  isSupportedWindowsCommand,
  isSupportedInputCommand,
  SUPPORTED_WINDOWS_COMMANDS,
  INPUT_COMMANDS,
} from './commands/extensions.js';
import { xpathToElementIds, type FoundElement } from './xpath/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

const constraints = {
  platformName: { isString: true, presence: true, inclusionCaseInsensitive: ['Windows'] },
  app: { isString: true },
  appTopLevelWindow: { isString: true }, // hex HWND of an existing window to attach to
  appArguments: { isString: true },
  appWorkingDir: { isString: true },
  shouldCloseApp: { isBoolean: true }, // default true
  'flaui:backend': { isString: true, inclusion: ['uia3', 'uia2'] },
} as const;

type Constraints = typeof constraints;

/** W3C element object for a backend runtime id. */
const toElement = (runtimeId: string): W3CElement => ({ [W3C_ELEMENT_KEY]: runtimeId });

const WINDOWS_METHOD_PREFIX = 'windowsCmd_';

// Appium 3 execute-method manifest: one entry per `windows:<name>` element command. base-driver's
// executeMethod calls `this[command](...positionalParams)` WITHOUT the script name, so each command needs
// its OWN method — we generate `windowsCmd_<name>` methods on the prototype below (after the class).
const executeMethodMap = Object.fromEntries([
  ...SUPPORTED_WINDOWS_COMMANDS.map((name) => [
    `windows: ${name}`,
    { command: `${WINDOWS_METHOD_PREFIX}${name}`, params: { required: ['elementId'], optional: ['value'] } },
  ]),
  ...Object.entries(INPUT_COMMANDS).map(([name, spec]) => [
    `windows: ${name}`,
    { command: `${WINDOWS_METHOD_PREFIX}${name}`, params: spec.params },
  ]),
  ['windows: setClipboard', { command: `${WINDOWS_METHOD_PREFIX}setClipboard`, params: { required: ['b64'], optional: ['contentType'] } }],
  ['windows: getClipboard', { command: `${WINDOWS_METHOD_PREFIX}getClipboard`, params: { required: [], optional: ['contentType'] } }],
]) as unknown as ExecuteMethodMap<FlaUINativeDriver>;

// W3C key codepoints (subset) → Windows virtual-key codes for performActions key sequences.
// Printable characters are typed on keyDown (keyUp is a no-op) — documented subset.
const W3C_KEY_TO_VK: Record<string, number> = {
  '': 0x08, // Backspace
  '': 0x09, // Tab
  '': 0x0d, // Return
  '': 0x0d, // Enter
  '': 0x10, // Shift
  '': 0x11, // Control
  '': 0x12, // Alt
  '': 0x1b, // Escape
  '': 0x20, // Space
  '': 0x25, // ArrowLeft
  '': 0x26, // ArrowUp
  '': 0x27, // ArrowRight
  '': 0x28, // ArrowDown
  '': 0x2e, // Delete
};

export class FlaUINativeDriver extends BaseDriver<Constraints> {
  static newMethodMap = {} as const;
  static executeMethodMap = executeMethodMap;
  desiredCapConstraints = constraints;
  locatorStrategies = ['accessibility id', 'id', 'name', 'class name', 'tag name', 'xpath'];
  private sidecar?: Sidecar;

  async createSession(
    w3cCaps1: W3CDriverCaps<Constraints>,
    w3cCaps2?: W3CDriverCaps<Constraints>,
    w3cCaps3?: W3CDriverCaps<Constraints>,
    driverData?: DriverData[],
  ): Promise<DefaultCreateSessionResult<Constraints>> {
    const [sessionId, caps] = await super.createSession(w3cCaps1, w3cCaps2, w3cCaps3, driverData);
    const arch = process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
    const exe = path.resolve(__dirname, `../../prebuilt/${arch}/FlaUiSidecar.exe`);
    if (!this.opts.app && !this.opts.appTopLevelWindow) {
      throw new Error(`Either 'appium:app' or 'appium:appTopLevelWindow' must be provided`);
    }
    this.sidecar = new Sidecar({ command: exe, args: [] });
    await this.sidecar.start();
    await this.sidecar.client.session({
      app: this.opts.app,
      appTopLevelWindow: this.opts.appTopLevelWindow,
      appArguments: this.opts.appArguments,
      appWorkingDir: this.opts.appWorkingDir,
      shouldCloseApp: this.opts.shouldCloseApp ?? true,
      backend: this.opts['flaui:backend'] ?? 'uia3',
    });
    return [sessionId, caps];
  }

  async deleteSession(sessionId?: string, _driverData?: DriverData[]): Promise<void> {
    try {
      // Close the app per shouldCloseApp (best effort), then stop the sidecar process.
      try {
        await this.sidecar?.client.deleteSession();
      } catch {
        /* best effort */
      }
      await this.sidecar?.stop();
    } finally {
      await super.deleteSession(sessionId);
    }
  }

  /** Issue a backend `find` op via the sidecar RPC and return the matched elements. */
  private readonly findViaBackend = async (op: BackendOp): Promise<FoundElement[]> => {
    const res = await this.sidecar!.client.op<BasicProps | { elements: BasicProps[] }>(op);
    const rows = 'elements' in res ? res.elements : [res];
    return rows.map((e) => ({ runtimeId: e.runtimeId }));
  };

  async findElOrEls(strategy: string, selector: string, mult: true, context?: string): Promise<W3CElement[]>;
  async findElOrEls(strategy: string, selector: string, mult: false, context?: string): Promise<W3CElement>;
  async findElOrEls(
    strategy: string,
    selector: string,
    mult: boolean,
    context?: string,
  ): Promise<W3CElement | W3CElement[]> {
    if (strategy === 'xpath') {
      const ids = await xpathToElementIds(selector, mult, context, this.findViaBackend);
      if (mult) {
        return ids.map(toElement);
      }
      if (ids.length === 0) {
        throw new Error(`no such element: unable to find an element using xpath '${selector}'`);
      }
      return toElement(ids[0]);
    }

    const propMap: Record<string, string> = {
      'accessibility id': 'AutomationId',
      id: 'AutomationId', // nova2-compatible alias
      name: 'Name',
      'class name': 'ClassName',
      'tag name': 'ControlType', // e.g. "Button", "Document"
    };
    const prop = propMap[strategy];
    if (!prop) throw new Error(`unsupported strategy: ${strategy}`);

    const res = await this.sidecar!.client.op<BasicProps | { elements: BasicProps[] }>(
      findOp({
        startId: context ?? 'root',
        multiple: mult,
        // 'subtree' includes the start element itself — matches nova2's default
        // includeContextElementInSearch:true (e.g. finding the root Window by its own ClassName).
        scope: 'subtree',
        condition: propertyCondition(prop, selector),
      }),
    );

    if (mult) {
      return (res as { elements: BasicProps[] }).elements.map((e) => toElement(e.runtimeId));
    }
    return toElement((res as BasicProps).runtimeId);
  }

  // ── Phase 2 command surface ──────────────────────────────────────────────────────────────
  async getPageSource(): Promise<string> {
    const res = await this.sidecar!.client.op<{ source: string }>(sourceOp('root'));
    return res.source;
  }

  async getAttribute(name: string, elementId: string): Promise<string | null> {
    const res = await this.sidecar!.client.op<Record<string, unknown>>(attributesOp(elementId, [name]));
    const v = res[name];
    return v == null ? null : String(v);
  }

  async click(elementId: string): Promise<void> {
    // Real pointer click at the element's center (nova2/W3C semantics). UIA Invoke stays available
    // separately as `windows: invoke`.
    await this.sidecar!.client.op(inputOp('click', { elementId }));
  }

  async setValue(text: string | string[], elementId: string): Promise<void> {
    const value = Array.isArray(text) ? text.join('') : text;
    await this.sidecar!.client.op(actionOp(elementId, 'setValue', { value }));
  }

  async clear(elementId: string): Promise<void> {
    await this.sidecar!.client.op(actionOp(elementId, 'setValue', { value: '' }));
  }

  async getText(elementId: string): Promise<string> {
    // Prefer ValuePattern text (e.g. Edit/Document content); fall back to the Name property.
    const res = await this.sidecar!.client.op<Record<string, unknown>>(attributesOp(elementId, ['Value', 'Name']));
    const v = res.Value ?? res.Name;
    return v == null ? '' : String(v);
  }

  async getName(elementId: string): Promise<string> {
    return (await this.getAttribute('Name', elementId)) ?? '';
  }

  async getProperty(name: string, elementId: string): Promise<string | null> {
    return this.getAttribute(name, elementId);
  }

  async getElementRect(elementId: string): Promise<{ x: number; y: number; width: number; height: number }> {
    const res = await this.sidecar!.client.op<{
      BoundingRectangle: { x: number; y: number; width: number; height: number } | null;
    }>(attributesOp(elementId, ['BoundingRectangle']));
    return res.BoundingRectangle ?? { x: 0, y: 0, width: 0, height: 0 };
  }

  async elementEnabled(elementId: string): Promise<boolean> {
    const res = await this.sidecar!.client.op<Record<string, unknown>>(attributesOp(elementId, ['IsEnabled']));
    return res.IsEnabled === true;
  }

  async elementDisplayed(elementId: string): Promise<boolean> {
    const res = await this.sidecar!.client.op<Record<string, unknown>>(attributesOp(elementId, ['IsOffscreen']));
    return res.IsOffscreen !== true;
  }

  async elementSelected(elementId: string): Promise<boolean> {
    // SelectionItemPattern.IsSelected; null (pattern unsupported) reads as false.
    const res = await this.sidecar!.client.op<Record<string, unknown>>(attributesOp(elementId, ['IsSelected']));
    return res.IsSelected === true;
  }

  // ── Screenshots ──────────────────────────────────────────────────────────────────────────
  async getScreenshot(): Promise<string> {
    const res = await this.sidecar!.client.op<{ data: string }>({ op: 'screenshot' });
    return res.data;
  }

  async getElementScreenshot(elementId: string): Promise<string> {
    const res = await this.sidecar!.client.op<{ data: string }>({ op: 'screenshot', id: elementId });
    return res.data;
  }

  // ── Clipboard (windows: setClipboard / getClipboard; plaintext base64, nova2-style) ───────
  async windowsCmd_setClipboard(b64: string, contentType?: string): Promise<unknown> {
    return this.sidecar!.client.op({ op: 'clipboard', action: 'set', b64, contentType });
  }

  async windowsCmd_getClipboard(contentType?: string): Promise<string> {
    const res = await this.sidecar!.client.op<{ b64: string }>({ op: 'clipboard', action: 'get', contentType });
    return res.b64;
  }

  // ── W3C Actions API (subset: sequential sources; mouse pointer + key) ─────────────────────
  private pointerPos = { x: 0, y: 0 };

  async performActions(actions: unknown[]): Promise<void> {
    for (const seq of (actions ?? []) as Array<Record<string, any>>) {
      if (seq.type === 'pause' || seq.type === 'none') {
        for (const a of seq.actions ?? []) {
          if (a.duration) await new Promise((r) => setTimeout(r, a.duration));
        }
      } else if (seq.type === 'pointer') {
        await this.performPointerSeq(seq);
      } else if (seq.type === 'key') {
        await this.performKeySeq(seq);
      } else {
        throw new Error(`unsupported action source type: ${seq.type}`);
      }
    }
  }

  async releaseActions(): Promise<void> {
    // No persistent pressed-key/button state is kept across calls yet (subset).
  }

  private async performPointerSeq(seq: Record<string, any>): Promise<void> {
    for (const a of seq.actions ?? []) {
      switch (a.type) {
        case 'pause':
          if (a.duration) await new Promise((r) => setTimeout(r, a.duration));
          break;
        case 'pointerMove': {
          let x = a.x ?? 0;
          let y = a.y ?? 0;
          const origin = a.origin ?? 'viewport';
          if (origin === 'pointer') {
            x += this.pointerPos.x;
            y += this.pointerPos.y;
          } else if (typeof origin === 'object' && origin !== null) {
            // element origin: W3C offsets are from the element CENTER.
            const elId = (origin as Record<string, string>)[W3C_ELEMENT_KEY] ?? (origin as any).ELEMENT;
            const r = await this.getElementRect(elId);
            x += Math.round(r.x + r.width / 2);
            y += Math.round(r.y + r.height / 2);
          }
          this.pointerPos = { x, y };
          await this.sidecar!.client.op(inputOp('move', { x, y }));
          break;
        }
        case 'pointerDown':
          await this.sidecar!.client.op(inputOp('down', { button: a.button === 2 ? 'right' : 'left' }));
          break;
        case 'pointerUp':
          await this.sidecar!.client.op(inputOp('up', { button: a.button === 2 ? 'right' : 'left' }));
          break;
        default:
          throw new Error(`unsupported pointer action: ${a.type}`);
      }
    }
  }

  private async performKeySeq(seq: Record<string, any>): Promise<void> {
    for (const a of seq.actions ?? []) {
      if (a.type === 'pause') {
        if (a.duration) await new Promise((r) => setTimeout(r, a.duration));
        continue;
      }
      const ch = a.value as string;
      const vk = W3C_KEY_TO_VK[ch];
      if (vk !== undefined) {
        await this.sidecar!.client.op(inputOp('keys', { actions: [{ virtualKeyCode: vk, down: a.type === 'keyDown' }] }));
      } else if (a.type === 'keyDown') {
        // Printable characters are typed on keyDown; keyUp is a no-op (documented subset).
        await this.sidecar!.client.op(inputOp('keys', { actions: [{ text: ch }] }));
      }
    }
  }

  // base-driver provides no default `execute`, so the W3C execute endpoint 405s without this. Route it
  // through executeMethod, which dispatches via the static executeMethodMap.
  async execute(script: string, args: unknown[]): Promise<unknown> {
    return this.executeMethod(script, args);
  }

  /** Shared implementation for every `windows:<action>` element command. */
  async runWindowsAction(action: string, elementId: string, value?: unknown): Promise<unknown> {
    if (!isSupportedWindowsCommand(action)) throw new Error(`unsupported windows: command: ${action}`);
    const args = value === undefined ? {} : { value };
    return this.sidecar!.client.op(buildWindowsCommandOp(action, elementId, args));
  }

  /** Shared implementation for every `windows:` INPUT command (mouse/keyboard via FlaUI.Core.Input). */
  async runWindowsInput(kind: string, args: Record<string, unknown>): Promise<unknown> {
    if (!isSupportedInputCommand(kind)) throw new Error(`unsupported windows: input command: ${kind}`);
    return this.sidecar!.client.op(inputOp(kind as 'click' | 'hover' | 'keys' | 'scroll' | 'clickAndDrag', args));
  }
}

// Generate one method per `windows:` command. base-driver's executeMethod looks up `this[command]` by name
// and calls it with positional params, so each command must be a distinct method.
for (const name of SUPPORTED_WINDOWS_COMMANDS) {
  Object.defineProperty(FlaUINativeDriver.prototype, `${WINDOWS_METHOD_PREFIX}${name}`, {
    value: function (this: FlaUINativeDriver, elementId: string, value?: unknown) {
      return this.runWindowsAction(name, elementId, value);
    },
    writable: true,
    configurable: true,
  });
}
// Input commands have per-command param lists: rebuild the named-args object from the positional args
// (base-driver passes them in the declared required+optional order).
for (const [name, spec] of Object.entries(INPUT_COMMANDS)) {
  const paramNames = [...spec.params.required, ...spec.params.optional];
  Object.defineProperty(FlaUINativeDriver.prototype, `${WINDOWS_METHOD_PREFIX}${name}`, {
    value: function (this: FlaUINativeDriver, ...args: unknown[]) {
      const named: Record<string, unknown> = {};
      paramNames.forEach((p, i) => {
        if (args[i] !== undefined) named[p] = args[i];
      });
      return this.runWindowsInput(name, named);
    },
    writable: true,
    configurable: true,
  });
}

export default FlaUINativeDriver;
