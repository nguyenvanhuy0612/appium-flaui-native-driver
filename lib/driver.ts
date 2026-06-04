// FlaUINativeDriver — the Appium 3 driver entry point.
// AUTHORED ON macOS. Builds against @appium/base-driver@10.6.0 (Appium-3 line); requires
// Windows + a published sidecar to run. See docs/NEXT-STEPS.md.
import { BaseDriver, errors } from '@appium/base-driver';
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
import { RpcError } from './backend/rpc-client.js';
import {
  findOp,
  propertyCondition,
  attributesOp,
  actionOp,
  sourceOp,
  inputOp,
  fileOp,
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
import { xpathToElementIds, type FoundElement, type XPathBackend } from './xpath/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

const constraints = {
  platformName: { isString: true, presence: true, inclusionCaseInsensitive: ['Windows'] },
  app: { isString: true },
  appTopLevelWindow: { isString: true }, // hex HWND of an existing window to attach to
  appProcessId: { isNumber: true }, // attach to an already-running app by PID (roots at its outermost window)
  appName: { isString: true }, // attach to an already-running app by executable name (e.g. "SecureAge")
  appArguments: { isString: true },
  appWorkingDir: { isString: true },
  shouldCloseApp: { isBoolean: true }, // default true
  'flaui:backend': { isString: true, inclusion: ['uia3', 'uia2'] },
  // Sidecar / stability tuning (spec §7). All optional; sane defaults applied in the sidecar.
  'flaui:connectionTimeout': { isNumber: true }, // UIA ConnectionTimeout (ms)
  'flaui:transactionTimeout': { isNumber: true }, // UIA TransactionTimeout (ms)
  'flaui:operationTimeout': { isNumber: true }, // per-op watchdog (ms)
  'flaui:elementTableMax': { isNumber: true }, // element registry cap
  'flaui:idleTimeout': { isNumber: true }, // sidecar idle self-exit (ms; default 300000, 0 disables) — orphan guard (E)
  'flaui:autoRecycle': { isBoolean: true }, // OPT-IN silent sidecar recycle on death (default FALSE — C)
  // nova2-compat capabilities (accepted; some are advisory no-ops here — see docs/PARITY.md)
  'ms:waitForAppLaunch': { isNumber: true },
  'ms:forcequit': { isBoolean: true },
  powerShellCommandTimeout: { isNumber: true },
  treatStderrAsError: { isBoolean: true },
  prerun: { isObject: true },
  postrun: { isObject: true },
  typeDelay: { isNumber: true },
  smoothPointerMove: { isString: true },
  delayBeforeClick: { isNumber: true },
  delayAfterClick: { isNumber: true },
  releaseModifierKeys: { isBoolean: true },
  includeContextElementInSearch: { isBoolean: true },
  convertAbsoluteXPathToRelativeFromElement: { isBoolean: true },
  isolatedScriptExecution: { isBoolean: true },
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
    // nova2 clients pass either {elementId} or the W3C element object key — accept both.
    {
      command: `${WINDOWS_METHOD_PREFIX}${name}`,
      params: { required: [], optional: ['elementId', W3C_ELEMENT_KEY, 'value'] },
    },
  ]),
  ...Object.entries(INPUT_COMMANDS).map(([name, spec]) => [
    `windows: ${name}`,
    { command: `${WINDOWS_METHOD_PREFIX}${name}`, params: spec.params },
  ]),
  ['windows: setClipboard', { command: `${WINDOWS_METHOD_PREFIX}setClipboard`, params: { required: [], optional: ['b64', 'b64Content', 'contentType'] } }],
  ['windows: getClipboard', { command: `${WINDOWS_METHOD_PREFIX}getClipboard`, params: { required: [], optional: ['contentType'] } }],
  ['windows: launchApp', { command: `${WINDOWS_METHOD_PREFIX}launchApp`, params: { required: [], optional: [] } }],
  ['windows: closeApp', { command: `${WINDOWS_METHOD_PREFIX}closeApp`, params: { required: [], optional: [] } }],
  ['windows: setProcessForeground', { command: `${WINDOWS_METHOD_PREFIX}setProcessForeground`, params: { required: ['process'], optional: [] } }],
  ['windows: typeDelay', { command: `${WINDOWS_METHOD_PREFIX}typeDelay`, params: { required: ['delay'], optional: [] } }],
  ['windows: cacheRequest', { command: `${WINDOWS_METHOD_PREFIX}cacheRequest`, params: { required: [], optional: ['treeScope', 'treeFilter', 'conditions', 'automationElementMode'] } }],
  ['windows: getPageSource', { command: `${WINDOWS_METHOD_PREFIX}getPageSource`, params: { required: [], optional: ['elementId'] } }],
  ['windows: setWindowForeground', { command: `${WINDOWS_METHOD_PREFIX}setWindowForeground`, params: { required: [], optional: ['elementId', W3C_ELEMENT_KEY] } }],
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
  '': 0x21, // PageUp
  '': 0x22, // PageDown
  '': 0x23, // End
  '': 0x24, // Home
  '': 0x25, // ArrowLeft
  '': 0x26, // ArrowUp
  '': 0x27, // ArrowRight
  '': 0x28, // ArrowDown
  '': 0x2e, // Delete
  '': 0x5b, // Meta / Windows key
  '': 0x70, // F1
  '': 0x71, // F2
  '': 0x72, // F3
  '': 0x73, // F4
  '': 0x74, // F5
  '': 0x75, // F6
  '': 0x76, // F7
  '': 0x77, // F8
  '': 0x78, // F9
  '': 0x79, // F10
  '': 0x7a, // F11
  '': 0x7b, // F12
};

