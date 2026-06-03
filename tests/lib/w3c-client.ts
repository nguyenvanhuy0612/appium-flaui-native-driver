// Tiny, typed, fetch-based W3C WebDriver client — NO webdriverio.
//
// Designed for protocol-exact testing of the FlaUINative Appium 3 driver. Every method returns the
// raw transport result `{ status, value, error }` so specs can assert BOTH happy paths and the exact
// W3C error shapes (HTTP status + `value.error` string per https://www.w3.org/TR/webdriver2/#errors).
//
// Environment config (no OS-version-specific selectors anywhere in the suite):
//   APPIUM_URL  default http://127.0.0.1:4723
//   TARGET_APP  default C:\Windows\System32\notepad.exe
//
// This client is intentionally dumb: it never throws on a 4xx/5xx; it surfaces the body. Specs decide.

export const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

export const APPIUM_URL = (process.env.APPIUM_URL ?? 'http://127.0.0.1:4723').replace(/\/$/, '');
export const TARGET_APP = process.env.TARGET_APP ?? 'C:\\Windows\\System32\\notepad.exe';

/** A raw protocol result. `value` is the W3C `value` payload; on an error it is `{ error, message, stacktrace }`. */
export interface W3CResult<T = any> {
  /** HTTP status code (200 on success; 4xx/5xx on a W3C error). */
  status: number;
  /** `value` field of the W3C envelope (may be the success data OR the error object). */
  value: T;
  /** The W3C error code string (e.g. 'no such element') when `status` is non-2xx, else undefined. */
  error?: string;
  /** The error message, when present. */
  message?: string;
  /** Raw response text (debugging aid). */
  raw?: string;
}

/** Locator strategies recognised by the W3C/Appium endpoints used in this suite. */
export type Using =
  | 'css selector'
  | 'link text'
  | 'partial link text'
  | 'tag name'
  | 'xpath'
  | 'accessibility id'
  | 'id'
  | 'class name'
  | 'name';

/** A W3C element reference object, e.g. `{ 'element-6066-...': '1.2.3' }`. */
export type ElementRef = Record<string, string>;

async function request<T = any>(
  method: string,
  path: string,
  body?: unknown,
): Promise<W3CResult<T>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(APPIUM_URL + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { status: 0, value: undefined as unknown as T, error: 'network error', message: String(e) };
  }
  const text = await res.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    return { status: res.status, value: text as unknown as T, raw: text };
  }
  const value = parsed?.value;
  const out: W3CResult<T> = { status: res.status, value, raw: text };
  // W3C errors put `{ error, message, stacktrace }` inside `value`.
  if (res.status >= 400 && value && typeof value === 'object') {
    out.error = value.error;
    out.message = value.message;
  }
  return out;
}

/** Build a W3C `capabilities` payload from extra alwaysMatch caps. platformName + automationName always present. */
export function caps(extra: Record<string, unknown> = {}): unknown {
  return {
    capabilities: {
      alwaysMatch: {
        platformName: 'Windows',
        'appium:automationName': 'FlaUINative',
        ...extra,
      },
      firstMatch: [{}],
    },
  };
}

/** Extract the element id from a find result's `value`. Returns undefined if not an element ref. */
export function elementId(value: unknown): string | undefined {
  if (value && typeof value === 'object' && W3C_ELEMENT_KEY in (value as object)) {
    return (value as ElementRef)[W3C_ELEMENT_KEY];
  }
  return undefined;
}

// ── Session ────────────────────────────────────────────────────────────────────────────────────
export function newSession(extraCaps: Record<string, unknown> = {}) {
  return request<{ sessionId: string; capabilities: Record<string, unknown> }>('POST', '/session', caps(extraCaps));
}
export function newSessionRaw(payload: unknown) {
  return request('POST', '/session', payload);
}
export function deleteSession(sessionId: string) {
  return request('DELETE', `/session/${sessionId}`);
}
export function status() {
  return request('GET', '/status');
}

// ── Find ──────────────────────────────────────────────────────────────────────────────────────
export function findElement(sessionId: string, using: Using, value: string) {
  return request<ElementRef>('POST', `/session/${sessionId}/element`, { using, value });
}
export function findElements(sessionId: string, using: Using, value: string) {
  return request<ElementRef[]>('POST', `/session/${sessionId}/elements`, { using, value });
}
export function findElementFromElement(sessionId: string, fromId: string, using: Using, value: string) {
  return request<ElementRef>('POST', `/session/${sessionId}/element/${enc(fromId)}/element`, { using, value });
}
export function findElementsFromElement(sessionId: string, fromId: string, using: Using, value: string) {
  return request<ElementRef[]>('POST', `/session/${sessionId}/element/${enc(fromId)}/elements`, { using, value });
}

