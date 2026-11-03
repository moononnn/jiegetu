'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));

const RECORDER_IDS = ['record', 'preview', 'mode', 'timer', 'stop', 'cancel', 'record-retry', 'size', 'message',
  'image', 'preview-status', 'save', 'save-as', 'copy', 'retry', 'close', 'edit', 'gif-editor'];

// 最小 fake DOM：只有本页会用到的查询、事件、hidden/textContent/disabled 与 img.src。
function recorderHarness({ status = { mode: 'starting' }, readyFails = false, actionFails = false, actionGate, withBridge = true, editor = null, editable = false } = {}) {
  const nodes = Object.fromEntries(RECORDER_IDS.map(id => [id, {
    hidden: ['preview', 'timer', 'stop', 'record-retry'].includes(id), style: {}, textContent: '', disabled: false, src: '',
    attributes: {}, listeners: {},
    removeAttribute(name) { delete this.attributes[name]; if (name === 'src') this.src = ''; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    click() { return this.listeners.click?.(); }
  }]));
  const order = [], actions = [], revokes = [], blobs = [], statusHandlers = [], previewHandlers = [];
  const windowListeners = new Map();
  const bridge = {
    ready: () => { order.push('ready'); return readyFails ? Promise.reject(new Error('SECRET_READY')) : Promise.resolve(status); },
    action: async value => { actions.push(value); if (actionGate) await actionGate; if (actionFails) throw new Error('SECRET_ACTION'); return { ok: true }; },
    onStatus: fn => { order.push('onStatus'); statusHandlers.push(fn); return () => {}; },
    onPreview: fn => { order.push('onPreview'); previewHandlers.push(fn); return () => {}; }
  };
  const document = { querySelector: selector => nodes[selector.slice(1)], addEventListener(type, fn) { windowListeners.set(`document:${type}`, fn); } };
  const url = { createObjectURL: blob => { blobs.push(blob); return `blob:gif-${blobs.length}`; }, revokeObjectURL: value => revokes.push(value) };
  class FakeBlob { constructor(parts, options) { this.parts = parts; this.type = options?.type; } }
  const window = { addEventListener: (type, fn) => windowListeners.set(type, fn) };
  if (withBridge) window.gifRecorder = bridge;
  if (editable) { bridge.edit=async()=>({token:'token'}); window.ImageDecoder=function(){}; }
  if (editor) window.createGifEditor=options=> { editor.options=options; return editor; };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/gif-recorder.js'), 'utf8'), {
    document, window, Blob: FakeBlob, URL: url, location: { search: '' }, console
  });
  return { nodes, order, actions, revokes, blobs, windowListeners,
    emitStatus: value => statusHandlers.forEach(fn => fn(value)),
    emitPreview: value => previewHandlers.forEach(fn => fn(value)),
    keydown: (key, extra = {}) => {
      const event = { key, repeat: false, prevented: 0, preventDefault() { this.prevented += 1; }, ...extra };
      windowListeners.get('document:keydown')?.(event);
      return event;
    } };
}

test('先订阅再 ready；ready 只回当前状态，录制中显示源时长与选区尺寸', async () => {
  const h = recorderHarness({ status: { mode: 'recording', elapsedMs: 65_000, width: 640, height: 400 } });
  await tick();
  assert.deepEqual(h.order, ['onStatus', 'onPreview', 'ready'], '订阅必须早于 ready');
  assert.equal(h.nodes.mode.textContent, '录制中');
  assert.equal(h.nodes.timer.hidden, false);
  assert.equal(h.nodes.timer.textContent, '01:05', '用源实际 elapsed 的 mm:ss');
  assert.equal(h.nodes.size.textContent, '640 × 400 像素');
  assert.equal(h.nodes.stop.hidden, false);
  assert.equal(h.nodes.stop.disabled, false);
  assert.equal(h.nodes.cancel.hidden, false);
  assert.equal(h.nodes.preview.hidden, true);
});

