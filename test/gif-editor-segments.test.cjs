'use strict';
// GIF 编辑器（定位 / 切分 / 选片段 / 删除 / 撤销重做 / 虚拟序号）回归：VM + 最小 fake DOM。
// 不启动 Electron、不采屏、不碰剪贴板、不联网；ImageDecoder 与 image-editor 都是替身。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parse } = require('../core/gif-timeline.js');

const SOURCE = fs.readFileSync(path.join(__dirname, '../renderer/gif-editor.js'), 'utf8');
const IMAGE_EDITOR = fs.readFileSync(path.join(__dirname, '../renderer/image-editor.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '../renderer/gif-editor.css'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
// 导出循环里有 setTimeout(0)，多轮 flush 才能让整段桥接序列跑完。
const flush = async (rounds = 8) => { for (let i = 0; i < rounds; i += 1) { await tick(); await new Promise(resolve => setTimeout(resolve, 0)); } };

// 与 gif-timeline.test.cjs 同款自家 GIF 合成器（只造结构，不解码像素）。
function fixture(delays = [500, 1000, 300], width = 4, height = 3) {
  const head = [...Buffer.from('GIF89a'), width & 255, width >> 8, height & 255, height >> 8, 128, 0, 0, 0, 0, 0, 255, 255, 255];
  for (const delay of delays) head.push(33, 249, 4, 4, (delay / 10) & 255, (delay / 10) >> 8, 0, 0, 44, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0, 2, 2, 68, 1, 0);
  return Uint8Array.from([...head, 59]);
}

// —— 极小 DOM：够 gif-editor 用即可（innerHTML 建树、按 data-ge 取节点、片段块可点可查） ——
const VOID_TAGS = new Set(['input', 'br', 'img', 'meta', 'link', 'hr']);
function matches(node, selector) {
  if (!node || node.nodeType !== 1) return false;
  if (selector.startsWith('[data-ge="')) return node.attributes['data-ge'] === selector.slice(10, -2);
  if (selector.startsWith('.')) return node.classes.has(selector.slice(1));
  return node.tagName === selector.toUpperCase();
}
function descendants(node) {
  const out = [];
  for (const child of node.children ?? []) { out.push(child); out.push(...descendants(child)); }
  return out;
}
function createNode(tagName, attributes = {}, parentNode = null) {
  const node = {
    nodeType: 1, tagName: String(tagName).toUpperCase(), attributes: { ...attributes },
    parentNode, children: [], classes: new Set(String(attributes.class || '').split(' ').filter(Boolean)),
    dataset: {}, style: {}, listeners: {}, hidden: false, disabled: false, _text: '', _html: '',
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    dispatch(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, stopPropagation() {}, target: this, ...event }); },
    click() { if (this.disabled) return undefined; return this.dispatch('click', { button: 0 }); },
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'aria-pressed') this.pressed = String(value) === 'true'; },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
    removeAttribute(name) { delete this.attributes[name]; },
    focus() { globalThis.__document.activeElement = this; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 8 }),
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false,
    querySelectorAll(selector) { return descendants(this).filter(child => matches(child, selector)); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    get textContent() { return this._text; },
    set textContent(value) { this._text = String(value); if (this._text === '') this.children = []; },
    get innerHTML() { return this._html; },
    set innerHTML(value) { this._html = String(value); this.children = []; buildTree(this._html, this); },
    classList: { add: name => node.classes.add(name), remove: name => node.classes.delete(name), contains: name => node.classes.has(name) }
  };
  for (const [name, value] of Object.entries(attributes)) {
    if (name.startsWith('data-')) node.dataset[name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = value;
  }
  return node;
}
// 递归建树：只认本文件里用到的简单标签，够解析自己写的那段模板。
function buildTree(html, parent, register = () => {}) {
  const pattern = /<(\/?)([a-z]+)\b([^>]*?)(\/?)>/g;
  const stack = [parent];
  let match;
  while ((match = pattern.exec(html))) {
    const [, closing, tag, rawAttributes] = match;
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const attributes = {};
    for (const attribute of rawAttributes.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) attributes[attribute[1]] = attribute[2] ?? '';
    const node = createNode(tag, attributes, stack[stack.length - 1]);
    stack[stack.length - 1].children.push(node);
    register(node);
    if (!VOID_TAGS.has(tag) && !match[4]) stack.push(node);
  }
}

