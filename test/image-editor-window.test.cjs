'use strict';
// 独立图片编辑宿主（main/image-editor-window.cjs）与编辑窗页面胶水（renderer/image-editor-window.js）的定向用例。
// 全部用替身：不启动真实 Electron、不建可见窗口、不读写用户文件。
// 覆盖：每文档一条记录（叠层不互相覆盖）、原生窗口选项/工作区限界、就绪握手与失败 tombstone、
// 同 token 不重载、导出请求/回包路由、原生 X 归属、异常中断后拒绝重开与导出。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const RENDERER = path.join(__dirname, '../renderer/image-editor-window.html');
const PRELOAD = path.join(__dirname, '../main/image-editor-preload.cjs');
const ICON = path.join(__dirname, '../assets/app-icon.ico');
const { FAILED_MESSAGE } = require('../main/image-editor-window.cjs');

function hostHarness({ workArea = { x: 100, y: 50, width: 1920, height: 1040 }, showFails = false, closeGate, theme, onCopyText = null, showDirectory = null, writeSegmentFile = null } = {}) {
  const handlers = new Map();
  const windows = [];
  const events = [];
  const commits = [], closes = [], exits = [];
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.visible = false;
      this.minimized = false;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.sent = [];
      this.webContents.send = (channel, payload) => { this.webContents.sent.push({ channel, payload }); };
      this.webContents.executeJavaScript = async () => ({ ready: true });
      this.loads = [];
      windows.push(this);
    }
    async loadFile(file) { this.loads.push(file); }
    // 主题只碰的纯装饰属性：记下来供断言。
    setBackgroundColor(color) { (this.backgrounds ??= []).push(color); }
    setTitleBarOverlay(options) { (this.overlays ??= []).push({ ...options }); }
    setAccentColor(color) { (this.accents ??= []).push(color); }
    show() { if (showFails) throw new Error('编辑窗无法显示'); this.visible = true; this.shows = (this.shows ?? 0) + 1; }
    hide() { this.visible = false; }
    focus() { this.focused = (this.focused ?? 0) + 1; }
    minimize() { this.minimized = true; }
    isVisible() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    crashRenderer() { this.webContents.emit('render-process-gone', {}, { reason: 'crashed' }); }
  }
  const host = require('../main/image-editor-window.cjs').installImageEditorWindow({
    BrowserWindow: Window,
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea }) },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    rendererFile: RENDERER, preloadFile: PRELOAD, iconFile: ICON, theme, onCopyText,
    onLifecycle: (event, fields) => events.push({ event, ...fields }),
    onCommit: async (action, edited, doc) => { commits.push({ action, edited, doc }); return { ok: true, action, token: edited.token }; },
    onClose: async ({ doc }) => { closes.push(doc); if (closeGate) await closeGate; return true; },
    onExit: async (doc, source) => { exits.push({ ...doc, source }); return false; },
    showDirectory,
    ...(writeSegmentFile ? { writeSegmentFile } : {})
  });
  const winFor = token => windows.find(item => (item.webContents.sent ?? []).some(entry => entry.channel === 'shot:editor-open' && entry.payload.token === token));
  const eventFor = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  const ready = (win, token) => handlers.get('shot:editor-ready')(eventFor(win), token);
  const openPayload = token => {
    const win = winFor(token);
    if (!win) return undefined;
    const entry = win.webContents.sent.filter(item => item.channel === 'shot:editor-open').at(-1);
    return entry && entry.payload;
  };
  const doc = (token, extra = {}) => ({ token, width: 400, height: 300, rect: { x: 10, y: 20, width: 200, height: 150 }, longToken: undefined, ...extra });
  return { host, handlers, windows, events, commits, closes, exits, winFor, eventFor, ready, openPayload, doc,
    lastWin: () => windows.at(-1) };
}

test('独立提取按主frame与文档token授权，复制只交文字，隐藏后失效',async()=>{
 const copied=[];const h=hostHarness({onCopyText:text=>copied.push(text)});
 const opening=h.host.open(h.doc('ocr-doc'),{dataUrl:'data:image/png;base64,src'});await new Promise(resolve=>setImmediate(resolve));const win=h.lastWin();
 const event=h.eventFor(win);assert.equal(h.host.ocrContext(event,'ocr-doc'),null,'尚未打开不接OCR');h.ready(win,'ocr-doc');await opening;
 const context=h.host.ocrContext(event,'ocr-doc');assert.equal(context,h.host.ocrContext(event,'ocr-doc'),'每文档上下文稳定');
 assert.equal(context.editDocument.token,'ocr-doc');assert.equal(h.host.ocrContext({...event,senderFrame:{}},'ocr-doc'),null);assert.equal(h.host.ocrContext(event,'wrong'),null);
 const copy=h.handlers.get('shot:editor-copy-text');assert.throws(()=>copy({...event,senderFrame:{}},{token:'ocr-doc',text:'拒绝'}),/已失效/);
 assert.throws(()=>copy(event,{token:'wrong',text:'拒绝'}),/已失效/);assert.throws(()=>copy(event,{token:'ocr-doc',text:' '}),/为空或过长/);
 assert.throws(()=>copy(event,{token:'ocr-doc',text:'字'.repeat(2001)}),/为空或过长/);assert.deepEqual(copy(event,{token:'ocr-doc',text:'测试文字'}),{ok:true});assert.deepEqual(copied,['测试文字']);
 await h.host.close('ocr-doc');assert.equal(h.host.ocrContext(event,'ocr-doc'),null);assert.throws(()=>copy(event,{token:'ocr-doc',text:'已关闭'}),/已失效/);h.host.dispose();
});

test('编辑窗在 load 前就按主题上色：背景 + 标题栏叠加 + 强调色，且只绑这一扇窗', async () => {
  const bound = [];
  const theme = { bind: (win, options) => { bound.push({ win, options }); win.setBackgroundColor('#17231f');
    win.setTitleBarOverlay({ color: '#21382d', symbolColor: '#e0eee5', height: 36 }); win.setAccentColor('#486959');
    return () => {}; } };
  const h = hostHarness({ theme });
  const opening = h.host.open(h.doc('doc-1'), { dataUrl: 'data:image/png;base64,src' });
  await new Promise(resolve => setImmediate(resolve));
  const win = h.lastWin();
  assert.equal(bound.length, 1, '建窗只绑一次');
  assert.equal(bound[0].win, win);
  assert.deepEqual(bound[0].options, { titleBarOverlay: true }, '编辑窗声明自己带标题栏叠加');
  assert.deepEqual(win.backgrounds, ['#17231f'], 'load 前已上色');
  assert.deepEqual(win.overlays, [{ color: '#21382d', symbolColor: '#e0eee5', height: 36 }]);
  assert.deepEqual(win.accents, ['#486959']);
  assert.equal(win.loads.length, 1, '绑定不影响页面加载');
  h.ready(win, 'doc-1');
  await opening;
  h.host.dispose();
});

test('编辑宿主默认不绑主题：没传 theme 时窗口保持构造参数，不调用任何装饰 setter', async () => {
  const h = hostHarness();
  const opening = h.host.open(h.doc('doc-1'), { dataUrl: 'data:image/png;base64,src' });
  await new Promise(resolve => setImmediate(resolve));
  const win = h.lastWin();
  assert.equal(win.backgrounds, undefined);
  assert.equal(win.overlays, undefined);
  h.ready(win, 'doc-1');
  await opening;
  h.host.dispose();
});

