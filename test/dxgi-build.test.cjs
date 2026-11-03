'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'native', 'dxgi-capture.cs');
const exe = path.join(root, 'native', 'dxgi-capture.exe');

test('DXGI 采集源走 duplication 路线，不复用 WGC 会话，也不自己画指针', () => {
  const text = fs.readFileSync(source, 'utf8');
  assert.match(text, /JGC2/, '必须复用 JGC2 帧协议');
  assert.match(text, /DuplicateOutput/, '必须使用 IDXGIOutput1::DuplicateOutput');
  assert.doesNotMatch(text, /GraphicsCaptureSession/, '不得再走 WGC 会话');
  assert.doesNotMatch(text, /DrawIcon/, '不得自己画指针');
  assert.doesNotMatch(text, /GraphicsCaptureItem/, '不得依赖 WGC 捕获项');
});

test('DXGI 采集源只使用已核对的基础接口槽位', () => {
  const text = fs.readFileSync(source, 'utf8');
  assert.match(text, /AcquireNextFrame>\(duplication, 8\)/, 'AcquireNextFrame 必须是槽位 8');
  assert.match(text, /ReleaseFrame>\(duplication, 14\)/, 'ReleaseFrame 必须是槽位 14');
  assert.match(text, /DuplicateOutput1>\(output1, 26\)/, 'DuplicateOutput1 必须是槽位 26');
  assert.match(text, /releaseFrame\(duplication\)/, '必须释放取到的帧');
});

test('DXGI ABI与失败边界显式保留，静态检查不冒充真实取屏', () => {
  const text = fs.readFileSync(source, 'utf8');
  assert.match(text, /MODE_ROTATION_IDENTITY = 1;/);
  assert.match(text, /delegate void CopyRegion\(/);
  assert.match(text, /delegate void GetTextureDesc\(/);
  assert.match(text, /delegate int DeviceStatus\(IntPtr self\);/);
  assert.match(text, /\[DllImport\("user32.dll"\)\] static extern IntPtr GetThreadDesktop/);
  assert.match(text, /if \(info.LastMouseUpdateTime != 0\)/);
  assert.match(text, /if \(!pointerKnown \|\| !pointerSeparate\) throw/);
  assert.match(text, /if \(info.ProtectedContentMaskedOut != 0\) throw/);
  assert.doesNotMatch(text, /--allow-pointer/);
  assert.ok(text.indexOf('Marshal.ThrowExceptionForHR(released)') < text.indexOf('Write(stdout, width, height, sequence, true, rgba)'));
});

test('DXGI 组件自检输出合法 JGC2 2x2 帧', (t) => {
  if (!fs.existsSync(exe)) { t.skip('尚未构建 native/dxgi-capture.exe'); return; }
  const run = spawnSync(exe, ['--self-test'], { windowsHide: true, timeout: 15000 });
  assert.equal(run.status, 0, run.stderr && run.stderr.toString());
  const out = run.stdout;
  assert.equal(out.slice(0, 4).toString('ascii'), 'JGC2');
  assert.equal(out.readUInt32LE(4), 2);
  assert.equal(out.readUInt32LE(8), 2);
  assert.equal(out.readUInt32LE(12), 1);
  assert.equal(out.readUInt32LE(16), 1);
  assert.equal(out.length, 20 + 16);
});
