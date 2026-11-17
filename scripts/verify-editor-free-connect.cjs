/* 真实 CDP 验收「自由连线」（20261112）：连线随时可用，空白自动落点，已有点/框吸附复用。
   隐藏窗 + 隔离 userData + CDP 真实鼠标/键盘 + 真实工具按钮；不碰桌面、不碰系统剪贴板、不动现用进程。
   覆盖：
   - 从零开始（一条批注都没有）：拖动与两次点击的空白→空白，一次动作 = 2 个空点 + 1 条关系；
   - 混合：已有→空白、空白→已有（拖/两击）、已有→已有；吸附已有不复制批注；
   - 只开共同说明、不弹第二份输入；写一句共同说明就能导出，两个空点都被它覆盖；
   - 主图逐像素：先复制一张无批注基线，连线后再复制，主图区 480×360＝172800 像素 RGBA 全部相同（含笔迹/遮盖）；
   - 组撤销/重做：一次撤销撤掉自动新点与线，原有批注与文字不动；一次重做恢复相同身份与共同说明；
   - 取消：Esc、右键、图外松手、两次点太近都不留正式新点/线/历史；邻接画笔不被组撤销吞掉。
   运行：node_modules\electron\dist\electron.exe scripts\verify-editor-free-connect.cjs */
'use strict';
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { installImageEditorWindow } = require('../main/image-editor-window.cjs');
const { installProbeGuard } = require('./probe-safety.cjs');