test('准备中与生成中：停止隐藏、只留取消，取消仍能按', async () => {
  const h = recorderHarness({ status: { mode: 'starting' } });
  await tick();
  assert.equal(h.nodes.mode.textContent, '准备中…');
  assert.equal(h.nodes.timer.hidden, true);
  assert.equal(h.nodes.stop.hidden, true);
  assert.equal(h.nodes.cancel.hidden, false);
  assert.equal(h.nodes.cancel.disabled, false);
  h.emitStatus({ mode: 'finishing', elapsedMs: 12_000 });
  assert.equal(h.nodes.mode.textContent, '正在生成 GIF…');
  assert.equal(h.nodes.stop.hidden, true);
  assert.equal(h.nodes.cancel.disabled, false, '生成中仍可取消，交给主进程判断');
  assert.equal(h.nodes.timer.textContent, '00:12', '生成中保留最后的时长');
});

test('preview 只认有界 Uint8Array：合法就换成 blob 并显示尺寸/时长/体积', async () => {
  const h = recorderHarness({ status: { mode: 'finishing', width: 640, height: 400 } });
  await tick();
  const bytes = new Uint8Array(1024 * 512);
  h.emitPreview({ bytes, width: 640, height: 400, elapsedMs: 12_000 });
  assert.equal(h.nodes.record.hidden, true);
  assert.equal(h.nodes.preview.hidden, false);
  assert.equal(h.blobs.length, 1);
  assert.equal(h.blobs[0].type, 'image/gif', 'Blob 必须是 image/gif');
  assert.match(h.nodes.image.src, /^blob:/);
  assert.match(h.nodes['preview-status'].textContent, /640 × 400 像素/);
  assert.match(h.nodes['preview-status'].textContent, /00:12/);
  assert.match(h.nodes['preview-status'].textContent, /MiB/);
  assert.equal(h.nodes.save.disabled, false);
  assert.equal(h.nodes.retry.disabled, false);
  assert.equal(h.nodes.close.disabled, false);
});

test('preview 入参不合规时不换图、不切页', async () => {
  const h = recorderHarness({ status: { mode: 'finishing', width: 640, height: 400 } });
  await tick();
  const tooBig = new Uint8Array(48 * 1024 * 1024 + 1);
  const cases = [null, 'bytes', { bytes: [1, 2, 3], width: 640, height: 400 },
    { bytes: new Uint8Array(0), width: 640, height: 400 },
    { bytes: tooBig, width: 640, height: 400 },
    { bytes: new Uint8Array(8), width: 0, height: 400 },
    { bytes: new Uint8Array(8), width: 640, height: 4097 },
    { bytes: new Uint8Array(8), width: 2001, height: 2000 }];
  for (const value of cases) h.emitPreview(value);
  assert.equal(h.nodes.preview.hidden, true, '不合规的 GIF 不进预览');
  assert.equal(h.blobs.length, 0);
  assert.equal(h.nodes.image.src, '');
});

test('saving：预览区按钮全禁用并说明正在保存', async () => {
  const h = recorderHarness({ status: { mode: 'finishing', width: 640, height: 400 } });
  await tick();
  h.emitPreview({ bytes: new Uint8Array(64), width: 640, height: 400, elapsedMs: 5_000 });
  h.emitStatus({ mode: 'saving', width: 640, height: 400 });
  assert.equal(h.nodes.preview.hidden, false);
  for (const id of ['save', 'save-as', 'copy', 'edit', 'retry', 'close']) assert.equal(h.nodes[id].disabled, true, `${id} 要禁用`);
  assert.match(h.nodes['preview-status'].textContent, /正在保存/);
});

test('重新录制先回收 Blob URL 与图片，再请主进程重来', async () => {
  const h = recorderHarness({ status: { mode: 'finishing', width: 640, height: 400 } });
  await tick();
  h.emitPreview({ bytes: new Uint8Array(64), width: 640, height: 400, elapsedMs: 5_000 });
  const firstUrl = h.nodes.image.src;
  await h.nodes.retry.click();
  assert.deepEqual(h.revokes, [firstUrl], '旧 URL 必须先 revoke');
  assert.equal(h.nodes.image.src, '');
  assert.deepEqual(h.actions, ['retry']);
  assert.equal(h.nodes.preview.hidden, true);
});

