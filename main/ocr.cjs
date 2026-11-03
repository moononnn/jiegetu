'use strict';
// 独立 Windows 离线文字识别：固定 helper 路径、PNG 走 stdin、结果走一行 JSON。
// 主进程不读 active.image/snapshot/原图，不落盘、不联网、不写剪贴板，也不记录识别文本。
const fs = require('node:fs');
const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');

const DEFAULT_EXECUTABLE = path.join(__dirname, '..', 'native', 'ocr-helper.exe');
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_EDGE = 2048;
const MAX_PIXELS = 4_000_000;
const MAX_TEXT_UNITS = 2000;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 2048;
const DEFAULT_TIMEOUT_MS = 6000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// helper 的固定失败码 → 固定中文。原始输出、异常文本、像素和路径都不外传。
const HELPER_FAILURES = new Map([
  ['too-large', '识别图片尺寸超出上限'],
  ['empty-image', '识别图片为空'],
  ['bad-image', '识别图片格式无效'],
  ['no-language', '本机未安装文字识别语言包'],
  ['text-too-long', '识别文字过长，请缩小选区'],
  ['timeout', '文字识别超时'],
  ['canceled', '文字识别已取消'],
  ['bad-arguments', '离线文字识别不可用']
]);
const SAFE_FAILURE = '文字识别失败，请稍后再试';

const codePointLength = value => { let count = 0; for (const unit of value) { void unit; count += 1; } return count; };

// 只接受字节视图；返回的是拷贝，不把渲染层的缓冲区引用留在主进程。
function payloadBytes(png) {
  if (!ArrayBuffer.isView(png) || png.BYTES_PER_ELEMENT !== 1) throw new Error('识别图片格式无效');
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (bytes.length === 0) throw new Error('识别图片为空');
  if (bytes.length > MAX_PNG_BYTES) throw new Error('识别图片超出 8 MiB 上限');
  return Buffer.from(bytes);
}

// IHDR 是唯一可信的尺寸来源：签名、块长、块类型、正整数边与像素总数全部严格校验。
function pngSize(bytes) {
  if (bytes.length < 33) throw new Error('识别图片格式无效');
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('识别图片格式无效');
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('识别图片格式无效');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!(width >= 1 && height >= 1)) throw new Error('识别图片格式无效');
  if (width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) throw new Error('识别图片尺寸超出上限');
  return { width, height };
}

// 一次会话一条在途任务：stdin 送整张 PNG，stdout 只收一行有界 JSON，超时/退出/取消都终止本次子进程。
function startJob({ spawn, executable, png, width, height, timeoutMs }) {
  let child;
  try {
    // 固定可执行文件 + 无用户参数；不用 shell，不按进程名清理。
    child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return { promise: Promise.reject(new Error('离线文字识别无法启动')), cancel: () => {} };
  }
  const chunks = [];
  let stdoutBytes = 0, stderrBytes = 0, settled = false, timer;
  let resolvePromise, rejectPromise;
  const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  function settle(error, value, kill) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (kill && child) { try { child.kill(); } catch { /* 已退出就不用再杀。 */ } }
    if (error) rejectPromise(error); else resolvePromise(value);
  }
  function parse(raw) {
    let reply;
    try { reply = JSON.parse(raw); } catch { settle(new Error('识别结果格式异常')); return; }
    if (!reply || typeof reply !== 'object' || Array.isArray(reply) || typeof reply.ok !== 'boolean') {
      settle(new Error('识别结果格式异常')); return;
    }
    if (reply.ok !== true) {
      const reason = typeof reply.reason === 'string' ? reply.reason : '';
      settle(new Error(HELPER_FAILURES.get(reason) || SAFE_FAILURE)); return;
    }
    if (typeof reply.text !== 'string' || !Number.isSafeInteger(reply.width) || !Number.isSafeInteger(reply.height) ||
        reply.width !== width || reply.height !== height) { settle(new Error('识别结果格式异常')); return; }
    if (codePointLength(reply.text) > MAX_TEXT_UNITS) { settle(new Error('识别文字过长，请缩小选区')); return; }
    const result = { text: reply.text };
    if (typeof reply.language === 'string' && reply.language) result.language = reply.language;
    settle(undefined, result);
  }
  child.stdout?.on('data', chunk => {
    if (settled) return;
    if (!Buffer.isBuffer(chunk)) { settle(new Error('识别结果格式异常'), undefined, true); return; }
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_STDOUT_BYTES) { settle(new Error('识别结果超出上限'), undefined, true); return; }
    chunks.push(chunk);
  });
  // stderr 只做有界丢弃，既不外传也不写日志。
  child.stderr?.on('data', chunk => { stderrBytes += Buffer.isBuffer(chunk) ? chunk.length : 0; if (stderrBytes > MAX_STDERR_BYTES) stderrBytes = MAX_STDERR_BYTES; });
  child.on?.('error', () => settle(new Error('离线文字识别无法启动'), undefined, true));
  child.stdin?.on?.('error', () => settle(new Error('离线文字识别无法启动'), undefined, true));
  // 非正常退出（非 0 退出码或被信号终止）一律拒绝：即使 stdout 里伪造了 ok:true 也不采信。
  child.on?.('close', (code, signal) => {
    if (settled) return;
    if (code !== 0 || signal) { settle(new Error(SAFE_FAILURE)); return; }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) { settle(new Error('识别结果格式异常')); return; }
    parse(raw);
  });
  timer = setTimeout(() => settle(new Error('文字识别超时'), undefined, true), timeoutMs);
  timer?.unref?.();
  try { child.stdin?.end(png); } catch { settle(new Error('离线文字识别无法启动'), undefined, true); }
  return { promise, cancel: () => settle(new Error('文字识别已取消'), undefined, true) };
}

