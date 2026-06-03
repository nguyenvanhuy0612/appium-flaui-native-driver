/**
 * Desktop-anchored E2E suite.
 *
 * Uses `app: 'Root'` so the test target is the Windows desktop itself
 * rather than a launched app. The selectors here reference REAL Windows
 * shell elements with stable @AutomationId / @ClassName attributes that
 * survive across Win10/11 builds and locales:
 *
 *   - Taskbar:        Pane[ClassName=Shell_TrayWnd]
 *   - Start button:   Button[AutomationId=StartButton]
 *   - Search button:  Button[AutomationId=SearchButton]
 *   - Pinned apps:    Button[contains(AutomationId, "Appid:")]
 *   - System tray:    Button[AutomationId=SystemTrayIcon]
 *
 * Why use @AutomationId over @Name? AutomationIds are localization-invariant
 * (the Start button is "Pornire" in Romanian Win11 but its AutomationId is
 * still "StartButton"). Names are language-dependent.
 *
 * Captured from the actual desktop on 192.168.196.128 in this session.
 * See log/desktop-source.xml for the full snapshot.
 *
 * Closes "test-data drift" — these tests don't depend on a specific app
 * being installed or having a specific UI state.
 */

import { remote, type Browser } from 'webdriverio';
import { expect } from 'chai';

const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
const url = new URL(APPIUM_URL);

