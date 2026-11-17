/* 真实 Chromium 里核对「选中清单项」的字色/底色是否看得见。
   用离屏隐藏窗（offscreen，不上屏、不采桌面、不抢焦点）+ 真实 computedStyle 实测 RGB，
   自己算 WCAG 对比度：常态 / 悬停 / 聚焦三态都要 >= 4.5。
   同时输出离屏截图（整图 + 说明区局部）供人工复核。
   运行：node_modules\electron\dist\electron.exe scripts\verify-editor-contrast.cjs */
'use strict';
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { installImageEditorWindow } = require('../main/image-editor-window.cjs');

const ROOT = path.join(__dirname, '..');
const EVIDENCE = process.env.VERIFY_EVIDENCE
  ? path.resolve(ROOT, process.env.VERIFY_EVIDENCE)
  : path.join(ROOT, 'evidence', '20261111-inspector-followup');
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

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-editor-contrast-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

fs.mkdirSync(EVIDENCE, { recursive: true });

// WCAG 对比度：按实测 RGB 算，不用正则猜 CSS。
function parseRgb(value) {
  const numbers = String(value || '').match(/[\d.]+/g);
  if (!numbers || numbers.length < 3) return null;
  return [Number(numbers[0]), Number(numbers[1]), Number(numbers[2])];
}
function channel(value) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(fg, bg) {
  if (!fg || !bg) return null;
  const a = luminance(fg), b = luminance(bg);
  const light = Math.max(a, b), dark = Math.min(a, b);
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

async function main() {
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
  const token = `contrast-${Date.now()}`;
  const opened = host.open({ token, width: 480, height: 360, rect: { x: 0, y: 0, width: 480, height: 360 } },
    { dataUrl: dataUrlOf(makePng(480, 360)) });
  const win = await waitUntil(async () => host.getWindow(token), { timeout: 9000, label: 'window' });
  if (!win) { host.dispose(); throw new Error('窗口没起来'); }
  let frame = null;
  win.webContents.on('paint', (_event, _dirty, image) => { if (image && !image.isEmpty()) frame = image; });
  await waitUntil(() => win.webContents.executeJavaScript('Boolean(window.__imageEditorDebug)').catch(() => false),
    { timeout: 9000, label: 'page' });
  await opened;
  win.setContentSize(1280, 800);
  await sleep(320);
  const run = code => win.webContents.executeJavaScript(code, true);
  win.webContents.debugger.attach('1.3');
  const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
  const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent',
    { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra });
  const moveTo = async (x, y) => { await mouse('mouseMoved', x, y, { buttons: 0 }); await sleep(80); };
  const clickAt = async (x, y, extra = {}) => {
    await mouse('mouseMoved', x, y, { buttons: 0, ...extra });
    await mouse('mousePressed', x, y, { buttons: 1, ...extra });
    await mouse('mouseReleased', x, y, { buttons: 0, ...extra });
    await sleep(80);
  };
  const dragAt = async (from, to) => {
    await mouse('mouseMoved', from.x, from.y, { buttons: 0 });
    await mouse('mousePressed', from.x, from.y, { buttons: 1 });
    for (let step = 1; step <= 8; step += 1) {
      await mouse('mouseMoved', from.x + ((to.x - from.x) * step) / 8, from.y + ((to.y - from.y) * step) / 8, { buttons: 1 });
    }
    await mouse('mouseReleased', to.x, to.y, { buttons: 0 });
    await sleep(80);
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

  // 两个目标：一个点、一个框；再连一条关系，清单里才有位置项和关系项。
  await clickAt((await center('[data-tool="point"]')).x, (await center('[data-tool="point"]')).y);
  await waitUntil(async () => (await debug()).tool === 'point', { label: 'tool-point' });
  await clickAt((await toClient(120, 120)).x, (await toClient(120, 120)).y);
  await waitUntil(async () => (await debug()).notes.length === 1, { label: 'note-point' });
  await clickAt((await center('[data-tool="region"]')).x, (await center('[data-tool="region"]')).y);
  await waitUntil(async () => (await debug()).tool === 'region', { label: 'tool-region' });
  await dragAt(await toClient(260, 140), await toClient(380, 250));
  await waitUntil(async () => (await debug()).notes.length === 2, { label: 'note-region' });
  await clickAt((await center('[data-tool="select"]')).x, (await center('[data-tool="select"]')).y);
  await waitUntil(async () => (await debug()).tool === 'select', { label: 'tool-select' });
  // 选中两处 → 建立关联（关系清单才有可点项）：第二处用 Shift（普通点击是替换选择）。
  await clickAt((await toClient(120, 120)).x, (await toClient(120, 120)).y);
  await clickAt((await toClient(320, 195)).x, (await toClient(320, 195)).y, { modifiers: 8 });
  await waitUntil(async () => (await debug()).selectedTargets.length === 2, { label: 'two-selected' });
  await clickAt((await center('[data-action="relation-create"]')).x, (await center('[data-action="relation-create"]')).y);
  await waitUntil(async () => (await debug()).relations.length === 1, { label: 'relation' });
  // 选中关系项：关系清单里那一项会是 aria-pressed=true。
  const relationItem = await center('.ie-relation-list .ie-list-item');
  await clickAt(relationItem.x, relationItem.y);
  await waitUntil(async () => Boolean((await debug()).selectedRelationId), { label: 'relation-selected' });

  // 量一个清单项在三种状态下的字色与底色（实测 computedStyle）。
  const measure = async (selector, label) => {
    const read = () => run(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const style = getComputedStyle(node);
      const r = node.getBoundingClientRect();
      return { text: node.textContent, color: style.color, background: style.backgroundColor,
        fontWeight: style.fontWeight, pressed: node.getAttribute('aria-pressed'),
        focus: node.matches(':focus'), focusVisible: node.matches(':focus-visible'),
        rect: { left: r.left, top: r.top, width: r.width, height: r.height } };
    })()`);
    const normal = await read();
    if (!normal) return null;
    const at = { x: normal.rect.left + normal.rect.width / 2, y: normal.rect.top + normal.rect.height / 2 };
    await moveTo(at.x, at.y);
    const hovered = await read();
    await run(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node) node.focus(); return true; })()`);
    await sleep(80);
    const focused = await read();
    await run(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node) node.blur(); return true; })()`);
    await moveTo(5, 5);
    const states = { normal, hovered, focused };
    const measured = {};
    for (const [state, value] of Object.entries(states)) {
      const fg = parseRgb(value.color), bg = parseRgb(value.background);
      measured[state] = { color: value.color, background: value.background, fg, bg,
        ratio: contrast(fg, bg), focusVisible: value.focusVisible, focus: value.focus, fontWeight: value.fontWeight };
    }
    trace(`measure-${label}`, measured);
    const bad = Object.entries(measured).filter(([, value]) => !(value.ratio >= 4.5)).map(([state]) => state);
    check(`${label}：常态/悬停/聚焦都看得清（对比度 >= 4.5，实测 RGB）`, bad.length === 0, measured);
    check(`${label}：确实是选中态（aria-pressed=true）`, normal.pressed === 'true', { pressed: normal.pressed });
    return measured;
  };

  const positionMeasured = await measure('.ie-note-list .ie-list-item[aria-pressed=true]', '位置清单选中项');
  const relationMeasured = await measure('.ie-relation-list .ie-list-item[aria-pressed=true]', '关系清单选中项');
  check('位置清单与关系清单是同一个 class（一条规则一起覆盖）',
    await run(`Boolean(document.querySelector('.ie-note-list .ie-list-item[aria-pressed=true]'))
      && Boolean(document.querySelector('.ie-relation-list .ie-list-item[aria-pressed=true]'))`));

  // 离屏证据：整图 + 说明区局部。
  await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  frame = null;
  win.webContents.invalidate();
  const captured = await waitUntil(() => frame, { timeout: 3000, label: 'frame' });
  if (captured) {
    const full = path.join(EVIDENCE, 'contrast-list-full.png');
    fs.writeFileSync(full, captured.toPNG());
    const panel = await run(`(() => { const r = document.querySelector('.ie-panel').getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
    const size = captured.getSize();
    const crop = nativeImage.createFromBuffer(captured.toPNG()).crop({
      x: Math.max(0, Math.min(size.width - 1, panel.x)), y: Math.max(0, Math.min(size.height - 1, panel.y)),
      width: Math.max(1, Math.min(size.width - panel.x, panel.width)), height: Math.max(1, Math.min(size.height - panel.y, panel.height)) });
    const cropFile = path.join(EVIDENCE, 'contrast-list-panel.png');
    fs.writeFileSync(cropFile, crop.toPNG());
    trace('shots', { full: path.relative(ROOT, full), panel: path.relative(ROOT, cropFile), size });
    check('离屏截图不是空白帧', captured.getSize().width > 0, captured.getSize());
  } else check('离屏截图拿到帧', false);

  check('窗口底层始终不可见', nativeVisible(win) === false, { nativeVisible: nativeVisible(win), lifecycle });
  fs.writeFileSync(path.join(EVIDENCE, 'contrast-results.json'),
    JSON.stringify({ results, failures, positionMeasured, relationMeasured }, null, 1));
  console.log(JSON.stringify({ results, failures }, null, 1));
  host.cleanup(token);
  host.dispose();
  app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(main).catch(error => {
  console.error('FAIL', error);
  app.exit(1);
});
