'use strict';
// 工具光标（按工具区分的整套指针）的精确断言：解码真实 SVG、核对 path/颜色/线宽/热点/回退，
// 以及这些光标在关联选择、图外、平移、裁切/选择手柄、缩放和 GIF（动画）模式下的优先级。
// 用 test/fixtures/editor-dom.cjs 的假 DOM 跑真实 renderer/image-editor.js；不采屏、不启动 GUI。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createEditorDom, HTMLElement } = require('./fixtures/editor-dom.cjs');

const ROOT = path.join(__dirname, '..');
const SOURCE_URL = 'data:image/png;base64,CURSOR-SOURCE';
const ZOOM = 0.92, ORIGIN = 16;
const at = (x, y) => ({ x: ORIGIN + x * ZOOM, y: ORIGIN + y * ZOOM });
// 光标字符串 → { svg, hot: 'x y', fallback }；不是自定义 SVG 就返回 null。
const parseCursor = value => {
  const match = /^url\("data:image\/svg\+xml,([^"]+)"\) (\d+) (\d+), ([a-z-]+)$/.exec(value || '');
  return match ? { svg: decodeURIComponent(match[1]), hot: `${match[2]} ${match[3]}`, fallback: match[4] } : null;
};

function harness({ width = 400, height = 300, animation = false } = {}) {
  const dom = createEditorDom();
  const sandbox = { window: dom.window, document: dom.document, HTMLElement, Image: dom.Image,
    createImageBitmap: dom.createImageBitmap, ResizeObserver: dom.ResizeObserver,
    requestAnimationFrame: dom.requestAnimationFrame, cancelAnimationFrame: dom.cancelAnimationFrame,
    setTimeout, clearTimeout, queueMicrotask, console };
  vm.createContext(sandbox);
  for (const file of ['annotations.js', 'image-editor.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer', file), 'utf8'), sandbox, { filename: file });
  }
  dom.document.images.set(SOURCE_URL, { width, height });
  const editor = sandbox.window.createImageEditor({ root: dom.root, animation,
    onCreate: () => {}, onCommit: () => {}, onClose: () => {} });
  dom.attachBoxes();
  const q = selector => dom.root.querySelector(selector);
  const scroller = q('.ie-scroll');
  const pointer = (type, x, y, extra = {}) => ({ clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse',
    button: 0, buttons: type === 'pointerup' ? 0 : 1, preventDefault() {}, getCoalescedEvents: () => [], ...extra });
  const emit = (node, type, event) => node.emit(type, event);
  const hover = (x, y) => {
    emit(scroller, 'pointermove', pointer('pointermove', x, y));
    return scroller.style.cursor;
  };
  const hoverSource = (x, y) => { const p = at(x, y); return hover(p.x, p.y); };
  const drag = (from, to = from) => {
    emit(scroller, 'pointerdown', pointer('pointerdown', from.x, from.y));
    emit(scroller, 'pointermove', pointer('pointermove', to.x, to.y));
    emit(scroller, 'pointerup', pointer('pointerup', to.x, to.y));
  };
  const tool = id => emit(dom.root, 'click', { target: q(`[data-tool="${id}"]`) });
  const clickAction = id => emit(dom.root, 'click', { target: q(`[data-action="${id}"]`) });
  const key = (values) => dom.window.emit('keydown', { key: values.key, target: values.target ?? scroller,
    preventDefault() {}, stopImmediatePropagation() {}, ...values });
  const open = async () => { await editor.open({ token: 'cur', dataUrl: SOURCE_URL, width, height }); dom.flushFrames(); };
  return { dom, editor, q, scroller, hover, hoverSource, drag, tool, clickAction, key, open, pointer, emit };
}

// —— 精确造型 ——
test('笔/直线光标：细笔尖 (5,25)、两 path 白底+墨绿、同 path 同 fill，圆头圆角', async () => {
  const h = harness();
  await h.open();
  h.tool('pen');
  const pen = parseCursor(h.hoverSource(120, 120));
  assert.ok(pen, '笔工具必须是自定义 SVG 指针');
  assert.equal(pen.hot, '5 25', '热点是笔尖');
  assert.equal(pen.fallback, 'default', '笔的普通回退');
  assert.match(pen.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="32" height="32" viewBox="0 0 32 32">/);
  const body = 'M5 25L7 18L22 3L27 8L12 23Z M7 18L12 23M20 5L25 10';
  assert.ok(pen.svg.includes(`<path d="${body}" fill="#f3f8ed" stroke="#fff" stroke-width="3.35" stroke-linejoin="round" stroke-linecap="round"/>`),
    '白底描边宽度 = 主线 + 2.2');
  assert.ok(pen.svg.includes(`<path d="${body}" fill="#f3f8ed" stroke="#244e43" stroke-width="1.15" stroke-linejoin="round" stroke-linecap="round"/>`),
    '主线墨绿、与白底同 path 同 fill');
  assert.ok(pen.svg.includes('<path d="M5 25L7 18L12 23Z" fill="#244e43"/>'), '笔尖墨块');
  assert.ok(pen.svg.includes('<path d="M11 18L20 9" stroke="#9ab49e" stroke-width="1.1"/>'), '笔杆高光');
  // 直线与笔共用同一套指针。
  h.tool('line');
  assert.equal(h.hoverSource(120, 120), h.q('.ie-scroll').style.cursor);
  const line = parseCursor(h.hoverSource(120, 120));
  assert.deepEqual(line, pen, 'line 与 pen 完全一致');
});

