/**
 * Regression test for the non-blocking killProcessTree fix.
 *
 * Background — what was broken
 * ----------------------------
 * When a PowerShell command runs past its per-call `timeout`, the driver
 * force-kills the PS process tree. The OLD implementation used
 * `execSync('taskkill /F /T /PID ...')` which is SYNCHRONOUS and blocks
 * Node.js's event loop for the duration of the kill. On Windows, killing a
 * PS process that holds COM / UIA resources can take several seconds because
 * the COM runtime needs to tear down marshalled interfaces before the kernel
 * declares the process exited.
 *
 * Symptom in production (QAOFF-309 TC_009):
 *   - Element find rejects with a timeout.
 *   - During the kill, Robot Framework teardown tries to connect to Appium.
 *   - TCP connect to :4723 times out for ~60s because Node.js never gets to
 *     `accept()` — its event loop is frozen inside execSync.
 *   - 3× ConnectTimeoutError (one per teardown step), then TC_010 connects
 *     fine because by then execSync has returned.
 *
 * Fix:
 *   killProcessTree now uses `spawn('taskkill', ..., { detached: true })`
 *   + `child.unref()` — fire-and-forget. The event loop stays unblocked
 *   while taskkill runs in the background.
 *
 * What this test verifies
 * -----------------------
 *   (1) A hanging PS command rejects within timeout + small slack.
 *   (2) During the kill window, raw HTTP requests to Appium's /status
 *       endpoint all complete in <1s. If the regression returns, those
 *       requests would TCP-timeout because the event loop is blocked.
 *   (3) After the kill, a fresh PS command succeeds — PS auto-restarted.
 *
 * Run:
 *   APPIUM_URL=http://192.168.196.129:4723 \
 *     npm run test:e2e:killtree
 *
 * Designed to be safe to run on any Windows VM with the driver deployed.
 * Uses TARGET_APP='Root' (desktop scope) — no app-specific UI touched.
 */

import { remote, type Browser } from 'webdriverio';
import { expect } from 'chai';
import axios from 'axios';
import { requireAppium } from '../../lib/helpers.js';

const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
const TARGET_APP = process.env.TARGET_APP ?? 'Root';
const url = new URL(APPIUM_URL);

// Short timeout makes the test fast. 5s is plenty to confirm the hanging
// command is recognised as timed-out, and short enough to keep the suite
// well under the mocha default.
const PS_TIMEOUT_MS = 5_000;
// Time we are willing to wait above PS_TIMEOUT_MS before flagging the
// timeout as "did not fire on schedule". Includes WebDriver protocol
// overhead, kill scheduling, and the auto-restart of PS.
const TIMEOUT_SLACK_MS = 8_000;
// Connect timeout for the /status probe. If the event loop is blocked,
// the TCP SYN never gets accepted; with the fix, connect completes in
// the low single-digit ms.
const STATUS_CONNECT_TIMEOUT_MS = 1_500;
// How long we keep probing /status during the kill window.
const PROBE_DURATION_MS = 6_000;
const PROBE_INTERVAL_MS = 100;

function buildOpts() {
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
        } as WebdriverIO.Capabilities,
    };
}

async function probeStatusOnce(): Promise<number> {
    // Returns elapsed ms. Throws on TCP connect timeout, which is the
    // regression signal we care about.
    const start = Date.now();
    await axios.get(`${APPIUM_URL.replace(/\/$/, '')}/status`, {
        timeout: STATUS_CONNECT_TIMEOUT_MS,
        // Reject anything 5xx so a broken Appium also fails the assertion;
        // 2xx/4xx all count as "Appium responded".
        validateStatus: (s) => s < 500,
    });
    return Date.now() - start;
}

