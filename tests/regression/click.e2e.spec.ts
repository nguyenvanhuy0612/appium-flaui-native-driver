/**
 * Comprehensive click test — app-scoped (Notepad) FlaUINative session.
 *
 * Run:
 *   APPIUM_URL=http://192.168.196.128:4723 \
 *   TARGET_APP='C:\\Windows\\System32\\notepad.exe' \
 *   npm run test:e2e:click
 */

import { remote, type Browser } from 'webdriverio';
import { expect } from 'chai';
import axios from 'axios';
import { requireAppium } from '../lib/helpers.js';

const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
const TARGET_APP = process.env.TARGET_APP ?? 'C:\\Windows\\System32\\notepad.exe';

const url = new URL(APPIUM_URL);

describe('FlaUINative — click (app scope: Notepad)', function () {
    this.timeout(120_000);
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

    /** Soft click: returns ok flag instead of throwing, for negative-case branching. */
    async function softClick(el: WebdriverIO.Element): Promise<{ ok: boolean; err?: string }> {
        try {
            await el.click();
            return { ok: true };
        } catch (err: any) {
            return { ok: false, err: err?.message ?? String(err) };
        }
    }

    // =====================================================================
    // A. POSITIVE — single click via various locators
    //
    // Test order matters: clicking the Settings button in Notepad navigates
    // away from the main view and removes the toolbar, hiding AddButton,
    // SettingsButton, the tab strip, etc. So Settings-touching tests run LAST.
    // =====================================================================
    describe('A. Positive — single click', () => {
        it('A1. click Button by xpath (Add New Tab) does not error', async () => {
            // Don't assert exact tab count — Notepad's session-restore may add or auto-collapse tabs,
            // and once the tab strip overflows, the AddButton can be clipped. The functional check is
            // that the click itself returns successfully.
            const btn = await driver.$('//Button[@AutomationId="AddButton"]');
            await btn.click();
            await driver.pause(400);
        });

        it('A2. click MenuItem (File) opens dropdown', async () => {
            const file = await driver.$('//MenuItem[@AutomationId="File"]');
            await file.click();
            await driver.pause(400);
            const newItems = await driver.$$("//MenuItem[contains(@Name,'New')]");
            expect(newItems.length).to.be.greaterThan(0);
            await driver.keys(['Escape']);
            await driver.pause(200);
        });

        it('A3. click first TabItem selects it', async function () {
            const tabs = await driver.$$('//TabItem');
            if (tabs.length === 0) this.skip();
            const r = await softClick(tabs[0]);
            expect(r.ok, r.err).to.equal(true);
        });

        it('A4. element-scoped find then click', async () => {
            const root = await driver.$('//Window[@ClassName="Notepad"]');
            const addBtn = await root.$('.//Button[@AutomationId="AddButton"]');
            const r = await softClick(addBtn);
            expect(r.ok, r.err).to.equal(true);
        });

        it('A5. find by tag (//Button) then click first', async function () {
            const btns = await driver.$$('//Button');
            if (btns.length === 0) this.skip();
            const r = await softClick(btns[0]);
            expect(r.ok, r.err).to.equal(true);
        });

        it('A6. click same locator twice in a row', async () => {
            const btn1 = await driver.$('//Button[@AutomationId="AddButton"]');
            const r1 = await softClick(btn1);
            const btn2 = await driver.$('//Button[@AutomationId="AddButton"]');
            const r2 = await softClick(btn2);
            expect(r1.ok, r1.err).to.equal(true);
            expect(r2.ok, r2.err).to.equal(true);
        });

        it('A7. click toolbar Button by accessibility id (~AddButton)', async () => {
            const btn = await driver.$('~AddButton');
            const r = await softClick(btn);
            expect(r.ok, r.err).to.equal(true);
        });
    });

    // =====================================================================
    // B. W3C ACTIONS API — pointerMove + pointerDown + pointerUp
    // =====================================================================
    describe('B. W3C Actions API', () => {
        it('B1. performActions tap via element rect center', async () => {
            const btn = await driver.$('//Button[@AutomationId="AddButton"]');
            const loc = await btn.getLocation();
            const size = await btn.getSize();
            const cx = Math.round(loc.x + size.width / 2);
            const cy = Math.round(loc.y + size.height / 2);
            await driver.performActions([{
                type: 'pointer',
                id: 'mouse1',
                parameters: { pointerType: 'mouse' },
                actions: [
                    { type: 'pointerMove', duration: 0, x: cx, y: cy },
                    { type: 'pointerDown', button: 0 },
                    { type: 'pause', duration: 50 },
                    { type: 'pointerUp', button: 0 },
                ],
            }]);
            await driver.releaseActions();
        });
    });

    // =====================================================================
    // C. NEGATIVE — failure modes that must surface clean W3C errors
    // =====================================================================
    describe('C. Negative — invalid clicks must produce W3C errors', () => {
        it('C1. findElement on missing element → NoSuchElement', async () => {
            try {
                await driver.findElement('xpath', "//Button[@Name='__no_such_button__']");
                expect.fail('expected NoSuchElement');
            } catch (err: any) {
                const m = err?.message ?? String(err);
                expect(/NoSuchElement|no such element/i.test(m), `got: ${m}`).to.equal(true);
            }
        });

        it('C2. findElement with malformed xpath → InvalidSelector / Malformed', async () => {
            try {
                await driver.findElement('xpath', '//Button[@Name=');
                expect.fail('expected error');
            } catch (err: any) {
                const m = err?.message ?? String(err);
                // Driver currently returns "Malformed XPath: ...". Per W3C this should be
                // InvalidSelectorError. Accept either, but fail loudly on UnknownError/UIA crashes.
                expect(/InvalidSelector|invalid selector|Malformed XPath/i.test(m), `got: ${m}`).to.equal(true);
            }
        });

        it('C3. click stale/unknown element id → NoSuchElement (NOT SyntaxError)', async () => {
            // wdio v9 doesn't reliably surface 404 NoSuchElement from elementClick — assert
            // at the protocol level instead so we test what the driver actually returns.
            const sid = (driver as any).sessionId;
            try {
                await axios.post(`${APPIUM_URL}/session/${sid}/element/00000000-0000-0000-0000-000000000000/click`, {});
                expect.fail('expected protocol error');
            } catch (err: any) {
                const status = err?.response?.status;
                const body = err?.response?.data?.value;
                expect(status, `unexpected status ${status}`).to.equal(404);
                expect(body?.error).to.equal('no such element');
                expect(body?.message ?? '').to.not.match(/SyntaxError|Unexpected end of JSON input/i);
            }
        });

        it('C4. click offscreen element rejects or is a no-op — must not crash session', async function () {
            const offscreen = await driver.$$('//*[@IsOffscreen="True"]');
            if (offscreen.length === 0) this.skip();
            const r = await softClick(offscreen[0]);
            if (!r.ok) {
                expect(/not\s*interactable|offscreen|invisible|out\s*of\s*bounds/i.test(r.err!), `got: ${r.err}`).to.equal(true);
            }
            const ok = await driver.$('//Window').then(() => true).catch(() => false);
            expect(ok, 'session crashed after clicking offscreen element').to.equal(true);
        });

        it('C5. click disabled element rejects or is a no-op — must not crash session', async function () {
            const disabled = await driver.$$('//*[@IsEnabled="False"]');
            if (disabled.length === 0) this.skip();
            const r = await softClick(disabled[0]);
            if (!r.ok) {
                expect(/not\s*interactable|disabled|cannot/i.test(r.err!), `got: ${r.err}`).to.equal(true);
            }
            const ok = await driver.$('//Window').then(() => true).catch(() => false);
            expect(ok, 'session crashed after clicking disabled element').to.equal(true);
        });

        it('C6. element-scoped find with no match → NoSuchElement (protocol)', async () => {
            const rootRef: any = await driver.findElement('xpath', '//Window');
            const rootId = rootRef['element-6066-11e4-a52e-4f735466cecf'] ?? rootRef.ELEMENT;
            try {
                await driver.findElementFromElement(rootId, 'xpath', "./Button[@Name='__nope__']");
                expect.fail('expected NoSuchElement');
            } catch (err: any) {
                const m = err?.message ?? String(err);
                expect(/NoSuchElement|no such element/i.test(m), `got: ${m}`).to.equal(true);
            }
        });
    });
});
