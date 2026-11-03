'use strict';
const path = require('node:path');
const { spawn: defaultSpawn, execFile: defaultExecFile } = require('node:child_process');
// Scroll sampling keeps the long-image budget; a one-shot plain snapshot needs room for a 6K/5K desktop panel.
const MAX_PIXELS = Object.freeze({ scroll: 16_000_000, snapshot: 36_000_000, record: 4_000_000 });
const MONITOR_QUERY_REPLY_LIMIT = 4096;
const MAX_MONITOR_SPAN = 4_000_000;

// 只接受单一完整 JSON 对象：字段恰好为 x/y/width/height，且都是安全整数与合理范围。
function parseRectPayload(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : '';
  if (!text || text.length > 512) throw new Error('显示器矩形返回长度异常');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('显示器矩形返回无法解析'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('显示器矩形返回格式不符');
  if (Object.keys(value).sort().join(',') !== 'height,width,x,y') throw new Error('显示器矩形返回字段异常');
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(Number.isSafeInteger)) throw new Error('显示器矩形返回非整数');
  if (Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000 || width < 1 || height < 1 ||
      width > MAX_MONITOR_SPAN || height > MAX_MONITOR_SPAN) throw new Error('显示器矩形返回范围异常');
  return { x, y, width, height };
}

// 多屏混合缩放下 Electron 的 dipToScreenRect 可能比真实监视器大几像素；这里只问真实矩形，不采任何像素。
// 匹配条件：hint 中心必须落在返回矩形内，且四条边与 hint 的偏差不超过 ceil(scale)（不固定 2px）。
// 明显错屏（整块偏移或尺寸差超出本屏取整误差）一律拒绝，不把别的屏矩形拿去裁切。
function parseMonitorBounds(stdout, hint, { scaleFactor } = {}) {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0 || scaleFactor > 8) throw new Error('显示器矩形查询缺少有效缩放');
  const tolerance = Math.ceil(scaleFactor);
  const { x, y, width, height } = parseRectPayload(stdout);
  const centerX = hint.x + Math.floor(hint.width / 2), centerY = hint.y + Math.floor(hint.height / 2);
  if (centerX < x || centerX >= x + width || centerY < y || centerY >= y + height) throw new Error('显示器矩形未包含查询中心');
  const edges = [Math.abs(x - hint.x), Math.abs(y - hint.y),
    Math.abs((x + width) - (hint.x + hint.width)), Math.abs((y + height) - (hint.y + hint.height))];
  if (edges.some(delta => delta > tolerance)) throw new Error('显示器矩形与查询范围差异过大，可能不是同一块屏');
  return { x, y, width, height };
}

// 物理布局的结果必须严格等于目标矩形，不接受“差不多”：差一像素就是错窗。
function parseFittedBounds(stdout, canonical) {
  const fitted = parseRectPayload(stdout);
  if (!['x', 'y', 'width', 'height'].every(key => fitted[key] === canonical[key])) throw new Error('窗口物理矩形与目标不符');
  return fitted;
}

function validRect(bounds) {
  const { x, y, width, height } = bounds || {};
  return [x, y, width, height].every(Number.isSafeInteger) && Math.abs(x) <= 1_000_000 && Math.abs(y) <= 1_000_000 &&
    width >= 1 && height >= 1 && width <= MAX_MONITOR_SPAN && height <= MAX_MONITOR_SPAN;
}

// 监视器/工作区共用一个有限异步查询模板：只换固定 flag，解析与容差完全一致。
function queryRect(flag, hint, { execFile = defaultExecFile, executable = path.join(__dirname, '..', 'native', 'wgc-capture.exe'), timeoutMs = 3000, scaleFactor } = {}) {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0 || scaleFactor > 8) return Promise.reject(new Error('显示器矩形查询缺少有效缩放'));
  if (!validRect(hint)) return Promise.reject(new Error('无效显示器矩形查询范围'));
  const { x, y, width, height } = hint;
  return new Promise((resolve, reject) => {
    try {
      execFile(executable, [flag, String(x), String(y), String(width), String(height)],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: MONITOR_QUERY_REPLY_LIMIT }, (error, stdout) => {
          // 不回传原始输出/异常文本：类型与范围都在固定代码里判，调用方只看到固定原因。
          if (error) { reject(new Error('显示器矩形查询失败')); return; }
          try { resolve(parseMonitorBounds(stdout, hint, { scaleFactor })); } catch (failure) { reject(failure); }
        });
    } catch { reject(new Error('显示器矩形查询无法启动')); }
  });
}

