// Phase A attribute-parity verify (run from the Mac against the .44 box).
//   APPIUM_BASE=http://172.16.10.44:4723 node scripts/verify-startbtn.mjs
//
// 1. Root (desktop) session → find the taskbar Start button (name=Start) → dump getAttributes "all" +
//    per-name reads → diff against docs/inspect.startbtn.md (LegacyIAccessible.*, Is*PatternAvailable,
//    ProviderDescription, IsDialog, BoundingRectangle).
// 2. Notepad session → find the Edit → setValue → confirm Value.Value (pattern dot-notation) reads back.
// Prints a property-by-property match/differ/unavailable table. Exits non-zero on a hard failure.

const BASE = (process.env.APPIUM_BASE ?? 'http://172.16.10.44:4723').replace(/\/$/, '');
const KEY = 'element-6066-11e4-a52e-4f735466cecf';
const TARGET_APP = process.env.TARGET_APP ?? 'C:\\Windows\\System32\\notepad.exe';

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, value: json?.value, raw: text };
}

const newSession = (caps) =>
  req('POST', '/session', { capabilities: { alwaysMatch: { platformName: 'windows', 'appium:automationName': 'FlaUINative', ...caps } } });
const del = (sid) => req('DELETE', `/session/${sid}`);
const find = (sid, using, value) => req('POST', `/session/${sid}/element`, { using, value });
const eid = (v) => (v && (v[KEY] ?? v.ELEMENT)) || undefined;
const execute = (sid, script, args = []) => req('POST', `/session/${sid}/execute/sync`, { script, args });

function norm(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}
// inspect "push button (0x2B)" vs our hex casing — compare role/state by the leading text + hex value.
function roleStateEq(got, want) {
  const g = norm(got).toLowerCase().replace(/\s+/g, ' ');
  const w = norm(want).toLowerCase().replace(/\s+/g, ' ');
  return g === w;
}

const results = [];
function check(name, got, want, eq = (a, b) => norm(a) === norm(b)) {
  const ok = eq(got, want);
  results.push({ name, got, want, status: ok ? 'MATCH' : 'DIFFER' });
  return ok;
}
function note(name, got, status = 'INFO') {
  results.push({ name, got, want: '', status });
}

