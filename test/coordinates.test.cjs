const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toPixels, outsideMask } = require('../core/coordinates.cjs');

test('100% / 125% / 150% 的负坐标副屏', () => {
  for (const scale of [1, 1.25, 1.5]) {
    assert.deepEqual(toPixels({ x: -1700, y: 120, width: 800, height: 600 },
      { x: -1920, y: 0, width: 1920, height: 1080 },
      { width: 1920 * scale, height: 1080 * scale }),
    { x: 220 * scale, y: 120 * scale, width: 800 * scale, height: 600 * scale });
  }
});

test('边界按端点取整，不让裁切超过视频边界', () => {
  assert.deepEqual(toPixels({ x: 1, y: 1, width: 2, height: 2 },
    { x: 0, y: 0, width: 3, height: 3 }, { width: 4, height: 4 }),
  { x: 1, y: 1, width: 3, height: 3 });
});

test('中空遮罩按物理裁切反推：多DPI、负坐标和小数选框都不压入成图', () => {
  for (const scale of [1, 1.25, 1.5, 1.75, 2]) for (const origin of [0, -1920]) {
    const bounds = { x: origin, y: -600, width: 1024, height: 768 };
    const frame = { width: 1024 * scale, height: 768 * scale };
    const pixels = toPixels({ x: origin + 20.4, y: -559.7, width: 220.8, height: 350.2 }, bounds, frame);
    const panels = outsideMask(pixels, bounds, frame); assert.equal(panels.length, 4);
    for (const p of panels) {
      assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.width <= bounds.width && p.y + p.height <= bounds.height);
      assert.ok((p.x + p.width) * scale <= pixels.x || p.x * scale >= pixels.x + pixels.width ||
        (p.y + p.height) * scale <= pixels.y || p.y * scale >= pixels.y + pixels.height);
      for (const q of panels) if (p !== q) assert.ok(p.x + p.width <= q.x || q.x + q.width <= p.x || p.y + p.height <= q.y || q.y + q.height <= p.y);
    }
  }
});
test('全屏选区没有外部遮罩；贴边选区不生成零宽色块', () => {
  const bounds = { width: 100, height: 100 };
  assert.deepEqual(outsideMask({ x: 0, y: 0, width: 100, height: 100 }, bounds, bounds), []);
  assert.equal(outsideMask({ x: 0, y: 0, width: 20, height: 30 }, bounds, bounds).length, 2);
  assert.throws(() => outsideMask({ x: -1, y: 0, width: 20, height: 30 }, bounds, bounds), RangeError);
});

test('无效或跨屏选区明确拒绝', () => {
  const display = { x: 0, y: 0, width: 100, height: 100 };
  for (const rect of [{ x: -1, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: 101, height: 10 }, { x: 0, y: 0, width: 0, height: 10 },
    { x: NaN, y: 0, width: 10, height: 10 }]) {
    assert.throws(() => toPixels(rect, display, display), RangeError);
  }
});