function harness({ delays = [500, 1000, 300], canRender = true, editGate, decodeGate } = {}) {
  const bytes = fixture(delays);
  const frameCount = parse(bytes).frames.length;
  const calls = { edit: [], decode: [], replaceFrame: [], renderFrame: [] };
  const state = { canRender, editGate, decodeGate, now: 0 };
  const byName = new Map();
  const document = {
    activeElement: null,
    createElement(tag) {
      if (tag !== 'canvas') return { style: {}, addEventListener() {} };
      return { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/png;base64,AA' };
    },
    addEventListener() {},
    querySelector() { return null; }
  };
  globalThis.__document = document;
  const root = createNode('section', {});
  root.hidden = true;
  root.listeners = {};
  // root 的 innerHTML 写进去后，所有 data-ge 节点都进 byName，root.querySelector 也能找到嵌套的片段块。
  const originalSetter = Object.getOwnPropertyDescriptor(root, 'innerHTML');
  Object.defineProperty(root, 'innerHTML', {
    get: originalSetter.get,
    set(value) {
      root.children = [];
      buildTree(String(value), root, node => { if (node.attributes['data-ge']) byName.set(node.attributes['data-ge'], node); });
      root._html = String(value);
    }
  });
  root.querySelector = selector => root.querySelectorAll(selector)[0] ?? null;
  root.querySelectorAll = selector => descendants(root).filter(node => matches(node, selector));
  root.addEventListener = (type, fn) => { (root.listeners[type] ??= []).push(fn); };
  const editor = {
    reset() {}, async open() {}, setBusy() {},
    get canRenderFrame() { return state.canRender; },
    get outputSize() { return { width: 4, height: 3 }; },
    async replaceFrame(image) { calls.replaceFrame.push(image); return true; },
    renderFrame() { calls.renderFrame.push(true); return { rgba: new Uint8Array(4 * 3 * 4) }; }
  };
  let editorOptions;
  class FakeImageDecoder {
    constructor() {
      this.tracks = { ready: Promise.resolve(), selectedTrack: { frameCount } };
      this.completed = Promise.resolve(); this.closed = false;
    }
    async decode({ frameIndex }) {
      calls.decode.push(frameIndex);
      if (state.decodeGate) await state.decodeGate;
      return { image: { frameIndex, close() {} } };
    }
    close() { this.closed = true; }
  }
  const bridge = {
    async action() { return { ok: true }; },
    async edit(action, payload) {
      calls.edit.push({ action, payload });
      if (action === 'begin') { if (state.editGate) await state.editGate; return { token: 'owned-token' }; }
      return { ok: true };
    }
  };
  const windowListeners = new Map();
  const window = {
    GifTimeline: require('../core/gif-timeline.js'),
    ImageDecoder: FakeImageDecoder,
    createImageEditor(options) { editorOptions = options; return editor; },
    addEventListener(type, fn) { if (!windowListeners.has(type)) windowListeners.set(type, []); windowListeners.get(type).push(fn); }
  };
  const intervals = new Set();
  vm.runInNewContext(SOURCE, { window, document, ImageDecoder: FakeImageDecoder, performance: { now: () => state.now },
    setInterval: fn => { const token = { fn }; intervals.add(token); return token; },
    clearInterval: token => intervals.delete(token), setTimeout, clearTimeout, console });
  const statuses = [];
  const controller = window.createGifEditor({ root, bridge, onClose() {}, onStatus: text => statuses.push(text) });
  const node = name => byName.get(name) ?? root.querySelector(`[data-ge="${name}"]`);
  // 片段块随 innerHTML 重建，所以每次都从宿主现取。
  const segments = () => node('segments').querySelectorAll('[data-ge="segment"]');
  // 时钟用可控替身：测试结束不会留真 setInterval 拖住进程，还能手动推一格。
  const tickClock = () => { for (const token of [...intervals]) token.fn(); };
  // 派发 window 级事件（blur/beforeunload），验证暂停而非关闭。
  const emitWindow = type => { for (const fn of windowListeners.get(type) ?? []) fn({ type }); };
  // 模拟图片编辑器一次 sync：它会在 sync 末尾通知宿主刷新时间栏。
  const notifyEditor = () => editorOptions?.onStateChange?.();
  return { controller, calls, state, node, segments, editorOptions, notifyEditor, emitWindow, frameCount, bytes, statuses, root, document, intervals, tickClock };
}

// 打开编辑器：与真实调用一致（source 带 sourceId/字节/尺寸）。
async function open(harnessed) {
  const { bytes } = harnessed;
  await harnessed.controller.open({ sourceId: 'src-1', bytes, width: 4, height: 3 });
  await tick(); await tick();
  assert.equal(harnessed.controller.isOpen, true, `打开失败：${harnessed.statuses.join(' / ')}`);
  return harnessed;
}
// 点上方定位条移动播放头（真实 input 事件）。
function seekTo(harnessed, ms) {
  const input = harnessed.node('seek');
  input.value = String(ms);
  input.dispatch('input');
}
const position = harnessed => harnessed.node('position').textContent;
const duration = harnessed => harnessed.node('duration').textContent;
const pressedIndexes = harnessed => harnessed.segments()
  .filter(button => button.getAttribute('aria-pressed') === 'true').map(button => Number(button.dataset.index));
const cutsOf = harnessed => harnessed.segments().map(button => [Number(button.dataset.from), Number(button.dataset.to)]);
// —— 上方轨道的切点层与轨迹高亮 ——
const cutMarks = harnessed => harnessed.node('cutLayer').querySelectorAll('[data-ge="cut"]');
const cutLabels = harnessed => harnessed.node('cutLayer').querySelectorAll('.ge-cut-label');
const cutLefts = harnessed => cutMarks(harnessed).map(mark => Number.parseFloat(mark.style.left));
const pickState = harnessed => {
  const pick = harnessed.node('pick');
  return { hidden: pick.hidden === true, left: Number.parseFloat(pick.style.left), width: Number.parseFloat(pick.style.width) };
};
const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-3, `${message}：${actual} ≈ ${expected}`);