test('矩形/框批注光标：定位点 (8,8) + 空心框；箭头是定位点 + 小箭头', async () => {
  const h = harness();
  await h.open();
  h.tool('rect');
  const rect = parseCursor(h.hoverSource(120, 120));
  assert.ok(rect, '矩形必须是自定义 SVG 指针');
  assert.equal(rect.hot, '8 8', '热点在定位点');
  assert.equal(rect.fallback, 'crosshair');
  const pin = 'M8 2V5M8 11V14M2 8H5M11 8H14';
  assert.ok(rect.svg.includes(`<path d="${pin}" fill="none" stroke="#fff" stroke-width="3.4"`), '定位点十字有白底描边');
  assert.ok(rect.svg.includes(`<path d="${pin}" fill="none" stroke="#244e43" stroke-width="1.2"`), '定位点主线');
  assert.ok(rect.svg.includes('<circle cx="8" cy="8" r=".9" fill="#244e43" stroke="#fff" stroke-width=".5"/>'), '中心墨点');
  assert.ok(rect.svg.includes('<path d="M18 17H29V28H18Z" fill="none" stroke="#244e43" stroke-width="1.25"'), '空心框');
  // 框批注与矩形同一套。
  h.tool('region');
  assert.deepEqual(parseCursor(h.hoverSource(120, 120)), rect, 'region 与 rect 完全一致');
  // 纯色填充也还是矩形工具：光标不因 fill 改变。
  h.tool('rect');
  h.q('[data-setting="fill"]').checked = true;
  assert.deepEqual(parseCursor(h.hoverSource(120, 120)), rect, '填充矩形用同一个矩形光标');
  h.q('[data-setting="fill"]').checked = false;
  // 箭头：同一个定位点 + 另一个形状。
  h.tool('arrow');
  const arrow = parseCursor(h.hoverSource(120, 120));
  assert.ok(arrow);
  assert.equal(arrow.hot, '8 8');
  assert.equal(arrow.fallback, 'crosshair');
  assert.ok(arrow.svg.includes(`<path d="${pin}"`), '箭头也带定位点');
  assert.ok(arrow.svg.includes('<path d="M18 28L29 17M22 17H29V24" fill="none" stroke="#244e43" stroke-width="1.35"'), '小箭头');
  assert.notEqual(arrow.svg, rect.svg, '箭头与矩形不是同一个图形');
  // 三套互不相同：笔 / 矩形(=框) / 箭头。
  h.tool('pen');
  const pen = parseCursor(h.hoverSource(120, 120));
  assert.notEqual(pen.svg, rect.svg);
  assert.notEqual(pen.svg, arrow.svg);
});

test('point 气泡与 mosaic 范围圈保持不变：气泡热点在尾巴尖端，马赛克仍是实际范围圈 + 隐藏系统指针', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  const point = parseCursor(h.hoverSource(120, 120));
  assert.ok(point, 'point 仍是自定义 SVG');
  assert.equal(point.hot, '10 29', '气泡热点不变');
  assert.equal(point.fallback, 'crosshair');
  assert.ok(point.svg.includes('M13 19 10 29 17 19'), '气泡尾巴尖端');
  assert.ok(point.svg.includes('#f7faf6'), '气泡底色不变');
  // 马赛克：光标 none（隐藏系统指针），范围圈可见。
  h.tool('mosaic');
  assert.equal(h.hoverSource(120, 120), 'none');
  assert.equal(h.q('.ie-brush-cursor').hidden, false, '实际范围圈仍显示');
});

test('关联选择按实际 linkPick.kind 选图标：框工具选点、点工具选框；取消后回原工具', async () => {
  const h = harness();
  await h.open();
  // 框批注：建草稿后点「＋关联点」→ 选择中的光标必须是点气泡，而不是框图标。
  h.tool('region');
  h.drag(at(40, 40), at(120, 120));
  const regionTool = h.hoverSource(200, 200);
  h.clickAction('bubble-add-point');
  const linkPoint = parseCursor(h.hoverSource(200, 200));
  assert.ok(linkPoint);
  assert.equal(linkPoint.hot, '10 29', '关联点用气泡光标');
  assert.ok(linkPoint.svg.includes('M13 19 10 29 17 19'));
  assert.notEqual(linkPoint.svg, parseCursor(regionTool).svg);
  h.key({ key: 'Escape' });
  assert.equal(h.hoverSource(200, 200), regionTool, '取消关联后回到框工具光标');
  // 点批注：建草稿后点「＋关联框」→ 选择中的光标必须是框图标。
  h.tool('point');
  h.drag(at(60, 60));
  const pointTool = h.hoverSource(200, 200);
  h.clickAction('bubble-add-region');
  const linkRegion = parseCursor(h.hoverSource(200, 200));
  assert.ok(linkRegion);
  assert.equal(linkRegion.hot, '8 8', '关联框用矩形/定位点光标');
  assert.ok(linkRegion.svg.includes('M18 17H29V28H18Z'));
  assert.notEqual(linkRegion.svg, parseCursor(pointTool).svg);
  h.key({ key: 'Escape' });
  assert.equal(h.hoverSource(200, 200), pointTool, '取消关联后回到点工具光标');
});

