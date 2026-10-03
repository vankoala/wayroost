// Checks a packaged Wayroost.exe against package.json's build.electronFuses: every configured fuse
// flipped as configured, and, with embedded ASAR integrity on, the integrity resource it needs.
// Usage: node scripts/check-fuses.cjs [release/win-unpacked/Wayroost.exe]
const { readFileSync } = require('node:fs');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
const ENABLE = 49;
const DISABLE = 48;
async function checkFuses(exe, wanted) {
  const wire = await getCurrentFuseWire(exe);
  const problems = [];
  for (const [name, value] of Object.entries(wanted)) {
    const index = FuseV1Options[name[0].toUpperCase() + name.slice(1)];
    if (index === undefined) { problems.push(`${name}: not a fuse`); continue; }
    const state = wire[index];
    if (state !== (value ? ENABLE : DISABLE)) problems.push(`${name}: expected ${value ? 'enabled' : 'disabled'}, found ${state === ENABLE ? 'enabled' : state === DISABLE ? 'disabled' : `state ${state}`}`);
  }
  // electron-builder embeds the app.asar header hash as an INTEGRITY/ELECTRONASAR resource; without it the app won't start.
  if (wanted.enableEmbeddedAsarIntegrityValidation && !readFileSync(exe).includes(Buffer.from('ELECTRONASAR', 'utf16le'))) problems.push('ASAR integrity resource missing');
  return problems;
}
module.exports = { checkFuses };
if (require.main === module) {
  const exe = process.argv[2] ?? 'release/win-unpacked/Wayroost.exe';
  const wanted = JSON.parse(readFileSync('package.json', 'utf8')).build.electronFuses;
  checkFuses(exe, wanted).then((problems) => {
    if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; return; }
    console.log(`fuses: ${Object.keys(wanted).length} as configured`);
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
