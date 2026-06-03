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

    const E = encodeURIComponent(elId);

    // setValue via the W3C send-keys endpoint, then read it back via getAttribute("Value").
    const T1 = 'alpha-123';
    await call('POST', `/session/${sid}/element/${E}/value`, { text: T1 });
    const a1 = await call('GET', `/session/${sid}/element/${E}/attribute/Value`);
    console.log('[setValue->Value]', a1.status, JSON.stringify(a1.data?.value));

    // setValue via the `windows:` execute method (exercises executeMethodMap routing).
    const T2 = 'beta-456';
    const ex = await call('POST', `/session/${sid}/execute/sync`, {
      script: 'windows: setValue', args: [{ elementId: elId, value: T2 }],
    });
    const a2 = await call('GET', `/session/${sid}/element/${E}/attribute/Value`);
    console.log('[windows:setValue]', ex.status, '->Value', a2.status, JSON.stringify(a2.data?.value));

    // clear, then read back empty.
    await call('POST', `/session/${sid}/element/${E}/clear`);
    const a3 = await call('GET', `/session/${sid}/element/${E}/attribute/Value`);
    console.log('[clear->Value]', a3.status, JSON.stringify(a3.data?.value));

    // a plain UIA attribute.
    const cn = await call('GET', `/session/${sid}/element/${E}/attribute/ClassName`);
    console.log('[ClassName]', cn.status, JSON.stringify(cn.data?.value));

    // New W3C reads: set text again, then getText / rect / enabled / displayed / selected.
    const T3 = 'gamma-789';
    await call('POST', `/session/${sid}/element/${E}/value`, { text: T3 });
    const txt = await call('GET', `/session/${sid}/element/${E}/text`);
    const rect = await call('GET', `/session/${sid}/element/${E}/rect`);
    const en = await call('GET', `/session/${sid}/element/${E}/enabled`);
    const dis = await call('GET', `/session/${sid}/element/${E}/displayed`);
    const sel = await call('GET', `/session/${sid}/element/${E}/selected`);
    console.log('[getText]', txt.status, JSON.stringify(txt.data?.value));
    console.log('[rect]', rect.status, JSON.stringify(rect.data?.value));
    console.log('[enabled/displayed/selected]', en.data?.value, dis.data?.value, sel.data?.value);

    // tag-name strategy (Notepad's text area is ControlType Document under UIA3).
    const tagEl = await call('POST', `/session/${sid}/element`, { using: 'tag name', value: 'Document' });
    console.log('[tag name]', tagEl.status, JSON.stringify(tagEl.data?.value).slice(0, 120));

    // windows: getValue (read-style execute command).
    const gv = await call('POST', `/session/${sid}/execute/sync`, {
      script: 'windows: getValue', args: [{ elementId: elId }],
    });
    console.log('[windows:getValue]', gv.status, JSON.stringify(gv.data?.value));

    pass =
      el.status === 200 && !!elId && xml.length > 0 &&
      a1.data?.value === T1 &&
      ex.status === 200 && a2.data?.value === T2 &&
      a3.data?.value === '' &&
      cn.data?.value === 'Edit' &&
      txt.data?.value === T3 &&
      (rect.data?.value?.width ?? 0) > 0 &&
      en.data?.value === true && dis.data?.value === true && sel.data?.value === false &&
      tagEl.status === 200 &&
      gv.status === 200 && gv.data?.value?.value === T3;
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
