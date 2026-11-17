/* 便签「完成」+ 干净细框：短场景真机验收（20261113）。
   离屏窗 + 隔离 userData + CDP 真实鼠标/键盘 + 真实工具按钮；不碰桌面、不碰系统剪贴板、不动现用进程。
   场景：真画框 → 写没回车的字 → 点「完成」收便签 → 点编号重选核字 →
         再新建一处（不误连）→ 真实连线 → 写共同说明 → 点「完成」→ 点线重选核字 → 撤销只退这条线。
   顺带在 1280 / 640×480 / 480×401 三种窗口下核「完成」在自己卡片与可视窗口内、更多展开+长文内部滚。
   证据目录：默认 evidence/20261113-annotation-confirm；母会话独立复跑时用
   ANNOTATION_DONE_EVIDENCE_DIR 指到树外目录，免得覆盖已冻结的截图与 results。
   运行：node_modules\electron\dist\electron.exe scripts\verify-editor-done.cjs */
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { installImageEditorWindow } = require('../main/image-editor-window.cjs');
const { installProbeGuard } = require('./probe-safety.cjs');

const ROOT = path.join(__dirname, '..');
const EVIDENCE = process.env.ANNOTATION_DONE_EVIDENCE_DIR || path.join(ROOT, 'evidence', '20261113-annotation-confirm');
// 先装测试生命周期保护（任何日志之前）。
const probeGuard = installProbeGuard({ name: 'verify-editor-done' });
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
// 隐藏窗不产帧：要真实渲染图就只能离屏窗（与既有布局/连线探针同一手法），底层始终不可见。
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
const SOURCE_RGB = [226, 238, 230];
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

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-editor-done-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

// 便签几何：卡片 / 底部操作行 / 完成按钮 / 更多面板 / 输入框 / 工作区 / 窗口。
const GEOMETRY_JS = `(() => {
  const card = document.querySelector('.ie-note-bubble');
  const relation = document.querySelector('.ie-relation-bubble');
  const box = node => { if (!node) return null; const b = node.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
  const pick = (root, sel) => root ? root.querySelector(sel) : null;
  const foot = pick(card, '.ie-card-foot');
  const btn = pick(card, '.ie-done');
  const more = pick(card, '.ie-bubble-more');
  const field = pick(card, '.ie-bubble-text');
  const relFoot = pick(relation, '.ie-card-foot');
  const relBtn = pick(relation, '.ie-done');
  return {
    card: box(card), foot: box(foot), btn: box(btn), more: box(more), field: box(field),
    relFoot: box(relFoot), relBtn: box(relBtn),
    moreHidden: more ? more.hidden : null,
    moreScroll: more ? { height: more.scrollHeight, client: more.clientHeight } : null,
    fieldScroll: field ? { height: field.scrollHeight, client: field.clientHeight } : null,
    workspace: box(document.querySelector('.ie-workspace')),
    win: { width: innerWidth, height: innerHeight },
    cardHidden: card ? card.hidden : null,
    relationHidden: relation ? relation.hidden : null
  };
})()`;
const inside = (outer, inner, slack = 0.5) => Boolean(outer && inner) &&
  inner.left >= outer.left - slack && inner.top >= outer.top - slack &&
  inner.right <= outer.right + slack && inner.bottom <= outer.bottom + slack;
