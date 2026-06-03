// FlaUINativeDriver — the Appium 3 driver entry point.
// AUTHORED ON macOS. Requires @appium/base-driver (Appium-3 line) to be installed to build, and
// Windows + a published sidecar to run. See package.json _notes and docs/NEXT-STEPS.md.
import { BaseDriver } from '@appium/base-driver';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sidecar } from './backend/sidecar';
import { findOp, propertyCondition, type BasicProps } from './backend/ops';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

const constraints = {
  platformName: { isString: true, presence: true, inclusionCaseInsensitive: ['Windows'] },
  app: { isString: true },
  'flaui:backend': { isString: true, inclusion: ['uia3', 'uia2'] },
} as const;

export class FlaUINativeDriver extends BaseDriver<typeof constraints> {
  static newMethodMap = {} as const;
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
}

export default FlaUINativeDriver;