test('动作失败给出可读错误，按钮不会永远 busy', async () => {
  const h = recorderHarness({ status: { mode: 'recording' }, actionFails: true });
  await tick();
  await h.nodes.stop.click();
  assert.deepEqual(h.actions, ['stop']);
  assert.match(h.nodes.message.textContent, /操作未完成/);
  assert.match(h.nodes.message.textContent, /SECRET_ACTION/, '主进程给的原因要原样可读');
  assert.equal(h.nodes.stop.disabled, false);
  assert.equal(h.nodes.cancel.disabled, false);
  await h.nodes.cancel.click();
  assert.equal(h.actions.length, 2, '失败后还能继续操作');
});

test('重录失败不会把页面卡在准备中：回到错误态并留出口', async () => {
  const h = recorderHarness({ status: { mode: 'finishing', width: 640, height: 400 }, actionFails: true });
  await tick();
  h.emitPreview({ bytes: new Uint8Array(64), width: 640, height: 400, elapsedMs: 5_000 });
  await h.nodes.retry.click();
  assert.deepEqual(h.actions, ['retry']);
  assert.equal(h.nodes.mode.textContent, '录制未完成');
  assert.equal(h.nodes['record-retry'].hidden, false, '还能再重录');
  assert.equal(h.nodes.cancel.hidden, false);
  assert.match(h.nodes.message.textContent, /操作未完成/);
});

test('防动作连发：第一次未回包前再点不再发', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = recorderHarness({ status: { mode: 'finishing', width: 640, height: 400 }, actionGate: gate });
  await tick();
  h.emitPreview({ bytes: new Uint8Array(64), width: 640, height: 400, elapsedMs: 5_000 });
  const first = h.nodes.save.click();
  const second = h.nodes.save.click();
  await tick();
  assert.deepEqual(h.actions, ['save-quick']);
  release();
  await first; await second;
});

test('Esc：录制中停止、预览中关闭，其余阶段不发动作', async () => {
  const recording = recorderHarness({ status: { mode: 'recording' } });
  await tick();
  const escape = recording.keydown('Escape');
  assert.deepEqual(recording.actions, ['stop']);
  assert.equal(escape.prevented, 1);

  const preview = recorderHarness({ status: { mode: 'finishing', width: 640, height: 400 } });
  await tick();
  preview.emitPreview({ bytes: new Uint8Array(64), width: 640, height: 400, elapsedMs: 5_000 });
  preview.keydown('Escape');
  assert.deepEqual(preview.actions, ['cancel']);

  const starting = recorderHarness({ status: { mode: 'starting' } });
  await tick();
  starting.keydown('Escape');
  const saving = recorderHarness({ status: { mode: 'saving' } });
  await tick();
  saving.keydown('Escape');
  assert.deepEqual(starting.actions, []);
  assert.deepEqual(saving.actions, [], '准备/保存阶段不抢主进程判断');
});

test('换图与关页都会回收 Blob URL', async () => {
  const h = recorderHarness({ status: { mode: 'finishing', width: 640, height: 400 } });
  await tick();
  h.emitPreview({ bytes: new Uint8Array(64), width: 640, height: 400, elapsedMs: 5_000 });
  const first = h.nodes.image.src;
  h.emitPreview({ bytes: new Uint8Array(128), width: 320, height: 200, elapsedMs: 8_000 });
  assert.deepEqual(h.revokes, [first], '换图先回收上一段');
  const last = h.nodes.image.src;
  h.windowListeners.get('beforeunload')?.();
  assert.deepEqual(h.revokes, [first, last], '关页回收当前 URL');
});

test('没有录制桥时明确报错，不装作可用', async () => {
  const h = recorderHarness({ withBridge: false });
  await tick();
  assert.match(h.nodes.message.textContent, /未能连接主进程/);
  assert.equal(h.nodes.mode.textContent, '录制未完成');
  await h.nodes.cancel.click();
  assert.deepEqual(h.actions, []);
});