test('打开后是一整段、没有选中片段：删除要先选块，切分在片头被禁并给原因', async () => {
  const h = await open(harness());
  assert.match(duration(h), /共 1\.80秒 · 1 段/);
  assert.deepEqual(cutsOf(h), [[0, 1800]], '初始只有一整段');
  assert.deepEqual(pressedIndexes(h), [], '初始不选中任何片段');
  assert.equal(h.node('remove').disabled, true);
  assert.match(h.node('remove').title, /先在下方点一个片段选中它/);
  assert.equal(h.node('split').disabled, true, '播放头在片头时不能切分');
  assert.match(h.node('split').title, /片头/);
  assert.equal(h.node('undo').disabled, true);
  assert.equal(h.node('redo').disabled, true);
  assert.match(position(h), /^1\/3 /);
  // 片尾也不行，且切点重复会说明原因。
  seekTo(h, 1790);
  assert.equal(h.node('split').disabled, false, '片尾前 10ms 可以切');
  h.node('split').click();
  await tick();
  seekTo(h, 1790);
  assert.equal(h.node('split').disabled, true);
  assert.match(h.node('split').title, /已经是切点/);
});

test('定位→切分：只多一个切点、不丢内容，右侧新片段自动选中', async () => {
  const h = await open(harness());
  seekTo(h, 500);
  await tick();
  assert.match(position(h), /^2\/3 · 0\.50秒/, '点定位条只移动播放头（500ms 已属第 2 帧）');
  h.node('split').click();
  await tick();
  assert.deepEqual(cutsOf(h), [[0, 500], [500, 1800]], '在 500ms 处多一刀');
  assert.deepEqual(pressedIndexes(h), [1], '右侧新片段自动选中');
  assert.match(duration(h), /共 1\.80秒 · 2 段/, '切分不改变总时长');
  assert.match(position(h), /\/3 /, '切分不改变帧数');
  assert.match(h.node('status').textContent, /切分/);
  assert.equal(h.node('undo').disabled, false);
  assert.equal(h.node('redo').disabled, true);
  // 切分不改变输出：导出仍是 3 帧、总长 1800。
  await h.editorOptions.onCommit();
  const begin = h.calls.edit.find(call => call.action === 'begin');
  assert.equal(begin.payload.frames, 3);
  assert.equal(begin.payload.durationMs, 1800);
});