test('编辑宿主是普通窗口：frame/resizable/任务栏/不置顶/图标，初始尺寸在工作区内并居中', async () => {
  const h = hostHarness();
  const opening = h.host.open(h.doc('doc-1'), { dataUrl: 'data:image/png;base64,src' });
  await new Promise(resolve => setImmediate(resolve));
  const win = h.lastWin();
  const sent = h.openPayload('doc-1');
  assert.equal(sent.token, 'doc-1');
  assert.equal(sent.dataUrl, 'data:image/png;base64,src');
  assert.deepEqual(sent.rect, { x: 10, y: 20, width: 200, height: 150 });
  assert.equal(win.options.frame, true, '保留系统边框');
  assert.equal(win.options.titleBarStyle, 'hidden');
  assert.equal(win.options.accentColor, '#a8cbb9', '窗口细边不再沿用系统紫红强调色');
  assert.deepEqual(win.options.titleBarOverlay, { color: '#e6f1e9', symbolColor: '#244e43', height: 36 });
  assert.equal(win.options.minimizable, true);
  assert.equal(win.options.maximizable, true);
  assert.equal(win.options.closable, true);
  assert.deepEqual([...h.handlers.keys()].sort(), ['shot:editor-close', 'shot:editor-commit', 'shot:editor-copy-text', 'shot:editor-exit-request', 'shot:editor-export-reply', 'shot:editor-open-failed', 'shot:editor-ready',
    'shot:editor-segment-abort', 'shot:editor-segment-begin', 'shot:editor-segment-done', 'shot:editor-segment-part', 'shot:editor-segment-start']);
  assert.equal(win.options.resizable, true);
  assert.equal(win.options.movable, true);
  assert.equal(win.options.skipTaskbar, false, '任务栏条目');
  assert.equal(win.options.alwaysOnTop, false, '不置顶');
  assert.equal(win.options.transparent, false);
  assert.equal(win.options.title, '截个图 · 图片编辑');
  assert.equal(win.options.icon, ICON, '普通窗用应用图标');
  const workArea = { x: 100, y: 50, width: 1920, height: 1040 };
  assert.ok(win.options.width <= Math.floor(workArea.width * 0.9) && win.options.width <= 1200);
  assert.ok(win.options.height <= Math.floor(workArea.height * 0.9) && win.options.height <= 850);
  assert.ok(win.options.minWidth <= workArea.width && win.options.minHeight <= workArea.height);
  assert.equal(win.options.x + win.options.width / 2, workArea.x + workArea.width / 2);
  assert.equal(win.loads.length, 1, '页面只加载一次');
  assert.equal(win.visible, false, '就绪前不上屏');
  h.ready(win, 'doc-1');
  const result = await opening;
  assert.equal(result.token, 'doc-1');
  assert.equal(win.visible, true, '就绪后才上屏');
  assert.equal(h.host.getWindow('doc-1'), win);
});

