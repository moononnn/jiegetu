'use strict';
// Local-only static release proof. Does not launch, install or uninstall the application.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { verifyPayload } = require('../scripts/verify-review-build.cjs');
const root = path.resolve(process.argv[2]);
const version = require('../package.json').version;
const out = path.join(root, 'dist-release');
const walk = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  assert.ok(!e.isSymbolicLink(), 'Unexpected symlink: ' + prefix + e.name);
  return e.isDirectory() ? walk(path.join(dir, e.name), prefix + e.name + '/') : [prefix + e.name];
}).sort();
const digest = file => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file);
  stream.on('error', reject); stream.on('data', data => hash.update(data));
  stream.on('end', () => resolve(hash.digest('hex')));
});
async function tree(dir) {
  const result = [];
  for (const file of walk(dir)) result.push({ file, bytes: fs.statSync(path.join(dir, file)).size, sha256: await digest(path.join(dir, file)) });
  return result;
}
(async () => {
  const base = path.join(out, 'win-unpacked');
  const source = await tree(base);
  assert.ok(source.some(f => f.file === 'LICENSE.electron.txt'));
  assert.ok(source.some(f => f.file === 'LICENSES.chromium.html'));
  const checks = [];
  for (const kind of ['Setup', 'Portable']) {
    const target = path.join(out, 'verify-extract', kind);
    const actual = await tree(target);
    assert.deepEqual(actual, source, kind + ': embedded runtime differs from reviewed win-unpacked');
    const payload = verifyPayload({ root, target, profile: 'release' });
    assert.equal(payload.native.length, 6);
    for (const native of payload.native) assert.equal(native.machine, '8664', native.file);
    const name = `Jiegetu-${version}-${kind}-x64.exe`;
    const file = path.join(out, name);
    const fd = fs.openSync(file, 'r');
    try {
      const header = Buffer.alloc(64); fs.readSync(fd, header, 0, 64, 0);
      assert.equal(header.toString('ascii', 0, 2), 'MZ');
      const pe = Buffer.alloc(6); fs.readSync(fd, pe, 0, 6, header.readUInt32LE(60));
      assert.equal(pe.readUInt32LE(), 0x4550);
    } finally { fs.closeSync(fd); }
    checks.push({ name, bytes: fs.statSync(file).size, sha256: await digest(file), runtimeFiles: actual.length, payloadFiles: payload.payloadFiles, helperMachines: payload.native.map(p => ({ name: p.file, machine: p.machine })), runtimeMatches: true, sourceMatches: true });
  }
  const report = { version, checks, scope: 'Static extraction, byte hashes, runtime allowlist, PE and source comparison. No installation, GUI, actual capture or uninstall tested.', warnings: ['Unsigned binaries', '7-Zip locates the embedded 7z stream and reports wrapper data after the archive; CRC test and full extraction succeeded.'] };
  fs.writeFileSync(path.join(out, 'double-package-verification.json'), JSON.stringify(report, null, 2) + '\n');
  const sums = checks.map(c => `${c.sha256}  ${c.name}`).join('\n') + '\n';
  fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums);
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
