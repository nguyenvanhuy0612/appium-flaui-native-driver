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
  type BackendOp,
  type BasicProps,
} from './backend/ops.js';
import {
  buildWindowsCommandOp,
  isSupportedWindowsCommand,
  SUPPORTED_WINDOWS_COMMANDS,
} from './commands/extensions.js';
import { xpathToElementIds, type FoundElement } from './xpath/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

const constraints = {
  platformName: { isString: true, presence: true, inclusionCaseInsensitive: ['Windows'] },
  app: { isString: true },
  'flaui:backend': { isString: true, inclusion: ['uia3', 'uia2'] },
} as const;

type Constraints = typeof constraints;

/** W3C element object for a backend runtime id. */
const toElement = (runtimeId: string): W3CElement => ({ [W3C_ELEMENT_KEY]: runtimeId });

// Appium 3 execute-method manifest: one entry per `windows:<name>` element command (Phase 2).
// Each maps to the single generic handler `windowsCommand`, which takes an elementId + params.
const executeMethodMap = Object.fromEntries(
  SUPPORTED_WINDOWS_COMMANDS.map((name) => [
    `windows: ${name}`,
    { command: 'windowsCommand', params: { required: ['elementId'], optional: ['value'] } },
  ]),
) as ExecuteMethodMap<FlaUINativeDriver>;

export class FlaUINativeDriver extends BaseDriver<Constraints> {
  static newMethodMap = {} as const;
  static executeMethodMap = executeMethodMap;
  desiredCapConstraints = constraints;
  locatorStrategies = ['accessibility id', 'name', 'class name', 'xpath'];
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
    this.sidecar = new Sidecar({ command: exe, args: [] });
    await this.sidecar.start();
    await this.sidecar.client.session({
      app: this.opts.app,
      backend: this.opts['flaui:backend'] ?? 'uia3',
    });
    return [sessionId, caps];
  }

  async deleteSession(sessionId?: string, _driverData?: DriverData[]): Promise<void> {
    try {
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
      name: 'Name',
      'class name': 'ClassName',
    };
    const prop = propMap[strategy];
    if (!prop) throw new Error(`unsupported strategy: ${strategy}`);

    const res = await this.sidecar!.client.op<BasicProps | { elements: BasicProps[] }>(
      findOp({
        startId: context ?? 'root',
        multiple: mult,
        scope: 'descendants',
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
    // Default element "click" maps to UIA Invoke; W3C Actions-based pointer click arrives in Phase 5.
    await this.sidecar!.client.op(actionOp(elementId, 'invoke'));
  }

  async setValue(text: string | string[], elementId: string): Promise<void> {
    const value = Array.isArray(text) ? text.join('') : text;
    await this.sidecar!.client.op(actionOp(elementId, 'setValue', { value }));
  }

  async clear(elementId: string): Promise<void> {
    await this.sidecar!.client.op(actionOp(elementId, 'setValue', { value: '' }));
  }

  /** Generic handler for all `windows:<name>` element commands (wired via executeMethodMap). */
  async windowsCommand(name: string, opts: { elementId: string; value?: unknown }): Promise<unknown> {
    const bare = name.replace(/^windows:\s*/, '');
    if (!isSupportedWindowsCommand(bare)) throw new Error(`unsupported windows: command: ${bare}`);
    const args = opts.value === undefined ? {} : { value: opts.value };
    return this.sidecar!.client.op(buildWindowsCommandOp(bare, opts.elementId, args));
  }
}

export default FlaUINativeDriver;
