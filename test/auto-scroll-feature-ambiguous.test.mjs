// 歧义候选恢复：行指纹（48 列）多解、局部特征给出准确位移时，core 必须拿它当候选，
// 但仍由原帧核验/support、首尾闭合、建窗与遮挡学习决定能不能接长。
// 这里只用自有生成像素：不读真实截图，不改共享 fixture，不动旧断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAutoScrollSession } from '../core/auto-scroll-session.mjs';
import { fingerprint, estimateMotion } from '../core/scroll.mjs';
import { estimateFeatureMotion } from '../core/feature-motion.mjs';
import { chatFrame } from './fixtures/chat-background.mjs';
import { createScene, firstDifference, countDifferentPixels } from './fixtures/auto-scenes.mjs';

// 生成器：宽度/高度沿用 thin-strokes 的 343×539。
// 48 列行指纹采样区只随 doc 行按 P=16 周期起伏（行指纹因此天然多解）；
// 细笔画写在采样盲区里的真实 doc 行上，不随 P 重复，是唯一的真位移证据。
const W = 343, H = 539, P = 16, STEP = 98;
const sampled = Array.from({ length: 48 }, (_, c) => Math.min(W - 1, Math.floor(W * (.06 + .88 * (c + .5) / 48))));
const blind = new Set();
for (const x of sampled) for (let d = -2; d <= 2; d++) blind.add(x + d);
const strokes = new Set();
for (let x = 26; x < W * .97 - 2; x += 4) if (!blind.has(x)) strokes.add(x);