const ROOT = path.join(__dirname, '..');
// 先装测试生命周期保护（任何日志之前）：断管／未捕获异常／超时都落故障文件并非 0 退出。
const probeGuard = installProbeGuard({ name: 'verify-editor-free-connect' });
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
class HiddenWindow extends BrowserWindow {
  constructor(options = {}) {
    super({ ...options, show: false });
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

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-editor-free-connect-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

async function main() {
  const commitLog = [];
  const host = installImageEditorWindow({
    BrowserWindow: HiddenWindow,
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    ipcMain,
    rendererFile: path.join(ROOT, 'renderer', 'image-editor-window.html'),
    preloadFile: path.join(ROOT, 'main', 'image-editor-preload.cjs'),
    iconFile: path.join(ROOT, 'assets', 'app-icon.ico'),
    theme: undefined,
    onCommit: async (action, edited) => {
      commitLog.push({ action, png: edited && edited.png ? edited.png : null,
        size: edited && edited.clipboardSize || null, bytes: edited && edited.png ? edited.png.length : 0 });
      return { ok: true };
    },
    onClose: async () => true,
    onExit: async () => false,
    onStatus: () => {}
  });
  const token = `free-connect-${Date.now()}`;
  const opened = host.open({ token, width: 480, height: 360, rect: { x: 0, y: 0, width: 480, height: 360 } },
    { dataUrl: dataUrlOf(makePng(480, 360)) });
  const win = await waitUntil(async () => host.getWindow(token), { timeout: 9000, label: 'window' });
  if (!win) { host.dispose(); throw new Error('窗口没起来'); }
  const run = code => win.webContents.executeJavaScript(code, true);
  await waitUntil(() => run('Boolean(window.__imageEditorDebug)').catch(() => false), { timeout: 9000, label: 'page' });
  await opened;
  win.webContents.debugger.attach('1.3');
  const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
  const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent',
    { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra });
  const clickAt = async (x, y) => {
    await mouse('mouseMoved', x, y, { buttons: 0 });
    await mouse('mousePressed', x, y, { buttons: 1 });
    await mouse('mouseReleased', x, y, { buttons: 0 });
    await sleep(70);
  };
  const rightClickAt = async (x, y) => {
    await mouse('mouseMoved', x, y, { buttons: 0 });
    await mouse('mousePressed', x, y, { buttons: 2, button: 'right' });
    await mouse('mouseReleased', x, y, { buttons: 0, button: 'right' });
    await sleep(70);
  };
  const dragAt = async (from, to) => {
    await mouse('mouseMoved', from.x, from.y, { buttons: 0 });
    await mouse('mousePressed', from.x, from.y, { buttons: 1 });
    for (let step = 1; step <= 8; step += 1) {
      await mouse('mouseMoved', from.x + ((to.x - from.x) * step) / 8, from.y + ((to.y - from.y) * step) / 8, { buttons: 1 });
    }
    await mouse('mouseReleased', to.x, to.y, { buttons: 0 });
    await sleep(70);
  };
  const escapeOnce = async () => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(60);
  };
  const typeInto = async (selector, text) => {
    await run(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.focus(); node.select(); return true; })()`);
    await cdp('Input.insertText', { text });
    await sleep(60);
  };
  const center = sel => run(`(() => { const node = document.querySelector(${JSON.stringify(sel)});
    if (!node) return null; const r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const debug = () => run('__imageEditorDebug()');
  const toClient = async (x, y) => {
    const d = await debug();
    const rect = await run(`(() => { const r = document.querySelector('.ie-scroll').getBoundingClientRect();
      return { left: r.left, top: r.top }; })()`);
    return { x: rect.left + d.origin.x + x * d.zoom, y: rect.top + d.origin.y + y * d.zoom };
  };
  const ringOf = id => run(`(() => { const button = document.querySelector('.ie-marker[data-annotation-id="' + ${JSON.stringify(id)} + '"]');
    if (!button) return null; const figure = button.closest('.ie-marker-figure');
    const ring = figure && figure.querySelector('.ie-marker-ring');
    const anchor = (ring || button).getBoundingClientRect();
    return { x: anchor.left + anchor.width / 2, y: anchor.top + anchor.height / 2 }; })()`);
  const elementInfoAt = async (x, y) => run(`(() => { const n = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
    if (!n) return null; return { cls: String(n.className || n.tagName),
      inCard: Boolean(n.closest && n.closest('.ie-note-card')),
      onMarker: Boolean(n.closest && n.closest('.ie-marker')),
      inScroller: Boolean(n.closest && n.closest('.ie-scroll')) }; })()`);
  const imageRect = async () => {
    const d = await debug();
    const rect = await run(`(() => { const r = document.querySelector('.ie-scroll').getBoundingClientRect();
      return { left: r.left, top: r.top }; })()`);
    return { left: rect.left + d.origin.x + d.view.x * d.zoom, top: rect.top + d.origin.y + d.view.y * d.zoom,
      right: rect.left + d.origin.x + (d.view.x + d.view.width) * d.zoom,
      bottom: rect.top + d.origin.y + (d.view.y + d.view.height) * d.zoom };
  };
  const canvasPath = value => /ie-scroll|ie-display|ie-workspace|ie-spacer/.test(String(value));
  // 线中点（图像坐标 → 屏幕）：点旧线要用真实位置，不用编号片的 DOM 偏移。
  const lineSpot = async (relation, fraction = 0.5) => {
    const curve = relation && relation.curve;
    if (!curve || !curve.length) return null;
    const index = Math.max(1, Math.min(curve.length - 2, Math.round((curve.length - 1) * fraction)));
    return toClient(curve[index].x, curve[index].y);
  };
  const tool = async name => {
    const spot = await center(`[data-tool="${name}"]`);
    if (!spot) throw new Error(`找不到工具 ${name}`);
    await clickAt(spot.x, spot.y);
    return waitUntil(async () => (await debug()).tool === name, { label: `tool-${name}` });
  };
  // 口径：落点真的在画布上、不在便签/编号上，避免“点空了”被当成业务通过。
  const aim = async (x, y, label) => {
    const spot = await toClient(x, y);
    const info = await elementInfoAt(spot.x, spot.y);
    check(`口径：${label} 落在画布上（不在便签/编号上）`,
      Boolean(info) && info.inScroller && !info.inCard && !info.onMarker, { spot, info });
    return { spot, info };
  };
  // 真正空的起手位置：按下后必须是新起点（不是选中旧线）；候选不够就当场换下一个。
  const freePress = async candidates => {
    for (const [x, y] of candidates) {
      const spot = await toClient(x, y);
      const info = await elementInfoAt(spot.x, spot.y);
      if (!info || !info.inScroller || info.inCard || info.onMarker) continue;
      await mouse('mouseMoved', spot.x, spot.y, { buttons: 0 });
      await mouse('mousePressed', spot.x, spot.y, { buttons: 1 });
      const state = await debug();
      if (state.connect && state.connect.start && state.connect.start.annotationId === undefined) return { spot, state };
      await mouse('mouseReleased', spot.x, spot.y, { buttons: 0 });
      await escapeOnce();
    }
    return null;
  };
  const dragFromPressed = async (from, to) => {
    for (let step = 1; step <= 8; step += 1) {
      await mouse('mouseMoved', from.x + ((to.x - from.x) * step) / 8, from.y + ((to.y - from.y) * step) / 8, { buttons: 1 });
    }
    await mouse('mouseReleased', to.x, to.y, { buttons: 0 });
    await sleep(70);
  };
  const installFillTextHook = () => run(`(() => { const proto = CanvasRenderingContext2D.prototype;
    if (!window.__fillTextHook) { const original = proto.fillText;
      proto.fillText = function (text, ...rest) { (window.__fillTextLog = window.__fillTextLog || []).push(String(text));
        return original.call(this, text, ...rest); };
      window.__fillTextHook = true; }
    window.__fillTextLog = []; return true; })()`);
  const fillTextLog = async () => ((await run('window.__fillTextLog || []')) || []).join('\n');
  // 复制门禁用 30s：隐藏窗里的首次 canvas 光栅化+PNG 编码在本机会被拉长到十几秒（旧 link 探针的 5s 门禁就为此红过），
  // 这里要验的是「出图与像素一致」，不是编码延迟；不催逼、不重试、少一次都不算过。
  const copyNow = async () => {
    const before = commitLog.length;
    const button = await center('[data-action="copy"]');
    await clickAt(button.x, button.y);
    const entry = await waitUntil(() => commitLog.length > before && commitLog[commitLog.length - 1],
      { label: 'copy-commit', timeout: 30000, interval: 120 });
    await waitUntil(async () => { const d = await debug(); return !d.busy && d; }, { label: 'copy-idle', timeout: 30000 });
    return entry;
  };

  await installFillTextHook();

  // —— 0. 先画一条笔迹 + 一块遮盖，复制一张无批注的安全基线（主图逐像素对照的参照）——
  await tool('pen');
  const basePenA = await aim(80, 250, '基线笔迹起点');
  const basePenB = await aim(180, 300, '基线笔迹终点');
  await dragAt(basePenA.spot, basePenB.spot);
  await tool('rect');
  const baseMaskA = await aim(320, 240, '基线遮盖起点');
  const baseMaskB = await aim(440, 340, '基线遮盖终点');
  await dragAt(baseMaskA.spot, baseMaskB.spot);
  const baselinePainted = await debug();
  check('前提：基线上有一条笔迹和一块遮盖（两条真实像素 op）',
    baselinePainted.paint.length === 2 && baselinePainted.notes.length === 0,
    { paint: baselinePainted.paint.length, notes: baselinePainted.notes.length });
  const baselinePaintCount = baselinePainted.paint.length;
  const baselineCopy = await copyNow();
  const baselineImage = baselineCopy && baselineCopy.png
    ? nativeImage.createFromBuffer(Buffer.from(baselineCopy.png)) : null;
  const baselineBitmap = baselineImage ? baselineImage.toBitmap() : null;
  const baselineSize = baselineImage ? baselineImage.getSize() : null;
  check('基线复制出口出图（无批注时就是原尺寸主图）',
    Boolean(baselineBitmap) && baselineSize.width === 480 && baselineSize.height === 360,
    { bytes: baselineCopy && baselineCopy.bytes, size: baselineSize });
  // —— 1. 一条批注都没有：连线随手可用 ——
  const state0 = await run(`(() => { const node = document.querySelector('[data-tool="connect"]');
    return { disabled: node.disabled, title: node.title }; })()`);
  check('没有批注时连线也可用，标题说清空白会落点',
    state0.disabled === false && /空白/.test(String(state0.title)), state0);
  const start0 = await debug();
  check('前提：打开时没有任何批注',
    start0.notes.length === 0 && start0.relations.length === 0, { notes: start0.notes.length });

  await tool('connect');
  const a = await aim(120, 120, '起点');
  const b = await aim(320, 240, '终点');
  const beforeDrag = await debug();
  await dragAt(a.spot, b.spot);
  const dragged = await waitUntil(async () => { const d = await debug(); return d.relations.length === 1 && d; }, { label: 'drag-blank-line' });
  check('从零开始：空白→空白拖一下就连上', Boolean(dragged), dragged && dragged.relations.length);
  check('一次动作 = 两个空点 + 一条线（空点没有假占位字）',
    Boolean(dragged) && dragged.notes.length === 2 && dragged.notes.every(note => !note.text)
      && dragged.cursor === beforeDrag.cursor + 3 && dragged.ops === beforeDrag.ops + 3,
    dragged && { notes: dragged.notes.map(note => note.text), cursor: dragged.cursor, base: beforeDrag.cursor });
  check('成功后只选中这条线，线旁便签打开、批注便签不弹第二份输入',
    Boolean(dragged) && dragged.selectedRelationId === dragged.relations[0].id
      && (await run(`document.querySelector('.ie-relation-bubble').hidden`)) === false
      && (await run(`document.querySelector('.ie-note-bubble').hidden`)) === true,
    dragged && { selected: dragged.selectedRelationId });
  check('新落下的两个点都是普通点批注（之后可以单独选中改字）',
    Boolean(dragged) && dragged.notes.every(note => note.targets.length === 1 && note.targets[0].kind === 'point'),
    dragged && dragged.notes.map(note => note.targets));
  const statusAfter = await run(`document.querySelector('.ie-status').textContent`);
  check('状态直接引导写这一条共同说明', /共同说明/.test(statusAfter), statusAfter);

  // —— 2. 组撤销 / 重做 ——
  const groupIds = dragged.notes.map(note => note.id).join('|');
  await run(`document.querySelector('.ie-scroll').focus()`);
  const undoSpot = await center('[data-action="undo"]');
  await clickAt(undoSpot.x, undoSpot.y);
  const undoGroup = await waitUntil(async () => { const d = await debug(); return d.notes.length === 0 && d; }, { label: 'undo-group' });
  check('一次撤销把自动新点和这条线一起撤掉（不先撤走一个点）',
    Boolean(undoGroup) && undoGroup.relations.length === 0 && undoGroup.cursor === beforeDrag.cursor,
    undoGroup && { notes: undoGroup.notes.length, relations: undoGroup.relations.length, cursor: undoGroup.cursor });
  const redoSpot = await center('[data-action="redo"]');
  await clickAt(redoSpot.x, redoSpot.y);
  const redoGroup = await waitUntil(async () => { const d = await debug(); return d.relations.length === 1 && d; }, { label: 'redo-group' });
  check('一次重做恢复相同的稳定身份与那条线',
    Boolean(redoGroup) && redoGroup.notes.map(note => note.id).join('|') === groupIds
      && redoGroup.notes.every(note => !note.text),
    redoGroup && { ids: redoGroup.notes.map(note => note.id) });

  // —— 3. 只写一句共同说明就能导出，两个空点都被覆盖 ——
  // 重做不自动选中那条线（选择是暂态），先按真实路径点一下线再写。
  const reselect = await lineSpot(redoGroup.relations[0], 0.5);
  check('口径：重做后的线中点落在画布上', Boolean(reselect), reselect);
  await clickAt(reselect.x, reselect.y);
  const selectedLine = await waitUntil(async () => { const d = await debug();
    return d.selectedRelationId === redoGroup.relations[0].id && d; }, { label: 'reselect-line' });
  check('点一下线就能重新展开共同说明', Boolean(selectedLine),
    selectedLine && selectedLine.selectedRelationId);
  await typeInto('.ie-relation-text', '这两处一起看');
  await run(`document.querySelector('.ie-scroll').focus()`);
  await installFillTextHook();
  const copyEntry = await copyNow();
  const descText = await fillTextLog();
  check('复制走真实按钮并成功交给宿主（不碰系统剪贴板）',
    Boolean(copyEntry) && copyEntry.action === 'copy' && copyEntry.bytes > 0,
    copyEntry && { action: copyEntry.action, bytes: copyEntry.bytes, size: copyEntry.size });
  check('说明区因此加高（两个空点也进了成品说明）',
    Boolean(copyEntry) && copyEntry.size && copyEntry.size.height > 360, copyEntry && copyEntry.size);
  const covered = (descText.match(/见 关系1/g) || []).length;
  check('两个空点都被这一句共同说明覆盖，不逼着各写一句', covered === 2, descText.split('\n').slice(0, 6));
  const described = [...descText.matchAll(/第 \d+ 条 · 点 \((-?[\d.]+), (-?[\d.]+)\)/g)]
    .map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
  const nearStart = described.some(item => Math.abs(item.x - 120) <= 1.5 && Math.abs(item.y - 120) <= 1.5);
  const nearEnd = described.some(item => Math.abs(item.x - 320) <= 1.5 && Math.abs(item.y - 240) <= 1.5);
  check('空点坐标就是起手/松手的位置（没被 clamp 或吸附到别处）',
    described.length === 2 && nearStart && nearEnd, described);
  const afterText = await debug();
  check('共同说明写在线上，两端批注仍各自为空、没有被塞进假字',
    afterText.relations[0].text === '这两处一起看' && afterText.notes.every(note => !note.text),
    afterText && { relation: afterText.relations[0].text, notes: afterText.notes.map(note => note.text) });

  // —— 3b. 主图逐像素对照：有批注/连线以后，主图区仍与无批注基线完全一致（含笔迹/遮盖）——
  if (copyEntry && copyEntry.png && baselineBitmap && baselineSize) {
    const finalImage = nativeImage.createFromBuffer(Buffer.from(copyEntry.png));
    const finalSize = finalImage.getSize();
    const finalBitmap = finalImage.toBitmap();
    const areaWidth = Math.min(480, finalSize.width, baselineSize.width);
    const areaHeight = Math.min(360, finalSize.height, baselineSize.height);
    let samples = 0, mismatches = 0;
    const bad = [];
    for (let y = 0; y < areaHeight; y += 1) {
      for (let x = 0; x < areaWidth; x += 1) {
        const offset = (y * finalSize.width + x) * 4;
        const base = (y * baselineSize.width + x) * 4;
        samples += 1;
        const same = finalBitmap[offset] === baselineBitmap[base]
          && finalBitmap[offset + 1] === baselineBitmap[base + 1]
          && finalBitmap[offset + 2] === baselineBitmap[base + 2]
          && finalBitmap[offset + 3] === baselineBitmap[base + 3];
        if (same) continue;
        mismatches += 1;
        if (bad.length < 5) bad.push({ x, y });
      }
    }
    check('主图区 172800 个像素 RGBA 逐像素与无批注基线完全一致（不抽样、不排除笔迹/遮盖）',
      areaWidth === 480 && areaHeight === 360 && samples === 480 * 360 && mismatches === 0,
      { samples, mismatches, areaWidth, areaHeight, finalSize, baselineSize, bad });
    check('复制图仍带下方说明区（批注信息只在下方，不进主图）', finalSize.height > 360, finalSize);
  } else {
    check('主图逐像素对照可用（需要基线图与本次复制的字节）', false,
      { hasBaseline: Boolean(baselineBitmap), hasBytes: Boolean(copyEntry && copyEntry.png) });
  }

  // —— 4. 两次点击的空白→空白；再到混合吸附 ——
  await escapeOnce();
  await run(`document.querySelector('.ie-scroll').focus()`);
  await clickAt(undoSpot.x, undoSpot.y);
  const cleared = await waitUntil(async () => { const d = await debug(); return d.notes.length === 0 && d; }, { label: 'undo-before-click-mode' });
  check('前提：组撤销后回到 0 条批注（共同说明也随线撤走）',
    Boolean(cleared) && cleared.relations.length === 0 && cleared.cursor === beforeDrag.cursor,
    cleared && cleared.cursor);
  await tool('connect');
  const c1 = await aim(60, 320, '第一击空白');
  const c2 = await aim(420, 60, '第二击空白');
  await clickAt(c1.spot.x, c1.spot.y);
  const armed = await waitUntil(async () => { const d = await debug(); return d.connect && d.connect.phase === 'armed' && d; }, { label: 'blank-armed' });
  check('空白第一击只是暂存坐标：不落批注、不写历史',
    Boolean(armed) && armed.notes.length === 0 && armed.cursor === beforeDrag.cursor
      && typeof armed.connect.start.point?.x === 'number' && armed.connect.start.annotationId === undefined,
    armed && armed.connect);
  const beforeSecond = await debug();
  await clickAt(c2.spot.x, c2.spot.y);
  const clicked = await waitUntil(async () => { const d = await debug(); return d.relations.length === 1 && d; }, { label: 'click-blank-line' });
  check('两次点击也是同一种关系：又一 2 个空点 + 1 条线',
    Boolean(clicked) && clicked.notes.length === 2 && clicked.cursor === beforeSecond.cursor + 3,
    clicked && { notes: clicked.notes.length, cursor: clicked.cursor, base: beforeSecond.cursor });

  // 已有 → 空白（两次点击）：坐标直接按图像坐标算，不靠编号片的 DOM 偏移。
  await escapeOnce();
  const existingA = await aim(60, 320, '已有的那个点');
  const beforeMixed = await debug();
  await clickAt(existingA.spot.x, existingA.spot.y);
  await waitUntil(async () => (await debug()).connect && (await debug()).connect.phase === 'armed', { label: 'armed-existing' });
  const blankEnd = await aim(420, 300, '混合终点空白');
  await clickAt(blankEnd.spot.x, blankEnd.spot.y);
  const mixed = await waitUntil(async () => { const d = await debug();
    return d.relations.length === beforeMixed.relations.length + 1 && d; }, { label: 'existing-to-blank' });
  check('已有 → 空白：只多一个新点，已有端点复用不复制',
    Boolean(mixed) && mixed.notes.length === beforeMixed.notes.length + 1
      && mixed.cursor === beforeMixed.cursor + 2,
    mixed && { notes: mixed.notes.length, base: beforeMixed.notes.length, cursor: mixed.cursor });

  // 空白 → 已有（拖动）
  await escapeOnce();
  const beforeDragBack = await debug();
  const existingB = await aim(420, 60, '已有的另一个点');
  const dragStart = await aim(200, 150, '空白起点（拖到已有点）');
  await dragAt(dragStart.spot, existingB.spot);
  const backLinked = await waitUntil(async () => { const d = await debug();
    return d.relations.length === beforeDragBack.relations.length + 1 && d; }, { label: 'blank-to-existing' });
  check('空白 → 已有：拖过去也连上，只多一个空点',
    Boolean(backLinked) && backLinked.notes.length === beforeDragBack.notes.length + 1
      && backLinked.cursor === beforeDragBack.cursor + 2,
    backLinked && { notes: backLinked.notes.length, cursor: backLinked.cursor });

  // 已有 → 已有：吸附复用、不新增批注、只多一条关系 op
  await escapeOnce();
  const beforeBoth = await debug();
  const existingC = await aim(420, 300, '混合时落下的那个点');
  const existingD = await aim(200, 150, '拖出来落下的那个点');
  await clickAt(existingC.spot.x, existingC.spot.y);
  await waitUntil(async () => (await debug()).connect && (await debug()).connect.phase === 'armed', { label: 'armed-both' });
  await clickAt(existingD.spot.x, existingD.spot.y);
  const bothLinked = await waitUntil(async () => { const d = await debug();
    return d.relations.length === beforeBoth.relations.length + 1 && d; }, { label: 'existing-to-existing' });
  check('已有 → 已有：不新增批注，只多一条关系 op',
    Boolean(bothLinked) && bothLinked.notes.length === beforeBoth.notes.length
      && bothLinked.cursor === beforeBoth.cursor + 1,
    bothLinked && { notes: bothLinked.notes.length, cursor: bothLinked.cursor });
  // 同一对再来一次：选中原来那条，不重复、不清字。
  await escapeOnce();
  const beforeAgain = await debug();
  await clickAt(existingC.spot.x, existingC.spot.y);
  await clickAt(existingD.spot.x, existingD.spot.y);
  const again = await waitUntil(async () => { const d = await debug(); return d.selectedRelationId && d; }, { label: 'dedupe' });
  check('同一对再连：定位原来那条线，不重复、不清共同说明',
    Boolean(again) && again.relations.length === beforeAgain.relations.length
      && again.cursor === beforeAgain.cursor, again && { relations: again.relations.length, cursor: again.cursor });

  // —— 5. 取消路径：Esc / 右键 / 图外 / 两次点太近 ——
  await escapeOnce();
  const beforeCancel = await debug();
  const blankStart = await aim(100, 200, '取消用例的空白起点');
  await clickAt(blankStart.spot.x, blankStart.spot.y);
  await waitUntil(async () => (await debug()).connect && (await debug()).connect.phase === 'armed', { label: 'cancel-armed' });
  await escapeOnce();
  const afterEsc = await debug();
  check('Esc 取消待定起点：不留正式新点、不写历史',
    afterEsc.connect === null && afterEsc.notes.length === beforeCancel.notes.length
      && afterEsc.relations.length === beforeCancel.relations.length && afterEsc.cursor === beforeCancel.cursor,
    { connect: afterEsc.connect, notes: afterEsc.notes.length, cursor: afterEsc.cursor });

  await rightClickAt(blankStart.spot.x, blankStart.spot.y);
  const afterRight = await debug();
  check('右键在空白处不起手、不落点',
    afterRight.connect === null && afterRight.notes.length === beforeCancel.notes.length,
    { connect: afterRight.connect, notes: afterRight.notes.length });

  const frame = await imageRect();
  const outside = { x: Math.round(frame.left) - 4, y: Math.round(blankStart.spot.y) };
  const outsideInfo = await elementInfoAt(outside.x, outside.y);
  check('口径：图外落点仍在画布上（letterbox），没盖住编号/便签',
    Boolean(outsideInfo) && outsideInfo.inScroller && !outsideInfo.onMarker && !outsideInfo.inCard, outsideInfo);
  await dragAt(blankStart.spot, outside);
  const afterOutside = await debug();
  check('空白起手拖到图外松手：不建线、不落点、暂态清掉',
    afterOutside.connect === null && afterOutside.notes.length === beforeCancel.notes.length
      && afterOutside.relations.length === beforeCancel.relations.length && afterOutside.cursor === beforeCancel.cursor,
    { connect: afterOutside.connect, notes: afterOutside.notes.length, cursor: afterOutside.cursor });

  const nearA = await aim(300, 60, '太近用例的第一个点');
  await clickAt(nearA.spot.x, nearA.spot.y);
  await clickAt(nearA.spot.x + 2, nearA.spot.y + 2);
  const near = await debug();
  const nearStatus = await run(`document.querySelector('.ie-status').textContent`);
  check('两次点在同处/太近：不产生两个点、也不留线',
    near.connect === null && near.notes.length === beforeCancel.notes.length
      && near.relations.length === beforeCancel.relations.length && near.cursor === beforeCancel.cursor
      && /太近/.test(nearStatus),
    { connect: near.connect, notes: near.notes.length, status: nearStatus });

  // —— 6. 邻接画笔历史：组撤销只退这次连接 ——
  await tool('pen');
  const penFrom = await aim(80, 260, '画笔起点');
  const penTo = await aim(160, 300, '画笔终点');
  await dragAt(penFrom.spot, penTo.spot);
  const painted = await debug();
  check('前提：又画了一笔（一条真实像素 op）',
    painted.paint.length === baselinePaintCount + 1 && painted.cursor === beforeCancel.cursor + 1,
    { paint: painted.paint.length, base: baselinePaintCount, cursor: painted.cursor });
  await tool('connect');
  const penStart = await freePress([[120, 120], [100, 140], [300, 120], [320, 200], [280, 120]]);
  check('口径：找一个真的空白起手位置（按下不是选中旧线）', Boolean(penStart), penStart && penStart.spot);
  const penEndSpot = await toClient(120, 60);
  const penEndInfo = await elementInfoAt(penEndSpot.x, penEndSpot.y);
  check('口径：画笔之后的终点也不在便签/编号上',
    Boolean(penEndInfo) && penEndInfo.inScroller && !penEndInfo.inCard && !penEndInfo.onMarker, penEndInfo);
  trace('pen-tool', { tool: (await debug()).tool, cursor: painted.cursor, notes: painted.notes.length });
  if (penStart) await dragFromPressed(penStart.spot, penEndSpot);
  trace('pen-connect-after', { connect: (await debug()).connect, cursor: (await debug()).cursor,
    notes: (await debug()).notes.length, relations: (await debug()).relations.length,
    status: await run(`document.querySelector('.ie-status').textContent`) });
  const afterPenLink = await waitUntil(async () => { const d = await debug();
    return d.notes.length === painted.notes.length + 2 && d; }, { label: 'pen-then-connect' });
  check('画笔之后连线：只多两个空点与一条线',
    Boolean(afterPenLink) && afterPenLink.relations.length === painted.relations.length + 1
      && afterPenLink.cursor === painted.cursor + 3,
    afterPenLink && { cursor: afterPenLink.cursor, base: painted.cursor });
  await run(`document.querySelector('.ie-scroll').focus()`);
  await clickAt(undoSpot.x, undoSpot.y);
  const undoAfterPen = await waitUntil(async () => { const d = await debug(); return d.notes.length === painted.notes.length && d; },
    { label: 'undo-connect-only' });
  check('一次撤销只退这次连接，邻接的画笔还在',
    Boolean(undoAfterPen) && undoAfterPen.paint.length === painted.paint.length
      && undoAfterPen.cursor === painted.cursor,
    undoAfterPen && { paint: undoAfterPen.paint.length, cursor: undoAfterPen.cursor });

  check('窗口底层始终不可见', nativeVisible(win) === false, { nativeVisible: nativeVisible(win), lifecycle });
  console.log(JSON.stringify({ results, failures }, null, 1));
  host.cleanup(token);
  host.dispose();
  probeGuard.finish();
  app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(main).catch(error => {
  console.error('FAIL', error);
  app.exit(1);
});