test('独立页面标题条占安全区并让出编辑区，保留 CSP 和共享样式', () => {
  const html = fs.readFileSync(RENDERER, 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../renderer/image-editor-window.css'), 'utf8');
  const shared = fs.readFileSync(path.join(__dirname, '../renderer/image-editor.css'), 'utf8');
  assert.match(html, /Content-Security-Policy[^>]*default-src 'none'; script-src 'self'; style-src 'self'; img-src data: blob:; object-src 'none'; base-uri 'none'/);
  assert.match(html, /<body><header class="window-titlebar"><div class="window-titlebar-drag"><span class="window-titlebar-text">截个图 · 图片编辑<\/span><\/div><\/header><section id="editor-root"/);
  // 「编辑图片」不再住在标题条：它是带细边次级外形的独立按钮，由页面移进顶栏输出组。
  assert.match(html, /id="host-edit" class="ie-outline"[^>]*hidden>编辑图片<\/button>/);
  assert.match(html, /<\/section><button type="button" id="host-edit"/, '按钮在编辑器根之后定义，由页面移入输出组');
  assert.doesNotMatch(html, /window-titlebar-action/, '不再用标题条专属按钮样式');
  assert.match(css, /height:36px/);
  assert.match(css, /left:env\(titlebar-area-x, 0px\)/);
  assert.match(css, /width:env\(titlebar-area-width, calc\(100% - 140px\)\)/);
  assert.match(css, /height:min\(36px, env\(titlebar-area-height, 36px\)\)/);
  assert.match(css, /-webkit-app-region:drag/);
  assert.match(css, /#editor-root\.image-editor\{top:36px;height:auto\}/);
  // 「编辑图片」移进输出组后只补间距，外形用共享的 .ie-outline（细浅绿边纸白底）。
  assert.match(css, /\.image-editor \.ie-exports #host-edit\{margin-right:8px\}/);
  assert.match(shared, /\.image-editor\{[^}]*position:fixed;inset:0;z-index:20/);
});

test('工作区比最小尺寸还小时也不越界：初始尺寸与最小尺寸都夹在实际工作区内', async () => {
  for (const workArea of [{ x: 0, y: 0, width: 500, height: 360 }, { x: 0, y: 0, width: 200, height: 150 }]) {
    const h = hostHarness({ workArea });
    const opening = h.host.open(h.doc('doc-1'), { dataUrl: 'data:image/png;base64,src' });
    await new Promise(resolve => setImmediate(resolve));
    const win = h.lastWin();
    assert.ok(win.options.width <= workArea.width, `${workArea.width}px 屏上初始宽 ${win.options.width} 不能越界`);
    assert.ok(win.options.height <= workArea.height);
    assert.ok(win.options.minWidth <= workArea.width, `minWidth ${win.options.minWidth} 不能大于工作区 ${workArea.width}`);
    assert.ok(win.options.minHeight <= workArea.height);
    h.ready(win, 'doc-1');
    await opening;
  }
});

test('同 token 重开：只发元数据、不重载页面、不带原图', async () => {
  const h = hostHarness();
  const first = h.host.open(h.doc('doc-1'), { dataUrl: 'data:image/png;base64,src' });
  await new Promise(resolve => setImmediate(resolve));
  h.ready(h.lastWin(), 'doc-1');
  await first;
  assert.equal(await h.host.close('doc-1'), true);
  assert.equal(h.lastWin().visible, false, '返回预览只收起');
  const second = h.host.open(h.doc('doc-1'), {});
  await new Promise(resolve => setImmediate(resolve));
  h.ready(h.lastWin(), 'doc-1');
  await second;
  const payloads = h.lastWin().webContents.sent.filter(item => item.channel === 'shot:editor-open').map(item => item.payload);
  assert.equal(payloads.length, 2);
  assert.equal('dataUrl' in payloads[1], false, '同 token 不再传原图');
  assert.equal(h.lastWin().loads.length, 1, '不重载页面');
  assert.equal(h.lastWin().visible, true);
});

test('页面拒绝就绪（首次初始化失败）：open 报错并整条记录收掉，换新 token 可重试', async () => {
  const h = hostHarness();
  const opening = h.host.open(h.doc('doc-1'), { dataUrl: 'data:image/png;base64,src' });
  await new Promise(resolve => setImmediate(resolve));
  const win = h.lastWin();
  h.handlers.get('shot:editor-open-failed')(h.eventFor(win), 'doc-1', '画布加载失败');
  await assert.rejects(opening, /画布加载失败/);
  assert.equal(win.destroyed, true);
  assert.equal(h.host.getWindow('doc-1'), null, '还没有可用编辑，记录不保留');
  const retry = h.host.open(h.doc('doc-2'), { dataUrl: 'data:image/png;base64,src' });
  await new Promise(resolve => setImmediate(resolve));
  h.ready(h.lastWin(), 'doc-2');
  assert.equal((await retry).token, 'doc-2');
});

test('编辑窗不能上屏：open 报错并收掉这一层，不假装已进入编辑', async () => {
  const h = hostHarness({ showFails: true });
  const opening = h.host.open(h.doc('doc-1'), { dataUrl: 'data:image/png;base64,src' });
  await new Promise(resolve => setImmediate(resolve));
  h.ready(h.lastWin(), 'doc-1');
  await assert.rejects(opening, /无法显示/);
  assert.equal(h.lastWin().destroyed, true);
  assert.equal(h.host.getWindow('doc-1'), null);
});

test('已成功编辑过的宿主中断：记 tombstone，拒绝重开与导出，绝不用原图重建', async () => {
  const h = hostHarness();
  const opening = h.host.open(h.doc('doc-1'), { dataUrl: 'data:image/png;base64,src' });
  await new Promise(resolve => setImmediate(resolve));
  const win = h.lastWin();
  h.ready(win, 'doc-1');
  await opening;
  const loadsBefore = win.loads.length;

  win.crashRenderer();
  assert.equal(h.host.isFailed('doc-1'), true);
  assert.equal(await h.host.probe('doc-1'), 'failed');
  // 重开：明确拒绝，不新建窗口、不重载、不再传源图。
  await assert.rejects(h.host.open(h.doc('doc-1'), {}), new RegExp(FAILED_MESSAGE.slice(0, 8)));
  await assert.rejects(h.host.open(h.doc('doc-1'), { dataUrl: 'data:image/png;base64,src' }), new RegExp(FAILED_MESSAGE.slice(0, 8)));
  assert.equal(h.windows.length, 1, '没有新建窗口');
  assert.equal(win.loads.length, loadsBefore, '没有重载页面');
  assert.equal(win.webContents.sent.filter(item => item.channel === 'shot:editor-open').length, 1, '没有再发一次原图');
  // 导出同样拒绝，且不会产出任何结果。
  await assert.rejects(h.host.export('doc-1', 'copy'), new RegExp(FAILED_MESSAGE.slice(0, 8)));
  // 显式放弃才清掉这一层。
  assert.equal(h.host.cleanup('doc-1'), true);
  assert.equal(h.host.getWindow('doc-1'), null);
  assert.equal(h.host.isFailed('doc-1'), false);
});

test('没有记录又没带源图：直接按“编辑页已中断”拒绝，不建空壳窗口', async () => {
  const h = hostHarness();
  await assert.rejects(h.host.open(h.doc('doc-1'), {}), new RegExp(FAILED_MESSAGE.slice(0, 8)));
  assert.equal(h.windows.length, 0);
});

test('每份文档一条记录：父子两层各自 handshake/导出，互不覆盖', async () => {
  const h = hostHarness();
  const parent = h.host.open(h.doc('p-doc'), { dataUrl: 'data:image/png;base64,parent' });
  await new Promise(resolve => setImmediate(resolve));
  const parentWin = h.lastWin();
  h.ready(parentWin, 'p-doc');
  await parent;

  const child = h.host.open(h.doc('c-doc'), { dataUrl: 'data:image/png;base64,child' });
  await new Promise(resolve => setImmediate(resolve));
  const childWin = h.lastWin();
  assert.notEqual(childWin, parentWin, '子层是自己的窗口');
  h.ready(childWin, 'c-doc');
  await child;
  assert.equal(h.windows.length, 2);

  // 子层的提交只带子层文档；父层窗口还能独立导出。
  const commit = h.handlers.get('shot:editor-commit');
  await commit(h.eventFor(childWin), 'copy', { token: 'c-doc', png: Uint8Array.of(1) });
  assert.equal(h.commits.at(-1).doc.token, 'c-doc');
  const pending = h.host.export('p-doc', 'png');
  const request = parentWin.webContents.sent.filter(item => item.channel === 'shot:editor-export').at(-1).payload;
  assert.equal(request.token, 'p-doc');
  h.handlers.get('shot:editor-export-reply')(h.eventFor(parentWin), request.id, true, { token: 'p-doc', png: Uint8Array.of(2) });
  assert.equal((await pending).token, 'p-doc');
  // 父层窗口发的导出回包不能结掉子层的请求。
  const childPending = h.host.export('c-doc', 'copy');
  const childRequest = childWin.webContents.sent.filter(item => item.channel === 'shot:editor-export').at(-1).payload;
  assert.throws(() => h.handlers.get('shot:editor-export-reply')(h.eventFor(parentWin), childRequest.id, true, {}), /导出请求已失效/);
  h.handlers.get('shot:editor-export-reply')(h.eventFor(childWin), childRequest.id, true, { token: 'c-doc' });
  await childPending;

  // 释放子层不影响父层。
  h.host.cleanup('c-doc');
  assert.equal(childWin.destroyed, true);
  assert.equal(h.host.getWindow('p-doc'), parentWin);
  assert.equal(await h.host.probe('p-doc'), 'drawable');
  h.host.dispose();
  assert.equal(parentWin.destroyed, true);
});

test('同一窗口只认自己 token：迟到的 ready 不能推进别的记录', async () => {
  const h = hostHarness();
  const first = h.host.open(h.doc('doc-1'), { dataUrl: 'data:image/png;base64,one' });
  await new Promise(resolve => setImmediate(resolve));
  const firstWin = h.lastWin();
  h.ready(firstWin, 'doc-1');
  await first;
  const second = h.host.open(h.doc('doc-2'), { dataUrl: 'data:image/png;base64,two' });
  await new Promise(resolve => setImmediate(resolve));
  const secondWin = h.lastWin();
  // 用一层的 sender 报另一层的 token：拒绝，不影响第二层握手。
  assert.throws(() => h.ready(secondWin, 'doc-1'), /已失效/);
  assert.throws(() => h.ready(firstWin, 'doc-2'), /已失效/);
  h.ready(secondWin, 'doc-2');
  assert.equal((await second).token, 'doc-2');
});

test('提交与关闭只认 sender 记录：伪 sender / 异 token 一律拒绝', async () => {
  const h = hostHarness();
  const opening = h.host.open(h.doc('doc-1'), { dataUrl: 'data:image/png;base64,src' });
  await new Promise(resolve => setImmediate(resolve));
  const win = h.lastWin();
  h.ready(win, 'doc-1');
  await opening;
  const handle = h.handlers.get('shot:editor-commit');
  await assert.rejects(handle({ sender: {}, senderFrame: {} }, 'copy', { token: 'doc-1' }), /已失效/);
  await assert.rejects(handle(h.eventFor(win), 'copy', { token: 'foreign' }), /缺失或已失效/);
  await assert.rejects(handle(h.eventFor(win), 'delete', { token: 'doc-1' }), /保存或复制/);
  const result = await handle(h.eventFor(win), 'copy', { token: 'doc-1', png: Uint8Array.of(1) });
  assert.equal(result.ok, true);
  assert.equal(h.commits.length, 1);
  // 原生 X 带的是这一层文档。
  let prevented = 0;
  win.emit('close', { preventDefault() { prevented += 1; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, 1);
  assert.equal(h.exits.at(-1).token, 'doc-1');
});

test('导出请求一次一 id：回包匹配才交付，异 id/异 sender 拒绝，收窗时在途请求被拒', async () => {
  const h = hostHarness();
  const opening = h.host.open(h.doc('doc-1'), { dataUrl: 'data:image/png;base64,src' });
  await new Promise(resolve => setImmediate(resolve));
  const win = h.lastWin();
  h.ready(win, 'doc-1');
  await opening;
  const pending = h.host.export('doc-1', 'copy');
  const request = win.webContents.sent.filter(item => item.channel === 'shot:editor-export').at(-1).payload;
  assert.equal(request.kind, 'copy');
  assert.equal(request.token, 'doc-1');
  assert.throws(() => h.handlers.get('shot:editor-export-reply')(h.eventFor(win), 'nope', true, {}), /导出请求已失效/);
  assert.throws(() => h.handlers.get('shot:editor-export-reply')({ sender: win.webContents, senderFrame: {} }, request.id, true, {}), /已失效/);
  h.handlers.get('shot:editor-export-reply')(h.eventFor(win), request.id, true, { token: 'doc-1', png: Uint8Array.of(1) });
  assert.equal((await pending).token, 'doc-1');

  const failing = h.host.export('doc-1', 'png');
  const second = win.webContents.sent.filter(item => item.channel === 'shot:editor-export').at(-1).payload;
  h.handlers.get('shot:editor-export-reply')(h.eventFor(win), second.id, false, { message: '合成失败' });
  await assert.rejects(failing, /合成失败/);

  const closing = h.host.export('doc-1', 'png');
  h.host.cleanup('doc-1');
  await assert.rejects(closing, /编辑窗口已关闭/);
  assert.equal(win.destroyed, true);
});

test('健康探针认编辑根与画布，不拿隐藏状态或其它页冒充', async () => {
  const h = hostHarness();
  const opening = h.host.open(h.doc('doc-1'), { dataUrl: 'data:image/png;base64,src' });
  await new Promise(resolve => setImmediate(resolve));
  const win = h.lastWin();
  h.ready(win, 'doc-1');
  await opening;
  assert.equal(await h.host.probe('doc-1'), 'drawable');
  win.webContents.executeJavaScript = async () => ({ ready: false });
  assert.equal(await h.host.probe('doc-1'), 'blocked');
  win.webContents.executeJavaScript = async () => { throw new Error('renderer gone'); };
  assert.equal(await h.host.probe('doc-1'), 'throw');
  win.visible = false;
  assert.equal(await h.host.probe('doc-1'), 'hidden');
  h.host.cleanup('doc-1');
  assert.equal(await h.host.probe('doc-1'), 'gone');
});

test('最多同时保留三层编辑：第四层明确拒绝，不挤掉已有记录', async () => {
  const h = hostHarness();
  for (const token of ['doc-1', 'doc-2', 'doc-3']) {
    const opening = h.host.open(h.doc(token), { dataUrl: 'data:image/png;base64,src' });
    await new Promise(resolve => setImmediate(resolve));
    h.ready(h.lastWin(), token);
    await opening;
  }
  await assert.rejects(h.host.open(h.doc('doc-4'), { dataUrl: 'data:image/png;base64,src' }), /最多同时保留 3 层/);
  assert.equal(h.windows.length, 3);
  for (const token of ['doc-1', 'doc-2', 'doc-3']) assert.equal(h.host.getWindow(token)?.destroyed, false, token);
  h.host.dispose();
});

// —— 编辑窗页面胶水：把浏览器编辑器接到受限 IPC ——
function pageHarness({ openFails = false, closeFails = false, commitResult = { ok: true }, exportFails = null, refusePreview = false, segmentOptions = null } = {}) {
  const opens = [], statuses = [], readies = [], failures = [], closed = [], commits = [], replies = [], exits = [], order = [], exportCalls = [];
  const segments = { started: [], begin: [], parts: [], done: [], abort: [] };
  const editButton = { hidden: true, addEventListener(type, fn) { this.click = fn; } };
  // 编辑器根与输出组的桩：页面建好编辑器后会把 #host-edit 插到输出组最前。
  const exportsGroup = { children: [], prepend(node) { this.children.unshift(node); } };
  const rootStub = { id: 'editor-root', querySelector: selector => (selector === '.ie-exports' ? exportsGroup : null) };
  const editorInstance = {
    isOpen: false,
    previewMode: false,
    setPreviewMode(value) {
      const on = Boolean(value);
      // 与真实引擎同语义：进入预览前如果那条批注写不完，就不切并返回当前状态。
      if (on && refusePreview) return this.previewMode;
      this.previewMode = on;
      order.push(`preview:${on}`);
      return this.previewMode;
    },
    close() { this.closeCalls = (this.closeCalls ?? 0) + 1; this.isOpen = false; if (this.onCloseHook) this.onCloseHook(); },
    async open(source) { opens.push(source); if (openFails) throw new Error('画布加载失败'); this.isOpen = true; },
    thumbnail: () => 'data:image/png;base64,thumb',
    outputSize: { width: 300, height: 200 },
    cropRect: undefined,
    async exportPNG() { if (exportFails === 'png') throw new Error('合成失败'); exportCalls.push('png'); return Uint8Array.of(137, 80); },
    async exportClipboard() {
      if (exportFails === 'copy') throw new Error('批注说明放不下');
      exportCalls.push('copy');
      return { token: 'doc-1', png: Uint8Array.of(137, 80), clipboardSize: { width: 720, height: 300 } };
    },
    setBusy() {}, setStatus(message) { statuses.push(message); }, reset() {},
    // 分段导出桩：与真实引擎同名同形；gate 用来把“编码中途”做成可控时序。
    segmentActive: false, segmentStopped: false,
    async beginSegmentExport() {
      this.segmentActive = true; this.segmentStopped = false;
      return segmentOptions?.size ?? { width: 400, height: 300 };
    },
    async exportSegment(index, top, height) {
      if (segmentOptions?.gate) await segmentOptions.gate.promise;
      if (segmentOptions?.failAt === index) throw new Error('这一段编码失败');
      return { index, png: new Uint8Array([137, 80, 78, 71]) };
    },
    endSegmentExport() { this.segmentActive = false; this.segmentStopped = false; }
  };
  let openCallback, exportCallback;
  const windowListeners = new Map();
  const hostBridge = {
    onOpen: callback => { openCallback = callback; },
    onExportRequest: callback => { exportCallback = callback; },
    ready: async token => { readies.push(token); order.push(`ready:${token}`); return true; },
    openFailed: async (token, message) => { failures.push({ token, message }); return true; },
    close: async payload => { closed.push(payload); if (closeFails) throw new Error('编辑会话已失效'); return true; },
    requestExit: async (token, source) => { exits.push({ token, source }); return true; },
    commit: async (action, edited) => { commits.push({ action, edited }); if (commitResult instanceof Error) throw commitResult; return commitResult; },
    exportReply: async (id, ok, payload) => { replies.push({ id, ok, payload }); return true; },
    segmentStart: async token => { segments.started.push(token); return segmentOptions?.startResult ?? { ok: true, batchId: 'b1', dir: 'C:/tmp/segment' }; },
    segmentBegin: async payload => { segments.begin.push(payload); return { ok: true, width: payload.width, height: payload.height, total: segmentOptions?.total };
    },
    segmentPart: async payload => { segments.parts.push(payload); return { ok: true, written: segments.parts.length }; },
    segmentDone: async payload => { segments.done.push(payload); return { ok: true, dir: 'C:/tmp/segment', files: segments.parts.length, bytes: 1, total: segments.parts.length }; },
    segmentAbort: async payload => { segments.abort.push(payload); return { ok: true, written: segments.parts.length, dir: 'C:/tmp/segment' }; },
    recognizeText: async payload => ({ text: 'x', payload })
  };
  const sandbox = {
    document: { getElementById: id => (id === 'editor-root' ? rootStub : id === 'host-edit' ? editButton : null) },
    window: { editorHost: hostBridge, createImageEditor: options => { sandbox.options = options;
      // 真实引擎的 close() 会回调宿主的 onClose；桩也要一样，否则看不出“交回选区页”这一步。
      editorInstance.onCloseHook = () => options.onClose();
      return editorInstance; },
      addEventListener: (type, fn) => windowListeners.set(type, fn), removeEventListener: (type) => windowListeners.delete(type) }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../core/segment-export.js'), 'utf8'), sandbox);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/image-editor-window.js'), 'utf8'), sandbox);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  return { opens, statuses, readies, failures, closed, commits, replies, exits, order, exportCalls, segments, editorInstance, editButton, exportsGroup, options: () => sandbox.options,
    open: async payload => { openCallback(payload); await tick(); },
    exportRequest: async request => { exportCallback(request); await tick(); },
    commit: async action => { sandbox.options.onCommit(action); await tick(); await tick(); },
    close: async () => { sandbox.options.onClose(); await tick(); await tick(); },
    // 编辑器里的「返回预览」/末端 Esc：走引擎给宿主的两个回调。
    previewRequest: async () => { const value = await sandbox.options.onPreviewRequest(); await tick(); return value; },
    exitRequest: async () => { const value = await sandbox.options.onExitRequest(); await tick(); return value; },
    contextMenu: async () => { const handler = windowListeners.get('contextmenu'); if (!handler) return;
      let prevented = 0; handler({ preventDefault() { prevented += 1; }, stopPropagation() {} }); await tick(); return prevented; },
    clickEdit: async () => { editButton.click?.(); await tick(); },
    // 顶栏「分段导出」走宿主回调（真实页是按钮点击 → onSegmentRequest）。
    startSegment: async () => { const value = sandbox.options.onSegmentRequest(); await tick(); return value; } };
}

test('页面收到打开指令：editor.open 原样收 payload，成功后回 ready', async () => {
  const p = pageHarness();
  await p.open({ token: 'doc-1', width: 400, height: 300, dataUrl: 'data:image/png;base64,src', warning: '仅保留已接部分' });
  assert.deepEqual(p.opens.map(item => ({ ...item })), [{ token: 'doc-1', width: 400, height: 300, dataUrl: 'data:image/png;base64,src', warning: '仅保留已接部分' }]);
  assert.deepEqual(p.readies, ['doc-1']);
  assert.equal(p.failures.length, 0);
});

test('页面打开失败：明确回报主进程，不改说成功', async () => {
  const p = pageHarness({ openFails: true });
  await p.open({ token: 'doc-1', width: 400, height: 300, dataUrl: 'data:image/png;base64,src' });
  assert.equal(p.readies.length, 0);
  assert.equal(p.failures.length, 1);
  assert.equal(p.failures[0].token, 'doc-1');
  assert.match(p.failures[0].message, /画布加载失败/);
});

test('页面提交：三个动作都走 exportClipboard（同一张完整成图），crop 实际存在才带上', async () => {
  const p = pageHarness();
  await p.open({ token: 'doc-1', width: 400, height: 300, dataUrl: 'data:image/png;base64,src' });
  await p.commit('copy');
  assert.equal(p.commits.length, 1);
  assert.equal(p.commits[0].action, 'copy');
  assert.equal(p.commits[0].edited.token, 'doc-1');
  assert.equal('crop' in p.commits[0].edited, false);
  assert.deepEqual(p.commits[0].edited.clipboardSize, { width: 720, height: 300 }, '复制交出带说明区的成图');

  p.editorInstance.cropRect = { x: 4, y: 6, width: 100, height: 80 };
  await p.commit('save-quick');
  assert.equal(p.commits[1].action, 'save-quick');
  assert.deepEqual(p.commits[1].edited.crop, { x: 4, y: 6, width: 100, height: 80 });
  assert.deepEqual(p.commits[1].edited.clipboardSize, { width: 720, height: 300 }, '保存交出同一张带说明区的成图');
  await p.commit('save');
  assert.equal(p.commits[2].action, 'save');
  assert.deepEqual(p.commits[2].edited.clipboardSize, { width: 720, height: 300 });
  assert.deepEqual(p.exportCalls, ['copy', 'copy', 'copy'], '三个动作只用 exportClipboard，不再走 exportPNG');
});

test('页面提交被取消或失败：只在状态栏说明，编辑保持', async () => {
  const canceled = pageHarness({ commitResult: { ok: false, canceled: true } });
  await canceled.open({ token: 'doc-1', width: 400, height: 300, dataUrl: 'data:image/png;base64,src' });
  await canceled.commit('save');
  assert.match(canceled.statuses.at(-1), /已取消保存/);

  const failed = pageHarness({ commitResult: { ok: false, errors: ['磁盘不可用'] } });
  await failed.open({ token: 'doc-1', width: 400, height: 300, dataUrl: 'data:image/png;base64,src' });
  await failed.commit('copy');
  assert.match(failed.statuses.at(-1), /磁盘不可用/);
});

test('页面返回预览：把缩略图与输出尺寸交主进程；被拒就把编辑页放回来', async () => {
  const p = pageHarness();
  await p.open({ token: 'doc-1', width: 400, height: 300, dataUrl: 'data:image/png;base64,src' });
  await p.close();
  assert.deepEqual(JSON.parse(JSON.stringify(p.closed.at(-1))), { token: 'doc-1', thumbnail: 'data:image/png;base64,thumb', outputSize: { width: 300, height: 200 } });

  const failing = pageHarness({ closeFails: true });
  await failing.open({ token: 'doc-1', width: 400, height: 300, dataUrl: 'data:image/png;base64,src' });
  await failing.close();
  assert.equal(failing.opens.length, 2, '交回被拒后按原文档重开');
  assert.match(failing.statuses.at(-1), /返回预览失败/);
});

test('首次初始化时 renderer 崩溃立即销毁窗口并拒绝握手', async () => {
  const h = hostHarness();
  const opening = h.host.open(h.doc('crash'), { dataUrl: 'data:image/png;base64,src' });
  await new Promise(resolve => setImmediate(resolve));
  const win = h.lastWin();
  win.crashRenderer();
  await assert.rejects(opening, /关闭|中断/);
  assert.equal(win.destroyed, true);
  assert.equal(h.host.getWindow('crash'), null);
});

test('重开时页面拒绝就绪不销毁已编辑 DOM', async () => {
  const h = hostHarness();
  const first = h.host.open(h.doc('keep'), { dataUrl: 'data:image/png;base64,src' });
  await new Promise(resolve => setImmediate(resolve));
  const win = h.lastWin(); h.ready(win, 'keep'); await first;
  await h.host.close('keep');
  const second = h.host.open(h.doc('keep'));
  await new Promise(resolve => setImmediate(resolve));
  h.handlers.get('shot:editor-open-failed')(h.eventFor(win), 'keep', '失败');
  await assert.rejects(second, /失败/);
  assert.equal(win.destroyed, false);
  assert.equal(h.host.getWindow('keep'), win);
  assert.equal(h.host.isFailed('keep'), false);
  h.host.dispose();
});

test('迟到 close 失败不复活已清理的宿主', async () => {
  let rejectClose;
  const gate = new Promise((resolve, reject) => { rejectClose = reject; });
  const h = hostHarness({ closeGate: gate });
  const opening = h.host.open(h.doc('late'), { dataUrl: 'data:image/png;base64,src' });
  await new Promise(resolve => setImmediate(resolve));
  const win = h.lastWin(); h.ready(win, 'late'); await opening;
  const pending = h.handlers.get('shot:editor-close')(h.eventFor(win), { token: 'late' });
  h.host.cleanup('late');
  rejectClose(new Error('迟到失败'));
  await assert.rejects(pending, /迟到失败/);
  assert.equal(win.destroyed, true);
  assert.equal(h.host.getWindow('late'), null);
});

test('页面拒绝错误 token 导出请求，不导出也不回包', async () => {
  const p = pageHarness();
  await p.open({ token: 'doc-1', width: 400, height: 300, dataUrl: 'data:image/png;base64,src' });
  await p.exportRequest({ id: 'wrong', kind: 'copy', token: 'foreign' });
  assert.equal(p.replies.length, 0);
});

test('页面响应导出请求：按 kind 导出并带 token/crop 回包；失败回包带原因', async () => {
  const p = pageHarness();
  await p.open({ token: 'doc-1', width: 400, height: 300, dataUrl: 'data:image/png;base64,src' });
  p.editorInstance.cropRect = { x: 1, y: 2, width: 30, height: 40 };
  await p.exportRequest({ id: 'req-1', kind: 'copy', token: 'doc-1' });
  assert.equal(p.replies.length, 1);
  assert.equal(p.replies[0].id, 'req-1');
  assert.equal(p.replies[0].ok, true);
  assert.equal(p.replies[0].payload.token, 'doc-1');
  assert.deepEqual(p.replies[0].payload.clipboardSize, { width: 720, height: 300 });
  assert.deepEqual(p.replies[0].payload.crop, { x: 1, y: 2, width: 30, height: 40 });

  const failing = pageHarness({ exportFails: 'copy' });
  await failing.open({ token: 'doc-1', width: 400, height: 300, dataUrl: 'data:image/png;base64,src' });
  await failing.exportRequest({ id: 'req-2', kind: 'png', token: 'doc-1' });
  assert.equal(failing.replies[0].ok, false);
  assert.match(failing.replies[0].payload.message, /批注说明放不下/);
  assert.deepEqual(failing.exportCalls, [], 'kind 不再决定导出路径，三个动作都是同一条合成出口');
});

// —— 长截图结果窗：同窗只读预览 + 「编辑图片」——
test('宿主把 presentation 原样带进文档与打开指令，不丢 longToken/warning', async () => {
  const h = hostHarness();
  const doc = h.doc('long-doc', { longToken: 'long-1', presentation: 'long-result' });
  const opening = h.host.open(doc, { dataUrl: 'data:image/png;base64,long', warning: '仅保留已接部分' });
  await new Promise(resolve => setImmediate(resolve));
  const win = h.lastWin();
  h.ready(win, 'long-doc');
  await opening;
  const sent = h.openPayload('long-doc');
  assert.equal(sent.presentation, 'long-result');
  assert.equal(sent.longToken, 'long-1');
  assert.equal(sent.warning, '仅保留已接部分');
  assert.equal(h.host.getDocument('long-doc').presentation, 'long-result');
  // 同 token 重开只带元数据，presentation 不能丢。
  await h.host.close('long-doc');
  const second = h.host.open(doc, {});
  await new Promise(resolve => setImmediate(resolve));
  h.ready(win, 'long-doc');
  await second;
  assert.equal(h.openPayload('long-doc').presentation, 'long-result');
  assert.equal('dataUrl' in h.openPayload('long-doc'), false);
  h.host.dispose();
});

test('预览退出申请只认当前主 frame/文档且只在打开态：转到已有 onExit(doc, source)', async () => {
  const h = hostHarness();
  const opening = h.host.open(h.doc('exit-doc', { presentation: 'long-result' }), { dataUrl: 'data:image/png;base64,src' });
  await new Promise(resolve => setImmediate(resolve));
  const win = h.lastWin();
  h.ready(win, 'exit-doc');
  await opening;
  const handle = h.handlers.get('shot:editor-exit-request');
  await assert.rejects(handle({ sender: {}, senderFrame: {} }, 'exit-doc', 'escape-key'), /已失效/);
  await assert.rejects(handle(h.eventFor(win), 'foreign', 'escape-key'), /已失效/);
  assert.equal(await handle(h.eventFor(win), 'exit-doc', 'escape-key'), false, '退出确认归会话层，返回值原样透传');
  assert.equal(h.exits.at(-1).token, 'exit-doc');
  assert.equal(h.exits.at(-1).source, 'escape-key');
  await handle(h.eventFor(win), 'exit-doc', 'context-menu');
  assert.equal(h.exits.at(-1).source, 'context-menu');
  // 未登记的来源最多只能当系统关闭，不能自造新语义。
  await handle(h.eventFor(win), 'exit-doc', 'made-up');
  assert.equal(h.exits.at(-1).source, 'window-close');
  // 窗口不在打开态（已收起）时不再接预览退出申请。
  await h.host.close('exit-doc');
  await assert.rejects(handle(h.eventFor(win), 'exit-doc', 'escape-key'), /尚未就绪/);
  // 无会话（canInteract 为 false）时一律拒绝。
  const blocked = require('../main/image-editor-window.cjs').installImageEditorWindow({
    BrowserWindow: class extends require('node:events').EventEmitter {},
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 800, height: 600 } }) },
    ipcMain: { handle: () => {} }, rendererFile: RENDERER, preloadFile: PRELOAD, iconFile: ICON, canInteract: () => false });
  assert.equal(typeof blocked.isSender, 'function');
});

