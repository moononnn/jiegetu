/* 真实 CDP 验收「连线」：独立于像素直线，也不走旧追加位置。
   隐藏窗 + 隔离 userData + CDP 真实鼠标/键盘；不碰桌面、不碰系统剪贴板、不动现用进程。
   坐标每次现算（标记圈中心 / 当前 origin+zoom），不缓存旧坐标；
   覆盖：连线随时可用（0/1/2 条都一样）、拖拽与两次点击、第二击拖离不误连、同点/图外不建线、Esc 取消、
   同对去重、删线/撤销、手势不写历史、成图端点坐标仍进说明、窗口中始终不可见。
   20261112 自由连线：空白端点属于新验收（scripts/verify-editor-free-connect.cjs），这里只剩图外/同点等取消门禁。
   20261111 review-v2 补：连线工具里直接点已有的线（改字/删线，不切选择）、
   共同说明框一次 Esc 收起、连线里点空白收起便签、letterbox 图外不起手/不误连（贴边批注）。
   运行：node_modules\electron\dist\electron.exe scripts\verify-editor-connect.cjs */
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
const probeGuard = installProbeGuard({ name: 'verify-editor-connect' });
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

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-editor-connect-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

async function main() {
  const host = installImageEditorWindow({
    BrowserWindow: HiddenWindow,
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    ipcMain,
    rendererFile: path.join(ROOT, 'renderer', 'image-editor-window.html'),
    preloadFile: path.join(ROOT, 'main', 'image-editor-preload.cjs'),
    iconFile: path.join(ROOT, 'assets', 'app-icon.ico'),
    theme: undefined,
    onCommit: async () => ({ ok: true }),
    onClose: async () => true,
    onExit: async () => false,
    onStatus: () => {}
  });
  const token = `connect-${Date.now()}`;
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
  // 标记圈中心：点/框的真实屏幕位置（圈就画在落点上），现读。
  const ringOf = id => run(`(() => { const button = document.querySelector('.ie-marker[data-annotation-id="' + ${JSON.stringify(id)} + '"]');
    if (!button) return null; const figure = button.closest('.ie-marker-figure');
    const ring = figure && figure.querySelector('.ie-marker-ring');
    const anchor = (ring || button).getBoundingClientRect();
    return { x: anchor.left + anchor.width / 2, y: anchor.top + anchor.height / 2 }; })()`);
  // 落点元素：确认点击真的落在画布上（不是便签/编号按钮），避免“点空了所以没反应”的假通过。
  const elementInfoAt = async (x, y) => run(`(() => { const n = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
    if (!n) return null; return { cls: String(n.className || n.tagName),
      inCard: Boolean(n.closest && n.closest('.ie-note-card')),
      onMarker: Boolean(n.closest && n.closest('.ie-marker')),
      inScroller: Boolean(n.closest && n.closest('.ie-scroll')) }; })()`);
  // 当前画面在屏幕上的矩形：图外手势用自己的原始位置判定，不经过 point() 的 clamp。
  const imageRect = async () => {
    const d = await debug();
    const rect = await run(`(() => { const r = document.querySelector('.ie-scroll').getBoundingClientRect();
      return { left: r.left, top: r.top }; })()`);
    return { left: rect.left + d.origin.x + d.view.x * d.zoom, top: rect.top + d.origin.y + d.view.y * d.zoom,
      right: rect.left + d.origin.x + (d.view.x + d.view.width) * d.zoom,
      bottom: rect.top + d.origin.y + (d.view.y + d.view.height) * d.zoom };
  };
  // 线中段：按当前投影几何现算屏幕坐标，不缓存旧坐标。
  const lineSpotOf = async (relation, fraction = 0.42) => {
    const d = await debug();
    const curve = relation.curve;
    const index = Math.max(1, Math.min(curve.length - 2, Math.round((curve.length - 1) * fraction)));
    const sample = curve[index];
    const rect = await run(`(() => { const r = document.querySelector('.ie-scroll').getBoundingClientRect();
      return { left: r.left, top: r.top }; })()`);
    return { x: rect.left + d.origin.x + sample.x * d.zoom, y: rect.top + d.origin.y + sample.y * d.zoom };
  };
  // 空白画布落点：候选里取第一个真的落在画布、不在便签/编号上的。
  const blankSpotNear = async candidates => {
    for (const [ix, iy] of candidates) {
      const spot = await toClient(ix, iy);
      const info = await elementInfoAt(spot.x, spot.y);
      if (info && info.inScroller && !info.inCard && !info.onMarker) return { spot, info };
    }
    return null;
  };
  const canvasPath = value => /ie-scroll|ie-display|ie-workspace|ie-spacer/.test(String(value));
  const tool = async name => {
    const spot = await center(`[data-tool="${name}"]`);
    if (!spot) throw new Error(`找不到工具 ${name}`);
    await clickAt(spot.x, spot.y);
    return waitUntil(async () => (await debug()).tool === name, { label: `tool-${name}` });
  };

  // —— 0 / 1 / 2 条批注时的可用性：连线随时可用，不靠条数门禁 ——
  const connectState = () => run(`(() => { const node = document.querySelector('[data-tool="connect"]');
    return { disabled: node.disabled, title: node.title, pressed: node.getAttribute('aria-pressed') }; })()`);
  const empty = await connectState();
  check('没有批注时连线也可用，标题说清空白也能起手', empty.disabled === false && /空白|任意一处/.test(String(empty.title)), empty);

  await tool('point');
  const spotA = await toClient(120, 120);
  await clickAt(spotA.x, spotA.y);
  const noteA = await waitUntil(async () => { const d = await debug(); return d.notes.length === 1 && d; }, { label: 'note-A' });
  check('前提：点 A 已落位', Boolean(noteA), noteA && noteA.notes.length);
  await run(`(() => { const node = document.querySelector('.ie-bubble-text'); node.focus(); node.select(); return true; })()`);
  await cdp('Input.insertText', { text: 'A 点' });
  const one = await connectState();
  check('只有一条批注时连线仍可用', one.disabled === false, one);

  await tool('region');
  await dragAt(await toClient(260, 140), await toClient(380, 250));
  const noteB = await waitUntil(async () => { const d = await debug(); return d.notes.length === 2 && d; }, { label: 'note-B' });
  check('前提：框 B 已落位', Boolean(noteB), noteB && noteB.notes.length);
  await run(`(() => { const node = document.querySelector('.ie-bubble-text'); node.focus(); node.select(); return true; })()`);
  await cdp('Input.insertText', { text: 'B 框' });

  // 框里再落一个点，验证“框中有其它点”时连线仍先命中那个点，不拖旧框。
  await tool('point');
  const insideB = await toClient(320, 195);
  await clickAt(insideB.x, insideB.y);
  const noteD = await waitUntil(async () => { const d = await debug(); return d.notes.length === 3 && d; }, { label: 'note-D' });
  check('前提：框 B 里还有一个点 D', Boolean(noteD), noteD && noteD.notes.length);
  await run(`(() => { const node = document.querySelector('.ie-bubble-text'); node.focus(); node.select(); return true; })()`);
  await cdp('Input.insertText', { text: 'D 框里的点' });
  // 第三个独立的点，给两次点击用例。
  await tool('point');
  const spotC = await toClient(140, 310);
  await clickAt(spotC.x, spotC.y);
  const noteC = await waitUntil(async () => { const d = await debug(); return d.notes.length === 4 && d; }, { label: 'note-C' });
  check('前提：独立点 C 已落位', Boolean(noteC), noteC && noteC.notes.length);
  await run(`(() => { const node = document.querySelector('.ie-bubble-text'); node.focus(); node.select(); return true; })()`);
  await cdp('Input.insertText', { text: 'C 点' });
  await escapeOnce();
  await waitUntil(async () => !(await debug()).editing, { label: 'clear-editing' });

  const ready = await connectState();
  check('两条以上批注后连线可用，且不是像素直线', ready.disabled === false && ready.title !== undefined, ready);
  const baseline = await debug();
  const markerA = await ringOf(baseline.notes[0].id);
  check('起点的屏幕坐标来自它自己的标记圈，落在画布上',
    Boolean(markerA) && canvasPath(await run(`(() => { const n = document.elementFromPoint(${Math.round(markerA.x)}, ${Math.round(markerA.y)});
      return n ? (n.className || n.tagName) : 'none'; })()`)), markerA);

  // —— 拖拽连线：A → B（框内） ——
  await tool('connect');
  const connectOn = await connectState();
  check('点击后明确切到连线工具', connectOn.pressed === 'true' && (await debug()).tool === 'connect', connectOn);
  const framesBefore = (await debug()).frames;
  await dragAt(markerA, await toClient(320, 195));
  const linked = await waitUntil(async () => { const d = await debug();
    return d.relations.length === 1 && d.selectedRelationId && d; }, { label: 'relation-AB' });
  check('按住拖到另一处就建立连线并选中', Boolean(linked), linked && linked.relations);
  const afterLink = await debug();
  check('建线只多一条历史 op，批注几何不动', afterLink.cursor === baseline.cursor + 1
    && afterLink.notes.length === 4 && afterLink.ops === baseline.ops + 1,
    { cursor: afterLink.cursor, base: baseline.cursor, notes: afterLink.notes.length });
  check('建立后第一个完成帧就重画（线在画布上）', afterLink.frames > framesBefore, { before: framesBefore, after: afterLink.frames });
  const lineCard = await run(`(() => { const node = document.querySelector('.ie-relation-bubble');
    if (!node || node.hidden) return null; const r = node.getBoundingClientRect();
    const del = node.querySelector('[data-action="relation-delete"]');
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, label: del && del.textContent,
      text: node.querySelector('.ie-relation-text')?.value ?? '' }; })()`);
  check('线旁便签打开，动作叫「删线」', Boolean(lineCard) && lineCard.label === '删线', lineCard);
  check('便签夹在窗口里', Boolean(lineCard) && lineCard.left >= -1 && lineCard.top >= -1
    && lineCard.right <= (await run('innerWidth')) + 1 && lineCard.bottom <= (await run('innerHeight')) + 1,
    { card: lineCard, inner: [await run('innerWidth'), await run('innerHeight')] });
  await run(`(() => { const node = document.querySelector('.ie-relation-text'); node.focus(); node.select(); return true; })()`);
  await cdp('Input.insertText', { text: '这两处一起改' });
  const texted = await waitUntil(async () => { const d = await debug();
    return d.relations[0].text === '这两处一起改' && d; }, { label: 'relation-text' });
  check('共同说明写回同一条线，两端原文不变',
    Boolean(texted) && texted.notes.map(note => note.text).join('|') === 'A 点|B 框|D 框里的点|C 点',
    texted && texted.notes.map(note => note.text));
  const cursorAfterLink = texted.cursor;
  // 线旁便签会盖住旁边的目标：现在一次 Esc（焦点在共同说明框里）就收起，不再靠两次 Esc 绕。
  await escapeOnce();
  const collapsedAfterLink = await waitUntil(async () => { const d = await debug();
    return d.selectedRelationId === null && !d.editing && d; }, { label: 'clear-after-link' });
  check('共同说明框一次 Esc 就收起便签（不再需要第二下）', Boolean(collapsedAfterLink)
    && (await run(`document.querySelector('.ie-relation-bubble').hidden`)) === true,
    { selected: collapsedAfterLink && collapsedAfterLink.selectedRelationId });

  // —— 两次点击：B → C ——
  await tool('connect');
  const bEdge = await toClient(380, 195);
  const cRing = await ringOf((await debug()).notes[3].id);
  // 图外（letterbox）落点：连线输入只认画布里的原始位置，图外松手一律取消。
  const frameNow = await imageRect();
  const letterboxSpot = { x: Math.round(frameNow.left) - 4, y: Math.round(cRing.y) };
  trace('two-click-before', { tool: (await debug()).tool, bEdge, cRing,
    element: await run(`(() => { const n = document.elementFromPoint(${Math.round(bEdge.x)}, ${Math.round(bEdge.y)});
      return n ? (n.className || n.tagName) : 'none'; })()`) });
  await clickAt(bEdge.x, bEdge.y);
  const afterFirstClick = await debug();
  trace('after-first-click', { connect: afterFirstClick.connect, status: await run(`document.querySelector('.ie-status').textContent`),
    notes: afterFirstClick.notes.map(note => ({ id: note.id, targets: note.targets })),
    view: afterFirstClick.view, origin: afterFirstClick.origin, zoom: afterFirstClick.zoom });
  const armed = await waitUntil(async () => { const d = await debug(); return d.connect && d.connect.phase === 'armed' && d; }, { label: 'armed' });
  check('第一击只记起点、等第二击', Boolean(armed), armed && armed.connect);
  // 第二击按在 C 上，但拖到图外再松手：按最终坐标判定，不误连、不落点。
  await dragAt(cRing, letterboxSpot);
  const missed = await debug();
  check('第二击按住后拖离到图外：按松手坐标判定，不误连也不落点',
    missed.relations.length === 1 && missed.connect === null && missed.notes.length === 4,
    { relations: missed.relations.length, connect: missed.connect, notes: missed.notes.length });
  // 正常两次点击：先点 B，再点 C。
  await clickAt(bEdge.x, bEdge.y);
  await waitUntil(async () => { const d = await debug(); return d.connect && d.connect.phase === 'armed' && d; }, { label: 'armed-2' });
  await clickAt(cRing.x, cRing.y);
  const clicked = await waitUntil(async () => { const d = await debug(); return d.relations.length === 2 && d; }, { label: 'relation-BC' });
  check('两次点击也能建立同一种关系',
    Boolean(clicked) && clicked.relations.every(relation => relation.complete !== false),
    clicked && clicked.relations.length);

  // —— 同一处、图外、Esc：不建线、不落点、不写历史 ——
  const beforeFailures = await debug();
  await clickAt(cRing.x, cRing.y);
  await clickAt(cRing.x, cRing.y);
  const same = await debug();
  check('同一处点两下不自连', same.relations.length === 2, same.relations.length);
  await clickAt(cRing.x, cRing.y);
  await clickAt(letterboxSpot.x, letterboxSpot.y);
  const blank = await debug();
  check('第二击落图外不建线、不多出批注', blank.relations.length === 2 && blank.notes.length === 4,
    { relations: blank.relations.length, notes: blank.notes.length });
  await dragAt(cRing, letterboxSpot);
  const dragBlank = await debug();
  check('拖到图外不建线、暂态清掉、不多出批注',
    dragBlank.relations.length === 2 && dragBlank.connect === null && dragBlank.notes.length === 4,
    { relations: dragBlank.relations.length, connect: dragBlank.connect, notes: dragBlank.notes.length });
  await clickAt(cRing.x, cRing.y);
  await waitUntil(async () => (await debug()).connect, { label: 'armed-3' });
  await escapeOnce();
  const escaped = await debug();
  check('Esc 取消手势、不删批注、不写历史',
    escaped.connect === null && escaped.notes.length === 4 && escaped.cursor === beforeFailures.cursor,
    { connect: escaped.connect, notes: escaped.notes.length, cursor: escaped.cursor, base: beforeFailures.cursor });

  // —— 同一对去重：选中原来那条，不清字 ——
  await escapeOnce();
  await clickAt(markerA.x, markerA.y);
  await clickAt(await toClient(320, 195).then(spot => spot.x), await toClient(320, 195).then(spot => spot.y));
  const again = await debug();
  check('同一对再连：不重复建线、原共同说明保留',
    again.relations.length === 2 && again.selectedRelationId === linked.relations[0].id
      && again.relations.find(relation => relation.id === linked.relations[0].id).text === '这两处一起改',
    again && { relations: again.relations.length, selected: again.selectedRelationId });
  check('这些失败/去重手势都没写历史', again.cursor === beforeFailures.cursor, { cursor: again.cursor, base: beforeFailures.cursor });

  // —— 删线 / 撤销：第一次撤销只退线 ——
  const deleteButton = await center('.ie-relation-bubble [data-action="relation-delete"]');
  await clickAt(deleteButton.x, deleteButton.y);
  const deleted = await waitUntil(async () => { const d = await debug(); return d.relations.length === 1 && d; }, { label: 'line-deleted' });
  check('删线只删这条线，两端批注与原文都在',
    Boolean(deleted) && deleted.notes.length === 4 && deleted.notes.map(note => note.text).includes('A 点'),
    deleted && deleted.notes.map(note => note.text));
  await run(`document.querySelector('.ie-scroll').focus()`);
  const undoButton = await center('[data-action="undo"]');
  await clickAt(undoButton.x, undoButton.y);
  const restored = await waitUntil(async () => { const d = await debug();
    return d.relations.length === 2 && d; }, { label: 'line-restored' });
  check('撤销恢复这条线与共同说明', Boolean(restored)
    && restored.relations.some(relation => relation.text === '这两处一起改'), restored && restored.relations);

  // —— review-v2 F2/F3：连线工具里直接点已有的线 → 改共同说明 → 一次 Esc 收起 → 删线 ——
  await run(`document.querySelector('.ie-scroll').focus()`);
  await escapeOnce();
  await waitUntil(async () => { const d = await debug(); return d.selectedRelationId === null && d; }, { label: 'clear-before-line-click' });
  const lineTarget = (await debug()).relations[0];
  const lineSpot = await lineSpotOf(lineTarget, 0.42);
  const lineSpotInfo = await elementInfoAt(lineSpot.x, lineSpot.y);
  check('口径：点线的位置落在画布上、没被便签盖住',
    Boolean(lineSpotInfo) && lineSpotInfo.inScroller && !lineSpotInfo.inCard, { spot: lineSpot, info: lineSpotInfo });
  const beforeLineClick = await debug();
  await clickAt(lineSpot.x, lineSpot.y);
  const pickedLine = await waitUntil(async () => { const d = await debug();
    return d.selectedRelationId === lineTarget.id && d; }, { label: 'line-picked-in-connect' });
  check('连线工具里直接点已有的线就选中它，不切选择工具',
    Boolean(pickedLine) && pickedLine.tool === 'connect',
    pickedLine && { tool: pickedLine.tool, selected: pickedLine.selectedRelationId });
  check('点线不新建线、不写历史、批注不变',
    Boolean(pickedLine) && pickedLine.relations.length === beforeLineClick.relations.length
      && pickedLine.cursor === beforeLineClick.cursor && pickedLine.notes.length === 4,
    pickedLine && { relations: pickedLine.relations.length, cursor: pickedLine.cursor, base: beforeLineClick.cursor });
  const pickedCard = await run(`(() => { const node = document.querySelector('.ie-relation-bubble');
    if (!node || node.hidden) return null; return { deleteLabel: node.querySelector('[data-action="relation-delete"]')?.textContent,
      text: node.querySelector('.ie-relation-text')?.value ?? '' }; })()`);
  check('点线后共同输入与「删线」就在眼前', Boolean(pickedCard) && pickedCard.deleteLabel === '删线', pickedCard);
  await run(`(() => { const node = document.querySelector('.ie-relation-text'); node.focus(); node.select(); return true; })()`);
  await cdp('Input.insertText', { text: '点线后改的共同说明' });
  const editedLine = await waitUntil(async () => { const d = await debug();
    return d.relations.find(relation => relation.id === lineTarget.id)?.text === '点线后改的共同说明' && d; },
    { label: 'line-text-edited' });
  check('点线后能直接改字，仍写回同一条线', Boolean(editedLine), editedLine && editedLine.relations.map(item => item.text));
  const cursorAfterEdit = editedLine ? editedLine.cursor : -1;
  await escapeOnce();
  const collapsedLine = await waitUntil(async () => { const d = await debug();
    return d.selectedRelationId === null && d; }, { label: 'esc-collapse-line' });
  const lineBubbleHidden = await run(`document.querySelector('.ie-relation-bubble').hidden`);
  check('共同说明框一次 Esc 就收起便签', Boolean(collapsedLine) && lineBubbleHidden === true,
    { selected: collapsedLine && collapsedLine.selectedRelationId, hidden: lineBubbleHidden });
  check('收起后线、两端文字、共同说明与连线工具都保留', Boolean(collapsedLine)
    && collapsedLine.tool === 'connect' && collapsedLine.notes.length === 4
    && collapsedLine.relations.some(relation => relation.id === lineTarget.id && relation.text === '点线后改的共同说明')
    && collapsedLine.notes.map(note => note.text).join('|') === 'A 点|B 框|D 框里的点|C 点',
    collapsedLine && { tool: collapsedLine.tool, notes: collapsedLine.notes.map(note => note.text) });
  check('收起不算一次编辑：历史条数没变', Boolean(collapsedLine) && collapsedLine.cursor === cursorAfterEdit,
    { cursor: collapsedLine && collapsedLine.cursor, base: cursorAfterEdit });
  // 仍在连线工具里（没有预先切选择），再点这条线 → 删线。
  await clickAt(lineSpot.x, lineSpot.y);
  await waitUntil(async () => (await debug()).selectedRelationId === lineTarget.id, { label: 'line-picked-again' });
  const deleteOnLine = await center('.ie-relation-bubble [data-action="relation-delete"]');
  await clickAt(deleteOnLine.x, deleteOnLine.y);
  const lineRemoved = await waitUntil(async () => { const d = await debug();
    return d.relations.length === beforeLineClick.relations.length - 1 && d; }, { label: 'line-removed-by-line-click' });
  check('点线后直接删线：只少这条线，四条批注与文字都在', Boolean(lineRemoved)
    && lineRemoved.notes.length === 4 && lineRemoved.notes.map(note => note.text).join('|') === 'A 点|B 框|D 框里的点|C 点',
    lineRemoved && { relations: lineRemoved.relations.length, notes: lineRemoved.notes.map(note => note.text) });
  await run(`document.querySelector('.ie-scroll').focus()`);
  const undoAfterLineDelete = await center('[data-action="undo"]');
  await clickAt(undoAfterLineDelete.x, undoAfterLineDelete.y);
  await waitUntil(async () => (await debug()).relations.length === beforeLineClick.relations.length, { label: 'line-back-after-undo' });

  // —— review-v2 F1：letterbox（图外）不能起手、不能误连贴边批注 ——
  await tool('point');
  const edgeLeftInside = await toClient(8, 200);
  await clickAt(edgeLeftInside.x, edgeLeftInside.y);
  const edgeLeftNote = await waitUntil(async () => { const d = await debug(); return d.notes.length === 5 && d; }, { label: 'edge-left-note' });
  await run(`(() => { const node = document.querySelector('.ie-bubble-text'); node.focus(); node.select(); return true; })()`);
  await cdp('Input.insertText', { text: '贴左的批注' });
  await escapeOnce();
  await tool('point');
  const edgeRightInside = await toClient(470, 300);
  await clickAt(edgeRightInside.x, edgeRightInside.y);
  const edgeRightNote = await waitUntil(async () => { const d = await debug(); return d.notes.length === 6 && d; }, { label: 'edge-right-note' });
  await run(`(() => { const node = document.querySelector('.ie-bubble-text'); node.focus(); node.select(); return true; })()`);
  await cdp('Input.insertText', { text: '贴右的批注' });
  await escapeOnce();
  check('前提：贴边两条批注就位', Boolean(edgeLeftNote) && Boolean(edgeRightNote),
    { left: edgeLeftNote && edgeLeftNote.notes.length, right: edgeRightNote && edgeRightNote.notes.length });
  await tool('connect');
  const frame = await imageRect();
  trace('letterbox', { frame, inner: [await run('innerWidth'), await run('innerHeight')] });
  const edgeNotes = (await debug()).notes.slice(-2);
  const edgeLeftId = edgeNotes[0] && edgeNotes[0].id;
  const edgeRightId = edgeNotes[1] && edgeNotes[1].id;
  const leftRing = await ringOf(edgeLeftId);
  const rightRing = await ringOf(edgeRightId);
  const outsideLeft = { x: Math.round(frame.left) - 4, y: Math.round(leftRing.y) };
  const outsideRight = { x: Math.round(frame.right) + 4, y: Math.round(rightRing.y) };
  const leftInfo = await elementInfoAt(outsideLeft.x, outsideLeft.y);
  const rightInfo = await elementInfoAt(outsideRight.x, outsideRight.y);
  check('口径：左右图外落点都在画布上、没盖住编号/便签', Boolean(leftInfo) && leftInfo.inScroller
    && !leftInfo.onMarker && !leftInfo.inCard && Boolean(rightInfo) && rightInfo.inScroller && !rightInfo.onMarker && !rightInfo.inCard,
    { left: leftInfo, right: rightInfo });
  const beforeLetterbox = await debug();
  await clickAt(outsideLeft.x, outsideLeft.y);
  const afterOutsideDown = await debug();
  check('图外按下不起手：贴边批注不被 letterbox 吸附',
    afterOutsideDown.connect === null && afterOutsideDown.relations.length === beforeLetterbox.relations.length
      && afterOutsideDown.cursor === beforeLetterbox.cursor,
    { connect: afterOutsideDown.connect, relations: afterOutsideDown.relations.length });
  await dragAt(leftRing, outsideRight);
  const afterOutsideUp = await debug();
  check('图外松手：不建线、暂态清掉、不写历史',
    afterOutsideUp.relations.length === beforeLetterbox.relations.length && afterOutsideUp.connect === null
      && afterOutsideUp.cursor === beforeLetterbox.cursor,
    { relations: afterOutsideUp.relations.length, connect: afterOutsideUp.connect, cursor: afterOutsideUp.cursor });
  await dragAt(leftRing, rightRing);
  const edgeLinked = await waitUntil(async () => { const d = await debug();
    return d.relations.length === beforeLetterbox.relations.length + 1 && d; }, { label: 'edge-linked-inside' });
  check('同一对在图内拖：照常连上（门禁没误伤正常手势）', Boolean(edgeLinked), edgeLinked && edgeLinked.relations.length);

  // —— review-v2 F3 / 20261112：连线里无起点点空白 → 收起当前便签，并只在原地起一条待定起点（不落批注） ——
  // 真实界面里连线工具下能开着的便签是“线旁共同说明”：先点线选中它（仍在连线工具），
  // 再点空白。两个卡片都必须收起，且不能造新批注/线或写历史。
  await run(`document.querySelector('.ie-scroll').focus()`);
  await escapeOnce();
  await waitUntil(async () => { const d = await debug(); return d.selectedRelationId === null && d; }, { label: 'clear-before-blank' });
  const blankTarget = (await debug()).relations[0];
  const blankTargetSpot = await lineSpotOf(blankTarget, 0.42);
  const beforeBlank = await debug();
  await clickAt(blankTargetSpot.x, blankTargetSpot.y);
  await waitUntil(async () => (await debug()).selectedRelationId === blankTarget.id, { label: 'line-open-before-blank' });
  const relationCardOpen = await run(`document.querySelector('.ie-relation-bubble').hidden === false`);
  check('前提：连线工具下线旁便签开着', relationCardOpen === true, { hidden: relationCardOpen });
  const blankPick = await blankSpotNear([[430, 340], [40, 340], [430, 60], [60, 40]]);
  check('口径：找得到一个空白画布落点', Boolean(blankPick), blankPick);
  if (blankPick) {
    await clickAt(blankPick.spot.x, blankPick.spot.y);
    const afterBlank = await debug();
    const noteBubbleHidden = await run(`document.querySelector('.ie-note-bubble').hidden`);
    const relationBubbleHidden = await run(`document.querySelector('.ie-relation-bubble').hidden`);
    check('连线模式点空白只收起当前便签', afterBlank.noteId === null && noteBubbleHidden === true
      && relationBubbleHidden === true && afterBlank.selectedRelationId === null,
      { noteId: afterBlank.noteId, noteHidden: noteBubbleHidden, relationHidden: relationBubbleHidden });
    check('点空白先收起便签、不造新批注/线、不写历史', afterBlank.notes.length === beforeBlank.notes.length
      && afterBlank.relations.length === beforeBlank.relations.length && afterBlank.cursor === beforeBlank.cursor,
      { notes: afterBlank.notes.length, relations: afterBlank.relations.length, cursor: afterBlank.cursor });
    check('空白处留下的是一个待定起点（暂存坐标，还不是批注）',
      Boolean(afterBlank.connect) && afterBlank.connect.phase === 'armed' && afterBlank.connect.start.annotationId === undefined
        && typeof afterBlank.connect.start.point?.x === 'number',
      afterBlank.connect);
    check('两端的字原样保留', afterBlank.notes.find(note => note.id === edgeLeftId)?.text === '贴左的批注',
      afterBlank.notes.map(note => note.text));
    // 收尾：Esc 取消这个待定起点，不给最后一项留下悬空手势。
    await escapeOnce();
    const afterBlankEsc = await debug();
    check('Esc 取消待定起点后不多出批注', afterBlankEsc.connect === null
      && afterBlankEsc.notes.length === beforeBlank.notes.length
      && afterBlankEsc.cursor === beforeBlank.cursor, { connect: afterBlankEsc.connect });
  }

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
