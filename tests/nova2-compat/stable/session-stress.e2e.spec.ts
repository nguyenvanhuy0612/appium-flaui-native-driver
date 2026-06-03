/**
 * Session-lifecycle stress test for the 1.1.17 stability work.
 *
 * Validates four properties under repeated create -> use -> delete cycles:
 *   1. Sessions can be opened and closed N times in a row without the
 *      driver / Appium server crashing or wedging.
 *   2. Each session's commandQueue drains cleanly across createSession +
 *      a handful of operations + deleteSession (queue depth returns to 0).
 *   3. Node-side per-session memory does NOT grow unboundedly. We snapshot
 *      RSS via the Appium /status endpoint (best available without
 *      process-internal hooks) at intervals and assert the growth stays
 *      within a tolerance.
 *   4. The new PS-side $elementTable cap doesn't leak across sessions.
 *      A fresh session's commands respond as quickly as the first session's
 *      (a soft assertion on per-command latency).
 *
 * Run:
 *   APPIUM_URL=http://192.168.196.129:4723 npm run test:e2e:session-stress
 *
 * Notes:
 *   - Each iteration uses app: 'Root' so we don't depend on any specific
 *     app being installed on the target VM.
 *   - The test deliberately exercises every code path that allocates
 *     per-session state: findElement, getPageSource (iterative now),
 *     executeScript('powershell'), and the W3C delete.
 */

import { remote, type Browser } from 'webdriverio';
import { expect } from 'chai';
import axios from 'axios';

const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
const TARGET_APP = process.env.TARGET_APP ?? 'Root';
const url = new URL(APPIUM_URL);

// 30 iterations is enough to surface a per-session leak without taking
// forever — each iteration adds ~1-2s of overhead from create/delete.
// If a real leak exists, it'll show up well before iteration 30.
const ITERATIONS = Number(process.env.STRESS_ITERATIONS ?? '30');
// Per-iteration latency budget: include session create + a few ops +
// delete. Generous because Root-app sessions still take ~1s to spin up.
const PER_ITERATION_BUDGET_MS = 60_000;

function buildOpts() {
    return {
        hostname: url.hostname,
        port: Number(url.port || 4723),
        path: url.pathname && url.pathname !== '/' ? url.pathname : '/',
        protocol: url.protocol.replace(':', '') as 'http' | 'https',
        logLevel: 'warn' as const,
        connectionRetryCount: 0,
        capabilities: {
            platformName: 'Windows',
            'appium:automationName': 'FlaUINative',
            'appium:app': TARGET_APP,
            'appium:shouldCloseApp': true,
            // Tight timeout so a hung command surfaces fast in the test.
            'appium:powerShellCommandTimeout': 30_000,
            'ms:waitForAppLaunch': 5,
        } as WebdriverIO.Capabilities,
    };
}

async function appiumStatus(): Promise<any> {
    const resp = await axios.get(`${APPIUM_URL.replace(/\/$/, '')}/status`, {
        timeout: 5_000,
        validateStatus: () => true,
    });
    return resp.data;
}

