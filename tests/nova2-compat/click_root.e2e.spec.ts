/**
 * Root-scope click test — appium:app=Root (whole desktop tree).
 *
 * Run:
 *   APPIUM_URL=http://192.168.196.128:4723 npm run test:e2e:click:root
 */

import { remote, type Browser } from 'webdriverio';
import { expect } from 'chai';
import axios from 'axios';

const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
const url = new URL(APPIUM_URL);

describe('NovaWindows2 — click (Root scope: Desktop)', function () {
    this.timeout(120_000);

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
                'appium:app': 'Root',
                'appium:powerShellCommandTimeout': 60_000,
            } as WebdriverIO.Capabilities,
        });
    });

    after(async function () {
        if (driver) await driver.deleteSession();
    });

    async function softClick(el: WebdriverIO.Element): Promise<{ ok: boolean; err?: string }> {
        try {
            await el.click();
            return { ok: true };
        } catch (err: any) {
            return { ok: false, err: err?.message ?? String(err) };
        }
    }

    // =====================================================================
    // R. ROOT — sanity / discovery
    // =====================================================================
    describe('R. Root scope sanity', () => {
        it('R1. getPageSource returns a Pane/Window root', async () => {
            const src = await driver.getPageSource();
            expect(src).to.be.a('string').and.have.length.greaterThan(0);
            expect(/<Pane|<Window/.test(src)).to.equal(true);
        });

        it('R2. taskbar (Shell_TrayWnd) is reachable', async () => {
            const tray = await driver.$$('//*[@ClassName="Shell_TrayWnd"]');
            expect(tray.length).to.be.greaterThan(0);
        });

        it('R3. at least one top-level Window enumerable', async () => {
            const wins = await driver.$$('//Window');
            expect(wins.length).to.be.greaterThan(0);
        });
    });

    // =====================================================================
    // S. ROOT POSITIVE — click reachable desktop UI
    // =====================================================================
    describe('S. Root scope positive clicks', () => {
        it('S1. click Start button', async function () {
            const candidates = [
                '//Button[@AutomationId="StartButton"]',
                '//*[@ClassName="Shell_TrayWnd"]//Button[@Name="Start"]',
                '//Button[@Name="Start"]',
            ];
            let btn: WebdriverIO.Element | null = null;
            for (const xp of candidates) {
                const list = await driver.$$(xp);
                if (list.length > 0) { btn = list[0]; break; }
            }
            if (!btn) this.skip();

            const r = await softClick(btn);
            expect(r.ok, r.err).to.equal(true);
            await driver.pause(800);
            await driver.keys(['Escape']);
            await driver.pause(300);
        });

        it('S2. click a Taskbar tray button (Search/Task View)', async function () {
            const candidates = [
                '//Button[@Name="Search"]',
                '//Button[@AutomationId="SearchButton"]',
                '//Button[@Name="Task view"]',
            ];
            let btn: WebdriverIO.Element | null = null;
            for (const xp of candidates) {
                const list = await driver.$$(xp);
                if (list.length > 0) { btn = list[0]; break; }
            }
            if (!btn) this.skip();

            const r = await softClick(btn);
            expect(r.ok, r.err).to.equal(true);
            await driver.pause(500);
            await driver.keys(['Escape']);
            await driver.pause(300);
        });

        it('S3. click any TitleBar of an open window', async function () {
            const titleBars = await driver.$$('//Window//TitleBar');
            if (titleBars.length === 0) this.skip();
            const r = await softClick(titleBars[0]);
            expect(r.ok, r.err).to.equal(true);
        });
    });

    // =====================================================================
    // T. ROOT NEGATIVE — failure modes
    // =====================================================================
    describe('T. Root scope negative', () => {
        it('T1. find non-existent element → NoSuchElement', async () => {
            try {
                await driver.findElement('xpath', "//Button[@AutomationId='__definitely_not_here__']");
                expect.fail('expected NoSuchElement');
            } catch (err: any) {
                const m = err?.message ?? String(err);
                expect(/NoSuchElement|no such element/i.test(m), `got: ${m}`).to.equal(true);
            }
        });

        it('T2. malformed xpath → InvalidSelector', async () => {
            try {
                await driver.findElement('xpath', '//Button[@Name=');
                expect.fail('expected InvalidSelector');
            } catch (err: any) {
                const m = err?.message ?? String(err);
                expect(/InvalidSelector|invalid selector|Malformed XPath/i.test(m), `got: ${m}`).to.equal(true);
            }
        });

        it('T3. click offscreen element must not crash session', async function () {
            const offscreen = await driver.$$('//*[@IsOffscreen="True"]');
            if (offscreen.length === 0) this.skip();
            await softClick(offscreen[0]);
            const ok = await driver.getPageSource().then(() => true).catch(() => false);
            expect(ok, 'session unusable after offscreen click').to.equal(true);
        });

        it('T4. click stale element id → W3C 404 NoSuchElement (NOT SyntaxError)', async () => {
            // Protocol-level assertion (wdio v9 swallows the 404 from elementClick).
            const sid = (driver as any).sessionId;
            try {
                await axios.post(`${APPIUM_URL}/session/${sid}/element/00000000-0000-0000-0000-000000000000/click`, {});
                expect.fail('expected protocol error');
            } catch (err: any) {
                expect(err?.response?.status).to.equal(404);
                expect(err?.response?.data?.value?.error).to.equal('no such element');
                expect(err?.response?.data?.value?.message ?? '').to.not.match(/SyntaxError|Unexpected end of JSON input/i);
            }
        });
    });
});
