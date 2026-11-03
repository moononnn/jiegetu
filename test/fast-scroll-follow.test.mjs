import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fingerprint, estimateMotion, detectShift } from '../core/scroll.mjs';
import { createAutoScrollSession } from '../core/auto-scroll-session.mjs';
import { createScene } from './fixtures/auto-scenes.mjs';

// 快滚跟随的减负改动必须与基线逐值等价：候选列预计算、行差直方图中位数、body 只读视图与指纹缓存
// 都只是同一个判定的不同实现。基线 core 留在 _backups/快滚跟随-20261026_095328/core；
// 目录被清理时只跳过对照用例，行为用例仍照常执行。
const BASELINE = new URL('../_backups/快滚跟随-20261026_095328/core/scroll.mjs', import.meta.url);
const BASELINE_SESSION = new URL('../_backups/快滚跟随-20261026_095328/core/auto-scroll-session.mjs', import.meta.url);
const hasBaseline = fs.existsSync(BASELINE) && fs.existsSync(BASELINE_SESSION);
const baseline = hasBaseline ? await import(BASELINE.href) : undefined;
const baselineSession = hasBaseline ? await import(BASELINE_SESSION.href) : undefined;

// 64 宽的确定性文档横向平铺到目标宽度，保持 fixture 的逐像素可预测性。
const expand = (image, width) => {
  if (image.width === width) return image;
  const data = new Uint8ClampedArray(width * image.height * 4);
  for (let y = 0; y < image.height; y++) {
    const row = image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4);
    for (let x = 0; x < width; x += image.width) data.set(row.subarray(0, Math.min(image.width, width - x) * 4), (y * width + x) * 4);
  }
  return { width, height: image.height, data };
};
function scene({ width = 64, top = 0, bottom = 0, bodyHeight = 240, offsets = [0, 16, 32, 48, 64], ball = 'none', ballRadius = 6, blocks = [] } = {}) {
  // 原夹具按最后 offset 分配文档；折返时先造足最远位置，再去掉辅助帧。
  const furthest = Math.max(...offsets);
  const sourceOffsets = offsets.at(-1) === furthest ? offsets : [...offsets, furthest];
  const base = createScene({ top, bottom, bodyHeight, offsets: sourceOffsets, ball, ballRadius });
  const paint = image => {
    const out = expand(image, width);
    // 屏幕固定红块：进 components 的见证区域，用于让覆盖位图的 3 个 bit 都真的用上。
    for (const rect of blocks) for (let y = rect.top; y < rect.bottom; y++) for (let x = rect.left; x < rect.right; x++) out.data.set([220, 30, 30, 255], (y * width + x) * 4);
    return out;
  };
  return { ...base,
    seedFrame: paint(base.seedFrame),
    frames: base.frames.slice(0, offsets.length).map(frame => ({ ...frame, image: paint(frame.image) })),
    expected: base.expected ? paint(base.expected) : null };
}
const BLOCK_RECTS = [[24, 60], [140, 90], [260, 130], [60, 220], [200, 260], [320, 320], [120, 400], [280, 470]]
  .map(([left, top]) => ({ left, top, right: left + 40, bottom: top + 32 }));
const signature = update => ({ kind: update.result.kind, shift: update.result.shift, height: update.height,
  capturedHeight: update.capturedHeight, added: update.added, capturedAdded: update.capturedAdded,
  complete: update.complete, viewport: update.viewport ?? null, maskCount: update.autoEvidence.maskCount });
const runSession = (create, built, options = {}) => {
  const session = create(built.seedFrame, options);
  let at = 0;
  const updates = built.frames.map(frame => session.accept(frame.image, at += 50));
  const output = session.finish();
  session.clear();
  return { updates, output };
};

test('位移估计与基线逐值一致：快滚/大步/折返/停住都走同一命中', { skip: !hasBaseline && '基线 core 不在，跳过对照' }, () => {
  const cases = [
    { name: '常规前滚', options: { offsets: [0, 16, 32] }, pair: [0, 1] },
    { name: '快滚大步', options: { offsets: [0, 96, 192] }, pair: [0, 1] },
    { name: '快滚更大步', options: { offsets: [0, 140, 280], bodyHeight: 320 }, pair: [0, 1] },
    { name: '折返回看', options: { offsets: [0, 96, 32] }, pair: [2, 1] },
    { name: '固定栏与小浮物', options: { top: 32, bottom: 48, offsets: [0, 64, 128], ball: 'screen' }, pair: [0, 1] },
    { name: '停住同帧', options: { offsets: [0, 64] }, pair: [1, 1] },
  ];
  for (const item of cases) {
    const built = scene(item.options);
    const [left, right] = item.pair;
    const a = built.frames[left].image, b = built.frames[right].image;
    const fa = fingerprint({ ...a }), fb = fingerprint({ ...b });
    assert.deepEqual(baseline.fingerprint({ ...a }), fa, `${item.name}：指纹本身未变`);
    assert.deepEqual(estimateMotion(fa, fb), baseline.estimateMotion(fa, fb), `${item.name}：estimateMotion 必须与基线逐字段相同`);
    assert.deepEqual(detectShift(fa, fb, {}), baseline.detectShift(fa, fb, {}), `${item.name}：detectShift 必须与基线逐字段相同`);
  }
});

