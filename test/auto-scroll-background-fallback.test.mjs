import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createAutoScrollSession } from '../core/auto-scroll-session.mjs';
import { createScene } from './fixtures/auto-scenes.mjs';

// 本轮新增行为：收尾的背景延展阶段超时，不再仅因此丢掉已有长图，
// 改为保留“未做背景延展”的完整拼接图，并明确警告它不是可信完成图。
// 只覆盖这一条退让路径及其边界；其它阶段超时、可信检查点与恢复契约另有既有用例。

const FALLBACK_TEXT = '背景处理超时，已保留未延展的拼接图，请检查未核实区域';
const REPAIR_TEXT = '实验性修补，来源未完全核实，请对照原图检查';

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
  return { width, height: top + bodyHeight + bottom, bodyHeight, top, bottom, offsets, frames };
}

function single({ width = 240, bodyHeight = 180, bands = 0, seed = 7 }, offset) {
  const base = createScene({ bodyHeight, offsets: [offset], seed });
  return paintBands(expand(base.frames[0].image, width), bands);
}

// 预算时钟可切换：未 arm 时永远返回 0（预算不耗尽）；arm(limit) 后第 limit 次之后的读取暴增。
// 这样 limit 只对应 finish 阶段的读取，扫描范围小且与本机速度无关。
function switchableClock() {
  let armed = false, reads = 0, limit = 0;
  const clock = () => { if (!armed) return 0; reads += 1; return reads > limit ? 1e6 * reads : 0; };
  clock.arm = value => { armed = true; reads = 0; limit = value; };
  // 首次退让后把时钟切回稳定，用来验证重复 finish（不要求第二次的修补阶段也耗尽预算）。
  clock.disarm = () => { armed = false; reads = 0; limit = 0; };
  return clock;
}

function runAt(frames, limit, options = {}) {
  const clock = switchableClock();
  const session = createAutoScrollSession(frames[0], { analysisBudgetMs: 4000, now: clock, maxBytes: frames[0].data.length * 8, ...options });
  let at = 0;
  for (const frame of frames) session.accept(frame, at += 50);
  if (limit !== null) clock.arm(limit);
  let output = null, error = null;
  try { output = session.finish(); } catch (thrown) { error = thrown; }
  return { session, output, error, counters: session.counters() };
}

// finish 阶段的预算读取总数（不 arm、只计数）。
function finishReads(frames, options = {}) {
  let armed = false, reads = 0;
  const clock = () => { if (armed) reads += 1; return 0; };
  const session = createAutoScrollSession(frames[0], { analysisBudgetMs: 4000, now: clock, maxBytes: frames[0].data.length * 8, ...options });
  let at = 0;
  for (const frame of frames) session.accept(frame, at += 50);
  armed = true;
  session.finish();
  return reads;
}

const isFallback = output => output?.background?.active === false && typeof output.warning === 'string' && output.warning.includes(FALLBACK_TEXT);

function differingPixels(a, b) {
  if (a.length !== b.length) return -1;
  let count = 0;
  for (let index = 0; index < a.length; index += 4) {
    if (a[index] !== b[index] || a[index + 1] !== b[index + 1] || a[index + 2] !== b[index + 2] || a[index + 3] !== b[index + 3]) count++;
  }
  return count;
}

// 大数组逐字节比较只用“首个差异位置 + 差异像素数”，不生成上千行 diff（变异验证时会直接撑爆内存）。
function pixelDiff(a, b) {
  if (!a || !b) return { missing: true };
  if (a.length !== b.length) return { length: [a.length, b.length] };
  for (let index = 0; index < a.length; index += 4) {
    if (a[index] !== b[index] || a[index + 1] !== b[index + 1] || a[index + 2] !== b[index + 2] || a[index + 3] !== b[index + 3]) {
      return { at: index, x: (index / 4) % 1 };
    }
  }
  return null;
}
function assertSamePixels(actual, expected, message) {
  const diff = pixelDiff(actual, expected);
  assert.equal(diff, null, `${message}：${JSON.stringify(diff)}`);
}
function assertDifferentPixels(actual, expected, message) {
  assert.ok(pixelDiff(actual, expected) !== null, message);
}