export class FlaUINativeDriver extends BaseDriver<Constraints> {
  static newMethodMap = {} as const;
  static executeMethodMap = executeMethodMap;
  desiredCapConstraints = constraints;
  locatorStrategies = ['accessibility id', 'id', 'name', 'class name', 'tag name', 'xpath'];
  private sidecar?: Sidecar;
  /** Path to the sidecar exe — kept so the layer-5 recycle path can relaunch it. */
  private sidecarExe?: string;
  /** The /session body used to (re-)open the backend session — replayed on recycle (F1, layer 5). */
  private sessionBody?: Record<string, unknown>;
  /** Per-op watchdog timeout (ms) threaded from flaui:operationTimeout (advisory; default in sidecar). */
  private operationTimeoutMs?: number;
  /** Single in-flight recycle promise so concurrent failures dedup to one restart (F1). */
  private recyclePromise?: Promise<void>;
  /** C: once the sidecar dies/wedges, the session is terminal — every op fails fast with this reason. */
  private sessionDead = false;
  private deadReason = 'session is no longer valid';

  /**
   * Whether silent sidecar recycle/re-attach is enabled. Default **FALSE** (C): a dead/unresponsive
   * sidecar fails the session honestly so the client can decide to restart with full knowledge.
   * Set `flaui:autoRecycle: true` to opt back into the old auto-recycle-and-retry behaviour.
   */
  private get autoRecycle(): boolean {
    return this.opts['flaui:autoRecycle'] === true;
  }

