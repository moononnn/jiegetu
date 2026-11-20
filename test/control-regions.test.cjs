'use strict';
// The frozen-frame control-rectangle detector: synthetic browser-like fixtures (whole controls
// plus noise) and the guard rails. Nothing here reads text, fonts or names - the detector only
// looks for matching orthogonal border runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectControlRegions } = require('../renderer/control-regions.js');

function surface(width, height, background = [242, 243, 246]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      data[at] = background[0]; data[at + 1] = background[1]; data[at + 2] = background[2]; data[at + 3] = 255;
    }
  }
  const set = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const at = (y * width + x) * 4;
    data[at] = rgb[0]; data[at + 1] = rgb[1]; data[at + 2] = rgb[2]; data[at + 3] = 255;
  };
  return {
    data,
    set,
    fill(x, y, w, h, rgb) { for (let j = 0; j < h; j += 1) for (let i = 0; i < w; i += 1) set(x + i, y + j, rgb); },
    border(x, y, w, h, rgb, thickness = 2) {
      for (let t = 0; t < thickness; t += 1) {
        for (let i = 0; i < w; i += 1) { set(x + i, y + t, rgb); set(x + i, y + h - 1 - t, rgb); }
        for (let j = 0; j < h; j += 1) { set(x + t, y + j, rgb); set(x + w - 1 - t, y + j, rgb); }
      }
    },
    // A rounded corner leaves the corner pixels empty, the sides stay straight.
    rounded(x, y, w, h, rgb, radius = 6, thickness = 2) {
      for (let t = 0; t < thickness; t += 1) {
        for (let i = radius; i < w - radius; i += 1) { set(x + i, y + t, rgb); set(x + i, y + h - 1 - t, rgb); }
        for (let j = radius; j < h - radius; j += 1) { set(x + t, y + j, rgb); set(x + w - 1 - t, y + j, rgb); }
      }
    },
    // Text-like strokes: short dark runs that must never become a control.
    textLine(x, y, w, rgb = [60, 62, 70], thickness = 3) {
      for (let j = 0; j < thickness; j += 1) for (let i = 0; i < w; i += 1) set(x + i, y + j, rgb);
    },
  };
}

const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const found = (boxes, rect, ratio = 0.6) => boxes.filter(box => overlapArea(box, rect) >= ratio * rect.width * rect.height);

// The renderer hands the detector one bounded sample (long edge 768). This is a stand-in for the
// filtered drawImage the page does: a box average over the source footprint.
function sample768(rgba, width, height) {
  const scale = Math.min(1, 768 / Math.max(width, height));
  const w = Math.round(width * scale), h = Math.round(height * scale);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const fx = x / scale, fy = y / scale;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    const tx = Math.min(1, fx - x0), ty = Math.min(1, fy - y0);
    for (let c = 0; c < 3; c++) {
      const p00 = (y0 * width + x0) * 4 + c, p10 = (y0 * width + x1) * 4 + c;
      const p01 = (y1 * width + x0) * 4 + c, p11 = (y1 * width + x1) * 4 + c;
      out[(y * w + x) * 4 + c] = (rgba[p00] * (1 - tx) + rgba[p10] * tx) * (1 - ty) + (rgba[p01] * (1 - tx) + rgba[p11] * tx) * ty;
    }
    out[(y * w + x) * 4 + 3] = 255;
  }
  return { data: out, w, h, scale };
}

