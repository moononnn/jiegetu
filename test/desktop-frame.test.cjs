const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopFrame, blitDesktopFrame, PIXEL_BUDGET } = require('../core/desktop-frame.cjs');

function makeSource(width, height, color) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = color(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r; data[offset + 1] = g; data[offset + 2] = b; data[offset + 3] = a;
    }
  }
  return { width, height, data };
}

// 取 union 画布上物理坐标处的 BGRA 像素
function pixel(frame, x, y) {
  const { bounds } = frame;
  assert.ok(x >= bounds.x && y >= bounds.y && x < bounds.x + bounds.width && y < bounds.y + bounds.height, `像素 (${x},${y}) 不在画布内`);
  const offset = ((y - bounds.y) * bounds.width + (x - bounds.x)) * 4;
  return [frame.data[offset], frame.data[offset + 1], frame.data[offset + 2], frame.data[offset + 3]];
}

function swapped(r, g, b, a) { return [b, g, r, a]; }

test('200% 主屏与 125% 副屏的小比例合成：几何、位置与空洞', () => {
  // 逻辑 192x108 @200% → 384x216；逻辑 128x72 @125% → 160x90，副屏在主屏左侧
  const primary = { x: 0, y: 0, width: 384, height: 216 };
  const secondary = { x: -160, y: 0, width: 160, height: 90 };
  const frame = createDesktopFrame([primary, secondary]);
  assert.deepEqual(frame.bounds, { x: -160, y: 0, width: 544, height: 216 });
  assert.equal(frame.data.length, 544 * 216 * 4);

  blitDesktopFrame(frame, primary, makeSource(384, 216, (x, y) => [x & 255, y & 255, 7, 255]));
  blitDesktopFrame(frame, secondary, makeSource(160, 90, (x, y) => [9, y & 255, x & 255, 255]));

  assert.deepEqual(pixel(frame, 0, 0), swapped(0, 0, 7, 255));
  assert.deepEqual(pixel(frame, 383, 215), swapped(383 & 255, 215 & 255, 7, 255));
  assert.deepEqual(pixel(frame, -160, 0), swapped(9, 0, 0, 255));
  assert.deepEqual(pixel(frame, -1, 89), swapped(9, 89, 159, 255));
  // 副屏高 90，其下方属于空洞
  assert.deepEqual(pixel(frame, -100, 150), [0, 0, 0, 255]);
  assert.deepEqual(pixel(frame, -160, 215), [0, 0, 0, 255]);
});

test('负原点 + 竖屏：union 取最小/最大物理边界，像素不做旋转或缩放', () => {
  const portrait = { x: -120, y: -240, width: 120, height: 240 };
  const landscape = { x: 0, y: 0, width: 320, height: 180 };
  const frame = createDesktopFrame([portrait, landscape]);
  assert.deepEqual(frame.bounds, { x: -120, y: -240, width: 440, height: 420 });

  blitDesktopFrame(frame, portrait, makeSource(120, 240, (x, y) => [x, y, 33, 255]));
  blitDesktopFrame(frame, landscape, makeSource(320, 180, (x, y) => [x, y, 77, 255]));

  assert.deepEqual(pixel(frame, -120, -240), swapped(0, 0, 33, 255));
  assert.deepEqual(pixel(frame, -1, -1), swapped(119, 239, 33, 255));
  assert.deepEqual(pixel(frame, 0, 0), swapped(0, 0, 77, 255));
  assert.deepEqual(pixel(frame, 319, 179), swapped(319 & 255, 179, 77, 255));
  // 竖屏右下方（x 0..319, y -239..-1 之外）为公司外空白
  assert.deepEqual(pixel(frame, -120, 0), [0, 0, 0, 255]);
});

