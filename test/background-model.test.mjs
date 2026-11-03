import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModel, observeBackground, extendBackground, backgroundReady, mirrorSourceRow, backgroundSourceRow, backgroundSummary, CONFIRMATIONS } from '../core/background-model.mjs';
import { createScrollSession } from '../core/scroll-session.mjs';

function solid(width, height, value) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255; }
  return { data, width, height };
}
function paint(frame, x, y, value) {
  const i = (y * frame.width + x) * 4;
  frame.data[i] = frame.data[i + 1] = frame.data[i + 2] = value;
}
function hash(a, b) { return (Math.imul(a + 7, 17389) ^ Math.imul(b + 13, 31337)) >>> 0; }

/**
 * 匿名程序化页面：视口固定且带纹理的壁纸 + 滚动的纸面正文。
 * fixed=false 时壁纸跟内容一起滚，用来对照「没有固定背景层时不能动像素」。
 */
function texturedPage(offset, { width = 180, height = 320, left = 16, right = 164, fixed = true, smooth = false } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const wallpaper = fixed ? y : y + offset;
    // 竖条纹壁纸：相邻像素永远差得很远，保证每一列都可当纹理来学；
    // 条纹只随视口坐标（fixed）变，内容滚它不动。
    let value = smooth ? 80 + ((x + wallpaper) % 100) : ((x + wallpaper) & 1 ? 45 : 215) + (hash(x, wallpaper) % 24) - 12;
    const p = y + offset, block = Math.floor(p / 18);
    if (x >= left && x < right) {
      const glyph = hash(block, Math.floor((x - left) / 5)) % 5 < 2 && x % 6 < 4;
      value = glyph ? 32 : 246;
    }
    const i = (y * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255;
  }
  return { data, width, height };
}

test('镜像源行从底部接着往下，折返处不跳行', () => {
  const height = 60, rows = [];
  for (let doc = height; doc < height + 4 * height; doc++) rows.push(mirrorSourceRow(doc, height));
  assert.equal(rows[0], height - 1);
  assert.equal(rows[1], height - 2);
  assert.equal(rows[height - 1], 0);
  assert.equal(rows[height], 1);
  for (let i = 1; i < rows.length; i++) assert.ok(Math.abs(rows[i] - rows[i - 1]) === 1, `第${i}行跳跃：${rows[i - 1]}→${rows[i]}`);
  for (const row of rows) assert.ok(row >= 0 && row < height, `源行越界：${row}`);
  // 首屏下沿必须接着走，不能因为避让上边缘而在第一道缝上跳开一段。
  assert.equal(backgroundSourceRow(height, height), height - 2);
  assert.equal(backgroundSourceRow(height + 2, height), height - 3);
  assert.equal(backgroundSourceRow(height, height, 40), height - 2, '固定顶栏不影响底部源行');
  assert.equal(backgroundSourceRow(height + height - 1, height, 40), 40, '真检测到顶栏时才避开顶部');
});

test('背景层要求邻域静止，同色纸面与完全平坦区域不参与', () => {
  const model = createBackgroundModel(8, 6);
  const previous = solid(8, 6, 128), current = solid(8, 6, 128);
  for (let x = 0; x < 8; x++) for (let y = 0; y < 6; y++) {
    const texture = (hash(x, y) % 120) + 60;
    paint(previous, x, y, texture); paint(current, x, y, texture);
  }
  for (const [x, y] of [[3, 3], [4, 3], [3, 4], [4, 4]]) { paint(previous, x, y, 246); paint(current, x, y, 246); } // 一块纯色纸面
  paint(current, 1, 1, 10);                                                                                            // 有运动证据
  for (let round = 1; round <= CONFIRMATIONS; round++) {
    const mask = observeBackground(model, previous, current, { start: 0, rows: 6 });
    assert.equal(mask.length, 48);
    if (round < CONFIRMATIONS) assert.equal(model.valid[2 * 8 + 6], 0, `第${round}次还不该确认`);
  }
  assert.equal(model.valid[1 * 8 + 1], 0, '有变化的像素不是背景');
  assert.equal(model.valid[2 * 8 + 6], 1, '连续静止且邻域不动的纹理像素应成为背景');
  assert.equal(model.valid[2 * 8 + 2], 0, '临近运动像素的点也应保守排除');
  assert.equal(model.valid[3 * 8 + 3], 0, '纯色纸面不参与背景层');
});