function queryMonitorBounds(hint, options = {}) {
  return queryRect('--monitor-info', hint, options);
}

// 同一块监视器的工作区（任务栏/其他保留区由系统给出，不在 JS 里推算）。
function queryMonitorWorkArea(hint, options = {}) {
  return queryRect('--workarea-info', hint, options);
}

// HWND 只以十进制字符串交给原生进程：8 字节小端（Win64）或 4 字节（Win32），不接受任意文本。
function handleToDecimal(rawHandle) {
  if (!Buffer.isBuffer(rawHandle) || (rawHandle.length !== 8 && rawHandle.length !== 4)) throw new Error('无效窗口句柄');
  const value = rawHandle.length === 8 ? rawHandle.readBigUInt64LE(0) : BigInt(rawHandle.readUInt32LE(0));
  if (value <= 0n || value > 0xFFFFFFFFFFFFFFFFn) throw new Error('无效窗口句柄');
  return value.toString();
}

// 只拟合本进程自己新建的隐藏窗：异步 execFile，不能同步等 SetWindowPos 回包，否则跨进程 WM_SIZE 会互锁。
// nonce 写到窗口标题上，原生侧用 GetWindowText 核对：同 PID 下 HWND 被回收时不会改错窗。
// 白名单固定四个模式：跨屏只允许整块虚拟桌面，不接受调用方自造的子矩形语义。
const FIT_MODES = new Set(['--fit-selection-window', '--fit-hidden-window', '--fit-desktop-window', '--check-desktop-window']);
function fitWindowRect(mode, handle, pid, nonce, canonical, { execFile = defaultExecFile, executable = path.join(__dirname, '..', 'native', 'wgc-capture.exe'), timeoutMs = 4000 } = {}) {
  if (typeof mode !== 'string' || !FIT_MODES.has(mode)) return Promise.reject(new Error('无效窗口布局模式'));
  if (typeof handle !== 'string' || !/^\d{1,20}$/.test(handle)) return Promise.reject(new Error('无效窗口句柄'));
  const numeric = BigInt(handle);
  if (numeric <= 0n || numeric > 0xFFFFFFFFFFFFFFFFn) return Promise.reject(new Error('无效窗口句柄'));
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 4294967295) return Promise.reject(new Error('无效进程标识'));
  if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) return Promise.reject(new Error('无效窗口标识'));
  if (!validRect(canonical)) return Promise.reject(new Error('无效窗口目标矩形'));
  const { x, y, width, height } = canonical;
  return new Promise((resolve, reject) => {
    try {
      // 参数固定为十进制与固定长度十六进制，不做字符串拼接或 shell；输出上限与元数据查询共用。
      execFile(executable, [mode, handle, String(pid), nonce, String(x), String(y), String(width), String(height)],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: MONITOR_QUERY_REPLY_LIMIT }, (error, stdout) => {
          if (error) { reject(new Error('窗口物理布局失败')); return; }
          try { resolve(parseFittedBounds(stdout, canonical)); } catch (failure) { reject(failure); }
        });
    } catch { reject(new Error('窗口物理布局无法启动')); }
  });
}

// 选区/遮罩：目标必须整块等于监视器。
function fitSelectionWindow(handle, pid, nonce, canonical, options = {}) {
  return fitWindowRect('--fit-selection-window', handle, pid, nonce, canonical, options);
}

