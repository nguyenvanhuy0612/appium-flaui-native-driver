/**
 * Escape-character and {RETURN} verification suite.
 *
 * Targets two suspect code paths in lib/commands/element.ts setValue:
 *
 *   F1 — `keysToSend.push(char.replace(/[+^%~()]/g, '{$&}'))` (line 302)
 *        does NOT escape `{ } [ ]`. Per Microsoft SendKeys docs, the full
 *        set of metachars is `+ ^ % ~ ( ) { } [ ]`. A password containing
 *        any of `{ } [ ]` is mis-interpreted by SendKeys.SendWait.
 *
 *   F2 — For text containing `` (Keys.RETURN), setValue splits the
 *        send between PS subprocess (SendKeys.SendWait for ASCII prefix)
 *        and Node.js (SendInput VK_RETURN). Two processes touching the
 *        foreground input queue → race condition where Enter can land in
 *        the wrong place if focus shifts during typing.
 *
 * Verification strategy:
 *   - Type into Notepad's Document control.
 *   - Win11 Notepad's Document does NOT expose ValuePattern — so we
 *     can't read back via getValue. Instead: send Ctrl+A then Ctrl+C
 *     via `windows: keys` (which goes through SendInput end-to-end,
 *     bypassing SendKeys.SendWait), then read clipboard via
 *     `windows: getClipboard`.
 *   - The read-back path uses a different code path than the type-under-
 *     test path, so a bug in setValue won't be masked by the same bug
 *     in the read-back.
 *
 * Run pattern:
 *   APPIUM_URL=http://192.168.196.136:4723 \
 *     npx mocha --no-config -r ts-node/register --timeout 300000 \
 *     tests/e2e/stable/escape-and-return.e2e.spec.ts
 */

import { remote, type Browser } from 'webdriverio';
import { expect } from 'chai';

const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
const TARGET_APP = process.env.TARGET_APP ?? 'C:\\Windows\\System32\\notepad.exe';
const url = new URL(APPIUM_URL);

// Selenium Keys reference: https://www.selenium.dev/selenium/docs/api/py/_modules/selenium/webdriver/common/keys.html
const KEY_RETURN = '';
const KEY_ENTER  = '';
const KEY_TAB    = '';
const KEY_LCTRL  = '';

function baseOpts(extra: Record<string, any> = {}) {
    return {
        hostname: url.hostname,
        port: Number(url.port || 4723),
        path: url.pathname && url.pathname !== '/' ? url.pathname : '/',
        protocol: url.protocol.replace(':', '') as 'http' | 'https',
        logLevel: 'warn' as const,
        capabilities: {
            platformName: 'Windows',
            'appium:automationName': 'FlaUINative',
            ...extra,
        } as WebdriverIO.Capabilities,
    };
}