test('选片段→删除：只留剩余帧，剩余片段的顺序与时长不变', async () => {
  const h = await open(harness({ delays: [500, 1000, 300] }));
  seekTo(h, 500); h.node('split').click(); await tick();
  seekTo(h, 1500); h.node('split').click(); await tick();
  assert.deepEqual(cutsOf(h), [[0, 500], [500, 1500], [1500, 1800]]);
  assert.deepEqual(pressedIndexes(h), [2], '每次切分都自动选中右侧块');

  h.segments()[1].click();                       // 选中中间那段（原第 2 帧的 1000ms）
  await tick();
  assert.deepEqual(pressedIndexes(h), [1]);
  assert.match(position(h), /^2\/3 · 0\.50秒/, '选中片段会把播放头挪到这块第一帧');
  assert.equal(h.node('remove').disabled, false);
  assert.match(h.node('remove').title, /删除第 2 段/);

  h.node('remove').click();
  await tick(); await tick();
  assert.match(duration(h), /共 0\.80秒 · 2 段/);
  assert.deepEqual(cutsOf(h), [[0, 500], [500, 800]], '切口前的切点不动，后面的整体前移');
  assert.match(position(h), /\/2 /, '只剩原第 1、3 帧');
  assert.match(h.node('status').textContent, /已删除片段/);
  assert.equal(h.node('undo').disabled, false);

  // 导出：只剩两帧，elapsed 从 0 起，源帧号仍是 0 与 2。
  h.calls.decode.length = 0;
  await h.editorOptions.onCommit();
  const begin = h.calls.edit.find(call => call.action === 'begin');
  assert.equal(begin.payload.frames, 2);
  assert.equal(begin.payload.durationMs, 800);
  const frames = h.calls.edit.filter(call => call.action === 'frame');
  assert.deepEqual(frames.map(call => call.payload.elapsedMs), [0, 500]);
  assert.deepEqual(h.calls.decode.slice(-2), [0, 2], '导出顺序按 sourceIndex 回原图');
});

test('首尾片段通过切分后选择删除：与中间段同样走 remove', async () => {
  const h = await open(harness({ delays: [500, 1000, 300] }));
  seekTo(h, 500); h.node('split').click(); await tick();
  h.segments()[0].click(); await tick();
  h.node('remove').click(); await tick(); await tick();
  assert.match(duration(h), /共 1\.30秒 · 1 段/, '删掉首段 500ms');
  assert.deepEqual(cutsOf(h), [[0, 1300]]);
  await h.editorOptions.onCommit();
  const begin = h.calls.edit.find(call => call.action === 'begin');
  assert.equal(begin.payload.frames, 2, '剩原第 2、3 帧');
  assert.equal(begin.payload.durationMs, 1300);
});

test('全删拒绝：只剩一段时删除按钮禁用，点击也改不动时间线', async () => {
  const h = await open(harness());
  seekTo(h, 500); h.node('split').click(); await tick();
  h.segments()[0].click(); await tick();
  h.node('remove').click(); await tick(); await tick();
  assert.match(duration(h), /共 1\.30秒 · 1 段/);
  // 只剩一段：选中它也不能删。
  h.segments()[0].click(); await tick();
  assert.deepEqual(pressedIndexes(h), [0]);
  assert.equal(h.node('remove').disabled, true, '删了就没有内容了');
  assert.match(h.node('remove').title, /至少要保留 10ms/);
  const before = duration(h);
  h.node('remove').dispatch('click'); await tick();
  assert.equal(duration(h), before, '被禁的删除不能改时间线（函数层也挡）');
});

test('撤销/重做恢复切点、选中与播放头；新操作清空重做', async () => {
  const h = await open(harness());
  seekTo(h, 500); h.node('split').click(); await tick();
  seekTo(h, 1200); h.node('split').click(); await tick();
  assert.deepEqual(cutsOf(h), [[0, 500], [500, 1200], [1200, 1800]]);
  h.segments()[2].click(); await tick();
  h.node('remove').click(); await tick(); await tick();
  assert.match(duration(h), /共 1\.20秒 · 2 段/);

  h.node('undo').click(); await tick(); await tick();
  assert.match(duration(h), /共 1\.80秒 · 3 段/, '撤销回到删段前（切点都还在）');
  assert.deepEqual(cutsOf(h), [[0, 500], [500, 1200], [1200, 1800]]);
  assert.equal(h.node('redo').disabled, false);

  h.node('redo').click(); await tick(); await tick();
  assert.match(duration(h), /共 1\.20秒 · 2 段/);
  assert.equal(h.node('redo').disabled, true, '重做后没有可重做的');

  h.node('undo').click(); await tick(); await tick();
  assert.match(duration(h), /共 1\.80秒 · 3 段/);
  seekTo(h, 300); h.node('split').click(); await tick();
  assert.equal(h.node('redo').disabled, true, '新切分必须清掉重做分支');
  assert.match(duration(h), /· 4 段/);
});

