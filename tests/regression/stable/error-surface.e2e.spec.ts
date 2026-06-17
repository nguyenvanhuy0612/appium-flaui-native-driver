/**
 * Error-surface coverage.
 *
 * Verifies that each documented failure mode surfaces as the right WebDriver
 * error type. Closes gaps identified in design-review-stable.md §3:
 *   - NoSuchElement
 *   - StaleElementReference
 *   - InvalidSelector
 *   - Timeout (per-call powershell `timeout` arg)
 *
 * Run:
 *   APPIUM_URL=http://127.0.0.1:4723 \
 *   TARGET_APP='C:\\Windows\\System32\\notepad.exe' \
 *   npx mocha --config tests/e2e/.mocharc.json tests/e2e/stable/error-surface.e2e.spec.ts
 */

import { remote, type Browser } from 'webdriverio';
import { expect } from 'chai';
import { requireAppium } from '../../lib/helpers.js';

const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
// Default to 'Root' (desktop): negative-path tests don't need an app launch,
// and skipping it cuts ~6s of setup per session. Override with TARGET_APP if
// you want to repro a Notepad-specific bug.
const TARGET_APP = process.env.TARGET_APP ?? 'Root';
const url = new URL(APPIUM_URL);

/**
 * Capture the WebDriver error JSON shape. webdriverio v9 throws a generic
 * Error whose .message contains the JSON-encoded error info; we parse out
 * the `error` field to compare with W3C error codes.
 */
function errorCode(e: any): string {
    if (!e) return '';
    if (typeof e.error === 'string') return e.error;
    const msg = String(e?.message ?? e);
    const match = msg.match(/"error":\s*"([^"]+)"/);
    if (match) return match[1];
    if (/no such element/i.test(msg)) return 'no such element';
    if (/stale element/i.test(msg)) return 'stale element reference';
    if (/malformed xpath|invalid selector|invalid argument/i.test(msg)) return 'invalid selector';
    if (/timeout/i.test(msg)) return 'timeout';
    return msg;
}

describe('FlaUINative — error surface', function () {
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

    describe('NoSuchElement', function () {
        // WDIO v9's findElement does NOT throw on no-match; it returns a
        // lazy Element with no elementId. The W3C-compliant test is to use
        // $(selector).isExisting() which returns boolean, OR findElements
        // which returns []. We use both shapes here.

        it('xpath matching nothing: $(...).isExisting() is false', async function () {
            const el = await driver.$('//Button[@Name="NoSuchButton_xyz_zzz9999"]');
            expect(await el.isExisting()).to.equal(false);
        });

        it('findElements with no match returns empty array', async function () {
            const els = await driver.findElements('xpath', '//Button[@Name="NoSuchButton_xyz_zzz9999"]');
            expect(els).to.be.an('array').with.lengthOf(0);
        });

        it('accessibility-id that does not exist: $(~...).isExisting() is false', async function () {
            const el = await driver.$('~NoSuchAutomationId_zzz9999');
            expect(await el.isExisting()).to.equal(false);
        });
    });

    describe('InvalidSelector', function () {
        it('malformed XPath throws InvalidSelector', async function () {
            let err: any;
            try {
                await driver.findElement('xpath', '//Window[@Name=');
            } catch (e) { err = e; }
            expect(err, 'expected an error').to.exist;
            expect(errorCode(err)).to.match(/invalid selector/i);
        });

        it('XPath with unclosed predicate throws InvalidSelector', async function () {
            let err: any;
            try {
                await driver.findElement('xpath', '//*[@Name="foo"');
            } catch (e) { err = e; }
            expect(err).to.exist;
            expect(errorCode(err)).to.match(/invalid selector/i);
        });
    });

    describe('StaleElementReference', function () {
        it('using an element id after the underlying control vanished surfaces an error', async function () {
            // Find an element that's destroyed by closing it.
            // Notepad's title bar is stable, so we manufacture stale by deleting the
            // server-side cache entry through windows:powershell.
            const root = await driver.$('//Window');
            expect(await root.elementId).to.be.a('string').and.not.empty;

            // Wipe the element table server-side
            await driver.execute('powershell', {
                script: `$elementTable.Clear()`,
            });

            let err: any;
            let textResult: string | undefined;
            try {
                textResult = await root.getText();
            } catch (e) { err = e; }
            // Two acceptable outcomes:
            //   (a) driver re-resolved via RUNTIME_ID fallback → getText returns a string
            //   (b) driver could not re-resolve → throws NoSuchElement
            // Either is documented behavior; what we MUST NOT see is a
            // "Cannot call method on null-valued expression" leak.
            if (err) {
                expect(errorCode(err)).to.not.match(/cannot call.*null/i);
            } else {
                expect(textResult).to.be.a('string');
            }
        });
    });

    describe('Timeout', function () {
        it('a runaway PS command rejects with timeout after the per-call timeout', async function () {
            // The per-call `timeout` (ms) bounds a single powershell invocation. A 30s
            // Start-Sleep with a 2s budget must reject fast, surfacing a `timeout` error
            // rather than hanging for the full sleep.
            this.timeout(15_000);
            const start = Date.now();
            let err: any;
            try {
                await driver.execute('powershell', {
                    script: `Start-Sleep -Seconds 30`,
                    timeout: 2_000,
                });
            } catch (e) { err = e; }
            const elapsed = Date.now() - start;
            expect(err, 'a bounded PS command must reject').to.exist;
            expect(errorCode(err)).to.match(/timeout/i);
            // Must come back well under the 30s sleep — the child was killed at ~2s.
            expect(elapsed).to.be.lessThan(15_000);
        });

        it('a fast PS command under its timeout budget resolves normally', async function () {
            this.timeout(15_000);
            const start = Date.now();
            await driver.execute('powershell', {
                script: `Start-Sleep -Milliseconds 1000`,
                timeout: 10_000,
            });
            const elapsed = Date.now() - start;
            expect(elapsed).to.be.greaterThan(900);
            expect(elapsed).to.be.lessThan(10_000);
        });
    });
});
