// Standalone E2E smoke: drives a real Appium 3 server (no webdriverio dependency) to verify the
// FlaUINative driver against Notepad. Run on Windows in the interactive session (after `appium` is up).
//   node scripts/e2e-notepad.mjs
// Exits 0 on E2E_PASS, 1 otherwise. Prints a compact trace.
const BASE = process.env.APPIUM_BASE || 'http://127.0.0.1:4723';

async function call(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

const W3C_KEY = 'element-6066-11e4-a52e-4f735466cecf';

(async () => {
  let sid;
  let pass = false;
  try {
    const caps = {
      capabilities: {
        alwaysMatch: {
          platformName: 'Windows',
          'appium:automationName': 'FlaUINative',
          'appium:app': 'notepad.exe',
        },
        firstMatch: [{}],
      },
    };
    const s = await call('POST', '/session', caps);
    console.log('[session]', s.status, JSON.stringify(s.data).slice(0, 400));
    sid = s.data?.value?.sessionId;
    if (!sid) throw new Error('no sessionId returned');

    // Find the Notepad text area. Classic Win10 Notepad exposes an "Edit" control.
    const el = await call('POST', `/session/${sid}/element`, { using: 'class name', value: 'Edit' });
    console.log('[find]', el.status, JSON.stringify(el.data).slice(0, 300));
    const elId = el.data?.value?.[W3C_KEY];

    // Page source (exercises CacheRequest + DFS XML builder).
    const src = await call('GET', `/session/${sid}/source`);
    const xml = typeof src.data?.value === 'string' ? src.data.value : '';
    if (src.status !== 200) console.log('[source ERR]', src.status, JSON.stringify(src.data).slice(0, 500));
    console.log('[source]', src.status, 'len=', xml.length, '|', xml.slice(0, 200).replace(/\n/g, ' '));

    pass = el.status === 200 && !!elId && xml.length > 0;
    console.log(pass ? 'E2E_PASS' : 'E2E_FAIL');
  } catch (e) {
    console.log('E2E_ERROR', e?.message || String(e));
  } finally {
    if (sid) {
      try { await call('DELETE', `/session/${sid}`); } catch { /* ignore */ }
    }
  }
  process.exit(pass ? 0 : 1);
})();
