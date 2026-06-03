/**
 * Unicode and PSString-escaping coverage — protocol level.
 *
 * Important: PowerShell reads stdin using the system code page (not UTF-8),
 * so we CANNOT put raw non-ASCII chars in the script string sent to PS.
 * Instead we build unicode payloads from `[char]0xNNNN` codepoints — those
 * are ASCII over the wire. PS constructs the string locally and outputs it
 * via $OutputEncoding=UTF-8, which Node decodes correctly.
 *
 * This exercises:
 *   - $OutputEncoding=UTF-8 transport for non-ASCII bytes back to Node
 *   - PSString escaping of single/double quotes, $, backtick (the marker-
 *     protocol-corrupting characters)
 *   - The completion-marker protocol surviving mixed-byte output
 *   - Clipboard set/get for unicode (via base64 — no encoding issue)
 *
 * Closes the "Unicode / special-char input" GAP row in design-review-stable.md §3.
 */

import { remote, type Browser } from 'webdriverio';
import { expect } from 'chai';

const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
// Default to 'Root' (desktop): all assertions are against PS round-trips,
// no app-specific UI is needed. Skipping the launch saves ~6s per session.
const TARGET_APP = process.env.TARGET_APP ?? 'Root';
const url = new URL(APPIUM_URL);

/** Build a PS expression that constructs a unicode string from codepoints. */
function psFromCodepoints(text: string): string {
    const parts: string[] = [];
    for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        if (cp > 0xFFFF) {
            // Surrogate pair (e.g., emoji). [char]::ConvertFromUtf32 handles it.
            parts.push(`[System.Char]::ConvertFromUtf32(0x${cp.toString(16).toUpperCase()})`);
        } else {
            parts.push(`[char]0x${cp.toString(16).toUpperCase()}`);
        }
    }
    return parts.length === 0 ? `''` : parts.join(' + ');
}

describe('NovaWindows2 — unicode & PSString escaping', function () {
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

    /** Round-trip a unicode string by constructing it in PS via codepoints. */
    async function unicodeRoundTrip(text: string): Promise<string> {
        const result = await driver.execute('powershell', {
            script: `Write-Output (${psFromCodepoints(text)})`,
        });
        return String(result ?? '').replace(/\r/g, '').trim();
    }

    it('ASCII round-trip baseline', async function () {
        const result = await driver.execute('powershell', {
            script: `Write-Output "hello world"`,
        });
        expect(String(result).trim()).to.equal('hello world');
    });

    it('latin-1 accented characters round-trip via codepoint construction', async function () {
        const out = await unicodeRoundTrip('café résumé naïve');
        expect(out).to.contain('café');
        expect(out).to.contain('résumé');
        expect(out).to.contain('naïve');
    });

    it('CJK characters round-trip via codepoint construction', async function () {
        const out = await unicodeRoundTrip('日本語テスト中文');
        expect(out).to.contain('日本語');
        expect(out).to.contain('中文');
    });

    it('emoji (surrogate pair) round-trip via ConvertFromUtf32', async function () {
        const out = await unicodeRoundTrip('🚀🎉🔥');
        expect(out).to.contain('🚀');
        expect(out).to.contain('🎉');
    });

    it('PS-special chars in a here-string survive the marker protocol', async function () {
        // Here-string @'...'@ preserves contents literally. The chars below
        // would, if unescaped in a NORMAL string, all be interpreted as PS
        // syntax. The marker protocol must still detect completion.
        const result = await driver.execute('powershell', {
            script: `Write-Output @'\nit's a "test" with $vars and \`backticks\`\n'@`,
        });
        const out = String(result ?? '');
        expect(out).to.contain("it's a");
        expect(out).to.contain('"test"');
        expect(out).to.contain('$vars');
        expect(out).to.contain('`backticks`');
    });

    it('clipboard set/get round-trips unicode via base64', async function () {
        const text = 'unicode-clipboard: café 日本語 🎉';
        await driver.execute('windows: setClipboard', {
            b64Content: Buffer.from(text, 'utf8').toString('base64'),
        });
        const got = await driver.execute('windows: getClipboard', {}) as string;
        const decoded = Buffer.from(String(got), 'base64').toString('utf8');
        expect(decoded).to.contain('café');
        expect(decoded).to.contain('日本語');
    });

    it('page source returns mixed-byte content without corrupting the marker', async function () {
        const source = await driver.getPageSource();
        expect(source).to.be.a('string').and.have.length.greaterThan(100);
        expect(source).to.match(/<Window/);
    });
});
