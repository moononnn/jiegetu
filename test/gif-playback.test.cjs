'use strict';
// GIF 播放时钟回归：spawn 本机 Electron 跑 test/fixtures/gif-playback-probe.cjs（隐藏合成窗口）。
// 不采屏、不碰剪贴板、不联网、不启动真实应用；非 Windows 或缺 Electron 运行时明确 skip。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(__dirname, 'fixtures', 'gif-playback-probe.cjs');
const TIMEOUT_MS = 60_000;
// 探针里的断言名；新增项可以追加，已有项不许悄悄消失。
const EXPECTED = [
  '单帧 2000ms：播放头随钟前进，不再整段停在 0',
  '暂停不再走表，继续播从暂停点接着走',
  '变长帧：播放头在长帧内继续走，帧号按真实边界切换',
  '循环回到首帧但不重置播放钟',
  '暂停时的迟到解码不回退播放头、不重启播放',
  '暂停中异步 seek 后立即播放：从 seek 目标起播，不回退',
  '时间滑块 pointerdown 即暂停，拖动区间不被时钟写回',
  '延迟解码跨循环：绕回首帧后暂停，head/帧号/画面保持一致',
  '播放中 reset：迟到解码不复活画面'
];

function electronBinary() {
  if (process.platform !== 'win32') return { skip: `仅 Windows 有本机 Electron 合成窗口（当前 ${process.platform}）` };
  let resolved;
  try { resolved = require('electron'); } catch { return { skip: '未安装 Electron 运行时（node_modules/electron）' }; }
  if (typeof resolved !== 'string' || !fs.existsSync(resolved)) return { skip: '未安装 Electron 运行时（node_modules/electron）' };
  return { binary: resolved };
}

function runProbe(binary) {
  const env = { ...process.env };
  // 从普通 Node 里 spawn 时不能让它退化成 Node 进程。
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return spawnSync(binary, [PROBE], { cwd: ROOT, env, encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}

const found = electronBinary();
test('GIF 播放时钟：隐藏合成窗口证明播放头随钟、暂停与迟到解码', { skip: found.skip }, () => {
  const child = runProbe(found.binary);
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  if (child.error?.code === 'ETIMEDOUT') assert.fail(`合成探针 ${TIMEOUT_MS / 1000}s 未结束：${output.slice(-2000)}`);
  assert.equal(child.error, undefined, `无法启动 Electron：${child.error?.message}\n${output.slice(-2000)}`);
  assert.equal(child.status, 0, `探针退出码 ${child.status}（signal ${child.signal}）\n${output.slice(-2000)}`);

  const line = `${child.stdout ?? ''}`.split(/\r?\n/).map(text => text.trim()).filter(text => text.startsWith('{')).at(-1);
  assert.ok(line, `探针没有输出 JSON 报告：\n${output.slice(-2000)}`);
  const report = JSON.parse(line);

  assert.equal(report.result, 'GIF_PLAYBACK_PROBE_PASS', `${JSON.stringify(report.error ?? '')}\n${JSON.stringify(report.checks ?? [])}`);
  assert.equal(report.failure, null);
  assert.equal(report.synthetic, true);
  assert.equal(report.desktopRead, false, '不得采屏');
  assert.equal(report.clipboardReadOrWritten, false, '不得碰剪贴板');
  assert.equal(report.visibleWindow, false, '不得显示窗口');
  assert.equal(report.networkBlocked, true);

  assert.ok(Array.isArray(report.checks), '报告缺少 checks');
  const failed = report.checks.filter(check => !check.ok);
  assert.deepEqual(failed, [], '有断言失败');
  const names = report.checks.map(check => check.name);
  for (const name of EXPECTED) assert.ok(names.includes(name), `缺少时钟断言：${name}`);
  assert.equal(report.passed, report.checks.length);

  const single = report.checks.find(check => check.name === EXPECTED[0]).details;
  assert.ok(single.paused.playheadMs > 0, '单帧暂停后播放头不能是 0');
  assert.ok(single.distinctPlayheadValues >= 10, '播放头没有按钟刷新');
  const pressed = report.checks.find(check => check.name === EXPECTED[6]).details;
  assert.equal(pressed.settled.head, 1200, '拖动目标被时钟写回');
  const loop = report.checks.find(check => check.name === EXPECTED[7]).details;
  assert.equal(loop.settled.head, loop.paused.head, '绕回首帧暂停后播放头被迟到解码改动');
  assert.match(loop.settled.position, /^1\//, '绕回首帧暂停后帧号与播放头不符');
  assert.ok(loop.settled.colours.red > 0 && loop.settled.colours.green === 0, '画面与暂停点不符');
});