test('背景延展写到像素后超时：交付未延展的完整拼接图，且不交半截延展', () => {
  const scene = build({ offsets: [0, 40, 80, 120, 160], bands: 20, seed: 53 });
  const snapshots = scene.frames.map(frame => frame.data.slice());
  const normal = runAt(scene.frames, null);
  assert.ok(normal.output.background?.active, `正常收尾必须真的启用延展：${JSON.stringify(normal.output.backgroundEvidence?.extend)}`);
  assert.ok(normal.output.background.pixels > 1000, `延展像素过少：${normal.output.background.pixels}`);
  assert.equal(normal.counters.backgroundExtensionFallbacks, 0);

  // limit=1 时延展还没写任何像素，可作为“未延展”参照图（它同样走退让分支，但不含半途写入）。
  const entry = runAt(scene.frames, 1);
  assert.ok(isFallback(entry.output), `入口耗尽也必须走退让：${entry.output?.warning}`);
  assert.equal(entry.counters.backgroundExtensionFallbacks, 1);

  const total = finishReads(scene.frames);
  assert.ok(total > 4, `finish 阶段预算读取过少，无法定位中途：${total}`);
  const rows = [];
  for (let limit = 1; limit <= total; limit += 1) rows.push({ limit, ...runAt(scene.frames, limit) });

  const fallbacks = rows.filter(row => isFallback(row.output));
  assert.ok(fallbacks.length > 0, '扫描必须至少命中一次延展超时');
  // 真正的“写到一半”样本：limit 大于入口，说明延展已经进入像素循环才耗尽。
  // 真正的“写到像素后”样本：limit 必须接近收尾读取末尾。只要求 limit>1 挡不住“还没进行循环就抛”的样本。
  // 最后一个读取是延展出口检查，所以 total-1/-2 处的退让必然发生在写入循环之后或末尾。
  assert.ok(fallbacks.some(row => row.limit >= total - 2),
    `只命中入口或块首耗尽，未覆盖写到像素后：fallbacks=${fallbacks.map(row => row.limit).join(',')} total=${total}`);
  for (const row of fallbacks) {
    assert.equal(row.output.complete, false, '退让结果不得宣称完整');
    assert.equal(row.counters.backgroundExtensionFallbacks, 1, '首次退让只计一次');
    assert.deepEqual(row.output.background, { active: false, rows: 0, pixels: 0 }, '退让输出不得谎称有延展');
    assert.equal(row.output.backgroundEvidence?.extend, null, '退让输出必须把 extend 标成没有可用结果');
    assert.equal(row.output.missingRanges?.length, normal.output.missingRanges?.length, '缺口结构不能被退让改动');
    assertSamePixels(row.output.data, entry.output.data, `limit=${row.limit} 的退让输出必须完全回到未延展像素`);
  }
  // 退让图与正常延展图的差异必须落在被延展写过的那部分像素之内：说明中途写入被整份覆盖回去。
  // 延展可能把某像素写成与原值相同的颜色，所以差异数不超过延展像素数，不能要求严格相等。
  const differing = differingPixels(fallbacks[0].output.data, normal.output.data);
  assert.ok(differing > 0 && differing <= normal.output.background.pixels,
    `退让输出与延展输出的差异越界：${differing} / ${normal.output.background.pixels}`);
  // 差异只能出现在壁纸带列内（正文列一律不能被退让改动）。
  for (let index = 0; index < fallbacks[0].output.data.length; index += 4) {
    const pixel = index / 4, x = pixel % scene.width;
    if (x < 20 || x >= scene.width - 20) continue; // 壁纸带内允许与延展图不同
    if (fallbacks[0].output.data[index] === normal.output.data[index] &&
        fallbacks[0].output.data[index + 1] === normal.output.data[index + 1] &&
        fallbacks[0].output.data[index + 2] === normal.output.data[index + 2]) continue;
    assert.fail(`退让改动了壁纸带以外的像素：x=${x} y=${Math.floor(pixel / scene.width)}`);
  }
  assertDifferentPixels(fallbacks.at(-1).output.data, normal.output.data, '退让输出不能等于延展后的图');
  scene.frames.forEach((frame, index) => assertSamePixels(frame.data, snapshots[index], `第 ${index} 帧被改写`));
});