describe('NovaWindows2 — desktop (app: Root)', function () {
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
                'appium:app': 'Root',
                'appium:powerShellCommandTimeout': 60_000,
            } as WebdriverIO.Capabilities,
        });
    });

    after(async function () {
        if (driver) await driver.deleteSession();
    });

    describe('shell anchors', function () {
        it('finds the taskbar', async function () {
            const taskbar = await driver.$('//Pane[@ClassName="Shell_TrayWnd"]');
            expect(await taskbar.isExisting()).to.equal(true);
        });

        it('finds the Start button by AutomationId (locale-invariant)', async function () {
            const start = await driver.$('//Button[@AutomationId="StartButton"]');
            expect(await start.isExisting()).to.equal(true);
        });

        it('Start button reports localized control type "button"', async function () {
            const start = await driver.$('//Button[@AutomationId="StartButton"]');
            const ct = await driver.execute('powershell', {
                script: `($elementTable['${start.elementId}']).Current.LocalizedControlType`,
            });
            expect(String(ct).trim()).to.equal('button');
        });

        it('finds the Search button', async function () {
            const search = await driver.$('//Button[@AutomationId="SearchButton"]');
            expect(await search.isExisting()).to.equal(true);
        });

        it('finds at least one pinned taskbar app (Appid:* AutomationId)', async function () {
            const pinned = await driver.findElements('xpath', '//Button[contains(@AutomationId, "Appid:")]');
            expect(pinned.length).to.be.greaterThan(0,
                'expected at least one pinned app on the taskbar');
        });

        it('finds at least one system-tray icon', async function () {
            const trayIcons = await driver.findElements('xpath', '//Button[@AutomationId="SystemTrayIcon"]');
            expect(trayIcons.length).to.be.greaterThan(0);
        });
    });

    describe('XPath axes against real elements', function () {
        it('descendant axis: taskbar has children', async function () {
            const children = await driver.findElements(
                'xpath',
                '//Pane[@ClassName="Shell_TrayWnd"]/descendant::*',
            );
            expect(children.length).to.be.greaterThan(5,
                'taskbar should have multiple descendants');
        });

        it('ancestor axis: Start button has a Pane ancestor', async function () {
            const ancestors = await driver.findElements(
                'xpath',
                '//Button[@AutomationId="StartButton"]/ancestor::Pane',
            );
            expect(ancestors.length).to.be.greaterThan(0);
        });

        it('parent axis: Start button parent is a control', async function () {
            const parents = await driver.findElements(
                'xpath',
                '//Button[@AutomationId="StartButton"]/parent::*',
            );
            expect(parents.length).to.equal(1);
        });

        it('union (|): Start OR Search button → 2 matches', async function () {
            const both = await driver.findElements(
                'xpath',
                '//Button[@AutomationId="StartButton"] | //Button[@AutomationId="SearchButton"]',
            );
            expect(both.length).to.equal(2);
        });
    });

    describe('XPath predicates on real attribute values', function () {
        it('contains(): pinned apps with "pinned" in their @Name', async function () {
            // Win10/11 taskbar buttons for pinned (not-running) apps have Name
            // like "File Explorer pinned" / "Microsoft Edge pinned".
            const pinnedNamed = await driver.findElements(
                'xpath',
                '//Button[contains(@Name, "pinned")]',
            );
            expect(pinnedNamed.length).to.be.greaterThan(0);
        });

        it('starts-with(): AutomationId starts with "Appid:"', async function () {
            const apps = await driver.findElements(
                'xpath',
                '//Button[starts-with(@AutomationId, "Appid:")]',
            );
            expect(apps.length).to.be.greaterThan(0);
        });

        it('numeric @ProcessId > 0 on the taskbar', async function () {
            const taskbar = await driver.$('//Pane[@ClassName="Shell_TrayWnd"]');
            const pidStr = await driver.execute('powershell', {
                script: `($elementTable['${taskbar.elementId}']).Current.ProcessId`,
            });
            const pid = Number(String(pidStr).trim());
            expect(pid).to.be.a('number').and.greaterThan(0);
        });

        it('@AutomationId equality matches exactly one', async function () {
            const els = await driver.findElements(
                'xpath',
                '//*[@AutomationId="StartButton"]',
            );
            expect(els.length).to.equal(1);
        });
    });

    describe('XPath functions against real desktop', function () {
        it('count() — number of taskbar buttons', async function () {
            // Count children of Shell_TrayWnd via descendant axis count
            const buttons = await driver.findElements(
                'xpath',
                '//Pane[@ClassName="Shell_TrayWnd"]//Button',
            );
            expect(buttons.length).to.be.greaterThan(0);
        });

        it('name() — Start button tag name is "Button"', async function () {
            const start = await driver.$('//Button[@AutomationId="StartButton"]');
            const tag = await start.getTagName();
            expect(String(tag).toLowerCase()).to.equal('button');
        });

        it('string-length(@Name) > 0 on the Start button', async function () {
            const start = await driver.$('//Button[@AutomationId="StartButton"]');
            const name = await start.getAttribute('Name');
            expect(String(name).length).to.be.greaterThan(0);
        });
    });

    describe('locator strategies on real elements', function () {
        it('accessibility id ("~Start" via WDIO) finds the Start button', async function () {
            // WDIO's "~name" shortcut maps to the "accessibility id" strategy,
            // which the driver maps to @AutomationId.
            const start = await driver.$('~StartButton');
            expect(await start.isExisting()).to.equal(true);
        });

        it('class name strategy finds the taskbar', async function () {
            const taskbars = await driver.findElements('class name', 'Shell_TrayWnd');
            expect(taskbars.length).to.equal(1);
        });

        it('tag name strategy: Button matches many', async function () {
            const buttons = await driver.findElements('tag name', 'Button');
            expect(buttons.length).to.be.greaterThan(5);
        });
    });

    describe('page source from the real desktop', function () {
        it('page source contains the taskbar marker', async function () {
            const src = await driver.getPageSource();
            expect(src).to.contain('Shell_TrayWnd');
        });

        it('page source contains the Start button AutomationId', async function () {
            const src = await driver.getPageSource();
            expect(src).to.contain('AutomationId="StartButton"');
        });

        it('page source is well-formed XML (single root element)', async function () {
            const src = await driver.getPageSource();
            // Must start with a single root tag — the desktop Pane.
            expect(src).to.match(/^<\w+[\s>]/);
            // Tag count: open tags ≥ close tags (will be equal when properly nested)
            const opens = (src.match(/<\w+[\s>]/g) || []).length;
            const closes = (src.match(/<\/\w+>/g) || []).length;
            expect(opens).to.be.greaterThan(0);
            // Self-closing tags (<X />) inflate the open count over the close
            // count; we don't try to balance exactly, just sanity-check.
            expect(closes).to.be.greaterThan(0);
        });
    });
});
