'use strict';
// 剪贴板 helper 构建与内存自测：不注册系统监听、不读写系统剪贴板。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { build } = require('../scripts/build-clipboard-helper.cjs');

const ROOT = path.resolve(__dirname, '..');
const HELPER = path.join(ROOT, 'native', 'clipboard-helper.exe');

test('缺本机 Framework 编译器时明确报错，不尝试安装', () => {
  assert.throws(() => build({ platform: 'win32', windowsRoot: path.join(os.tmpdir(), 'no-windows-root') }),
    /缺少本机 Framework 编译器/);
});

test('缺引用程序集时直接说要装什么，不静默降级', () => {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-build-fake-'));
  try {
    const framework = path.join(fake, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
    fs.mkdirSync(framework, { recursive: true });
    fs.writeFileSync(path.join(framework, 'csc.exe'), '');
    // 只放 csc，不放引用程序集。
    assert.throws(() => build({ platform: 'win32', windowsRoot: fake, run: () => ({ status: 0 }) }),
      /缺少 System\.dll/);
  } finally { fs.rmSync(fake, { recursive: true, force: true }); }
});

test('非 Windows 平台拒绝构建', () => {
  assert.throws(() => build({ platform: 'linux' }), /只能在 Windows 构建/);
});

test('编译失败要如实报错，不把失败说成成功', () => {
  assert.throws(() => build({ run: () => ({ status: 1, stderr: 'E_COMPILE' }) }), /E_COMPILE/);
});

test('本机 helper 已构建并通过 --self-test（只合成 DataObject 与内存图）', { skip: process.platform !== 'win32' }, () => {
  if (!fs.existsSync(HELPER)) build();
  assert.ok(fs.existsSync(HELPER), 'helper 应已生成');
  const result = spawnSync(HELPER, ['--self-test'], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || '自测失败');
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.ok, true);
  assert.equal(output.selfTest, true);
  assert.equal(result.stderr.trim(), '', '自测不该往 stderr 写内容');
});

test('参数错误只回安全错误码', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync(HELPER, ['--bogus'], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr.trim(), /^E_ARGS$/);
});