test('图片编辑器状态变化经 onStateChange 刷新时间栏，函数层也不再放行', async () => {
  const h = await open(harness());
  seekTo(h, 900);
  assert.equal(h.node('split').disabled, false, '块内点可以切');
  h.node('split').click(); await tick();
  assert.equal(h.node('undo').disabled, false, '切分进了历史');
  seekTo(h, 1200);                                // 挪到不是切点的位置
  assert.equal(h.node('split').disabled, false);

  h.state.canRender = false;                      // 例如进了空间裁切、还没应用
  h.notifyEditor();                               // 图片编辑器 sync 末尾的回调
  assert.equal(h.node('split').disabled, true, '裁切未应用时不能切分');
  assert.equal(h.node('remove').disabled, true);
  assert.equal(h.node('undo').disabled, true);
  assert.equal(h.node('redo').disabled, true);
  const before = cutsOf(h);
  h.node('split').dispatch('click'); h.node('remove').dispatch('click');
  await tick();
  assert.deepEqual(cutsOf(h), before, '被禁时切分/删除都不能动时间线（函数层也挡）');
  assert.match(h.node('status').textContent, /裁切/, '并且说明原因');

  h.state.canRender = true;
  h.notifyEditor();
  assert.equal(h.node('split').disabled, false, '裁切应用/取消后立刻恢复');
  assert.equal(h.node('undo').disabled, false);

  // 回调本身在图片编辑器里被 try/catch 包住，宿主抛错不能打断编辑器。
  assert.match(IMAGE_EDITOR, /onStateChange = \(\) => \{\}/, 'createImageEditor 要接受可选 onStateChange');
  assert.match(IMAGE_EDITOR, /try \{ onStateChange\(\); \} catch \{/, 'onStateChange 必须包在 try/catch 里');
});

test('生成中禁用切分/删除/历史，且不触发导出', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await open(harness({ editGate: gate }));
  seekTo(h, 500); h.node('split').click(); await tick();
  h.segments()[1].click(); await tick();
  const before = cutsOf(h);
  h.editorOptions.onCommit();                    // 开始生成，job 挂在 begin 上
  await tick();
  assert.equal(h.node('split').disabled, true);
  assert.equal(h.node('remove').disabled, true);
  assert.equal(h.node('undo').disabled, true);
  h.node('remove').dispatch('click'); h.node('split').dispatch('click');
  await tick();
  assert.deepEqual(cutsOf(h), before, '生成中改不动时间线（函数层也挡）');
  release();
  await flush();
});

test('迟到解码撞上删段：旧结果失效，不把已删帧画回来也不改序号', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await open(harness());
  h.state.decodeGate = gate;
  h.node('next').click();                        // 解码原图第 2 帧，卡在闸门上
  await tick();
  seekTo(h, 500); h.node('split').click(); await tick();
  seekTo(h, 1500); h.node('split').click(); await tick();
  h.segments()[1].click(); await tick();          // 中间那段整段都是原第 2 帧
  h.node('remove').click(); await tick(); await tick();
  const afterRemove = h.calls.replaceFrame.length;
  h.state.decodeGate = null;
  release();
  await tick(); await tick(); await tick();
  assert.ok(h.calls.replaceFrame.length > afterRemove, '删段自己的 seek 仍然要画出新帧');
  assert.deepEqual(h.calls.replaceFrame.slice(afterRemove).filter(image => image.frameIndex === 1), [],
    '删段之后不能再把已删帧画回来');
  assert.equal(h.calls.replaceFrame.at(-1).frameIndex, 2, '切口上的帧是原图第 3 帧');
  assert.match(duration(h), /共 0\.80秒/, '时间线仍是剪后的');
  assert.match(position(h), /\/2 /, '帧数仍是剪后的两帧');
});

test('片段块：有 aria-pressed、可键盘点击、短片段也有最小宽度与时间标签', async () => {
  const h = await open(harness({ delays: [500, 1000, 300] }));
  seekTo(h, 490); h.node('split').click(); await tick();
  seekTo(h, 500); h.node('split').click(); await tick();
  const blocks = h.segments();
  assert.deepEqual(cutsOf(h), [[0, 490], [490, 500], [500, 1800]], '10ms 短块也要能单独存在');
  assert.equal(blocks.length, 3);
  assert.deepEqual(pressedIndexes(h), [2], '第二次切分后自动选中右侧新块');
  for (const block of blocks) {
    assert.equal(block.tagName, 'BUTTON', '片段块是原生按钮，可键盘激活');
    assert.match(block.getAttribute('aria-label'), /片段 \d：\d+\.\d\d–\d+\.\d\d 秒/, '块上有时间标签');
    assert.match(block.getAttribute('aria-pressed'), /^(true|false)$/, 'aria-pressed 必须是 true/false');
    // 宽度按时长占比给 flex-basis（CSSOM 赋值，页面 CSP 不允许内联 style 属性），最小宽由 CSS 保底。
    assert.match(String(block.style.flexBasis), /^calc\(\d+(\.\d+)?% - \d+(\.\d+)?px\)$/, `块宽要按占比：${block.style.flexBasis}`);
    assert.equal(block.style.flexGrow, '0');
    assert.equal(block.style.flexShrink, '0');
    assert.ok(block.querySelectorAll('span').length === 1, '块里还有起止时间文字');
  }
  blocks[1].click(); await tick();
  assert.deepEqual(pressedIndexes(h), [1]);
  assert.equal(blocks[1].getAttribute('aria-pressed'), 'true');
  assert.equal(blocks[0].getAttribute('aria-pressed'), 'false');
  // 10ms 的块也能被删除，且删完仍留 ≥10ms。
  h.node('remove').click(); await tick(); await tick();
  assert.match(duration(h), /共 1\.79秒 · 2 段/);
});

