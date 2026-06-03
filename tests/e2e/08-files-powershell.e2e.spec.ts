// §6 Files & PowerShell — pushFile/pullFile/pullFolder roundtrips (endpoints + execute scripts),
// powershell stdout, missing-file error. Requires insecure features push_file/pull_file/power_shell.
import { expect } from 'chai';
import { w3c, SessionPool, b64, unb64 } from '../lib/helpers.js';

const TEST_FILE = 'C:\\Users\\admin\\flaui-suite-test.txt';
const TEST_DIR = 'C:\\Users\\admin\\flaui-suite-dir';

describe('§6 Files & PowerShell', function () {
  this.timeout(120_000);
  const pool = new SessionPool();
  let sid: string;
  before(async () => { sid = await pool.open(); });
  after(async () => {
    // Best-effort cleanup of artifacts via powershell, then sessions.
    try {
      await w3c.execute(sid, 'powershell', [{ command:
        `Remove-Item -Force -ErrorAction SilentlyContinue '${TEST_FILE}'; ` +
        `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue '${TEST_DIR}'` }]);
    } catch { /* ignore */ }
    await pool.cleanup();
  });

  it('pushFile then pullFile roundtrips via the appium device endpoints', async () => {
    const payload = 'roundtrip-' + Date.now();
    const push = await w3c.pushFile(sid, TEST_FILE, b64(payload));
    expect(push.status, `pushFile: ${push.raw?.slice(0, 200)}`).to.equal(200);
    const pull = await w3c.pullFile(sid, TEST_FILE);
    expect(pull.status).to.equal(200);
    expect(unb64(pull.value as string)).to.equal(payload);
  });

  it('pullFile / pushFile via execute scripts roundtrip', async () => {
    const payload = 'exec-roundtrip-' + Date.now();
    const push = await w3c.execute(sid, 'pushFile', [{ path: TEST_FILE, data: b64(payload) }]);
    expect(push.status, `execute pushFile: ${push.raw?.slice(0, 200)}`).to.equal(200);
    const pull = await w3c.execute(sid, 'pullFile', [{ path: TEST_FILE }]);
    expect(pull.status).to.equal(200);
    expect(unb64(pull.value as string)).to.equal(payload);
  });

  it('pullFolder returns a ZIP (PK magic) of the folder contents', async () => {
    await w3c.pushFile(sid, TEST_DIR + '\\one.txt', b64('one'));
    await w3c.pushFile(sid, TEST_DIR + '\\two.txt', b64('two'));
    const folder = await w3c.pullFolder(sid, TEST_DIR);
    expect(folder.status, `pullFolder: ${folder.raw?.slice(0, 200)}`).to.equal(200);
    const zip = folder.value as string;
    expect(zip).to.be.a('string').and.have.length.greaterThan(0);
    // ZIP local file header magic "PK\x03\x04".
    const head = Buffer.from(zip, 'base64').subarray(0, 4);
    expect([head[0], head[1], head[2], head[3]]).to.deep.equal([0x50, 0x4b, 0x03, 0x04]);
  });

  it('powershell execute returns stdout', async () => {
    const res = await w3c.execute(sid, 'powershell', [{ command: 'Write-Output flaui-ps-marker' }]);
    expect(res.status, `powershell: ${res.raw?.slice(0, 200)}`).to.equal(200);
    expect(String(res.value)).to.include('flaui-ps-marker');
  });

  it('pullFile on a missing file returns a clean error', async () => {
    const res = await w3c.pullFile(sid, 'C:\\Users\\admin\\definitely-not-here-xyz-suite.txt');
    expect(res.status, 'HTTP status').to.be.greaterThanOrEqual(400);
    expect(JSON.stringify(res.value).toLowerCase(),
      'error message should reference the missing path/file').to.match(/not|exist|find|missing|no such/);
  });
});
