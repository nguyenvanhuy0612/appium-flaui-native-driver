/**
 * FlaUINative driver smoke test.
 *
 * Verifies the freshly deployed driver is registered with Appium and can
 * drive a real Windows session end-to-end:
 *   1. Create a session with automationName=NovaWindows2.
 *   2. Read the active window name.
 *   3. Dump page source.
 *   4. Find at least one element via XPath.
 *   5. Tear down cleanly.
 *
 * Run:
 *   APPIUM_URL=http://192.168.196.128:4723 \
 *   TARGET_APP='C:\\Windows\\System32\\notepad.exe' \
 *   npm run test:e2e:smoke
 */

import { remote, type Browser } from 'webdriverio';
import { expect } from 'chai';

const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
const TARGET_APP = process.env.TARGET_APP ?? 'C:\\Windows\\System32\\notepad.exe';

const url = new URL(APPIUM_URL);

describe('FlaUINative driver — smoke', function () {
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
                'appium:app': TARGET_APP,
                'appium:shouldCloseApp': true,
                'appium:powerShellCommandTimeout': 60_000,
                'ms:waitForAppLaunch': 5,
            } as WebdriverIO.Capabilities,
        });
    });

    after(async function () {
        if (driver) await driver.deleteSession();
    });

    it('creates a NovaWindows2 session', function () {
        expect(driver).to.exist;
        expect(driver.sessionId).to.be.a('string').and.not.empty;
    });

    it('returns a non-empty page source', async function () {
        const source = await driver.getPageSource();
        expect(source).to.be.a('string').and.have.length.greaterThan(0);
        expect(source).to.match(/<\w+/);
    });

    it('finds the root //Window element', async function () {
        const root = await driver.findElement('xpath', '//Window');
        expect(root).to.exist;
    });

    it('finds at least one descendant via //*', async function () {
        const els = await driver.findElements('xpath', '//*');
        expect(els.length).to.be.greaterThan(0);
    });

    it('reads @Name attribute on the root window', async function () {
        const root = await driver.findElement('xpath', '//Window');
        const name = await driver.getElementAttribute(root.elementId, 'Name');
        expect(name).to.be.a('string');
    });
});
