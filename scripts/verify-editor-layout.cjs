/* 固定说明区的真实布局验收：三种 CSS 可用尺寸 × 三种说明状态。
   全程隐藏窗口 + 离屏渲染（offscreen），不显示、不采桌面、不抢焦点；userData 隔离。
   用 CDP 真实鼠标/输入构造状态，读真实 DOM 几何判断：
   - 宽窗说明区在右列、窄窗在下底带，画布区域不因选中/更多字段/关系编辑而变；
   - 复制/保存/返回主入口始终在视口内；长内容只在说明区内部滚；
   - 保存每种尺寸 × 每种状态的合成界面截图到 evidence 供人工审核。
   夹具输入一律按当前 debug.origin/zoom 从「看得见的那块图」的源比例投影成客户端坐标，
   并在每次输入前核对落点在图内、真落在画布上；不再用画布/视口比例当图像坐标。
   运行：VERIFY_PASSES=1 node_modules\electron\dist\electron.exe scripts\verify-editor-layout.cjs */
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { installImageEditorWindow } = require('../main/image-editor-window.cjs');
const { installProbeGuard } = require('./probe-safety.cjs');

const ROOT = path.join(__dirname, '..');
// 先装测试生命周期保护（任何日志之前）：断管／未捕获异常／超时都落故障文件并非 0 退出。
// 三种尺寸 × 三态离屏渲染加合成截图，比单场景探针慢，留 6 分钟。
const probeGuard = installProbeGuard({ name: 'verify-editor-layout', timeoutMs: 6 * 60 * 1000 });
// 本轮修订的证据另放 v2，旧 v1 保留做对照。
// 证据目录默认 v2；重跑时用 VERIFY_EVIDENCE 指向新目录，不覆盖上一轮证据。
const EVIDENCE = process.env.VERIFY_EVIDENCE
  ? path.resolve(ROOT, process.env.VERIFY_EVIDENCE)
  : path.join(ROOT, 'evidence', '20261110-inspector-v2');
const results = [];
const failures = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures.push(name);
  return Boolean(ok);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const trace = (label, value) => console.log(`TRACE ${label} ${JSON.stringify(value)}`);
const waitUntil = async (probe, { timeout = 5000, interval = 60, label = 'condition' } = {}) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(interval);
  }
  trace(`timeout:${label}`, last === undefined ? 'undefined' : last);
  return undefined;
};

const lifecycle = { show: 0, focus: 0, showInactive: 0, restore: 0 };
class OffscreenWindow extends BrowserWindow {
  constructor(options = {}) {
    super({ ...options, show: false, webPreferences: { ...(options.webPreferences || {}), offscreen: true } });
    this.__logicalVisible = false;
  }
  show() { lifecycle.show += 1; this.__logicalVisible = true; }
  showInactive() { lifecycle.showInactive += 1; this.__logicalVisible = true; }
  focus() { lifecycle.focus += 1; }
  restore() { lifecycle.restore += 1; }
  isVisible() { return this.__logicalVisible; }
  isMinimized() { return false; }
}
const nativeVisible = win => BrowserWindow.prototype.isVisible.call(win);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const SOURCE_RGB = [220, 235, 225];
function makePng(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length, 0);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const stride = width * 3;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      rows[y * (stride + 1) + 1 + x * 3] = SOURCE_RGB[0];
      rows[y * (stride + 1) + 2 + x * 3] = SOURCE_RGB[1];
      rows[y * (stride + 1) + 3 + x * 3] = SOURCE_RGB[2];
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const dataUrlOf = bytes => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-editor-layout-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

fs.mkdirSync(EVIDENCE, { recursive: true });
const SIZE_LIST = [[1280, 800], [800, 600], [640, 480]];
// 合成图的源像素尺寸：夹具输入一律用这份图像坐标，不拿画布比例当图像坐标。
const IMAGE_WIDTH = 480, IMAGE_HEIGHT = 360;
const commitLog = [];

function makeHost() {
  return installImageEditorWindow({
    BrowserWindow: OffscreenWindow,
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    ipcMain,
    rendererFile: path.join(ROOT, 'renderer', 'image-editor-window.html'),
    preloadFile: path.join(ROOT, 'main', 'image-editor-preload.cjs'),
    iconFile: path.join(ROOT, 'assets', 'app-icon.ico'),
    theme: undefined,
    onCommit: async (action, edited) => { commitLog.push({ action, edited }); return { ok: true }; },
    onClose: async () => true,
    onExit: async () => false,
    onStatus: () => {}
  });
}