test('证据冲突时背景资格作废，不会拿可疑值盖真实壁纸', () => {
  const model = createBackgroundModel(8, 6);
  const still = solid(8, 6, 150);
  for (let x = 0; x < 8; x++) for (let y = 0; y < 6; y++) paint(still, x, y, (hash(x, y) % 150) + 40);
  for (let round = 0; round < CONFIRMATIONS; round++) observeBackground(model, still, still, { start: 0, rows: 0 });
  assert.equal(model.valid[4 * 8 + 4], 1);
  const changed = { data: still.data.slice(), width: 8, height: 6 };
  paint(changed, 4, 4, 5);
  observeBackground(model, still, changed, { start: 0, rows: 0 });
  assert.equal(model.valid[4 * 8 + 4], 1, '单次移动遮挡保留历史背景');
  observeBackground(model, changed, changed, { start: 0, rows: 0 });
  assert.equal(model.valid[4 * 8 + 4], 0, '同一坐标出现两种静止值，必须退回待确认');
  assert.equal(backgroundReady(model), false, '画幅太小的模型不足以启用延展');
});

test('固定纹理壁纸：新增条背景接成连续画面，正文逐字节不动', () => {
  const width = 180, height = 320, seed = texturedPage(0, { width, height });
  const session = createScrollSession(seed);
  const accepted = [0], frames = [seed], shifts = [];
  for (const offset of [24, 48, 72, 96, 120, 144]) {
    const frame = texturedPage(offset, { width, height });
    const result = session.accept(frame, offset * 10);
    assert.equal(result.result.kind, 'forward', `offset=${offset}: ${JSON.stringify(result.result)}`);
    accepted.push(offset); frames.push(frame); shifts.push(result.added);
  }
  const output = session.finish();
  assert.ok(output.background, '固定纹理背景应当启用连续延展');
  assert.equal(output.height, height + 144);
  const stride = width * 4;
  let backgroundChecked = 0, contentChecked = 0;
  for (let doc = height; doc < output.height; doc++) {
    const local = backgroundSourceRow(doc, height);
    for (const x of [1, 5, 12, 172]) {
      assert.equal(output.data[doc * stride + x * 4], seed.data[local * stride + x * 4], `背景列 x=${x} 第${doc}行应接成连续壁纸`);
      backgroundChecked++;
    }
    for (let x = 18; x < 162; x += 9) {
      assert.equal(output.data[doc * stride + x * 4], capturedPixel(accepted, shifts, frames, x, doc, height), `正文 x=${x} 第${doc}行必须保留原像素`);
      contentChecked++;
    }
  }
  assert.ok(backgroundChecked >= 500 && contentChecked >= 2000, `覆盖不足：背景${backgroundChecked} 正文${contentChecked}`);
  assert.ok(output.background.pixels > 800, `延展像素数异常：${output.background.pixels}`);
});

test('真实匹配会话：柔和固定壁纸能启用，正文完整保留', () => {
  const seed = texturedPage(0, { smooth: true }), session = createScrollSession(seed);
  const frames = [seed], accepted = [0], shifts = [];
  for (const offset of [24, 48, 72, 96, 120, 144]) {
    const frame = texturedPage(offset, { smooth: true });
    const update = session.accept(frame, offset * 10);
    assert.equal(update.added, 24, `offset=${offset}: ${JSON.stringify(update.result)}`);
    frames.push(frame); accepted.push(offset); shifts.push(update.added);
  }
  const output = session.finish();
  assert.ok(output.background?.pixels > 1000);
  for (let doc = 320; doc < output.height; doc++) for (let x = 18; x < 162; x++) {
    const original = capturedPixel(accepted, shifts, frames, x, doc, 320);
    for (let c = 0; c < 3; c++) assert.equal(output.data[(doc * 180 + x) * 4 + c], original);
  }
});

function capturedPixel(accepted, shifts, frames, x, docRow, seedHeight) {
  for (let i = 1; i < accepted.length; i++) {
    const start = seedHeight + accepted[i - 1];
    if (docRow < start || docRow >= start + shifts[i - 1]) continue;
    const frame = frames[i], local = seedHeight - shifts[i - 1] + (docRow - start);
    return frame.data[(local * frame.width + x) * 4];
  }
  throw new Error(`行 ${docRow} 不属于任何新增条`);
}

