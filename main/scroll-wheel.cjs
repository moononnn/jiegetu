'use strict';
const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');

// Main-process only: spawn AFTER the selection window hides, so native pins the
// intended foreground. Native conditionally handles arrows; JS never registers keys.
// Invalid ROI/options throw synchronously. Runtime errors stop this optional helper
// and report onError once (safe to omit); the caller must not cancel the screenshot.
function createScrollWheel(region, {
  spawn = defaultSpawn,
  executable = path.join(__dirname, '../native/gdi-capture.exe'),
  foreground = 0,
  onError = () => {}
} = {}) {
  if (!region || !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(region[key])) ||
      Math.abs(region.x) > 1000000 || Math.abs(region.y) > 1000000 ||
      region.width < 1 || region.height < 1 || region.width * region.height > 16000000) {
    throw new TypeError('无效滚轮选区：需整数物理坐标、正尺寸，且不超过 1600 万像素');
  }
  if (typeof spawn !== 'function' || typeof onError !== 'function' || typeof executable !== 'string' || !executable) {
    throw new TypeError('无效滚轮桥选项');
  }
  if (!Number.isSafeInteger(foreground) || foreground < 0) throw new TypeError('无效前台窗口句柄');
  let child, stopped = false, exited = false, timer, stderr = '';
  function stop() {
    if (stopped) return;
    stopped = true;
    if (!child || exited) return;
    try { child.stdin.end('Q'); } catch { /* EOF/250ms kill bound shutdown. */ }
    if (exited) return;
    timer = setTimeout(() => { if (!exited) { try { child.kill(); } catch {} } }, 250);
    timer.unref?.();
  }
  function fail(error) {
    if (stopped) return;
    stop();
    try { onError(error); } catch { /* Reporting must not crash the capture session. */ }
  }
  try {
    child = spawn(executable, ['--scroll-wheel', ...['x', 'y', 'width', 'height'].map(key => String(region[key])), String(foreground)], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stderr.on('error', fail);
    child.stdout.on('error', fail);
    child.stderr.on('data', value => { stderr = (stderr + value.toString('utf8')).slice(0, 600); });
    child.on('exit', (code, signal) => {
      exited = true;
      clearTimeout(timer);
      if (!stopped) fail(new Error(stderr.trim() || `滚轮桥意外退出（${signal || code}）`));
    });
    child.stdout.resume(); // No READY or arrow command protocol.
  } catch (error) { fail(error); }
  return { stop };
}
module.exports = { createScrollWheel };
