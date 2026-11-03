'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { queryForegroundHwnd } = require('../main/foreground.cjs');

// Fake execFile only. This suite never starts the native helper.
const fake = (error, stdout, calls = []) => (exe, args, options, callback) => { calls.push({ exe, args, options }); callback(error, stdout); return { calls }; };

test('把原生 --fg 的句柄和进程号解析成前台窗口', async () => {
  const calls = [];
  assert.equal(await queryForegroundHwnd({ execFile: fake(null, '3211506 4242\n', calls), selfPid: 999 }), 3211506);
  assert.deepEqual(calls[0].args, ['--fg']);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(typeof calls[0].options.timeout, 'number');
  assert.ok(calls[0].exe.endsWith(path.join('native', 'gdi-capture.exe')));
});

test('前台是自己的窗口时不还焦点，回退为 0', async () => {
  assert.equal(await queryForegroundHwnd({ execFile: fake(null, '3211506 4242'), selfPid: 4242 }), 0);
});

for (const [label, error, stdout] of [
  ['报错', new Error('boom'), ''],
  ['空输出', null, ''],
  ['非数字', null, 'not-a-handle'],
  ['只有句柄没有进程号', null, '3211506'],
  ['零句柄', null, '0 4242'],
  ['负数', null, '-12 4242'],
  ['小数', null, '12.5 4242'],
  ['超长数字', null, '12345678901234567890 4242']
]) test(`${label}一律回退为 0，不拦截图`, async () => {
  assert.equal(await queryForegroundHwnd({ execFile: fake(error, stdout) }), 0);
});

test('execFile 同步抛错也回退为 0', async () => {
  assert.equal(await queryForegroundHwnd({ execFile: () => { throw new Error('spawn-failed'); } }), 0);
});

test('可显式指定原生路径，不经过 shell', async () => {
  const calls = [];
  await queryForegroundHwnd({ execFile: fake(null, '7 4242', calls), executable: 'C:/native helper/gdi-capture.exe', selfPid: 1 });
  assert.equal(calls[0].exe, 'C:/native helper/gdi-capture.exe');
});