test('播放中点切分：先停表再判定，不会插出重复切点', async () => {
  const h = await open(harness());
  seekTo(h, 500); h.node('split').click(); await tick();      // cuts [0,500,1800]
  seekTo(h, 300); await tick();                               // 播放头停在块内 300
  h.state.now = 500;
  h.node('play').click(); await tick();                       // playOrigin = 500-300 = 200
  assert.equal(h.node('play').textContent, '暂停');
  h.state.now = 700; h.tickClock(); await tick();             // 时钟走到 500 —— 正好是已有切点
  assert.equal(h.node('split').disabled, true, 'DOM 上也先挡住（此时头就在切点上）');
  // 绕过 DOM 禁用，验函数层：先 pause 再判定，绝不拿旧头插入重复切点。
  h.node('split').dispatch('click'); await tick();
  assert.deepEqual(cutsOf(h), [[0, 500], [500, 1800]], '不能插出重复切点');
  assert.match(h.node('status').textContent, /已经是切点/);
  assert.equal(h.node('play').textContent, '播放', '点切分要把播放停下来');
  assert.equal(h.intervals.size, 0, '不留时钟');

  // 停在非切点的时间上仍然可以正常切。
  seekTo(h, 700); await tick();
  assert.equal(h.node('split').disabled, false);
  h.node('split').click(); await tick();
  assert.deepEqual(cutsOf(h), [[0, 500], [500, 700], [700, 1800]], '块内点可以切');
});

test('空间裁切草稿/绘制未完成时不选中片段：head 与选中都不动', async () => {
  const h = await open(harness());
  seekTo(h, 500); h.node('split').click(); await tick();
  h.segments()[0].click(); await tick();
  assert.deepEqual(pressedIndexes(h), [0]);
  const before = h.node('seek').value;
  h.state.canRender = false; h.notifyEditor();
  assert.equal(h.segments()[1].disabled, true, '片段按钮也要禁用');
  h.segments()[1].dispatch('click'); await tick();             // 绕过 DOM 禁用，验函数层
  assert.deepEqual(pressedIndexes(h), [0], '选中不能变');
  assert.equal(h.node('seek').value, before, '播放头不能动');
  assert.match(h.node('status').textContent, /裁切/);
});

test('生成中/裁切未完成：定位条、播放与片段全禁用，只留取消生成', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await open(harness({ editGate: gate }));
  seekTo(h, 500); h.node('split').click(); await tick();
  h.editorOptions.onCommit();                                  // 开始生成，job 挂在 begin 上
  await tick();
  for (const name of ['seek', 'play', 'prev', 'next', 'split', 'remove', 'undo', 'redo']) {
    assert.equal(h.node(name).disabled, true, `${name} 生成中要禁用`);
  }
  for (const block of h.segments()) assert.equal(block.disabled, true, '片段按钮生成中也要禁用');
  assert.equal(h.node('cancel').hidden, false, '取消生成必须还能按');
  release();
  await flush();
  for (const name of ['seek', 'play', 'prev', 'next']) assert.equal(h.node(name).disabled, false, '生成完恢复');
});

test('窗口失焦：GIF 播放立即暂停且不自动续播，编辑器不关', async () => {
  const h = await open(harness());
  h.state.now = 0;
  h.node('play').click(); await tick();
  assert.equal(h.node('play').textContent, '暂停');
  h.emitWindow('blur'); await tick();
  assert.equal(h.node('play').textContent, '播放', '失焦就暂停');
  assert.equal(h.intervals.size, 0, '时钟要被清掉');
  assert.equal(h.controller.isOpen, true, '只暂停，不关编辑器');
  const frozen = h.node('seek').value;
  h.state.now = 1500; await tick();
  assert.equal(h.node('seek').value, frozen, '失焦后不再推进播放头、也不自动续播');
  assert.equal(h.node('play').textContent, '播放');
});

