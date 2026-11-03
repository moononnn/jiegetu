'use strict';

// 用屏幕流的真实尺寸换算，避免假定所有显示器使用同一个 DPI。
function toPixels(rect, displayBounds, frame) {
  for (const box of [rect, displayBounds, frame]) {
    if (!Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0) {
      throw new RangeError('无效尺寸');
    }
  }
  if (![rect.x, rect.y, displayBounds.x, displayBounds.y].every(Number.isFinite)) throw new RangeError('无效坐标');
  if (rect.x < displayBounds.x || rect.y < displayBounds.y ||
      rect.x + rect.width > displayBounds.x + displayBounds.width ||
      rect.y + rect.height > displayBounds.y + displayBounds.height) throw new RangeError('选区超出显示器');
  const sx = frame.width / displayBounds.width;
  const sy = frame.height / displayBounds.height;
  const x = Math.round((rect.x - displayBounds.x) * sx);
  const y = Math.round((rect.y - displayBounds.y) * sy);
  return { x, y, width: Math.round((rect.x + rect.width - displayBounds.x) * sx) - x,
    height: Math.round((rect.y + rect.height - displayBounds.y) * sy) - y };
}

// 从实际物理裁切反推中空区，向外留1 DIP安全带，色块绝不压进输出。
function outsideMask(pixels, bounds, frame) {
  if (![bounds.width, bounds.height, frame.width, frame.height, pixels.width, pixels.height].every(n => Number.isFinite(n) && n > 0) ||
      ![pixels.x, pixels.y].every(Number.isFinite) || pixels.x < 0 || pixels.y < 0 ||
      pixels.x + pixels.width > frame.width || pixels.y + pixels.height > frame.height) throw new RangeError('无效提示范围');
  const left = Math.max(0, Math.floor(pixels.x * bounds.width / frame.width) - 1);
  const top = Math.max(0, Math.floor(pixels.y * bounds.height / frame.height) - 1);
  const right = Math.min(bounds.width, Math.ceil((pixels.x + pixels.width) * bounds.width / frame.width) + 1);
  const bottom = Math.min(bounds.height, Math.ceil((pixels.y + pixels.height) * bounds.height / frame.height) + 1);
  return [
    { x: 0, y: 0, width: bounds.width, height: top },
    { x: 0, y: bottom, width: bounds.width, height: bounds.height - bottom },
    { x: 0, y: top, width: left, height: bottom - top },
    { x: right, y: top, width: bounds.width - right, height: bottom - top }
  ].filter(r => r.width > 0 && r.height > 0);
}

module.exports = { toPixels, outsideMask };