test('长截图结果打开：默认同窗预览，编辑图片只在预览态出现', async () => {
  const p = pageHarness();
  // 「编辑图片」已由页面移到顶栏输出组最前面：真实 DOM 顺序是编辑 → 另存 → 保存 → 复制。
  assert.equal(p.exportsGroup.children[0], p.editButton, '编辑按钮在输出组第一个位置');
  await p.open({ token: 'long-1', width: 400, height: 300, dataUrl: 'data:image/png;base64,src', presentation: 'long-result' });
  assert.equal(p.editorInstance.previewMode, true, '结果页默认只读预览');
  // ready 代表首帧已经是预览：主进程收到 ready 时不能还是编辑形态。
  assert.deepEqual(p.order, ['preview:true', 'ready:long-1'], '先切预览再回就绪');
  assert.equal(p.editButton.hidden, false, '预览时标题栏出现「编辑图片」');
  assert.match(p.statuses.at(-1), /长截图预览/);
  assert.equal(p.statuses.at(-1).includes('已完成'), false, '有警告/异常恢复时不能自称已完成');
  assert.match(p.statuses.at(-1), /编辑图片/);
  assert.equal(p.readies.at(-1), 'long-1');

  await p.clickEdit();
  assert.equal(p.editorInstance.previewMode, false, '点编辑才展开工具');
  assert.equal(p.editButton.hidden, true);

  // 同 token 重开（F1 唤回/重新显示）不能把本地模式改回去。
  await p.open({ token: 'long-1', width: 400, height: 300, presentation: 'long-result' });
  assert.equal(p.editorInstance.previewMode, false, '重开不覆盖本地编辑态');
  assert.equal(p.editButton.hidden, true);
  assert.deepEqual(p.order.slice(-1), ['ready:long-1'], '重开只回就绪，不再改模式');
});

