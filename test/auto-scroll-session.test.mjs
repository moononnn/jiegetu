import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene, feedSession, countDifferentPixels, firstDifference, ballCoveredRows,
  WIDTH, BODY_HEIGHT, OFFSETS } from './fixtures/auto-scenes.mjs';
import { createScrollSession } from '../core/scroll-session.mjs';

// The automatic session is being written by the main line; the suite stays runnable before it lands.
let autoModule = null;
let autoLoadError = null;
try { autoModule = await import('../core/auto-scroll-session.mjs'); }
catch (error) { autoLoadError = error; }

const skipAuto = autoModule ? false : 'core/auto-scroll-session.mjs 尚未提供（主线实现中）';

function expectedHeightOf(scene) { return scene.top + scene.documentRows + scene.bottom; }

function composedOf(result) {
  if (!result) return undefined;
  if (result.output && result.output.data) return result.output;
  if (result.data) return result;
  return undefined;
}

function runOld(scene) {
  const session = createScrollSession(scene.seedFrame);
  feedSession(session, scene);
  return session.finish();
}

function runAuto(scene, options = {}) {
  const session = autoModule.createAutoScrollSession(scene.seedFrame, options);
  feedSession(session, scene);
  return session.finish();
}

const scenes = {
  none: createScene({ top: 0, bottom: 0 }),
  top: createScene({ top: 32, bottom: 0 }),
  bottom: createScene({ top: 0, bottom: 48 }),
  both: createScene({ top: 32, bottom: 48 }),
  // Screen-fixed ball, scroll step 16 > ball diameter 12: every document row passes under it once.
  ballScreen: createScene({ top: 0, bottom: 0, ball: 'screen', ballRadius: 6 }),
  // Screen-fixed ball, total scroll 8 < ball diameter 16: the same rows stay covered in every frame.
  ballStuck: createScene({ top: 0, bottom: 0, ball: 'screen', ballRadius: 8, offsets: [0, 2, 4, 6, 8] }),
  periodic: createScene({ top: 0, bottom: 0, periodic: true, periodicPeriod: 24 }),
  multi: createScene({ top: 0, bottom: 0, regions: 2, regionSkew: 8 })
};

// ---------------------------------------------------------------- fixture self-checks

test('fixture: 尺寸与 expected 由文档唯一决定', () => {
  for (const name of ['none', 'top', 'bottom', 'both', 'ballScreen']) {
    const scene = scenes[name];
    assert.equal(scene.seedFrame.width, WIDTH);
    assert.equal(scene.seedFrame.height, scene.top + BODY_HEIGHT + scene.bottom);
    assert.equal(scene.expected.height, expectedHeightOf(scene));
    assert.equal(scene.expected.width, WIDTH);
    assert.equal(scene.expectedHeight, scene.top + scene.documentRows + scene.bottom);
    assert.equal(scene.offsets.length, OFFSETS.length);
  }
});

test('fixture: expected 的顶栏取自种子帧、正文取自文档、底栏取自末帧', () => {
  for (const name of ['none', 'top', 'bottom', 'both']) {
    const scene = scenes[name];
    const expected = scene.expected;
    for (let y = 0; y < scene.top; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const from = (y * WIDTH + x) * 4, to = (y * WIDTH + x) * 4;
        assert.deepEqual(Array.from(expected.data.slice(to, to + 4)), Array.from(scene.seedFrame.data.slice(from, from + 4)), `${name} 顶栏像素`);
      }
    }
    for (let row = 0; row < scene.documentRows; row++) {
      for (let x = 0; x < WIDTH; x++) {
        const from = (row * WIDTH + x) * 4, to = ((scene.top + row) * WIDTH + x) * 4;
        assert.deepEqual(Array.from(expected.data.slice(to, to + 4)), Array.from(scene.document.data.slice(from, from + 4)), `${name} 正文像素`);
      }
    }
    for (let row = 0; row < scene.bottom; row++) {
      for (let x = 0; x < WIDTH; x++) {
        const from = ((scene.height - scene.bottom + row) * WIDTH + x) * 4;
        const to = ((scene.top + scene.documentRows + row) * WIDTH + x) * 4;
        assert.deepEqual(Array.from(expected.data.slice(to, to + 4)), Array.from(scene.lastFrame.data.slice(from, from + 4)), `${name} 底栏像素`);
      }
    }
  }
});

