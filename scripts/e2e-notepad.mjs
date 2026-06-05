// Standalone E2E smoke: drives a real Appium 3 server (no webdriverio dependency) to verify the
// FlaUINative driver against Notepad. Run on Windows with `appium` already listening.
//   node scripts/e2e-notepad.mjs
// Phase 1 (main): launch, find, source(+schema), setValue/clear/getAttribute, W3C reads, windows: cmds.
// Phase 2 (attach): launch w/ shouldCloseApp:false, grab HWND, re-attach via appTopLevelWindow.
// Exits 0 only if BOTH phases pass.
const BASE = process.env.APPIUM_BASE || 'http://127.0.0.1:4723';
const W3C_KEY = 'element-6066-11e4-a52e-4f735466cecf';

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

const capsWith = (extra = {}) => ({
  capabilities: {
    alwaysMatch: {
      platformName: 'Windows',
      'appium:automationName': 'FlaUINative',
      ...extra,
    },
    firstMatch: [{}],
  },
});

async function mainFlow() {
  let sid;
  let pass = false;
  try {
    const s = await call('POST', '/session', capsWith({ 'appium:app': 'notepad.exe' }));
    console.log('[session]', s.status, JSON.stringify(s.data).slice(0, 300));
    sid = s.data?.value?.sessionId;
    if (!sid) throw new Error('no sessionId returned');

    const el = await call('POST', `/session/${sid}/element`, { using: 'class name', value: 'Edit' });
    console.log('[find]', el.status, JSON.stringify(el.data).slice(0, 200));
    const elId = el.data?.value?.[W3C_KEY];
    const E = encodeURIComponent(elId);

    const src = await call('GET', `/session/${sid}/source`);
    const xml = typeof src.data?.value === 'string' ? src.data.value : '';
    if (src.status !== 200) console.log('[source ERR]', src.status, JSON.stringify(src.data).slice(0, 500));
    console.log('[source]', src.status, 'len=', xml.length, '|', xml.slice(0, 200).replace(/\n/g, ' '));
    // page-source schema markers: full property set, relative coords, pattern attrs.
    const schemaOk =
      xml.includes('LocalizedControlType="') && xml.includes(' x="') && xml.includes(' width="') &&
      xml.includes('IsKeyboardFocusable="') && xml.includes('CanMaximize="');
    console.log('[schema]', schemaOk ? 'ok' : 'MISSING ATTRS');

    const T1 = 'alpha-123';
    await call('POST', `/session/${sid}/element/${E}/value`, { text: T1 });
    const a1 = await call('GET', `/session/${sid}/element/${E}/attribute/Value`);
    console.log('[setValue->Value]', a1.status, JSON.stringify(a1.data?.value));

    const T2 = 'beta-456';
    const ex = await call('POST', `/session/${sid}/execute/sync`, {
      script: 'windows: setValue', args: [{ elementId: elId, value: T2 }],
    });
    const a2 = await call('GET', `/session/${sid}/element/${E}/attribute/Value`);
    console.log('[windows:setValue]', ex.status, '->Value', a2.status, JSON.stringify(a2.data?.value));

    await call('POST', `/session/${sid}/element/${E}/clear`);
    const a3 = await call('GET', `/session/${sid}/element/${E}/attribute/Value`);
    console.log('[clear->Value]', a3.status, JSON.stringify(a3.data?.value));

    const cn = await call('GET', `/session/${sid}/element/${E}/attribute/ClassName`);
    console.log('[ClassName]', cn.status, JSON.stringify(cn.data?.value));

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

    const tagEl = await call('POST', `/session/${sid}/element`, { using: 'tag name', value: 'Document' });
    console.log('[tag name]', tagEl.status, JSON.stringify(tagEl.data?.value).slice(0, 120));

    const gv = await call('POST', `/session/${sid}/execute/sync`, {
      script: 'windows: getValue', args: [{ elementId: elId }],
    });
    console.log('[windows:getValue]', gv.status, JSON.stringify(gv.data?.value));

    // Input layer: REAL pointer click focuses the Edit; REAL keyboard types into it.
    await call('POST', `/session/${sid}/element/${E}/clear`);
    const clk = await call('POST', `/session/${sid}/element/${E}/click`);
    const hf = await call('GET', `/session/${sid}/element/${E}/attribute/HasKeyboardFocus`);
    const ks = await call('POST', `/session/${sid}/execute/sync`, {
      script: 'windows: keys', args: [{ actions: [{ text: 'typed-via-keys' }] }],
    });
    const kv = await call('GET', `/session/${sid}/element/${E}/attribute/Value`);
    console.log('[click]', clk.status, 'focus=', JSON.stringify(hf.data?.value),
      '[keys]', ks.status, '->Value', JSON.stringify(kv.data?.value));
    const sc = await call('POST', `/session/${sid}/execute/sync`, {
      script: 'windows: scroll', args: [{ elementId: elId, deltaY: -2 }],
    });
    const hv = await call('POST', `/session/${sid}/execute/sync`, {
      script: 'windows: hover', args: [{ elementId: elId }],
    });
    console.log('[scroll/hover]', sc.status, hv.status);

    // W3C Actions API: pointer click on the Edit, then key actions type "xyz".
    await call('POST', `/session/${sid}/element/${E}/clear`);
    const act = await call('POST', `/session/${sid}/actions`, {
      actions: [
        { type: 'pointer', id: 'mouse1', parameters: { pointerType: 'mouse' }, actions: [
          { type: 'pointerMove', origin: { [W3C_KEY]: elId }, x: 0, y: 0 },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ] },
        { type: 'key', id: 'kb1', actions: [
          { type: 'keyDown', value: 'x' }, { type: 'keyUp', value: 'x' },
          { type: 'keyDown', value: 'y' }, { type: 'keyUp', value: 'y' },
          { type: 'keyDown', value: 'z' }, { type: 'keyUp', value: 'z' },
        ] },
      ],
    });
    const av = await call('GET', `/session/${sid}/element/${E}/attribute/Value`);
    console.log('[actions]', act.status, '->Value', JSON.stringify(av.data?.value));

    // Screenshots (PNG base64).
    const shot = await call('GET', `/session/${sid}/screenshot`);
    const eshot = await call('GET', `/session/${sid}/element/${E}/screenshot`);
    const pngOk = typeof shot.data?.value === 'string' && shot.data.value.startsWith('iVBOR') && shot.data.value.length > 1000;
    const epngOk = typeof eshot.data?.value === 'string' && eshot.data.value.startsWith('iVBOR');
    console.log('[screenshot]', shot.status, pngOk, '[element-shot]', eshot.status, epngOk);

    // Clipboard roundtrip (plaintext base64).
    const clipB64 = Buffer.from('clip-hello').toString('base64');
    const setc = await call('POST', `/session/${sid}/execute/sync`, {
      script: 'windows: setClipboard', args: [{ b64: clipB64 }],
    });
    const getc = await call('POST', `/session/${sid}/execute/sync`, {
      script: 'windows: getClipboard', args: [{}],
    });
    const clipOk = getc.data?.value === clipB64;
    console.log('[clipboard]', setc.status, getc.status, clipOk);

    pass =
      el.status === 200 && !!elId && xml.length > 0 && schemaOk &&
      a1.data?.value === T1 &&
      ex.status === 200 && a2.data?.value === T2 &&
      a3.data?.value === '' &&
      cn.data?.value === 'Edit' &&
      txt.data?.value === T3 &&
      (rect.data?.value?.width ?? 0) > 0 &&
      en.data?.value === true && dis.data?.value === true && sel.data?.value === false &&
      tagEl.status === 200 &&
      gv.status === 200 && gv.data?.value?.value === T3 &&
      clk.status === 200 && hf.data?.value === 'true' &&
      ks.status === 200 && kv.data?.value === 'typed-via-keys' &&
      sc.status === 200 && hv.status === 200 &&
      act.status === 200 && av.data?.value === 'xyz' &&
      shot.status === 200 && pngOk && eshot.status === 200 && epngOk &&
      setc.status === 200 && getc.status === 200 && clipOk;
  } catch (e) {
    console.log('MAIN_ERROR', e?.message || String(e));
  } finally {
    if (sid) { try { await call('DELETE', `/session/${sid}`); } catch { /* ignore */ } }
  }
  console.log(pass ? 'MAIN_PASS' : 'MAIN_FAIL');
  return pass;
}