describe('FlaUINative — killProcessTree non-blocking (regression)', function () {
    this.timeout(120_000);
    before(requireAppium);

    let driver: Browser;

    before(async function () {
        driver = await remote(buildOpts());
    });

    after(async function () {
        // Best-effort: the test deliberately puts the session in a state
        // where PS was killed and restarted. deleteSession may surface
        // benign noise; swallow it.
        if (driver) {
            try { await driver.deleteSession(); } catch { /* noop */ }
        }
    });

    it('Appium /status responds before the test starts', async function () {
        const ms = await probeStatusOnce();
        expect(ms).to.be.lessThan(STATUS_CONNECT_TIMEOUT_MS);
    });

    it('a hanging PS command rejects near PS_TIMEOUT_MS, and Appium stays reachable during the kill', async function () {
        // Kick off the hang. We do NOT await it here — we want to observe
        // /status DURING the kill, not after the rejection has propagated.
        //
        // We talk to Appium via raw axios instead of `driver.execute(...)`
        // because webdriverio retries failed commands (connectionRetryCount
        // defaults to 3, giving 4 total attempts × ~5s each = ~20s of
        // misleading elapsed time). Raw HTTP gives us the exact moment the
        // driver-side timeout fires, which is what we are measuring.
        const hangScript = `Start-Sleep -Seconds 60`;
        const sessionId = driver.sessionId;
        const sessionUrl = `${APPIUM_URL.replace(/\/$/, '')}/session/${sessionId}`;
        const start = Date.now();

        const hangPromise = axios
            .post(
                `${sessionUrl}/execute/sync`,
                { script: 'powershell', args: [{ script: hangScript, timeout: PS_TIMEOUT_MS }] },
                {
                    timeout: PS_TIMEOUT_MS + TIMEOUT_SLACK_MS + 5_000,
                    validateStatus: () => true, // we'll inspect manually
                },
            )
            .then(
                (resp) => ({
                    resolved: resp.status >= 200 && resp.status < 300,
                    status: resp.status,
                    error: resp.data?.value ?? resp.data,
                    elapsedMs: Date.now() - start,
                }),
                (e) => ({
                    resolved: false,
                    status: -1,
                    error: e,
                    elapsedMs: Date.now() - start,
                }),
            );

        // Probe /status throughout the timeout + kill window. We start
        // BEFORE the timeout fires (to establish baseline) and continue
        // PAST the timeout (to cover the entire kill duration).
        const probeSamples: { atMs: number; elapsedMs: number }[] = [];
        const probeErrors: { atMs: number; message: string }[] = [];
        const probeStart = Date.now();
        const probeDeadline = probeStart + PROBE_DURATION_MS;

        while (Date.now() < probeDeadline) {
            const atMs = Date.now() - probeStart;
            try {
                const elapsedMs = await probeStatusOnce();
                probeSamples.push({ atMs, elapsedMs });
            } catch (e: any) {
                probeErrors.push({
                    atMs,
                    message: e?.code ?? e?.message ?? String(e),
                });
            }
            await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
        }

        // Now await the hang's rejection (it should already have happened
        // during the probe loop).
        const hangOutcome = await hangPromise;

        // -------- Assertions --------

        // (A) The hang must NOT have resolved — it should have timed out.
        expect(hangOutcome.resolved, 'hanging PS command must reject, not resolve').to.equal(false);

        // (B) The timeout must fire near PS_TIMEOUT_MS, not at the mocha
        //     suite timeout (which would indicate the timeout machinery
        //     didn't fire at all).
        expect(hangOutcome.elapsedMs).to.be.lessThan(PS_TIMEOUT_MS + TIMEOUT_SLACK_MS);
        // It must also be >= PS_TIMEOUT_MS - some grace; otherwise the
        // timeout machinery fired too early and we're measuring the wrong
        // thing.
        expect(hangOutcome.elapsedMs).to.be.greaterThan(PS_TIMEOUT_MS - 1_000);

        // (C) /status probes during the kill window must all succeed.
        //     ZERO TCP connect timeouts is the regression bar — before the
        //     fix, several probes near PS_TIMEOUT_MS would fail with
        //     ECONNABORTED / connect timeout because the event loop was
        //     frozen inside execSync('taskkill ...').
        expect(
            probeErrors,
            `/status must stay reachable; got ${probeErrors.length} failures: ${JSON.stringify(probeErrors)}`,
        ).to.have.lengthOf(0);

        // (D) Every successful probe must complete well under
        //     STATUS_CONNECT_TIMEOUT_MS. Even with the kill in flight,
        //     /status should answer in tens of ms — anything approaching
        //     the connect timeout suggests partial event-loop stalls.
        const slowestProbe = probeSamples.reduce(
            (max, s) => (s.elapsedMs > max ? s.elapsedMs : max),
            0,
        );
        expect(
            slowestProbe,
            `slowest /status probe during kill window: ${slowestProbe}ms (samples=${probeSamples.length})`,
        ).to.be.lessThan(STATUS_CONNECT_TIMEOUT_MS);

        // (E) Sanity check: the rejection body should mention a timeout
        //     (we won't be strict about wording). The W3C error body lives
        //     at resp.data.value.{error,message}; we already unwrapped one
        //     level above.
        const errBlob = hangOutcome.error;
        const errStr = String(
            errBlob?.message ?? errBlob?.error ?? JSON.stringify(errBlob ?? ''),
        );
        expect(errStr.toLowerCase()).to.match(/timeout|timed out/);
    });

    it('PS auto-restarts after the kill — a fresh command succeeds', async function () {
        // After the previous test, the underlying PS process was killed and
        // driver.powerShell was cleared. The next sendPowerShellCommand
        // hits ensurePowerShellSession which spawns a new PS and re-runs
        // INIT_SCRIPT. This test confirms that recovery works end-to-end.
        const result = await driver.execute('powershell', {
            script: `Write-Output "after-kill-recovered"`,
        });
        expect(String(result)).to.contain('after-kill-recovered');
    });
});