test('fixture: 正文有横向纹理，帧随滚动真的变化', () => {
  const scene = scenes.none;
  for (let index = 1; index < scene.frames.length; index++) {
    assert.ok(countDifferentPixels(scene.frames[0].image, scene.frames[index].image) > 0, `第 ${index} 帧必须与首帧不同`);
  }
  let textured = 0;
  for (let row = 0; row < scene.documentRows; row++) {
    const values = new Set();
    for (let x = 0; x < WIDTH; x++) values.add(scene.document.data[(row * WIDTH + x) * 4]);
    if (values.size > 1) textured++;
  }
  assert.ok(textured > scene.documentRows * 0.8, '多数正文行必须带有横向细节');
});

test('fixture: 步长大于球径时每行正文都有干净来源', () => {
  const scene = scenes.ballScreen;
  const clean = new Uint8Array(scene.documentRows);
  for (const frame of scene.frames) {
    for (let row = 0; row < scene.documentRows; row++) {
      const screenRow = scene.top + row - frame.offset;
      if (screenRow < scene.top || screenRow >= scene.top + BODY_HEIGHT) continue;
      let same = true;
      for (let x = 0; x < WIDTH; x++) {
        const from = (row * WIDTH + x) * 4, to = (screenRow * WIDTH + x) * 4;
        if (frame.image.data[to] !== scene.document.data[from] ||
            frame.image.data[to + 1] !== scene.document.data[from + 1] ||
            frame.image.data[to + 2] !== scene.document.data[from + 2]) { same = false; break; }
      }
      if (same) clean[row] = 1;
    }
  }
  let missing = 0;
  for (let row = 0; row < scene.documentRows; row++) if (!clean[row]) missing++;
  assert.equal(missing, 0, '每一行正文都必须在至少一帧里未被浮球遮挡');
  assert.equal(scene.options.ballRadius * 2 + 1, 13);
  assert.ok(scene.offsets[1] - scene.offsets[0] > scene.options.ballRadius * 2 + 1, '滚动步长必须大于球占的行数');
});

test('fixture: 步长小于球径时同一批正文行始终被遮，手算覆盖成立', () => {
  const scene = scenes.ballStuck;
  const radius = scene.options.ballRadius;
  const span = radius * 2 + 1; // 圆形覆盖的屏幕行数（含首尾两行）
  const totalShift = scene.offsets[scene.offsets.length - 1] - scene.offsets[0];
  assert.ok(totalShift < span, '总位移必须小于球占的行数');
  // 手算：每帧覆盖 [k+offset, k+offset+span)，交集长度 = span - 总位移。
  const intersection = [];
  for (let row = 0; row < scene.documentRows; row++) {
    const coveredEverywhere = scene.frames.every((_, index) => ballCoveredRows(scene, index).includes(row));
    if (coveredEverywhere) intersection.push(row);
  }
  assert.equal(intersection.length, span - totalShift, '始终被遮的行数必须等于球占行数减总位移');
  assert.ok(intersection.length > 0, '必须存在始终被遮的行');
  // 这些行在任何一帧里都没有干净来源：球心列上的像素必须是球的不透明颜色。
  for (const row of intersection) {
    for (const frame of scene.frames) {
      const screenRow = scene.top + row - frame.offset;
      assert.ok(screenRow >= scene.top && screenRow < scene.top + BODY_HEIGHT, '被遮行必须落在正文区');
      const index = (screenRow * WIDTH + scene.options.ballCenterX) * 4;
      assert.deepEqual(Array.from(frame.image.data.slice(index, index + 3)), scene.options.ballColor,
        `第 ${row} 行在第 ${frame.offset} 帧必须被球覆盖`);
    }
  }
});

test('fixture: 周期文档的帧完全相同（歧义前提成立）', () => {
  const scene = createScene({ top: 0, bottom: 0, periodic: true, periodicPeriod: 16 });
  for (let index = 1; index < scene.frames.length; index++) {
    assert.equal(countDifferentPixels(scene.frames[0].image, scene.frames[index].image), 0, '周期相同的两帧必须逐像素一致');
  }
});