async function attachFlow() {
  let sidA, sidB, hwnd;
  let ok = false;
  try {
    // Launch with shouldCloseApp:false so Notepad survives session A.
    const sA = await call('POST', '/session', capsWith({ 'appium:app': 'notepad.exe', 'appium:shouldCloseApp': false }));
    sidA = sA.data?.value?.sessionId;
    const win = await call('POST', `/session/${sidA}/element`, { using: 'class name', value: 'Notepad' });
    const wid = win.data?.value?.[W3C_KEY];
    const hw = await call('GET', `/session/${sidA}/element/${encodeURIComponent(wid)}/attribute/NativeWindowHandle`);
    hwnd = hw.data?.value;
    console.log('[hwnd]', hw.status, hwnd);
  } catch (e) {
    console.log('ATTACH_SETUP_ERROR', e?.message || String(e));
  } finally {
    if (sidA) { try { await call('DELETE', `/session/${sidA}`); } catch { /* ignore */ } }
  }

  try {
    // Re-attach to the still-open Notepad by HWND (no app capability).
    const sB = await call('POST', '/session', capsWith({ 'appium:appTopLevelWindow': hwnd }));
    sidB = sB.data?.value?.sessionId;
    console.log('[attach session]', sB.status, sidB ? 'ok' : JSON.stringify(sB.data).slice(0, 300));
    const ed = await call('POST', `/session/${sidB}/element`, { using: 'class name', value: 'Edit' });
    const eid = ed.data?.value?.[W3C_KEY];
    const E = encodeURIComponent(eid);
    await call('POST', `/session/${sidB}/element/${E}/value`, { text: 'attached-ok' });
    const v = await call('GET', `/session/${sidB}/element/${E}/attribute/Value`);
    console.log('[attached setValue->Value]', v.status, JSON.stringify(v.data?.value));
    ok = /^0x[0-9A-Fa-f]+$/.test(hwnd || '') && !!sidB && v.data?.value === 'attached-ok';
  } catch (e) {
    console.log('ATTACH_ERROR', e?.message || String(e));
  } finally {
    // shouldCloseApp defaults true → deleting session B closes the attached Notepad (WindowPattern).
    if (sidB) { try { await call('DELETE', `/session/${sidB}`); } catch { /* ignore */ } }
  }
  console.log(ok ? 'ATTACH_PASS' : 'ATTACH_FAIL');
  return ok;
}

(async () => {
  const a = await mainFlow();
  const b = await attachFlow();
  console.log(a && b ? 'E2E_PASS' : 'E2E_FAIL');
  process.exit(a && b ? 0 : 1);
})();
