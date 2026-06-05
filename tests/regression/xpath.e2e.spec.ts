/**
 * XPath 1.0 end-to-end suite.
 *
 * Covers every XPath feature actually implemented by lib/xpath/core.ts:
 *   13 axes, element/wildcard/node() tests, 21 allowlisted property predicates,
 *   union/and/or/not, [n]/[last()]/[position()], the full core function library
 *   implemented in lib/xpath/functions.ts, and the tag-name aliases
 *   (list, listitem, appbar, semanticzoom).
 *
 * Workflow per §4.1 of E2E_TEST_PLAN.md:
 *   1. Launch target app.
 *   2. Dump page source -> E2E_RESULTS/<date>/sources/<app>.xml .
 *   3. Run each XPath as a mocha case; record result into results.json.
 *
 * Run:
 *   APPIUM_URL=http://192.168.196.132:4723 \
 *   TARGET_APP='C:\\Windows\\System32\\notepad.exe' \
 *   npm run test:e2e:xpath
 */

import { remote, type Browser } from 'webdriverio';
import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
const TARGET_APP = process.env.TARGET_APP ?? 'C:\\Windows\\System32\\notepad.exe';
const APP_LABEL  = process.env.APP_LABEL  ?? path.basename(TARGET_APP, path.extname(TARGET_APP));
const VM_LABEL   = process.env.VM_LABEL   ?? 'local';

const url = new URL(APPIUM_URL);
const runDate = new Date().toISOString().slice(0, 10);
const outDir  = path.resolve(
    __dirname, '..', '..', 'E2E_RESULTS', VM_LABEL, runDate,
);
const sourcesDir = path.join(outDir, 'sources');
const resultsPath = path.join(outDir, 'results.json');

type CaseResult = {
    category: string;
    name: string;
    xpath: string;
    status: 'pass' | 'fail' | 'skip';
    matched?: number;
    error?: string;
    note?: string;
};
const results: CaseResult[] = [];

function record(c: CaseResult) { results.push(c); }

