/**
 * stderr-as-error capability and native-exe exit-code detection.
 *
 * These are NEW capabilities added in 1.1.11. No E2E coverage exists.
 *   - treatStderrAsError (default true): when false, stderr from a PS
 *     command does NOT cause rejection.
 *   - $LASTEXITCODE detection: a native exe that exits non-zero MUST
 *     reject even when treatStderrAsError=false.
 */

import { remote, type Browser } from 'webdriverio';
import { expect } from 'chai';

const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
// Default to 'Root' (desktop): all assertions are against PS execution,
// no app-specific UI is needed. shouldCloseApp is a no-op when app is Root
// (see driver.ts:268), so the cap setting is harmless.
const TARGET_APP = process.env.TARGET_APP ?? 'Root';
const url = new URL(APPIUM_URL);

function buildOpts(extra: Record<string, any> = {}) {
    return {
        hostname: url.hostname,
        port: Number(url.port || 4723),
        path: url.pathname && url.pathname !== '/' ? url.pathname : '/',
        protocol: url.protocol.replace(':', '') as 'http' | 'https',
        logLevel: 'warn' as const,
        capabilities: {
            platformName: 'Windows',
            'appium:automationName': 'FlaUINative',
            'appium:app': TARGET_APP,
            'appium:shouldCloseApp': true,
            'ms:waitForAppLaunch': 5,
            ...extra,
        } as WebdriverIO.Capabilities,
    };
}

describe('FlaUINative — treatStderrAsError + native exits', function () {
    this.timeout(180_000);

    describe('default (treatStderrAsError omitted, i.e. true)', function () {
        let driver: Browser;
        before(async function () { driver = await remote(buildOpts()); });
        after(async function () { if (driver) await driver.deleteSession(); });

        it('a PS Write-Error rejects the command', async function () {
            let err: any;
            try {
                await driver.execute('powershell', {
                    script: `Write-Error "intentional-error-from-test"`,
                });
            } catch (e) { err = e; }
            expect(err, 'expected rejection on stderr').to.exist;
            expect(String(err)).to.match(/intentional-error-from-test/);
        });

        it('a PS command that only writes to stdout succeeds', async function () {
            const result = await driver.execute('powershell', {
                script: `Write-Output "hello-from-ps"`,
            });
            expect(String(result)).to.contain('hello-from-ps');
        });
    });

    describe('treatStderrAsError = false', function () {
        let driver: Browser;
        before(async function () {
            driver = await remote(buildOpts({ 'appium:treatStderrAsError': false }));
        });
        after(async function () { if (driver) await driver.deleteSession(); });

        it('a PS Write-Error no longer rejects the command', async function () {
            const result = await driver.execute('powershell', {
                script: `Write-Error "informational-stderr"; Write-Output "still-succeeded"`,
            });
            expect(String(result)).to.contain('still-succeeded');
        });

        it('native exe non-zero exit still rejects (caught via $LASTEXITCODE)', async function () {
            // `cmd /c exit 7` is a portable native exe with deterministic exit
            // code and no stdout/stderr.
            let err: any;
            try {
                await driver.execute('powershell', {
                    script: `cmd /c exit 7`,
                });
            } catch (e) { err = e; }
            expect(err, 'native exit 7 must reject even when treatStderrAsError=false')
                .to.exist;
            expect(String(err)).to.match(/(Native command exited with code 7|NativeExit.*7)/);
        });

        it('native exit 0 succeeds', async function () {
            const result = await driver.execute('powershell', {
                script: `cmd /c exit 0; Write-Output "ok"`,
            });
            expect(String(result)).to.contain('ok');
        });
    });
});
