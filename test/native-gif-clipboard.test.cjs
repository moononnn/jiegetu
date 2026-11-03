'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { build } = require('../scripts/build-gif-clipboard.cjs');
const root = path.resolve(__dirname, '..');
const exe = path.join(root, 'native/gif-clipboard.exe');
const run = args => spawnSync(exe, args, { windowsHide: true, encoding: 'utf8', timeout: 6000, maxBuffer: 16384 });
const windows = { skip: process.platform !== 'win32' };

test('build rejects non-Windows without invoking compiler', () => {
  assert.throws(() => build({ platform: 'linux', run: () => assert.fail('compiler called') }), /Windows/);
});
test('self-test dispatch is pure DataObject construction; only publish branch calls system Clipboard', () => {
  const source = fs.readFileSync(path.join(root, 'native/gif-clipboard.cs'), 'utf8');
  const self = source.slice(source.indexOf('static void SelfTest()'), source.indexOf('[STAThread]'));
  assert.doesNotMatch(self, /\bClipboard\s*\./);
  assert.match(self, /DataFormats\.FileDrop\)\.Id == 15/);
  assert.match(self, /EqualStream\(data, "GIF", bytes\)/);
  assert.match(self, /EqualStream\(data, "image\/gif", bytes\)/);
  assert.match(self, /EqualStream\(data, "Preferred DropEffect", new byte\[\] \{ 1, 0, 0, 0 \}\)/);
  assert.equal((source.match(/\bClipboard\s*\./g) || []).length, 1);
  assert.match(source, /if \(args\[0\] == "--publish"\)\s*\{[\s\S]*?Clipboard\.SetDataObject\(data, true, 5, 100\)/);
  assert.doesNotMatch(source, /Clipboard\.(Get|Clear)|DllImport|Process\.Start/);
});
test('compiled STA helper pure self-test: CF_HDROP 15, raw GIF/MIME and copy drop effect', windows, () => {
  assert.ok(fs.existsSync(exe), 'Build with node scripts/build-gif-clipboard.cjs first');
  const result = run(['--self-test']);
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, ''); assert.deepEqual(JSON.parse(result.stdout), { ok: true });
  assert.match(result.stdout, /^[\x00-\x7f]+$/);
});
test('inspect only parses bounded Unicode GIF files without modifying source; rejects invalid inputs', windows, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-helper-'));
  const file = path.join(directory, '中文 动画.gif');
  const bytes = Buffer.from([71,73,70,56,57,97,1,0,1,0,128,0,0,0,0,0,255,255,255,33,249,4,4,10,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59]);
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    const good = run(['--inspect', file]);
    assert.equal(good.status, 0, good.stderr); assert.deepEqual(JSON.parse(good.stdout), { ok: true });
    assert.deepEqual(fs.readFileSync(file), bytes);
    const invalid = [Buffer.alloc(0), Buffer.from('not a GIF file'),
      (() => { const b = Buffer.from(bytes); b.writeUInt16LE(4097, 6); return b; })(),
      (() => { const b = Buffer.from(bytes); b.writeUInt16LE(2001, 6); b.writeUInt16LE(2000, 8); return b; })(),
      Buffer.alloc(48 * 1024 * 1024 + 1)];
    for (const b of invalid) {
      fs.writeFileSync(file, b);
      const result = run(['--inspect', file]);
      assert.equal(result.status, 1); assert.equal(result.stdout, '');
      assert.equal(result.stderr.trim(), 'E_GIF_CLIPBOARD'); assert.deepEqual(fs.readFileSync(file), b);
    }
    assert.equal(run(['--inspect', 'relative.gif']).status, 1);
    assert.equal(run(['--inspect', path.join(directory, 'missing.gif')]).status, 1);
    assert.equal(run(['--unknown']).status, 2);
  } finally {
    // Only this test's own known temporary file/directory, never application cache.
    fs.unlinkSync(file); fs.rmdirSync(directory);
  }
});
