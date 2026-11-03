'use strict';

// 跨屏普通截图的无重采样合成：物理 union 画布 + 逐屏原始像素 blit。
// 只做几何校验与字节搬运：不缩放、不推断镜像、不缓存整屏帧。
const PIXEL_BUDGET = 36_000_000;
const BYTES_PER_PIXEL = 4;

function requireInteger(value, label) {
  if (typeof value !== 'number') throw new TypeError(`${label} 必须是数值`);
  if (!Number.isFinite(value)) throw new RangeError(`${label} 必须是有限数值`);
  if (!Number.isInteger(value)) throw new RangeError(`${label} 必须是整数`);
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} 超出安全整数范围`);
  return value;
}

function requirePoints(value, label) {
  const count = requireInteger(value, label);
  if (count <= 0) throw new RangeError(`${label} 必须为正数`);
  return count;
}

function requireSpan(start, size, label) {
  const end = start + size;
  if (!Number.isSafeInteger(end)) throw new RangeError(`${label} 坐标溢出`);
  return end;
}

// 采集侧真实返回的是 Uint8ClampedArray，因此按单字节视图判定，不绑定具体构造器。
function requireBytes(value, label) {
  if (!ArrayBuffer.isView(value) || value.BYTES_PER_ELEMENT !== 1) throw new TypeError(`${label} 必须是单字节视图`);
  return value;
}

// 规整一个矩形：坐标允许为负，尺寸必须为正安全整数，且端点不溢出。
function normalizeRect(rect, label) {
  if (!rect || typeof rect !== 'object') throw new TypeError(`${label} 必须是对象`);
  const x = requireInteger(rect.x, `${label}.x`);
  const y = requireInteger(rect.y, `${label}.y`);
  const width = requirePoints(rect.width, `${label}.width`);
  const height = requirePoints(rect.height, `${label}.height`);
  return { x, y, width, height,
    endX: requireSpan(x, width, label), endY: requireSpan(y, height, label) };
}

function requirePixelBudget(area, label) {
  if (!Number.isSafeInteger(area) || area > PIXEL_BUDGET) {
    throw new RangeError(`${label} 像素数超出预算 ${PIXEL_BUDGET}`);
  }
  return area;
}

// 按物理屏矩形建立 union 画布：空洞与未覆盖区域保持不透明黑（RGB 0 / A 255）。
function createDesktopFrame(rects) {
  if (!Array.isArray(rects)) throw new TypeError('rects 必须是数组');
  if (rects.length === 0) throw new RangeError('rects 不能为空');
  const surfaces = rects.map((rect, index) => {
    const normalized = normalizeRect(rect, `rects[${index}]`);
    requirePixelBudget(normalized.width * normalized.height, `rects[${index}]`);
    return normalized;
  });

  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const surface of surfaces) {
    if (surface.x < minX) minX = surface.x;
    if (surface.y < minY) minY = surface.y;
    if (surface.endX > maxX) maxX = surface.endX;
    if (surface.endY > maxY) maxY = surface.endY;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) throw new RangeError('union 范围超出安全整数');
  const pixelCount = requirePixelBudget(width * height, 'union');
  if (!Number.isSafeInteger(pixelCount * BYTES_PER_PIXEL)) throw new RangeError('union 字节数超出安全整数');

  const data = Buffer.alloc(pixelCount * BYTES_PER_PIXEL);
  for (let offset = 3; offset < data.length; offset += BYTES_PER_PIXEL) data[offset] = 255;
  return { bounds: { x: minX, y: minY, width, height }, data };
}

function normalizeCanvas(canvas) {
  if (!canvas || typeof canvas !== 'object') throw new TypeError('canvas 必须是对象');
  const bounds = normalizeRect(canvas.bounds, 'canvas.bounds');
  const data = requireBytes(canvas.data, 'canvas.data');
  requirePixelBudget(bounds.width * bounds.height, 'canvas.bounds');
  const expected = bounds.width * bounds.height * BYTES_PER_PIXEL;
  if (!Number.isSafeInteger(expected) || data.length !== expected) {
    throw new RangeError('canvas.data 长度与 bounds 不一致');
  }
  return { bounds, data };
}

// 逐屏 blit：frame 为一次采集的原始 RGBA 字节，按行搬进 union 画布并转成 BGRA。
function blitDesktopFrame(canvas, rect, frame) {
  const surface = normalizeCanvas(canvas);
  const target = normalizeRect(rect, 'rect');
  const { bounds } = surface;
  if (target.x < bounds.x || target.y < bounds.y ||
      target.endX > bounds.endX || target.endY > bounds.endY) {
    throw new RangeError('rect 超出画布范围');
  }
  if (!frame || typeof frame !== 'object') throw new TypeError('frame 必须是对象');
  const width = requirePoints(frame.width, 'frame.width');
  const height = requirePoints(frame.height, 'frame.height');
  if (width !== target.width || height !== target.height) throw new RangeError('frame 尺寸与 rect 不一致');
  requirePixelBudget(width * height, 'frame');
  const source = requireBytes(frame.data, 'frame.data');
  if (source.length !== width * height * BYTES_PER_PIXEL) throw new RangeError('frame.data 长度与尺寸不一致');

  const srcStride = width * BYTES_PER_PIXEL;
  const dstStride = bounds.width * BYTES_PER_PIXEL;
  const dx = (target.x - bounds.x) * BYTES_PER_PIXEL;
  const dy = target.y - bounds.y;
  const dst = surface.data;
  for (let row = 0; row < height; row += 1) {
    let s = row * srcStride;
    let d = (dy + row) * dstStride + dx;
    const end = s + srcStride;
    for (; s < end; s += BYTES_PER_PIXEL, d += BYTES_PER_PIXEL) {
      dst[d] = source[s + 2];
      dst[d + 1] = source[s + 1];
      dst[d + 2] = source[s];
      dst[d + 3] = source[s + 3];
    }
  }
}

module.exports = { createDesktopFrame, blitDesktopFrame, PIXEL_BUDGET };