async function main() {
  let rootSid, npSid;
  try {
    // ── 1. Root session + Start button ──────────────────────────────────────────────────────
    const rs = await newSession({ 'appium:app': 'Root' });
    if (rs.status !== 200) throw new Error(`Root session failed: ${rs.status} ${rs.raw?.slice(0, 300)}`);
    rootSid = rs.value.sessionId;

    const fb = await find(rootSid, 'name', 'Start');
    if (fb.status !== 200) throw new Error(`find Start failed: ${fb.status} ${fb.raw?.slice(0, 300)}`);
    const startId = eid(fb.value);

    // Per-name getAttribute routes through the new PropertyResolver. Build an "all"-like dump by reading
    // every property of interest individually (W3C getAttribute returns strings/JSON-strings).
    const rawGet = async (n) => {
      const r = await req('GET', `/session/${rootSid}/element/${startId}/attribute/${encodeURIComponent(n)}`);
      return { status: r.status, value: r.value };
    };
    const get = async (n) => (await rawGet(n)).value;

    const names = [
      'LegacyIAccessible.Name', 'LegacyIAccessible.Value', 'LegacyIAccessible.Role', 'LegacyIAccessible.State',
      'LegacyIAccessible.DefaultAction', 'LegacyIAccessible.Description', 'LegacyIAccessible.Help',
      'LegacyIAccessible.KeyboardShortcut', 'LegacyIAccessible.ChildId',
      'IsInvokePatternAvailable', 'IsLegacyIAccessiblePatternAvailable', 'IsValuePatternAvailable',
      'IsTogglePatternAvailable', 'IsExpandCollapsePatternAvailable', 'IsScrollPatternAvailable',
      'IsSelectionPatternAvailable', 'IsWindowPatternAvailable', 'IsGridPatternAvailable',
      'IsRangeValuePatternAvailable', 'IsTextPatternAvailable', 'IsTextPattern2Available',
      'IsTransform2PatternAvailable',
      'ProviderDescription', 'IsDialog', 'BoundingRectangle', 'Name', 'ControlType', 'NativeWindowHandle',
    ];
    const all = {};
    for (const n of names) all[n] = await get(n);
    console.log('\n=== per-name getAttribute dump (Start button) ===');
    console.log(JSON.stringify(all, null, 2));

    // LegacyIAccessible.*
    check('LegacyIAccessible.Name', all['LegacyIAccessible.Name'], 'Start');
    check('LegacyIAccessible.Value', all['LegacyIAccessible.Value'], '');
    check('LegacyIAccessible.Role', all['LegacyIAccessible.Role'], 'push button (0x2B)', roleStateEq);
    check('LegacyIAccessible.State', all['LegacyIAccessible.State'], 'focusable (0x100000)', roleStateEq);
    check('LegacyIAccessible.DefaultAction', all['LegacyIAccessible.DefaultAction'], 'Press');
    check('LegacyIAccessible.Description', all['LegacyIAccessible.Description'], '');
    check('LegacyIAccessible.Help', all['LegacyIAccessible.Help'], '');
    check('LegacyIAccessible.KeyboardShortcut', all['LegacyIAccessible.KeyboardShortcut'], '');
    check('LegacyIAccessible.ChildId', all['LegacyIAccessible.ChildId'], 0, (a, b) => Number(a) === Number(b));

    // Is*PatternAvailable flags (inspect: Invoke + LegacyIAccessible true, all else false).
    const flagEq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    check('IsInvokePatternAvailable', all['IsInvokePatternAvailable'], true, flagEq);
    check('IsLegacyIAccessiblePatternAvailable', all['IsLegacyIAccessiblePatternAvailable'], true, flagEq);
    for (const f of ['IsValuePatternAvailable', 'IsTogglePatternAvailable', 'IsExpandCollapsePatternAvailable',
      'IsScrollPatternAvailable', 'IsSelectionPatternAvailable', 'IsWindowPatternAvailable',
      'IsGridPatternAvailable', 'IsRangeValuePatternAvailable', 'IsTextPatternAvailable']) {
      check(f, all[f], false, flagEq);
    }

    // Direct props.
    check('ProviderDescription present', String(all['ProviderDescription'] ?? '').length > 0, true,
      (a, b) => a === b);
    note('ProviderDescription', all['ProviderDescription']);
    check('IsDialog', all['IsDialog'], false, flagEq);

    // BoundingRectangle: structured + readable via per-name getAttribute (JSON string).
    const brAttr = all['BoundingRectangle'];
    note('BoundingRectangle (getAttribute)', brAttr);
    let brOk = false;
    try {
      const o = JSON.parse(brAttr);
      brOk = ['x', 'y', 'width', 'height'].every((k) => typeof o[k] === 'number');
    } catch { /* ignore */ }
    check('BoundingRectangle well-formed {x,y,width,height}', brOk, true, (a, b) => a === b);
    check('BoundingRectangle not [object Object]', String(brAttr).includes('[object'), false, (a, b) => a === b);

    // Unknown-but-plausible name must NOT 400.
    const unkRes = await req('GET', `/session/${rootSid}/element/${startId}/attribute/Toggle.ToggleState`);
    note('GET Toggle.ToggleState (unsupported pattern)', `status=${unkRes.status} value=${JSON.stringify(unkRes.value)}`);
    check('unsupported pattern dot-notation does not 400', unkRes.status, 200, (a, b) => a === b);

    const bogusRes = await req('GET', `/session/${rootSid}/element/${startId}/attribute/IsTogglePatternAvailable`);
    note('GET IsTogglePatternAvailable', `status=${bogusRes.status} value=${JSON.stringify(bogusRes.value)}`);

    // ── 2. Notepad Value.Value (pattern dot-notation) ───────────────────────────────────────
    const ns = await newSession({ 'appium:app': TARGET_APP });
    if (ns.status === 200) {
      npSid = ns.value.sessionId;
      let editId;
      for (const [u, v] of [['class name', 'Edit'], ['tag name', 'Document'], ['tag name', 'Edit'], ['class name', 'RichEditD2DPT']]) {
        const r = await find(npSid, u, v);
        if (r.status === 200) { editId = eid(r.value); break; }
      }
      if (editId) {
        await req('POST', `/session/${npSid}/element/${editId}/value`, { text: 'hello-phaseA' });
        const vv = await req('GET', `/session/${npSid}/element/${editId}/attribute/Value.Value`);
        note('Notepad Value.Value (dot-notation)', `status=${vv.status} value=${JSON.stringify(vv.value)}`);
        check('Value.Value reads back set text', String(vv.value ?? ''), 'hello-phaseA',
          (a) => String(a).includes('hello-phaseA'));
      } else {
        note('Notepad Edit', 'NOT FOUND', 'UNAVAILABLE');
      }
    } else {
      note('Notepad session', `failed ${ns.status}`, 'UNAVAILABLE');
    }
  } finally {
    if (rootSid) await del(rootSid).catch(() => {});
    if (npSid) await del(npSid).catch(() => {});
  }

  // ── report ──
  console.log('\n=== Property-by-property vs inspect ===');
  let fails = 0;
  for (const r of results) {
    if (r.status === 'DIFFER') fails++;
    const g = r.got === undefined ? '(missing)' : JSON.stringify(r.got);
    const w = r.want === '' ? '' : ` want=${JSON.stringify(r.want)}`;
    console.log(`[${r.status}] ${r.name}: got=${g}${w}`);
  }
  console.log(`\n${fails === 0 ? 'ALL CHECKS MATCH' : fails + ' CHECK(S) DIFFER'}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
