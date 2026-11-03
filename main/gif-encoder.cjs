'use strict';
// GIF 编码宿主：把 RGBA 帧交给 worker_threads 里的 gifenc 编码，主线程只做校验与单飞调度。
// 这里不采屏、不建窗口、不落盘，也不记录像素；上游仍然只负责把「变化过的新帧」按 elapsedMs 送进来。
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const MAX_EDGE = 4096;
const MAX_PIXELS = 4_000_000;
const FRAME_LIMIT_MS = 30000;
const FINISH_LIMIT_MS = 31000;      // 收尾允许比帧界多 1s
const COMMAND_TIMEOUT_MS = 10000;   // 单条命令 10s 不回应就判死，不无限等
const DEFAULT_MAX_BYTES = 48 * 1024 * 1024;
const WORKER_FILE = path.join(__dirname, 'gif-encoder-worker.cjs');
// 这些错误发生在真正写 GIF 之前，线程状态仍然一致：只拒这一条命令，编码器还能继续用。
const RECOVERABLE_CODES = new Set(['BAD_FRAME', 'BAD_ELAPSED', 'TIME_BACKWARDS', 'NO_FRAMES', 'BAD_MESSAGE', 'NOT_READY', 'ALREADY_INIT']);

function coded(code, message) { return Object.assign(new Error(message), { code }); }