test('未覆盖区域与屏间空洞全为不透明黑，整块画布 alpha 恒为 255', () => {
  const frame = createDesktopFrame([
    { x: 0, y: 0, width: 40, height: 20 },
    { x: 0, y: 60, width: 40, height: 20 },
    { x: 40, y: 0, width: 10, height: 80 }
  ]);
  assert.deepEqual(frame.bounds, { x: 0, y: 0, width: 50, height: 80 });
  for (let offset = 3; offset < frame.data.length; offset += 4) assert.equal(frame.data[offset], 255);
  for (let y = 0; y < 80; y += 1) {
    for (let x = 0; x < 50; x += 1) {
      const [r, g, b, a] = pixel(frame, x, y);
      assert.equal(a, 255);
      if ((y >= 20 && y < 60) || x >= 40) assert.deepEqual([r, g, b], [0, 0, 0]);
    }
  }
});

test('跨接缝源像素逐字节一致：无缩放、无插值、无边缘混合', () => {
  const left = { x: 0, y: 0, width: 64, height: 32 };
  const right = { x: 64, y: 0, width: 64, height: 32 };
  const frame = createDesktopFrame([left, right]);
  assert.deepEqual(frame.bounds, { x: 0, y: 0, width: 128, height: 32 });

  blitDesktopFrame(frame, left, makeSource(64, 32, (x, y) => [x, y, 0x10, 255]));
  blitDesktopFrame(frame, right, makeSource(64, 32, (x, y) => [x + 64, y, 0x20, 255]));

  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 128; x += 1) {
      const expected = x < 64 ? swapped(x, y, 0x10, 255) : swapped(x, y, 0x20, 255);
      assert.deepEqual(pixel(frame, x, y), expected, `接缝像素 (${x},${y}) 被改写`);
    }
  }
});

test('重叠屏按 blit 顺序确定性覆盖', () => {
  const back = { x: 0, y: 0, width: 32, height: 32 };
  const front = { x: 8, y: 8, width: 16, height: 16 };
  const canvas = createDesktopFrame([back, front]);
  const backSource = makeSource(32, 32, () => [255, 0, 0, 255]);
  const frontSource = makeSource(16, 16, () => [0, 0, 255, 255]);

  blitDesktopFrame(canvas, back, backSource);
  blitDesktopFrame(canvas, front, frontSource);
  const frontLast = Buffer.from(canvas.data);
  assert.deepEqual(pixel(canvas, 8, 8), [255, 0, 0, 255]);
  assert.deepEqual(pixel(canvas, 7, 7), [0, 0, 255, 255]);
  assert.deepEqual(pixel(canvas, 0, 0), [0, 0, 255, 255]);

  const again = createDesktopFrame([front, back]);
  blitDesktopFrame(again, back, backSource);
  blitDesktopFrame(again, front, frontSource);
  assert.equal(Buffer.compare(again.data, frontLast), 0);

  // 顺序反过来，重叠区改由 back 覆盖
  blitDesktopFrame(canvas, front, frontSource);
  blitDesktopFrame(canvas, back, backSource);
  assert.deepEqual(pixel(canvas, 8, 8), [0, 0, 255, 255]);
  assert.deepEqual(pixel(canvas, 0, 0), [0, 0, 255, 255]);
  assert.notDeepEqual(pixel(canvas, 8, 8), [255, 0, 0, 255]);
});

test('超出像素预算的计划快速拒绝，不分配巨图', () => {
  const started = Date.now();
  assert.equal(PIXEL_BUDGET, 36_000_000);
  assert.throws(() => createDesktopFrame([{ x: 0, y: 0, width: 6001, height: 6000 }]), RangeError);
  assert.throws(() => createDesktopFrame([{ x: 0, y: 0, width: 36_000_001, height: 1 }]), RangeError);
  // 单块都在预算内，但 union 超预算
  assert.throws(() => createDesktopFrame([
    { x: 0, y: 0, width: 4000, height: 4000 },
    { x: 100_000, y: 0, width: 4000, height: 4000 }
  ]), RangeError);
  assert.throws(() => createDesktopFrame([
    { x: 0, y: 0, width: 6000, height: 6000 },
    { x: 6000, y: 0, width: 6000, height: 6000 }
  ]), RangeError);
  assert.ok(Date.now() - started < 2_000, '超预算拒绝不应耗时到分配巨图');
});