test('壁纸本来空跑时于入口耗尽：仍保守交未延展图，complete=false 且不清 pending', () => {
  const scene = build({ offsets: [0, 40, 80, 120, 160], seed: 91 });
  const normal = runAt(scene.frames, null);
  assert.equal(normal.output.background?.active, false, '无壁纸场景本来就不延展');
  assert.equal(normal.output.complete, true, normal.output.warning);
  const total = finishReads(scene.frames);
  const rows = [];
  for (let limit = 1; limit <= total; limit += 1) rows.push({ limit, ...runAt(scene.frames, limit) });
  const fallbacks = rows.filter(row => isFallback(row.output));
  assert.ok(fallbacks.length > 0, '无壁纸场景在延展入口耗尽也必须走退让');
  for (const row of fallbacks) {
    assert.equal(row.output.complete, false);
    assertSamePixels(row.output.data, normal.output.data, '空跑退让的像素必须与从未延展时一致');
    assert.match(row.output.warning, /遮挡分析超出预算/);
  }
});

test('上接长（seedIndex>0）时退让：覆盖整份输出且不涂抹切片前片段', () => {
  const bands = 20, bodyHeight = 180, step = 40, width = 240, seed = 71;
  const frames = [single({ width, bodyHeight, bands, seed }, 200), single({ width, bodyHeight, bands, seed }, 240),
    single({ width, bodyHeight, bands, seed }, 280), single({ width, bodyHeight, bands, seed }, 240),
    single({ width, bodyHeight, bands, seed }, 200), single({ width, bodyHeight, bands, seed }, 160)];
  const snapshots = frames.map(frame => frame.data.slice());
  const normal = runAt(frames, null);
  assert.ok(normal.output.background?.active, `上接长场景必须真的启用延展：${JSON.stringify(normal.output.backgroundEvidence?.extend)}`);
  const entry = runAt(frames, 1);
  assert.ok(isFallback(entry.output));
  const total = finishReads(frames);
  const fallbacks = [];
  for (let limit = 1; limit <= total; limit += 1) {
    const row = runAt(frames, limit);
    if (isFallback(row.output)) fallbacks.push({ limit, ...row });
  }
  assert.ok(fallbacks.some(row => row.limit >= total - 2), `必须覆盖上接长场景的中途耗尽：total=${total} fallbacks=${fallbacks.map(row => row.limit).join(',')}`);
  for (const row of fallbacks) assertSamePixels(row.output.data, entry.output.data, `limit=${row.limit} 未完全回到未延展像素`);
  // 切片前那段上接长片段仍保持原像素（没被延展、也没被还原写坏）。
  const firstRow = entry.output.data.slice(0, width * 4 * 4);
  assert.deepEqual(firstRow, frames[5].data.slice(0, width * 4 * 4));
  frames.forEach((frame, index) => assertSamePixels(frame.data, snapshots[index], `第 ${index} 帧被改写`));
});

test('退让后同一会话：重复 finish 一致，改写首次输出不污染，新帧也不重启延展', () => {
  const scene = build({ offsets: [0, 40, 80, 120, 160], bands: 20, seed: 113 });
  const clock = switchableClock();
  const session = createAutoScrollSession(scene.frames[0], { analysisBudgetMs: 4000, now: clock, maxBytes: scene.frames[0].data.length * 8 });
  let at = 0;
  for (const frame of scene.frames) session.accept(frame, at += 50);
  clock.arm(1);
  const first = session.finish();
  assert.ok(isFallback(first));
  clock.disarm();
  const pixels = first.data.slice();
  const semantics = { width: first.width, height: first.height, complete: first.complete,
    missingRanges: JSON.stringify(first.missingRanges), warning: first.warning,
    background: JSON.stringify(first.background), extend: JSON.stringify(first.backgroundEvidence?.extend) };
  first.data.fill(0);
  // 时钟已用完：第二次 finish 的修补/合成与预算都要能正常通过，仍不重启已放弃的延展。
  const second = session.finish();
  assert.notEqual(second.data.buffer, first.data.buffer, '每次 finish 必须是独立输出缓冲');
  assertSamePixels(second.data, pixels, '第二次输出必须仍是未延展的正确像素');
  assert.deepEqual({ width: second.width, height: second.height, complete: second.complete,
    missingRanges: JSON.stringify(second.missingRanges), warning: second.warning,
    background: JSON.stringify(second.background), extend: JSON.stringify(second.backgroundEvidence?.extend) }, semantics);
  assert.equal(session.counters().backgroundExtensionFallbacks, 1, '同一会话只计一次退让');
  // 新帧可以继续接长，但本会话不再重启延展。
  const next = single({ width: 240, bodyHeight: 180, bands: 20, seed: 113 }, 200);
  session.accept(next, at += 50);
  const third = session.finish();
  assert.equal(third.background?.active, false, '退让后不得在新帧上重启延展');
  assert.ok(third.warning.includes(FALLBACK_TEXT));
  assert.equal(session.counters().backgroundExtensionFallbacks, 1);
});

