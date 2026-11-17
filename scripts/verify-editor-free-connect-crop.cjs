/* 自由连线 × 裁切缺端：自动新点组跨裁切的短场景 + 真实截图（20261112 修订轮）。
   隐藏窗 + 隔离 userData + CDP 真实鼠标/键盘 + 真实工具按钮；不碰桌面、不碰系统剪贴板、不动现用进程。
   场景：空白→空白连线（自动落 2 个空点 + 1 条关系）→ 填共同说明 → 真实裁切收掉一端 →
   复制被缺端守卫拦下（不产生成功 PNG）→ 撤销裁切 / 撤销整组 / 两次重做，逐项看身份与光标。
   顺带在 480 / 1280 / 640 三种宽度下各存两张真实渲染图：临时起点的空心点、完成后的线与共同说明便签。
   运行：node_modules\electron\dist\electron.exe scripts\verify-editor-free-connect-crop.cjs */
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { installImageEditorWindow } = require('../main/image-editor-window.cjs');
const { installProbeGuard } = require('./probe-safety.cjs');

const ROOT = path.join(__dirname, '..');
// 证据目录：默认写回仓库的 evidence/20261112-free-connect；母会话独立复跑时用
// FREE_CONNECT_EVIDENCE_DIR 指到自己的目录，免得覆盖已提交的截图与 results。
const EVIDENCE = process.env.FREE_CONNECT_EVIDENCE_DIR || path.join(ROOT, 'evidence', '20261112-free-connect');
// 先装测试生命周期保护（任何日志之前）。
const probeGuard = installProbeGuard({ name: 'verify-editor-free-connect-crop' });
const results = [];
const failures = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures.push(name);
  return Boolean(ok);
};
const trace = (label, value) => console.log(`TRACE ${label} ${JSON.stringify(value)}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
// 离屏窗口：隐藏窗不产帧，截图拿不到；离屏才有真实 paint 帧（与布局探针同一手法）。
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

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-editor-free-connect-crop-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const commitLog = [];
  const host = installImageEditorWindow({
    BrowserWindow: OffscreenWindow,
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    ipcMain,
    rendererFile: path.join(ROOT, 'renderer', 'image-editor-window.html'),
    preloadFile: path.join(ROOT, 'main', 'image-editor-preload.cjs'),
    iconFile: path.join(ROOT, 'assets', 'app-icon.ico'),
    theme: undefined,
    onCommit: async (action, edited) => {
      commitLog.push({ action, bytes: edited && edited.png ? edited.png.length : 0 });
      return { ok: true };
    },
    onClose: async () => true,
    onExit: async () => false,
    onStatus: () => {}
  });

  // 一个窗口一套交互：尺寸只影响布局与坐标，别的都一样。
  const openEditor = async (tag, cssWidth, cssHeight) => {
    const token = `free-crop-${tag}-${Date.now()}`;
    const opened = host.open({ token, width: 480, height: 360,
      rect: { x: 0, y: 0, width: cssWidth, height: cssHeight } }, { dataUrl: dataUrlOf(makePng(480, 360)) });
    const win = await waitUntil(async () => host.getWindow(token), { timeout: 9000, label: `window-${tag}` });
    if (!win) throw new Error('窗口没起来');
    let frame = null;
    win.webContents.on('paint', (_event, _dirty, image) => { if (image && !image.isEmpty()) frame = image; });
    const run = code => win.webContents.executeJavaScript(code, true);
    await waitUntil(() => run('Boolean(window.__imageEditorDebug)').catch(() => false), { timeout: 9000, label: `page-${tag}` });
    await opened;
    win.setContentSize(cssWidth, cssHeight);
    await sleep(320);
    win.webContents.debugger.attach('1.3');
    const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
    const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent',
      { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra });
    const clickAt = async (x, y) => {
      await mouse('mouseMoved', x, y, { buttons: 0 });
      await mouse('mousePressed', x, y, { buttons: 1 });
      await mouse('mouseReleased', x, y, { buttons: 0 });
      await sleep(80);
    };
    const dragAt = async (from, to) => {
      await mouse('mouseMoved', from.x, from.y, { buttons: 0 });
      await mouse('mousePressed', from.x, from.y, { buttons: 1 });
      for (let step = 1; step <= 8; step += 1) {
        await mouse('mouseMoved', from.x + ((to.x - from.x) * step) / 8, from.y + ((to.y - from.y) * step) / 8, { buttons: 1 });
      }
      await mouse('mouseReleased', to.x, to.y, { buttons: 0 });
      await sleep(90);
    };
    const escapeOnce = async () => {
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(70);
    };
    const debug = () => run('__imageEditorDebug()');
    const status = () => run(`document.querySelector('.ie-status').textContent`);
    const center = sel => run(`(() => { const node = document.querySelector(${JSON.stringify(sel)});
      if (!node) return null; const r = node.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const action = async sel => {
      const spot = await center(sel);
      if (!spot) throw new Error(`找不到 ${sel}`);
      await clickAt(spot.x, spot.y);
    };
    const tool = async name => {
      await action(`[data-tool="${name}"]`);
      return waitUntil(async () => (await debug()).tool === name, { label: `tool-${name}` });
    };
    // 图像坐标 → 屏幕坐标：每次现算当前 origin/zoom，不沿用旧坐标。
    const toClient = async (x, y) => {
      const d = await debug();
      const rect = await run(`(() => { const r = document.querySelector('.ie-scroll').getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.clientWidth, height: r.clientHeight }; })()`);
      return { x: rect.left + d.origin.x + x * d.zoom, y: rect.top + d.origin.y + y * d.zoom };
    };
    // 看得见的那块图（源图像素坐标）：图像区 ∩ 画布视口。落点必须落在这里，
    // 否则松手会在画布外，编辑器收不到 pointerup。
    const visibleSourceRect = async () => {
      const d = await debug();
      const rect = await run(`(() => { const el = document.querySelector('.ie-scroll'); const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, width: el.clientWidth, height: el.clientHeight }; })()`);
      const left = Math.max(d.view.x, (d.origin.x - d.origin.x) / d.zoom);
      const top = Math.max(d.view.y, (d.origin.y - d.origin.y) / d.zoom);
      const right = Math.min(d.view.x + d.view.width, (rect.width - d.origin.x) / d.zoom);
      const bottom = Math.min(d.view.y + d.view.height, (rect.height - d.origin.y) / d.zoom);
      return { left, top, right, bottom, zoom: d.zoom, origin: d.origin, scroller: rect, view: d.view };
    };
    // 看得见的那块图里的一个源图像素点（比例 0~1）。
    const visibleSpot = async (fx, fy) => {
      const r = await visibleSourceRect();
      const x = r.left + (r.right - r.left) * fx;
      const y = r.top + (r.bottom - r.top) * fy;
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`看得见的图区算不出来：${JSON.stringify(r)}`);
      return toClient(x, y);
    };
    // 隐藏窗的截图走 paint 帧（capturePage 对隐藏窗不稳）：先丢旧帧再 invalidate。
    const shot = async name => {
      await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
      frame = null;
      win.webContents.invalidate();
      const captured = await waitUntil(() => frame, { timeout: 4000, label: `frame-${tag}-${name}` });
      if (!captured) return null;
      const target = path.join(EVIDENCE, `free-connect-${tag}-${name}.png`);
      fs.writeFileSync(target, captured.toPNG());
      const size = captured.getSize();
      trace(`shot-${tag}-${name}`, { file: path.relative(ROOT, target), size });
      return { file: target, size };
    };
    return { tag, win, run, cdp, clickAt, dragAt, escapeOnce, debug, status, center, action, tool, toClient, shot,
      visibleSourceRect, visibleSpot,
      close: () => { host.cleanup(token); } };
  };

  const finish = () => {
    fs.writeFileSync(path.join(EVIDENCE, 'free-connect-crop-results.json'),
      JSON.stringify({ results, failures }, null, 1));
    console.log(JSON.stringify({ results, failures }, null, 1));
    host.dispose();
    probeGuard.finish();
    app.exit(failures.length ? 1 : 0);
  };

  // —— 三种宽度下的真实渲染图：临时起点的空心点 + 完成后的线与共同说明便签 ——
  for (const [tag, width, height] of [['480', 480, 360], ['1280', 1280, 800], ['640', 640, 480]]) {
    const ed = await openEditor(tag, width, height);
    await ed.tool('connect');
    // 落点取自“看得见的那块图”，不按整个 scroller 比例猜。
    const start = await ed.visibleSpot(0.2, 0.25);
    const end = await ed.visibleSpot(0.8, 0.75);
    await ed.clickAt(start.x, start.y);
    const armed = await waitUntil(async () => { const d = await ed.debug(); return d.connect && d.connect.phase === 'armed' && d; },
      { label: `armed-${tag}` });
    check(`${tag} 宽：空白第一击只是暂存起点（画面上是那个空心点）`,
      Boolean(armed) && armed.connect.start.annotationId === undefined && armed.connect.start.point
      && typeof armed.connect.start.point.x === 'number', armed && armed.connect);
    const armedShot = await ed.shot('armed-start-dot');
    check(`${tag} 宽：存下临时起点的真实渲染图`, Boolean(armedShot), armedShot && armedShot.file);
    // 取消这次起手，再重新拖一条线完成连接（截图要的是完成态的真实渲染）。
    await ed.escapeOnce();
    await ed.tool('connect');
    await ed.dragAt(start, end);
    const linked = await waitUntil(async () => { const d = await ed.debug(); return d.relations.length === 1 && d; },
      { label: `linked-${tag}` });
    check(`${tag} 宽：空白→空白拖出一条线并落两个空点`,
      Boolean(linked) && linked.notes.length === 2 && linked.notes.every(note => !note.text),
      linked && { notes: linked.notes.length, relations: linked.relations.length, status: await ed.status() });
    const bubbleOpen = await ed.run(`document.querySelector('.ie-relation-bubble').hidden === false`);
    check(`${tag} 宽：完成后只开共同说明便签`, bubbleOpen === true, { bubbleOpen });
    const doneShot = await ed.shot('connected-bubble');
    check(`${tag} 宽：存下完成后的真实渲染图`, Boolean(doneShot), doneShot && doneShot.file);
    check(`${tag} 宽：窗口底层始终不可见`, nativeVisible(ed.win) === false, { nativeVisible: nativeVisible(ed.win) });
    ed.close();
  }

  // —— 短场景：自动新点组跨裁切缺端（宽窗：整张 480×360 都看得见，落点才能按源坐标取）——
  const ed = await openEditor('crop', 1280, 800);
  await ed.tool('connect');
  const keep = await ed.toClient(80, 80);          // 会被裁进来的一端
  const drop = await ed.toClient(400, 300);         // 会被完整裁掉的一端
  await ed.dragAt(keep, drop);
  const made = await waitUntil(async () => { const d = await ed.debug(); return d.relations.length === 1 && d; },
    { label: 'crop-made' });
  check('前提：空白→空白生成 2 个空点 + 1 条关系',
    Boolean(made) && made.notes.length === 2 && made.relations.length === 1,
    made && { notes: made.notes.length, relations: made.relations.length, status: await ed.status() });
  if (!made) { finish(); return; }
  const relation = made.relations[0];  const endA = relation.a, endB = relation.b;
  const cursorAfterLink = made.cursor;
  // 填共同说明（走真实的输入框与 input 事件）。
  await ed.run(`(() => { const node = document.querySelector('.ie-relation-text'); node.focus(); node.select(); return true; })()`);
  await ed.cdp('Input.insertText', { text: '这两处一起看' });
  await sleep(120);
  const texted = await ed.debug();
  check('前提：共同说明写在这条线上', texted.relations[0].text === '这两处一起看', texted.relations[0].text);

  // 真实裁切工具：进裁切后重新取当前 origin/zoom，把右下句柄拖到 (200,160)。
  await ed.tool('crop');
  const live = await ed.debug();
  const bounds = await ed.run(`(() => { const r = document.querySelector('.ie-scroll').getBoundingClientRect();
    return { left: r.left, top: r.top }; })()`);
  const to = (x, y) => ({ x: bounds.left + live.origin.x + x * live.zoom,
    y: bounds.top + live.origin.y + y * live.zoom });
  const from = to(live.view.x + live.view.width, live.view.y + live.view.height);
  await ed.dragAt(from, to(live.view.x + 200, live.view.y + 160));
  const cropSize = await ed.run(`document.querySelector('.ie-crop-size').textContent`);
  check('裁切框收成 200×160', /200 × 160/.test(String(cropSize)), cropSize);
  await ed.action('[data-action="crop-apply"]');
  const cropped = await waitUntil(async () => { const d = await ed.debug(); return d.view.width === 200 && d; },
    { label: 'crop-applied', timeout: 5000 });
  check('裁切已应用：画面变成 200×160',
    Boolean(cropped) && cropped.view.width === 200 && cropped.view.height === 160,
    cropped && cropped.view);
  const afterCrop = await ed.debug();
  check('裁掉一端后关系变成缺端（complete=false）',
    afterCrop.relations.length === 1 && afterCrop.relations[0].complete === false,
    afterCrop.relations[0]);
  check('幸存的那一条批注还在，身份与最初相同',
    afterCrop.notes.length === 1
      && (afterCrop.notes[0].id === endA.annotationId || afterCrop.notes[0].id === endB.annotationId),
    { notes: afterCrop.notes.map(note => note.id), endA: endA.annotationId, endB: endB.annotationId });
  const survivor = afterCrop.relations[0].a && afterCrop.relations[0].a.annotationId === endA.annotationId
    ? endA : endB;
  check('幸存端的 stable ID 与最初完全一致',
    afterCrop.notes[0].id === survivor.annotationId
      && afterCrop.notes[0].targets[0].targetId === survivor.targetId,
    { now: afterCrop.notes[0], was: survivor });

  // 复制：缺端 + 空点必须被守卫拦下（不产生成功 PNG），并把两件事都说清楚。
  const commitsBefore = commitLog.length;
  await ed.action('[data-action="copy"]');
  await sleep(2500);
  const copyStatus = await ed.status();
  check('复制被缺端守卫拦下：短窗内没有成功 PNG',
    commitLog.length === commitsBefore, { commits: commitLog.length, before: commitsBefore });
  check('状态同时说清：这一处既没正文也没被有效关系覆盖',
    /既没正文|没被有效关系覆盖/.test(String(copyStatus)), copyStatus);
  check('状态同时说清：关系1 的另一端不在当前画面，不能当作已说明',
    /关系1/.test(String(copyStatus)) && /另一端不在/.test(String(copyStatus))
      && /不能当作已说明/.test(String(copyStatus)), copyStatus);

  // 撤销裁切：回到 480×360，两端与身份都回来，光标只退一步（不吞掉自动点组）。
  await ed.run(`document.querySelector('.ie-scroll').focus()`);
  await ed.action('[data-action="undo"]');
  const afterUndoCrop = await waitUntil(async () => { const d = await ed.debug(); return d.view.width === 480 && d; },
    { label: 'undo-crop', timeout: 5000 });
  check('撤销裁切：画面回到 480×360',
    Boolean(afterUndoCrop) && afterUndoCrop.view.width === 480 && afterUndoCrop.view.height === 360,
    afterUndoCrop && afterUndoCrop.view);
  check('撤销裁切：关系恢复完整，两端原 ID 都在',
    afterUndoCrop.relations.length === 1 && afterUndoCrop.relations[0].complete === true
      && afterUndoCrop.notes.length === 2
      && afterUndoCrop.notes.map(note => note.id).includes(endA.annotationId)
      && afterUndoCrop.notes.map(note => note.id).includes(endB.annotationId),
    afterUndoCrop && { notes: afterUndoCrop.notes.map(note => note.id), complete: afterUndoCrop.relations[0].complete });
  check('撤销裁切只退一步（自动点组没被吞掉）',
    afterUndoCrop.cursor === cursorAfterLink && afterUndoCrop.ops === cursorAfterLink + 1,
    { cursor: afterUndoCrop.cursor, ops: afterUndoCrop.ops, expect: cursorAfterLink });

  // 再撤销一次：整组连线（新点 + 关系）一起回退。
  await ed.action('[data-action="undo"]');
  const afterUndoGroup = await waitUntil(async () => { const d = await ed.debug(); return d.notes.length === 0 && d; },
    { label: 'undo-group', timeout: 5000 });
  check('再撤销一次：两个新点与关系一起回退',
    Boolean(afterUndoGroup) && afterUndoGroup.notes.length === 0 && afterUndoGroup.relations.length === 0,
    afterUndoGroup && { notes: afterUndoGroup.notes.length, relations: afterUndoGroup.relations.length });

  // 重做：整组恢复同一身份与共同说明；再重做：裁切恢复，缺端回来。
  await ed.action('[data-action="redo"]');
  const afterRedoGroup = await waitUntil(async () => { const d = await ed.debug(); return d.relations.length === 1 && d; },
    { label: 'redo-group', timeout: 5000 });
  check('重做一次：整组恢复，身份与共同说明都回来',
    Boolean(afterRedoGroup) && afterRedoGroup.notes.length === 2
      && afterRedoGroup.notes.map(note => note.id).join('|') === `${endA.annotationId}|${endB.annotationId}`
      && afterRedoGroup.relations[0].text === '这两处一起看',
    afterRedoGroup && { notes: afterRedoGroup.notes.map(note => note.id), text: afterRedoGroup.relations[0].text });
  await ed.action('[data-action="redo"]');
  const afterRedoCrop = await waitUntil(async () => { const d = await ed.debug(); return d.view.width === 200 && d; },
    { label: 'redo-crop', timeout: 5000 });
  check('再重做一次：裁切恢复，缺端状态也恢复',
    Boolean(afterRedoCrop) && afterRedoCrop.relations.length === 1 && afterRedoCrop.relations[0].complete === false
      && afterRedoCrop.notes.length === 1,
    afterRedoCrop && { view: afterRedoCrop.view, complete: afterRedoCrop.relations[0].complete,
      notes: afterRedoCrop.notes.length });

  const cropShot = await ed.shot('crop-missing-end');
  check('存下缺端状态的真实渲染图', Boolean(cropShot), cropShot && cropShot.file);
  check('窗口底层始终不可见', nativeVisible(ed.win) === false, { nativeVisible: nativeVisible(ed.win) });
  ed.close();
  finish();
}

app.whenReady().then(main).catch(error => {
  console.error('FAIL', error);
  app.exit(1);
});