async function runSize(host, size) {
  const [cssWidth, cssHeight] = size;
  const tag = `${cssWidth}x${cssHeight}`;
  const token = `layout-${tag}-${Date.now()}`;
  const png = makePng(IMAGE_WIDTH, IMAGE_HEIGHT);
  const opened = host.open({ token, width: IMAGE_WIDTH, height: IMAGE_HEIGHT,
    rect: { x: 0, y: 0, width: IMAGE_WIDTH, height: IMAGE_HEIGHT } },
    { dataUrl: dataUrlOf(png) });
  const win = await waitUntil(async () => host.getWindow(token), { timeout: 9000, label: `window-${tag}` });
  if (!win) { host.dispose(); return check(`${tag} 窗口创建`, false); }
  let frame = null;
  win.webContents.on('paint', (_event, _dirty, image) => { if (image && !image.isEmpty()) frame = image; });
  await waitUntil(() => win.webContents.executeJavaScript('Boolean(window.__imageEditorDebug)').catch(() => false),
    { timeout: 9000, label: `page-${tag}` });
  await opened;
  win.setContentSize(cssWidth, cssHeight);
  await sleep(320);
  const run = code => win.webContents.executeJavaScript(code, true);
  win.webContents.debugger.attach('1.3');
  // 画布上的 fillText 日志：证明关系中间标签真的画进了 canvas，不只是停在 DOM 输入框里。
  await run(`(() => { if (!window.__fillTextHook) { const proto = CanvasRenderingContext2D.prototype;
    const orig = proto.fillText;
    proto.fillText = function (text, ...rest) { (window.__fillTextLog = window.__fillTextLog || []).push(String(text));
      return orig.call(this, text, ...rest); };
    window.__fillTextHook = true; }
    window.__fillTextLog = []; return true; })()`);
  const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
  const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent',
    { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra });
  const clickAt = async (x, y, extra = {}) => {
    await mouse('mouseMoved', x, y, { buttons: 0, ...extra });
    await mouse('mousePressed', x, y, { buttons: 1, ...extra });
    await mouse('mouseReleased', x, y, { buttons: 0, ...extra });
  };
  const dragAt = async (from, to) => {
    await mouse('mouseMoved', from.x, from.y, { buttons: 0 });
    await mouse('mousePressed', from.x, from.y, { buttons: 1 });
    for (let step = 1; step <= 8; step += 1) {
      await mouse('mouseMoved', from.x + ((to.x - from.x) * step) / 8, from.y + ((to.y - from.y) * step) / 8, { buttons: 1 });
    }
    await mouse('mouseReleased', to.x, to.y, { buttons: 0 });
  };
  const center = sel => run(`(() => { const node = document.querySelector(${JSON.stringify(sel)});
    if (!node) return null; const r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const debug = () => run('__imageEditorDebug()');
  // —— 图内输入夹具 ——
  // 每次现读 debug.origin/zoom 和 .ie-scroll 的实时位置，把「图像源像素」投影成客户端坐标。
  // 不缓存屏幕坐标，也不再用画布比例冒充分数图像坐标：宽窗画布两侧的 letterbox 会点到图外。
  const projection = async () => {
    const d = await debug();
    const rect = await run(`(() => { const r = document.querySelector('.ie-scroll').getBoundingClientRect();
      return { left: r.left, top: r.top }; })()`);
    return { d, left: rect.left, top: rect.top };
  };
  const toClient = async (x, y) => {
    const p = await projection();
    return { x: p.left + p.d.origin.x + x * p.d.zoom, y: p.top + p.d.origin.y + y * p.d.zoom };
  };
  // 图像框 ∩ 画布视口：当前真的看得见的那块图（客户端坐标）；夹具只在这块里按比例取点。
  // 这样图比画布大（矮窗要滚动）时也不会点到图外/视口外，宽窗也不会把画布 letterbox 当图。
  const visibleSpots = async fractions => {
    const p = await projection();
    const scroller = await run(`(() => { const sc = document.querySelector('.ie-scroll');
      return { width: sc.clientWidth, height: sc.clientHeight }; })()`);
    const v = p.d.view;
    const image = { left: p.left + p.d.origin.x + v.x * p.d.zoom, top: p.top + p.d.origin.y + v.y * p.d.zoom,
      right: p.left + p.d.origin.x + (v.x + v.width) * p.d.zoom,
      bottom: p.top + p.d.origin.y + (v.y + v.height) * p.d.zoom };
    const visible = { left: Math.max(image.left, p.left), top: Math.max(image.top, p.top),
      right: Math.min(image.right, p.left + scroller.width), bottom: Math.min(image.bottom, p.top + scroller.height) };
    const toSource = spot => ({ x: v.x + (spot.x - p.left - p.d.origin.x) / p.d.zoom,
      y: v.y + (spot.y - p.top - p.d.origin.y) / p.d.zoom });
    const spots = fractions.map(([fx, fy]) => ({ x: visible.left + (visible.right - visible.left) * fx,
      y: visible.top + (visible.bottom - visible.top) * fy }));
    // 同一份投影换回图像源像素，日志里能直接看到夹具到底点在图上的哪里。
    return { spots, sources: spots.map(toSource), image, visible, zoom: p.d.zoom };
  };
  const insideBox = (spot, box, pad = 0) => Boolean(spot) && Boolean(box)
    && spot.x > box.left + pad && spot.x < box.right - pad
    && spot.y > box.top + pad && spot.y < box.bottom - pad;
  const withinBox = (inner, outer, pad = 0) => Boolean(inner) && Boolean(outer)
    && inner.left >= outer.left - pad && inner.top >= outer.top - pad
    && inner.right <= outer.right + pad && inner.bottom <= outer.bottom + pad;
  const near = (a, b, pad = 2) => Boolean(a) && Boolean(b)
    && Math.abs(a.x - b.x) <= pad && Math.abs(a.y - b.y) <= pad;
  // 落点元素：确认这一下真的落在画布上，不在便签或编号按钮上。
  const elementInfoAt = async (x, y) => run(`(() => { const n = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
    if (!n) return null; return { cls: String(n.className || n.tagName),
      inCard: Boolean(n.closest && n.closest('.ie-note-card')),
      onMarker: Boolean(n.closest && n.closest('.ie-marker')),
      inScroller: Boolean(n.closest && n.closest('.ie-scroll')) }; })()`);
  // 已创建批注的真实编号圈心：圈就画在落点上（框是左上角），现读、不缓存。
  const ringOf = id => run(`(() => { const button = document.querySelector('.ie-marker[data-annotation-id="' + ${JSON.stringify(id)} + '"]');
    if (!button) return null; const figure = button.closest('.ie-marker-figure');
    const ring = figure && figure.querySelector('.ie-marker-ring');
    const anchor = (ring || button).getBoundingClientRect();
    return { x: anchor.left + anchor.width / 2, y: anchor.top + anchor.height / 2 }; })()`);
  const escapeOnce = async () => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(60);
  };
  const geometry = () => run(`(() => {
    const rect = sel => { const node = document.querySelector(sel); if (!node) return null;
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const card = sel => { const node = document.querySelector(sel); if (!node || node.hidden) return null; return rect(sel); };
    const more = document.querySelector('.ie-bubble-more');
    const moreStyle = more ? getComputedStyle(more) : null;
    return { inner: [innerWidth, innerHeight], devicePixelRatio,
      canvas: rect('.ie-scroll'), workspace: rect('.ie-workspace'), header: rect('.ie-header'), footer: rect('.ie-footer'),
      copy: rect('[data-action="copy"]'), save: rect('[data-action="save"]'), back: rect('[data-action="close"]'),
      undo: rect('[data-action="undo"]'), redo: rect('[data-action="redo"]'),
      note: card('.ie-note-bubble'), relation: card('.ie-relation-bubble'),
      moreScroll: more ? { overflowY: moreStyle.overflowY, maxHeight: moreStyle.maxHeight } : null,
      hasPanel: Boolean(document.querySelector('.ie-panel')),
      noteVisible: !document.querySelector('.ie-note-bubble').hidden,
      relationVisible: !document.querySelector('.ie-relation-bubble').hidden };
  })()`);
  const inside = (rect, inner, pad = 0) => Boolean(rect) &&
    rect.left >= -pad && rect.top >= -pad && rect.right <= inner[0] + pad && rect.bottom <= inner[1] + pad;
  const saveShot = async name => {
    // 离屏窗口靠 paint 事件出帧：每次先丢掉旧帧，再请求重绘。
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    frame = null;
    win.webContents.invalidate();
    const captured = await waitUntil(() => frame, { timeout: 3000, label: `frame-${tag}-${name}` });
    if (!captured) return null;
    const target = path.join(EVIDENCE, `layout-${tag}-${name}.png`);
    fs.writeFileSync(target, captured.toPNG());
    const bitmap = captured.toBitmap();
    const colors = new Set();
    const step = Math.max(4, Math.floor(bitmap.length / 4 / 4000)) * 4;
    for (let i = 0; i < bitmap.length; i += step) colors.add(`${bitmap[i]},${bitmap[i + 1]},${bitmap[i + 2]}`);
    trace(`shot-${tag}-${name}`, { file: path.relative(ROOT, target), size: captured.getSize(), colors: colors.size });
    return { file: target, colors: colors.size };
  };

  try {
    const inner0 = await geometry();
    check(`${tag} CSS 可用尺寸就是声明的尺寸`, Math.abs(inner0.inner[0] - cssWidth) <= 1 && Math.abs(inner0.inner[1] - cssHeight) <= 1,
      { inner: inner0.inner, want: size });
    check(`${tag} 常驻说明侧栏已撤掉`, inner0.hasPanel === false, { hasPanel: inner0.hasPanel });
    check(`${tag} 便签层贴在画布上（不另占一列）`, await run(`Boolean(document.querySelector('.ie-workspace > .ie-note-layer'))`));
    check(`${tag} 空态不摆便签`, inner0.note === null, inner0.note);
    check(`${tag} 空态画布就是整块可用区域`, inner0.canvas.width >= inner0.inner[0] - 2, inner0.canvas);
    check(`${tag} 连线入口在空态置灰并说明先标两处`,
      await run(`(() => { const node = document.querySelector('[data-tool="connect"]');
        return Boolean(node) && node.disabled && node.title === '先标出两处'; })()`));
    // 撤销/重做只有一套，且在不滚动的顶栏：工具区窄到要滚也能随手点。
    check(`${tag} 撤销/重做在顶栏、不在可滚工具区`,
      await run(`Boolean(document.querySelector('.ie-header [data-action="undo"]'))
        && Boolean(document.querySelector('.ie-header [data-action="redo"]'))
        && document.querySelectorAll('[data-action="undo"]').length === 1
        && document.querySelectorAll('[data-action="redo"]').length === 1
        && !document.querySelector('.ie-toolbar [data-action="undo"]')
        && !document.querySelector('.ie-toolbar [data-action="redo"]')`));
    for (const [name, rect] of [['复制', inner0.copy], ['保存', inner0.save], ['返回', inner0.back], ['撤销', inner0.undo], ['重做', inner0.redo]]) {
      check(`${tag} ${name}入口在视口内`, inside(rect, inner0.inner, 1), rect);
    }
    check(`${tag} 画布内部可滚（便签另层，不推画布）`, await run(`(() => { const node = document.querySelector('.ie-scroll');
      return getComputedStyle(node).overflow === 'auto' || getComputedStyle(node).overflowY === 'auto'; })()`));
    const shot0 = await saveShot('plain');
    check(`${tag} 空态截图不是空白帧`, Boolean(shot0) && shot0.colors > 8, shot0 && shot0.colors);

    // 状态 1：单选一处 + 展开更多字段。
    // 落点取「看得见的那块图」里的源比例位置，再投影回客户端；不拿画布比例冒充分数图坐标。
    const pointTool = await center('[data-tool="point"]');
    await clickAt(pointTool.x, pointTool.y);
    await waitUntil(async () => (await debug()).tool === 'point', { label: `tool-point-${tag}` });
    const grid1 = await visibleSpots([[0.35, 0.4]]);
    const at = grid1.spots[0];
    const atInfo = await elementInfoAt(at.x, at.y);
    check(`${tag} 状态1 落点在图内、真的落在画布上`, insideBox(at, grid1.visible)
      && withinBox(grid1.visible, grid1.image)
      && Boolean(atInfo) && atInfo.inScroller && !atInfo.inCard && !atInfo.onMarker,
      { at, source: grid1.sources[0], image: grid1.image, visible: grid1.visible, info: atInfo });
    await clickAt(at.x, at.y);
    const noteOne = await waitUntil(async () => { const d = await debug(); return d.notes.length === 1 && d; },
      { label: `point-${tag}` });
    const pointId = noteOne && noteOne.notes[0].id;
    const pointRing = await ringOf(pointId);
    check(`${tag} 状态1 真落下一处「点」批注，圈心就在投影落点上`, Boolean(noteOne)
      && noteOne.notes[0].targets.some(target => target.kind === 'point')
      && near(pointRing, at, 2), { notes: noteOne && noteOne.notes, ring: pointRing, at });
    await run(`(() => { const node = document.querySelector('.ie-bubble-text'); node.focus(); node.select(); return true; })()`);
    await cdp('Input.insertText', { text: '这条说明比较长，看看说明区会不会挤动画布。' });
    const more = await center('[data-action="bubble-more-toggle"]');
    await clickAt(more.x, more.y);
    await run(`(() => { const node = document.querySelector('.ie-details-action');
      if (!node) return false; node.value = '点了保存'; node.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(120);
    const state1 = await geometry();
    const canvasDelta1 = Math.abs(state1.canvas.width - inner0.canvas.width) + Math.abs(state1.canvas.height - inner0.canvas.height);
    check(`${tag} 选中并展开更多字段后画布区域不变`, canvasDelta1 <= 1,
      { before: inner0.canvas, after: state1.canvas });
    check(`${tag} 便签贴在画布内、不出视口`, inside(state1.note, state1.inner, 1)
      && state1.note.left >= state1.canvas.left - 1 && state1.note.right <= state1.canvas.right + 1
      && state1.note.top >= state1.canvas.top - 1 && state1.note.bottom <= state1.canvas.bottom + 1, state1.note);
    check(`${tag} 高级内容有界内部滚`, Boolean(state1.moreScroll) && /auto|scroll/.test(state1.moreScroll.overflowY), state1.moreScroll);
    check(`${tag} 选中态便签打开`, state1.noteVisible, state1.note);
    for (const [name, rect] of [['复制', state1.copy], ['保存', state1.save], ['返回', state1.back], ['撤销', state1.undo], ['重做', state1.redo]]) {
      check(`${tag} 选中态${name}入口仍在视口内`, inside(rect, state1.inner, 1), rect);
    }
    const shot1 = await saveShot('note-more');
    check(`${tag} 选中态截图不是空白帧`, Boolean(shot1) && shot1.colors > 8, shot1 && shot1.colors);

    // 状态 2：再标一个框（起终点同样用图内源坐标），再用连线工具把两处连起来，再写共同说明。
    // 先把状态 1 的便签单 Esc 收起，避免它盖住框的起手位置。
    await escapeOnce();
    await waitUntil(async () => (await debug()).selectedTargets.length === 0, { label: `clear-before-region-${tag}` });
    const regionTool = await center('[data-tool="region"]');
    await clickAt(regionTool.x, regionTool.y);
    await waitUntil(async () => (await debug()).tool === 'region', { label: `tool-region-${tag}` });
    const grid2 = await visibleSpots([[0.55, 0.55], [0.85, 0.85]]);
    const [regionFrom, regionTo] = grid2.spots;
    const regionFromInfo = await elementInfoAt(regionFrom.x, regionFrom.y);
    check(`${tag} 状态2 框起终点都在图内、起手不在编号上`,
      insideBox(regionFrom, grid2.visible) && insideBox(regionTo, grid2.visible)
        && withinBox(grid2.visible, grid2.image)
        && Boolean(regionFromInfo) && regionFromInfo.inScroller && !regionFromInfo.inCard && !regionFromInfo.onMarker,
      { from: regionFrom, to: regionTo, sources: grid2.sources, info: regionFromInfo });
    await dragAt(regionFrom, regionTo);
    const noteTwo = await waitUntil(async () => { const d = await debug(); return d.notes.length === 2 && d; },
      { label: `region-${tag}` });
    const regionId = noteTwo && noteTwo.notes[1].id;
    const regionRing = await ringOf(regionId);
    // 框的圈心画在框左上角（就是拖拽起点的源坐标）：用同一套投影换回去核对。
    const regionAnchor = await toClient(grid2.sources[0].x, grid2.sources[0].y);
    check(`${tag} 状态2 真落下一处「框」批注，圈心就在拖拽起点`, Boolean(noteTwo)
      && noteTwo.notes[1].targets.some(target => target.kind === 'region')
      && near(regionRing, regionAnchor, 2), { notes: noteTwo && noteTwo.notes, ring: regionRing, anchor: regionAnchor,
        from: regionFrom, source: grid2.sources[0] });
    // 退出编辑、放下刚落的选中；画布稳定性从这个基准开始比。
    await escapeOnce();
    await waitUntil(async () => (await debug()).selectedTargets.length === 0, { label: `clear-before-connect-${tag}` });
    const bubblesHidden = await run(`(() => ({ note: document.querySelector('.ie-note-bubble').hidden,
      relation: document.querySelector('.ie-relation-bubble').hidden }))()`);
    check(`${tag} 连线前两个便签都已收起（不挡连线输入）`,
      bubblesHidden.note === true && bubblesHidden.relation === true, bubblesHidden);
    const stateBase = await geometry();
    const connectTool = await center('[data-tool="connect"]');
    await clickAt(connectTool.x, connectTool.y);
    await waitUntil(async () => (await debug()).tool === 'connect', { label: `tool-connect-${tag}` });
    // 连线输入取真实几何：起点是已有点的编号圈心，终点是这个框的真实内部中心（现读）。
    const lineFrom = await ringOf(pointId);
    const grid3 = await visibleSpots([[0.7, 0.7]]);
    const lineTo = grid3.spots[0];
    const lineFromInfo = await elementInfoAt(lineFrom.x, lineFrom.y);
    check(`${tag} 连线起点是已有点的真实圈心、终点在框内且都没被便签盖住`,
      Boolean(lineFrom) && insideBox(lineFrom, grid3.visible) && insideBox(lineTo, grid3.visible)
        && lineTo.x > regionFrom.x && lineTo.x < regionTo.x && lineTo.y > regionFrom.y && lineTo.y < regionTo.y
        && Boolean(lineFromInfo) && lineFromInfo.inScroller && !lineFromInfo.inCard,
      { from: lineFrom, to: lineTo, toSource: grid3.sources[0], info: lineFromInfo });
    await dragAt(lineFrom, lineTo);
    const relationOne = await waitUntil(async () => { const d = await debug(); return d.relations.length === 1 && d; },
      { label: `relation-${tag}` });
    check(`${tag} 连线连的是这两处真实批注`, Boolean(relationOne)
      && Boolean(relationOne.relations[0].a) && Boolean(relationOne.relations[0].b)
      && [relationOne.relations[0].a.annotationId, relationOne.relations[0].b.annotationId].sort().join('|')
        === [pointId, regionId].sort().join('|'),
      relationOne && relationOne.relations.map(relation => ({ a: relation.a, b: relation.b })));
    await run(`window.__fillTextLog = []; true`);
    await run(`(() => { const node = document.querySelector('.ie-relation-text'); node.focus(); node.select(); return true; })()`);
    await cdp('Input.insertText', { text: '这两处有关：先改上面的，再改下面。' });
    await sleep(120);
    const state2 = await geometry();
    const canvasDelta2 = Math.abs(state2.canvas.width - stateBase.canvas.width) + Math.abs(state2.canvas.height - stateBase.canvas.height);
    check(`${tag} 进入连线编辑后画布区域不变`, canvasDelta2 <= 1, { before: stateBase.canvas, after: state2.canvas });
    check(`${tag} 连线便签打开且夹在画布内`, state2.relationVisible && inside(state2.relation, state2.inner, 1)
      && state2.relation.left >= state2.canvas.left - 1 && state2.relation.right <= state2.canvas.right + 1
      && state2.relation.top >= state2.canvas.top - 1 && state2.relation.bottom <= state2.canvas.bottom + 1, state2.relation);
    check(`${tag} 删线入口在连线便签里`, await run(`(() => { const node = document.querySelector('.ie-relation-bubble [data-action="relation-delete"]');
      return Boolean(node) && node.textContent === '删线'; })()`));
    // 便签上的两端摘要：人话方向，不摆裸坐标；完整几何仍在 title 与成图说明里。
    const endsInfo = await run(`(() => { const node = document.querySelector('.ie-relation-ends');
      if (!node) return null;
      return { text: node.textContent, title: node.title, inside: node.getBoundingClientRect().width > 0 }; })()`);
    check(`${tag} 连线便签两端用人话方向、不露裸坐标`, Boolean(endsInfo)
      && !/[（(]\s*-?\d/.test(endsInfo.text) && /批注\s*1/.test(endsInfo.text) && endsInfo.text.includes('↔'),
      endsInfo);
    check(`${tag} 精确位置收进 title（完整几何没丢）`, Boolean(endsInfo)
      && /点 \(\d/.test(endsInfo.title) && /框 \(\d/.test(endsInfo.title), endsInfo);
    for (const [name, rect] of [['复制', state2.copy], ['保存', state2.save], ['返回', state2.back], ['撤销', state2.undo], ['重做', state2.redo]]) {
      check(`${tag} 关系态${name}入口仍在视口内`, inside(rect, state2.inner, 1), rect);
    }
    check(`${tag} 连线态主按钮仍稳稳在顶栏（不被便签盖住）`,
      state2.copy.bottom <= state2.canvas.top + 1 && state2.copy.right <= state2.inner[0] + 1,
      { copy: state2.copy, canvasTop: state2.canvas.top });
    // 画布上真的有线与中间标签：沿曲线取真实像素，再看 fillText 日志。
    const relationNow = await debug();
    const curve = relationNow.relations[0] && relationNow.relations[0].curve;
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    const line = curve ? await run(`(() => { const canvas = document.querySelector('.ie-display');
      const ctx = canvas.getContext('2d');
      const now = __imageEditorDebug();
      const dpr = canvas.width / Math.max(1, document.querySelector('.ie-scroll').clientWidth);
      let hit = 0, total = 0; const samples = [];
      for (const p of ${JSON.stringify(curve)}) {
        const x = Math.round((now.origin.x + p.x * now.zoom) * dpr);
        const y = Math.round((now.origin.y + p.y * now.zoom) * dpr);
        if (x < 1 || y < 1 || x >= canvas.width - 1 || y >= canvas.height - 1) continue;
        total += 1;
        const px = ctx.getImageData(x, y, 1, 1).data;
        if (px[0] > 190 && px[1] > 110 && px[1] < 205 && px[2] > 140 && px[2] < 215) hit += 1;
        if (samples.length < 6) samples.push({ x, y, px: [px[0], px[1], px[2]] });
      }
      return { hit, total, samples, origin: now.origin, zoom: now.zoom, dpr,
        canvas: { width: canvas.width, height: canvas.height },
        scroll: (() => { const s = document.querySelector('.ie-scroll');
          return { top: s.scrollTop, left: s.scrollLeft, width: s.clientWidth, height: s.clientHeight }; })(),
        pink: (() => { let count = 0, box = null;
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
            const i = (y * canvas.width + x) * 4;
            if (data[i] > 190 && data[i + 1] > 110 && data[i + 1] < 205 && data[i + 2] > 140 && data[i + 2] < 215) {
              count += 1; if (!box) box = { left: x, top: y, right: x, bottom: y };
              else { box.left = Math.min(box.left, x); box.top = Math.min(box.top, y);
                box.right = Math.max(box.right, x); box.bottom = Math.max(box.bottom, y); }
            }
          }
          return { count, box }; })() }; })()`) : { hit: 0, total: 0 };
    check(`${tag} 连线态画布上真看得见线（选中高亮色）`,
      Boolean(curve) && line.total >= 12 && line.pink && line.pink.count >= 40,
      { curve: curve && curve.length, line });
    const labelLog = ((await run('window.__fillTextLog || []')) || []).join('');
    check(`${tag} 连线中间标签画在画布上`, labelLog.includes('这两处有关'), { label: labelLog.slice(0, 40) });
    const shot2 = await saveShot('relation');
    check(`${tag} 连线态截图不是空白帧`, Boolean(shot2) && shot2.colors > 8, shot2 && shot2.colors);

    check(`${tag} 窗口底层始终不可见`, nativeVisible(win) === false, { nativeVisible: nativeVisible(win) });
  } finally {
    try { win.webContents.debugger.detach(); } catch { /* 已断开。 */ }
    host.cleanup(token);
  }
}

app.whenReady().then(async () => {
  // 一个宿主负责所有尺寸：rerenderer 只允许注册一次 IPC；窗口尺寸靠 setContentSize 设定。
  const host = makeHost();
  for (const size of SIZE_LIST) await runSize(host, size);
  host.dispose();
  fs.writeFileSync(path.join(EVIDENCE, 'layout-results.json'), JSON.stringify({ results, failures,
    dprNote: '离屏窗口按 setContentSize 设定的 CSS 尺寸渲染；截图里的像素是实际 devicePixelRatio 的结果，不是模拟缩放。' }, null, 1));
  console.log(JSON.stringify({ results, failures }, null, 1));
  probeGuard.finish();
  app.exit(failures.length ? 1 : 0);
}).catch(error => {
  console.error('FAIL', error);
  app.exit(1);
});