  async createSession(
    w3cCaps1: W3CDriverCaps<Constraints>,
    w3cCaps2?: W3CDriverCaps<Constraints>,
    w3cCaps3?: W3CDriverCaps<Constraints>,
    driverData?: DriverData[],
  ): Promise<DefaultCreateSessionResult<Constraints>> {
    const [sessionId, caps] = await super.createSession(w3cCaps1, w3cCaps2, w3cCaps3, driverData);
    const arch = process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
    const exe = path.resolve(__dirname, `../../prebuilt/${arch}/FlaUiSidecar.exe`);
    if (!this.opts.app && !this.opts.appTopLevelWindow && this.opts.appProcessId == null && !this.opts.appName) {
      throw new Error(
        `One of 'appium:app', 'appium:appTopLevelWindow', 'appium:appProcessId' or 'appium:appName' must be provided`,
      );
    }
    this.sidecarExe = exe;
    this.operationTimeoutMs = this.opts['flaui:operationTimeout'];
    // E — orphan-guard idle self-exit, by default DERIVED from Appium's own session reaping so that
    // setting `newCommandTimeout` alone is sufficient: a long inter-command wait that Appium is keeping
    // alive must never be cut short by the sidecar. We sit just ABOVE newCommandTimeout (a pure backstop
    // that only fires if Appium itself fails to reap). `flaui:idleTimeout` is an explicit override;
    // newCommandTimeout=0 (infinite) disables the idle guard entirely (honour "never reap").
    const idleTimeoutMs =
      this.opts['flaui:idleTimeout'] ??
      (this.newCommandTimeoutMs && this.newCommandTimeoutMs > 0 ? this.newCommandTimeoutMs + 120_000 : 0);
    // Build the /session body once so the layer-5 recycle path can replay it (re-attach).
    this.sessionBody = {
      app: this.opts.app,
      appTopLevelWindow: this.opts.appTopLevelWindow,
      appProcessId: this.opts.appProcessId,
      appName: this.opts.appName,
      appArguments: this.opts.appArguments,
      appWorkingDir: this.opts.appWorkingDir,
      waitForAppLaunch: this.opts['ms:waitForAppLaunch'],
      shouldCloseApp: this.opts.shouldCloseApp ?? true,
      forcequit: this.opts['ms:forcequit'] ?? false,
      backend: this.opts['flaui:backend'] ?? 'uia3',
      connectionTimeout: this.opts['flaui:connectionTimeout'],
      transactionTimeout: this.opts['flaui:transactionTimeout'],
      operationTimeout: this.opts['flaui:operationTimeout'],
      elementTableMax: this.opts['flaui:elementTableMax'],
      idleTimeout: idleTimeoutMs,
    };
    // D: the RPC client default timeout sits just ABOVE the sidecar's per-op watchdog (operationTimeout),
    // so the transport never aborts an op the backend is still legitimately working on.
    const opTimeout = this.operationTimeoutMs ?? 30_000;
    this.sidecar = new Sidecar({ command: exe, args: [], rpcTimeoutMs: opTimeout + 5_000 });
    await this.sidecar.start();
    // /session can legitimately take as long as the app-launch wait (ResolveAppRoot loops up to
    // max(waitForAppLaunch,10)s) — give it that plus a generous buffer instead of the per-op timeout.
    const launchWaitMs = Math.max((this.opts['ms:waitForAppLaunch'] ?? 0) * 1000, 10_000);
    await this.sidecar.client.session(this.sessionBody, launchWaitMs + 30_000);
    // nova2-compat: optional settle delay after app launch (seconds).
    const wait = this.opts['ms:waitForAppLaunch'];
    if (typeof wait === 'number' && wait > 0) await new Promise((r) => setTimeout(r, wait * 1000));
    // nova2-compat: optional prerun PowerShell snippet. PowerShell is a SCOPED INSECURE feature
    // (ADR-014): prerun executes arbitrary PowerShell, so it MUST be gated exactly like the
    // `windows: powershell` script — fail loud if the feature is not enabled (F23).
    const prerun = this.opts.prerun as { script?: string; command?: string } | undefined;
    if (prerun?.script || prerun?.command) {
      this.assertFeatureEnabled('power_shell');
      await this.op({
        op: 'powershell',
        script: prerun.script ?? prerun.command ?? '',
        timeoutMs: this.opts.powerShellCommandTimeout,
      });
    }
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

  /** Send an op to the sidecar, converting backend error types into W3C/appium error classes
   * (otherwise base-driver wraps everything as a 500 UnknownError). Wraps every call in the layer-5
   * health/recycle guard (F1). */
  private async op<T = unknown>(o: BackendOp): Promise<T> {
    try {
      return await this.ensureHealthyAndOp<T>(o);
    } catch (e) {
      if (e instanceof RpcError) {
        switch (e.type) {
          case 'stale element reference':
            throw new errors.StaleElementReferenceError(e.message);
          case 'no such element':
            throw new errors.NoSuchElementError(e.message);
          case 'invalid selector':
            throw new errors.InvalidSelectorError(e.message);
          case 'invalid argument':
            throw new errors.InvalidArgumentError(e.message);
          case 'timeout':
            throw new errors.TimeoutError(e.message);
          default:
            throw new errors.UnknownError(e.message);
        }
      }
      throw e;
    }
  }

  /**
   * Run an op with the anti-hang failure policy (C, spec §6).
   *
   * A clean {@link RpcError} means the sidecar ANSWERED (it is alive) — including a watchdog `"timeout"`
   * for a single frozen op; the session survives and the error propagates to the W3C mapping.
   *
   * A TRANSPORT failure (connection refused → process gone, or the hard-deadline firing → the backend is
   * wedged with every inner timeout having failed) is terminal by default: we kill the dead/wedged sidecar
   * (so it cannot linger as an orphan) and mark the SESSION dead, so this and every later command fails
   * fast with `InvalidSessionId` — the client decides to start a new session, with full knowledge.
   *
   * Opting into `flaui:autoRecycle: true` restores the old behaviour: recycle the sidecar (replaying the
   * stored /session body to re-attach/relaunch) and retry the op once, deduped via a single restart promise.
   */
  private async ensureHealthyAndOp<T = unknown>(o: BackendOp): Promise<T> {
    if (this.sessionDead) throw new errors.NoSuchDriverError(this.deadReason);
    if (this.sidecar!.hasExited && !this.autoRecycle) {
      this.markDead(`sidecar process exited (${this.sidecar!.exitReason})`);
    }
    const rpcTimeout = this.rpcTimeoutFor(o);
    try {
      return await this.sidecar!.client.op<T>(o, rpcTimeout);
    } catch (e) {
      if (e instanceof RpcError) throw e; // backend answered → session alive
      if (this.autoRecycle) {
        const recovered = await this.tryRecycle();
        if (!recovered) {
          throw new errors.UnknownError(
            `sidecar transport failed and could not be recycled: ${(e as Error).message}`,
          );
        }
        return await this.sidecar!.client.op<T>(o, rpcTimeout); // retry once against the fresh sidecar
      }
      // Default (C): the backend is gone or unresponsive — kill it and end the session honestly.
      try {
        await this.sidecar!.stop();
      } catch {
        /* presumed dead */
      }
      const how = this.sidecar!.hasExited ? `exited (${this.sidecar!.exitReason})` : 'became unresponsive';
      this.markDead(`sidecar backend ${how}: ${(e as Error).message}`);
    }
  }

  /** Mark the session terminally dead and throw the W3C "invalid session id" error (C). Never returns. */
  private markDead(reason: string): never {
    this.sessionDead = true;
    this.deadReason = `${reason} — this session is no longer valid; create a new session.`;
    throw new errors.NoSuchDriverError(this.deadReason);
  }

  /**
   * Per-op RPC timeout (D, nested timeouts). UIA ops get `operationTimeout + grace` so the transport sits
   * just above the sidecar's per-op watchdog. PowerShell runs out-of-scheduler and may legitimately run
   * longer than the watchdog, so it gets its own (per-call / session / 60s default) timeout + grace.
   */
  private rpcTimeoutFor(o: BackendOp): number {
    const grace = 5_000;
    if (o.op === 'powershell') {
      const t = (o as { timeoutMs?: number }).timeoutMs ?? this.opts.powerShellCommandTimeout ?? 60_000;
      return t + grace;
    }
    return (this.operationTimeoutMs ?? 30_000) + grace;
  }

  /** Recycle the sidecar process and re-open the backend session (deduped). Returns true on success. */
  private async tryRecycle(): Promise<boolean> {
    if (!this.recyclePromise) {
      this.recyclePromise = this.doRecycle().finally(() => {
        this.recyclePromise = undefined;
      });
    }
    try {
      await this.recyclePromise;
      return true;
    } catch {
      return false;
    }
  }

  private async doRecycle(): Promise<void> {
    try {
      await this.sidecar?.stop();
    } catch {
      /* the old process is presumed dead; ignore */
    }
    const next = new Sidecar({ command: this.sidecarExe!, args: [] });
    await next.start();
    await next.client.session(this.sessionBody ?? {});
    this.sidecar = next;
  }

  /** Issue a backend `find` op via the sidecar RPC and return the matched elements. */
  private readonly findViaBackend = async (op: BackendOp): Promise<FoundElement[]> => {
    const res = await this.op<BasicProps | { elements: BasicProps[] }>(op);
    const rows = 'elements' in res ? res.elements : [res];
    return rows.map((e) => ({
      runtimeId: e.runtimeId,
      name: e.name ?? undefined,
      automationId: e.automationId ?? undefined,
      className: e.className ?? undefined,
      controlType: e.controlType ?? undefined,
    }));
  };

  /** Full backend for the XPath engine: structural finds + tree walking + attribute evaluation. */
  private readonly xpathBackend: XPathBackend = {
    find: async (op: BackendOp) => {
      // nova2's includeContextElementInSearch (default true): descendant searches include the context
      // element itself — e.g. `//Window` matches the session root window.
      if (op.op === 'find' && op.scope === 'descendants' && (this.opts.includeContextElementInSearch ?? true)) {
        op = { ...op, scope: 'subtree' };
      }
      return this.findViaBackend(op);
    },
    walk: async (id, direction) => {
      const res = await this.op<{ elements: BasicProps[] }>({ op: 'walk', id, direction });
      return res.elements.map((e) => ({
        runtimeId: e.runtimeId,
        name: e.name ?? undefined,
        automationId: e.automationId ?? undefined,
        className: e.className ?? undefined,
        controlType: e.controlType ?? undefined,
      }));
    },
    attributes: async (id, names) => {
      const raw = await this.op<Record<string, unknown>>(attributesOp(id, names));
      // Predicates compare page-source-style strings: booleans must read "True"/"False" (C# style).
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) {
        out[k] = typeof v === 'boolean' ? (v ? 'True' : 'False') : v;
      }
      return out;
    },
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
      let ids: string[];
      try {
        ids = await xpathToElementIds(selector, mult, context, this.xpathBackend);
      } catch (e) {
        // Map the engine's InvalidSelectorError onto the W3C error (400 invalid selector).
        if ((e as Error)?.name === 'InvalidSelectorError') {
          throw new errors.InvalidSelectorError((e as Error).message);
        }
        throw e;
      }
      if (mult) {
        return ids.map(toElement);
      }
      if (ids.length === 0) {
        throw new errors.NoSuchElementError(
          `unable to find an element using xpath '${selector}'`,
        );
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

    const res = await this.op<BasicProps | { elements: BasicProps[] }>(
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
    const res = await this.op<{ source: string }>(sourceOp('root'));
    return res.source;
  }

  async getAttribute(name: string, elementId: string): Promise<string | null> {
    // `all` → the full attribute dump (inspect-style set) as a JSON string (W3C getAttribute returns a
    // string). The object form is also available via execute('windows: getAttributes').
    if (name === 'all') {
      const dump = await this.op<Record<string, unknown>>(attributesOp(elementId, 'all'));
      return JSON.stringify(dump);
    }
    const res = await this.op<Record<string, unknown>>(attributesOp(elementId, [name]));
    const v = res[name];
    if (v == null) return null;
    // W3C getAttribute returns a string. Scalars stringify natively; structured values (e.g.
    // BoundingRectangle's {x,y,width,height}) are JSON-serialised rather than coerced to "[object Object]".
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }

  async click(elementId: string): Promise<void> {
    // Real pointer click at the element's center (nova2/W3C semantics). UIA Invoke stays available
    // separately as `windows: invoke`.
    await this.op(inputOp('click', { elementId }));
  }

  async setValue(text: string | string[], elementId: string): Promise<void> {
    const value = Array.isArray(text) ? text.join('') : text;
    await this.op(actionOp(elementId, 'setValue', { value }));
  }

  async clear(elementId: string): Promise<void> {
    await this.op(actionOp(elementId, 'setValue', { value: '' }));
  }

  async getText(elementId: string): Promise<string> {
    // W3C "Get Element Text". The sidecar resolves the synthetic "Text" attribute with FlaUI-native
    // precedence: TextPattern.DocumentRange.GetText → ValuePattern.Value → Name → LegacyIAccessible.Value.
    const res = await this.op<Record<string, unknown>>(attributesOp(elementId, ['Text']));
    const v = res.Text;
    return v == null ? '' : String(v);
  }

  async getName(elementId: string): Promise<string> {
    // W3C "Get Element Tag Name" — returns the tag (ControlType), matching the page-source tag names.
    return (await this.getAttribute('ControlType', elementId)) ?? '';
  }

  async getProperty(name: string, elementId: string): Promise<string | null> {
    return this.getAttribute(name, elementId);
  }

  async getElementRect(elementId: string): Promise<{ x: number; y: number; width: number; height: number }> {
    const res = await this.op<{
      BoundingRectangle: { x: number; y: number; width: number; height: number } | null;
    }>(attributesOp(elementId, ['BoundingRectangle']));
    return res.BoundingRectangle ?? { x: 0, y: 0, width: 0, height: 0 };
  }

  async elementEnabled(elementId: string): Promise<boolean> {
    const res = await this.op<Record<string, unknown>>(attributesOp(elementId, ['IsEnabled']));
    return res.IsEnabled === true;
  }

  async elementDisplayed(elementId: string): Promise<boolean> {
    const res = await this.op<Record<string, unknown>>(attributesOp(elementId, ['IsOffscreen']));
    return res.IsOffscreen !== true;
  }

  async elementSelected(elementId: string): Promise<boolean> {
    // SelectionItemPattern.IsSelected; null (pattern unsupported) reads as false.
    const res = await this.op<Record<string, unknown>>(attributesOp(elementId, ['IsSelected']));
    return res.IsSelected === true;
  }

  // ── Screenshots ──────────────────────────────────────────────────────────────────────────
  async getScreenshot(): Promise<string> {
    const res = await this.op<{ data: string }>({ op: 'screenshot' });
    return res.data;
  }

  async getElementScreenshot(elementId: string): Promise<string> {
    const res = await this.op<{ data: string }>({ op: 'screenshot', id: elementId });
    return res.data;
  }

  // ── Clipboard (windows: setClipboard / getClipboard; plaintext base64, nova2-style) ───────
  async windowsCmd_setClipboard(b64?: string, b64Content?: string, contentType?: string): Promise<unknown> {
    // nova2 calls this parameter `b64Content`; accept both spellings.
    return this.op({ op: 'clipboard', action: 'set', b64: b64 ?? b64Content, contentType });
  }

  async windowsCmd_getClipboard(contentType?: string): Promise<string> {
    const res = await this.op<{ b64: string }>({ op: 'clipboard', action: 'get', contentType });
    return res.b64;
  }

  // ── W3C Actions API (subset: sequential sources; mouse pointer + key) ─────────────────────
  private pointerPos = { x: 0, y: 0 };
  /** Cached top-left of the session root window, used to make `viewport`-origin coords window-relative
   * (W3C "viewport" analog for a window-rooted session). Memoized per performActions() call. */
  private viewportOrigin?: { x: number; y: number };

  /** Top-left (screen coords) of the session root window — the origin for `viewport` pointer coords.
   * For a desktop (`app:'Root'`) session this is ~(0,0), so coords stay screen-absolute. */
  private async viewportOffset(): Promise<{ x: number; y: number }> {
    if (!this.viewportOrigin) {
      try {
        const r = await this.getWindowRect();
        this.viewportOrigin = { x: r.x ?? 0, y: r.y ?? 0 };
      } catch {
        this.viewportOrigin = { x: 0, y: 0 };
      }
    }
    return this.viewportOrigin;
  }

  async performActions(actions: unknown[]): Promise<void> {
    this.viewportOrigin = undefined; // refresh the window origin once per call (window may have moved)
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
            // element origin: W3C offsets are from the element CENTER (BoundingRectangle is screen coords).
            const elId = (origin as Record<string, string>)[W3C_ELEMENT_KEY] ?? (origin as any).ELEMENT;
            const r = await this.getElementRect(elId);
            x += Math.round(r.x + r.width / 2);
            y += Math.round(r.y + r.height / 2);
          } else {
            // viewport origin (default): coords are relative to the session ROOT WINDOW's top-left, not the
            // raw screen — so (x,y) hit the same spot regardless of where the (attached) window sits.
            const off = await this.viewportOffset();
            x += off.x;
            y += off.y;
          }
          this.pointerPos = { x, y };
          await this.op(inputOp('move', { x, y }));
          break;
        }
        case 'pointerDown':
          await this.op(inputOp('down', { button: a.button === 2 ? 'right' : 'left' }));
          break;
        case 'pointerUp':
          await this.op(inputOp('up', { button: a.button === 2 ? 'right' : 'left' }));
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
        await this.op(inputOp('keys', { actions: [{ virtualKeyCode: vk, down: a.type === 'keyDown' }] }));
      } else if (a.type === 'keyDown') {
        // Printable characters are typed on keyDown; keyUp is a no-op (documented subset).
        await this.op(inputOp('keys', { actions: [{ text: ch }] }));
      }
    }
  }

  // base-driver provides no default `execute`, so the W3C execute endpoint 405s without this. Route it
  // through executeMethod, which dispatches via the static executeMethodMap.
  async execute(script: string, args: unknown[]): Promise<unknown> {
    const name = script.trim();
    const lower = name.toLowerCase();
    if (lower === 'powershell') {
      // Scoped insecure feature (ADR-014, reversing ADR-007). Gate must fail LOUD (F22): base-driver
      // 10.6 provides assertFeatureEnabled, so call it directly — never optional-chain it away.
      this.assertFeatureEnabled('power_shell');
      const a = ((args as unknown[])?.[0] ?? {}) as {
        script?: string;
        command?: string;
        timeoutMs?: number;
        timeout?: number;
      };
      const res = await this.op<{ stdout: string; stderr: string; exitCode: number }>({
        op: 'powershell',
        script: a.script ?? a.command ?? '',
        // Per-call timeout wins; else the session cap (powerShellCommandTimeout); else the sidecar's 60s
        // default. PowerShell runs out-of-scheduler so flaui:operationTimeout does NOT bound it — this is.
        timeoutMs: a.timeoutMs ?? a.timeout ?? this.opts.powerShellCommandTimeout,
      });
      return res.stdout;
    }
    // nova2-compatible execute scripts for file transfer (also reachable via the standard appium endpoints
    // below). Each is gated as a scoped insecure feature (ADR-008), failing loud via assertFeatureEnabled.
    if (name === 'pullFile') {
      const a = ((args as unknown[])?.[0] ?? {}) as { path?: string };
      return this.pullFile(a.path ?? '');
    }
    if (name === 'pushFile') {
      const a = ((args as unknown[])?.[0] ?? {}) as { path?: string; data?: string };
      return this.pushFile(a.path ?? '', a.data ?? '');
    }
    if (name === 'pullFolder') {
      const a = ((args as unknown[])?.[0] ?? {}) as { path?: string };
      return this.pullFolder(a.path ?? '');
    }
    return this.executeMethod(script, args);
  }

  // ── File transfer (insecure features, ADR-008) ────────────────────────────────────────────
  // base-driver routes the standard appium endpoints (POST .../appium/device/{pull_file,push_file,
  // pull_folder}) to these methods. Each is gated with assertFeatureEnabled (fails loud — F22).
  //
  // TRUST BOUNDARY (F24): once pull_file/push_file is enabled there is NO path sandbox. ANY absolute
  // path on the host is readable (pull) or writable (push) by the connected client, running with the
  // Appium server's privileges. Enable only for fully-trusted clients. See FUNCTIONS.md §6 / README.
  async pullFile(remotePath: string): Promise<string> {
    this.assertFeatureEnabled('pull_file');
    const res = await this.op<{ data: string }>(fileOp('pull', remotePath));
    return res.data;
  }

  async pushFile(remotePath: string, base64Data: string): Promise<void> {
    this.assertFeatureEnabled('push_file');
    await this.op(fileOp('push', remotePath, base64Data));
  }

  async pullFolder(remotePath: string): Promise<string> {
    this.assertFeatureEnabled('pull_file');
    const res = await this.op<{ data: string }>(fileOp('pullFolder', remotePath));
    return res.data;
  }

  // ── W3C window commands (operate on the session root window) ──────────────────────────────
  // base-driver routes `GET /session/:id/title` to the command name `title` (see protocol/routes.js),
  // so the method MUST be named `title`. `getTitle` is kept as an alias for internal/nova2-style callers.
  async title(): Promise<string> {
    return (await this.op<{ value: string }>({ op: 'window', action: 'title' })).value;
  }

  async getTitle(): Promise<string> {
    return this.title();
  }

  async getWindowHandle(): Promise<string> {
    return (await this.op<{ value: string }>({ op: 'window', action: 'handle' })).value;
  }

  async getWindowHandles(): Promise<string[]> {
    return [await this.getWindowHandle()];
  }

  async getWindowRect(): Promise<{ x: number; y: number; width: number; height: number }> {
    return this.op({ op: 'window', action: 'rect' });
  }

  async setWindowRect(x: number | null, y: number | null, width: number | null, height: number | null) {
    const args: Record<string, unknown> = {};
    if (x != null) args.x = x;
    if (y != null) args.y = y;
    if (width != null) args.width = width;
    if (height != null) args.height = height;
    return this.op({ op: 'window', action: 'setRect', args });
  }

  async maximizeWindow() {
    return this.op({ op: 'window', action: 'maximize' });
  }

  async minimizeWindow() {
    return this.op({ op: 'window', action: 'minimize' });
  }

  /** Strong, escalating foreground: FlaUI `Focus()`/SetForeground first, then Win32 topmost-toggle →
   * minimize/restore if still not on top. With an elementId it targets that element's top-level window;
   * otherwise the session window. Use when the basic focus a `click` does isn't enough. */
  async windowsCmd_setWindowForeground(elementId?: string, w3cElement?: string): Promise<unknown> {
    const id = elementId ?? w3cElement;
    return this.op(id ? { op: 'window', action: 'foreground', elementId: id } : { op: 'window', action: 'foreground' });
  }

  // ── windows: app/session-level commands (nova2-compat) ────────────────────────────────────
  async windowsCmd_launchApp(): Promise<unknown> {
    return this.op({ op: 'app', action: 'launch' });
  }

  async windowsCmd_closeApp(): Promise<unknown> {
    return this.op({ op: 'app', action: 'close' });
  }

  async windowsCmd_setProcessForeground(process: string): Promise<unknown> {
    return this.op({ op: 'app', action: 'activate', process });
  }

  private typeDelayMs = 0;
  async windowsCmd_typeDelay(delay: number): Promise<number> {
    const previous = this.typeDelayMs;
    this.typeDelayMs = delay; // advisory for now (FlaUI Keyboard has its own pacing)
    return previous;
  }

  async windowsCmd_cacheRequest(..._args: unknown[]): Promise<unknown> {
    return { done: true }; // accepted no-op: we build per-call requests, no global cache to reset
  }

  async windowsCmd_getPageSource(elementId?: string): Promise<string> {
    const res = await this.op<{ source: string }>(sourceOp(elementId ?? 'root'));
    return res.source;
  }

  /** Shared implementation for every `windows:<action>` element command. */
  async runWindowsAction(action: string, elementId: string, value?: unknown): Promise<unknown> {
    if (!isSupportedWindowsCommand(action)) throw new Error(`unsupported windows: command: ${action}`);
    const args = value === undefined ? {} : { value };
    return this.op(buildWindowsCommandOp(action, elementId, args));
  }

  /** Shared implementation for every `windows:` INPUT command (mouse/keyboard via FlaUI.Core.Input). */
  async runWindowsInput(kind: string, args: Record<string, unknown>): Promise<unknown> {
    if (!isSupportedInputCommand(kind)) throw new Error(`unsupported windows: input command: ${kind}`);
    return this.op(inputOp(kind as 'click' | 'hover' | 'keys' | 'scroll' | 'clickAndDrag', args));
  }
}

// Generate one method per `windows:` command. base-driver's executeMethod looks up `this[command]` by name
// and calls it with positional params, so each command must be a distinct method.
for (const name of SUPPORTED_WINDOWS_COMMANDS) {
  Object.defineProperty(FlaUINativeDriver.prototype, `${WINDOWS_METHOD_PREFIX}${name}`, {
    // Positional params: [elementId, <W3C element key>, value] — accept either element reference style.
    value: function (this: FlaUINativeDriver, elementId?: string, w3cElement?: string, value?: unknown) {
      const id = elementId ?? w3cElement;
      if (!id) throw new Error(`windows: ${name} requires an elementId`);
      return this.runWindowsAction(name, id, value);
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
