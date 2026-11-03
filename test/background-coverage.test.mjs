import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModel, observeBackground, backgroundReady, extendBackground, backgroundSourceRow, backgroundSummary } from '../core/background-model.mjs';

// 匿名柔和壁纸；前景每次移动，不复制任何应用、真实截图或聊天。
function scene(offset, { width = 120, height = 180, cover = false, movingBackground = false, alpha = 1, soft = false } = {}) {
  const data = new Uint8ClampedArray(width * height * 4), content = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const coordinate = x + y + (movingBackground ? offset : 0);
    let value = soft ? 100 + Math.round(40 * Math.sin(coordinate / 50)) : 80 + (coordinate % 100);
    const doc = y + offset, inside = x >= 20 && x < width - 20 && (cover || doc % 64 < 40);
    if (inside) {
      content[y * width + x] = 1;
      const foreground = doc % 12 < 4 && x % 9 < 4 ? 28 : 246;
      value = Math.round(value * (1 - alpha) + foreground * alpha);
    }
    const q = (y * width + x) * 4;
    data[q] = data[q + 1] = data[q + 2] = value; data[q + 3] = 255;
  }
  return { width, height, data, content };
}

function learn(frames) {
  const model = createBackgroundModel(frames[0].width, frames[0].height);
  const chunks = [{ data: frames[0].data.slice(), height: frames[0].height }];
  for (let i = 1; i < frames.length; i++) {
    const current = frames[i], shift = 8;
    const mask = observeBackground(model, frames[i - 1], current, { start: current.height - shift, rows: shift });
    chunks.push({ data: current.data.slice((current.height - shift) * current.width * 4), height: shift, mask, sourceStart: current.height - shift });
  }
  return { model, chunks };
}

test('柔和固定壁纸也能形成连续背景，不能只认相邻像素强边', () => {
  const frames = Array.from({ length: 13 }, (_, i) => scene(i * 8));
  const { model, chunks } = learn(frames);
  assert.equal(backgroundReady(model), true);
  const before = chunks.map(chunk => chunk.data.slice());
  const result = extendBackground(chunks, model, { seedHeight: 180 });
  assert.equal(result.active, true);
  assert.ok(result.pixels > 1000, `有效背景覆盖过少：${result.pixels}`);
  let changed = 0, checked = 0;
  for (let k = 1; k < chunks.length; k++) for (let r = 0; r < 8; r++) for (let x = 0; x < 120; x++) {
    const sourceY = 180 - 8 + r, i = (r * 120 + x) * 4;
    if (frames[k].content[sourceY * 120 + x]) {
      for (let c = 0; c < 4; c++) assert.equal(chunks[k].data[i + c], before[k][i + c], `前景被改 k=${k} y=${sourceY} x=${x}`);
      checked++;
    }
    if (x === 5) {
      const doc = 180 + (k - 1) * 8 + r, local = backgroundSourceRow(doc, 180);
      assert.equal(chunks[k].data[i], frames[0].data[(local * 120 + x) * 4]);
      if (chunks[k].data[i] !== before[k][i]) changed++;
    }
  }
  assert.ok(checked > 1000); assert.ok(changed > 70, '应真正改变原来重复的壁纸，而非空过');
});

test('已确认壁纸被移动内容短暂遮住，不丢掉此前学到的值；新的静止冲突才撤销', () => {
  const original = scene(0), model = createBackgroundModel(120, 180);
  for (let i = 0; i < 4; i++) observeBackground(model, original, original);
  const pixel = 70 * 120 + 5, q = pixel * 4;
  assert.equal(model.valid[pixel], 1);
  const changed = { ...original, data: original.data.slice() };
  changed.data[q] = changed.data[q + 1] = changed.data[q + 2] = 10;
  observeBackground(model, original, changed);
  assert.equal(model.valid[pixel], 1, '一次运动不能抹掉历史背景');
  assert.equal(model.data[q], original.data[q]);
  observeBackground(model, changed, changed);
  assert.equal(model.valid[pixel], 0, '新的静止异色不能继续沿用旧背景');
});