test('图外、平移与手柄优先：图外 default，空格/中键优先，裁切与选择手柄仍给方向光标', async () => {
  const h = harness();
  await h.open();
  for (const id of ['pen', 'line', 'rect', 'arrow', 'point', 'region']) {
    h.tool(id);
    const outside = h.hover(398, 296);
    assert.equal(outside, 'default', `${id} 出图回到普通指针`);
  }
  // 空格临时抓手压过工具光标。
  h.tool('pen');
  h.key({ key: ' ', code: 'Space' });
  assert.equal(h.hoverSource(120, 120), 'grab');
  h.handleKey = undefined;
  h.dom.window.emit('keyup', { key: ' ', code: 'Space' });
  assert.match(h.hoverSource(120, 120), /^url\("data:image\/svg\+xml,/);
  // 裁切：进入裁切后手柄给方向光标，框内 move，框外十字。
  h.tool('crop');
  h.dom.flushFrames();
  assert.equal(h.hoverSource(200, 150), 'move', '裁切框内是 move');
  const cropZoom = Number(h.q('.ie-zoom').textContent.replace('%', '')) / 100;
  const cropHandle = h.hover(16 + 400 * cropZoom, 16 + 300 * cropZoom);
  assert.match(cropHandle, /-resize$/, `裁切角手柄给 resize：${cropHandle}`);
  // 选择工具：画个矩形后边线 move、手柄 resize、端点 crosshair。
  h.tool('rect');
  h.drag(at(60, 60), at(200, 160));
  assert.equal(h.hoverSource(90, 60), 'move', '边线是移动（避开了中点手柄）');
  assert.match(h.hoverSource(60, 60), /resize$/, '角手柄是 resize');
  h.tool('line');
  h.drag(at(40, 240), at(160, 240));
  assert.equal(h.hoverSource(160, 240), 'crosshair', '线端点是十字');
  // 抓手工具本身仍是 grab。
  h.tool('browse');
  assert.equal(h.hoverSource(200, 150), 'grab');
});

test('缩放只改画布不改光标：同一工具在不同 zoom 下光标字符串逐字相同', async () => {
  const h = harness();
  await h.open();
  h.tool('rect');
  const before = h.hoverSource(120, 120);
  h.clickAction('zoom-in');
  h.dom.flushFrames();
  const zoomText = h.q('.ie-zoom').textContent;
  assert.notEqual(zoomText, '92%', '缩放确实变了');
  const after = h.hover(ORIGIN + 120 * (Number(zoomText.replace('%', '')) / 100),
    ORIGIN + 120 * (Number(zoomText.replace('%', '')) / 100));
  assert.equal(after, before, '热点不随 zoom 缩放');
});

test('GIF（动画）模式与普通编辑用同一套工具光标（动画没有 point/region）', async () => {
  const normal = harness();
  await normal.open();
  const anim = harness({ animation: true });
  await anim.open();
  for (const id of ['pen', 'line', 'rect', 'arrow', 'browse', 'mosaic']) {
    normal.tool(id);
    anim.tool(id);
    assert.equal(anim.hoverSource(120, 120), normal.hoverSource(120, 120), `${id} 在两种模式下一致`);
  }
  // GIF 本来就没有批注工具：按钮隐藏，不会出现点/框光标。
  for (const id of ['point', 'region']) assert.equal(anim.q(`[data-tool="${id}"]`).hidden, true, `${id} 在动画模式仍隐藏`);
});

test('换光标不改绘图：矩形落点与批注落点仍按源坐标', async () => {
  const h = harness();
  await h.open();
  h.tool('rect');
  h.hoverSource(120, 120);
  h.drag(at(40, 40), at(120, 80));
  const before = h.dom.canvases.length;
  await h.editor.exportPNG();
  const calls = h.dom.canvases.slice(before)[0].context.calls;
  const stroked = calls.filter(call => call.name === 'strokeRect').map(call => call.args);
  assert.deepEqual(stroked, [[40, 40, 80, 40]], '矩形仍是拖框源坐标');
  h.tool('point');
  h.hoverSource(200, 200);
  h.drag(at(100, 90));
  const marker = h.q('.ie-marker');
  assert.ok(marker, '点批注仍落在原处');
  assert.deepEqual(JSON.parse(JSON.stringify(h.editor.outputSize)), { width: 400, height: 300 });
});