test('create 拒绝畸形矩形与坐标溢出', () => {
  const bad = [
    null,
    'x',
    { x: 0, y: 0, width: 1 },
    { x: 0, y: 0, width: NaN, height: 10 },
    { x: NaN, y: 0, width: 10, height: 10 },
    { x: 0, y: Infinity, width: 10, height: 10 },
    { x: 0.5, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: 0, height: 10 },
    { x: 0, y: 0, width: -4, height: 10 },
    { x: 0, y: 0, width: 10, height: 0 },
    { x: 0, y: 0, width: 10.5, height: 10 },
    { x: Number.MAX_SAFE_INTEGER, y: 0, width: 2, height: 1 },
    { x: 0, y: 0, width: '10', height: 10 }
  ];
  for (const rect of bad) {
    assert.throws(() => createDesktopFrame([rect]), (error) => error instanceof RangeError || error instanceof TypeError,
      `未拒绝 ${JSON.stringify(rect)}`);
  }
  assert.throws(() => createDesktopFrame('x'), TypeError);
  assert.throws(() => createDesktopFrame([]), RangeError);
});

test('blit 对非法输入全部拒绝，且不部分写坏原 canvas 字节', () => {
  const boundsRect = { x: 0, y: 0, width: 16, height: 16 };
  const canvas = createDesktopFrame([boundsRect]);
  const seed = makeSource(16, 16, (x, y) => [x * 3, y * 5, (x + y) & 255, 255]);
  blitDesktopFrame(canvas, boundsRect, seed);
  const snapshot = Buffer.from(canvas.data);
  const goodRect = { x: 4, y: 4, width: 8, height: 8 };
  const goodSource = makeSource(8, 8, () => [1, 2, 3, 4]);

  const attempts = [
    () => blitDesktopFrame(canvas, { ...goodRect, x: -1 }, goodSource),
    () => blitDesktopFrame(canvas, { ...goodRect, y: -1 }, goodSource),
    () => blitDesktopFrame(canvas, { ...goodRect, x: 12 }, goodSource),
    () => blitDesktopFrame(canvas, { ...goodRect, y: 12 }, goodSource),
    () => blitDesktopFrame(canvas, { ...goodRect, width: NaN }, goodSource),
    () => blitDesktopFrame(canvas, { ...goodRect, width: 0 }, goodSource),
    () => blitDesktopFrame(canvas, { ...goodRect, width: -8 }, goodSource),
    () => blitDesktopFrame(canvas, { ...goodRect, height: 7.5 }, goodSource),
    () => blitDesktopFrame(canvas, { ...goodRect, x: 0.5 }, goodSource),
    () => blitDesktopFrame(canvas, null, goodSource),
    () => blitDesktopFrame(canvas, goodRect, null),
    () => blitDesktopFrame(canvas, goodRect, { width: 9, height: 8, data: goodSource.data }),
    () => blitDesktopFrame(canvas, goodRect, { width: 8, height: 8, data: goodSource.data.subarray(0, 8 * 8 * 4 - 4) }),
    () => blitDesktopFrame(canvas, goodRect, { width: 8, height: 8, data: Buffer.concat([goodSource.data, Buffer.alloc(4)]) }),
    () => blitDesktopFrame(canvas, goodRect, { width: 8, height: 8, data: [...goodSource.data] }),
    () => blitDesktopFrame(canvas, goodRect, { width: NaN, height: 8, data: goodSource.data }),
    () => blitDesktopFrame(canvas, goodRect, { width: 8, height: 8 }),
    () => blitDesktopFrame({ bounds: { ...boundsRect }, data: canvas.data.subarray(0, 16) }, goodRect, goodSource),
    () => blitDesktopFrame({ bounds: { ...boundsRect, width: NaN }, data: canvas.data }, goodRect, goodSource),
    () => blitDesktopFrame({ bounds: { ...boundsRect } }, goodRect, goodSource),
    () => blitDesktopFrame(null, goodRect, goodSource)
  ];
  for (const attempt of attempts) {
    assert.throws(attempt, (error) => error instanceof RangeError || error instanceof TypeError);
    assert.equal(Buffer.compare(canvas.data, snapshot), 0, 'canvas 在拒绝后被部分写坏');
  }

  // 合法调用仍然生效，证明拒绝不是靠“什么都不做”通过
  blitDesktopFrame(canvas, goodRect, goodSource);
  assert.deepEqual(pixel(canvas, 4, 4), swapped(1, 2, 3, 4));
  assert.deepEqual(pixel(canvas, 3, 3), swapped(9, 15, 6, 255));
});