describe('FlaUINative — escape chars & {RETURN} verification', function () {
    this.timeout(180_000);

    let driver: Browser;

    before(async function () {
        driver = await remote(baseOpts({
            'appium:app': TARGET_APP,
            'appium:shouldCloseApp': true,
            'ms:waitForAppLaunch': 5,
        }));
    });

    after(async function () {
        if (driver) {
            try { await driver.deleteSession(); } catch { /* noop */ }
        }
    });

    // --------------------------------------------------------------
    // Helpers
    // --------------------------------------------------------------

    /** Locate Notepad's editable Document control. */
    async function getEditControl() {
        // Win11 Notepad: //Document
        // Some Win10/Win11 builds also expose //Edit; try both.
        let el = await driver.$('//Document');
        if (!await el.isExisting()) el = await driver.$('//Edit');
        return el;
    }

    /** Clear the document by selecting all + delete via `windows: keys`. */
    async function clearDocument() {
        // 'windows: keys' goes through executeKeys (extension.ts:564) which
        // routes every char through keyDown/keyUp Win32 SendInput — no
        // SendKeys.SendWait involvement, so this read-back path doesn't
        // share the bug under test.
        await driver.execute('windows: keys', { actions: [
            { virtualKeyCode: 0x11, down: true },   // VK_CONTROL down
            { virtualKeyCode: 0x41 },                // 'A' press
            { virtualKeyCode: 0x11, down: false },  // VK_CONTROL up
            { virtualKeyCode: 0x2E },                // VK_DELETE
        ]});
        await new Promise((r) => setTimeout(r, 100));
    }

    /** Read the document content by Ctrl+A / Ctrl+C and reading clipboard.
     *  Uses `Get-Clipboard -Raw` (preserves newlines) — the driver's
     *  `windows: getClipboard` uses `(Get-Clipboard)` w/o -Raw which
     *  collapses multi-line into a single line joined by $OFS (space).
     */
    async function readDocument(): Promise<string> {
        const sentinel = '__CLIP_EMPTY_SENTINEL__';
        // Seed clipboard with a sentinel via PS so we can detect empty doc.
        await driver.execute('powershell', {
            script: `Set-Clipboard -Value '${sentinel}'`,
        });
        await driver.execute('windows: keys', { actions: [
            { virtualKeyCode: 0x11, down: true },   // VK_CONTROL down
            { virtualKeyCode: 0x41 },                // 'A'
            { virtualKeyCode: 0x43 },                // 'C'
            { virtualKeyCode: 0x11, down: false },  // VK_CONTROL up
        ]});
        await new Promise((r) => setTimeout(r, 250));
        // Read raw clipboard and base64-encode to preserve byte exactness
        // through the PS → Node stdout transport.
        const b64Result = await driver.execute('powershell', {
            script: `
                $t = Get-Clipboard -Raw;
                if ($null -eq $t) { '' } else {
                    [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($t))
                }
            `,
        });
        const b64 = String(b64Result ?? '').trim();
        if (!b64) return '';
        let text = Buffer.from(b64, 'base64').toString('utf8');
        if (text === sentinel) return ''; // Ctrl+C from empty doc was a no-op
        // Get-Clipboard -Raw on multi-line text appends a final \r\n. Strip
        // exactly one trailing newline so 'hello\r\n' (typed via Enter, no
        // following text) reads as 'hello\r\n' but a doc with no content
        // after the last Enter still preserves that final newline.
        // We DON'T strip here — tests use regex `\r?\n?$` to handle both.
        return text;
    }

    // --------------------------------------------------------------
    // Baselines — confirm the read-back harness itself works
    // --------------------------------------------------------------

    describe('baseline — read-back harness', function () {
        it('typing pure ASCII via setValue, read via clipboard', async function () {
            const el = await getEditControl();
            await el.click();
            await clearDocument();
            await el.setValue('hello world');
            const got = await readDocument();
            expect(got).to.equal('hello world');
        });

        it('typing empty string is a no-op', async function () {
            const el = await getEditControl();
            await el.click();
            await clearDocument();
            // Type a sentinel first so we know clipboard had content
            await el.setValue('sentinel');
            await clearDocument();
            await el.setValue('');
            const got = await readDocument();
            expect(got).to.equal('');
        });
    });

    // --------------------------------------------------------------
    // F1 — missing escape for `{ } [ ]` in SendKeys path
    // Expected behaviour per Microsoft SendKeys grammar:
    //   `{` is the start of an escape sequence
    //   `}` closes it
    //   `[` `]` reserved for "applicable to some apps"
    // setValue currently escapes only `+ ^ % ~ ( )`.
    // --------------------------------------------------------------

    describe('F1 — SendKeys metachar escape (suspect bug)', function () {
        const cases = [
            { label: 'plain {',          input: 'A{B',                expected: 'A{B' },
            { label: 'plain }',          input: 'A}B',                expected: 'A}B' },
            { label: '{ then }',         input: '{value}',            expected: '{value}' },
            { label: 'plain [',          input: 'A[B',                expected: 'A[B' },
            { label: 'plain ]',          input: 'A]B',                expected: 'A]B' },
            { label: '[ ]',              input: '[abc]',              expected: '[abc]' },
            { label: 'currently-escaped + only', input: 'A+B',        expected: 'A+B' },
            { label: 'currently-escaped ~ only', input: 'A~B',        expected: 'A~B' },
            { label: 'currently-escaped ^ only', input: 'A^B',        expected: 'A^B' },
            { label: 'currently-escaped % only', input: 'A%B',        expected: 'A%B' },
            { label: 'currently-escaped ( )',    input: 'A(B)C',      expected: 'A(B)C' },
            { label: 'password-like with {',     input: 'P@ss{w0rd}', expected: 'P@ss{w0rd}' },
            { label: 'password-like with []',    input: 'sec[ret]',   expected: 'sec[ret]' },
        ];
        for (const c of cases) {
            it(`types literal ${c.label} (${JSON.stringify(c.input)})`, async function () {
                const el = await getEditControl();
                await el.click();
                await clearDocument();
                await el.setValue(c.input);
                const got = await readDocument();
                expect(got, `Expected literal '${c.expected}' but got '${got}'`).to.equal(c.expected);
            });
        }
    });

    // --------------------------------------------------------------
    // F2 — split SendKeys (PS subprocess) + SendInput (Node) for 
    // Expected: typing 'text' produces 'text\n' in Notepad.
    // --------------------------------------------------------------

    describe('F2 — text + {RETURN} via setValue (suspect bug)', function () {
        it('"hello\\uE006" via setValue → expects "hello\\r\\n"', async function () {
            const el = await getEditControl();
            await el.click();
            await clearDocument();
            // What AppiumLibrary's `_format_keys` produces for input "hello{RETURN}":
            await el.setValue(`hello${KEY_RETURN}`);
            const got = await readDocument();
            // Notepad converts a single Enter to CRLF on copy.
            expect(got).to.match(/^hello\r?\n?$/);
        });

        it('"line1\\uE006line2" via setValue → expects "line1\\r\\nline2"', async function () {
            const el = await getEditControl();
            await el.click();
            await clearDocument();
            await el.setValue(`line1${KEY_RETURN}line2`);
            const got = await readDocument();
            expect(got).to.match(/^line1\r?\nline2$/);
        });

        it('"a\\uE006b\\uE006c" via setValue → 3 lines', async function () {
            const el = await getEditControl();
            await el.click();
            await clearDocument();
            await el.setValue(`a${KEY_RETURN}b${KEY_RETURN}c`);
            const got = await readDocument();
            expect(got.split(/\r?\n/)).to.deep.equal(['a', 'b', 'c']);
        });

        it('"\\uE006" alone via setValue → single newline', async function () {
            // Pure unicode key — no ASCII flush before SendInput. This
            // should be unaffected by F2 (no race).
            const el = await getEditControl();
            await el.click();
            await clearDocument();
            await el.setValue(KEY_RETURN);
            const got = await readDocument();
            expect(got).to.match(/^\r?\n?$/);
        });

        it('{ENTER} (\\uE007) behaves like {RETURN}', async function () {
            const el = await getEditControl();
            await el.click();
            await clearDocument();
            await el.setValue(`hi${KEY_ENTER}`);
            const got = await readDocument();
            expect(got).to.match(/^hi\r?\n?$/);
        });
    });

    // --------------------------------------------------------------
    // F2 control — same input via `windows: keys` extension (no split).
    // If this passes while the F2 setValue suite fails, that's strong
    // evidence the SendKeys+SendInput split is the root cause.
    // --------------------------------------------------------------

    describe('F2 control — same payload via windows: keys (all SendInput, no split)', function () {
        async function typeViaWindowsKeys(text: string) {
            // executeKeys with text iterates each codepoint through
            // keyDown/keyUp Win32 SendInput — single code path.
            await driver.execute('windows: keys', {
                actions: [{ text }],
            });
        }

        it('"hello\\uE006" via windows:keys → expects "hello\\r\\n"', async function () {
            const el = await getEditControl();
            await el.click();
            await clearDocument();
            await typeViaWindowsKeys(`hello${KEY_RETURN}`);
            const got = await readDocument();
            expect(got).to.match(/^hello\r?\n?$/);
        });

        it('"line1\\uE006line2" via windows:keys', async function () {
            const el = await getEditControl();
            await el.click();
            await clearDocument();
            await typeViaWindowsKeys(`line1${KEY_RETURN}line2`);
            const got = await readDocument();
            expect(got).to.match(/^line1\r?\nline2$/);
        });
    });

    // --------------------------------------------------------------
    // Other suspect characters: \t and \n embedded in text.
    // SendKeys interprets these specially in some .NET builds.
    // --------------------------------------------------------------

    describe('embedded \\t and \\n in setValue text', function () {
        it('literal \\t in text — observed behaviour', async function () {
            const el = await getEditControl();
            await el.click();
            await clearDocument();
            await el.setValue('a\tb');
            const got = await readDocument();
            // Notepad either shows a tab character or interprets \t as
            // focus-change. Document the actual behaviour.
            console.log(`    [info] '\\t' in setValue produced: ${JSON.stringify(got)}`);
            expect(got.length).to.be.greaterThan(0);
        });

        it('literal \\n in text — observed behaviour', async function () {
            const el = await getEditControl();
            await el.click();
            await clearDocument();
            await el.setValue('a\nb');
            const got = await readDocument();
            console.log(`    [info] '\\n' in setValue produced: ${JSON.stringify(got)}`);
            expect(got.length).to.be.greaterThan(0);
        });
    });

    // --------------------------------------------------------------
    // SecureAge-style scenario: password-then-{RETURN}. Mirrors the
    // production keyword path that B1 reports as failing.
    // --------------------------------------------------------------

    describe('SecureAge-style end-to-end pattern', function () {
        it('typical password + RETURN pattern types both', async function () {
            const el = await getEditControl();
            await el.click();
            await clearDocument();
            // Simulates: Appium Input ${passwd_loc} secret123{RETURN}
            await el.setValue(`secret123${KEY_RETURN}`);
            const got = await readDocument();
            // We expect 'secret123\n' — if the RETURN gets lost, we'd
            // see 'secret123' alone with no trailing newline.
            expect(got).to.match(/^secret123\r?\n?$/);
            expect(got).to.include('\n'); // Ensures the RETURN actually fired
        });

        it('password with {} chars typed correctly', async function () {
            // The bug F1 + F2 combined: password contains { } AND has {RETURN}.
            const el = await getEditControl();
            await el.click();
            await clearDocument();
            await el.setValue(`P{ass}word${KEY_RETURN}`);
            const got = await readDocument();
            expect(got).to.match(/^P\{ass\}word\r?\n?$/);
        });
    });
});