test('普通编辑文档仍从编辑页开始，不出现「编辑图片」', async () => {
  const p = pageHarness();
  await p.open({ token: 'doc-1', width: 400, height: 300, dataUrl: 'data:image/png;base64,src' });
  assert.equal(p.editorInstance.previewMode, false);
  assert.equal(p.editButton.hidden, true);
  assert.match(p.statuses.at(-1), /复制/);
});

test('编辑态返回预览：长截图结果回同窗预览，普通文档仍交回选区页', async () => {
  const long = pageHarness();
  await long.open({ token: 'long-1', width: 400, height: 300, dataUrl: 'data:image/png;base64,src', presentation: 'long-result' });
  await long.clickEdit();
  assert.equal(await long.previewRequest(), true);
  assert.equal(long.editorInstance.previewMode, true, '回到同窗预览');
  assert.equal(long.closed.length, 0, '不把窗口交回旧桌面蒙版');
  assert.equal(long.editButton.hidden, false);

  const normal = pageHarness();
  await normal.open({ token: 'doc-1', width: 400, height: 300, dataUrl: 'data:image/png;base64,src' });
  await normal.previewRequest();
  assert.equal(normal.editorInstance.closeCalls, 1, '普通编辑页仍调引擎的收起义');
  assert.equal(normal.closed.length, 1, '普通编辑页仍是原来的返回预览');
  assert.equal(normal.closed[0].token, 'doc-1');
});