function createGifEncoder(options = {}) {
  const { width, height, maxBytes = DEFAULT_MAX_BYTES } = options || {};
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) {
    throw coded('BAD_SIZE', `GIF 尺寸无效：宽高须为 1..${MAX_EDGE} 的安全整数，且总像素不超过 ${MAX_PIXELS}`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw coded('BAD_MAX_BYTES', 'maxBytes 必须是正整数');
  const expectedBytes = width * height * 4;

  let worker = null;
  let pending = null;
  let failure = null;     // 一旦置位，编码器终结且不再接受命令
  let closed = false;
  let seq = 0;
  let lastElapsed = 0;
  let frames = 0;
  let finished = false;

  function terminate() {
    const dying = worker;
    worker = null;
    if (!dying) return;
    // 先摘监听：终止过程中迟到的 message/error/exit 都不能复活任何状态。
    try { dying.removeAllListeners(); } catch { /* 线程已结束 */ }
    try { dying.terminate(); } catch { /* 线程已结束 */ }
  }

  function rejectPending(error) {
    const current = pending;
    pending = null;
    if (!current) return;
    clearTimeout(current.timer);
    current.reject(error);
  }

  function fail(error, { kill }) {
    if (!failure) failure = error;
    closed = true;
    rejectPending(failure);
    if (kill) terminate();
  }

  worker = new Worker(WORKER_FILE, { name: 'gif-encoder' });
  worker.on('message', message => {
    // init 不占帧命令的 pending；初始化异常也必须明确结束，不能被 id=0 的过滤吞掉。
    if (message?.id === 0 && message.type === 'error') {
      fail(coded(message.code || 'ENCODE_FAILED', message.message || 'GIF 编码器初始化失败'), { kill: true });
      return;
    }
    if (!pending || !message || message.id !== pending.id) return; // 迟到回应一律丢弃
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    if (message.type === 'error') {
      const error = coded(message.code || 'ENCODE_FAILED', message.message || 'GIF 编码失败');
      if (RECOVERABLE_CODES.has(error.code)) { current.reject(error); return; }
      // 终结性错误：先收掉这一条命令的 promise（它已被摘出 pending），再判死线程。
      fail(error, { kill: true });
      current.reject(failure);
      return;
    }
    if (message.type === 'done') {
      finished = true;
      closed = true;
      const bytes = new Uint8Array(message.buffer);
      current.resolve(bytes);
      terminate();          // 结果已交付，线程立刻收掉，不残留
      return;
    }
    current.resolve(undefined);
  });
  worker.on('error', error => {
    fail(coded('WORKER_ERROR', error?.message || 'GIF 编码线程出错'), { kill: true });
  });
  worker.on('exit', code => {
    worker = null;
    if (closed) return;
    fail(coded('WORKER_EXIT', `GIF 编码线程已退出（code ${code}）`), { kill: false });
  });
  worker.postMessage({ type: 'init', id: 0, width, height, maxBytes });

  function checkElapsed(value, limit) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw coded('BAD_ELAPSED', '帧时间必须是有限数值');
    if (value < 0 || value > limit) throw coded('BAD_ELAPSED', `帧时间须在 0..${limit}ms 之间`);
    if (value < lastElapsed) throw coded('TIME_BACKWARDS', '帧时间不能回退');
    return value;
  }

  function dispatch(message, transfer) {
    // 单飞：同一时刻只允许一条命令在飞，绝不排队。
    if (closed || failure) return Promise.reject(failure || coded('CANCELLED', 'GIF 编码器已停止'));
    if (pending) return Promise.reject(coded('BUSY', '上一帧还在编码'));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending || pending.id !== id) return;
        // 超时说明线程可能卡在编码里：状态不可信，直接判死。
        fail(coded('TIMEOUT', `GIF 编码超过 ${COMMAND_TIMEOUT_MS}ms 没有回应`), { kill: true });
        reject(failure);
      }, COMMAND_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      pending = { id, resolve, reject, timer };
      try {
        worker.postMessage({ ...message, id }, transfer || []);
      } catch (error) {
        pending = null;
        clearTimeout(timer);
        reject(coded('POST_FAILED', error?.message || '无法把帧交给 GIF 编码线程'));
      }
    });
  }

  async function frame(rgba, elapsedMs) {
    if (finished) throw coded('FINISHED', 'GIF 已经结束，不能再加帧');
    if (closed || failure) throw failure || coded('CANCELLED', 'GIF 编码器已停止');
    if (pending) throw coded('BUSY', '上一帧还在编码');
    if (finished) throw coded('FINISHED', 'GIF 已经结束，不能再加帧');
    const tag = Object.prototype.toString.call(rgba);
    if (tag !== '[object Uint8Array]' && tag !== '[object Uint8ClampedArray]') {
      throw coded('BAD_FRAME', '帧数据必须是 Uint8Array 或 Uint8ClampedArray 的 RGBA');
    }
    if (rgba.byteLength !== expectedBytes) {
      throw coded('BAD_FRAME', `帧数据应为 ${expectedBytes} 字节（${width}×${height}×4）`);
    }
    const elapsed = checkElapsed(elapsedMs, FRAME_LIMIT_MS);
    // 始终复制到独立缓冲：既不把调用方的池化 Buffer / 更大 ArrayBuffer 传给线程，
    // 也不用 transfer 去 detach 调用方还在用的数据。
    const payload = new Uint8Array(expectedBytes);
    payload.set(rgba);
    lastElapsed = elapsed;
    frames += 1;
    await dispatch({ type: 'frame', elapsedMs: elapsed, buffer: payload.buffer }, [payload.buffer]);
  }

  async function finish(elapsedMs) {
    if (finished) throw coded('FINISHED', 'GIF 已经结束过了');
    if (closed || failure) throw failure || coded('CANCELLED', 'GIF 编码器已停止');
    if (pending) throw coded('BUSY', '上一帧还在编码');
    if (!frames) throw coded('NO_FRAMES', '还没有可写出的帧');
    const elapsed = checkElapsed(elapsedMs, FINISH_LIMIT_MS);
    lastElapsed = elapsed;
    return dispatch({ type: 'finish', elapsedMs: elapsed });
  }

  function cancel() {
    if (closed && !worker) return; // 幂等：重复取消、结束后再取消都不做事
    fail(coded('CANCELLED', 'GIF 录制已取消'), { kill: true });
  }

  return Object.freeze({ frame, finish, cancel });
}

module.exports = { createGifEncoder, DEFAULT_MAX_BYTES, MAX_EDGE, MAX_PIXELS, COMMAND_TIMEOUT_MS };
