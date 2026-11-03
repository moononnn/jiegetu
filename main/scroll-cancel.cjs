'use strict';
const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');
// One short-lived watcher per long capture. Reads only right-button transitions;
// no keyboard hooks, input injection, screenshots, or persistent input history.
function watchScrollCancel(onCancel, onError, { spawn = defaultSpawn, executable = path.join(__dirname, '../native/gdi-capture.exe') } = {}) {
  let stopped = false, stderr = '', timer;
  const child = spawn(executable, ['--watch-cancel'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  function stop() {
    if (stopped) return;
    stopped = true;
    try { child.stdin.end('Q'); } catch { /* Bounded shutdown below. */ }
    timer = setTimeout(() => { try { child.kill(); } catch {} }, 250); timer.unref?.();
  }
  function fail(error) { if (!stopped) { stop(); onError(error); } }
  child.stdin.on('error', error => fail(error));
  child.on('error', error => fail(error));
  child.stderr.on('data', value => { stderr = (stderr + value.toString('utf8')).slice(0, 600); });
  child.stdout.on('data', value => {
    if (stopped) return;
    if (value.toString('ascii').includes('R')) { stop(); onCancel(); }
  });
  child.on('exit', () => { clearTimeout(timer); if (!stopped) fail(new Error(stderr.trim() || '右键取消监听已结束')); });
  return { stop };
}
module.exports = { watchScrollCancel };
