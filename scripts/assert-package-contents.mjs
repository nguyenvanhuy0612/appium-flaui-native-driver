// Safety net: refuse to publish a tarball that is missing the compiled driver or the
// self-contained sidecar exe. Runs from prepublishOnly so a publish from a box without a
// `prebuilt/` build (e.g. the Mac) fails loudly instead of shipping an empty package.
// Run: node scripts/assert-package-contents.mjs
import { existsSync } from 'node:fs';

const required = [
  'build/lib/driver.js',
  'prebuilt/win-x64/FlaUiSidecar.exe',
];
const warnIfMissing = [
  'prebuilt/win-x86/FlaUiSidecar.exe',
  'prebuilt/win-arm64/FlaUiSidecar.exe',
];

const missing = required.filter((p) => !existsSync(p));
if (missing.length > 0) {
  console.error('\nERROR: refusing to publish — required package contents are missing:');
  for (const p of missing) {
    console.error(`  - ${p}`);
  }
  console.error(
    '\nBuild first: `npm run build` (TypeScript) and `npm run publish:sidecar` (the C# sidecar,\n' +
    'which must run on Windows). Never publish from a box without a `prebuilt/` build.\n'
  );
  process.exit(1);
}

for (const p of warnIfMissing) {
  if (!existsSync(p)) {
    console.warn(`WARNING: ${p} is missing — the published tarball will be win-x64 only.`);
  }
}

console.log('Package contents OK: compiled driver + win-x64 sidecar present.');