// 浮条：目标必须是同一块监视器内的子矩形（仍只操作自己新建的隐藏窗）。
function fitHiddenWindow(handle, pid, nonce, target, options = {}) {
  return fitWindowRect('--fit-hidden-window', handle, pid, nonce, target, options);
}

// 跨屏普通截图：一块隐藏窗盖住整个虚拟桌面 union。原生侧会自己枚举监视器算 union，
// 传进来的 canonical 必须与它严格相等，差一像素就是错窗。
function fitDesktopWindow(handle, pid, nonce, canonical, options = {}) {
  return fitWindowRect('--fit-desktop-window', handle, pid, nonce, canonical, options);
}

// 载入页面后纯读复核：不做 SetWindowPos，只回报实际 GetWindowRect 并要求它仍等于 union。
function checkDesktopWindow(handle, pid, nonce, canonical, options = {}) {
  return fitWindowRect('--check-desktop-window', handle, pid, nonce, canonical, options);
}

// One authenticated caller, one request/response in flight; raw pixels never go to disk.
// deferredStart: true only for plain snapshots — the helper parses the monitor and creates the D3D
// device/item, but must not create the frame pool/session/staging/pixels or call StartCapture until
// the first N. Older helpers reject the unknown fifth flag before any capture, and the caller falls
// back to a normal --snapshot process without ever having started a background capture.
function createWinCapture(region, { spawn = defaultSpawn, executable, timeoutMs = 12000, purpose = 'scroll', deferredStart = false } = {}) {
  if (typeof purpose !== 'string' || !Object.hasOwn(MAX_PIXELS, purpose)) throw new Error('无效原生采集用途');
  if (typeof deferredStart !== 'boolean') throw new Error('无效原生采集启动方式');
  if (deferredStart && purpose !== 'snapshot') throw new Error('只有普通快照可以延迟启动');
  const limit = MAX_PIXELS[purpose];
  const { x, y, width, height } = region || {};
  if (![x, y, width, height].every(Number.isInteger) || Math.abs(x) > 1_000_000 || Math.abs(y) > 1_000_000 ||
      width < 1 || height < 1 || width * height > limit ||
      (purpose === 'record' && (width > 4096 || height > 4096))) throw new Error('无效原生采集范围');
  const bytes = width * height * 4, header = Buffer.alloc(20);
  // The native helper takes an explicit fifth flag only for the larger plain-snapshot budget.
  const args = [x, y, width, height].map(String);
  if (purpose === 'snapshot') args.push(deferredStart ? '--snapshot-lazy' : '--snapshot');
  // Recording alone includes the real pointer; screenshot/scroll defaults stay cursor-free.
  if (purpose === 'record') args.push('--record');
  const captureExecutable = executable === undefined
    ? path.join(__dirname, '..', 'native', purpose === 'record' ? 'wgc-record.exe' : 'wgc-capture.exe') : executable;
  const child = spawn(captureExecutable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending, stopped = false, failure, stderr = '', killTimer, lastSequence = 0;
  // 普通快照是一次性取帧：没有后续帧要和它逐字节比对，就不留整帧参照副本；scroll/record 的去重语义不变。
  const keepReference = purpose !== 'snapshot';
  let headerBytes = 0, payload, payloadBytes = 0, sequence = 0, fresh = false, lastPixels;
  function rejectPending(error) {
    if (!pending) return;
    const job = pending; pending = undefined; clearTimeout(job.timer); payload = undefined; job.reject(error);
  }
  function fail(error) {
    if (stopped) return;
    failure = error; stopped = true; rejectPending(error); lastPixels = undefined;
    try { child.kill(); } catch { /* Process may have exited already. */ }
  }
  function complete() {
    const job = pending; pending = undefined; clearTimeout(job.timer);
    // WGC reports whole-monitor damage; animation outside the ROI must not flood the matcher or evict distinct recovery frames.
    // Exact byte equality only: even a single changed channel remains a new frame. Keep one private, bounded ROI reference.
    // 普通快照是一次性取帧，没有后续比对需求：不比较也不留整帧参照；scroll/record 的去重与参照语义不变。
    const changed = fresh && (keepReference ? !lastPixels || !lastPixels.equals(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)) : true);
    const image = { fresh: changed, sequence, width, height, ...(changed ? { data: payload } : {}) };
    if (changed && keepReference) lastPixels = Buffer.from(payload);
    payload = undefined; lastSequence = sequence; job.resolve(image);
  }
  child.stdout.on('data', chunk => {
    if (stopped) return;
    try {
      if (!pending || !Buffer.isBuffer(chunk)) throw new Error('原生采集返回了未请求的数据');
      let offset = 0;
      if (headerBytes < 20) {
        const count = Math.min(20 - headerBytes, chunk.length); chunk.copy(header, headerBytes, 0, count); headerBytes += count; offset += count;
        if (headerBytes < 20) return;
        sequence = header.readUInt32LE(12); const flags = header.readUInt32LE(16); fresh = flags === 1;
        if (header.toString('ascii', 0, 4) !== 'JGC2' || header.readUInt32LE(4) !== width || header.readUInt32LE(8) !== height ||
            flags > 1 || !sequence || (fresh ? sequence <= lastSequence : sequence !== lastSequence)) throw new Error('原生采集帧头或顺序不符');
        if (fresh) payload = new Uint8ClampedArray(bytes);
      }
      const remaining = chunk.length - offset;
      if (!fresh) {
        if (remaining) throw new Error('无新帧回包不应包含像素');
        complete(); return;
      }
      if (remaining > bytes - payloadBytes) throw new Error('原生采集像素长度超限');
      payload.set(chunk.subarray(offset), payloadBytes); payloadBytes += remaining;
      if (payloadBytes === bytes) complete();
    } catch (error) { fail(error); }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(0, 1200); });
  child.on('error', error => fail(new Error(`原生采集无法启动：${error.message}`)));
  child.stdin.on('error', error => fail(new Error(`原生采集输入中断：${error.message}`)));
  // 只在 close 结案：Node 保证它在 exit/error 之后、stdio 已排空，退出码与 stderr 尾部同时到手。
  // 半帧 EOF 但进程不退的情况不在这里抢答，交给 next() 的 timeoutMs 兜底。
  child.on('close', (code, signal) => {
    clearTimeout(killTimer);
    fail(new Error(`${stderr.trim() || '原生采集已中断'}（exit code=${code ?? 'null'} signal=${signal ?? 'null'}）`));
  });
  function next() {
    if (stopped) return Promise.reject(failure || new Error('原生采集已取消'));
    if (pending) return Promise.reject(new Error('上一帧仍在采集中'));
    headerBytes = 0; payloadBytes = 0; payload = undefined;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('原生屏幕帧采集超时')), timeoutMs);
      pending = { resolve, reject, timer };
      try { child.stdin.write(Buffer.from('N')); } catch (error) { fail(error); }
    });
  }
  function stop() {
    if (stopped) return;
    stopped = true; rejectPending(new Error('原生采集已取消')); lastPixels = undefined;
    try { child.stdin.end(Buffer.from('Q')); } catch { /* Kill timer below bounds shutdown. */ }
    killTimer = setTimeout(() => { try { child.kill(); } catch { } }, 250); killTimer.unref?.();
  }
  return { next, stop, deferred: deferredStart,
    // 只读状态：预备源可以先用 alive 判断是否已经退出/拒收，再去 take；next/stop 语义不变。
    get alive() { return !stopped && child.exitCode == null && child.signalCode == null; },
    get status() { if (stopped) return failure ? 'failed' : 'stopped'; return pending ? 'busy' : 'ready'; } };
}
module.exports = { createWinCapture, queryMonitorBounds, queryMonitorWorkArea, fitSelectionWindow, fitHiddenWindow,
  fitDesktopWindow, checkDesktopWindow, parseMonitorBounds, parseFittedBounds, handleToDecimal };
