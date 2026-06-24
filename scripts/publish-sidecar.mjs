// Publishes the sidecar as a self-contained, NON-single-file FOLDER per architecture (ADR-019).
// The exe + runtime DLLs sit side by side and are loaded directly — there is NO runtime self-extraction
// (which hardened / security-product hosts block: a process writing decompressed executables to disk then
// loading them trips real-time protection). Run on Windows: node scripts/publish-sidecar.mjs
import { execSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const arches = ['win-x64', 'win-x86', 'win-arm64'];
for (const rid of arches) {
  const out = `prebuilt/${rid}`;
  rmSync(out, { recursive: true, force: true }); // drop any stale (e.g. single-file) build first
  mkdirSync(out, { recursive: true });
  const cmd = [
    'dotnet publish sidecar/FlaUiSidecar.csproj',
    '-c Release',
    `-r ${rid}`,
    '--self-contained true',
    '-p:PublishSingleFile=false',
    '-p:EnableWindowsTargeting=true',
    '-p:SatelliteResourceLanguages=en', // drop WinForms/WPF localized satellite DLLs (unused; InvariantGlobalization)
    `-o ${out}`,
  ].join(' ');
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}
console.log('Sidecar published (non-single-file folder) to prebuilt/.');