test('fixture: 多滚动区没有单一 expected，且同帧相邻两段位移不同', () => {
  const scene = scenes.multi;
  assert.equal(scene.expected, null);
  assert.ok(expectedHeightOf(scene) > 0);
  const regionWidth = Math.floor(WIDTH / scene.options.regions);
  for (const frame of scene.frames) {
    const leftOffset = frame.offset * 1 + scene.options.regionSkew * 0;
    const rightOffset = frame.offset * 2 + scene.options.regionSkew * 1;
    assert.notEqual(leftOffset, rightOffset, '相邻两段的位移必须不同');
    for (let row = 0; row < BODY_HEIGHT; row++) {
      for (let x = 0; x < regionWidth; x++) {
        const leftTo = ((scene.top + row) * WIDTH + x) * 4;
        const leftFrom = ((leftOffset + row) * WIDTH + x) * 4;
        assert.equal(frame.image.data[leftTo], scene.document.data[leftFrom], '左段必须等于文档第一段');
        const rightTo = ((scene.top + row) * WIDTH + regionWidth + x) * 4;
        const rightFrom = ((rightOffset + row) * WIDTH + x) * 4;
        assert.equal(frame.image.data[rightTo], scene.document.data[rightFrom], '右段必须等于文档第二段');
      }
    }
  }
});

// ------------------------------------------- baseline facts of the current createScrollSession

test('基线事实：旧会话在无固定栏与仅顶栏时逐像素正确', () => {
  for (const name of ['none', 'top']) {
    const scene = scenes[name];
    const out = runOld(scene);
    assert.equal(out.height, scene.expected.height, `${name} 输出高度`);
    assert.equal(countDifferentPixels(out, scene.expected), 0, `${name} 必须逐像素一致`);
  }
});

test('基线事实：旧会话遇到固定底栏完全不接长（事实记录，不是断言未来行为）', () => {
  for (const name of ['bottom', 'both']) {
    const scene = scenes[name];
    const out = runOld(scene);
    assert.equal(out.height, scene.height, `${name} 旧会话没有任何新增行`);
    assert.notEqual(out.height, scene.expected.height, `${name} 旧会话与完整长图高度不一致`);
  }
});

test('基线事实：旧会话把屏幕浮球烙进成图（事实记录）', () => {
  for (const name of ['ballScreen', 'ballStuck']) {
    const scene = scenes[name];
    const out = runOld(scene);
    assert.equal(out.height, scene.expected.height, `${name} 高度虽然对上了`);
    assert.ok(countDifferentPixels(out, scene.expected) > 0, `${name} 旧会话成图含有浮球像素`);
  }
});

test('基线事实：旧会话在周期图上不添乱，异速多滚动区上也不接长（事实记录）', () => {
  const periodic = runOld(scenes.periodic);
  assert.equal(periodic.height, scenes.periodic.height, '周期图不得新增行');
  const multi = runOld(scenes.multi);
  assert.equal(multi.height, scenes.multi.height, '异速多滚动区旧会话没有接上任何一行');
});

// ------------------------------------------------------------------ automatic session

test('自动会话：无固定栏时逐像素等于 expected', { skip: skipAuto }, () => {
  const scene = scenes.none;
  const result = runAuto(scene);
  const out = composedOf(result);
  assert.ok(out, 'finish 必须给出合成图像');
  assert.equal(out.height, scene.expected.height);
  assert.equal(firstDifference(out, scene.expected), null);
});

test('自动会话：仅顶栏时逐像素等于 expected', { skip: skipAuto }, () => {
  const scene = scenes.top;
  const out = composedOf(runAuto(scene));
  assert.equal(out.height, scene.expected.height);
  assert.equal(firstDifference(out, scene.expected), null);
});

test('自动会话：仅底栏时逐像素等于 expected', { skip: skipAuto }, () => {
  const scene = scenes.bottom;
  const out = composedOf(runAuto(scene));
  assert.equal(out.height, scene.expected.height);
  assert.equal(firstDifference(out, scene.expected), null);
});

test('自动会话：顶底都有固定栏时逐像素等于 expected', { skip: skipAuto }, () => {
  const scene = scenes.both;
  const out = composedOf(runAuto(scene));
  assert.equal(out.height, scene.expected.height);
  assert.equal(firstDifference(out, scene.expected), null);
});

test('自动会话：中间浮球末帧可补齐首屏与中段', { skip: skipAuto }, () => {
  const scene = scenes.ballScreen;
  const out = composedOf(runAuto(scene));
  assert.equal(out.height, scene.expected.height);
  assert.equal(countDifferentPixels(out, scene.expected), 0, '被遮挡的正文必须用其它帧补齐');
});

test('自动会话：始终遮挡且无干净来源时不得交完整长图', { skip: skipAuto }, () => {
  const scene = scenes.ballStuck;
  const result = runAuto(scene);
  assert.equal(result.complete, false, '没有干净来源时不能声称完整');
  assert.ok(Array.isArray(result.missingRanges) && result.missingRanges.length > 0, '必须报告缺失区间');
  const out = composedOf(result);
  assert.ok(!out || out.height <= scene.expected.height, '不得输出超过完整长图的内容');
});

