// 未确认区域的坐标：对外必须报最终成图行，不能拿源文档偏移或帧内坐标冒充。
// 这里不读检查点的内部结构：用「成图里那块矩形内是否真的有屏幕固定物像素」证明坐标落点。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoScrollSession } from '../core/auto-scroll-session.mjs';
import { createScene } from './fixtures/auto-scenes.mjs';

const BALL = [250, 40, 120];

function ballPixels(image, rect) {
  let count = 0;
  for (let y = rect.top; y < rect.bottom; y++) {
    for (let x = rect.left; x < rect.right; x++) {
      const i = (y * image.width + x) * 4;
      if (image.data[i] === BALL[0] && image.data[i + 1] === BALL[1] && image.data[i + 2] === BALL[2]) count += 1;
    }
  }
  return count;
}

function runScene(scene) {
  const session = createAutoScrollSession(scene.seedFrame);
  let at = 0;
  for (const frame of scene.frames) session.accept(frame.image, at += 50);
  return session.finish();
}

function assertValidRanges(output) {
  assert.ok(Array.isArray(output.missingRanges));
  for (const rect of output.missingRanges) {
    for (const key of ['top', 'bottom', 'left', 'right']) assert.ok(Number.isInteger(rect[key]), `缺区 ${key} 必须是整数：${JSON.stringify(rect)}`);
    assert.ok(rect.bottom > rect.top && rect.right > rect.left, `缺区必须是正尺寸：${JSON.stringify(rect)}`);
    assert.ok(rect.top >= 0 && rect.bottom <= output.height, `缺区必须落在成图行内：${JSON.stringify(rect)} / 高 ${output.height}`);
    assert.ok(rect.left >= 0 && rect.right <= output.width, `缺区必须落在成图列内：${JSON.stringify(rect)}`);
  }
}

test('固定头 + 多片段：未确认矩形落在成图中真正被遮挡的那些行', () => {
  // 球固定贴在正文底部：后面的接长片段只覆盖屏幕最底下那几行，正好把球的下缘带进成图，
  // 于是缺区既出现在首段也出现在后面的片段上。后面的片段才是 offset 与成图行不同的地方。
  const scene = createScene({ top: 24, bottom: 40, ball: 'screen', ballRadius: 8, ballCenterY: 258, offsets: [0, 2, 4, 6, 8, 10] });
  const output = runScene(scene);
  assert.equal(output.complete, false);
  assert.ok(output.missingRanges.length > 0, '这场必须真的有未确认区域');
  assertValidRanges(output);
  // 每个矩形都必须与遮挡物所在的行相接：坐标若按文档偏移或帧内坐标算，会落到没有球的远处。
  const ballRows = new Set();
  for (let y = 0; y < output.height; y++) {
    for (let x = 0; x < output.width; x++) {
      const i = (y * output.width + x) * 4;
      if (output.data[i] === BALL[0] && output.data[i + 1] === BALL[1] && output.data[i + 2] === BALL[2]) { ballRows.add(y); break; }
    }
  }
  assert.ok(ballRows.size > 0, '成图里必须有遮挡物像素才谈得上定位');
  // 未知区矩形会向外拓 8 像素找完整对象，所以允许矩形边缘离遮挡行最多 8 行；再远就是坐标错了。
  const distance = rect => {
    let best = Infinity;
    for (const row of ballRows) best = Math.min(best, row >= rect.top && row < rect.bottom ? 0 : Math.min(Math.abs(row - rect.top), Math.abs(row - rect.bottom)));
    return best;
  };
  for (const rect of output.missingRanges) {
    assert.ok(distance(rect) <= 8, `矩形 ${JSON.stringify(rect)} 离被遮挡的行太远（${distance(rect)} 行），坐标落点不对`);
  }
  // 反向：成图里的球像素总数应该只出现在未确认矩形覆盖的行里（球从来没被清干净过）。
  let outside = 0;
  for (let y = 0; y < output.height; y++) {
    const row = output.missingRanges.some(rect => y >= rect.top && y < rect.bottom);
    if (row) continue;
    for (let x = 0; x < output.width; x++) {
      const i = (y * output.width + x) * 4;
      if (output.data[i] === BALL[0] && output.data[i + 1] === BALL[1] && output.data[i + 2] === BALL[2]) outside += 1;
    }
  }
  assert.equal(outside, 0, `未确认矩形之外还留着 ${outside} 个遮挡物像素，说明坐标没覆盖到真正的行`);
});

test('向上接长时不拿负的源偏移伪造缺区：干净文档回空数组', () => {
  // 无固定栏的随机文档：先向下接长，再退到起点之前，chunks[0] 是上接长片段（offset 为负）。
  // 没有遮挡证据时，负 offset 不能变成负数或错位的矩形。
  const width = 64, height = 240, pad = 160, rows = 900;
  const data = new Uint8ClampedArray(width * (rows + pad) * 4);
  let state = 9527;
  for (let i = 0; i < data.length; i += 4) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[i] = data[i + 1] = data[i + 2] = state >>> 24; data[i + 3] = 255;
  }
  const view = offset => ({ width, height, data: data.slice((offset + pad) * width * 4, (offset + pad + height) * width * 4) });
  const session = createAutoScrollSession(view(0));
  let at = 0;
  for (const offset of [0, 8, 16, 24, 32, 24, 16, 8, 0, -8]) session.accept(view(offset), at += 50);
  const output = session.finish();
  // 先确认这场真的向上接长过（否则这条用例就没有覆盖到负 offset 的片段）。
  assert.ok(output.height > height, `必须真的接长了：${output.height}`);
  assert.equal(output.complete, true, '干净文档不应有任何未确认区域');
  assert.deepEqual(output.missingRanges, [], '没有遮挡证据就不能因负 offset 造出位置');
});

test('没有遮挡的完整场景：不伪造任何缺区', () => {
  const scene = createScene({ offsets: [0, 16, 32, 48, 64] });
  const output = runScene(scene);
  assert.equal(output.complete, true);
  assert.deepEqual(output.missingRanges, [], '没有证据就不能凭空造位置');
});