// A dense file panel (many rows, many small buttons) with a compact transient overlay on top of
// it. The overlay is what the user wants to snap to; the panel behind it must not hide it.
function panelWithOverlay() {
  const width = 1440, height = 1760;
  const canvas = surface(width, height, [240, 242, 239]);
  canvas.fill(58, 0, 3, height, [127, 185, 138]);      // the panel's accent line at its left edge
  for (let row = 0; row < 120; row += 1) {
    const y = 110 + row * 26;
    canvas.textLine(96, y, 190, [92, 96, 104], 7);
    canvas.textLine(320, y, 140, [92, 96, 104], 7);
    canvas.rounded(672, y - 12, 34, 34, [176, 182, 174], 8, 3);
    canvas.rounded(736, y - 12, 34, 34, [176, 182, 174], 8, 3);
    canvas.rounded(1312, y - 12, 34, 34, [176, 182, 174], 8, 3);
  }
  const overlay = { x: 76, y: 1390, width: 612, height: 300 };
  canvas.fill(overlay.x, overlay.y, overlay.width, overlay.height, [235, 238, 233]);
  canvas.border(overlay.x, overlay.y, overlay.width, overlay.height, [200, 208, 198], 3);
  canvas.textLine(overlay.x + 38, overlay.y + 36, 150, [70, 74, 80], 11);
  for (let j = 0; j < 76; j += 1) for (let i = 0; i < 76; i += 1) {
    canvas.set(overlay.x + 36 + i, overlay.y + 96 + j, [(i * 7 + j * 13) % 255, (i * 3) % 255, (j * 5) % 255]);
  }
  for (let line = 0; line < 3; line += 1) canvas.textLine(overlay.x + 150, overlay.y + 104 + line * 32, 330, [96, 100, 108], 10);
  return { canvas, width, height, overlay };
}

test('合成浏览器版面：输入框、卡片、按钮都能被认出来', () => {
  const canvas = surface(640, 360);
  // Whole controls: a text input, a card with a title bar, a button.
  canvas.border(40, 40, 260, 40, [120, 124, 132]);
  canvas.border(40, 120, 320, 120, [150, 154, 162]);
  canvas.textLine(56, 140, 180);
  canvas.border(430, 40, 120, 40, [90, 94, 102], 2);
  // Noise: a table without vertical sides and loose text lines.
  for (let row = 260; row < 340; row += 26) canvas.textLine(40, row, 480);
  const boxes = detectControlRegions(canvas.data, 640, 360);
  const input = { x: 40, y: 40, width: 260, height: 40 };
  const card = { x: 40, y: 120, width: 320, height: 120 };
  const button = { x: 430, y: 40, width: 120, height: 40 };
  assert.equal(found(boxes, input).length >= 1, true, '输入框必须被认出来');
  assert.equal(found(boxes, card).length >= 1, true, '卡片必须被认出来');
  assert.equal(found(boxes, button).length >= 1, true, '按钮必须被认出来');
  // The table rows are long horizontal lines without vertical sides: not a control.
  assert.equal(found(boxes, { x: 40, y: 258, width: 480, height: 84 }, 0.3).length, 0, '只有横线的表格不能变成控件');
});

test('合成浏览器版面：圆角控件仍然可认，文字/噪声块不可认', () => {
  const canvas = surface(640, 360);
  canvas.rounded(40, 40, 300, 44, [110, 114, 122]);
  canvas.textLine(60, 56, 120);
  canvas.rounded(40, 120, 300, 90, [140, 144, 152]);
  // A busy picture block must not become a control.
  for (let y = 240; y < 340; y += 3) {
    for (let x = 380; x < 620; x += 3) canvas.set(x + (y % 5), y, [(x * 7 + y * 13) % 255, (x * 3) % 255, (y * 5) % 255]);
  }
  const boxes = detectControlRegions(canvas.data, 640, 360);
  assert.equal(found(boxes, { x: 40, y: 40, width: 300, height: 44 }).length >= 1, true, '圆角输入框要能认出来');
  assert.equal(found(boxes, { x: 40, y: 120, width: 300, height: 90 }).length >= 1, true, '圆角卡片要能认出来');
  assert.equal(found(boxes, { x: 380, y: 240, width: 240, height: 100 }, 0.4).length, 0, '花色噪点块不能变成控件');
});