test('自动会话：歧义周期图不得添出进度', { skip: skipAuto }, () => {
  const scene = createScene({ top: 0, bottom: 0, periodic: true, periodicPeriod: 16 });
  const result = runAuto(scene);
  const out = composedOf(result);
  assert.ok(!out || out.height === scene.height, '周期图不得新增行');
  assert.notEqual(result.complete, true, '周期图不得声称完整');
});

test('自动会话：异速多滚动区应暂停，不得冒充完整长图', { skip: skipAuto }, () => {
  const scene = scenes.multi;
  const result = runAuto(scene);
  const out = composedOf(result);
  assert.notEqual(result.complete, true, '多滚动区不得声称完整');
  assert.ok(!out || out.height < expectedHeightOf(scene), '多滚动区不得输出到完整长图的高度');
});

test('自动会话：模块缺失时整套自动用例明确跳过而不是误判通过', () => {
  if (autoModule) { assert.equal(autoLoadError, null); return; }
  assert.ok(autoLoadError, '未提供模块时必须留下可读的缺失原因');
  assert.match(String(autoLoadError.message || autoLoadError), /auto-scroll-session|Cannot find|ERR_MODULE_NOT_FOUND/i);
});

// ---------------------------------------------------------------- 文档环独立证据观察（只计数，显式开启）

const sameBytesAuto = (a, b) => a.byteLength === b.byteLength && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
// 仅匿名测试显式开启；默认（生产入口）必须完全不跑、也不多字段。
const RING_ON = Object.freeze({ inspectDocumentRing: true });

function runTwice(scene) {
  const withRing = runAuto(scene, RING_ON);
  const withoutRing = runAuto(scene);
  return { withRing, withoutRing };
}

// 不透明非周期正文 + 屏幕固定球（半径 6/中心 20,120）+ 左侧屏幕固定的平滑壁纸带（纵向有变化）。
// 壁纸带落在产品的柔和外侧带里：不成为组件，但旧环规则在文档位移处必然失配。
function softBandedScene(columns = 12, offsets = [0, 32, 64, 96, 128]) {
  const base = createScene({ top: 0, bottom: 0, ball: 'screen', ballRadius: 6, offsets });
  const frames = base.frames.map(frame => {
    const data = new Uint8ClampedArray(frame.image.data);
    for (let y = 0; y < frame.image.height; y++) {
      const value = Math.max(0, Math.min(255, 60 + .6 * y));
      for (let x = 0; x < columns; x++) { const i = (y * frame.image.width + x) * 4; data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255; }
    }
    return { offset: frame.offset, image: { data, width: frame.image.width, height: frame.image.height } };
  });
  return { ...base, frames, seedFrame: frames[0].image };
}

for (const name of ['ballStuck', 'ballScreen', 'periodic']) {
  test(`文档环观察不改输出：${name} 的像素、缺口、complete、checkpoint 与关闭时一致`, { skip: skipAuto }, () => {
    const scene = scenes[name];
    const { withRing, withoutRing } = runTwice(scene);
    assert.equal(withRing.complete, withoutRing.complete, 'complete 不得被旁路观察改变');
    assert.deepEqual(withRing.missingRanges, withoutRing.missingRanges, 'missing 不得被旁路观察改变');
    assert.deepEqual(withRing.warning, withoutRing.warning);
    const a = composedOf(withRing), b = composedOf(withoutRing);
    assert.ok(a && b, '两个会话都要产出成图');
    assert.equal(a.width, b.width); assert.equal(a.height, b.height);
    assert.ok(sameBytesAuto(a.data, b.data), '成图 RGBA 必须逐字节一致');
    assert.equal(typeof withRing.documentRingChecks, 'number');
    assert.equal(typeof withRing.documentRingSupported, 'number');
    assert.equal(typeof withRing.documentRingRefused, 'number');
    assert.equal(withRing.documentRingChecks, withRing.documentRingSupported + withRing.documentRingRefused);
    assert.equal('documentRingChecks' in withoutRing, false, '默认输出不得新增字段');
    assert.equal('documentRingSupported' in withoutRing, false);
  });
}

