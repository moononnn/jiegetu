import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoScrollSession } from '../core/auto-scroll-session.mjs';
import { createBackgroundModel, observeBackground, backgroundSourceRow } from '../core/background-model.mjs';
import { createScene, firstDifference } from './fixtures/auto-scenes.mjs';

// 本轮回归面：append 只读正文视图（不复制两份正文 RGBA），以及 finish 先拼出独占输出、
// 再在输出视图上延展背景（不复制一遍正文）。这里只断言所有权与偏移，不重跑整套匹配行为。

// 夹具本体固定 64 宽：按列平铺到目标宽度，保持“真实 createAutoScrollSession + 现有夹具”的约定。
function expand(image, width) {
  const height = image.height, data = new Uint8ClampedArray(width * height * 4), rowBytes = image.width * 4;
  for (let y = 0; y < height; y++) {
    const row = image.data.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < width; x += image.width) data.set(row.subarray(0, Math.min(image.width, width - x) * 4), (y * width + x) * 4);
  }
  return { width, height, data };
}

// 屏幕固定纹理壁纸带：只依赖屏幕坐标，每帧逐字节相同，才可能被当作固定背景层。
function paintBands(image, bands) {
  if (!bands) return image;
  const { width, height, data } = image;
  for (const side of [0, 1]) {
    for (let x = side === 0 ? 0 : width - bands; x < (side === 0 ? bands : width); x++) {
      for (let y = 0; y < height; y++) {
        const value = 40 + 30 * Math.sin(y / 17) + 20 * Math.sin(y / 5.3 + x / 3);
        const index = (y * width + x) * 4;
        data[index] = 128 + value / 4; data[index + 1] = 96 + value / 3; data[index + 2] = 72 + value / 2; data[index + 3] = 255;
      }
    }
  }
  return image;
}

function build({ width = 240, bodyHeight = 180, top = 0, bottom = 0, offsets, bands = 0, seed = 7 }) {
  const base = createScene({ top, bottom, bodyHeight, offsets, seed });
  const frames = base.frames.map(frame => paintBands(expand(frame.image, width), bands));
  const expected = base.expected ? expand(base.expected, width) : null;
  return { width, height: top + bodyHeight + bottom, bodyHeight, top, bottom, offsets, frames, expected };
}

// 单独取一帧：同一份文档、同一屏幕内容，用于构造正向之外的帧序。
function single({ width = 240, bodyHeight = 180, bands = 0, seed = 7 }, offset) {
  const base = createScene({ bodyHeight, offsets: [offset], seed });
  return paintBands(expand(base.frames[0].image, width), bands);
}

function feed(session, frames) {
  let at = 0;
  let last = null;
  for (const frame of frames) last = session.accept(frame, at += 50);
  return last;
}

const bandColumns = (width, bands) => [
  ...Array.from({ length: bands }, (_, index) => index),
  ...Array.from({ length: bands }, (_, index) => width - bands + index),
];

test('背景观察接受带正 byteOffset 的只读正文视图：像素一致、不越界、不改输入', () => {
  const width = 120, height = 180;
  const base = createScene({ bodyHeight: height, offsets: [0, 16, 32] });
  const previous = expand(base.frames[0].image, width), current = expand(base.frames[1].image, width);
  const wrap = image => {
    // 父缓冲两端的填充是垃圾值：任何越界读都会让结果偏离。
    const owner = new Uint8ClampedArray(image.data.length + 400);
    owner.fill(0x5a);
    owner.set(image.data, 400);
    return { width: image.width, height: image.height, data: owner.subarray(400, 400 + image.data.length) };
  };
  const exactPrevious = { ...previous, data: previous.data.slice() }, exactCurrent = { ...current, data: current.data.slice() };
  const viewPrevious = wrap(previous), viewCurrent = wrap(current);
  const keepPrevious = viewPrevious.data.slice(), keepCurrent = viewCurrent.data.slice();
  const exactModel = createBackgroundModel(width, height), viewModel = createBackgroundModel(width, height);
  for (let round = 0; round < 2; round++) {
    const band = { start: height - 16, rows: 16 };
    assert.deepEqual(observeBackground(viewModel, viewPrevious, viewCurrent, band), observeBackground(exactModel, exactPrevious, exactCurrent, band));
  }
  for (const key of ['data', 'valid', 'streak', 'blocked', 'edgeData', 'edgeColumns', 'movingColumns']) {
    assert.deepEqual(viewModel[key], exactModel[key], `模型字段 ${key} 不一致`);
  }
  assert.deepEqual(viewPrevious.data, keepPrevious, '只读视图的输入不得被改写');
  assert.deepEqual(viewCurrent.data, keepCurrent, '只读视图的输入不得被改写');
});

