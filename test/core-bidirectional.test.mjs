import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScrollSession } from '../core/scroll-session.mjs';
import { createFramedScrollSession } from '../core/framed-scroll-session.mjs';
import { createAutoScrollSession } from '../core/auto-scroll-session.mjs';
import { renderPreview, previewSize, PREVIEW_MAX_BYTES } from '../core/scroll-preview.mjs';
import { buildDocument } from './fixtures/auto-scenes.mjs';

const WIDTH = 64, BODY = 240, DOC_ROWS = 4000;
const doc = buildDocument(DOC_ROWS, WIDTH, { seed: 20261025 });
const frameAt = top => ({ width: WIDTH, height: BODY, data: doc.data.slice(top * WIDTH * 4, (top + BODY) * WIDTH * 4) });
const rowsOf = (from, to) => doc.data.slice(from * WIDTH * 4, to * WIDTH * 4);

test('legacy 双向：先上再下，回穿起点不重复，输出按文档顺序逐字节一致', () => {
  const session = createScrollSession(frameAt(1000));
  let at = 0;
  const step = top => session.accept(frameAt(top), at += 50);

  const up1 = step(984);
  assert.equal(up1.result.kind, 'reverse');
  assert.equal(up1.added, 16);
  assert.equal(up1.height, BODY + 16);

  const up2 = step(968);
  assert.equal(up2.added, 16);
  assert.equal(up2.height, BODY + 32);

  const back = step(1000);
  assert.equal(back.added, 0, '回穿起点后已覆盖区域不重复追加');
  assert.equal(back.height, BODY + 32);

  const down = step(1040);
  assert.equal(down.result.kind, 'forward');
  assert.equal(down.added, 40);
  assert.equal(down.height, BODY + 72);

  const output = session.finish();
  assert.equal(output.height, BODY + 72);
  assert.deepEqual(output.data, rowsOf(968, 1040 + BODY), '拼接结果保留源 RGBA 并保持文档顺序');
});

test('legacy 双向：双向都越过旧边界后继续接，起点附近内容不被截断', () => {
  const session = createScrollSession(frameAt(500));
  let at = 0;
  const step = top => session.accept(frameAt(top), at += 50);

  step(520); step(540);
  step(500);
  const up = step(460);
  assert.equal(up.result.kind, 'reverse');
  assert.equal(up.added, 40, '越过旧顶端后向上接长');
  const later = step(600);
  assert.equal(later.result.kind, 'forward');
  assert.equal(later.added, 60, '向下越过旧底端后继续接长');

  const output = session.finish();
  assert.equal(output.height, BODY + 140);
  assert.deepEqual(output.data, rowsOf(460, 600 + BODY));
});

test('legacy 视口与预览：位置随文档移动，折返时仍指向同一文档行', () => {
  const session = createScrollSession(frameAt(1000));
  let at = 0;
  const step = top => session.accept(frameAt(top), at += 50);

  const start = session.stats();
  assert.deepEqual(start.viewport, { top: 0, height: BODY, matched: false });
  assert.ok(start.preview && start.preview.width <= 240 && start.preview.height <= 480);
  assert.ok(start.preview.data.length <= PREVIEW_MAX_BYTES);

  const up = step(984);
  assert.equal(up.viewport.top, 0, '向上接长后视口就在输出图顶部');
  assert.equal(up.viewport.matched, true);

  const back = step(1000);
  assert.equal(back.viewport.top, 16, '回穿起点时视口坐标对应同一文档行');
  assert.equal(back.viewport.matched, true);
});

