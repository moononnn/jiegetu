/* 测试探针的生命周期保护：只给 scripts/verify-*.cjs 这类一次性验收脚本用，不进生产主进程。
   在探针最开头安装（任何日志之前），把三种“跑到一半没了”变成可查的失败，而不是桌面上的原生错误框：
   1. stdout/stderr 断管（父进程先关管道 → EPIPE）：判本次探针失败，不能静默当成功；
   2. 未捕获异常 / 未处理的 Promise 拒绝：落故障文件并非 0 退出；
   3. 探针自己挂死：超过 timeoutMs 也算失败。
   故障记录同步写到 _backups/probe-failures/（git 忽略）；写盘失败也只安静非 0 退出。
   处理函数里不写 console——那正是会再次触发 EPIPE 的通道；一次性 latch 防递归，也不吞首个真错误。
   正常结束调用 finish() 清掉生命周期定时器；除定时器外的监听留到进程退出，避免收尾阶段的异常弹窗。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_FAILURE_DIR = path.join(ROOT, '_backups', 'probe-failures');
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;

// Electron 里用 app.exit 收尾；纯 Node（回归测试）里退回 process.exit。
function defaultExit(code) {
  let app;
  try { ({ app } = require('electron')); } catch { /* 不是 Electron 环境。 */ }
  if (app && typeof app.exit === 'function') {
    try { app.exit(code); } catch { /* 落到下面的硬退出。 */ }
  }
  process.exit(code);
}

function describe(reason) {
  if (reason && typeof reason === 'object') {
    return {
      message: String(reason.message || reason),
      stack: reason.stack ? String(reason.stack).slice(0, 4000) : null,
      code: reason.code === undefined ? null : reason.code,
      errno: reason.errno === undefined ? null : reason.errno
    };
  }
  return { message: String(reason), stack: null, code: null, errno: null };
}

function installProbeGuard({ name = 'probe', timeoutMs = DEFAULT_TIMEOUT_MS,
  failureDir = DEFAULT_FAILURE_DIR, exit = defaultExit } = {}) {
  let latched = false;
  let timer = null;

  const writeFailure = (kind, reason) => {
    const { message, stack, code, errno } = describe(reason);
    const file = path.join(failureDir, `${name}-${process.pid}-${Date.now()}.json`);
    const record = { probe: name, kind, pid: process.pid, at: new Date().toISOString(),
      cwd: process.cwd(), argv: process.argv.slice(1), code, errno, message, stack };
    try {
      fs.mkdirSync(failureDir, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(record, null, 1)}\n`);
    } catch { /* 写盘失败不抛：安静非 0 退出，别再引发弹框。 */ }
    return file;
  };

  // 一次性 latch：第一条真错误赢，后续事件一律忽略，防止在 handler 里递归。
  const fail = (kind, reason) => {
    if (latched) return;
    latched = true;
    if (timer) clearTimeout(timer);
    writeFailure(kind, reason);
    exit(1);
  };

  process.stdout.on('error', error => fail('stdout', error));
  process.stderr.on('error', error => fail('stderr', error));
  process.on('uncaughtException', error => fail('uncaughtException', error));
  process.on('unhandledRejection', reason => fail('unhandledRejection', reason));

  timer = setTimeout(() => fail('timeout', new Error(`probe exceeded ${timeoutMs}ms`)), timeoutMs);

  return { name, failureDir, timeoutMs, finish() { if (timer) clearTimeout(timer); } };
}

module.exports = { installProbeGuard, DEFAULT_FAILURE_DIR, DEFAULT_TIMEOUT_MS };
