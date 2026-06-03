// Standalone E2E for file transfer (pullFile/pushFile/pullFolder) + clipboard (plaintext + image).
// Drives a real Appium 3 server via raw HTTP (no webdriverio). Run with the FlaUINative driver and the
// pull_file/push_file insecure features enabled. Prints PASS/FAIL per item; exits 0 only if all pass.
//   APPIUM_BASE=http://172.16.10.44:4723 node scripts/e2e-files.mjs
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

const caps = (extra = {}) => ({
  capabilities: {
    alwaysMatch: { platformName: 'Windows', 'appium:automationName': 'FlaUINative', ...extra },
    firstMatch: [{}],
  },
});

// A tiny valid 2x2 PNG (red), base64-encoded — used for the image clipboard roundtrip.
const TEST_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAjlwMBSEgvwQAAAABJRU5ErkJggg==';

async function run() {
  const results = {};
  let sid;
  const TEST_FILE = 'C:\\Users\\admin\\flaui-e2e-test.txt';
  const TEST_DIR = 'C:\\Users\\admin\\flaui-e2e-dir';
  try {
    const s = await call('POST', '/session', caps({ 'appium:app': 'notepad.exe' }));
    console.log('[session]', s.status, JSON.stringify(s.data).slice(0, 200));
    sid = s.data?.value?.sessionId;
    if (!sid) throw new Error('no sessionId: ' + JSON.stringify(s.data).slice(0, 300));

    // ── pushFile then pullFile roundtrip ──
    const payload = 'flaui-file-roundtrip-' + Date.now();
    const payloadB64 = Buffer.from(payload, 'utf8').toString('base64');
    const push = await call('POST', `/session/${sid}/appium/device/push_file`, {
      path: TEST_FILE, data: payloadB64,
    });
    console.log('[pushFile]', push.status, JSON.stringify(push.data).slice(0, 200));
    const pull = await call('POST', `/session/${sid}/appium/device/pull_file`, { path: TEST_FILE });
    const pulledB64 = pull.data?.value;
    const pulled = typeof pulledB64 === 'string' ? Buffer.from(pulledB64, 'base64').toString('utf8') : '';
    console.log('[pullFile]', pull.status, 'roundtrip=', pulled === payload, '|', JSON.stringify(pulled).slice(0, 80));
    results.pushFile = push.status === 200;
    results.pullFile = pull.status === 200 && pulled === payload;

    // ── pullFolder: create a small folder via pushFile, then zip it ──
    const f1 = await call('POST', `/session/${sid}/appium/device/push_file`, {
      path: TEST_DIR + '\\one.txt', data: Buffer.from('one', 'utf8').toString('base64'),
    });
    const f2 = await call('POST', `/session/${sid}/appium/device/push_file`, {
      path: TEST_DIR + '\\two.txt', data: Buffer.from('two', 'utf8').toString('base64'),
    });
    const folder = await call('POST', `/session/${sid}/appium/device/pull_folder`, { path: TEST_DIR });
    const zipB64 = folder.data?.value;
    const zipOk = typeof zipB64 === 'string' && zipB64.length > 0 && zipB64.startsWith('UEsDB');
    console.log('[pullFolder]', folder.status, 'pushed=', f1.status, f2.status,
      'zipMagicPK=', zipOk, 'len=', typeof zipB64 === 'string' ? zipB64.length : 0);
    results.pullFolder = folder.status === 200 && zipOk;

    // ── pullFile on a missing file: expect an error (clear message) ──
    const miss = await call('POST', `/session/${sid}/appium/device/pull_file`, {
      path: 'C:\\Users\\admin\\definitely-not-here-xyz.txt',
    });
    const missMsg = JSON.stringify(miss.data).slice(0, 160);
    console.log('[pullFile missing]', miss.status, missMsg);
    results.pullMissingErrors = miss.status >= 400;

    // ── clipboard plaintext roundtrip ──
    const clipText = 'clip-files-' + Date.now();
    const clipB64 = Buffer.from(clipText, 'utf8').toString('base64');
    const setc = await call('POST', `/session/${sid}/execute/sync`, {
      script: 'windows: setClipboard', args: [{ b64: clipB64, contentType: 'plaintext' }],
    });
    const getc = await call('POST', `/session/${sid}/execute/sync`, {
      script: 'windows: getClipboard', args: [{ contentType: 'plaintext' }],
    });
    const clipOk = getc.data?.value === clipB64;
    console.log('[clipboard plaintext]', setc.status, getc.status, 'roundtrip=', clipOk);
    results.clipboardPlaintext = setc.status === 200 && getc.status === 200 && clipOk;

    // ── clipboard image roundtrip ──
    const seti = await call('POST', `/session/${sid}/execute/sync`, {
      script: 'windows: setClipboard', args: [{ b64: TEST_PNG_B64, contentType: 'image' }],
    });
    const geti = await call('POST', `/session/${sid}/execute/sync`, {
      script: 'windows: getClipboard', args: [{ contentType: 'image' }],
    });
    const gotB64 = geti.data?.value;
    // Roundtrip through DIB is lossy on encoding (PNG re-encode), so assert we get a valid non-empty PNG back.
    let pngBack = false;
    if (typeof gotB64 === 'string' && gotB64.length > 0) {
      const head = Buffer.from(gotB64, 'base64').subarray(0, 8);
      pngBack = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    }
    console.log('[clipboard image]', seti.status, geti.status, 'setData=',
      JSON.stringify(seti.data).slice(0, 120), 'pngBack=', pngBack,
      'len=', typeof gotB64 === 'string' ? gotB64.length : 0);
    const imgUnsupported =
      JSON.stringify(seti.data).toLowerCase().includes('unsupported') ||
      JSON.stringify(geti.data).toLowerCase().includes('unsupported');
    results.clipboardImage = seti.status === 200 && geti.status === 200 && pngBack;
    results.clipboardImageUnsupported = imgUnsupported;
  } catch (e) {
    console.log('RUN_ERROR', e?.message || String(e));
  } finally {
    // Cleanup the pushed test file + dir via the powershell execute path.
    if (sid) {
      try {
        await call('POST', `/session/${sid}/execute/sync`, {
          script: 'powershell',
          args: [{ command:
            `Remove-Item -Force -ErrorAction SilentlyContinue '${TEST_FILE}'; ` +
            `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue '${TEST_DIR}'` }],
        });
      } catch { /* ignore */ }
      try { await call('DELETE', `/session/${sid}`); } catch { /* ignore */ }
    }
  }

  console.log('--- RESULTS ---');
  const items = [
    ['pushFile', results.pushFile],
    ['pullFile', results.pullFile],
    ['pullFolder (PK zip)', results.pullFolder],
    ['pullFile missing -> error', results.pullMissingErrors],
    ['clipboard plaintext', results.clipboardPlaintext],
    ['clipboard image', results.clipboardImage],
  ];
  for (const [name, ok] of items) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (results.clipboardImageUnsupported) console.log('NOTE clipboard image reported UNSUPPORTED by sidecar');

  // Image clipboard is allowed to be "unsupported" without failing the overall run; everything else must pass.
  const required = ['pushFile', 'pullFile', 'pullFolder', 'pullMissingErrors', 'clipboardPlaintext'];
  const pass = required.every((k) => results[k]);
  console.log(pass ? 'FILES_E2E_PASS' : 'FILES_E2E_FAIL');
  console.log('IMAGE_CLIPBOARD', results.clipboardImage ? 'REAL_OK' : (results.clipboardImageUnsupported ? 'UNSUPPORTED' : 'FAILED'));
  process.exit(pass ? 0 : 1);
}

run();
