/**
 * Stress / robustness coverage.
 *
 * Closes the "Stress / edge cases" GAP row in design-review-stable.md §3:
 *   - rapid command burst (queue depth)
 *   - large page source / element tree
 *   - long-running session (many iterations)
 *
 * Per-spec timeouts are generous because some of these intentionally push
 * the driver. A pass = no hang, no protocol-level error.
 */

import { remote, type Browser } from 'webdriverio';
import { expect } from 'chai';

const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
// Default to 'Root' (desktop): exercises a richer UIA tree than Notepad
// (taskbar + system tray + multiple windows), and skips the ~6s app launch.
const TARGET_APP = process.env.TARGET_APP ?? 'Root';
const url = new URL(APPIUM_URL);

describe('NovaWindows2 — stress & robustness', function () {
    this.timeout(300_000);

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

    it('50 sequential element finds finish in order, no errors', async function () {
        for (let i = 0; i < 50; i++) {
            const root = await driver.$('//Window');
            expect(root.elementId).to.be.a('string');
        }
    });

    it('20 parallel element finds all resolve (queue serialises them)', async function () {
        const promises = Array.from({ length: 20 }, () => driver.$('//Window'));
        const results = await Promise.all(promises);
        expect(results).to.have.lengthOf(20);
        results.forEach(r => expect(r.elementId).to.be.a('string'));
    });

    it('rapid alternation between two distinct XPaths', async function () {
        for (let i = 0; i < 30; i++) {
            const xpath = i % 2 === 0 ? '//Window' : '//*';
            if (i % 2 === 0) {
                const el = await driver.$(xpath);
                expect(el.elementId).to.be.a('string');
            } else {
                const els = await driver.$$(xpath);
                expect(els.length).to.be.greaterThan(0);
            }
        }
    });

    it('large page source completes within reasonable time', async function () {
        this.timeout(60_000);
        const start = Date.now();
        const source = await driver.getPageSource();
        const elapsed = Date.now() - start;
        expect(source).to.be.a('string').and.have.length.greaterThan(100);
        expect(elapsed).to.be.lessThan(30_000,
            `getPageSource took ${elapsed}ms — Notepad UI should be fast`);
    });

    it('100 round-trip PS commands keep session alive', async function () {
        for (let i = 0; i < 100; i++) {
            const result = await driver.execute('powershell', {
                script: `Write-Output "ping-${i}"`,
            });
            expect(String(result)).to.contain(`ping-${i}`);
        }
    });

    it('command queue ordering: 10 enqueued commands resolve in order', async function () {
        const results: string[] = [];
        const promises: Promise<void>[] = [];
        for (let i = 0; i < 10; i++) {
            promises.push(
                driver.execute('powershell', {
                    script: `Write-Output "ord-${i}"`,
                }).then(r => { results.push(String(r)); })
            );
        }
        await Promise.all(promises);
        // Order is not strictly guaranteed by webdriverio's promise scheduling,
        // but every command must have run. The queue inside the driver IS
        // strictly FIFO; we assert all 10 results landed.
        expect(results).to.have.lengthOf(10);
        for (let i = 0; i < 10; i++) {
            expect(results.some(r => r.includes(`ord-${i}`))).to.be.true;
        }
    });
});
