'use strict';
// GIF 编码 worker：只接收「当前画面」的 RGBA 帧并编码，不采屏、不碰窗口、不打日志。
// 宿主的校验不算数：init、每帧长度、时间单调都在这里独立再验一遍。
// 编码用 gifenc（MIT）：首帧写 GIF89a/LSD/GCT/NETSCAPE(repeat=0)，之后每个变化帧自带局部调色板，
// 都是整幅不透明帧，所以处置方式固定为 1（do not dispose），不会出现透明泄漏或半幅擦除。
const { parentPort } = require('node:worker_threads');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const MAX_EDGE = 4096;
const MAX_PIXELS = 4_000_000;
const FRAME_LIMIT_MS = 30000;
const FINISH_LIMIT_MS = 31000;
// GIF 延迟单位是 1/100 秒；0 会被浏览器当成 100ms，反而更慢，所以最小时长按 1 厘秒写。
const MIN_DELAY_CS = 1;

function coded(code, message) { return Object.assign(new Error(message), { code }); }

let config = null;      // { width, height, maxBytes }
let encoder = null;     // gifenc GIFEncoder
let held = null;        // 还没写出的那一帧 { index, palette, elapsedMs }
let writtenCs = 0;      // 已经写进 GCE 的总时长（厘秒），用于累计误差校正
let lastElapsed = 0;
let finished = false;

function readConfig(message) {
  const width = message?.width, height = message?.height, maxBytes = message?.maxBytes;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) {
    throw coded('BAD_SIZE', `GIF 尺寸无效：宽高须为 1..${MAX_EDGE} 的安全整数，且总像素不超过 ${MAX_PIXELS}`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw coded('BAD_MAX_BYTES', 'maxBytes 必须是正整数');
  return { width, height, maxBytes };
}

function checkElapsed(value, limit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw coded('BAD_ELAPSED', '帧时间必须是有限数值');
  if (value < 0 || value > limit) throw coded('BAD_ELAPSED', `帧时间须在 0..${limit}ms 之间`);
  if (value < lastElapsed) throw coded('TIME_BACKWARDS', '帧时间不能回退');
  return value;
}

// 目标时刻的绝对厘秒数减去已写总量：每帧都按「墙钟总量」校正，舍入误差不会累积成加速/减速。
function delayCsUntil(elapsedMs) {
  return Math.max(MIN_DELAY_CS, Math.round(elapsedMs / 10) - writtenCs);
}

function checkBytes() {
  const size = encoder.bytesView().byteLength;
  if (size > config.maxBytes) {
    throw coded('MAX_BYTES', `GIF 已经 ${size} 字节，超过 ${config.maxBytes} 字节上限`);
  }
}

// 把手上这一帧按「到 specElapsed 为止的停留时长」写出（gifenc 的 delay 参数是毫秒）。
function writeHeld(specElapsed) {
  const delayCs = delayCsUntil(specElapsed);
  encoder.writeFrame(held.index, config.width, config.height, {
    palette: held.palette, delay: delayCs * 10, repeat: 0,
    transparent: false, dispose: 1, colorDepth: 8,
  });
  writtenCs += delayCs;
  checkBytes();
}

function handleFrame(id, message) {
  const elapsed = checkElapsed(message.elapsedMs, FRAME_LIMIT_MS);
  if (finished) throw coded('FINISHED', 'GIF 已经结束，不能再加帧');
  const expected = config.width * config.height * 4;
  if (!(message.buffer instanceof ArrayBuffer) || message.buffer.byteLength !== expected) {
    throw coded('BAD_FRAME', `帧数据必须是 ${expected} 字节的 RGBA（ArrayBuffer）`);
  }
  const rgba = new Uint8Array(message.buffer);
  const palette = quantize(rgba, 256, { format: 'rgb565' });
  const index = applyPalette(rgba, palette, 'rgb565');
  // 先按新帧到达的时刻把上一帧的停留时长写进去，再换上新帧。
  if (held) writeHeld(elapsed);
  held = { index, palette, elapsedMs: elapsed };
  lastElapsed = elapsed;
  parentPort.postMessage({ type: 'ok', id });
}

function handleFinish(id, message) {
  const elapsed = checkElapsed(message.elapsedMs, FINISH_LIMIT_MS);
  if (finished) throw coded('FINISHED', 'GIF 已经结束过了');
  if (!held) throw coded('NO_FRAMES', '还没有可写出的帧');
  writeHeld(elapsed);
  encoder.finish();
  checkBytes();
  finished = true;
  const view = encoder.bytesView();
  const copy = view.slice(); // 独立缓冲，便于 transfer 给宿主
  parentPort.postMessage({ type: 'done', id, buffer: copy.buffer, bytes: copy.byteLength }, [copy.buffer]);
  held = null;
}

parentPort.on('message', message => {
  if (!message || typeof message !== 'object') return;
  const id = Number.isSafeInteger(message.id) ? message.id : null;
  try {
    if (message.type === 'init') {
      if (config) throw coded('ALREADY_INIT', '已经初始化过了');
      config = readConfig(message);
      encoder = GIFEncoder();
      parentPort.postMessage({ type: 'ready', id });
      return;
    }
    if (!config || !encoder) throw coded('NOT_READY', 'GIF 编码器还没初始化');
    if (message.type === 'frame') handleFrame(id, message);
    else if (message.type === 'finish') handleFinish(id, message);
    else throw coded('BAD_MESSAGE', '未知指令');
  } catch (error) {
    parentPort.postMessage({ type: 'error', id, code: error?.code || 'ENCODE_FAILED',
      message: error?.message || 'GIF 编码失败' });
  }
});