// win-capture 真实返回的 frame.data 是 new Uint8ClampedArray(bytes)，不是 Buffer。
test('真实 Uint8ClampedArray（含 subarray 偏移）可 blit，源字节不变且输出 BGRA 一致', () => {
  const width = 6; const height = 4;
  const rect = { x: 2, y: 3, width, height };
  const canvas = createDesktopFrame([{ x: 0, y: 0, width: 12, height: 10 }]);
  const backing = new Uint8ClampedArray(width * height * 4 + 16);
  for (let i = 0; i < width * height * 4; i += 1) backing[16 + i] = (i * 7 + 3) & 255;
  const view = backing.subarray(16);
  assert.equal(view.byteOffset, 16);
  assert.equal(view.BYTES_PER_ELEMENT, 1);
  const sourceBytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  const before = Buffer.from(sourceBytes);

  blitDesktopFrame(canvas, rect, { width, height, data: view });

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      assert.deepEqual(pixel(canvas, rect.x + x, rect.y + y),
        [view[offset + 2], view[offset + 1], view[offset], view[offset + 3]], `(${x},${y}) BGRA 不符`);
    }
  }
  assert.equal(Buffer.compare(sourceBytes, before), 0, '源像素被 blit 修改');
  assert.deepEqual(pixel(canvas, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(pixel(canvas, 11, 9), [0, 0, 0, 255]);
});

test('非单字节视图（DataView / Float32 / Uint16 / 普通数组）被拒且画布不被写坏', () => {
  const boundsRect = { x: 0, y: 0, width: 8, height: 8 };
  const canvas = createDesktopFrame([boundsRect]);
  blitDesktopFrame(canvas, boundsRect, makeSource(8, 8, (x, y) => [x, y, 5, 255]));
  const snapshot = Buffer.from(canvas.data);
  const rect = { x: 2, y: 2, width: 4, height: 4 };
  const bytes = 4 * 4 * 4;
  const badFrames = [
    { width: 4, height: 4, data: new DataView(new ArrayBuffer(bytes)) },
    { width: 4, height: 4, data: new Float32Array(bytes / 4) },
    { width: 4, height: 4, data: new Uint16Array(bytes / 2) },
    { width: 4, height: 4, data: new Array(bytes).fill(0) },
    { width: 4, height: 4, data: new Uint8ClampedArray(bytes) }
  ];
  for (const frame of badFrames.slice(0, 4)) {
    assert.throws(() => blitDesktopFrame(canvas, rect, frame), TypeError, `未拒绝 ${frame.data.constructor.name}`);
    assert.equal(Buffer.compare(canvas.data, snapshot), 0, 'canvas 在拒绝后被部分写坏');
  }
  // 非字节视图的 canvas.data 同样拒绝
  assert.throws(() => blitDesktopFrame({ bounds: boundsRect, data: new DataView(new ArrayBuffer(8 * 8 * 4)) }, rect,
    { width: 4, height: 4, data: new Uint8ClampedArray(bytes) }), TypeError);
  assert.equal(Buffer.compare(canvas.data, snapshot), 0);
  // 最后一个反例（byteLength 正确但仍是单字节视图）应当成功，用来确认上面的拒绝只因类型
  blitDesktopFrame(canvas, rect, badFrames[4]);
  assert.deepEqual(pixel(canvas, 2, 2), [0, 0, 0, 0]);
});