test('接长只读输入：带非零 byteOffset 的帧仍逐像素正确，调用方数据不被改写', () => {
  const scene = build({ offsets: [0, 40, 80, 120] });
  const wrapped = scene.frames.map(frame => {
    const owner = new Uint8ClampedArray(frame.data.length + 400);
    owner.fill(0x33);
    owner.set(frame.data, 400);
    return { width: scene.width, height: scene.height, data: owner.subarray(400, 400 + frame.data.length) };
  });
  const snapshots = wrapped.map(frame => frame.data.slice());
  const session = createAutoScrollSession(wrapped[0], { maxBytes: snapshots[0].length * 4 });
  feed(session, wrapped);
  const output = session.finish();
  const difference = firstDifference(output, scene.expected);
  assert.equal(difference, null, `输出与文档不一致：${JSON.stringify(difference)}`);
  wrapped.forEach((frame, index) => assert.deepEqual(frame.data, snapshots[index], `第 ${index} 帧被改写`));
});

test('收尾输出独占：连续两次 finish 一致，改写首次输出不污染第二次', () => {
  const scene = build({ offsets: [0, 40, 80, 120], seed: 31 });
  const session = createAutoScrollSession(scene.frames[0], { maxBytes: scene.frames[0].data.length * 4 });
  feed(session, scene.frames);
  const first = session.finish();
  const pixels = first.data.slice();
  const semantics = { height: first.height, width: first.width, complete: first.complete,
    missingRanges: JSON.stringify(first.missingRanges), warning: first.warning, background: JSON.stringify(first.background) };
  first.data.fill(0);
  const second = session.finish();
  assert.notEqual(second.data.buffer, first.data.buffer, '每次 finish 必须是独立输出缓冲');
  assert.deepEqual(second.data, pixels, '第二次输出必须仍是正确像素');
  assert.deepEqual({ height: second.height, width: second.width, complete: second.complete,
    missingRanges: JSON.stringify(second.missingRanges), warning: second.warning, background: JSON.stringify(second.background) }, semantics);
});

test('固定壁纸：延展写进最终输出，已返回检查点与原始输入不被改写', () => {
  const bands = 20, bodyHeight = 180;
  const scene = build({ bodyHeight, offsets: [0, 40, 80, 120, 160], bands, seed: 53 });
  const snapshots = scene.frames.map(frame => frame.data.slice());
  const session = createAutoScrollSession(scene.frames[0], { maxBytes: scene.frames[0].data.length * 6 });
  const last = feed(session, scene.frames);
  const layout = last.result.content;
  assert.ok(layout, '场景必须先建立正文范围');
  const checkpoint = session.checkpoint();
  assert.ok(checkpoint, '完整正向场景应给出可信检查点');
  const checkpointPixels = checkpoint.data.slice(), checkpointHeight = checkpoint.height;
  const output = session.finish();
  assert.ok(output.background?.active, '固定壁纸必须真的启用延展');
  assert.ok(output.background.pixels > 1000, `延展像素过少：${output.background.pixels}`);
  assert.deepEqual(checkpoint.data, checkpointPixels, '收尾不得改写已交给调用方的检查点');
  assert.equal(checkpoint.height, checkpointHeight);
  scene.frames.forEach((frame, index) => assert.deepEqual(frame.data, snapshots[index], `第 ${index} 帧被改写`));
  // 新增条的每行背景像素必须落在模型源行上；偏移错一行就会失败。
  const seedHeight = layout.bottom - layout.top, columns = bandColumns(scene.width, bands);
  let checked = 0;
  for (let row = layout.top + seedHeight; row < output.height - 2; row++) {
    const docRow = row - layout.top, local = backgroundSourceRow(docRow, seedHeight, 2);
    for (const x of columns) {
      assert.equal(output.data[(row * scene.width + x) * 4], scene.frames[0].data[((layout.top + local) * scene.width + x) * 4],
        `第 ${row} 行（文档行 ${docRow}）背景列 x=${x} 未接成连续壁纸`);
      checked++;
    }
  }
  assert.ok(checked > 4000, `覆盖不足：${checked}`);
});