function page(top, rows = H, bump = null) {
  const data = new Uint8ClampedArray(W * rows * 4);
  for (let y = 0; y < rows; y++) {
    const doc = top + y, base = (doc % P) < P / 2 ? 190 : 204;
    for (let x = 0; x < W; x++) {
      let value;
      if (strokes.has(x)) {
        let z = Math.imul(doc + 119, 0x9e3779b1) ^ Math.imul(x + 13, 0x85ebca6b);
        z ^= z >>> 16; z = Math.imul(z, 0x7feb352d); z ^= z >>> 15;
        value = (z & 1) ? 35 : 245;
      } else value = base + (((x >> 4) & 1) ? 14 : 0);
      if (bump && bump(x)) value = Math.min(255, value + 40);
      const p = (y * W + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = value; data[p + 3] = 255;
    }
  }
  return { width: W, height: rows, data };
}
const frameAt = offset => page(offset);

function feed(offsets) {
  const frames = offsets.map(offset => ({ offset, image: frameAt(offset) }));
  const session = createAutoScrollSession(frames[0].image);
  const updates = frames.map((item, index) => session.accept(item.image, (index + 1) * 50));
  return { session, frames, updates, output: session.finish() };
}

// ---------------------------------------------------------------- 前提：行指纹多解、特征准确

test('前提：连续文档上 48 列行指纹判歧义，特征给出准确位移', () => {
  const a = frameAt(0), b = frameAt(STEP);
  const rows = estimateMotion(fingerprint(a), fingerprint(b));
  assert.equal(rows.kind, 'ambiguous', '48 列采样区按 P=16 周期起伏，行指纹必须多解');
  const feature = estimateFeatureMotion(a, b);
  assert.equal(feature.kind, 'motion', JSON.stringify(feature));
  assert.equal(feature.shift, STEP, '笔画只在真实位移上重合');
  assert.deepEqual(feature.nearTies, [STEP], '特征自身不得近并列');
  // 真值自证：b 的正文就是 a 的正文整体上移 STEP 行
  for (let y = 0; y + STEP < H; y += 7) for (let x = 0; x < W; x += 13) {
    const i = (y * W + x) * 4, j = ((y + STEP) * W + x) * 4;
    assert.equal(b.data[i], a.data[j], `像素真值不符 x=${x} y=${y}`);
  }
});

// ---------------------------------------------------------------- 正例：歧义候选经原帧核验接长

test('歧义候选：特征补上位移后按连续文档逐字节接长，折返不改动已存像素', () => {
  // 前进 0→98→196→260，再折返 196、130；末图高度必须是 539 + 260。
  const offsets = [0, STEP, 196, 260, 196, 130];
  const { session, updates, output } = feed(offsets);
  try {
    // 候选来自特征：第一条位移帧的候选阶段必须是 features，并且确实走了原帧核验
    assert.equal(updates[1].autoEvidence.analysisStage, 'collecting', JSON.stringify(updates[1].autoEvidence));
    assert.equal(updates[1].result.kind, 'learning');
    assert.equal(updates[1].autoEvidence.motionMethod, 'features', '歧义帧必须尝试辅助候选');
    assert.ok(updates[1].autoEvidence.motionCoverage >= .85, `原帧核验覆盖率不足：${updates[1].autoEvidence.motionCoverage}`);
    assert.deepEqual(updates.map(update => update.result.kind), ['learning', 'learning', 'forward', 'forward', 'reverse', 'reverse']);

    assert.equal(output.complete, true, output.warning);
    assert.deepEqual(output.missingRanges, []);
    assert.equal(output.height, H + 260, '末图高度必须是 539 + 260');
    // 连续文档生成器给出整幅期望：逐字节相等即同时证明没改像素、没重复、没丢行。
    const expected = page(0, H + 260);
    assert.equal(firstDifference(output, expected), null, '整幅必须逐字节等于连续文档');
    assert.equal(countDifferentPixels(output, expected), 0);
  } finally { session.clear(); }
});

// ---------------------------------------------------------------- 负例

test('负例：特征自身也歧义时仍拒绝，不拿周期内容冒充进度', () => {
  const frames = [0, 108, 216].map(offset => chatFrame(offset, { repeat: true }));
  const rows = estimateMotion(fingerprint(frames[0]), fingerprint(frames[1]));
  const feature = estimateFeatureMotion(frames[0], frames[1]);
  assert.equal(rows.kind, 'ambiguous', JSON.stringify(rows));
  assert.equal(feature.kind, 'ambiguous', '纯周期画面特征必须也给不出唯一位移');
  const session = createAutoScrollSession(frames[0]);
  try {
    const updates = frames.map((image, index) => session.accept(image, (index + 1) * 50));
    for (const update of updates) assert.equal(update.added, 0, `${update.result.kind} 不得新增行`);
    const output = session.finish();
    assert.equal(output.complete, false);
    assert.equal(output.height, frames[0].height);
  } finally { session.clear(); }
});

test('负例：特征位移准确但原帧核验不通过时不得追加（不改原像素门）', () => {
  const a = frameAt(0), b = page(STEP, H, x => strokes.has(x)); // 只在笔画列加亮：行指纹不变，原像素已改
  assert.equal(estimateMotion(fingerprint(a), fingerprint(b)).kind, 'ambiguous', '改的列必须落在行指纹盲区');
  const feature = estimateFeatureMotion(a, b);
  assert.equal(feature.kind, 'motion');
  assert.equal(feature.shift, STEP);
  const session = createAutoScrollSession(a);
  try {
    const update = session.accept(b, 50);
    assert.equal(update.result.kind, 'ambiguous');
    assert.equal(update.added, 0);
    assert.equal(update.autoEvidence.motionMethod, 'features');
    assert.equal(update.autoEvidence.analysisStage, 'pixel-proof');
    assert.ok(update.autoEvidence.motionCoverage < .85, `原帧核验不该通过：${update.autoEvidence.motionCoverage}`);
    const output = session.finish();
    assert.equal(output.complete, false);
    assert.equal(output.height, H);
  } finally { session.clear(); }
});

test('负例：异速多滚动窗不得接长或冒充完整', () => {
  const scene = createScene({ top: 0, bottom: 0, regions: 2, regionSkew: 8 });
  const session = createAutoScrollSession(scene.seedFrame);
  try {
    const updates = scene.frames.map((frame, index) => session.accept(frame.image, (index + 1) * 50));
    for (const update of updates) assert.equal(update.added, 0, `${update.result.kind} 不得新增行`);
    const output = session.finish();
    assert.equal(output.complete, false);
    assert.equal(output.height, scene.height, '异速窗不能拼成单一位移长图');
  } finally { session.clear(); }
});

test('负例：首尾闭合无法确认时不得接长', () => {
  // 逐段 196 都能确认，但首尾跨度 392 超出可比较范围：闭合失败必须停在首屏。
  const { session, updates, output } = feed([0, 196, 392]);
  try {
    assert.equal(updates[2].result.kind, 'ambiguous');
    assert.equal(updates[2].added, 0);
    assert.equal(updates[2].autoEvidence.analysisStage, 'closure', JSON.stringify(updates[2].autoEvidence));
    assert.equal(updates[2].autoEvidence.closureExpected, 392);
    assert.equal(output.complete, false);
    assert.equal(output.height, H);
  } finally { session.clear(); }
});

// ---------------------------------------------------------------- 强冲突守卫

// 生产 motionBetween 没有导出：按 test/mask-presence-cache.test.mjs 的做法读同一份生产源码，
// 只把 scroll/feature 两个依赖换成注入模块后再取出 motionBetween——测的是生产函数本身，不是复制判定。
const sessionUrl = new URL('../core/auto-scroll-session.mjs', import.meta.url);
const realScroll = new URL('../core/scroll.mjs', import.meta.url).href;
const realFeature = new URL('../core/feature-motion.mjs', import.meta.url).href;
// data: URL 自身会嵌到单引号里，所以单引号也要转义，否则注入模块里的 'file://…' 会把字符串截断。
const dataModule = code => 'data:text/javascript,' + encodeURIComponent(code).replace(/'/g, '%27');

async function loadMotionBetween(scrollUrl, featureUrl) {
  let code = fs.readFileSync(sessionUrl, 'utf8');
  assert.ok(code.includes('function motionBetween(a,b,fa,fb){'), '生产 motionBetween 必须仍在原位');
  assert.ok(code.includes("from './scroll.mjs'") && code.includes("from './feature-motion.mjs'"), '两个判定入口必须仍可注入');
  code = code.replace("from './scroll.mjs'", `from '${scrollUrl}'`)
    .replace("from './feature-motion.mjs'", `from '${featureUrl}'`)
    .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, sessionUrl).href}'`);
  return import(dataModule(`${code}\nexport { motionBetween as probeMotionBetween };`));
}

