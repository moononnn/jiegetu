/* 诊断脚本（不属于默认验收）：只查“真实输入到底有没有到达编辑页”。
   不展示窗口、不抢焦点：用 BrowserWindow 子类把 show/focus 变成计数空实现，
   直接装真实的 installImageEditorWindow + 真实 renderer/preload，窗口全程 show:false。
   阶段一先用一页最小页面证实 CDP 鼠标事件是真事件且 setPointerCapture 能用；
   阶段二再加载真实编辑页，只放一个点，记录事件目标/指针属性/命中元素/工具与草稿状态。
   运行：node_modules\electron\dist\electron.exe scripts\probe-editor-input.cjs */
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { installImageEditorWindow } = require('../main/image-editor-window.cjs');

const ROOT = path.join(__dirname, '..');
const trace = (label, value) => console.log(`TRACE ${label} ${JSON.stringify(value)}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const lifecycleCalls = { show: 0, focus: 0, showInactive: 0 };
// 只在测试里用一个子类：真实窗口始终 show:false，show/focus 只记账；
// isVisible 返回“逻辑上已显示”，满足宿主对 show 之后的可见性检查，但屏幕上什么都不出。
class HiddenWindow extends BrowserWindow {
  constructor(options = {}) {
    super({ ...options, show: false });
    this.__visible = false;
  }
  show() { lifecycleCalls.show += 1; this.__visible = true; }
  showInactive() { lifecycleCalls.showInactive += 1; this.__visible = true; }
  focus() { lifecycleCalls.focus += 1; }
  isVisible() { return this.__visible; }
  isMinimized() { return false; }
  restore() {}
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
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
      rows[y * (stride + 1) + 1 + x * 3] = 220;
      rows[y * (stride + 1) + 2 + x * 3] = 235;
      rows[y * (stride + 1) + 3 + x * 3] = 225;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const dataUrlOf = bytes => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-editor-input-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const waitFor = async (check, { timeout = 4000, interval = 60 } = {}) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(interval);
  }
  return undefined;
};

app.whenReady().then(async () => {
  // —— 阶段一：最小页面，证明 CDP 鼠标是真事件、capture 可用 ——
  const minimal = new HiddenWindow({ width: 600, height: 400, frame: false,
    webPreferences: { contextIsolation: false, sandbox: false } });
  await minimal.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><html><body style="margin:0">
    <div id="pad" style="position:absolute;inset:0;background:#eef"></div>
    <script>
      window.__log = [];
      const pad = document.getElementById('pad');
      for (const type of ['pointerdown','pointermove','pointerup']) {
        pad.addEventListener(type, event => {
          let captured = 'n/a';
          if (type === 'pointerdown') {
            try { pad.setPointerCapture(event.pointerId); captured = 'ok'; }
            catch (error) { captured = 'throw:' + error.name; }
          }
          window.__log.push({ type, isTrusted: event.isTrusted, pointerId: event.pointerId,
            isPrimary: event.isPrimary, buttons: event.buttons, button: event.button,
            clientX: Math.round(event.clientX), clientY: Math.round(event.clientY), captured });
        });
      }
    </script></body></html>`));
  minimal.webContents.debugger.attach('1.3');
  const minimalSend = (type, x, y, extra = {}) => minimal.webContents.debugger.sendCommand('Input.dispatchMouseEvent',
    { type, x, y, button: 'left', clickCount: 1, ...extra });
  await minimalSend('mouseMoved', 100, 100, { buttons: 0 });
  await minimalSend('mousePressed', 100, 100, { buttons: 1 });
  await minimalSend('mouseReleased', 100, 100, { buttons: 0 });
  await sleep(200);
  trace('minimal-log', await minimal.webContents.executeJavaScript('window.__log', true));
  minimal.destroy();

  // —— 阶段二：真实编辑页（真实主进程宿主 + 真实 preload/renderer，窗口隐藏） ——
  const commits = [];
  const host = installImageEditorWindow({
    BrowserWindow: HiddenWindow,
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    ipcMain,
    rendererFile: path.join(ROOT, 'renderer', 'image-editor-window.html'),
    preloadFile: path.join(ROOT, 'main', 'image-editor-preload.cjs'),
    iconFile: path.join(ROOT, 'assets', 'app-icon.ico'),
    theme: undefined,
    onCommit: async action => { commits.push(action); return { ok: true }; },
    onClose: async () => true,
    onExit: async () => false
  });
  const png = makePng(480, 360);
  const opened = host.open({ token: 'probe-token', width: 480, height: 360, rect: { x: 0, y: 0, width: 480, height: 360 } },
    { dataUrl: dataUrlOf(png) });
  const win = await waitFor(async () => host.getWindow('probe-token'), { timeout: 8000 });
  if (!win) { console.error('NO-WINDOW'); app.exit(1); return; }
  await waitFor(() => win.webContents.executeJavaScript('Boolean(window.__imageEditorDebug)', true).catch(() => false),
    { timeout: 8000 });
  await opened;
  trace('lifecycle', { ...lifecycleCalls, visible: win.isVisible() });
  const run = code => win.webContents.executeJavaScript(code, true);

  // 页面侧记录：who got the pointer, what was on top, what the editor thought at that moment
  await run(`(() => {
    window.__events = [];
    const record = (type, event) => {
      const path = event.composedPath ? event.composedPath().slice(0, 5).map(node => node.className || node.tagName) : [];
      const debug = window.__imageEditorDebug ? window.__imageEditorDebug() : null;
      window.__events.push({ type, isTrusted: event.isTrusted, target: event.target && (event.target.className || event.target.tagName),
        path, pointerId: event.pointerId, isPrimary: event.isPrimary, buttons: event.buttons, button: event.button,
        clientX: Math.round(event.clientX), clientY: Math.round(event.clientY),
        tool: debug && debug.tool, draft: debug && debug.draft, preview: debug && debug.preview, busy: debug && debug.busy });
    };
    for (const type of ['pointerdown', 'pointerup', 'pointercancel']) window.addEventListener(type, event => record(type, event), true);
    return true;
  })()`);

  const debug = await run('__imageEditorDebug()');
  trace('initial-debug', debug);
  const origin = debug.origin, view = debug.view;
  const scrollRect = await run(`(() => { const r = document.querySelector('.ie-scroll').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
  trace('geometry', { scrollRect, origin, view });
  // 选“点批注”工具，然后在图中央点一下（坐标由 origin/zoom 反算）
  await run(`document.querySelector('[data-tool="point"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await sleep(150);
  const px = 240, py = 180; // 源图坐标
  const clientX = scrollRect.left + origin.x + px;
  const clientY = scrollRect.top + origin.y + py;
  trace('click-target', { clientX, clientY,
    atPoint: await run(`(() => { const node = document.elementFromPoint(${Math.round(clientX)}, ${Math.round(clientY)});
      return node ? (node.className || node.tagName) : 'none'; })()`),
    tool: await run('__imageEditorDebug().tool') });

  win.webContents.debugger.attach('1.3');
  const send = (type, x, y, extra = {}) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',
    { type, x, y, button: 'left', clickCount: 1, ...extra });
  await send('mouseMoved', clientX, clientY, { buttons: 0 });
  await sleep(60);
  await send('mousePressed', clientX, clientY, { buttons: 1 });
  await sleep(80);
  trace('after-down', await run('__imageEditorDebug()'));
  await send('mouseReleased', clientX, clientY, { buttons: 0 });
  await sleep(200);
  trace('after-up', { debug: await run('__imageEditorDebug()'),
    events: await run('window.__events') });
  trace('draft-visible', await run(`({ quick: !document.querySelector('.ie-quick-bar').hidden,
    bubble: !document.querySelector('.ie-bubble')?.hidden, active: document.activeElement?.className || document.activeElement?.tagName })`));

  host.dispose();
  console.log('DONE');
  app.exit(0);
}).catch(error => {
  console.error('FAIL', error);
  app.exit(1);
});