function installOcrIpc({ ipcMain, allowed, getActive, nativeImage, spawn = defaultSpawn, executable = DEFAULT_EXECUTABLE,
  platform = process.platform, timeoutMs = DEFAULT_TIMEOUT_MS, exists = fs.existsSync }) {
  const unavailable = () => platform !== 'win32' ? '本机不支持离线文字识别'
    : (!exists(executable) ? '离线文字识别组件缺失，暂不能识别' : undefined);

  // 只清自己这一条在途任务；后继任务不会被前一条的 finally 擦掉。
  function cancel(current) {
    const job = current?.ocrJob;
    if (!job) return false;
    current.ocrJob = undefined;
    job.cancel();
    return true;
  }

  async function recognize(event, payload) {
    // 与保存/取消同一条守卫：必须来自真选区主 frame，且会话仍在框选态、编辑器打开、token 属于当前文档。
    if (!allowed(event)) throw new Error('识别请求已失效');
    const current = getActive();
    if (!current || current.phase !== 'selecting' || current.editorOpen !== true || !current.editDocument) throw new Error('识别请求已失效');
    const document = current.editDocument;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('识别请求参数无效');
    if (typeof payload.token !== 'string' || payload.token !== document.token) throw new Error('识别请求已失效');
    // 每 current 会话最多一在途：重复请求直接报正忙，不杀旧进程再起新的。
    if (current.ocrJob) throw new Error('识别正忙，请稍后再试');
    const bytes = payloadBytes(payload.png);
    const size = pngSize(bytes);
    if (payload.width !== size.width || payload.height !== size.height) throw new Error('识别图片尺寸声明不符');
    const blocked = unavailable();
    if (blocked) throw new Error(blocked);
    // 声明尺寸之外再验一次真实解码尺寸：解码出来的图像与 IHDR 不一致一律拒绝。
    const decoded = nativeImage.createFromBuffer(bytes);
    if (!decoded || decoded.isEmpty()) throw new Error('识别图片无法解码');
    const decodedSize = decoded.getSize();
    if (!decodedSize || decodedSize.width !== size.width || decodedSize.height !== size.height) throw new Error('识别图片内容尺寸不符');
    const job = startJob({ spawn, executable, png: bytes, width: size.width, height: size.height, timeoutMs });
    current.ocrJob = job;
    let result;
    try { result = await job.promise; }
    finally { if (current.ocrJob === job) current.ocrJob = undefined; }
    // await 之后会话可能已经结束、换 token 或关掉编辑器：结果只交给仍然有效的那一轮。
    if (!allowed(event) || getActive() !== current || current.phase !== 'selecting' || current.editorOpen !== true ||
        !current.editDocument || current.editDocument.token !== document.token) throw new Error('识别请求已失效');
    return result;
  }

  ipcMain.handle('shot:recognize-text', (event, payload) => recognize(event, payload));
  return { cancel, recognize, unavailable };
}

module.exports = { installOcrIpc, DEFAULT_EXECUTABLE, MAX_PNG_BYTES, MAX_EDGE, MAX_PIXELS, MAX_TEXT_UNITS };