test('录制页只用 blob 图片与 textContent：源码无 innerHTML/fetch，CSP 收紧', () => {
  const script = fs.readFileSync(path.join(__dirname, '../renderer/gif-recorder.js'), 'utf8');
  assert.doesNotMatch(script, /innerHTML|outerHTML/);
  assert.doesNotMatch(script, /fetch\(|XMLHttpRequest|ipcRenderer/);
  const html = fs.readFileSync(path.join(__dirname, '../renderer/gif-recorder.html'), 'utf8');
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src blob: data:; object-src 'none'; base-uri 'none'/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)/, '不写内联脚本');
  assert.doesNotMatch(html, /\sstyle="/, '不写内联样式');
  const css = fs.readFileSync(path.join(__dirname, '../renderer/gif-recorder.css'), 'utf8');
  assert.match(css, /\[hidden\]\{display:none!important\}/);
  assert.match(css, /#image\{[^}]*object-fit:contain/);
});

test('保存失败：图不丢、预览不切走，错误写在可见的预览状态里', async () => {
  const h = recorderHarness({ status: { mode: 'finishing', width: 640, height: 400 }, actionFails: true });
  await tick();
  h.emitPreview({ bytes: new Uint8Array(256), width: 640, height: 400, elapsedMs: 9_000 });
  const src = h.nodes.image.src;
  assert.match(src, /^blob:/);
  await h.nodes.save.click();
  assert.deepEqual(h.actions, ['save-quick']);
  // 保存被主进程拒了也不能把预览换成错误页：图与页都要留在原处。
  assert.equal(h.nodes.image.src, src, 'GIF 不能被清掉');
  assert.equal(h.nodes.preview.hidden, false, '失败后仍在预览');
  assert.equal(h.nodes.record.hidden, true);
  assert.equal(h.nodes.mode.textContent, 'GIF 预览', '不进错误态');
  assert.match(h.nodes['preview-status'].textContent, /操作未完成/);
  assert.match(h.nodes['preview-status'].textContent, /640 × 400 像素/, '体积与尺寸照旧可见');
  assert.equal(h.nodes.message.textContent.includes('操作未完成'), false, '隐藏的录制段不承担这条提示');
  assert.equal(h.nodes.save.disabled, false, '还能再点保存');
  assert.equal(h.nodes.retry.disabled, false);
  assert.deepEqual(h.revokes, [], '失败不能回收当前 GIF');
});

test('取消保存：保留预览与图，主进程消息显示在预览状态里', async () => {
  const h = recorderHarness({ status: { mode: 'finishing', width: 640, height: 400 } });
  await tick();
  h.emitPreview({ bytes: new Uint8Array(256), width: 640, height: 400, elapsedMs: 9_000 });
  const src = h.nodes.image.src;
  h.emitStatus({ mode: 'saving', width: 640, height: 400 });
  assert.match(h.nodes['preview-status'].textContent, /正在保存/);
  assert.equal(h.nodes.image.src, src, '保存中图仍在');
  h.emitStatus({ mode: 'preview', message: '已取消保存，GIF 预览仍保留', width: 640, height: 400 });
  assert.equal(h.nodes.preview.hidden, false);
  assert.equal(h.nodes.image.src, src);
  assert.match(h.nodes['preview-status'].textContent, /已取消保存/);
  assert.match(h.nodes['preview-status'].textContent, /640 × 400 像素/);
  assert.equal(h.nodes.save.disabled, false, '取消后可以再保存');
  assert.deepEqual(h.revokes, []);
});

test('编辑按钮需要 sourceId 和能力；编辑中 Esc 不关闭录制窗口，新成品 reset 不 abort', async()=> {
  const editor={isOpen:false,busy:false,resetCalls:[],reset(options){this.isOpen=false;this.resetCalls.push(options);},async open(source){this.source=source;this.isOpen=true;}};
  const h=recorderHarness({editor,editable:true}); await tick();
  h.emitPreview({bytes:new Uint8Array(64),width:20,height:20});
  assert.equal(h.nodes.edit.disabled,true,'旧 preview 无 sourceId 仍可保存但不能编辑');
  assert.equal(h.nodes.save.disabled,false);
  h.emitPreview({sourceId:'source-1',bytes:new Uint8Array(64),width:20,height:20});
  assert.equal(h.nodes.edit.disabled,false);
  await h.nodes.edit.click();
  assert.equal(editor.source.sourceId,'source-1'); assert.equal(editor.source.bytes.length,64);
  h.keydown('Escape'); assert.deepEqual(h.actions,[],'编辑器独占 Esc');
  assert.equal(h.nodes.preview.hidden,true);
  h.emitPreview({sourceId:'source-2',bytes:new Uint8Array(80),width:10,height:10});
  assert.equal(editor.isOpen,false); assert.equal(editor.resetCalls.at(-1).committed,true);
  assert.equal(h.nodes.preview.hidden,false);
});

test('缺少原生解码或编辑桥时禁编辑，不影响保存',async()=> {
  const h=recorderHarness(); await tick();
  h.emitPreview({sourceId:'source',bytes:new Uint8Array(64),width:20,height:20});
  assert.equal(h.nodes.edit.disabled,true); assert.equal(h.nodes.save.disabled,false);
});

test('三出口按保存/另存/复制映射，失败保图，复制忙态不误报保存', async () => {
  for (const [id, action] of [['save', 'save-quick'], ['save-as', 'save'], ['copy', 'copy']]) {
    const h = recorderHarness({ actionFails: true }); await tick();
    h.emitPreview({ bytes: new Uint8Array(64), width: 20, height: 20 });
    const src = h.nodes.image.src;
    await h.nodes[id].click();
    assert.deepEqual(h.actions, [action]);
    assert.equal(h.nodes.image.src, src); assert.equal(h.nodes.preview.hidden, false);
    assert.match(h.nodes['preview-status'].textContent, /操作未完成/);
    assert.equal(h.nodes[id].disabled, false);
  }
  const h = recorderHarness(); await tick();
  h.emitPreview({ bytes: new Uint8Array(64), width: 20, height: 20 });
  const src = h.nodes.image.src;
  h.emitStatus({ mode: 'saving', message: '正在复制 GIF…' });
  assert.match(h.nodes['preview-status'].textContent, /正在复制 GIF/);
  assert.doesNotMatch(h.nodes['preview-status'].textContent, /正在保存/);
  for (const id of ['save', 'save-as', 'copy', 'edit', 'retry', 'close']) assert.equal(h.nodes[id].disabled, true);
  await h.nodes.retry.click(); await h.nodes.copy.click();
  assert.equal(h.nodes.image.src, src); assert.deepEqual(h.actions, []);
  const html = fs.readFileSync(path.join(__dirname, '../renderer/gif-recorder.html'), 'utf8');
  assert.ok(html.indexOf('id="save-as"') < html.indexOf('id="save"'));
  assert.ok(html.indexOf('id="save"') < html.indexOf('id="copy"'));
});

test('状态/预览先到不能放开未回包动作的互斥', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = recorderHarness({ actionGate: gate }); await tick();
  h.emitPreview({ bytes: new Uint8Array(64), width: 20, height: 20 });
  const task = h.nodes.copy.click();
  h.emitStatus({ mode: 'preview', message: '预览保留' });
  h.emitPreview({ bytes: new Uint8Array(64), width: 20, height: 20 });
  await h.nodes['save-as'].click(); await h.nodes.retry.click();
  assert.deepEqual(h.actions, ['copy']); assert.equal(h.nodes.copy.disabled, true);
  release(); await task; assert.equal(h.nodes.copy.disabled, false);
});