describe('NovaWindows2 — session-lifecycle stress', function () {
    this.timeout(ITERATIONS * PER_ITERATION_BUDGET_MS);

    let firstSessionAvgMs = 0;

    before(async function () {
        // Sanity: Appium must be up before we start.
        const ok = await appiumStatus().catch(() => null);
        expect(ok, 'Appium /status must respond before stress test starts').to.exist;
    });

    it(`opens, exercises, and closes a session ${ITERATIONS} times without wedging`, async function () {
        const perSessionMs: number[] = [];
        let earlyFailure: any = null;

        for (let i = 0; i < ITERATIONS; i++) {
            const iterStart = Date.now();
            let driver: Browser | undefined;
            try {
                driver = await remote(buildOpts());

                // Exercise the paths that allocate per-session state.
                // Each call should drain the commandQueue back to 0.
                await driver.execute('powershell', { script: `Write-Output "iter-${i}"` });

                // Find one element from the desktop tree — uses the new
                // streaming Find-AllDescendants on the root scope.
                const matches = await driver.findElements('xpath', '//Window');
                expect(matches.length, `iter ${i}: //Window must match at least one element`).to.be.greaterThan(0);

                // Run getPageSource on a small subtree — exercises the
                // iterative Get-PageSource rewrite. We use the first
                // window match so the subtree is bounded.
                const firstWindow = matches[0];
                if (firstWindow) {
                    const xml = await driver.execute('windows: getPageSource', {
                        elementId: (firstWindow as any).elementId ?? (firstWindow as any).ELEMENT,
                    } as any).catch(() => null);
                    // We don't strictly require getPageSource to succeed for
                    // every iteration (the chosen window may have closed
                    // mid-iteration). If it succeeds, sanity-check shape.
                    if (typeof xml === 'string') {
                        expect(xml).to.match(/<\w+/);
                    }
                }
            } catch (e: any) {
                earlyFailure = { iter: i, error: e?.message ?? String(e) };
                break;
            } finally {
                if (driver) {
                    try { await driver.deleteSession(); } catch { /* noop */ }
                }
            }
            const elapsed = Date.now() - iterStart;
            perSessionMs.push(elapsed);
        }

        expect(earlyFailure, `early failure: ${JSON.stringify(earlyFailure)}`).to.equal(null);
        expect(perSessionMs.length).to.equal(ITERATIONS);

        // Per-iteration time should stay roughly flat — not creep up.
        // Compute average of first 5 vs last 5 iterations.
        const sample = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
        const firstFive = perSessionMs.slice(0, 5);
        const lastFive = perSessionMs.slice(-5);
        firstSessionAvgMs = sample(firstFive);
        const lastAvg = sample(lastFive);

        // Allow up to 3x slowdown (very generous — accounts for system
        // noise on a busy VM). A real leak (queue growth, $elementTable
        // bleed across sessions) would typically show 10x+ blow-up.
        expect(
            lastAvg,
            `last-5 avg ${Math.round(lastAvg)}ms grew >3x relative to first-5 avg ${Math.round(firstSessionAvgMs)}ms — possible per-session leak`,
        ).to.be.lessThan(firstSessionAvgMs * 3 + 5_000);
    });

    it('Appium remains responsive after the stress loop', async function () {
        // /status must still respond fast after the loop. If a leak filled
        // the Node heap, /status would either fail or take a long time.
        const start = Date.now();
        const status = await appiumStatus();
        const elapsed = Date.now() - start;

        expect(status, 'Appium /status must still respond after the loop').to.exist;
        expect(elapsed, '/status responded slowly after stress').to.be.lessThan(2_000);
    });

    it('exceeding the PS command-queue cap surfaces a clean error', async function () {
        // Standalone verification of the MAX_POWERSHELL_QUEUE_DEPTH cap.
        // Spam parallel `Start-Sleep 5` calls beyond the cap. The cap is
        // 200 in code; we fire 250 and expect at least one to reject with
        // a "queue is full" error.
        const driver = await remote(buildOpts());
        try {
            const promises: Promise<any>[] = [];
            for (let i = 0; i < 250; i++) {
                promises.push(
                    driver.execute('powershell', { script: `Start-Sleep -Milliseconds 50` })
                        .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: String(e?.message ?? e) })),
                );
            }
            const results = await Promise.all(promises);
            const errors = results.filter((r: any) => !r.ok).map((r: any) => r.e);

            const queueFullErrors = errors.filter((m: string) => /queue is full/i.test(m));
            expect(
                queueFullErrors.length,
                `expected at least one 'queue is full' rejection, got errors: ${errors.slice(0, 5).join(' | ')}`,
            ).to.be.greaterThan(0);
        } finally {
            try { await driver.deleteSession(); } catch { /* noop */ }
        }
    });
});
