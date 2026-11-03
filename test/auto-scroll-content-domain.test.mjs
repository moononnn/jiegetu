// 窄内容域核验：720×900、平坦背景 + 150px 内容（按相对 x 生成），内容只占全宽四分桶的一格。
// 正例要求整条会话跑通并与连续自有文档整幅逐字节相同；负例只要求不新增行、不冒充完整。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoScrollSession } from '../core/auto-scroll-session.mjs';
import { firstDifference } from './fixtures/auto-scenes.mjs';

const W = 720, H = 900, FLAT = 214;
const NARROW = 150, NARROW_LEFT = 20;

function contentPixel(docRow, relX) {
  // 只按相对内容左边缘的 x 生成：内容平移不改变它的样子，采样相位才有意义。
  let h = Math.imul(docRow + 11, 0x9e3779b1) ^ Math.imul(relX + 7, 0x85ebca6b);
  h ^= h >>> 15; h = Math.imul(h, 0x2545f491); h ^= h >>> 13;
  return 25 + ((h >>> 3) % 210);
}
function page(top, rows = H, { left = NARROW_LEFT, width = NARROW, period = 0 } = {}) {
  const data = new Uint8ClampedArray(W * rows * 4);
  for (let y = 0; y < rows; y++) {
    const docRow = top + y;
    const key = period ? docRow % period : docRow;
    for (let x = 0; x < W; x++) {
      const value = x >= left && x < left + width ? contentPixel(key, x - left) : FLAT;
      const p = (y * W + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = value; data[p + 3] = 255;
    }
  }
  return { width: W, height: rows, data };
}
const frameAt = (offset, options) => page(offset, H, options);

function run(images) {
  const session = createAutoScrollSession(images[0]);
  const updates = images.map((image, index) => session.accept(image, (index + 1) * 50));
  const output = session.finish();
  return { session, updates, output };
}
function assertExact(images, height, options, label, { narrow = true } = {}) {
  const { session, updates, output } = run(images);
  try {
    assert.equal(output.complete, true, `${label}: ${output.warning}`);
    assert.deepEqual(output.missingRanges, [], label);
    assert.equal(output.height, H + height, label);
    assert.equal(firstDifference(output, page(0, H + height, options)), null, `${label}: 必须与连续文档整幅逐字节相同`);
    const proofs = updates.filter(update => Number.isFinite(update.autoEvidence.motionCoverage));
    assert.ok(proofs.length > 0, `${label}: 必须有帧经过原帧核验`);
    assert.ok(proofs.every(update => update.autoEvidence.motionProofVersion === 2), label);
    const domainUpdates = updates.filter(update => update.autoEvidence.motionDomainUsed === true);
    if (narrow) {
      assert.ok(domainUpdates.length > 0, `${label}: 必须有帧经窄内容域放行`);
      assert.ok(domainUpdates.every(update => update.autoEvidence.motionDomainWidth >= 96), label);
      assert.ok(updates.some(update => update.autoEvidence.motionDomainBuild === true), `${label}: 建窗用的是窄域`);
    } else {
      assert.equal(domainUpdates.length, 0, `${label}: 跨桶内容必须仍走原严格全宽路径`);
      assert.equal(updates.some(update => update.autoEvidence.motionDomainBuild === true), false, label);
    }
  } finally { session.clear(); }
}
function assertRefused(images, label) {
  const { session, updates, output } = run(images);
  try {
    for (const update of updates) assert.equal(update.added, 0, `${label}: ${update.result.kind} 不得新增行`);
    assert.equal(output.complete, false, label);
    assert.ok(output.height <= H, `${label}: 高度 ${output.height} 不得超出首屏`);
    assert.equal(updates.some(update => update.autoEvidence.motionDomainUsed === true), false, `${label}: 不得启用窄内容域`);
  } finally { session.clear(); }
}

// ---------------------------------------------------------------- 正例

for (const left of [20, 140, 200]) {
  test(`窄内容域：150px 内容 left=${left} 建窗后接长并折返，整幅逐字节一致`, () => {
    const offsets = [0, 40, 80, 240, 120, 320];
    // left=140 跨 180px 桶边界：应当仍由原严格全宽路径通过（窄域例外不必介入）。
    assertExact(offsets.map(offset => frameAt(offset, { left })), 320, { left }, `left=${left}`, { narrow: left !== 140 });
  });
}

test('窄内容域：240px 等速内容大步滚动仍整幅一致', () => {
  const options = { left: 20, width: 240 };
  const offsets = [0, 60, 120, 300];
  assertExact(offsets.map(offset => frameAt(offset, options)), 300, options, '240px', { narrow: false });
});

// ---------------------------------------------------------------- 负例

test('负例：24px 全高细条落在单个全宽桶，不因窄域例外接长', () => {
  const options = { left: 20, width: 24 };
  assertRefused([0, 40, 80, 240].map(offset => frameAt(offset, options)), '24px');
});

test('负例：150px 仅小角动画不得启用窄域例外', () => {
  const base = frameAt(0);
  const blip = index => {
    const data = new Uint8ClampedArray(base.data);
    for (let y = 10; y < 90; y++) for (let x = 20; x < 170; x++) {
      const v = (Math.imul(x + index * 31, 17389) ^ Math.imul(y + 7, 31337)) >>> 8 & 255;
      data.set([v, v, v, 255], (y * W + x) * 4);
    }
    return { width: W, height: H, data };
  };
  assertRefused([blip(1), blip(2), blip(3)], '角落动画');
});

test('负例：两处异速滚动（域外真实冲突）不得接长', () => {
  // 左 150px 按 1 倍速、右 150px（桶 3）按 2 倍速：单一位移无法同时对齐。
  const twoWindow = offset => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let value = FLAT;
      if (x >= 20 && x < 170) value = contentPixel(offset + y, x - 20);
      else if (x >= 560 && x < 710) value = contentPixel(offset * 2 + y + 5000, x - 560);
      const p = (y * W + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = value; data[p + 3] = 255;
    }
    return { width: W, height: H, data };
  };
  assertRefused([0, 40, 80, 120].map(twoWindow), '两处异速');
});