test('同一版面按不同尺寸与缩放给出同样的相对结果', () => {
  const draw = (scale) => {
    const canvas = surface(640 * scale, 360 * scale);
    canvas.border(40 * scale, 40 * scale, 260 * scale, 40 * scale, [120, 124, 132]);
    canvas.border(40 * scale, 120 * scale, 320 * scale, 120 * scale, [150, 154, 162]);
    canvas.textLine(56 * scale, 140 * scale, 180 * scale);
    return canvas;
  };
  const one = detectControlRegions(draw(1).data, 640, 360);
  const two = detectControlRegions(draw(2).data, 1280, 720);
  const cardOne = { x: 40, y: 120, width: 320, height: 120 };
  const cardTwo = { x: 80, y: 240, width: 640, height: 240 };
  assert.equal(found(one, cardOne).length >= 1, true);
  assert.equal(found(two, cardTwo).length >= 1, true, '放大两倍后卡片仍要被认出来');
});

test('同一输入跑两次结果一致，非法输入返回空', () => {
  const canvas = surface(640, 360);
  canvas.border(40, 40, 260, 40, [120, 124, 132]);
  const first = detectControlRegions(canvas.data, 640, 360);
  const second = detectControlRegions(canvas.data, 640, 360);
  assert.deepEqual(first, second, '同一帧必须给出同一结果');
  assert.deepEqual(detectControlRegions(null, 640, 360), []);
  assert.deepEqual(detectControlRegions(canvas.data, 640, 359), [], '尺寸与数据不匹配要拒绝');
  assert.deepEqual(detectControlRegions(canvas.data, 32, 32), [], '太小的画面不做猜测');
});

test('密集面板上的临时浮层（通知条）能被认出来，也不会冒出横跨面板的假矩形', () => {
  const { canvas, width, height, overlay } = panelWithOverlay();
  const { data, w, h, scale } = sample768(canvas.data, width, height);
  const boxes = detectControlRegions(data, w, h);
  const expected = { x: Math.round(overlay.x * scale), y: Math.round(overlay.y * scale),
    width: Math.round(overlay.width * scale), height: Math.round(overlay.height * scale) };
  assert.equal(found(boxes, expected, 0.6).length >= 1, true, '临时浮层必须被认出来');
  assert.equal(boxes.filter(box => box.height > 0.5 * h).length, 0, '不能出现横跨面板的假矩形');
});

test('边框强弱不均的控件仍能认出来', () => {
  const canvas = surface(640, 360);
  canvas.border(60, 40, 300, 200, [140, 144, 152]);
  // A stretch of the right border lost most of its edge evidence: the side is weaker, not gone.
  for (let y = 95; y <= 109; y += 1) canvas.fill(359, y, 2, 1, [242, 243, 246]);
  const boxes = detectControlRegions(canvas.data, 640, 360);
  assert.equal(found(boxes, { x: 60, y: 40, width: 300, height: 200 }).length >= 1, true, '弱边框仍要认出来');
});

test('两块面板之间的空隙不能凑成一个跨面板的矩形', () => {
  const canvas = surface(640, 360);
  canvas.border(40, 40, 560, 150, [140, 144, 152]);
  canvas.border(40, 220, 560, 100, [140, 144, 152]);
  const boxes = detectControlRegions(canvas.data, 640, 360);
  assert.equal(found(boxes, { x: 40, y: 40, width: 560, height: 150 }).length >= 1, true, '上层面板要认出来');
  assert.equal(found(boxes, { x: 40, y: 220, width: 560, height: 100 }).length >= 1, true, '下层面板要认出来');
  assert.equal(boxes.filter(box => box.y < 200 && box.y + box.height > 240).length, 0, '两层面板之间的空隙不能变成一个大矩形');
});

test('检测器只做几何，不读文字/字体', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../renderer/control-regions.js'), 'utf8');
  assert.doesNotMatch(source, /measureText|fillText|strokeText|fontFamily|fontSize|recognizeText|\bocr\b/i,
    '不得做文字或字体匹配');
  assert.match(source, /module\.exports = \{ detectControlRegions \}/);
});