test('退让只认 background-extend：修补阶段耗尽仍然对外抛出', () => {
  // 40 帧 + 3 个屏幕固定控件：收尾修补的检查点会跨过 64 次节流，真的读到时钟。
  const rects = [
    { left: 4, right: 22, top: 40, bottom: 54, color: [252, 248, 240] },
    { left: 40, right: 62, top: 92, bottom: 104, color: [16, 84, 120] },
    { left: 6, right: 58, top: 150, bottom: 160, color: [230, 90, 40] },
  ];
  const overlay = (image, rect) => {
    const out = { ...image, data: new Uint8ClampedArray(image.data) };
    for (let y = rect.top; y < rect.bottom; y++) {
      for (let x = rect.left; x < rect.right; x++) out.data.set([rect.color[0], rect.color[1], rect.color[2], 255], (y * image.width + x) * 4);
    }
    return out;
  };
  const base = createScene({ offsets: Array.from({ length: 40 }, (_, index) => index * 8) });
  const frames = base.frames.map(frame => rects.reduce((out, rect) => overlay(out, rect), frame.image));
  const normal = runAt(frames, null);
  const total = finishReads(frames);
  assert.ok(total >= 3, `收尾读取次数太少，无法定位阶段：${total}`);
  const stages = new Set();
  for (let limit = 1; limit <= total; limit += 1) {
    const row = runAt(frames, limit);
    if (row.error) {
      assert.equal(row.error.code, 'analysis-budget');
      assert.notEqual(row.error.stage, 'background-extend', 'background-extend 不得再走整场失败');
      stages.add(row.error.stage);
      continue;
    }
    if (isFallback(row.output)) continue;
    // 没耗尽预算：必须与正常完成一致，不能被退让逻辑连带改写。
    assertSamePixels(row.output.data, normal.output.data, `limit=${limit} 未耗尽却改了像素`);
    assert.equal(row.output.complete, normal.output.complete);
  }
  assert.ok(stages.size > 0, `扫描必须覆盖至少一个非延展阶段的耗尽：total=${total}`);
  assert.ok(stages.has('mark-repair') || stages.has('repair-copy'), `必须确认修补阶段仍抛错：${[...stages].join(',')}`);
});

test('实验性修补提示与超时提示同时存在时互不吞掉，且顺序固定', () => {
  // 复用生产实测里“球固定屏幕 + 左侧平滑带”的构造：旧环规则失配，但文档环能补，会真的写实验修补像素。
  const base = createScene({ top: 0, bottom: 0, ball: 'screen', ballRadius: 6, offsets: [0, 32, 64, 96, 128] });
  const frames = base.frames.map(frame => {
    const data = new Uint8ClampedArray(frame.image.data);
    for (let y = 0; y < frame.image.height; y++) {
      const value = Math.max(0, Math.min(255, 60 + .6 * y));
      for (let x = 0; x < 4; x++) { const index = (y * frame.image.width + x) * 4; data[index] = data[index + 1] = data[index + 2] = value; data[index + 3] = 255; }
    }
    return { data, width: frame.image.width, height: frame.image.height };
  });
  const repaired = runAt(frames, null, { repairDocumentRing: true });
  assert.ok(repaired.output.documentRepairCopies > 0, `场景必须先真的触发实验修补：${JSON.stringify(repaired.output.missingRanges?.length)}`);
  assert.match(repaired.output.warning, /实验性修补/);
  const total = finishReads(frames, { repairDocumentRing: true });
  let fallback = null;
  for (let limit = 1; limit <= total && !fallback; limit += 1) {
    const row = runAt(frames, limit, { repairDocumentRing: true });
    if (isFallback(row.output)) fallback = row.output;
  }
  assert.ok(fallback, '同一场景必须能命中延展退让');
  const warning = fallback.warning;
  const repairAt = warning.indexOf(REPAIR_TEXT), fallbackAt = warning.indexOf(FALLBACK_TEXT);
  assert.ok(repairAt >= 0, `实验修补警告不能被超时提示吞掉：${warning}`);
  assert.ok(fallbackAt > repairAt, `实验修补提示必须排在超时提示前：${warning}`);
  assert.equal(fallback.complete, false, '实验像素 + 未延展不得宣称完整');
  assert.ok(warning.slice(0, 120).includes('已保留未延展的拼接图'), 'renderer 截取的前 120 字必须保留关键结论');
  assert.ok(warning.slice(0, 120).includes('未核实区域'), 'renderer 截取的前 120 字必须保留风险提示');
});