test('上接长使 seedIndex>0：延展仍写在正确的成图行，切片前那段不被涂抹', () => {
  const bands = 20, bodyHeight = 180, step = 40, width = 240, seed = 71;
  // 会话种子按约定是“当前位置”。这里用文档行 200 当种子，向前再往上翻到 160，
  // 于是 ceiling=-40、chunks[0] 是 40 行上接长片段，正文首段排在它后面（seedIndex=1）。
  const frames = [single({ width, bodyHeight, bands, seed }, 200), single({ width, bodyHeight, bands, seed }, 240),
    single({ width, bodyHeight, bands, seed }, 280), single({ width, bodyHeight, bands, seed }, 240),
    single({ width, bodyHeight, bands, seed }, 200), single({ width, bodyHeight, bands, seed }, 160)];
  const session = createAutoScrollSession(frames[0], { maxBytes: frames[0].data.length * 8 });
  const kinds = [];
  let at = 0;
  for (const frame of frames) kinds.push(session.accept(frame, at += 50).result.kind);
  const last = session.stats();
  const layout = last.autoEvidence && session.stats().result.content;
  assert.ok(layout, `场景必须先建立正文范围：${JSON.stringify(kinds)}`);
  const output = session.finish();
  const seedHeight = Math.min(layout.bottom - layout.top, bodyHeight), columns = bandColumns(width, bands);
  const ceiling = -step;
  assert.ok(output.background?.active, `上接长场景也必须真的启用延展：${JSON.stringify(output.backgroundEvidence?.extend)}`);
  assert.ok(output.background.pixels > 0);
  // 1) 上接长片段（文档行 -40..0，位于 chunks[0]）不在延展列表里，必须保持原像素。
  for (let row = layout.top; row < layout.top + step; row++) {
    for (const x of columns) assert.equal(output.data[(row * width + x) * 4], frames[5].data[(row * width + x) * 4],
      `上接长片段的第 ${row} 行背景列被改写`);
  }
  // 2) 首段正文（文档行 0..seedHeight-1）同样不参与延展。
  for (let row = layout.top + step + 140; row < layout.top + step + seedHeight; row++) {
    assert.equal(output.data[(row * width + columns[0]) * 4], frames[0].data[(row - step) * width * 4 + columns[0] * 4],
      `首段正文第 ${row} 行被伪造背景覆盖`);
  }
  // 3) 正文首段之后的新增条按文档坐标接连续壁纸：错位一行这里就会失败。
  let checked = 0;
  for (let row = layout.top + step + seedHeight; row < output.height - 2; row++) {
    const docRow = row - layout.top - step, local = backgroundSourceRow(docRow, seedHeight, 2);
    for (const x of columns) {
      assert.equal(output.data[(row * width + x) * 4], frames[0].data[((layout.top + local) * width + x) * 4],
        `第 ${row} 行（文档行 ${docRow}）背景列 x=${x} 偏移错误`);
      checked++;
    }
  }
  assert.ok(checked > 1000, `覆盖不足：${checked}`);
});