test('legacy 未对齐帧不误报视口，尺寸上限与 clear 后不可再用', () => {
  const session = createScrollSession(frameAt(1000));
  let at = 0;
  session.accept(frameAt(1016), at += 50);
  const matched = session.stats().viewport;
  assert.equal(matched.matched, true, '首次向下接长已对齐');
  // 与文档毫无关系的噪声帧：不能当作对齐成功。
  const other = buildDocument(4000, WIDTH, { seed: 777 });
  const noise = { width: WIDTH, height: BODY, data: other.data.slice(1500 * WIDTH * 4, (1500 + BODY) * WIDTH * 4) };
  const lost = session.accept(noise, at += 50);
  assert.notEqual(lost.result.kind, 'forward');
  assert.equal(lost.viewport.matched, false, '未定位时保留最后可信位置并标记 matched:false');
  assert.equal(lost.viewport.top, matched.top);

  const tall = createScrollSession(frameAt(1000), { maxHeight: BODY + 8 });
  const capped = tall.accept(frameAt(1000 + 40), 1000);
  assert.equal(capped.added, 0);
  assert.equal(capped.limit, true);

  session.clear();
  assert.equal(session.stats().height, 0, 'clear 后回到零值形态而非抛错');
  assert.throws(() => session.accept(frameAt(1000), 9999), /已清除/);
});

test('framed 双向：固定顶底栏不被滚动替换，正文向上向下都接长', () => {
  const top = 20, bottom = 16, height = top + BODY + bottom;
  const header = buildDocument(top, WIDTH, { seed: 5 });
  const footer = buildDocument(bottom, WIDTH, { seed: 6 });
  const sceneFrame = docTop => {
    const data = new Uint8ClampedArray(WIDTH * height * 4);
    data.set(header.data.subarray(0, top * WIDTH * 4), 0);
    data.set(doc.data.subarray(docTop * WIDTH * 4, (docTop + BODY) * WIDTH * 4), top * WIDTH * 4);
    data.set(footer.data.subarray(0, bottom * WIDTH * 4), (top + BODY) * WIDTH * 4);
    return { data, width: WIDTH, height };
  };
  const session = createFramedScrollSession(sceneFrame(1000), { top, bottom: top + BODY });
  let at = 0;
  const step = docTop => session.accept(sceneFrame(docTop), at += 50);

  const up = step(984);
  assert.equal(up.result.kind, 'reverse');
  assert.equal(up.added, 16);
  assert.equal(up.height, height + 16);
  assert.equal(up.viewport.top, top, '视口与含固定栏的完整预览共用整图坐标');
  assert.equal(up.preview.sourceHeight, up.height);
  assert.deepEqual(Array.from(up.preview.data.subarray(0, 4)), Array.from(header.data.subarray(0, 4)));
  assert.equal('previewScope' in up, false);

  const down = step(1020);
  assert.equal(down.result.kind, 'forward');
  assert.equal(down.height, height + 36);

  const output = session.finish();
  assert.equal(output.height, height + 36);
  const expected = new Uint8ClampedArray(WIDTH * (height + 36) * 4);
  expected.set(header.data.subarray(0, top * WIDTH * 4), 0);
  expected.set(rowsOf(984, 1020 + BODY), top * WIDTH * 4);
  expected.set(footer.data.subarray(0, bottom * WIDTH * 4), (top + BODY + 36) * WIDTH * 4);
  assert.deepEqual(output.data, expected, '固定栏只出现一次，正文顺序正确');
  assert.equal(session.stats().preview.sourceHeight, output.height);
  assert.deepEqual(session.stats().preview.data, output.data, '尺寸未超过上限时完整预览与最终成图逐像素一致');
  const changed = sceneFrame(1020); changed.data.fill(0, 0, WIDTH * 4);
  const lost = session.accept(changed, at += 50);
  assert.equal(lost.result.kind, 'layout-changed');
  assert.equal(lost.viewport.matched, false);
  assert.equal(session.stats().viewport.matched, false, '固定栏变化后stats也不能恢复假绿框');
});

