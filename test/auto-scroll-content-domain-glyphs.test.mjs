// 匿名字形稀疏消息，不使用真实聊天截图；检验随机纹理正例之外的内容域。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoScrollSession } from '../core/auto-scroll-session.mjs';
import { chatFrame } from './fixtures/chat-background.mjs';
import { firstDifference } from './fixtures/auto-scenes.mjs';

const WIDTH = 720, HEIGHT = 900, CONTENT_WIDTH = 150;
const offsets = [0, 40, 80, 240, 120, 320];
function glyphFrame(offset, left, height = HEIGHT) {
  const glyphs = chatFrame(offset, { width: CONTENT_WIDTH, height, fixed: true });
  const data = new Uint8ClampedArray(WIDTH * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < WIDTH; x++) {
    // 仅保留已有匿名生成器的笔画，移除纸纹与气泡底色，使期望长图完全可知。
    const localX = x - left;
    const value = localX >= 0 && localX < CONTENT_WIDTH && glyphs.data[(y * CONTENT_WIDTH + localX) * 4] < 45 ? 35 : 230;
    const p = (y * WIDTH + x) * 4;
    data[p] = data[p + 1] = data[p + 2] = value; data[p + 3] = 255;
  }
  return { width: WIDTH, height, data };
}
for (const left of [20, 140, 200]) test(`稀疏字形窄消息跨桶位置不改变接长/折返，left=${left}`, () => {
  const frames = offsets.map(offset => glyphFrame(offset, left));
  const originals = frames.map(frame => Buffer.from(frame.data));
  const session = createAutoScrollSession(frames[0]);
  try {
    const updates = frames.map((image, index) => session.accept(image, index * 100));
    assert.equal(updates[1].capturedAdded, 0, '两个位置不能提前建窗追加');
    assert.equal(updates[1].complete, false);
    assert.equal(updates[2].result.kind, 'forward', JSON.stringify(updates[2].autoEvidence));
    assert.equal(updates[3].result.shift, 160);
    assert.equal(updates[4].result.kind, 'reverse');
    assert.equal(updates[4].result.shift, -120);
    const out = session.finish();
    assert.equal(out.complete, true, out.warning);
    assert.equal(out.height, HEIGHT + 320);
    assert.equal(firstDifference(out, glyphFrame(0, left, HEIGHT + 320)), null, '全文逐字节相同，不只验证高度');
    for (let i = 0; i < frames.length; i++) assert.deepEqual(Buffer.from(frames[i].data), originals[i], '运动核验不改写输入原帧');
  } finally { session.clear(); }
});