// ── Element commands ────────────────────────────────────────────────────────────────────────────
const enc = (id: string) => encodeURIComponent(id);
export function click(sessionId: string, id: string) {
  return request('POST', `/session/${sessionId}/element/${enc(id)}/click`, {});
}
export function setValue(sessionId: string, id: string, text: string) {
  return request('POST', `/session/${sessionId}/element/${enc(id)}/value`, { text });
}
export function clear(sessionId: string, id: string) {
  return request('POST', `/session/${sessionId}/element/${enc(id)}/clear`, {});
}
export function getText(sessionId: string, id: string) {
  return request<string>('GET', `/session/${sessionId}/element/${enc(id)}/text`);
}
export function getAttribute(sessionId: string, id: string, name: string) {
  return request('GET', `/session/${sessionId}/element/${enc(id)}/attribute/${encodeURIComponent(name)}`);
}
export function getProperty(sessionId: string, id: string, name: string) {
  return request('GET', `/session/${sessionId}/element/${enc(id)}/property/${encodeURIComponent(name)}`);
}
export function getName(sessionId: string, id: string) {
  return request<string>('GET', `/session/${sessionId}/element/${enc(id)}/name`);
}
export function getRect(sessionId: string, id: string) {
  return request<{ x: number; y: number; width: number; height: number }>(
    'GET', `/session/${sessionId}/element/${enc(id)}/rect`);
}
export function isEnabled(sessionId: string, id: string) {
  return request<boolean>('GET', `/session/${sessionId}/element/${enc(id)}/enabled`);
}
export function isDisplayed(sessionId: string, id: string) {
  return request<boolean>('GET', `/session/${sessionId}/element/${enc(id)}/displayed`);
}
export function isSelected(sessionId: string, id: string) {
  return request<boolean>('GET', `/session/${sessionId}/element/${enc(id)}/selected`);
}
export function elementScreenshot(sessionId: string, id: string) {
  return request<string>('GET', `/session/${sessionId}/element/${enc(id)}/screenshot`);
}

// ── Document / capture ──────────────────────────────────────────────────────────────────────────
export function getPageSource(sessionId: string) {
  return request<string>('GET', `/session/${sessionId}/source`);
}
export function screenshot(sessionId: string) {
  return request<string>('GET', `/session/${sessionId}/screenshot`);
}

// ── Window ─────────────────────────────────────────────────────────────────────────────────────
export function getTitle(sessionId: string) {
  return request<string>('GET', `/session/${sessionId}/title`);
}
export function getWindowHandle(sessionId: string) {
  return request<string>('GET', `/session/${sessionId}/window`);
}
export function getWindowHandles(sessionId: string) {
  return request<string[]>('GET', `/session/${sessionId}/window/handles`);
}
export function getWindowRect(sessionId: string) {
  return request<{ x: number; y: number; width: number; height: number }>('GET', `/session/${sessionId}/window/rect`);
}
export function setWindowRect(sessionId: string, rect: { x?: number; y?: number; width?: number; height?: number }) {
  return request<{ x: number; y: number; width: number; height: number }>('POST', `/session/${sessionId}/window/rect`, rect);
}
export function maximizeWindow(sessionId: string) {
  return request('POST', `/session/${sessionId}/window/maximize`, {});
}
export function minimizeWindow(sessionId: string) {
  return request('POST', `/session/${sessionId}/window/minimize`, {});
}

// ── Actions ────────────────────────────────────────────────────────────────────────────────────
export function performActions(sessionId: string, actions: unknown[]) {
  return request('POST', `/session/${sessionId}/actions`, { actions });
}
export function releaseActions(sessionId: string) {
  return request('DELETE', `/session/${sessionId}/actions`);
}

// ── Execute (extension commands + scripts) ───────────────────────────────────────────────────────
export function execute(sessionId: string, script: string, args: unknown[] = []) {
  return request('POST', `/session/${sessionId}/execute/sync`, { script, args });
}

// ── Appium device file endpoints ─────────────────────────────────────────────────────────────────
export function pushFile(sessionId: string, remotePath: string, dataB64: string) {
  return request('POST', `/session/${sessionId}/appium/device/push_file`, { path: remotePath, data: dataB64 });
}
export function pullFile(sessionId: string, remotePath: string) {
  return request<string>('POST', `/session/${sessionId}/appium/device/pull_file`, { path: remotePath });
}
export function pullFolder(sessionId: string, remotePath: string) {
  return request<string>('POST', `/session/${sessionId}/appium/device/pull_folder`, { path: remotePath });
}

// ── Generic escape hatch for endpoints not wrapped above ─────────────────────────────────────────
export function raw<T = any>(method: string, path: string, body?: unknown) {
  return request<T>(method, path, body);
}
