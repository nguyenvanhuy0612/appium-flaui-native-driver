/**
 * Wider smoke probe — areas not covered by the click suites.
 * Looking for new defects in: text input / setValue, getAttribute,
 * window state, screenshot, getElementText, isDisplayed, isEnabled,
 * pattern handlers without ensureElementResolved.
 *
 * Run:
 *   APPIUM_URL=http://192.168.196.128:4723 \
 *   TARGET_APP='C:\\Windows\\System32\\notepad.exe' \
 *   npm run test:e2e:smoke:more
 */

import { remote, type Browser } from 'webdriverio';
import { expect } from 'chai';
import axios from 'axios';

const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
const TARGET_APP = process.env.TARGET_APP ?? 'C:\\Windows\\System32\\notepad.exe';
const url = new URL(APPIUM_URL);

const W3C_KEY = 'element-6066-11e4-a52e-4f735466cecf';

describe('FlaUINative — wider smoke', function () {
    this.timeout(180_000);

    let driver: Browser;
    let sid: string;

    before(async function () {
        driver = await remote({
            hostname: url.hostname,
            port: Number(url.port || 4723),
            path: '/',
            protocol: 'http',
            logLevel: 'error',
            capabilities: {
                platformName: 'Windows',
                'appium:automationName': 'FlaUINative',
                'appium:app': TARGET_APP,
                'appium:shouldCloseApp': true,
                'ms:waitForAppLaunch': 5,
            } as WebdriverIO.Capabilities,
        });
        sid = (driver as any).sessionId;
    });

    after(async function () { if (driver) await driver.deleteSession(); });

    // -----------------------------------------------------------------
    // Text input
    // -----------------------------------------------------------------
    describe('text input', () => {
        it('keys() types text into the focused editor', async () => {
            const doc = await driver.$('//Document[@ClassName="RichEditD2DPT"]');
            await doc.click();
            await driver.pause(200);
            await driver.keys('hello world');
            await driver.pause(200);
            // Page source may not reflect text content, but operation must not throw
        });
    });

    // -----------------------------------------------------------------
    // getElementAttribute / getElementText
    // -----------------------------------------------------------------
    describe('attributes & text', () => {
        it('getAttribute(Name) on root window returns non-empty', async () => {
            const win = await driver.$('//Window[@ClassName="Notepad"]');
            const name = await win.getAttribute('Name');
            expect(name).to.be.a('string').and.have.length.greaterThan(0);
        });

        it('getAttribute on stale id throws or returns null cleanly', async () => {
            try {
                const r = await axios.post(`${APPIUM_URL}/session/${sid}/element/00000000-0000-0000-0000-000000000000/attribute/Name`);
                // Some drivers return 200 with null value; either is acceptable as long
                // as it isn't a 500 with a JSON parse error.
                expect(r.data?.value ?? null).to.satisfy((v: any) => v === null || typeof v === 'string');
            } catch (err: any) {
                expect(err?.response?.status).to.be.oneOf([404]);
                expect(err?.response?.data?.value?.message ?? '').to.not.match(/SyntaxError|Unexpected end of JSON input/i);
            }
        });

        it('getText() on a Text element', async function () {
            const txts = await driver.$$('//Text');
            if (txts.length === 0) this.skip();
            const t = await txts[0].getText();
            expect(t).to.be.a('string');
        });
    });

    // -----------------------------------------------------------------
    // Window management
    // -----------------------------------------------------------------
    describe('window management', () => {
        it('getWindowRect returns a sensible rect', async () => {
            const r = await driver.getWindowRect();
            expect(r.width).to.be.greaterThan(0);
            expect(r.height).to.be.greaterThan(0);
        });

        it('maximizeWindow then minimizeWindow then restore', async () => {
            await driver.maximizeWindow();
            await driver.pause(200);
            await driver.minimizeWindow();
            await driver.pause(200);
            // Restore the window so subsequent tests see a visible UI.
            // Use the windows: restore extension on the root window.
            const win = await driver.$('//Window[@ClassName="Notepad"]');
            await driver.executeScript('windows: restore', [{
                [W3C_KEY]: win.elementId,
            }]);
            await driver.pause(300);
        });

        it('takeScreenshot returns a non-empty base64 PNG', async () => {
            const b64 = await driver.takeScreenshot();
            expect(b64).to.be.a('string').and.have.length.greaterThan(100);
            // PNG starts with iVBORw0
            expect(b64.startsWith('iVBOR')).to.equal(true);
        });
    });

    // -----------------------------------------------------------------
    // Element states
    // -----------------------------------------------------------------
    describe('element states', () => {
        it('isDisplayed / isEnabled on a real element', async () => {
            const win = await driver.$('//Window[@ClassName="Notepad"]');
            const offscreen = await win.getAttribute('IsOffscreen');
            const enabled  = await win.getAttribute('IsEnabled');
            console.log(`Notepad Window IsOffscreen=${offscreen} IsEnabled=${enabled}`);
            expect(await win.isDisplayed(), `isDisplayed; IsOffscreen=${offscreen}`).to.equal(true);
            expect(await win.isEnabled(),  `isEnabled;  IsEnabled=${enabled}`).to.equal(true);
        });

        it('isDisplayed on stale id should not crash session', async () => {
            try {
                const r = await axios.get(`${APPIUM_URL}/session/${sid}/element/00000000-0000-0000-0000-000000000000/displayed`);
                // accept null or boolean
                expect([null, true, false]).to.include(r.data?.value);
            } catch (err: any) {
                expect(err?.response?.status).to.be.oneOf([404]);
            }
        });
    });

    // -----------------------------------------------------------------
    // Pattern operations on stale id (D11 candidates: invoke/expand/etc.
    // also need ensureElementResolved or proper error mapping)
    // -----------------------------------------------------------------
    describe('pattern ops on stale id (looking for new defects)', () => {
        const cases = [
            { name: 'invoke',  args: { [W3C_KEY]: '00000000-0000-0000-0000-000000000000' } },
            { name: 'expand',  args: { [W3C_KEY]: '00000000-0000-0000-0000-000000000000' } },
            { name: 'collapse',args: { [W3C_KEY]: '00000000-0000-0000-0000-000000000000' } },
            { name: 'select',  args: { [W3C_KEY]: '00000000-0000-0000-0000-000000000000' } },
            { name: 'toggle',  args: { [W3C_KEY]: '00000000-0000-0000-0000-000000000000' } },
            { name: 'setFocus',args: { [W3C_KEY]: '00000000-0000-0000-0000-000000000000' } },
            { name: 'maximize',args: { [W3C_KEY]: '00000000-0000-0000-0000-000000000000' } },
            { name: 'minimize',args: { [W3C_KEY]: '00000000-0000-0000-0000-000000000000' } },
            { name: 'restore', args: { [W3C_KEY]: '00000000-0000-0000-0000-000000000000' } },
            { name: 'close',   args: { [W3C_KEY]: '00000000-0000-0000-0000-000000000000' } },
        ];

        for (const c of cases) {
            it(`windows: ${c.name} on stale id should not be a 5xx with JSON parse error`, async () => {
                try {
                    await axios.post(`${APPIUM_URL}/session/${sid}/execute/sync`, {
                        script: `windows: ${c.name}`,
                        args: [c.args],
                    });
                    // Tolerate silent success — some pattern commands are no-ops on null.
                } catch (err: any) {
                    const status = err?.response?.status;
                    const msg = err?.response?.data?.value?.message ?? '';
                    expect(msg).to.not.match(/SyntaxError|Unexpected end of JSON input/i);
                    // Should NOT be a 500 (UnknownError). Should be 404 NoSuchElement OR
                    // 400 InvalidArgument OR 404 NotFound. 500 means we leak a raw failure.
                    expect(status, `${c.name} returned ${status}: ${msg.slice(0, 100)}`).to.not.equal(500);
                }
            });
        }
    });

    // -----------------------------------------------------------------
    // Misc extensions on stale id (looking for unguarded sendPowerShellCommand)
    // -----------------------------------------------------------------
    describe('misc extensions', () => {
        it('windows: getAttributes with stale id', async () => {
            try {
                await axios.post(`${APPIUM_URL}/session/${sid}/execute/sync`, {
                    script: 'windows: getAttributes',
                    args: [{ elementId: '00000000-0000-0000-0000-000000000000' }],
                });
            } catch (err: any) {
                expect(err?.response?.data?.value?.message ?? '').to.not.match(/SyntaxError|Unexpected end of JSON input/i);
                expect(err?.response?.status).to.not.equal(500);
            }
        });
    });
});