test('批注没写完时不肯切预览：留在编辑态并说明，不悄悄丢字', async () => {
  const p = pageHarness({ refusePreview: true });
  await p.open({ token: 'long-1', width: 400, height: 300, dataUrl: 'data:image/png;base64,src', presentation: 'long-result' });
  await p.clickEdit();
  assert.equal(await p.previewRequest(), false);
  assert.equal(p.editorInstance.previewMode, false);
  assert.match(p.statuses.at(-1), /完成批注/);
});

test('预览 Esc 与右键都只申请退出，编辑态右键不发申请', async () => {
  const p = pageHarness();
  await p.open({ token: 'long-1', width: 400, height: 300, dataUrl: 'data:image/png;base64,src', presentation: 'long-result' });
  await p.exitRequest();
  assert.deepEqual(p.exits.at(-1), { token: 'long-1', source: 'escape-key' });
  assert.equal(await p.contextMenu(), 1, '预览右键吞掉原生菜单');
  assert.deepEqual(p.exits.at(-1), { token: 'long-1', source: 'context-menu' });

  await p.clickEdit();
  await p.contextMenu();
  assert.equal(p.exits.length, 2, '编辑态右键不申请退出');
});

// —— 分段导出：目标目录由主进程选，逐段校验后写入唯一子目录 ——
function fakePng(width, height) {
  const bytes = Buffer.alloc(64);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8; bytes[25] = 6;
  return bytes;
}
const asArrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const call = (h, win, channel, payload) => h.handlers.get(channel)(h.eventFor(win), payload);