const withinWindow = (box, win, slack = 0.5) => Boolean(box && win) &&
  box.left >= -slack && box.top >= -slack && box.right <= win.width + slack && box.bottom <= win.height + slack;

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const host = installImageEditorWindow({
    BrowserWindow: OffscreenWindow,
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

  const openEditor = async (tag, cssWidth, cssHeight) => {
    const token = `done-${tag}-${Date.now()}`;
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
      await sleep(90);
    };
    const dragAt = async (from, to) => {
      await mouse('mouseMoved', from.x, from.y, { buttons: 0 });
      await mouse('mousePressed', from.x, from.y, { buttons: 1 });
      for (let step = 1; step <= 8; step += 1) {
        await mouse('mouseMoved', from.x + ((to.x - from.x) * step) / 8, from.y + ((to.y - from.y) * step) / 8, { buttons: 1 });
      }
      await mouse('mouseReleased', to.x, to.y, { buttons: 0 });
      await sleep(110);
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
      return spot;
    };
    const tool = async name => {
      await action(`[data-tool="${name}"]`);
      return waitUntil(async () => (await debug()).tool === name, { label: `tool-${name}` });
    };
    // 图像坐标 → 屏幕坐标：每次现算当前 origin/zoom 与画布位置，不沿用旧坐标。
    const toClient = async (x, y) => {
      const d = await debug();
      const rect = await run(`(() => { const r = document.querySelector('.ie-scroll').getBoundingClientRect();
        return { left: r.left, top: r.top }; })()`);
      return { x: rect.left + d.origin.x + x * d.zoom, y: rect.top + d.origin.y + y * d.zoom };
    };
    // 走真实输入框写一段文字（不按回车，模拟还没离开输入就点「完成」）。
    const typeInto = async (selector, text) => {
      await run(`(() => { const node = document.querySelector(${JSON.stringify(selector)});
        node.focus(); node.select(); return true; })()`);
      await cdp('Input.insertText', { text });
      await sleep(140);
    };
    const geometry = () => run(GEOMETRY_JS);
    // 隐藏窗截图走 paint 帧：先丢旧帧再 invalidate。
    const shot = async name => {
      await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
      frame = null;
      win.webContents.invalidate();
      const captured = await waitUntil(() => frame, { timeout: 5000, label: `frame-${tag}-${name}` });
      if (!captured) return null;
      const target = path.join(EVIDENCE, `annotation-confirm-${tag}-${name}.png`);
      fs.writeFileSync(target, captured.toPNG());
      trace(`shot-${tag}-${name}`, { file: path.relative(ROOT, target), size: captured.getSize() });
      return { file: target, size: captured.getSize() };
    };
    return { tag, win, run, cdp, clickAt, dragAt, debug, status, center, action, tool, toClient, typeInto, geometry, shot,
      close: () => { host.cleanup(token); } };
  };

  const finish = () => {
    fs.writeFileSync(path.join(EVIDENCE, 'annotation-confirm-results.json'), JSON.stringify({ results, failures }, null, 1));
    console.log(JSON.stringify({ results, failures }, null, 1));
    host.dispose();
    probeGuard.finish();
    app.exit(failures.length ? 1 : 0);
  };

  // —— 场景 A：宽窗里跑完整交互（框 → 字 → 完成 → 重选；连线 → 共同字 → 完成 → 重选 → 撤销）——
  const wide = await openEditor('wide', 1280, 800);
  await wide.tool('region');
  await wide.dragAt(await wide.toClient(40, 40), await wide.toClient(160, 130));
  const madeBox = await waitUntil(async () => { const d = await wide.debug(); return d.notes.length === 1 && d; },
    { label: 'wide-box' });
  check('宽窗：真拖出一个框批注并打开它的便签',
    Boolean(madeBox) && madeBox.notes[0].text === '', madeBox && madeBox.notes);
  const geomWide = await wide.geometry();
  check('宽窗：底部「完成」在自己卡片里，也在可视窗口内',
    inside(geomWide.card, geomWide.btn) && withinWindow(geomWide.btn, geomWide.win),
    { card: geomWide.card, btn: geomWide.btn, win: geomWide.win });

  const beforeType = await wide.debug();
  await wide.typeInto('.ie-bubble-text', '这块留白大一点');
  const typed = await wide.debug();
  check('没按回车的字已经写回这条批注（边写边记不变）',
    typed.notes[0].text === '这块留白大一点' && typed.cursor === beforeType.cursor,
    { text: typed.notes[0].text, cursor: typed.cursor });

  await wide.action('[data-action="note-done"]');
  const done = await waitUntil(async () => { const d = await wide.debug(); return d.noteId === null && d; }, { label: 'wide-done' });
  const statusDone = await wide.status();
  check('点「完成」：便签收起、选择放下，字都留着，不写历史',
    Boolean(done) && done.notes.length === 1 && done.notes[0].text === '这块留白大一点'
      && done.cursor === beforeType.cursor && done.ops === beforeType.ops,
    done && { notes: done.notes.length, text: done.notes[0].text, cursor: done.cursor, ops: done.ops });
  const bubbleHidden = await wide.run(`document.querySelector('.ie-note-bubble').hidden === true`);
  check('点「完成」：这条便签真的收起了', bubbleHidden === true, { bubbleHidden });
  check('点「完成」：状态说「批注已记下」，不说保存到图片',
    /批注已记下/.test(String(statusDone)) && !/保存/.test(String(statusDone)), statusDone);
  const toolKept = (await wide.debug()).tool;
  check('点「完成」：保持当前绘图工具，能接着批注', toolKept === 'region', { tool: toolKept });

  await wide.action('.ie-marker');
  const reselected = await waitUntil(async () => { const d = await wide.debug(); return d.noteId && d; }, { label: 'wide-reselect' });
  const fieldValue = await wide.run(`document.querySelector('.ie-bubble-text').value`);
  check('点编号重选回来：输入框里就是原来那句话',
    Boolean(reselected) && fieldValue === '这块留白大一点', { fieldValue });

  // 完成后接着新建：不该误连上一条，也不带走旧字。
  await wide.tool('point');
  const secondSpot = await wide.toClient(300, 240);
  await wide.clickAt(secondSpot.x, secondSpot.y);
  const second = await waitUntil(async () => { const d = await wide.debug(); return d.notes.length === 2 && d; },
    { label: 'wide-second' });
  check('完成一条后接着新建：第二处照常落位，没有残留的连线暂态',
    Boolean(second) && second.relations.length === 0 && second.connect === null
      && second.notes[0].text === '这块留白大一点',
    second && { notes: second.notes.map(note => note.text), relations: second.relations.length, connect: second.connect });
  await wide.typeInto('.ie-bubble-text', '第二条');
  await wide.action('[data-action="note-done"]');
  const twoDone = await waitUntil(async () => { const d = await wide.debug(); return d.noteId === null && d.notes.length === 2 && d; },
    { label: 'wide-two-done' });

  // 真实连线：框内一点 → 新点；再写共同说明并点「完成」。
  await wide.tool('connect');
  await wide.dragAt(await wide.toClient(90, 80), await wide.toClient(300, 240));
  const linked = await waitUntil(async () => { const d = await wide.debug(); return d.relations.length === 1 && d; },
    { label: 'wide-link' });
  check('前提：两处真的连成一条线并打开共同说明', Boolean(linked), linked && { relations: linked.relations.length });
  if (!linked) { finish(); return; }
  const relationId = linked.relations[0].id;
  const cursorBeforeRelationDone = linked.cursor;
  await wide.typeInto('.ie-relation-text', '两处一起说');
  await wide.action('[data-action="relation-done"]');
  const relationDone = await waitUntil(async () => { const d = await wide.debug(); return d.selectedRelationId === null && d; },
    { label: 'wide-relation-done' });
  const statusRelation = await wide.status();
  check('连线「完成」：线、共同说明、两端原文都留着，不写历史',
    Boolean(relationDone) && relationDone.relations.length === 1 && relationDone.relations[0].text === '两处一起说'
      && relationDone.cursor === cursorBeforeRelationDone
      && relationDone.notes.map(note => note.text).join('|') === '这块留白大一点|第二条',
    relationDone && { relations: relationDone.relations.length, text: relationDone.relations[0].text,
      notes: relationDone.notes.map(note => note.text), cursor: relationDone.cursor });
  check('连线「完成」：状态说「连线说明已记下」', /连线说明已记下/.test(String(statusRelation)), statusRelation);

  // 点线重选：共同说明还在。
  const curve = relationDone.relations[0].curve;
  await wide.tool('select');
  let hitLine = false;
  for (const sample of curve.slice(2, -2)) {
    const spot = await wide.toClient(sample.x, sample.y);
    await wide.clickAt(spot.x, spot.y);
    if ((await wide.debug()).selectedRelationId === relationId) { hitLine = true; break; }
  }
  const relValue = await wide.run(`document.querySelector('.ie-relation-text').value`);
  check('点连线重选：共同说明原样还在', hitLine && relValue === '两处一起说', { hitLine, relValue });

  // 宽窗实图：细实线框 + 便签底部「完成」（先把这条批注的便签点开）。
  await wide.action('.ie-marker');
  await sleep(160);
  const wideShot = await wide.shot('wide-done-footer');
  check('宽窗：存下细实线框 + 便签底部「完成」的真实渲染图', Boolean(wideShot), wideShot && wideShot.file);
  check('宽窗：窗口底层始终不可见', nativeVisible(wide.win) === false, { nativeVisible: nativeVisible(wide.win) });

  // 完成不是一步历史：一次撤销退的是这条线本身，两端批注与原文不动。
  await wide.action('[data-action="undo"]');
  const undone = await waitUntil(async () => { const d = await wide.debug(); return d.relations.length === 0 && d; },
    { label: 'wide-undo' });
  check('撤销一次：只退掉这条线，两端批注与各自原文都还在',
    Boolean(undone) && undone.notes.length === 2
      && undone.notes.map(note => note.text).join('|') === '这块留白大一点|第二条',
    undone && { relations: undone.relations.length, notes: undone.notes.map(note => note.text) });
  wide.close();

  // —— 场景 B/C：窄窗下「完成」在自己卡片与可视窗口内，更多展开 + 长文能滚而按钮仍可点 ——
  for (const [tag, width, height] of [['narrow640', 640, 480], ['narrow480', 480, 401]]) {
    const ed = await openEditor(tag, width, height);
    await ed.tool('region');
    await ed.dragAt(await ed.toClient(40, 40), await ed.toClient(180, 140));
    await waitUntil(async () => { const d = await ed.debug(); return d.notes.length === 1 && d; }, { label: `${tag}-box` });
    await ed.typeInto('.ie-bubble-text', '这里挤了一下，想再松一点，别贴边，下面那行也一起看看要不要换行');
    await ed.action('[data-action="bubble-more-toggle"]');
    await ed.typeInto('.ie-target-text', '保存');
    await sleep(160);
    const geometry = await ed.geometry();
    check(`${tag}：底部「完成」在自己卡片矩形内`,
      inside(geometry.card, geometry.foot) && inside(geometry.card, geometry.btn),
      { card: geometry.card, foot: geometry.foot, btn: geometry.btn });
    check(`${tag}：底部「完成」在可视窗口与画布区内`,
      withinWindow(geometry.btn, geometry.win) && inside(geometry.workspace, geometry.btn),
      { btn: geometry.btn, win: geometry.win, workspace: geometry.workspace });
    check(`${tag}：更多展开后内容自己滚，长文也在输入框里滚`,
      geometry.moreHidden === false && geometry.moreScroll.height > geometry.moreScroll.client
        && geometry.fieldScroll.height > geometry.fieldScroll.client,
      { more: geometry.moreScroll, field: geometry.fieldScroll });
    const narrowShot = await ed.shot('narrow-more');
    check(`${tag}：存下窄窗更多展开态的真实渲染图`, Boolean(narrowShot), narrowShot && narrowShot.file);
    // 真实点击：按钮还在原地且点得到，点完便签收起、字都留着。
    await ed.action('[data-action="note-done"]');
    const closed = await waitUntil(async () => { const d = await ed.debug(); return d.noteId === null && d; }, { label: `${tag}-done` });
    check(`${tag}：真实点到「完成」，便签收起且字没丢`,
      Boolean(closed) && closed.notes.length === 1 && closed.notes[0].text.startsWith('这里挤了一下'),
      closed && { text: closed.notes[0].text });
    check(`${tag}：窗口底层始终不可见`, nativeVisible(ed.win) === false, { nativeVisible: nativeVisible(ed.win) });
    ed.close();
  }

  finish();
}

app.whenReady().then(main).catch(error => {
  console.error('FAIL', error);
  app.exit(1);
});