// —— 录制范围边框：静态色条（历史 gif-border.js 已无生产入口，仅留存与旧安全断言）——
function borderHarness({ search, width = 1000, height = 800, position = 'fixed' } = {}) {
  const created = [];
  let children = [];
  const document = {
    createElement: () => { const node = { className: '', style: {} }; created.push(node); return node; },
    body: { replaceChildren: (...nodes) => { children = nodes; } }
  };
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/gif-border.js'), 'utf8'), {
    document, window, location: { search: search ?? '' }, URLSearchParams,
    innerWidth: width, innerHeight: height,
    getComputedStyle: () => ({ position }), console
  });
  return { window, created, children: () => children };
}
const borderLayout = (frame, pixels) => `layout=${encodeURIComponent(JSON.stringify({ frame, pixels }))}`;

test('边框：物理像素按本页视口比例投影成 2px 框，并标记就绪', () => {
  const h = borderHarness({ search: borderLayout({ width: 1920, height: 1080 }, { x: 100, y: 50, width: 640, height: 400 }) });
  assert.equal(h.window.gifBorderReady, true);
  assert.equal(h.children().length, 1);
  const border = h.children()[0];
  assert.equal(border.className, 'border');
  const near = (actual, expected) => assert.ok(Math.abs(parseFloat(actual) - expected) < 1e-6, `${actual} ≈ ${expected}`);
  near(border.style.left, 100 * 1000 / 1920);
  near(border.style.top, 50 * 800 / 1080);
  near(border.style.width, 640 * 1000 / 1920);
  near(border.style.height, 400 * 800 / 1080);
});

