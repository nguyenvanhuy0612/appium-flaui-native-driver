// Publishes the sidecar as a self-contained single-file exe per architecture (ADR-009).
// Run on Windows: node scripts/publish-sidecar.mjs
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const arches = ['win-x64', 'win-x86', 'win-arm64'];
for (const rid of arches) {
  const out = `prebuilt/${rid}`;
  mkdirSync(out, { recursive: true });
  const cmd = [
    'dotnet publish sidecar/FlaUiSidecar.csproj',
    '-c Release',
    `-r ${rid}`,
    '--self-contained true',
    '-p:PublishSingleFile=true',
    '-p:IncludeNativeLibrariesForSelfExtract=true',
    '-p:EnableCompressionInSingleFile=true',
    `-o ${out}`,
  ].join(' ');
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}
console.log('Sidecar published to prebuilt/.');
