import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVideoEdit, MAX_CUTS, TIMELINE_CODES } from '../core/video-edit.mjs';

test('全片 no-op 与首尾裁剪，使用源时间半开区间', () => {
  assert.deepEqual(normalizeVideoEdit({ durationMs: 10000 }), { durationMs: 10000, spans: [{ startMs: 0, endMs: 10000 }], totalMs: 10000, noOp: true });
  assert.deepEqual(normalizeVideoEdit({ durationMs: 10000, startMs: 1000, endMs: 9000 }), { durationMs: 10000, spans: [{ startMs: 1000, endMs: 9000 }], totalMs: 8000, noOp: false });
});
test('删一个内部片段，两个范围仍指向原始时间轴', () => {
  const remove = { startMs: 3000, endMs: 5000 };
  assert.deepEqual(normalizeVideoEdit({ durationMs: 10000, startMs: 1000, endMs: 9000, remove }), { durationMs: 10000, spans: [{ startMs: 1000, endMs: 3000 }, { startMs: 5000, endMs: 9000 }], totalMs: 6000, noOp: false });
  assert.deepEqual(remove, { startMs: 3000, endMs: 5000 });
});
test('边界及最短保留时长严格检查，不自动修正', () => {
  assert.equal(normalizeVideoEdit({ durationMs: 2, remove: null }).totalMs, 2);
  assert.equal(normalizeVideoEdit({ durationMs: 3, remove: { startMs: 1, endMs: 2 } }).totalMs, 2);
  assert.throws(() => normalizeVideoEdit({ durationMs: 10, minSpanMs: 4, remove: { startMs: 3, endMs: 6 } }), /太短/);
  for (const remove of [{ startMs: 0, endMs: 4 }, { startMs: 4, endMs: 10 }, { startMs: 5, endMs: 5 }, { startMs: 8, endMs: 3 }, [], {}]) {
    assert.throws(() => normalizeVideoEdit({ durationMs: 10, remove }), /删除范围/);
  }
  for (const [startMs, endMs] of [[-1, 4], [1, 11], [5, 5], [6, 3], [0.1, 5], [0, NaN]]) {
    assert.throws(() => normalizeVideoEdit({ durationMs: 10, startMs, endMs }), /保留范围/);
  }
});
test('时间值需为安全整数；不接受非有限值或字符串', () => {
  for (const durationMs of [0, -1, 1.1, Infinity, NaN, '100', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => normalizeVideoEdit({ durationMs }));
  for (const minSpanMs of [0, -1, 0.5, Infinity, '1']) assert.throws(() => normalizeVideoEdit({ durationMs: 100, minSpanMs }));
  assert.throws(() => normalizeVideoEdit({ durationMs: 100, remove: { startMs: 1.5, endMs: 2 } }));
});

test('多段删除：排序、合并重叠/相邻、夹到保留范围，产出 cuts+1 段', () => {
  const r = normalizeVideoEdit({ durationMs: 10000, startMs: 1000, endMs: 9000, cuts: [{ startMs: 6000, endMs: 7000 }, { startMs: 2000, endMs: 3000 }, { startMs: 2900, endMs: 3200 }, { startMs: 3050, endMs: 3100 }] });
  assert.deepEqual(r.spans, [{ startMs: 1000, endMs: 2000 }, { startMs: 3200, endMs: 6000 }, { startMs: 7000, endMs: 9000 }]);
  assert.equal(r.totalMs, 1000 + 2800 + 2000);
  assert.equal(r.noOp, false);
  // 相邻（1ms 内）也合并
  assert.deepEqual(normalizeVideoEdit({ durationMs: 1000, cuts: [{ startMs: 100, endMs: 200 }, { startMs: 201, endMs: 300 }] }).spans,
    [{ startMs: 0, endMs: 100 }, { startMs: 300, endMs: 1000 }]);
  // 超出保留范围的被夹回去；完全在外面的直接丢掉
  assert.deepEqual(normalizeVideoEdit({ durationMs: 1000, startMs: 100, endMs: 900, cuts: [{ startMs: 0, endMs: 200 }, { startMs: 950, endMs: 1000 }] }).spans,
    [{ startMs: 200, endMs: 900 }]);
  // 空数组等于不删
  assert.equal(normalizeVideoEdit({ durationMs: 1000, cuts: [] }).noOp, true);
});

test('多段删除的边界：超过 24 段、删空、片段太短都给固定代码与中文原因', () => {
  const many = Array.from({ length: MAX_CUTS + 1 }, (_, i) => ({ startMs: i * 200 + 10, endMs: i * 200 + 60 }));
  assert.throws(() => normalizeVideoEdit({ durationMs: 20000, cuts: many }), error => error.code === TIMELINE_CODES.tooManyCuts && /最多删除 24 段/.test(error.message));
  const full = Array.from({ length: MAX_CUTS }, (_, i) => ({ startMs: i * 100 + 20, endMs: i * 100 + 80 }));
  assert.equal(normalizeVideoEdit({ durationMs: MAX_CUTS * 100, cuts: full }).spans.length, MAX_CUTS + 1, '24 刀最多产出 25 段');
  const covers = [{ startMs: 0, endMs: 400 }, { startMs: 300, endMs: 1000 }];
  assert.throws(() => normalizeVideoEdit({ durationMs: 1000, cuts: covers }), error => error.code === TIMELINE_CODES.tooShort && /没有保留任何画面/.test(error.message));
  assert.throws(() => normalizeVideoEdit({ durationMs: 1000, minSpanMs: 50, cuts: [{ startMs: 40, endMs: 900 }] }),
    error => error.code === TIMELINE_CODES.tooShort && /太短/.test(error.message));
  for (const cuts of [[{ startMs: 10, endMs: 10 }], [{ startMs: 30, endMs: 10 }], [null], ['x'], [{}]]) {
    assert.throws(() => normalizeVideoEdit({ durationMs: 1000, cuts }), error => error.code === TIMELINE_CODES.invalid);
  }
  assert.throws(() => normalizeVideoEdit({ durationMs: 1000, cuts: 'x' }), error => error.code === TIMELINE_CODES.invalid);
});

test('旧单段契约与多段契约不能混用，旧契约行为不变', () => {
  const legacy = normalizeVideoEdit({ durationMs: 1000, startMs: 100, endMs: 900, remove: { startMs: 300, endMs: 500 } });
  const modern = normalizeVideoEdit({ durationMs: 1000, startMs: 100, endMs: 900, cuts: [{ startMs: 300, endMs: 500 }] });
  assert.deepEqual(legacy.spans, modern.spans);
  assert.deepEqual(legacy, modern);
  assert.throws(() => normalizeVideoEdit({ durationMs: 1000, remove: { startMs: 300, endMs: 500 }, cuts: [] }),
    error => error.code === TIMELINE_CODES.invalid && /不能同时提交/.test(error.message));
});