test('半透明纸面及文字逐字节保留，同时确实修补外侧背景', () => {
  const frames = Array.from({ length: 17 }, (_, i) => scene(i * 8, { alpha: .85 }));
  const { model, chunks } = learn(frames), before = chunks.map(chunk => chunk.data.slice());
  const result = extendBackground(chunks, model, { seedHeight: 180 });
  assert.ok(result.active && result.pixels > 1000);
  let checked = 0;
  for (let k = 1; k < chunks.length; k++) for (let r = 0; r < 8; r++) for (let x = 0; x < 120; x++) {
    if (!frames[k].content[(172 + r) * 120 + x]) continue;
    const q = (r * 120 + x) * 4;
    for (let c = 0; c < 4; c++) assert.equal(chunks[k].data[q + c], before[k][q + c], `半透明内容被改 k=${k} r=${r} x=${x}`);
    checked++;
  }
  assert.ok(checked > 1000);
});

test('外侧连续带遇到一次内容经过就缩回，不拿历史颜色覆盖新内容', () => {
  const frames = Array.from({ length: 9 }, (_, i) => scene(i * 8, { soft: true }));
  const changed = frames[6], q = (175 * 120 + 8) * 4;
  changed.data[q] = changed.data[q + 1] = changed.data[q + 2] = 12;
  const { model, chunks } = learn(frames);
  assert.equal(backgroundSummary(model).edgeColumns, 28, '左侧在第8列止步，右侧20列仍安全');
  extendBackground(chunks, model, { seedHeight: 180 });
  const out = (3 * 120 + 8) * 4;
  assert.equal(chunks[6].data[out], 12, '新进入的内容不能被旧背景覆盖');
});

test('逐帧轻微变色不能滚动更新外侧参考色，累积偏离首观察就停用', () => {
  const frames = Array.from({ length: 9 }, (_, i) => {
    const frame = scene(i * 8, { soft: true });
    for (let q = 0; q < frame.data.length; q += 4) for (let c = 0; c < 3; c++) frame.data[q + c] += i * 2;
    return frame;
  });
  const { model } = learn(frames);
  assert.equal(backgroundSummary(model).edgeColumns, 0);
});

test('条带必须携带有效源行与完整掩码，越界时外侧路径也不能写', () => {
  const { model } = learn(Array.from({ length: 9 }, (_, i) => scene(i * 8, { soft: true })));
  assert.ok(backgroundSummary(model).edgeColumns > 0);
  for (const malformed of ['missing-origin', 'outside-origin', 'too-tall', 'short-mask']) {
    const height = malformed === 'too-tall' ? 181 : 8;
    const part = { height, data: new Uint8ClampedArray(120 * height * 4),
      mask: new Uint8Array(malformed === 'short-mask' ? 1 : 120 * height), sourceStart: malformed === 'outside-origin' ? 180 : 0 };
    for (let y = 0; y < height; y++) part.data.set(model.edgeData.subarray((y % 180) * 480, (y % 180 + 1) * 480), y * 480);
    if (malformed === 'missing-origin') delete part.sourceStart;
    const original = part.data.slice();
    const result = extendBackground([{ height: 180, data: scene(0).data }, part], model, { seedHeight: 180 });
    assert.equal(result.pixels, 0, malformed); assert.deepEqual(part.data, original, malformed);
  }
});

test('非底部条带按显式sourceStart核对目标色，不按条高猜坐标', () => {
  const frames = Array.from({ length: 9 }, (_, i) => scene(i * 8, { soft: true }));
  const { model } = learn(frames);
  const part = { height: 8, sourceStart: 0, data: frames.at(-1).data.slice(0, 120 * 8 * 4), mask: new Uint8Array(120 * 8) };
  const result = extendBackground([{ height: 180, data: scene(0).data }, part], model, { seedHeight: 180 });
  assert.ok(result.pixels > 0);
  assert.equal(part.data[5 * 4], model.edgeData[(backgroundSourceRow(180, 180) * 120 + 5) * 4]);
});

test('柔和但随内容滚动的背景不参与替换', () => {
  const frames = Array.from({ length: 13 }, (_, i) => scene(i * 8, { movingBackground: true }));
  const { model, chunks } = learn(frames), before = chunks.map(chunk => chunk.data.slice());
  const result = extendBackground(chunks, model, { seedHeight: 180 });
  assert.equal(result.active, false);
  for (let k = 0; k < chunks.length; k++) assert.deepEqual(chunks[k].data, before[k]);
});