test('播放中不重建片段节点：焦点与块对象保持不变', async () => {
  const h = await open(harness());
  seekTo(h, 500); h.node('split').click(); await tick();
  seekTo(h, 1200); h.node('split').click(); await tick();
  const first = h.segments()[1];
  first.focus();
  h.node('play').click(); await tick();
  for (const now of [100, 300, 700, 1500]) { h.state.now = now; h.tickClock(); await tick(); }
  assert.equal(h.segments()[1], first, '每 tick 只能改属性，不能重建片段');
  assert.equal(h.document.activeElement, first, '焦点不能被刷新抢走');
  h.node('play').click(); await tick();
});

test('重新打开新源会清空切点、选中与历史', async () => {
  const h = await open(harness());
  seekTo(h, 500); h.node('split').click(); await tick();
  assert.equal(cutsOf(h).length, 2);
  await open(h);
  assert.deepEqual(cutsOf(h), [[0, 1800]], '新源重新从一整段开始');
  assert.deepEqual(pressedIndexes(h), []);
  assert.equal(h.node('undo').disabled, true);
  assert.equal(h.node('redo').disabled, true);
  assert.match(duration(h), /共 1\.80秒 · 1 段/);
});

// —— 上方播放进度条上的切点层：只画不点，百分比与播放头同坐标 ——
test('切点层：刚打开没有内部切点就是空层，轨道高亮也隐藏', async () => {
  const h = await open(harness());
  assert.equal(cutMarks(h).length, 0, '没有切点就不该有切线节点');
  assert.equal(h.node('cutLayer').innerHTML, '', '空层不残留旧内容');
  assert.equal(pickState(h).hidden, true, '没选中片段就不画轨道高亮');
  // 切点层必须独立且不吃指针：seek 的点击、拖动与键盘才不被挡。
  assert.match(CSS, /\.ge-cut-layer\{[^}]*pointer-events:none/, '切点层要 pointer-events:none');
  assert.match(CSS, /\.ge-pick\{[^}]*pointer-events:none/, '高亮层也不能挡拖动');
  assert.ok(h.node('rail').querySelector('[data-ge="cutLayer"]'), '切点层在定位轨道里，跟着轨道量宽度');
});

test('切点层：按 ms/总长 精确落位、秒数写进标签，不内联 style', async () => {
  const h = await open(harness());
  seekTo(h, 500); h.node('split').click(); await tick();
  seekTo(h, 1200); h.node('split').click(); await tick();
  const marks = cutMarks(h);
  assert.equal(marks.length, 2, '两个内部切点（首尾不算切点）');
  near(cutLefts(h)[0], 500 / 1800 * 100, '500ms 的百分比');
  near(cutLefts(h)[1], 1200 / 1800 * 100, '1200ms 的百分比');
  assert.deepEqual(cutLabels(h).map(label => label.textContent), ['0.50', '1.20'], '标签是秒数');
  // 与播放头同一套坐标：头在 900 时，两个切点分别在它两边。
  seekTo(h, 900); await tick();
  const head = Number.parseFloat(h.node('playhead').style.left);
  near(head, 900 / 1800 * 100, '播放头百分比');
  assert.ok(cutLefts(h)[0] < head && cutLefts(h)[1] > head, '切点与播放头坐标一致');
  assert.equal(Number(h.node('seek').value), 900, '切点层不能拦掉定位');
  assert.match(h.node('cutLayer').innerHTML, /ge-cut-line/, '切线在标记里');
  assert.doesNotMatch(h.node('cutLayer').innerHTML, /style=/, '位置靠 CSSOM 赋值，不写内联 style（CSP）');
});

test('轨道底部高亮：跟下方片段条的选中同步，无选中就收起', async () => {
  const h = await open(harness());
  seekTo(h, 500); h.node('split').click(); await tick();
  seekTo(h, 1200); h.node('split').click(); await tick();
  h.segments()[1].click(); await tick();                 // 选中 500–1200
  let pick = pickState(h);
  assert.equal(pick.hidden, false, '选中了就要高亮');
  near(pick.left, 500 / 1800 * 100, '高亮起点');
  near(pick.width, 700 / 1800 * 100, '高亮宽度按时长占比');
  h.segments()[0].click(); await tick();                 // 换到首段 0–500
  pick = pickState(h);
  near(pick.left, 0, '首段从 0 起');
  near(pick.width, 500 / 1800 * 100, '首段宽度');
  await open(h);                                        // 新源无选中
  assert.equal(pickState(h).hidden, true, '没选中就收起轨道高亮');
});

