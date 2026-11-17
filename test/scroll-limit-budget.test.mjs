import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoScrollSession } from '../core/auto-scroll-session.mjs';
import { compose, MAX_PIXELS, MAX_FRAME_PIXELS, MAX_HEIGHT } from '../core/scroll.mjs';

// 长图总预算与单帧选区预算是两件事：抬长图不等于抬单帧。
// 这里只锁常量与成图边界，不分配近上限的真像素（真实解码/渲染另在 experiments 里做）。
test('长图总预算 32M 与单帧选区 16M 分开锁定，单边仍是 30000', () => {
  assert.equal(MAX_PIXELS, 32_000_000);
  assert.equal(MAX_FRAME_PIXELS, 16_000_000);
  assert.equal(MAX_HEIGHT, 30_000);
  assert.ok(MAX_FRAME_PIXELS < MAX_PIXELS, '单帧额度不能跟着长图预算一起抬');
});

test('合成长图：旧 16M 之上到 32M 可通过，超过 32M 在分配像素前拒绝', () => {
  // 2220 宽正是 auto-longshot-08/09 的真实选区宽；32M/2220 = 14414 行。
  const width = 2220, rows = Math.floor(MAX_PIXELS / width);
  assert.equal(rows, 14414);
  assert.ok(width * rows > MAX_FRAME_PIXELS, '这张长图本身就超过旧的单帧额度');
  // 超 1 行：宽度×高度已越过预算，必须在分配 128MB 缓冲前抛出。
  assert.throws(() => compose([{ height: rows + 1, data: new Uint8ClampedArray(0) }], width), /上限/);
  // 单边上限独立生效：细高图即使像素很少也拒绝。
  assert.throws(() => compose([{ height: MAX_HEIGHT + 1, data: new Uint8ClampedArray(0) }], 16), /上限/);
});

test('自动会话把长图总预算折算成有效高度，供浮条提前提醒使用', () => {
  const width = 1200, height = 800;
  const seed = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const session = createAutoScrollSession(seed);
  try {
    // 32M/1200 = 26666，低于单边 30000：有效上限就是像素预算算出来的那个。
    assert.equal(session.stats().limitHeight, Math.floor(MAX_PIXELS / width));
    assert.ok(session.stats().limitHeight > Math.floor(MAX_FRAME_PIXELS / width), '按新预算折算，不是旧 16M');
  } finally { session.clear(); }
});

test('显式 maxHeight 仍被压低到有效上限，不能靠调用方放宽预算', () => {
  const width = 1200, height = 800;
  const seed = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const session = createAutoScrollSession(seed, { maxHeight: 30_000 });
  try { assert.equal(session.stats().limitHeight, Math.floor(MAX_PIXELS / width)); }
  finally { session.clear(); }
});