test('文档环观察默认关闭：生产入口式构造不产生观察，也不多字段', { skip: skipAuto }, () => {
  const scene = softBandedScene(); // 这个场景确实有被拒的掩码，开启时会命中 4 次上限
  const off = runAuto(scene);
  assert.equal('documentRingChecks' in off, false);
  assert.equal('documentRingSupported' in off, false);
  assert.equal('documentRingRefused' in off, false);
  const on = runAuto(scene, RING_ON);
  assert.equal(on.documentRingChecks, 4, '显式开启时上限必须是 4');
  assert.equal(on.documentRingChecks, on.documentRingSupported + on.documentRingRefused);
  assert.equal(on.complete, off.complete, '观察不得把拒绝说成完整');
  assert.deepEqual(on.missingRanges, off.missingRanges, '观察不得吃掉缺口');
});

test('文档环观察：每次 markAndRepair 最多 4 个，不随掩码数无限跑', { skip: skipAuto }, () => {
  for (const name of ['ballScreen', 'periodic', 'multi', 'ballStuck']) {
    const other = runAuto(scenes[name], RING_ON);
    assert.ok(other.documentRingChecks <= 4 * (scenes[name].frames.length + 1), `${name} 超出总上限：${other.documentRingChecks}`);
  }
});

test('文档环观察不改可信检查点：开了与关掉时 checkpoint 逐字节一致', { skip: skipAuto }, () => {
  for (const name of ['ballScreen', 'ballStuck', 'none']) {
    const scene = scenes[name];
    const on = autoModule.createAutoScrollSession(scene.seedFrame, RING_ON); feedSession(on, scene); const withRing = on.checkpoint();
    const off = autoModule.createAutoScrollSession(scene.seedFrame); feedSession(off, scene); const withoutRing = off.checkpoint();
    assert.equal(Boolean(withRing), Boolean(withoutRing), `${name}: 检查点可用性不得被旁路观察改变`);
    if (!withRing) continue;
    assert.equal(withRing.height, withoutRing.height);
    assert.equal(withRing.evidenceRevision, withoutRing.evidenceRevision);
    assert.ok(sameBytesAuto(withRing.data, withoutRing.data), `${name}: 检查点像素必须一致`);
  }
});

test('文档环证据实际链路阳性：旧环规则无干净来源时旁路得到支持，且不改输出', { skip: skipAuto }, () => {
  const scene = softBandedScene();
  const run = options => {
    const session = autoModule.createAutoScrollSession(scene.seedFrame, options);
    let view = null, at = 0;
    for (const frame of scene.frames) { at += 50; view = session.accept(frame.image, at); }
    return { session, view };
  };
  const on = run({ inspectDocumentRing: true }), off = run({});
  const onCheckpoint = on.session.checkpoint(), offCheckpoint = off.session.checkpoint();
  const withRing = on.session.finish(), plain = off.session.finish();
  assert.ok(withRing.documentRingSupported > 0, `实际链路未得到支持：${JSON.stringify({ checks: withRing.documentRingChecks, refused: withRing.documentRingRefused })}`);
  assert.equal(withRing.documentRingChecks, withRing.documentRingSupported + withRing.documentRingRefused);
  assert.equal(withRing.complete, false, '旧环规则必须仍找不到干净来源');
  assert.ok(withRing.missingRanges.length > 0);
  assert.equal(withRing.complete, plain.complete);
  assert.deepEqual(withRing.missingRanges, plain.missingRanges);
  assert.deepEqual(withRing.warning, plain.warning);
  assert.ok(sameBytesAuto(composedOf(withRing).data, composedOf(plain).data), '成图 RGBA 必须与默认一致');
  assert.equal(Boolean(onCheckpoint), Boolean(offCheckpoint));
  if (onCheckpoint) assert.equal(onCheckpoint.height, offCheckpoint.height);
  if (onCheckpoint) assert.ok(sameBytesAuto(onCheckpoint.data, offCheckpoint.data));
  assert.equal(on.view.autoEvidence.maskCount, 1, '浮物掩码必须独立');
  assert.equal(on.view.autoEvidence.rawFrames, 5, '来源不得被淘汰');
  assert.equal('documentRingChecks' in plain, false, '默认输出不新增字段');
});

test('文档环观察：clear 之后不再带出任何记录，新会话从零开始', { skip: skipAuto }, () => {
  const session = autoModule.createAutoScrollSession(scenes.ballStuck.seedFrame, RING_ON);
  feedSession(session, scenes.ballStuck);
  session.clear();
  assert.throws(() => session.finish(), /滚动会话已清除/);
  assert.throws(() => session.checkpoint(), /滚动会话已清除/);
  const fresh = runAuto(scenes.none, RING_ON);
  assert.equal(fresh.documentRingChecks, 0);
  assert.equal(fresh.documentRingSupported, 0);
  assert.equal(fresh.documentRingRefused, 0);
});