test('边框：不可信布局一律不显示、不就绪', () => {
  const cases = [
    '', 'layout=', 'layout=%7Bbad', borderLayout({ width: 0, height: 1080 }, { x: 0, y: 0, width: 10, height: 10 }),
    borderLayout({ width: 1.5, height: 1080 }, { x: 0, y: 0, width: 10, height: 10 }),
    borderLayout({ width: 1920, height: 1080 }, { x: -1, y: 0, width: 10, height: 10 }),
    borderLayout({ width: 1920, height: 1080 }, { x: 1900, y: 0, width: 100, height: 10 }),
    borderLayout({ width: 1920, height: 1080 }, { x: 0, y: 0, width: 4097, height: 10 }),
    borderLayout({ width: 1920, height: 1080 }, { x: 0, y: 0, width: 2001, height: 2000 }),
    borderLayout({ width: 1920, height: 1080 }, { x: 0, y: 0, width: 0, height: 10 })
  ];
  for (const search of cases) {
    const h = borderHarness({ search });
    assert.equal(h.window.gifBorderReady, false, search);
    assert.equal(h.created.length, 0, `不画框：${search}`);
  }
  const notFixed = borderHarness({ search: borderLayout({ width: 1920, height: 1080 }, { x: 0, y: 0, width: 100, height: 100 }), position: 'absolute' });
  assert.equal(notFixed.window.gifBorderReady, false, '样式没加载就不算就绪');
});

test('边框页是纯静态色条：无脚本、无 IPC、无网络、不再整屏铺一层', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/gif-border.html'), 'utf8');
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script/i, '页面不再加载任何脚本');
  assert.doesNotMatch(html, /gif-border\.js/, '旧整屏投影脚本不再被引用');
  assert.doesNotMatch(html, /ipcRenderer|require\(|fetch\(|XMLHttpRequest/);
  const css = fs.readFileSync(path.join(__dirname, '../renderer/gif-border.css'), 'utf8');
  assert.match(css, /background:#63ad8b/, '实体浅绿与控制条背景同色系');
  assert.doesNotMatch(css, /position:fixed|pointer-events:auto/, '不再整屏铺一层可交互遮罩');
  assert.doesNotMatch(css, /rgba\(10,31,25/, '不能有压暗层');
  // 主进程里的实体色必须与页面色一致，否则两条色条会跟窗口底色脱节。
  const recording = fs.readFileSync(path.join(__dirname, '../main/recording.cjs'), 'utf8');
  assert.match(recording, /const BORDER_COLOR = '#63ad8b'/);
  // 历史脚本仍然不请求 IPC、不联网、不拼 HTML。
  const legacy = fs.readFileSync(path.join(__dirname, '../renderer/gif-border.js'), 'utf8');
  assert.doesNotMatch(legacy, /ipcRenderer|require\(|fetch\(|XMLHttpRequest|innerHTML/);
});