test('负例：纯周期内容仍拒，不拿重复段落冒充位移', () => {
  const options = { left: 20, period: 12 };
  assertRefused([0, 40, 80, 160].map(offset => frameAt(offset, options)), '纯周期');
});

test('负例：只有两个位置不得建窗，只保留首屏', () => {
  const { session, output } = run([0, 40].map(offset => frameAt(offset)));
  try {
    assert.equal(output.complete, false);
    assert.equal(output.height, H);
    assert.match(String(output.warning), /小幅滚动/);
  } finally { session.clear(); }
});

test('负例：大跨度缺重叠不得硬接', () => {
  const { session, output } = run([0, 40, 80, 1200].map(offset => frameAt(offset)));
  try {
    assert.equal(output.complete, false);
    assert.ok(output.height <= H + 80, `高度 ${output.height} 不应越过已确认进度`);
  } finally { session.clear(); }
});

test('负例：窄正文旁贴 40px 异速纹理，域连成一片也不得靠裁域通过', () => {
  // 正文 [20,170) 走 1 倍速，紧贴着的 40px 纹理 [170,210) 走 2 倍速：变化域会连成 [20,210) 一整段。
  const adjacent = offset => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let value = FLAT;
      if (x >= 20 && x < 170) value = contentPixel(offset + y, x - 20);
      else if (x >= 170 && x < 210) value = contentPixel(offset * 2 + y + 9000, x - 170);
      const p = (y * W + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = value; data[p + 3] = 255;
    }
    return { width: W, height: H, data };
  };
  assertRefused([0, 40, 80, 120].map(adjacent), '旁贴异速纹理');
});

test('负例：正文顶部同列小角动画，不借窄域裁掉冲突后通过', () => {
  // 动画带 [20,170)×[0,80) 屏幕固定且每帧变：它落在正文同一列域里，只能靠全图 conflicts 拦住。
  const blip = index => {
    const base = frameAt(index * 40);
    const data = new Uint8ClampedArray(base.data);
    for (let y = 0; y < 80; y++) for (let x = 20; x < 170; x++) {
      const v = (Math.imul(x + index * 31, 17389) ^ Math.imul(y + 7, 31337)) >>> 8 & 255;
      data.set([v, v, v, 255], (y * W + x) * 4);
    }
    return { width: W, height: H, data };
  };
  assertRefused([0, 1, 2, 3].map(blip), '同列小角动画');
});

test('负例：建窗后完全切换到另一窄窗（交集为 0）拒绝', () => {
  // 左侧 150px（桶 0）建窗后换成右侧 150px（桶 3）：两域不相交，冻结的历史域不得跟着换。
  const shifted = (leftOffset, rightOffset) => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let value = FLAT;
      if (x >= 20 && x < 170) value = contentPixel(leftOffset + y, x - 20);
      else if (x >= 560 && x < 710) value = contentPixel(rightOffset + y + 5000, x - 560);
      const p = (y * W + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = value; data[p + 3] = 255;
    }
    return { width: W, height: H, data };
  };
  const images = [shifted(0, 0), shifted(40, 0), shifted(80, 0), shifted(80, 40), shifted(80, 80), shifted(80, 160)];
  const { session, updates, output } = run(images);
  try {
    assert.equal(output.complete, false);
    const late = updates.slice(3);
    for (const update of late) {
      assert.equal(update.added, 0, `${update.result.kind}: 域外的新窄窗不得接长`);
      assert.notEqual(update.autoEvidence.motionDomainUsed, true);
    }
    assert.equal(late.some(update => update.result.kind === 'forward' && update.added > 0), false);
    assert.ok(output.height <= H + 80, `高度 ${output.height}`);
  } finally { session.clear(); }
});
test('负例：建窗后内容窗换了（左停右动），窄域不得切到另一个窗', () => {
  // 建窗期：左 150px 滚动、右侧 150px（桶 3）是屏幕静止纹理；建窗后左侧停住、右侧开始滚动。
  const mixed = (leftOffset, rightOffset) => {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let value = FLAT;
      if (x >= 20 && x < 170) value = contentPixel(leftOffset + y, x - 20);
      else if (x >= 560 && x < 710) value = contentPixel(rightOffset + y, x - 560);
      const p = (y * W + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = value; data[p + 3] = 255;
    }
    return { width: W, height: H, data };
  };
  const images = [mixed(0, 0), mixed(40, 0), mixed(80, 0), mixed(80, 40), mixed(80, 80)];
  const { session, updates, output } = run(images);
  try {
    assert.equal(output.complete, false, '换了滚动窗不得声称完整');
    for (const update of updates.slice(3)) {
      assert.equal(update.added, 0, `${update.result.kind}: 历史域之外的新窗不得借窄域例外接长`);
      assert.notEqual(update.autoEvidence.motionDomainUsed, true, '窄域不得切到右侧新窗');
    }
    assert.ok(output.height <= H + 80, `高度 ${output.height} 不得越过建窗期的确认进度`);
  } finally { session.clear(); }
});
