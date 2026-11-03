'use strict';
// 录制范围边框：主进程只交物理数据，本页把它投影成自己视口里的 2px 浅绿边。
// 没有 preload：不请求 IPC、不拍屏、不联网，布局不可信时宁可不显示。
window.gifBorderReady = false;
try {
  const MAX_FRAME_EDGE = 32768;
  const MAX_FRAME_PIXELS = 64_000_000;
  const MAX_EDGE = 4096;
  const MAX_PIXELS = 4_000_000;
  const layout = JSON.parse(new URLSearchParams(location.search).get('layout'));
  const frame = layout && layout.frame, pixels = layout && layout.pixels;
  const isInt = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (!frame || typeof frame !== 'object' || !pixels || typeof pixels !== 'object') throw new Error('布局缺失');
  if (!isInt(frame.width, 1, MAX_FRAME_EDGE) || !isInt(frame.height, 1, MAX_FRAME_EDGE) ||
      frame.width * frame.height > MAX_FRAME_PIXELS) throw new Error('帧尺寸无效');
  if (!isInt(pixels.x, 0, MAX_FRAME_EDGE) || !isInt(pixels.y, 0, MAX_FRAME_EDGE) ||
      !isInt(pixels.width, 1, MAX_EDGE) || !isInt(pixels.height, 1, MAX_EDGE) ||
      pixels.width * pixels.height > MAX_PIXELS) throw new Error('选区像素无效');
  // 选区必须完整落在帧内：差一像素就是框错位置。
  if (pixels.x + pixels.width > frame.width || pixels.y + pixels.height > frame.height) throw new Error('选区超出帧');
  // 本页视口才是投影基准：录制窗 DIP 尺寸和采集帧物理尺寸不必相等。
  const width = innerWidth, height = innerHeight;
  if (!isInt(width, 1, MAX_FRAME_EDGE) || !isInt(height, 1, MAX_FRAME_EDGE)) throw new Error('视口无效');
  const scaleX = width / frame.width, scaleY = height / frame.height;
  const left = pixels.x * scaleX, top = pixels.y * scaleY;
  const boxWidth = pixels.width * scaleX, boxHeight = pixels.height * scaleY;
  if (![left, top, boxWidth, boxHeight].every(value => Number.isFinite(value) && value >= 0)) throw new Error('投影无效');
  const border = document.createElement('div');
  border.className = 'border';
  for (const [key, value] of Object.entries({ left, top, width: boxWidth, height: boxHeight })) border.style[key] = `${value}px`;
  document.body.replaceChildren(border);
  if (getComputedStyle(border).position !== 'fixed') throw new Error('边框样式未加载');
  window.gifBorderReady = true;
} catch { /* 主进程核对就绪标志：失败就不显示边框，也不偷偷采屏。 */ }
