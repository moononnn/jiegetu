'use strict';
// 分段导出的纯数学：段边界、重叠、尾段贴底、窄图收窄、上限与命名。
// 不碰像素与文件系统；真实 PNG 解码与逐像素比较在离屏 Electron 验收里做。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plan, fileName, DEFAULT_SEGMENT_HEIGHT, MAX_SEGMENTS } = require('../core/segment-export.js');

const coveredRows = result => {
  const rows = new Set();
  for (const segment of result.segments) for (let y = segment.top; y < segment.top + segment.height; y++) rows.add(y);
  return rows;
};

test('小图只有一段：原样一张，不硬切', () => {
  const result = plan(600, 900);
  assert.equal(result.segments.length, 1);
  assert.deepEqual(result.segments[0], { index: 0, top: 0, height: 900 });
  assert.equal(result.segmentHeight, 1200, '窄图按 2× 图宽收窄');
});

test('精确边界：等于段高只有一段，多 1 像素才两段', () => {
  const exact = plan(2000, 2400);
  assert.equal(exact.segments.length, 1);
  const over = plan(2000, 2401);
  assert.equal(over.segments.length, 2);
  assert.equal(over.segments[1].top, 2400 - over.overlap, '第二段仍按固定步长开始，重叠恰好是声明值');
  assert.equal(over.segments[1].height, over.overlap + 1, '末段只补到图底');
  assert.equal(over.segments[1].top + over.segments[1].height, 2401);
});

test('长图分段覆盖每一行，只允许相邻重叠、不允许缺口或重复整段', () => {
  const height = 11275, width = 2119;
  const result = plan(width, height);
  assert.ok(result.segments.length > 1);
  const rows = coveredRows(result);
  assert.equal(rows.size, height, '每一行都要被至少一段覆盖');
  assert.deepEqual([...rows].sort((a, b) => a - b), Array.from({ length: height }, (_, i) => i));
  let previous = null;
  for (const segment of result.segments) {
    assert.ok(Number.isInteger(segment.top) && segment.top >= 0);
    assert.ok(segment.top + segment.height <= height);
    assert.ok(segment.height >= 1 && segment.height <= result.segmentHeight, '前段满高、末段可矮，但不能超过段高');
    if (previous) {
      assert.ok(segment.top > previous.top, '段起点必须严格递增');
      const overlapRows = previous.top + previous.height - segment.top;
      assert.equal(overlapRows, result.overlap, '每一处相邻重叠都等于声明值');
      assert.ok(overlapRows < segment.height, '不得重复整段前段');
    }
    previous = segment;
  }
  assert.equal(result.segments[0].top, 0);
  assert.equal(previous.top + previous.height, height, '末段必须到图底');
  assert.ok(result.overlap <= Math.floor(result.segmentHeight * 0.1), '重叠不超过段高 10%');
});

test('尾段不会重复输出整张前段：末段起点严格大于倒数第二段', () => {
  for (const height of [2401, 2402, 2500, 4799, 4800, 4801, 5000]) {
    const result = plan(800, height);
    const last = result.segments.at(-1), before = result.segments.at(-2);
    assert.ok(last.top > before.top, `${height}: 末段起点必须更靠下`);
    assert.equal(last.top + last.height, height);
  }
});

test('窄图按 2× 图宽收窄，细长图不会被切成几十片', () => {
  const result = plan(300, 4000);
  assert.equal(result.segmentHeight, 600);
  assert.equal(result.overlap, 60);
  assert.ok(result.segments.length < 10);
  assert.equal(result.segments.at(-1).top + result.segments.at(-1).height, 4000);
});

test('极窄图的段高与步长仍是正整数', () => {
  for (const width of [1, 2, 3, 7]) {
    const result = plan(width, 400);
    assert.ok(result.segmentHeight >= 1);
    assert.ok(result.step >= 1);
    assert.ok(result.overlap <= result.segmentHeight - 1);
    assert.equal(result.segments.at(-1).top + result.segments.at(-1).height, 400);
  }
});

test('段数超过上限时明确报错，不悄悄给出几百个文件', () => {
  const width = 1;
  const result = plan(width, 400);
  assert.ok(result.segments.length <= MAX_SEGMENTS);
  assert.throws(() => plan(1, 20000), /段上限/);
});

test('文件名零填充、按自然顺序，位数跟着总段数走', () => {
  assert.equal(fileName(0, 8), '01.png');
  assert.equal(fileName(7, 8), '08.png');
  assert.equal(fileName(0, 120), '001.png');
  assert.deepEqual(Array.from({ length: 12 }, (_, i) => fileName(i, 12)), ['01.png', '02.png', '03.png', '04.png', '05.png', '06.png', '07.png', '08.png', '09.png', '10.png', '11.png', '12.png']);
  assert.throws(() => fileName(8, 8), /分段序号无效/);
  assert.throws(() => fileName(-1, 8), /分段序号无效/);
});

test('无效输入直接拒绝：零尺寸、非整数、类型不对', () => {
  assert.throws(() => plan(0, 100), /分段尺寸无效/);
  assert.throws(() => plan(100, 0), /分段尺寸无效/);
  assert.throws(() => plan(100.5, 200), /分段尺寸无效/);
  assert.throws(() => plan(100, 200, { segmentHeight: 0 }), /分段高度无效/);
  assert.throws(() => plan(100, 200, { overlap: -1 }), /分段重叠无效/);
  assert.throws(() => plan(40000, 100), /超过限制/);
});