test('滚动壁纸：没有固定背景层时输出与原切片逐字节相同', () => {
  const width = 180, height = 320, options = { width, height, fixed: false };
  const seed = texturedPage(0, options);
  const session = createScrollSession(seed);
  const parts = [seed.data.slice()];
  for (const offset of [24, 48, 72]) {
    const frame = texturedPage(offset, options);
    const result = session.accept(frame, offset * 10);
    assert.equal(result.result.kind, 'forward', `offset=${offset}: ${JSON.stringify(result.result)}`);
    parts.push(frame.data.slice((height - result.added) * width * 4));
  }
  const output = session.finish();
  assert.equal(output.background, undefined, '滚动壁纸不应触发延展');
  const expected = new Uint8ClampedArray((height + 72) * width * 4);
  let cursor = 0;
  for (const part of parts) { expected.set(part, cursor); cursor += part.length; }
  assert.deepEqual(output.data, expected);
});

test('延展只写掩码内的可信背景像素，源行从底部接着走并留出最后一行', () => {
  const model = createBackgroundModel(4, 20);
  for (let i = 0; i < 4 * 20; i++) { model.valid[i] = 1; model.validCount++; }
  for (let y = 0; y < 20; y++) for (let x = 0; x < 4; x++) {
    const i = (y * 4 + x) * 4;
    model.data[i] = model.data[i + 1] = model.data[i + 2] = y + 100;
  }
  const seed = solid(4, 20, 42), strip = solid(4, 5, 200);
  const mask = new Uint8Array(4 * 5);
  mask[1] = 1; mask[2] = 1;
  paint(strip, 1, 0, 115); // 当前像素与目标视口行的背景一致，才可替换。
  const result = extendBackground([{ height: 20, data: seed.data }, { height: 5, data: strip.data, mask, sourceStart: 15 }], model, { seedHeight: 20 });
  assert.equal(result.active, true);
  assert.equal(result.rows, 1);
  assert.equal(result.pixels, 1);
  const local = backgroundSourceRow(20, 20);
  assert.equal(strip.data[4], local + 100, '掩码内背景像素换成连续背景');
  assert.equal(strip.data[0], 200, '掩码外的像素必须原样保留');
  assert.equal(strip.data[8], 200, '即使有瞬时掩码，当前颜色不符目标历史背景也不能涂');
  assert.equal(strip.data[3], 255, 'alpha 不动');
  assert.equal(strip.mask, undefined, '收尾后释放掩码');
});

test('延展只留原因计数：不记颜色坐标，前提不满足时 processed=false', () => {
  const model = createBackgroundModel(6, 20);
  for (let i = 0; i < 6 * 20; i++) { model.valid[i] = 1; model.validCount++; }
  for (let y = 0; y < 20; y++) for (let x = 0; x < 6; x++) {
    const i = (y * 6 + x) * 4;
    model.data[i] = model.data[i + 1] = model.data[i + 2] = y + 100;
  }
  model.movingColumns[5] = 1;
  const seed = solid(6, 20, 42), strip = solid(6, 1, 200);
  const mask = new Uint8Array(6);
  for (const x of [1, 2, 3, 4]) mask[x] = 1;
  paint(strip, 3, 0, 130); // 与目标背景不符
  paint(strip, 4, 0, 115); // 与目标背景一致，唯一可写的一像素
  const target = 15 * 6, source = backgroundSourceRow(20, 20) * 6;
  model.valid[target + 1] = 0; model.validCount--;
  model.valid[source + 2] = 0; model.validCount--;
  const result = extendBackground([{ height: 20, data: seed.data },
    { height: 1, data: strip.data, mask, sourceStart: 15 }, { height: 4, data: new Uint8ClampedArray(4 * 6 * 4) }], model, { seedHeight: 20 });
  assert.deepEqual(Object.keys(result).sort(), ['active', 'pixels', 'rows'], '返回值形状不变');
  assert.equal(result.active, true); assert.equal(result.rows, 1); assert.equal(result.pixels, 1);
  assert.equal(strip.data[16], 118, '唯一写入仍是连续背景色');
  assert.equal(strip.data[0], 200, '拒绝的像素原样保留');
  assert.deepEqual(backgroundSummary(model).extend, { processed: true, chunks: 3, invalidChunks: 1, movingPixels: 1,
    maskPixels: 1, targetInvalidPixels: 1, sourceInvalidPixels: 1, colorMismatchPixels: 1 });
  const fresh = createBackgroundModel(6, 20);
  assert.equal(backgroundSummary(fresh).extend, null, '未调用延展时不伪造计数');
  assert.equal(extendBackground([{ height: 20, data: seed.data }], fresh, { seedHeight: 20 }).active, false);
  const skipped = backgroundSummary(fresh).extend;
  assert.equal(skipped.processed, false, '前提不满足必须与“到了像素阶段但全拒”区分');
  assert.equal(skipped.chunks, 1); assert.equal(skipped.invalidChunks, 0); assert.equal(skipped.movingPixels, 0);
});