test('同屏位置 detail 低不等于候选没资格：不得把 a.detail[i] 当额外门槛', { skip: !hasBaseline && '基线 core 不在，跳过对照' }, () => {
  const built = scene({ width: 200, bodyHeight: 600, offsets: [0, 120] });
  const a = fingerprint({ ...built.frames[0].image }), b = fingerprint({ ...built.frames[1].image });
  // 只把上半屏 a.detail 压成 0：同屏位置 i 没了 detail，但位移位置 old=y+120 仍在未压区（old>=half）。
  // 原实现只看 a.detail[old]，这些点仍符合候选资格；多一道 a.detail[i]>=12 会错删它们。
  const half = Math.floor(a.height / 2);
  for (let i = 0; i < half * 48; i++) a.detail[i] = 0;
  const now = estimateMotion(a, b), base = baseline.estimateMotion(a, b);
  assert.equal(now.kind, 'motion', '这一点必须能被估值命中');
  assert.equal(now.shift, 120);
  assert.equal(now.foreground, true, '必须仍由前景候选命中，而不是退回逐行 raw 结果');
  assert.deepEqual(now, base, '同屏位置 detail 低的候选必须仍按位移位置的门槛判定，结果与基线相同');
});

test('宽图整条会话与基线逐帧一致（0/1/8 固定物、固定栏、小浮物、折返与停住）', { skip: !hasBaseline && '基线 core 不在，跳过对照' }, () => {
  const cases = [
    { name: '固定栏+小浮物', options: { width: 400, top: 32, bottom: 48, bodyHeight: 700, offsets: [0, 300, 600, 300, 0, 160, 160], ball: 'screen', ballRadius: 7 } },
    { name: '无固定物', options: { width: 400, bodyHeight: 700, offsets: [0, 300, 600, 300, 0, 160, 160] } },
    { name: '1 个固定红块', options: { width: 400, bodyHeight: 700, offsets: [0, 300, 600], blocks: BLOCK_RECTS.slice(0, 1) } },
    { name: '8 个固定红块', options: { width: 400, bodyHeight: 700, offsets: [0, 300, 600], blocks: BLOCK_RECTS } },
  ];
  for (const item of cases) {
    const built = scene(item.options);
    const after = runSession(createAutoScrollSession, built);
    const before = runSession(baselineSession.createAutoScrollSession, built);
    assert.deepEqual(after.updates.map(signature), before.updates.map(signature), `${item.name}：逐帧结论必须与基线相同`);
    assert.equal(after.output.height, before.output.height, `${item.name}：高度`);
    assert.equal(after.output.complete, before.output.complete, `${item.name}：complete`);
    assert.deepEqual(after.output.missingRanges, before.output.missingRanges, `${item.name}：缺口`);
    assert.equal(after.output.data.length, before.output.data.length);
    assert.ok(Buffer.compare(Buffer.from(after.output.data.buffer), Buffer.from(before.output.data.buffer)) === 0, `${item.name}：finish 像素必须逐字节相同`);
  }
});

test('快滚大位移仍然接得准：shift 精确、像素来自原文档、不重复', () => {
  // 单帧内位移必须仍在 65% 重叠上限内：1600 高正文配 300/600 的前滚就是很快的滑动了。
  const built = scene({ width: 400, bodyHeight: 1600, offsets: [0, 300, 600] });
  const { updates, output } = runSession(createAutoScrollSession, built);
  assert.equal(updates.at(-1).result.kind, 'forward');
  assert.equal(updates.at(-1).result.shift, 300, '大步前进必须给出真实位移');
  assert.equal(output.height, built.height + 600);
  assert.equal(output.complete, true, output.warning);
  assert.ok(Buffer.compare(Buffer.from(output.data.buffer), Buffer.from(built.expected.data.buffer)) === 0, '输出必须是原文档像素');
});

test('超过重叠上限的大步不猜位移：明确 unmatched，不增长高度', () => {
  const built = scene({ width: 200, bodyHeight: 240, offsets: [0, 200] });
  const session = createAutoScrollSession(built.seedFrame);
  session.accept(built.frames[0].image, 50);
  // 240 高的帧位移上限是 65%（156）；200 已越界，不能凭猜测追加。
  const update = session.accept(built.frames[1].image, 100);
  assert.equal(update.result.kind, 'unmatched');
  assert.equal(update.added, 0);
  assert.equal(update.complete, false);
  const output = session.finish();
  assert.equal(output.height, built.height, '没有可靠对齐就不能变高');
  session.clear();
});

test('停住与折返回看：不重复接入，高度不丢，已接的正文仍是原像素', () => {
  const built = scene({ width: 300, bodyHeight: 600, offsets: [0, 160, 320, 160, 0] });
  const { updates, output } = runSession(createAutoScrollSession, built);
  assert.deepEqual(updates.map(update => update.result.kind), ['learning', 'learning', 'forward', 'reverse', 'reverse']);
  // 回看帧只确认位置，不新增片段也不改变高度。
  assert.equal(updates[3].height, updates[2].height);
  assert.equal(updates[4].height, updates[2].height);
  assert.equal(updates[4].chunks, updates[2].chunks);
  assert.equal(output.height, built.height + 320, '折返不能把高度算丢，也不能重复追加');
  assert.equal(output.complete, true, output.warning);
  assert.equal(output.height, built.expected.height);
  assert.deepEqual(output.data, built.expected.data, '折返后整张图必须与最远已覆盖原文逐字节相同，不只核验首屏');
});

test('同一帧重复（停住）不改变高度，也不产生新片段', () => {
  const built = scene({ width: 300, bodyHeight: 600, offsets: [0, 160, 320] });
  const session = createAutoScrollSession(built.seedFrame);
  let at = 0;
  for (const frame of built.frames) session.accept(frame.image, at += 50);
  const before = session.stats();
  const still = session.accept(built.frames.at(-1).image, at += 50);
  assert.equal(still.result.kind, 'still');
  assert.equal(still.added, 0);
  assert.equal(still.height, before.height);
  assert.equal(still.chunks, before.chunks);
  session.clear();
});
