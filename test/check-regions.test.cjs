'use strict';
// 未确认区域的对外收口：只接受成图内的整数正矩形；计数与位置分开对待，不补造位置。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitize, summary, MAX_REGIONS } = require('../core/check-regions.js');

test('来源不是数组时返回 null：代表没有可用元数据，不是零条', () => {
  for (const value of [undefined, null, {}, 'x', 3, { rects: [] }]) assert.equal(sanitize(value, 100, 200), null);
});

test('合法矩形原样保留，计数按真实条数', () => {
  const result = sanitize([{ top: 0, bottom: 10, left: 0, right: 100 }, { top: 190, bottom: 200, left: 5, right: 6 }], 100, 200);
  assert.equal(result.total, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.rects, [{ top: 0, bottom: 10, left: 0, right: 100 }, { top: 190, bottom: 200, left: 5, right: 6 }]);
});

test('零尺寸、负坐标、越界、非整数、非对象一律不收，也不补造', () => {
  const result = sanitize([
    { top: 10, bottom: 10, left: 0, right: 5 },
    { top: 10, bottom: 20, left: 5, right: 5 },
    { top: -1, bottom: 20, left: 0, right: 5 },
    { top: 10, bottom: 20, left: -3, right: 5 },
    { top: 10, bottom: 201, left: 0, right: 5 },
    { top: 10, bottom: 20, left: 0, right: 101 },
    { top: 10.5, bottom: 20, left: 0, right: 5 },
    { top: '10', bottom: 20, left: 0, right: 5 },
    null, 42, { top: 1, bottom: 2 },
    { top: 0, bottom: 1, left: 0, right: 1 }
  ], 100, 200);
  assert.equal(result.total, 12, '计数保留原始条数，不因非法项被改写');
  assert.deepEqual(result.rects, [{ top: 0, bottom: 1, left: 0, right: 1 }]);
});

test(`超过上限时只保留前 ${MAX_REGIONS} 处并标 truncated，计数仍是全部`, () => {
  const many = Array.from({ length: MAX_REGIONS + 5 }, (_, index) => ({ top: index, bottom: index + 1, left: 0, right: 10 }));
  const result = sanitize(many, 20, 400);
  assert.equal(result.total, MAX_REGIONS + 5);
  assert.equal(result.rects.length, MAX_REGIONS);
  assert.equal(result.truncated, true);
});

test('summary 区分有计数但不可定位、被截断与刚好可定位', () => {
  assert.equal(summary(null), null);
  assert.equal(summary({ total: 0, truncated: false, rects: [] }), null);
  const locatable = summary({ total: 3, truncated: false, rects: [{ top: 0, bottom: 1, left: 0, right: 1 }] });
  assert.deepEqual(locatable, { total: 3, locatable: 1, truncated: true });
  const clean = summary(sanitize([{ top: 0, bottom: 1, left: 0, right: 1 }], 10, 10));
  assert.deepEqual(clean, { total: 1, locatable: 1, truncated: false });
});
