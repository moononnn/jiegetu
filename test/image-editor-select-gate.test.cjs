'use strict';
// 「选择/调整」入口的能力闸：没有可调整对象时按钮置灰并说明原因，
// 有可调整对象（空心矩形/直线/箭头/批注/连线）时才可点；程序化点击也越不过去。
// 隐藏预览标记只是显示开关，不能把入口永久锁死。
// 用 test/fixtures/editor-dom.cjs 的最小 DOM 跑真实的 renderer/image-editor.js 与 annotations.js。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createEditorDom, HTMLElement } = require('./fixtures/editor-dom.cjs');

const ROOT = path.join(__dirname, '..');
const SOURCE_URL = 'data:image/png;base64,SELECT-GATE';
const ZOOM = 0.92, ORIGIN = 16;                 // 400×300 图在 400×300 视口里：min(1,(400-32)/400)
const at = (x, y) => ({ x: ORIGIN + x * ZOOM, y: ORIGIN + y * ZOOM });

function harness({ width = 400, height = 300 } = {}) {
  const dom = createEditorDom();
  const sandbox = { window: dom.window, document: dom.document, HTMLElement, Image: dom.Image,
    createImageBitmap: dom.createImageBitmap, ResizeObserver: dom.ResizeObserver,
    requestAnimationFrame: dom.requestAnimationFrame, cancelAnimationFrame: dom.cancelAnimationFrame,
    setTimeout, clearTimeout, queueMicrotask, console };
  vm.createContext(sandbox);
  for (const file of ['renderer/annotations.js', 'renderer/annotation-visuals.js', 'renderer/image-editor.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: path.basename(file) });
  }
  dom.document.images.set(SOURCE_URL, { width, height });
  const editor = dom.window.createImageEditor({ root: dom.root });
  dom.attachBoxes();
  const q = selector => dom.root.querySelector(selector);
  const qa = selector => dom.root.querySelectorAll(selector);
  const click = node => dom.root.emit('click', { target: node });
  const pointer = (x, y, extra = {}) => ({ clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0,
    buttons: 1, preventDefault() {}, getCoalescedEvents: () => [], ...extra });
  const drag = (from, to = from) => {
    const scroller = q('.ie-scroll');
    scroller.emit('pointerdown', pointer(from.x, from.y));
    scroller.emit('pointermove', pointer(to.x, to.y));
    scroller.emit('pointerup', pointer(to.x, to.y, { buttons: 0 }));
  };
  const open = async (token = 'gate-doc') => {
    await editor.open({ token, dataUrl: SOURCE_URL, width, height });
    dom.flushFrames();
  };
  const tool = id => click(q(`[data-tool="${id}"]`));
  const selectButton = () => q('[data-tool="select"]');
  const selectEnabled = () => selectButton().disabled === false;
  const currentTool = () => editor.debug().tool;
  return { dom, editor, q, qa, click, drag, tool, open, selectButton, selectEnabled, currentTool,
    undo: () => click(q('[data-action="undo"]')),
    redo: () => click(q('[data-action="redo"]')),
    toggleNotes: () => click(q('[data-action="notes-toggle"]')),
    fillRect: () => { q('[data-setting="fill"]').checked = true; } };
}

test('空白图没有可调整对象：选择入口置灰并说明原因', async () => {
  const h = harness();
  await h.open();
  assert.equal(h.selectEnabled(), false, '没有可调整对象时不能点');
  assert.match(h.selectButton().title, /还没有可调整|先添加/, 'title 说清为什么不能点');
  assert.equal(h.currentTool(), 'browse');
});

test('画了可调整形状或批注后：选择入口放开，title 换成调整说明', async () => {
  const cases = [
    { name: '空心矩形', draw: h => { h.tool('rect'); h.drag(at(40, 40), at(120, 80)); } },
    { name: '直线', draw: h => { h.tool('line'); h.drag(at(40, 40), at(120, 80)); } },
    { name: '箭头', draw: h => { h.tool('arrow'); h.drag(at(40, 40), at(120, 80)); } },
    { name: '批注', draw: h => { h.tool('point'); h.drag(at(60, 60)); } },
  ];
  for (const item of cases) {
    const h = harness();
    await h.open();
    assert.equal(h.selectEnabled(), false, `${item.name}之前是关的`);
    item.draw(h);
    assert.equal(h.selectEnabled(), true, `${item.name}之后可选`);
    assert.match(h.selectButton().title, /调整已添加的批注|调整/, `${item.name}的 title 换成可用说明`);
  }
});

test('只画笔、马赛克、纯色遮盖不算可调整对象：入口一直关着', async () => {
  const h = harness();
  await h.open();
  h.tool('pen');
  h.drag(at(40, 40), at(200, 200));
  assert.equal(h.selectEnabled(), false, '笔迹不可单独调整');
  h.tool('mosaic');
  h.drag(at(60, 60), at(160, 160));
  assert.equal(h.selectEnabled(), false, '马赛克不可单独调整');
  h.fillRect();
  h.tool('rect');
  h.drag(at(200, 40), at(300, 140));
  assert.equal(h.selectEnabled(), false, '纯色遮盖不可单独调整');
});

test('删光之后入口关掉；撤销恢复、重做再关；换图同样按新图算', async () => {
  const h = harness();
  await h.open();
  h.tool('rect');
  h.drag(at(40, 40), at(120, 80));
  assert.equal(h.selectEnabled(), true, '画完可选');
  // 画完矩形会自动选中并切到选择工具：直接在选中态删形状。
  h.click(h.q('[data-action="shape-delete"]'));
  assert.equal(h.selectEnabled(), false, '删光后没有可调整对象了');
  h.undo();
  assert.equal(h.selectEnabled(), true, '撤销把形状带回来，入口重新可用');
  h.redo();
  assert.equal(h.selectEnabled(), false, '重做又删掉，入口再关');
  // 换一张新图：新图上什么都没有，入口按新图算。
  await h.open('gate-doc-2');
  assert.equal(h.selectEnabled(), false, '换图后按新图内容重新判定');
});

test('程序化点击越不过禁用：工具不切到选择', async () => {
  const h = harness();
  await h.open();
  h.click(h.selectButton());
  assert.equal(h.currentTool(), 'browse', '点不动就还是抓手');
  h.tool('pen');
  h.drag(at(40, 40), at(200, 200));
  h.click(h.selectButton());
  assert.notEqual(h.currentTool(), 'select', '只有笔迹时程序化点击同样越不过去');
});

test('隐藏预览标记只是显示开关：入口仍可用，点选择后批注重新显示', async () => {
  const h = harness();
  await h.open();
  h.tool('point');
  h.drag(at(60, 60));
  h.tool('browse');
  h.toggleNotes();
  assert.equal(h.q('.ie-marker-layer').hidden, true, '批注标记先藏起来');
  assert.equal(h.selectEnabled(), true, '隐藏显示不锁死入口');
  h.click(h.selectButton());
  assert.equal(h.currentTool(), 'select', '从选择入口进来');
  assert.equal(h.q('.ie-marker-layer').hidden, false, '进入选择后批注重新显示');
});

test('批注删光、撤销和重做同步入口；空白处建连线也能启用', async () => {
  const h=harness(); await h.open(); h.tool('point'); h.drag(at(60,60));
  assert.equal(h.selectEnabled(),true);
  h.click(h.q('[data-action="bubble-delete"]'));
  assert.equal(h.selectEnabled(),false,'删掉最后一个批注就置灰');
  h.undo(); assert.equal(h.selectEnabled(),true);
  h.redo(); assert.equal(h.selectEnabled(),false);
  h.tool('connect'); h.drag(at(60,60),at(220,160));
  assert.equal(h.editor.debug().relations.length,1,'空白起手确实创建了连线');
  assert.equal(h.selectEnabled(),true,'连线和端点可以选择调整');
});
