// FlaUINativeDriver — the Appium 3 driver entry point.
// AUTHORED ON macOS. Requires @appium/base-driver (Appium-3 line) to be installed to build, and
// Windows + a published sidecar to run. See package.json _notes and docs/NEXT-STEPS.md.
import { BaseDriver } from '@appium/base-driver';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sidecar } from './backend/sidecar';
import { findOp, propertyCondition, attributesOp, actionOp, sourceOp, type BasicProps } from './backend/ops';
import { buildWindowsCommandOp, isSupportedWindowsCommand, SUPPORTED_WINDOWS_COMMANDS } from './commands/extensions';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

const constraints = {
  platformName: { isString: true, presence: true, inclusionCaseInsensitive: ['Windows'] },
  app: { isString: true },
  'flaui:backend': { isString: true, inclusion: ['uia3', 'uia2'] },
} as const;

// Appium 3 execute-method manifest: one entry per `windows:<name>` element command (Phase 2).
// Each maps to the single generic handler `windowsCommand`, which takes an elementId + params.
const executeMethodMap = Object.fromEntries(
  SUPPORTED_WINDOWS_COMMANDS.map((name) => [
    `windows: ${name}`,
    { command: 'windowsCommand', params: { required: ['elementId'], optional: ['value'] } },
  ]),
) as Record<string, { command: 'windowsCommand'; params: { required: string[]; optional: string[] } }>;

export class FlaUINativeDriver extends BaseDriver<typeof constraints> {
  static newMethodMap = {} as const;
  static executeMethodMap = executeMethodMap;
  desiredCapConstraints = constraints;
  locatorStrategies = ['accessibility id', 'name', 'class name', 'xpath'];
  private sidecar?: Sidecar;

  async createSession(...jwpArgs: any[]) {
    const [sessionId, caps] = (await super.createSession(...(jwpArgs as [any]))) as [string, any];
    const arch = process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
    const exe = path.resolve(__dirname, `../../prebuilt/${arch}/FlaUiSidecar.exe`);
    this.sidecar = new Sidecar({ command: exe, args: [] });
    await this.sidecar.start();
    await this.sidecar.client.session({
      app: this.opts.app,
      backend: (this.opts as any)['flaui:backend'] ?? 'uia3',
    });
    return [sessionId, caps] as [string, any];
  }

  async deleteSession() {
    try {
      await this.sidecar?.stop();
    } finally {
      await super.deleteSession();
    }
  }

  async findElOrEls(strategy: string, selector: string, mult: boolean, context?: string) {
    const propMap: Record<string, string> = {
      'accessibility id': 'AutomationId',
      name: 'Name',
      'class name': 'ClassName',
    };
    if (strategy === 'xpath') throw new Error('xpath arrives in Phase 3');
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
      return (res as { elements: BasicProps[] }).elements.map((e) => ({ [W3C_ELEMENT_KEY]: e.runtimeId }));
    }
    return { [W3C_ELEMENT_KEY]: (res as BasicProps).runtimeId };
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

  async execute(script: string, args: unknown): Promise<unknown> {
    return this.executeMethod(script, args as [Record<string, unknown>]);
  }
}

export default FlaUINativeDriver;
