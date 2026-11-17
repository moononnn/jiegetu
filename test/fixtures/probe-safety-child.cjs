/* scripts/probe-safety.cjs 的回归夹具：只被 test/probe-safety.test.cjs 启动。
   不 require electron、不建窗、不碰桌面/屏幕/剪贴板，纯 Node 子进程。
   mode：
   - ok        什么都不做，正常 finish 后退出 0
   - spam-out  持续写 stdout（父进程关掉读端 → EPIPE）
   - spam-err  持续写 stderr（同上，走 stderr 通道）
   - throw     setTimeout 里抛未捕获异常
   - reject    未处理的 Promise 拒绝
   - hang      只挂住不动，等生命周期超时
   - double    先拒绝再抛：验证一次性 latch 只留一条记录 */
'use strict';
const { installProbeGuard } = require('../../scripts/probe-safety.cjs');

const mode = process.argv[2] || 'ok';
const guard = installProbeGuard({
  name: `probe-safety-${mode}`,
  failureDir: process.env.PROBE_FAILURE_DIR,
  timeoutMs: Number(process.env.PROBE_TIMEOUT_MS || 60000)
});

if (mode === 'spam-out' || mode === 'spam-err') {
  const stream = mode === 'spam-out' ? process.stdout : process.stderr;
  stream.write('ready\n');
  setInterval(() => { stream.write(`tick ${Date.now()}\n`); }, 5);
} else if (mode === 'throw') {
  process.stdout.write('armed\n');
  setTimeout(() => { throw new Error('fixture-uncaught'); }, 20);
} else if (mode === 'reject') {
  process.stdout.write('armed\n');
  Promise.reject(new Error('fixture-rejection'));
} else if (mode === 'hang') {
  process.stdout.write('armed\n');
  setInterval(() => {}, 1000);
} else if (mode === 'double') {
  process.stdout.write('armed\n');
  Promise.reject(new Error('fixture-first-rejection'));
  setTimeout(() => { throw new Error('fixture-second-throw'); }, 30);
} else {
  process.stdout.write('ok\n');
  guard.finish();
}