test('删段后切点与高亮一起按新总长重算，撤销/重做把两者一起还原', async () => {
  const h = await open(harness());
  seekTo(h, 500); h.node('split').click(); await tick();
  seekTo(h, 1200); h.node('split').click(); await tick();
  h.segments()[1].click(); await tick();
  h.node('remove').click(); await tick(); await tick();
  assert.equal(cutMarks(h).length, 1, '切口两侧的切点合成一条');
  near(cutLefts(h)[0], 500 / 1100 * 100, '百分比按剪后总长重算');
  assert.equal(cutMarks(h)[0].dataset.at, '500', '切点毫秒值不变');
  let pick = pickState(h);
  near(pick.left, 500 / 1100 * 100, '高亮起点跟着新时间线');
  near(pick.width, 600 / 1100 * 100, '高亮宽度跟着新时间线');

  h.node('undo').click(); await tick(); await tick();
  assert.equal(cutMarks(h).length, 2, '撤销把两个切点还回来');
  near(cutLefts(h)[0], 500 / 1800 * 100, '撤销后按原总长算');
  near(cutLefts(h)[1], 1200 / 1800 * 100, '撤销后按原总长算');
  pick = pickState(h);
  near(pick.width, 700 / 1800 * 100, '撤销后高亮回到原片段');

  h.node('redo').click(); await tick(); await tick();
  assert.equal(cutMarks(h).length, 1, '重做再剪一遍');
  near(cutLefts(h)[0], 500 / 1100 * 100, '重做后同样按剪后总长算');
});

test('重新打开新源：切点层与轨道高亮一起清空，不留上一份时间线', async () => {
  const h = await open(harness());
  seekTo(h, 500); h.node('split').click(); await tick();
  h.segments()[1].click(); await tick();
  assert.equal(cutMarks(h).length, 1);
  assert.equal(pickState(h).hidden, false);
  await open(h);
  assert.equal(cutMarks(h).length, 0, '新源没有内部切点');
  assert.equal(pickState(h).hidden, true, '高亮不能留');
  assert.equal(h.node('cutLayer').dataset.key, '0,1800|1800', '缓存键跟着新时间线重置');
});

test('播放时切点节点不重建：tick 只挪播放头', async () => {
  const h = await open(harness());
  seekTo(h, 500); h.node('split').click(); await tick();
  seekTo(h, 1200); h.node('split').click(); await tick();
  const before = cutMarks(h), key = h.node('cutLayer').dataset.key;
  h.node('play').click(); await tick();
  for (const now of [100, 400, 900, 1600]) { h.state.now = now; h.tickClock(); await tick(); }
  const after = cutMarks(h);
  assert.equal(after.length, 2, '切点一条不少');
  assert.equal(after[0], before[0], '切点节点必须是同一个对象');
  assert.equal(after[1], before[1], '切点节点必须是同一个对象');
  assert.equal(h.node('cutLayer').dataset.key, key, '键不变就不重算');
  h.node('play').click(); await tick();
});

test('切点挤在一起时只藏秒数标签，切线一条不少，两端标签改对齐不越界', async () => {
  const h = await open(harness());
  seekTo(h, 10); h.node('split').click(); await tick();
  seekTo(h, 20); h.node('split').click(); await tick();   // 10ms 与 20ms 挨着
  seekTo(h, 1790); h.node('split').click(); await tick();
  const marks = cutMarks(h), labels = cutLabels(h);
  assert.equal(marks.length, 3, '贴得再紧也要画三条切线');
  assert.deepEqual(labels.map(label => label.textContent), ['0.01', '0.02', '1.79']);
  assert.equal(labels[0].hidden, false, '第一个标签照留');
  assert.equal(labels[1].hidden, true, '挤到看不见就藏标签');
  assert.equal(labels[2].hidden, false, '不挨着的标签照留');
  assert.equal(marks[0].dataset.align, 'start', '贴近左端改左对齐，不越出轨道');
  assert.equal(marks[2].dataset.align, 'end', '贴近右端改右对齐，不越出轨道');
  assert.equal(marks[1].dataset.align, undefined, '藏了标签就不用再排序对齐');
  for (const mark of marks) assert.ok(String(mark.style.left).endsWith('%'), '每条切线都要有位置');
});