test('auto 默认会话双向：先下再上越过旧顶端，折返不重复，预览与视口自洽', () => {
  const session = createAutoScrollSession(frameAt(1000));
  let at = 0;
  const step = docTop => session.accept(frameAt(docTop), at += 60);

  step(1016); step(1032); step(1048);
  const built = session.stats();
  assert.ok(built.height >= BODY, '建窗后高度至少一屏');
  assert.ok(built.preview && built.preview.width <= 240 && built.preview.height <= 480);
  assert.ok(built.preview.data.length <= PREVIEW_MAX_BYTES);

  const covered = step(1032);
  assert.equal(covered.added, 0, '已覆盖区间内折返不重复追加');

  const up = step(984);
  assert.equal(up.result.kind, 'reverse');
  assert.equal(up.added, 16, '越过旧顶端后向上接长');
  assert.equal(up.height, built.height + 16);

  const upAgain = step(968);
  assert.equal(upAgain.added, 16);

  const down = step(1100);
  assert.equal(down.result.kind, 'forward');
  assert.equal(down.height, built.height + 32 + (1100 - 1048));
  assert.equal(down.capturedHeight, down.height, '全部可信时已采集高度与输出高度一致');

  const viewport = down.viewport;
  assert.equal(viewport.matched, true);
  assert.equal(viewport.height <= BODY, true);
  assert.ok(viewport.top >= 0 && viewport.top + viewport.height <= down.capturedHeight, '视口必须落在输出图坐标内');

  const output = session.finish();
  assert.equal(output.height, down.height);
  assert.equal(output.complete, true);
});

test('auto 未对齐帧保留最后可信视口并标记 matched:false', () => {
  const session = createAutoScrollSession(frameAt(1000));
  let at = 0;
  session.accept(frameAt(1016), at += 60);
  session.accept(frameAt(1032), at += 60);
  session.accept(frameAt(1048), at += 60);
  const trusted = session.stats().viewport;
  assert.ok(trusted);

  const other = buildDocument(4000, WIDTH, { seed: 777 });
  const noise = { width: WIDTH, height: BODY, data: other.data.slice(1500 * WIDTH * 4, (1500 + BODY) * WIDTH * 4) };
  const lost = session.accept(noise, at += 60);
  assert.notEqual(lost.result.kind, 'forward');
  assert.equal(lost.viewport.matched, false);
  assert.equal(lost.viewport.top, trusted.top, '未定位时不能编造新的视口位置');
});

test('auto 尺寸上限拒绝新区域后不把图外锚点误报为已匹配', () => {
  const session = createAutoScrollSession(frameAt(1000), { maxHeight: BODY + 40 });
  session.accept(frameAt(1016), 60);
  session.accept(frameAt(1032), 120);
  const trusted = session.stats().viewport;
  const rejected = session.accept(frameAt(1048), 180);
  assert.equal(rejected.limit, true);
  assert.equal(rejected.viewport.matched, false);
  assert.equal(rejected.viewport.top, trusted.top);
  assert.equal(session.stats().viewport.matched, false);
});

test('有界预览：直接对片段降采样，尺寸与字节上限固定，空输入返回 null', () => {
  assert.equal(renderPreview(WIDTH, []), null);
  assert.equal(previewSize(64, 0), null);
  const parts = [{ data: rowsOf(1000, 1240), height: 240 }, { data: rowsOf(1240, 1480), height: 240 }];
  const preview = renderPreview(WIDTH, parts);
  assert.ok(preview);
  assert.equal(preview.width, WIDTH);
  assert.ok(preview.height <= 480);
  assert.ok(preview.data.length <= PREVIEW_MAX_BYTES);
  assert.equal(preview.data.length, preview.width * preview.height * 4);
  // 小图第一行必须来自第一块片段的顶部，最后一行来自第二块片段的底部。
  assert.deepEqual(Array.from(preview.data.subarray(0, 4)), Array.from(parts[0].data.subarray(0, 4)));
  const lastRow = (preview.height - 1) * preview.width * 4;
  assert.deepEqual(Array.from(preview.data.subarray(lastRow, lastRow + 4)), Array.from(parts[1].data.subarray(parts[1].data.length - preview.width * 4, parts[1].data.length - preview.width * 4 + 4)));

  const wide = renderPreview(1920, [{ data: new Uint8ClampedArray(1920 * 6000 * 4), height: 6000 }]);
  assert.equal(wide.width, 153);
  assert.equal(wide.height, 480, '超长图同时按宽高上限等比缩小，不横向拉胖');
  assert.ok(wide.data.length <= PREVIEW_MAX_BYTES);
  assert.ok(Math.abs(wide.width / wide.height - 1920 / 6000) <= 1 / 480);
});