async function segmentHarness(choice) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jiege-segment-'));
  const h = hostHarness({ showDirectory: async () => choice === undefined ? { canceled: false, filePaths: [root] } : choice });
  const opening = h.host.open(h.doc('doc-1', { width: 64, height: 300 }), { dataUrl: 'data:image/png;base64,src' });
  await new Promise(resolve => setImmediate(resolve));
  const win = h.lastWin();
  h.ready(win, 'doc-1');
  await opening;
  return { h, win, root };
}

const expectedSegments = (total, segmentHeight, height) => {
  const rows = [];
  let top = 0;
  for (let index = 0; index < total; index++) {
    const remaining = height - top;
    rows.push({ top, height: remaining <= segmentHeight ? remaining : segmentHeight });
    top += segmentHeight - Math.min(120, Math.floor(segmentHeight * 0.1));
  }
  return rows;
};

test('分段导出：新建唯一子目录，按规则逐段写入；尺寸/顺序/文件名都由主进程把关', async () => {
  const { h, win, root } = await segmentHarness();
  try {
    const started = await call(h, win, 'shot:editor-segment-start', { token: 'doc-1' });
    assert.equal(started.ok, true);
    assert.match(path.basename(started.dir), /^截个图分段-\d{8}-\d{6}$/, '批次目录名固定可读，不带临时串');
    assert.equal(path.dirname(started.dir), root, '只会在用户选中的目录下建子目录');

    const begun = await call(h, win, 'shot:editor-segment-begin', { token: 'doc-1', batchId: started.batchId, width: 64, height: 300 });
    assert.equal(begun.ok, true);
    assert.equal(begun.segmentHeight, 128, '64 宽图按 2× 图宽把段高压到 128');
    assert.equal(begun.overlap, 12, '重叠不超过段高 10%');
    const rows = expectedSegments(begun.total, begun.segmentHeight, 300);
    assert.equal(begun.total, rows.length);
    assert.ok(rows.length > 1);

    for (const [index, row] of rows.entries()) {
      const bytes = fakePng(64, row.height);
      const ack = await call(h, win, 'shot:editor-segment-part', { token: 'doc-1', batchId: started.batchId, index, png: asArrayBuffer(bytes) });
      assert.equal(ack.ok, true);
      assert.equal(ack.written, index + 1);
      assert.deepEqual(fs.readFileSync(path.join(started.dir, `${String(index + 1).padStart(2, '0')}.png`)), bytes, '写盘内容与上传字节一致');
    }
    const done = await call(h, win, 'shot:editor-segment-done', { token: 'doc-1', batchId: started.batchId });
    assert.equal(done.ok, true);
    assert.equal(done.files, rows.length);
    assert.deepEqual(fs.readdirSync(started.dir).sort(), rows.map((_, index) => `${String(index + 1).padStart(2, '0')}.png`).sort());
  } finally { h.host.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('分段导出：顺序错、尺寸不符、坏 PNG 都被拒，不会留下错文件', async () => {
  const { h, win, root } = await segmentHarness();
  try {
    const started = await call(h, win, 'shot:editor-segment-start', { token: 'doc-1' });
    await call(h, win, 'shot:editor-segment-begin', { token: 'doc-1', batchId: started.batchId, width: 64, height: 300 });
    await assert.rejects(call(h, win, 'shot:editor-segment-part', { token: 'doc-1', batchId: started.batchId, index: 1, png: asArrayBuffer(fakePng(64, 128)) }), /顺序不对/);
    await assert.rejects(call(h, win, 'shot:editor-segment-part', { token: 'doc-1', batchId: started.batchId, index: 0, png: asArrayBuffer(fakePng(65, 128)) }), /尺寸与计划不符/);
    const notPng = Buffer.alloc(64);
    await assert.rejects(call(h, win, 'shot:editor-segment-part', { token: 'doc-1', batchId: started.batchId, index: 0, png: asArrayBuffer(notPng) }), /尺寸与计划不符/);
    await assert.rejects(call(h, win, 'shot:editor-segment-part', { token: 'other', batchId: started.batchId, index: 0, png: asArrayBuffer(fakePng(64, 128)) }), /编辑文档已失效/);
    assert.deepEqual(fs.readdirSync(started.dir), [], '被拒的请求不落盘');
    await assert.rejects(call(h, win, 'shot:editor-segment-done', { token: 'doc-1', batchId: started.batchId }), /还没写完/);
  } finally { h.host.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('分段导出：同名文件已存在时拒绝写入且不覆盖；取消目录选择不建任何目录', async () => {
  const { h, win, root } = await segmentHarness();
  try {
    const started = await call(h, win, 'shot:editor-segment-start', { token: 'doc-1' });
    await call(h, win, 'shot:editor-segment-begin', { token: 'doc-1', batchId: started.batchId, width: 64, height: 300 });
    const existing = path.join(started.dir, '01.png');
    fs.writeFileSync(existing, 'not-ours');
    await assert.rejects(call(h, win, 'shot:editor-segment-part', { token: 'doc-1', batchId: started.batchId, index: 0, png: asArrayBuffer(fakePng(64, 128)) }), /已存在，未覆盖/);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'not-ours', '已有文件一字不改');
    // 取消：不建目录，也不返回批次。
    h.host.cleanup('doc-1');
  } finally { h.host.dispose(); fs.rmSync(root, { recursive: true, force: true }); }

  const cancelRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jiege-segment-'));
  const cancelled = hostHarness({ showDirectory: async () => ({ canceled: true, filePaths: [] }) });
  try {
    const opening = cancelled.host.open(cancelled.doc('doc-2', { width: 64, height: 300 }), { dataUrl: 'data:image/png;base64,src' });
    await new Promise(resolve => setImmediate(resolve));
    const win2 = cancelled.lastWin();
    cancelled.ready(win2, 'doc-2');
    await opening;
    const result = await call(cancelled, win2, 'shot:editor-segment-start', { token: 'doc-2' });
    assert.deepEqual(result, { canceled: true });
    assert.deepEqual(fs.readdirSync(cancelRoot), [], '取消不落任何东西');
  } finally { cancelled.host.dispose(); fs.rmSync(cancelRoot, { recursive: true, force: true }); }
});

test('分段导出中途文档被收掉：迟到的段被拒，不会写到另一张图', async () => {
  const { h, win, root } = await segmentHarness();
  try {
    const started = await call(h, win, 'shot:editor-segment-start', { token: 'doc-1' });
    await call(h, win, 'shot:editor-segment-begin', { token: 'doc-1', batchId: started.batchId, width: 64, height: 300 });
    h.host.cleanup('doc-1');
    await assert.rejects(call(h, win, 'shot:editor-segment-part', { token: 'doc-1', batchId: started.batchId, index: 0, png: asArrayBuffer(fakePng(64, 128)) }), /编辑文档已失效/);
    assert.deepEqual(fs.readdirSync(started.dir), []);
  } finally { h.host.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('缺区元数据随文档进编辑页：只保留落在图内的整数矩形，计数不丢', async () => {
  const h = hostHarness();
  const doc = h.doc('long-doc', { longToken: 'long-1', presentation: 'long-result',
    checkRegions: { total: 4, truncated: false, rects: [
      { top: 10, bottom: 40, left: 5, right: 60 },
      { top: 40, bottom: 40, left: 5, right: 60 },
      { top: -1, bottom: 20, left: 5, right: 60 },
      { top: 200, bottom: 260, left: 5, right: 60 }] } });
  const opening = h.host.open(doc, { dataUrl: 'data:image/png;base64,long' });
  await new Promise(resolve => setImmediate(resolve));
  const win = h.lastWin();
  h.ready(win, 'long-doc');
  await opening;
  const sent = h.openPayload('long-doc');
  assert.equal(sent.checkRegions.total, 4, '计数保留（两条非法不算位置，也不造假）');
  assert.deepEqual(sent.checkRegions.rects, [
    { top: 10, bottom: 40, left: 5, right: 60 },
    { top: 200, bottom: 260, left: 5, right: 60 }], '越界与零高度矩形被剔除');
  // 同 token 重开：只发元数据，缺区位置仍在。
  const reopened = h.host.open(doc, {});
  await new Promise(resolve => setImmediate(resolve));
  h.ready(win, 'long-doc');
  await reopened;
  assert.equal(h.openPayload('long-doc').checkRegions.rects.length, 2);
  h.host.dispose();
});

// —— 分段导出的竞态：写在途时 abort、终态不被复活、done 不认 aborted ——
test('主进程：abort 发生在途写盘时等落定再记账，写成功也不把 aborted 复活，done 不认', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jiege-segment-race-'));
  let release; const gate = new Promise(resolve => { release = resolve; });
  const writes = [];
  const h = hostHarness({ showDirectory: async () => ({ canceled: false, filePaths: [root] }),
    writeSegmentFile: async (file, bytes, options) => { writes.push(path.basename(file)); await gate; return fs.promises.writeFile(file, bytes, options); } });
  try {
    const opening = h.host.open(h.doc('doc-1', { width: 64, height: 300 }), { dataUrl: 'data:image/png;base64,src' });
    await new Promise(resolve => setImmediate(resolve));
    const win = h.lastWin();
    h.ready(win, 'doc-1');
    await opening;
    const started = await call(h, win, 'shot:editor-segment-start', { token: 'doc-1' });
    await call(h, win, 'shot:editor-segment-begin', { token: 'doc-1', batchId: started.batchId, width: 64, height: 300 });

    const partPromise = call(h, win, 'shot:editor-segment-part', { token: 'doc-1', batchId: started.batchId, index: 0, png: asArrayBuffer(fakePng(64, 128)) });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(writes, ['01.png'], '第一段已经真的开始写');

    let abortSettled = false;
    const abortPromise = call(h, win, 'shot:editor-segment-abort', { token: 'doc-1', batchId: started.batchId, reason: 'canceled' })
      .then(value => { abortSettled = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(abortSettled, false, 'abort 必须等在途写入落定，不能先报个数字');

    release();
    const ack = await partPromise;
    assert.equal(ack.ok, true, '已经开始的写入允许完成');
    assert.equal(ack.written, 1);
    const stopped = await abortPromise;
    assert.equal(stopped.written, 1, '在途写入完成后计入，不能少报一张');
    assert.equal(stopped.state, 'aborted', '写成功后不得把终态复活成 ready');
    assert.equal(h.host.getSegment('doc-1').state, 'aborted');
    // aborted 后不得再推进，也不得被 done 记成成功。
    await assert.rejects(call(h, win, 'shot:editor-segment-part', { token: 'doc-1', batchId: started.batchId, index: 1, png: asArrayBuffer(fakePng(64, 128)) }), /分段导出会话已失效/);
    await assert.rejects(call(h, win, 'shot:editor-segment-done', { token: 'doc-1', batchId: started.batchId }), /不能算完成|还没写完/);
    assert.deepEqual(fs.readdirSync(started.dir), ['01.png'], '只留下已经开始的这一张');
  } finally { h.host.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('主进程：整图 36M/30000 闸与整批 256MB 闸都在写盘前拒', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jiege-segment-limit-'));
  const h = hostHarness({ showDirectory: async () => ({ canceled: false, filePaths: [root] }) });
  try {
    const opening = h.host.open(h.doc('doc-1', { width: 64, height: 300 }), { dataUrl: 'data:image/png;base64,src' });
    await new Promise(resolve => setImmediate(resolve));
    const win = h.lastWin();
    h.ready(win, 'doc-1');
    await opening;
    const started = await call(h, win, 'shot:editor-segment-start', { token: 'doc-1' });
    // 20000 × 2000 = 4000 万像素，超过编辑/复制同一条 36M 闸。
    assert.throws(() => call(h, win, 'shot:editor-segment-begin', { token: 'doc-1', batchId: started.batchId, width: 20000, height: 2000 }), /图片超出编辑容量/);
    assert.deepEqual(fs.readdirSync(started.dir), [], '被拒的计划不建任何文件');
  } finally { h.host.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('主进程：整批累计字节超过 256MB 时在写盘前拒，已写的保留', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jiege-segment-bytes-'));
  const h = hostHarness({ showDirectory: async () => ({ canceled: false, filePaths: [root] }) });
  try {
    const opening = h.host.open(h.doc('doc-1', { width: 64, height: 300 }), { dataUrl: 'data:image/png;base64,src' });
    await new Promise(resolve => setImmediate(resolve));
    const win = h.lastWin();
    h.ready(win, 'doc-1');
    await opening;
    const started = await call(h, win, 'shot:editor-segment-start', { token: 'doc-1' });
    const begun = await call(h, win, 'shot:editor-segment-begin', { token: 'doc-1', batchId: started.batchId, width: 64, height: 300 });
    assert.ok(begun.total >= 3, `需要至少三段才测得到累计闸：${begun.total}`);
    // 每段 90MiB（未超过单段 128MiB），两段 180MiB，第三段会撞 256MiB 总闸。
    const chunk = 90 * 1024 * 1024;
    const bigPng = height => {
      const bytes = Buffer.alloc(chunk);
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
      bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'latin1');
      bytes.writeUInt32BE(64, 16); bytes.writeUInt32BE(height, 20);
      return bytes;
    };
    const heights = [128, 128];
    for (const [index, height] of heights.entries()) {
      const ack = await call(h, win, 'shot:editor-segment-part', { token: 'doc-1', batchId: started.batchId, index, png: asArrayBuffer(bigPng(height)) });
      assert.equal(ack.ok, true);
    }
    await assert.rejects(call(h, win, 'shot:editor-segment-part', { token: 'doc-1', batchId: started.batchId, index: 2, png: asArrayBuffer(bigPng(68)) }), /256MB 上限/);
    assert.deepEqual(fs.readdirSync(started.dir).sort(), ['01.png', '02.png'], '撞闸的那一段一张也不写');
    const stopped = await call(h, win, 'shot:editor-segment-abort', { token: 'doc-1', batchId: started.batchId, reason: 'failed' });
    assert.equal(stopped.written, 2);
  } finally { h.host.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

// —— 页面侧：编码回来时已经点了停止，就不能再提交新写入 ——
test('页面：编码中途点了停止，这一段不再提交，按主进程回报的张数说停止', async () => {
  let release; const gate = { promise: new Promise(resolve => { release = resolve; }) };
  const p = pageHarness({ segmentOptions: { size: { width: 400, height: 2000 }, total: 3, gate } });
  await p.open({ token: 'doc-1', width: 400, height: 2000, dataUrl: 'data:image/png;base64,src' });
  const running = p.startSegment();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(p.statuses.at(-1), /正在导出第 1\/3 段/);
  // 用户在 toBlob/arrayBuffer 期间点了停止。
  p.editorInstance.segmentStopped = true;
  release();
  await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.segments.parts.length, 0, '停止后不得提交任何新写入');
  assert.equal(p.segments.done.length, 0, '不得把半次导出说成完成');
  assert.equal(p.segments.abort.length, 1, '必须明确告诉主进程已停止');
  assert.match(p.statuses.at(-1), /已停止分段导出：已写 0\/3 张/);
  assert.deepEqual(p.segments.started, ['doc-1']);
});

test('页面：编码期间换了文档，这一段不提交到旧批次', async () => {
  let release; const gate = { promise: new Promise(resolve => { release = resolve; }) };
  const p = pageHarness({ segmentOptions: { size: { width: 400, height: 2000 }, total: 3, gate } });
  await p.open({ token: 'doc-1', width: 400, height: 2000, dataUrl: 'data:image/png;base64,src' });
  const running = p.startSegment();
  await new Promise(resolve => setImmediate(resolve));
  // 换文档：新 token 进来，旧导出必须停在原地。
  await p.open({ token: 'doc-2', width: 400, height: 2000, dataUrl: 'data:image/png;base64,other' });
  release();
  await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.segments.parts.length, 0, '旧文档的分段不得写进新文档');
  assert.match(p.statuses.at(-1), /文档已经换了|分段导出未完成/);
});
