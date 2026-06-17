// Shared, environment-independent helpers for the FlaUINative W3C conformance suite.
//
// Principles enforced here:
//  - Self-cleaning: SessionPool tracks every session it opens and force-deletes them in afterEach.
//  - OS-version-independent element discovery: NO Win11 AutomationIds. The editable text control of the
//    target app is found generically (class name=Edit, or tag name=Document/Edit fallbacks).
//  - Protocol-exact assertions live in the specs; helpers only locate/clean.

import { expect } from 'chai';
import * as w3c from './w3c-client.js';

export { w3c };
export const { W3C_ELEMENT_KEY, TARGET_APP, APPIUM_URL } = w3c;

/** Tracks opened sessions so a single afterEach can guarantee no leaked Notepads. */
export class SessionPool {
  private ids = new Set<string>();

  /** Create a session with the given extra caps; default app = TARGET_APP. Tracks the id for cleanup. */
  async open(extraCaps: Record<string, unknown> = {}): Promise<string> {
    // Any explicit launch/attach cap suppresses the default app. appName (window-title regex) and
    // processName (exact exe) are the post-redesign attach modes alongside app/appTopLevelWindow.
    const hasTarget = ['appium:app', 'appium:appTopLevelWindow', 'appium:appName', 'appium:processName']
      .some((k) => k in extraCaps);
    const merged = hasTarget ? extraCaps : { 'appium:app': TARGET_APP, ...extraCaps };
    const res = await w3c.newSession(merged);
    if (res.status !== 200 || !res.value?.sessionId) {
      throw new Error(`newSession failed: ${res.status} ${res.raw?.slice(0, 300)}`);
    }
    this.ids.add(res.value.sessionId);
    return res.value.sessionId;
  }

  /** Register an externally-created session id for cleanup. */
  track(id: string | undefined): void {
    if (id) this.ids.add(id);
  }

  /** Forget a session (e.g. after an intentional delete) so cleanup does not double-delete. */
  forget(id: string | undefined): void {
    if (id) this.ids.delete(id);
  }

  /** Delete every tracked session, ignoring errors. Call from afterEach. */
  async cleanup(): Promise<void> {
    for (const id of [...this.ids]) {
      try { await w3c.deleteSession(id); } catch { /* ignore */ }
      this.ids.delete(id);
    }
  }
}

/**
 * Find the editable text control of the target app, OS-version-independently.
 * Notepad's editor is a `class name=Edit` on classic builds and a Document/RichEdit on others.
 * Returns the element id, or throws with diagnostics.
 */
export async function findEditable(sessionId: string): Promise<string> {
  const attempts: Array<[w3c.Using, string]> = [
    ['class name', 'Edit'],
    ['tag name', 'Document'],
    ['tag name', 'Edit'],
    ['class name', 'RichEditD2DPT'],
  ];
  const tried: string[] = [];
  for (const [using, value] of attempts) {
    const res = await w3c.findElement(sessionId, using, value);
    tried.push(`${using}=${value} -> ${res.status}`);
    if (res.status === 200) {
      const id = w3c.elementId(res.value);
      if (id) return id;
    }
  }
  throw new Error(`could not locate editable control. tried: ${tried.join('; ')}`);
}

/**
 * Find the top-level window element of the target app, OS-version-independently.
 * Tries tag name=Window first (control type), then class name=Notepad as a fallback.
 */
export async function findWindow(sessionId: string): Promise<string> {
  const attempts: Array<[w3c.Using, string]> = [
    ['tag name', 'Window'],
    ['class name', 'Notepad'],
    ['class name', 'ApplicationFrameWindow'],
  ];
  const tried: string[] = [];
  for (const [using, value] of attempts) {
    const res = await w3c.findElement(sessionId, using, value);
    tried.push(`${using}=${value} -> ${res.status}`);
    if (res.status === 200) {
      const id = w3c.elementId(res.value);
      if (id) return id;
    }
  }
  throw new Error(`could not locate top-level window. tried: ${tried.join('; ')}`);
}

/** Assert a base64 string decodes to a PNG (magic bytes 89 50 4E 47 0D 0A 1A 0A). */
export function assertPng(b64: unknown, label = 'image'): Buffer {
  expect(b64, `${label} should be a base64 string`).to.be.a('string');
  const buf = Buffer.from(b64 as string, 'base64');
  expect(buf.length, `${label} should be non-empty`).to.be.greaterThan(0);
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < magic.length; i++) {
    expect(buf[i], `${label} PNG magic byte ${i}`).to.equal(magic[i]);
  }
  return buf;
}

/** Assert a string is well-formed-ish XML by structural parsing (no external deps). Returns a tiny check API. */
export function parseXml(xml: unknown): { tagCount: number; depthOk: boolean; text: string } {
  expect(xml, 'source should be a string').to.be.a('string');
  const text = xml as string;
  // Balance check: every opening tag (not self-closing, not <?...?>) must close.
  const stack: string[] = [];
  const tagRe = /<\/?([A-Za-z_][\w.\-]*)([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let tagCount = 0;
  let maxDepth = 0;
  let balanced = true;
  while ((m = tagRe.exec(text))) {
    const whole = m[0];
    const name = m[1];
    const selfClose = m[3] === '/' || whole.startsWith('<?') ;
    if (whole.startsWith('</')) {
      const top = stack.pop();
      if (top !== name) { balanced = false; break; }
    } else if (!selfClose) {
      stack.push(name);
      tagCount++;
      maxDepth = Math.max(maxDepth, stack.length);
    } else {
      tagCount++;
    }
  }
  if (stack.length !== 0) balanced = false;
  expect(balanced, 'XML tags should be balanced').to.equal(true);
  return { tagCount, depthOk: maxDepth >= 2, text };
}

/** Sleep helper. */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Mocha `before` hook: skip the suite cleanly when no Appium server is reachable at APPIUM_URL.
 *
 * E2E/regression/smoke require a live Appium (with this driver) on a Windows host. Gating is by SERVER
 * REACHABILITY, not local `process.platform` — APPIUM_URL may point at a remote Windows host from a
 * non-Windows dev box. When the server is down (the common dev/CI case), the suite SKIPS with a clear
 * reason instead of failing with opaque connection errors.
 *
 * Usage: add `before(requireAppium)` as the first hook in each E2E describe.
 */
export async function requireAppium(this: Mocha.Context): Promise<void> {
  try {
    const res = await fetch(APPIUM_URL + '/status', { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`  ↷ skipping: no Appium server at ${APPIUM_URL} (${(e as Error).message}) — set APPIUM_URL`);
    this.skip();
  }
}

/**
 * Bring the target app window to the foreground so synthetic pointer/keyboard input lands on it.
 * On a shared interactive desktop other windows can overlap; this makes focus-sensitive tests robust
 * without hard-coding any window geometry. Best-effort: ignores errors from setProcessForeground.
 */
export async function bringToFront(sessionId: string, _processName = 'notepad'): Promise<void> {
  // Foreground the SESSION's own window by HWND (Win32 SetForegroundWindow + AttachThreadInput) — reliable
  // with multiple windows / foreground-lock, unlike process-name activation.
  try { await w3c.execute(sessionId, 'windows: setWindowForeground', []); } catch { /* ignore */ }
  await sleep(200);
}

/** A small valid 2x2 red PNG, base64 — for image clipboard roundtrips. */
export const TEST_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAjlwMBSEgvwQAAAABJRU5ErkJggg==';

/** UTF-8 string -> base64. */
export const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
/** base64 -> UTF-8 string. */
export const unb64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');