// 真实 Node Worker：生产模块载入后，确定性触发 background-extend 耗尽，验证 done/partial 而不是 error。
// 时钟在 init/frame 阶段不耗尽，收到 finish 才开始计时，扫描范围只对应收尾阶段。
test('真实 Worker：延展超时回 done + 未延展像素，不回 error', async () => {
  const scene = build({ width: 240, bodyHeight: 180, offsets: [0, 40, 80, 120, 160], bands: 20, seed: 223 });
  const url = new URL('../renderer/scroll-match-worker.mjs', import.meta.url).href;
  const normal = runAt(scene.frames, null);
  assert.ok(normal.output.background?.active, '参照运行必须先真的延展');

  function channel(worker) {
    const waiting = [];
    worker.on('message', value => { if (value?.type === 'evidence-invalidated') return; waiting.shift()?.(value); });
    return packet => new Promise(resolve => { waiting.push(resolve); worker.postMessage(packet, packet.image ? [packet.image.data.buffer] : []); });
  }
  let seen = 0;
  for (let limit = 1; limit <= 60 && !seen; limit += 1) {
    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(`
 import {parentPort} from 'node:worker_threads';
 let armed = false, reads = 0;
 performance.now = () => { if (!armed) return 0; reads += 1; return reads > ${limit} ? 1e6 * reads : 0; };
 globalThis.self = { postMessage: (packet, transfer) => parentPort.postMessage(packet, transfer) };
 await import(${JSON.stringify(url)});
 parentPort.on('message', data => { if (data.type === 'finish') armed = true; self.onmessage({ data }); });`)), { type: 'module' });
    try {
      const send = channel(worker);
      const ready = await send({ type: 'init', image: structuredClone(scene.frames[0]) });
      assert.equal(ready.type, 'ready');
      for (let index = 1; index < scene.frames.length; index += 1) {
        const packet = await send({ type: 'frame', id: index, image: structuredClone(scene.frames[index]), atMs: index * 50 });
        assert.notEqual(packet.type, 'error', `帧处理不应失败：${packet.message}`);
      }
      const done = await send({ type: 'finish' });
      if (done.type !== 'done') { assert.notEqual(done.type, 'error', '延展超时不得回 error'); continue; }
      if (!isFallback(done.output)) continue;
      seen = 1;
      assert.equal(done.output.complete, false);
      // 退让发生在 finish() 内部：done 包必须带上这两个整数，不能是 finish 之前的 0。
      assert.equal(done.backgroundExtensionFallbacks, 1, `退让必须计入 done：${done.backgroundExtensionFallbacks}`);
      assert.equal(done.backgroundExtendCalls, 1, `退让也必须计到延展阶段调用：${done.backgroundExtendCalls}`);
      assert.deepEqual(done.output.background, { active: false, rows: 0, pixels: 0 });
      // 回包像素必须等于同一场景的“未延展”参照（入口耗尽）。
      const entry = runAt(scene.frames, 1);
      assertSamePixels(done.output.data, entry.output.data, 'Worker 回包像素必须等于未延展参照');
    } finally {
      await worker.terminate();
    }
  }
  assert.equal(seen, 1, '真实 Worker 至少要命中一次延展超时并回 done');
});
