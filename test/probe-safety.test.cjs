/* scripts/probe-safety.cjs 的 Node-only 回归：真子进程、真断管，不启动 Electron。
   要证明的是“失败就是失败”：stdout/stderr 断管（EPIPE）、未捕获异常/拒绝、生命周期超时
   都必须写故障记录并非 0 退出，不能被静默吞掉后绿灯；处理过程不能抛未捕获错误重入。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CHILD = path.join(__dirname, 'fixtures', 'probe-safety-child.cjs');
const CHILD_WAIT_MS = 15000;

const makeDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'probe-safety-'));

const readFailures = dir => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
};

// closeStream：等到子进程吐出 'ready'/'armed' 后关掉父端读管道，制造真实断管。
function runChild(mode, { failureDir, timeoutMs = 60000, closeStream = null, armWord = 'ready' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, mode], {
      cwd: ROOT,
      env: { ...process.env, PROBE_FAILURE_DIR: failureDir, PROBE_TIMEOUT_MS: String(timeoutMs) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let closed = false;
    const closeReadEnd = () => {
      if (closed) return;
      closed = true;
      if (closeStream === 'stdout') child.stdout.destroy();
      if (closeStream === 'stderr') child.stderr.destroy();
    };
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (closeStream === 'stdout' && stdout.includes(armWord)) closeReadEnd();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (closeStream === 'stderr' && stderr.includes(armWord)) closeReadEnd();
    });
    // 父端主动销毁管道后的读错误是预期现象，不该让测试自己失败。
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    const guardTimer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退出。 */ }
      reject(new Error(`子进程 ${mode} 超过 ${CHILD_WAIT_MS}ms 没退出`));
    }, CHILD_WAIT_MS);
    child.on('error', error => { clearTimeout(guardTimer); reject(error); });
    child.on('close', code => { clearTimeout(guardTimer); resolve({ code, stdout, stderr }); });
  });
}

test('正常结束：不写故障记录、退出 0', async () => {
  const dir = makeDir();
  const result = await runChild('ok', { failureDir: dir });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /ok/);
  assert.deepEqual(readFailures(dir), []);
});

test('stdout 断管：写 stdout/EPIPE 故障记录、非 0 退出、不重入未捕获错误', async () => {
  const dir = makeDir();
  const result = await runChild('spam-out', { failureDir: dir, closeStream: 'stdout' });
  assert.notEqual(result.code, 0);
  const failures = readFailures(dir);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, 'stdout');
  assert.equal(failures[0].code, 'EPIPE');
  assert.equal(failures[0].probe, 'probe-safety-spam-out');
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event|EPIPE/);
});

test('stderr 断管：写 stderr/EPIPE 故障记录、非 0 退出', async () => {
  const dir = makeDir();
  const result = await runChild('spam-err', { failureDir: dir, closeStream: 'stderr' });
  assert.notEqual(result.code, 0);
  const failures = readFailures(dir);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, 'stderr');
  assert.equal(failures[0].code, 'EPIPE');
});

test('未捕获异常：写记录、非 0 退出，不交回默认处理', async () => {
  const dir = makeDir();
  const result = await runChild('throw', { failureDir: dir });
  assert.notEqual(result.code, 0);
  const failures = readFailures(dir);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, 'uncaughtException');
  assert.match(failures[0].message, /fixture-uncaught/);
  assert.match(failures[0].stack, /probe-safety-child/);
});

test('未处理拒绝：写记录、非 0 退出', async () => {
  const dir = makeDir();
  const result = await runChild('reject', { failureDir: dir });
  assert.notEqual(result.code, 0);
  const failures = readFailures(dir);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, 'unhandledRejection');
  assert.match(failures[0].message, /fixture-rejection/);
});

test('生命周期超时：写 timeout 记录、非 0 退出', async () => {
  const dir = makeDir();
  const started = Date.now();
  const result = await runChild('hang', { failureDir: dir, timeoutMs: 400 });
  assert.notEqual(result.code, 0);
  assert.ok(Date.now() - started >= 400);
  const failures = readFailures(dir);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, 'timeout');
  assert.match(failures[0].message, /400ms/);
});

test('一次性 latch：拒绝之后再抛，只留第一条记录、只退出一次', async () => {
  const dir = makeDir();
  const result = await runChild('double', { failureDir: dir });
  assert.notEqual(result.code, 0);
  const failures = readFailures(dir);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, 'unhandledRejection');
  assert.match(failures[0].message, /fixture-first-rejection/);
});
