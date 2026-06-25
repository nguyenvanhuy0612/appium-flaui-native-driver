// Manual E2E: drive the real Appium flaui driver through the sidecar and prove multi-line +
// Unicode PowerShell execute correctly via the `powerShell` command (the bug silently returned
// empty output / produced a 0-byte file for multi-line scripts). Attaches to explorer.exe.
// Requires the Appium server started with `--allow-insecure power_shell` (or relaxed-security).
//   APPIUM_BASE=http://<host>:4723 node tests/manual/powershell-multiline-e2e.mjs
// Last run: 6/6 pass against the patched sidecar (client qa-win37).
const BASE = process.env.APPIUM_BASE || 'http://127.0.0.1:4723';

const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
};
const del = (path) => fetch(BASE + path, { method: 'DELETE' });

const caps = {
  capabilities: {
    alwaysMatch: {
      platformName: 'Windows',
      'appium:automationName': 'flauinative',
      'appium:processName': 'explorer.exe',
      'appium:newCommandTimeout': 180,
    },
    firstMatch: [{}],
  },
};

const ps = (script) => ({ script: 'powerShell', args: [{ script }] });
const CN = '你好世界';      // 你好世界
const EMOJI = '\u{1F600}';                    // 😀

let sid;
let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const a = String(actual ?? '').replace(/\r?\n$/, '');
  const ok = a === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  expected=[${expected}] got=[${a}]`));
  ok ? pass++ : fail++;
};

try {
  const c = await post('/session', caps);
  if (c.status !== 200) { console.log('SESSION CREATE FAILED', c.status, JSON.stringify(c.j).slice(0, 400)); process.exit(1); }
  sid = c.j.value.sessionId;
  console.log('session:', sid);

  const run = async (script) => (await post(`/session/${sid}/execute/sync`, ps(script))).j.value;

  // T1 multi-line for-loop (the core fix: this used to return empty)
  check('T1 multiline-for', await run("$s=''\nfor($i=1;$i -le 3;$i++){ $s+=$i }\nWrite-Output $s"), '123');
  // T2 multi-line if/else block
  check('T2 multiline-if', await run("if($false){ throw 'x' }\nelse { Write-Output 'OK' }"), 'OK');
  // T3 Unicode (Chinese) value
  check('T3 chinese', await run(`Write-Output '${CN}'`), CN);
  // T4 Chinese inside a # comment, then a real statement
  check('T4 chinese-#comment', await run(`# ${CN} comment line\n$v='${CN}'; Write-Output $v`), CN);
  // T5 emoji
  check('T5 emoji', await run(`Write-Output '${EMOJI}'`), EMOJI);
  // T6 multi-line WITH side effects + readback (mirrors the transfer recombine)
  const t6 = "$p='C:/Temp/e2e_ml.txt'\n$lines=@('alpha','beta','gamma')\n$sb=New-Object System.Text.StringBuilder\nforeach($l in $lines){ [void]$sb.AppendLine($l) }\n[IO.File]::WriteAllText($p,$sb.ToString())\nWrite-Output ([IO.File]::ReadAllText($p).Trim())";
  check('T6 multiline-fileio', await run(t6), 'alpha\r\nbeta\r\ngamma');

  console.log(`==== E2E RESULT: pass=${pass} fail=${fail} ====`);
} catch (e) {
  console.log('ERROR', e.message);
} finally {
  if (sid) await del(`/session/${sid}`).catch(() => {});
}
process.exit(fail === 0 ? 0 : 2);