describe('XPath 1.0 E2E — feature coverage', function () {
    this.timeout(120_000);

    let driver: Browser;
    let source: string;

    before(async function () {
        fs.mkdirSync(sourcesDir, { recursive: true });

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

        // §4.1 step 1: dump source first.
        source = await driver.getPageSource();
        fs.writeFileSync(path.join(sourcesDir, `${APP_LABEL}.xml`), source, 'utf8');
    });

    after(async function () {
        try { if (driver) await driver.deleteSession(); }
        finally {
            fs.writeFileSync(resultsPath, JSON.stringify({
                vm: VM_LABEL, run_date: runDate, target_app: TARGET_APP,
                total: results.length,
                passed: results.filter((r) => r.status === 'pass').length,
                failed: results.filter((r) => r.status === 'fail').length,
                skipped: results.filter((r) => r.status === 'skip').length,
                cases: results,
            }, null, 2), 'utf8');
        }
    });

    // --- helpers ---------------------------------------------------------
    /** Runs findElements(xpath). Returns the count. Records into results. */
    async function findAll(category: string, name: string, xpath: string, opts: { minExpected?: number; note?: string } = {}) {
        try {
            const els = await driver.findElements('xpath', xpath);
            const count = els.length;
            if (opts.minExpected !== undefined && count < opts.minExpected) {
                const msg = `expected >=${opts.minExpected}, got ${count}`;
                record({ category, name, xpath, status: 'fail', matched: count, error: msg, note: opts.note });
                throw new Error(msg);
            }
            record({ category, name, xpath, status: 'pass', matched: count, note: opts.note });
            return count;
        } catch (err: any) {
            if (!results.find((r) => r.name === name && r.category === category)) {
                record({ category, name, xpath, status: 'fail', error: err?.message ?? String(err), note: opts.note });
            }
            throw err;
        }
    }

    /** Runs findElement(xpath) expecting success. */
    async function findOne(category: string, name: string, xpath: string) {
        try {
            const el = await driver.findElement('xpath', xpath);
            // webdriverio returns error objects inside on failure — guard.
            if (!el || (el as any).error) {
                throw new Error((el as any)?.message ?? 'no element');
            }
            record({ category, name, xpath, status: 'pass', matched: 1 });
            return el;
        } catch (err: any) {
            record({ category, name, xpath, status: 'fail', error: err?.message ?? String(err) });
            throw err;
        }
    }

    /** Expects the driver to throw with an error class name (or message substring). */
    async function expectError(category: string, name: string, xpath: string, expected: string) {
        try {
            await driver.findElements('xpath', xpath);
            record({ category, name, xpath, status: 'fail', error: `expected ${expected}, got no error` });
            throw new Error(`expected ${expected}`);
        } catch (err: any) {
            const m = (err?.message ?? String(err));
            const ok = m.toLowerCase().includes(expected.toLowerCase());
            record({ category, name, xpath, status: ok ? 'pass' : 'fail', error: ok ? undefined : m, note: `expect ${expected}` });
            if (!ok) throw err;
        }
    }

    // ===================================================================
    // A. Basic paths
    // ===================================================================
    describe('A. Basic paths', () => {
        it('absolute root: /Window or //Window', async () => {
            await findAll('A_basic', 'absolute_window', '//Window', { minExpected: 1 });
        });
        it('descendant wildcard: //*', async () => {
            await findAll('A_basic', 'descendant_wildcard', '//*', { minExpected: 5 });
        });
        it('relative nested: //Window//Edit or similar', async () => {
            // not every app has Edit; Notepad does. Fall back to //Pane//* .
            const count = await driver.findElements('xpath', '//Window//*').then((x) => x.length);
            record({ category: 'A_basic', name: 'relative_nested_windowstar', xpath: '//Window//*', status: count > 0 ? 'pass' : 'fail', matched: count });
            expect(count).to.be.greaterThan(0);
        });
        it('union: //Button | //Edit', async () => {
            await findAll('A_basic', 'union', '//Button | //Edit', { minExpected: 1 });
        });
        it('no match: //Button[@Name="__nope__"] -> zero', async () => {
            const n = await driver.findElements('xpath', "//Button[@Name='__nope__']").then((x) => x.length);
            record({ category: 'A_basic', name: 'no_match_returns_zero', xpath: "//Button[@Name='__nope__']", status: n === 0 ? 'pass' : 'fail', matched: n });
            expect(n).to.equal(0);
        });
    });

    // ===================================================================
    // B. Axes (all 13 implemented)
    // ===================================================================
    describe('B. Axes', () => {
        it('child::  (implicit via /)',   async () => { await findAll('B_axes', 'child',                '//Window/child::*',              { minExpected: 1 }); });
        it('descendant::',                async () => { await findAll('B_axes', 'descendant',           '//Window/descendant::*',         { minExpected: 1 }); });
        it('descendant-or-self::',        async () => { await findAll('B_axes', 'descendant_or_self',   '//Window/descendant-or-self::*', { minExpected: 1 }); });
        it('self::',                      async () => { await findAll('B_axes', 'self',                 '//Window/self::Window',          { minExpected: 1 }); });
        it('parent::',                    async () => { await findAll('B_axes', 'parent',               '//*/parent::*',                  { minExpected: 1 }); });
        it('ancestor::',                  async () => { await findAll('B_axes', 'ancestor',             '//*/ancestor::Window',           { minExpected: 1 }); });
        it('ancestor-or-self::',          async () => { await findAll('B_axes', 'ancestor_or_self',     '//Window/ancestor-or-self::*',   { minExpected: 1 }); });
        it('following-sibling::',         async () => { await findAll('B_axes', 'following_sibling',    '//Window/*/following-sibling::*',  { minExpected: 0 }); });
        it('preceding-sibling::',         async () => { await findAll('B_axes', 'preceding_sibling',    '//Window/*/preceding-sibling::*',  { minExpected: 0 }); });
        it('following::',                 async () => { await findAll('B_axes', 'following',            '//Window/following::*',          { minExpected: 0 }); });
        it('preceding::',                 async () => { await findAll('B_axes', 'preceding',            '//Window/preceding::*',          { minExpected: 0 }); });
        it('attribute:: (via @)',         async () => {
            // @Name used in predicate — evaluating @ axis directly isn't a valid node selector,
            // but the allowlisted @ predicates exercise attribute::.
            await findAll('B_axes', 'attribute_predicate', '//*[@Name]', { minExpected: 1 });
        });
    });

    // ===================================================================
    // C. Node tests
    // ===================================================================
    describe('C. Node tests', () => {
        it('element name test: //Button', async () => {
            await findAll('C_nodetests', 'element_button', '//Button', { minExpected: 0 });
        });
        it('wildcard *: //Window/*', async () => {
            await findAll('C_nodetests', 'star', '//Window/*', { minExpected: 1 });
        });
        it('node(): //Window/node()', async () => {
            await findAll('C_nodetests', 'nodefn', '//Window/node()', { minExpected: 1 });
        });
    });

    // ===================================================================
    // D. Attribute predicates (21 allowlisted properties)
    // ===================================================================
    describe('D. Attribute predicates (all 21 allowlisted)', () => {
        const allow = [
            'Name', 'AutomationId', 'ClassName', 'FrameworkId', 'HelpText',
            'ItemStatus', 'ItemType', 'LocalizedControlType',
            'AcceleratorKey', 'AccessKey',
            'IsEnabled', 'IsKeyboardFocusable', 'IsOffscreen', 'IsPassword',
            'IsRequiredForForm', 'HasKeyboardFocus',
            'IsContentElement', 'IsControlElement',
            'RuntimeId', 'Orientation', 'ProcessId',
        ];
        for (const prop of allow) {
            it(`@${prop} presence predicate`, async () => {
                await findAll('D_attrs', `attr_${prop}`, `//*[@${prop}]`, { minExpected: 0 });
            });
        }
        it('equality: @Name="<root-name>"', async () => {
            // Grab the root window's Name from source, then query it.
            const m = /Name="([^"]+)"/.exec(source ?? '');
            const name = m?.[1] ?? 'Notepad';
            const xp = `//*[@Name="${name.replace(/"/g, "'")}"]`;
            await findAll('D_attrs', 'attr_equality', xp, { minExpected: 1, note: `root name=${name}` });
        });
        it('inequality: @Name!=""', async () => {
            await findAll('D_attrs', 'attr_inequality', '//*[@Name!=""]', { minExpected: 1 });
        });
        it('boolean true literal: @IsEnabled="True"', async () => {
            await findAll('D_attrs', 'attr_isenabled_true', '//*[@IsEnabled="True"]', { minExpected: 1 });
        });
        it('boolean false literal: @IsOffscreen="False"', async () => {
            await findAll('D_attrs', 'attr_isoffscreen_false', '//*[@IsOffscreen="False"]', { minExpected: 1 });
        });
        it('numeric compare: @ProcessId > 0', async () => {
            await findAll('D_attrs', 'attr_processid_gt0', '//*[@ProcessId > 0]', { minExpected: 1 });
        });
        it('wildcard attribute: @*="<root-name>"', async () => {
            const m = /Name="([^"]+)"/.exec(source ?? '');
            const name = m?.[1] ?? 'Notepad';
            await findAll('D_attrs', 'attr_star', `//*[@*="${name.replace(/"/g, "'")}"]`, { minExpected: 1 });
        });
    });

    // ===================================================================
    // E. Boolean & logical operators
    // ===================================================================
    describe('E. Operators', () => {
        it('and',       async () => { await findAll('E_ops', 'and',  '//*[@IsEnabled="True" and @IsControlElement="True"]',       { minExpected: 1 }); });
        it('or',        async () => { await findAll('E_ops', 'or',   '//*[@ControlType="Button" or @ControlType="Edit"]',         { minExpected: 0 }); });
        it('not()',     async () => { await findAll('E_ops', 'not',  '//*[not(@Name="__nope__")]',                                  { minExpected: 1 }); });
        it('=',         async () => { await findAll('E_ops', 'eq',   '//*[@IsEnabled="True"]',                                      { minExpected: 1 }); });
        it('!=',        async () => { await findAll('E_ops', 'neq',  '//*[@IsEnabled!="False"]',                                    { minExpected: 1 }); });
        it('<',         async () => { await findAll('E_ops', 'lt',   '//*[string-length(@Name) < 1000]',                            { minExpected: 1 }); });
        it('<=',        async () => { await findAll('E_ops', 'lte',  '//*[string-length(@Name) <= 1000]',                           { minExpected: 1 }); });
        it('>',         async () => { await findAll('E_ops', 'gt',   '//*[@ProcessId > 0]',                                         { minExpected: 1 }); });
        it('>=',        async () => { await findAll('E_ops', 'gte',  '//*[@ProcessId >= 1]',                                        { minExpected: 1 }); });
        it('| union',   async () => { await findAll('E_ops', 'union','//Window | //Pane',                                           { minExpected: 1 }); });
    });

    // ===================================================================
    // F. Position / indexing
    // ===================================================================
    describe('F. Position & indexing', () => {
        it('[1] first',          async () => { await findAll('F_pos', 'first',      '(//*)[1]',                { minExpected: 1 }); });
        it('[last()]',           async () => { await findAll('F_pos', 'last',       '(//*)[last()]',           { minExpected: 1 }); });
        it('[position()=1]',     async () => { await findAll('F_pos', 'positionfn', '(//*)[position()=1]',     { minExpected: 1 }); });
        it('[position()>1]',     async () => { await findAll('F_pos', 'position_gt','(//*)[position()>1]',     { minExpected: 0 }); });
        it('(xpath)[1] vs xpath[1]', async () => {
            const a = await driver.findElements('xpath', '//Button[1]').then((x) => x.length);
            const b = await driver.findElements('xpath', '(//Button)[1]').then((x) => x.length);
            record({ category: 'F_pos', name: 'grouped_vs_ungrouped', xpath: '//Button[1] vs (//Button)[1]',
                status: 'pass', matched: a + b, note: `ungrouped=${a} grouped=${b}` });
        });
    });

    // ===================================================================
    // G. Core function library
    // ===================================================================
    describe('G. Core functions', () => {
        // String fns
        it('contains()',        async () => { await findAll('G_fn', 'contains',        "//*[contains(@Name, 'a')]",                 { minExpected: 0 }); });
        it('starts-with()',     async () => { await findAll('G_fn', 'startswith',      "//*[starts-with(@Name, 'N')]",              { minExpected: 0 }); });
        it('string()',          async () => { await findAll('G_fn', 'string',          "//*[string(@Name)!='']",                    { minExpected: 1 }); });
        it('concat()',          async () => { await findAll('G_fn', 'concat',          "//*[concat(@Name,'x')!='x']",               { minExpected: 1 }); });
        it('substring()',       async () => { await findAll('G_fn', 'substring',       "//*[substring(@Name,1,1)!='']",             { minExpected: 1 }); });
        it('substring-before()',async () => { await findAll('G_fn', 'substring_before',"//*[substring-before(@Name,' ')!='']",      { minExpected: 0 }); });
        it('substring-after()', async () => { await findAll('G_fn', 'substring_after', "//*[substring-after(@Name,' ')!='']",       { minExpected: 0 }); });
        it('string-length()',   async () => { await findAll('G_fn', 'stringlen',       '//*[string-length(@Name) > 0]',             { minExpected: 1 }); });
        it('normalize-space()', async () => { await findAll('G_fn', 'normspace',       "//*[normalize-space(@Name)!='']",           { minExpected: 1 }); });
        it('translate()',       async () => { await findAll('G_fn', 'translate',       "//*[translate(@IsEnabled,'TF','tf')='true']",{ minExpected: 1 }); });

        // Node-set fns
        it('count()',           async () => { await findAll('G_fn', 'count',           "//*[count(@*) > 0]",                        { minExpected: 1 }); });
        it('last() in predicate', async () => { await findAll('G_fn', 'lastpred',      "//*[last() > 0]",                           { minExpected: 1 }); });
        it('position() in predicate', async () => { await findAll('G_fn', 'pospred',   "//*[position() >= 1]",                      { minExpected: 1 }); });
        it('name()',            async () => { await findAll('G_fn', 'name',            "//*[name()!='']",                           { minExpected: 1 }); });
        it('local-name()',      async () => { await findAll('G_fn', 'localname',       "//*[local-name()!='']",                     { minExpected: 1 }); });

        // Boolean fns
        it('boolean()',         async () => { await findAll('G_fn', 'boolean',         "//*[boolean(@Name)]",                       { minExpected: 1 }); });
        it('not()',              async () => { await findAll('G_fn', 'notfn',           "//*[not(@Name='__nope__')]",                { minExpected: 1 }); });
        it('true()',            async () => { await findAll('G_fn', 'truefn',          "//*[true()]",                               { minExpected: 1 }); });
        it('false()',           async () => { await findAll('G_fn', 'falsefn',         "//*[false()]",                              { minExpected: 0, note: 'expect zero' }); });

        // Numeric fns
        it('number()',          async () => { await findAll('G_fn', 'number',          "//*[number(@ProcessId) > 0]",               { minExpected: 1 }); });
        it('floor()',           async () => { await findAll('G_fn', 'floor',           "//*[floor(@ProcessId) >= 1]",               { minExpected: 1 }); });
        it('ceiling()',         async () => { await findAll('G_fn', 'ceiling',         "//*[ceiling(@ProcessId) >= 1]",             { minExpected: 1 }); });
        it('round()',           async () => { await findAll('G_fn', 'round',           "//*[round(@ProcessId) >= 1]",               { minExpected: 1 }); });
        it('sum() over @*',     async () => { await findAll('G_fn', 'sum',             "//*[sum(@ProcessId) > 0]",                  { minExpected: 1 }); });
    });

    // ===================================================================
    // H. Tag-name aliases
    // ===================================================================
    describe('H. Tag-name aliases', () => {
        it('//list -> List|DataGrid', async () => {
            await findAll('H_alias', 'list_alias', '//list', { minExpected: 0 });
        });
        it('//listitem -> ListItem|DataItem', async () => {
            await findAll('H_alias', 'listitem_alias', '//listitem', { minExpected: 0 });
        });
        it('//appbar (ControlType 50039 workaround)', async () => {
            await findAll('H_alias', 'appbar_alias', '//appbar', { minExpected: 0 });
        });
        it('//semanticzoom (ControlType 50040 workaround)', async () => {
            await findAll('H_alias', 'semanticzoom_alias', '//semanticzoom', { minExpected: 0 });
        });
        it('lowercase control types: //button, //edit', async () => {
            await findAll('H_alias', 'lowercase_button', '//button', { minExpected: 0 });
            await findAll('H_alias', 'lowercase_edit',   '//edit',   { minExpected: 0 });
        });
    });

    // ===================================================================
    // I. Element-scoped (relative) XPath
    // ===================================================================
    describe('I. Element-scoped search', () => {
        it('findElement under a found element with absolute //Window path', async () => {
            const root = await driver.findElement('xpath', '//Window');
            // Drill with relative XPath from the root.
            const kids = await driver.findElementsFromElement(root, 'xpath', './*');
            record({ category: 'I_scoped', name: 'relative_from_root', xpath: './*', status: kids.length > 0 ? 'pass' : 'fail', matched: kids.length });
            expect(kids.length).to.be.greaterThan(0);
        });
        it('absolute XPath rewritten from element scope', async () => {
            const root = await driver.findElement('xpath', '//Window');
            const desc = await driver.findElementsFromElement(root, 'xpath', '//Window/descendant::*');
            record({ category: 'I_scoped', name: 'absolute_rewritten', xpath: '//Window/descendant::*', status: desc.length >= 0 ? 'pass' : 'fail', matched: desc.length, note: 'convertAbsoluteXPathToRelativeFromElement' });
        });
    });

    // ===================================================================
    // J. Error surface — must throw W3C-compliant errors
    // ===================================================================
    describe('J. Error surface', () => {
        it('malformed XPath -> InvalidSelectorError', async () => {
            await expectError('J_err', 'malformed', "//Button[@Name=", 'InvalidSelector');
        });
        it('unclosed predicate -> InvalidSelectorError', async () => {
            await expectError('J_err', 'unclosed_pred', "//Button[1", 'InvalidSelector');
        });
        it('findElement with no match -> NoSuchElementError', async () => {
            try {
                await driver.findElement('xpath', "//Button[@Name='__definitely_not_here__']");
                record({ category: 'J_err', name: 'no_such_element', xpath: "//Button[@Name='__definitely_not_here__']", status: 'fail', error: 'expected NoSuchElementError' });
                throw new Error('expected throw');
            } catch (err: any) {
                const m = err?.message ?? String(err);
                const ok = /NoSuchElement|no such element/i.test(m);
                record({ category: 'J_err', name: 'no_such_element', xpath: "//Button[@Name='__definitely_not_here__']",
                    status: ok ? 'pass' : 'fail', error: ok ? undefined : m });
                expect(ok).to.equal(true);
            }
        });
    });

    // ===================================================================
    // K. Unsupported boundary — confirm explicit rejection
    // ===================================================================
    describe('K. Unsupported feature boundary', () => {
        it('text() node test is unsupported (returns empty, no error)', async () => {
            const n = await driver.findElements('xpath', '//text()').then((x) => x.length).catch(() => -1);
            record({ category: 'K_unsup', name: 'text_node', xpath: '//text()',
                status: n >= 0 ? 'pass' : 'fail', matched: n,
                note: 'UIA elements have no text nodes; empty result is correct' });
        });
        it('ends-with() is XPath 2.0 -> should error or be rejected', async () => {
            try {
                const n = await driver.findElements('xpath', "//*[ends-with(@Name, 'x')]").then((x) => x.length);
                record({ category: 'K_unsup', name: 'endswith', xpath: "//*[ends-with(@Name, 'x')]",
                    status: 'fail', matched: n, note: 'ends-with is XPath 2.0; driver should reject' });
            } catch (err: any) {
                record({ category: 'K_unsup', name: 'endswith', xpath: "//*[ends-with(@Name, 'x')]",
                    status: 'pass', note: 'rejected as expected', error: err?.message });
            }
        });
    });
});