test('强冲突：rows 与前景各自强成立但位移不同时保留 rows 拒绝，不尝试特征候选', async () => {
  // 只换判定入口：estimateMotion 直接给带 conflicting 的歧义，features 一被调用就抛错。
  const conflictScroll = dataModule(`export * from '${realScroll}';\nexport const estimateMotion = () => ({ kind: 'ambiguous', conflicting: true });`);
  const watchedFeature = dataModule(`export const estimateFeatureMotion = () => { globalThis.__featureCalls = (globalThis.__featureCalls ?? 0) + 1; throw new Error('强冲突不得调用特征候选'); };`);
  const { probeMotionBetween } = await loadMotionBetween(conflictScroll, watchedFeature);
  globalThis.__featureCalls = 0;
  const motion = probeMotionBetween({ width: W, height: H }, { width: W, height: H }, {}, {});
  assert.equal(motion.kind, 'ambiguous');
  assert.equal(motion.method, 'rows');
  assert.equal(motion.conflicting, true, '冲突元数据必须保留，供诊断区分这类停留');
  assert.equal(globalThis.__featureCalls, 0, '强冲突时不得调用特征候选');
});

test('普通歧义：不带冲突元数据时仍尝试特征候选（真实模块，无 stub）', async () => {
  const { probeMotionBetween } = await loadMotionBetween(realScroll, realFeature);
  const a = frameAt(0), b = frameAt(STEP), fa = fingerprint(a), fb = fingerprint(b);
  const rows = estimateMotion(fa, fb);
  assert.equal(rows.kind, 'ambiguous');
  assert.equal('conflicting' in rows, false, '只有强冲突才带元数据');
  const motion = probeMotionBetween(a, b, fa, fb);
  assert.equal(motion.method, 'features');
  assert.equal(motion.kind, 'motion');
  assert.equal(motion.shift, STEP);
});

test('已建窗后强冲突仍直接拒绝，不能改问历史原帧来覆盖拒绝', async () => {
  // 注入的只有第一对rows的强冲突；建图/其他候选/support均为真实实现。
  // 测公共session状态机的守卫契约，不冒称真实多窗像素已经复现。
  const watchedScroll = dataModule(`export * from '${realScroll}';
import {estimateMotion as realMotion} from '${realScroll}';
export const estimateMotion = (...args) => {
  if(globalThis.__historyConflict) {
    globalThis.__historyRowCalls++;
    if(globalThis.__historyRowCalls===1)return {kind:'ambiguous',conflicting:true};
  }
  return realMotion(...args);
};`);
  const {createAutoScrollSession: createSession} = await loadMotionBetween(watchedScroll, realFeature);
  const options={fixed:false}, session=createSession(chatFrame(0,options));let clock=0;
  try {
    for(const offset of [0,40,80,240,400,560])session.accept(chatFrame(offset,options),clock+=80);
    const before=session.finish();assert.equal(before.complete,true,before.warning);
    globalThis.__historyConflict=true;globalThis.__historyRowCalls=0;
    const update=session.accept(chatFrame(120,options),clock+=80);
    assert.equal(globalThis.__historyRowCalls,1,'强冲突后不得再询问历史候选');
    assert.equal(update.result.kind,'ambiguous');assert.equal(update.viewport?.matched,false);
    assert.equal(update.autoEvidence.analysisStage,'candidate');
    assert.equal(update.capturedAdded,0);assert.equal(update.recoveredFrames,0);
    assert.equal(update.capturedHeight,before.height);
    const output=session.finish();assert.equal(output.complete,false);
    assert.equal(firstDifference(output,before),null);
  } finally {
    session.clear();delete globalThis.__historyConflict;delete globalThis.__historyRowCalls;
  }
});
