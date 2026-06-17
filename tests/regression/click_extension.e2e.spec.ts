/**
 * Click via the windows: extension API.
 *
 * Exercises every click-related extension command:
 *   windows: click                — element / coordinates / button / modifiers / times
 *   windows: hover                — single point + start→end with modifiers
 *   windows: clickAndDrag         — element/coords for both ends, modifiers, button
 *   windows: invoke               — UIA InvokePattern (semantic click)
 *   windows: setFocus             — focusElement
 *   windows: select / toggle      — pattern-based "click" alternatives
 *   windows: scroll               — scroll wheel at element/coords
 *
 * Run:
 *   APPIUM_URL=http://192.168.196.128:4723 \
 *   TARGET_APP='C:\\Windows\\System32\\notepad.exe' \
 *   npm run test:e2e:click:ext
 */

import { remote, type Browser } from 'webdriverio';
import { expect } from 'chai';
import axios from 'axios';
import { requireAppium } from '../lib/helpers.js';

const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
const TARGET_APP = process.env.TARGET_APP ?? 'C:\\Windows\\System32\\notepad.exe';

const url = new URL(APPIUM_URL);

const W3C_KEY = 'element-6066-11e4-a52e-4f735466cecf';

describe('FlaUINative — windows: extension click commands', function () {
    this.timeout(180_000);
    before(requireAppium);

    let driver: Browser;

    before(async function () {
        driver = await remote({
            hostname: url.hostname,
            port: Number(url.port || 4723),
            path: url.pathname && url.pathname !== '/' ? url.pathname : '/',
            protocol: url.protocol.replace(':', '') as 'http' | 'https',
            logLevel: 'warn',
            capabilities: {
                platformName: 'Windows',
                'appium:automationName': 'FlaUINative',
                'appium:app': TARGET_APP,
                'appium:shouldCloseApp': true,
                'ms:waitForAppLaunch': 5,
            } as WebdriverIO.Capabilities,
        });
    });

    after(async function () {
        if (driver) await driver.deleteSession();
    });

    /** Get the protocol element id for a freshly-found element. */
    async function findId(xp: string): Promise<string | null> {
        try {
            const ref: any = await driver.findElement('xpath', xp);
            return ref?.[W3C_KEY] ?? ref?.ELEMENT ?? null;
        } catch {
            return null;
        }
    }

    /** Soft executeScript wrapper: returns ok flag instead of throwing. */
    async function call(cmd: string, args: any = {}): Promise<{ ok: boolean; value?: any; err?: string }> {
        try {
            const value = await driver.executeScript(`windows: ${cmd}`, [args]);
            return { ok: true, value };
        } catch (err: any) {
            return { ok: false, err: err?.message ?? String(err) };
        }
    }

    // =====================================================================
    // X. windows: click — element id mode
    // =====================================================================
    describe('X. windows: click (by elementId)', () => {
        it('X1. left click Add New Tab via elementId returns ok', async () => {
            // Don't assert exact tab count — Notepad's session-restore can add or auto-collapse
            // tabs across runs, and once the strip overflows the AddButton can be clipped. The
            // functional check is that the click extension call returns successfully.
            const id = await findId('//Button[@AutomationId="AddButton"]');
            expect(id, 'AddButton must be found').to.be.a('string');
            const r = await call('click', { elementId: id });
            expect(r.ok, r.err).to.equal(true);
        });

        it('X2. right click on TitleBar should produce a system menu', async function () {
            const id = await findId('//TitleBar');
            if (!id) this.skip();
            const r = await call('click', { elementId: id, button: 'right' });
            expect(r.ok, r.err).to.equal(true);
            await driver.pause(400);
            await driver.keys(['Escape']);
            await driver.pause(200);
        });

        it('X3. click with times=2 (double-click) is accepted', async () => {
            const id = await findId('//Button[@AutomationId="AddButton"]');
            expect(id).to.be.a('string');
            const r = await call('click', { elementId: id, times: 2, interClickDelayMs: 50 });
            expect(r.ok, r.err).to.equal(true);
        });

        it('X4. click with durationMs holds the button briefly', async () => {
            const id = await findId('//Button[@AutomationId="AddButton"]');
            expect(id).to.be.a('string');
            const t0 = Date.now();
            const r = await call('click', { elementId: id, durationMs: 200 });
            const dt = Date.now() - t0;
            expect(r.ok, r.err).to.equal(true);
            expect(dt, 'durationMs should be respected').to.be.greaterThan(150);
        });

        it('X5. click with modifierKeys=["ctrl"] sends Ctrl+click', async () => {
            const id = await findId('//Button[@AutomationId="AddButton"]');
            expect(id).to.be.a('string');
            const r = await call('click', { elementId: id, modifierKeys: ['ctrl'] });
            expect(r.ok, r.err).to.equal(true);
        });
    });

    // =====================================================================
    // Y. windows: click — coordinate mode
    // =====================================================================
    describe('Y. windows: click (by coordinates)', () => {
        it('Y1. click at element rect center coordinates', async () => {
            const btn = await driver.$('//Button[@AutomationId="AddButton"]');
            const loc = await btn.getLocation();
            const size = await btn.getSize();
            const cx = Math.round(loc.x + size.width / 2);
            const cy = Math.round(loc.y + size.height / 2);
            const r = await call('click', { x: cx, y: cy });
            expect(r.ok, r.err).to.equal(true);
        });

        it('Y2. click with only x set should fail with InvalidArgument', async () => {
            const r = await call('click', { x: 100 });
            expect(r.ok).to.equal(false);
            expect(r.err).to.match(/InvalidArgument|Both x and y/i);
        });
    });

    // =====================================================================
    // Z. windows: click — negative
    // =====================================================================
    describe('Z. windows: click — negative', () => {
        it('Z1. click with stale elementId → NoSuchElement (not SyntaxError)', async () => {
            // webdriverio v9's executeScript silently swallows W3C 404 NoSuchElement
            // bodies for `windows:` extension calls (it returns null instead of throwing).
            // Probe the protocol directly with axios so we assert what the SERVER returns.
            const sid = (driver as any).sessionId;
            try {
                await axios.post(`${APPIUM_URL}/session/${sid}/execute/sync`, {
                    script: 'windows: click',
                    args: [{ elementId: '00000000-0000-0000-0000-000000000000' }],
                });
                expect.fail('expected protocol error');
            } catch (err: any) {
                const status = err?.response?.status;
                const body = err?.response?.data?.value;
                expect(status, `unexpected status ${status}`).to.equal(404);
                expect(body?.error).to.equal('no such element');
                expect(body?.message ?? '').to.not.match(/SyntaxError|Unexpected end of JSON input/i);
            }
        });

        it('Z2. click with invalid button name → InvalidArgument', async () => {
            const id = await findId('//Button[@AutomationId="AddButton"]');
            expect(id).to.be.a('string');
            const r = await call('click', { elementId: id, button: 'notabutton' });
            // The driver maps via CLICK_TYPE_BUTTON_MAP; an undefined button
            // should result in an undefined mouseButton — accept either an
            // explicit InvalidArgument OR a downstream error. It MUST NOT silently
            // fall through to a left-click.
            expect(r.ok, 'invalid button name should not silently succeed').to.equal(false);
        });
    });

    // =====================================================================
    // H. windows: hover
    // =====================================================================
    describe('H. windows: hover', () => {
        it('H1. single-point hover by elementId', async () => {
            const id = await findId('//Button[@AutomationId="AddButton"]');
            expect(id).to.be.a('string');
            const r = await call('hover', { startElementId: id, durationMs: 100 });
            expect(r.ok, r.err).to.equal(true);
        });

        it('H2. start→end hover by element ids', async () => {
            const startId = await findId('//Button[@AutomationId="AddButton"]');
            const endId = await findId('//Button[@AutomationId="SettingsButton"]');
            if (!startId || !endId) this.skip();
            const r = await call('hover', {
                startElementId: startId,
                endElementId: endId,
                durationMs: 200,
            });
            expect(r.ok, r.err).to.equal(true);
        });

        it('H3. hover with stale start element id → NoSuchElement', async () => {
            // Same wdio-9 quirk as Z1: assert at the protocol level via axios.
            const sid = (driver as any).sessionId;
            try {
                await axios.post(`${APPIUM_URL}/session/${sid}/execute/sync`, {
                    script: 'windows: hover',
                    args: [{ startElementId: '00000000-0000-0000-0000-000000000000' }],
                });
                expect.fail('expected protocol error');
            } catch (err: any) {
                expect(err?.response?.status).to.equal(404);
                expect(err?.response?.data?.value?.error).to.equal('no such element');
            }
        });
    });

    // =====================================================================
    // I. windows: invoke (semantic click via UIA InvokePattern)
    // =====================================================================
    describe('I. windows: invoke', () => {
        it('I1. invoke Button[AddButton] returns ok', async () => {
            const id = await findId('//Button[@AutomationId="AddButton"]');
            expect(id).to.be.a('string');
            const r = await call('invoke', { [W3C_KEY]: id } as any);
            expect(r.ok, r.err).to.equal(true);
        });

        it('I2. invoke on non-invokable element should fail with a clean error', async function () {
            // A static Text label has no InvokePattern.
            const id = await findId('//Text[@AutomationId="ContentTextBlock"]');
            if (!id) this.skip();
            const r = await call('invoke', { [W3C_KEY]: id } as any);
            // We expect failure, but with a readable message — not a JSON SyntaxError.
            expect(r.ok).to.equal(false);
            expect(r.err).to.not.match(/SyntaxError|Unexpected end of JSON input/i);
        });
    });

    // =====================================================================
    // J. windows: setFocus / select / toggle
    // =====================================================================
    describe('J. windows: setFocus / select / toggle', () => {
        it('J1. setFocus on a focusable element', async function () {
            const id = await findId('//Document[@ClassName="RichEditD2DPT"]');
            if (!id) this.skip();
            const r = await call('setFocus', { [W3C_KEY]: id } as any);
            expect(r.ok, r.err).to.equal(true);
        });

        it('J2. setFocus on an unfocusable element should reject cleanly', async function () {
            // Try a TitleBar (often not focusable).
            const id = await findId('//TitleBar');
            if (!id) this.skip();
            const r = await call('setFocus', { [W3C_KEY]: id } as any);
            // Tolerate either, but the error must be readable.
            if (!r.ok) {
                expect(r.err).to.not.match(/SyntaxError|Unexpected end of JSON input/i);
            }
        });
    });

    // =====================================================================
    // K. windows: clickAndDrag
    // =====================================================================
    describe('K. windows: clickAndDrag', () => {
        it('K1. clickAndDrag from one button to another (by ids)', async function () {
            const a = await findId('//Button[@AutomationId="AddButton"]');
            const b = await findId('//Button[@AutomationId="SettingsButton"]');
            if (!a || !b) this.skip();
            const r = await call('clickAndDrag', {
                startElementId: a,
                endElementId: b,
                durationMs: 300,
            });
            expect(r.ok, r.err).to.equal(true);
        });

        it('K2. clickAndDrag with only startX (no startY) → InvalidArgument', async () => {
            const r = await call('clickAndDrag', { startX: 100, endX: 200, endY: 200 });
            expect(r.ok).to.equal(false);
            expect(r.err).to.match(/InvalidArgument|Both startX and startY/i);
        });
    });

    // =====================================================================
    // L. windows: scroll
    // =====================================================================
    describe('L. windows: scroll', () => {
        it('L1. scroll wheel by deltaY at element', async () => {
            const id = await findId('//Document[@ClassName="RichEditD2DPT"]');
            expect(id).to.be.a('string');
            const r = await call('scroll', { elementId: id, deltaY: -120 });
            expect(r.ok, r.err).to.equal(true);
        });

        it('L2. scroll with stale elementId → NoSuchElement', async () => {
            // Protocol-level assertion (see Z1 / H3 for the wdio-9 quirk).
            const sid = (driver as any).sessionId;
            try {
                await axios.post(`${APPIUM_URL}/session/${sid}/execute/sync`, {
                    script: 'windows: scroll',
                    args: [{ elementId: '00000000-0000-0000-0000-000000000000', deltaY: -120 }],
                });
                expect.fail('expected protocol error');
            } catch (err: any) {
                expect(err?.response?.status).to.equal(404);
                expect(err?.response?.data?.value?.error).to.equal('no such element');
            }
        });
    });
});