// ---------------------------------------------------------------- 实际修补实验（默认关闭）

function runSession(scene, options = {}) {
  const session = autoModule.createAutoScrollSession(scene.seedFrame, options);
  let view = null, at = 0;
  for (const frame of scene.frames) { at += 50; view = session.accept(frame.image, at); }
  const checkpoint = session.checkpoint();
  return { session, view, checkpoint };
}

// 改动的像素必须等于文档真值，且至少两张现存原帧在同一文档坐标上逐字节相同。
function traceChanged(scene, on, off) {
  let changed = 0, traced = 0;
  for (let i = 0; i < on.data.length; i += 4) {
    if (on.data[i] === off.data[i] && on.data[i + 1] === off.data[i + 1] && on.data[i + 2] === off.data[i + 2] && on.data[i + 3] === off.data[i + 3]) continue;
    changed++;
    const pixel = i / 4, y = Math.floor(pixel / on.width), x = pixel % on.width;
    const p = (y * on.width + x) * 4, doc = scene.document.data;
    if (doc[p] !== on.data[i] || doc[p + 1] !== on.data[i + 1] || doc[p + 2] !== on.data[i + 2]) continue;
    const offsets = new Set();
    for (const frame of scene.frames) {
      const fy = y - frame.offset;
      if (fy < 0 || fy >= frame.image.height) continue;
      const q = (fy * scene.width + x) * 4, data = frame.image.data;
      if (data[q] === on.data[i] && data[q + 1] === on.data[i + 1] && data[q + 2] === on.data[i + 2] && data[q + 3] === on.data[i + 3]) offsets.add(frame.offset);
    }
    if (offsets.size >= 2) traced++;
  }
  return { changed, traced };
}

test('实际修补实验：浮物被补齐但本场永不认证（complete=false、checkpoint=null）', { skip: skipAuto }, () => {
  const scene = softBandedScene(4);
  const offRun = runSession(scene);
  const off = offRun.session.finish();
  const onRun = runSession(scene, { repairDocumentRing: true });
  assert.equal(onRun.checkpoint, null, '实际写过像素后不得给检查点');
  const on = onRun.session.finish();
  assert.ok(on.documentRepairCopies > 0, '未得到实际修补');
  assert.ok(on.missingRanges.length < off.missingRanges.length, '缺口必须减少');
  assert.equal(on.complete, false, '实验性修补不得宣称完整');
  assert.match(on.warning, /实验性修补/);
  assert.equal(onRun.session.checkpoint(), null);
  assert.equal('documentRepairCopies' in off, false, '默认输出不新增字段');
  const { changed, traced } = traceChanged(scene, on, off);
  assert.ok(changed > 0);
  assert.equal(traced, changed, `${changed - traced} 个改动像素无法指到两张现存同文档源`);
  // 后续新帧与重复 finish 也不得重新认证。
  onRun.session.accept(scene.frames.at(-1).image, 900);
  assert.equal(onRun.session.checkpoint(), null, '后续新帧不得恢复检查点');
  const again = onRun.session.finish();
  assert.equal(again.complete, false);
  assert.match(again.warning, /实验性修补/);
  assert.equal(onRun.session.checkpoint(), null);
});

test('实际修补实验：没有第二张同文档来源时保持原像素、complete 与警告保守', { skip: skipAuto }, () => {
  const scene = softBandedScene(4, [0, 24, 48]);
  const off = runSession(scene).session.finish();
  const on = runSession(scene, { repairDocumentRing: true }).session.finish();
  assert.equal(on.documentRepairCopies, 0, '只有一张候选来源时不得写');
  assert.deepEqual(on.missingRanges, off.missingRanges);
  assert.equal(on.complete, false);
  assert.deepEqual(on.warning, off.warning);
  assert.ok(sameBytesAuto(on.data, off.data), '证明不足时必须逐字节保留原像素');
});

test('实际修补实验：预算异常正常传出，不静默通过', { skip: skipAuto }, () => {
  const scene = softBandedScene(4);
  let clock = 0;
  assert.throws(() => runSession(scene, { repairDocumentRing: true, analysisBudgetMs: 1, now: () => (clock += 1) }),
    error => error.code === 'analysis-budget');
});
