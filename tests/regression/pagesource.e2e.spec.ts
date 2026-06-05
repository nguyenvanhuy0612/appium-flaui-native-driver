/**
 * Minimal page-source test for the FlaUINative driver.
 *
 * Run:
 *   APPIUM_URL=http://192.168.196.128:4723 \
 *   TARGET_APP='C:\\Windows\\System32\\notepad.exe' \
 *   npm run test:e2e:pagesource
 */

import { remote, type Browser } from 'webdriverio';
import { expect } from 'chai';

const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
const TARGET_APP = process.env.TARGET_APP ?? 'C:\\Windows\\System32\\notepad.exe';

const url = new URL(APPIUM_URL);

describe('FlaUINative — page source', function () {
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
                'ms:waitForAppLaunch': 5,
            } as WebdriverIO.Capabilities,
        });
    });

    after(async function () {
        if (driver) await driver.deleteSession();
    });

    it('returns a non-empty XML page source', async function () {
        const source = await driver.getPageSource();
        console.log(source);
        expect(source).to.be.a('string').and.have.length.greaterThan(0);
        expect(source).to.match(/<\w+/);
    });
});
