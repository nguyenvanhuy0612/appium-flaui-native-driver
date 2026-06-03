// F22 / F23 — the power_shell / pull_file / push_file insecure-feature gates must fail LOUD (a hard throw),
// never be optionally chained away. The driver class transitively imports @appium/base-driver, whose ESM
// deep-deps trip tsx's loader, so we cannot `import` the driver inside this tsx-run spec. Instead we drive
// a tiny PLAIN-node child process that imports the BUILT driver and reports each gate's behavior. This
// exercises the real driver methods (execute/pullFile/pushFile) and the real base-driver gate.
import { expect } from 'chai';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const builtDriver = path.join(repoRoot, 'build/lib/driver.js');
// ESM import() of an absolute path needs a file:// URL on Windows (a bare C:\ path is rejected).
const builtDriverUrl = pathToFileURL(builtDriver).href;

// A self-contained node script: instantiate the driver, configure security, probe each gate, print JSON.
const PROBE = `
import { FlaUINativeDriver } from ${JSON.stringify(builtDriverUrl)};
function mk(allow) {
  const d = new FlaUINativeDriver({}, false);
  d.opts.automationName = 'FlaUINative';
  d.allowInsecure = allow; d.denyInsecure = []; d.relaxedSecurityEnabled = false;
  return d;
}
async function probe(fn) {
  try { await fn(); return { threw: false }; }
  catch (e) { return { threw: true, msg: String(e && e.message || e) }; }
}
const out = {};
out.psDenied   = await probe(() => mk([]).execute('powershell', [{ command: 'x' }]));
out.pullDenied = await probe(() => mk([]).pullFile('C:\\\\x.txt'));
out.pushDenied = await probe(() => mk([]).pushFile('C:\\\\x.txt', 'AAAA'));
out.psAllowed  = await probe(() => mk(['flauinative:power_shell']).execute('powershell', [{ command: 'x' }]));
process.stdout.write(JSON.stringify(out));
`;

describe('insecure-feature gates (F22/F23)', function () {
  let result: any;
  before(function () {
    if (!fs.existsSync(builtDriver)) this.skip(); // run `npm run build` first
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', PROBE], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    result = JSON.parse(raw);
  });

  it('execute("powershell") throws the feature error when power_shell is NOT enabled (loud gate)', () => {
    expect(result.psDenied.threw).to.equal(true);
    expect(result.psDenied.msg).to.match(/insecure feature 'power_shell' has not been/i);
  });

  it('pullFile throws when pull_file is NOT enabled', () => {
    expect(result.pullDenied.threw).to.equal(true);
    expect(result.pullDenied.msg).to.match(/insecure feature 'pull_file' has not been/i);
  });

  it('pushFile throws when push_file is NOT enabled', () => {
    expect(result.pushDenied.threw).to.equal(true);
    expect(result.pushDenied.msg).to.match(/insecure feature 'push_file' has not been/i);
  });

  it('the gate passes (no feature error) once the scoped feature is allowed', () => {
    // With the feature allowed and no sidecar wired, it fails PAST the gate (transport) — NOT at the gate.
    expect(result.psAllowed.threw).to.equal(true);
    expect(result.psAllowed.msg).to.not.match(/insecure feature/i);
  });
});
