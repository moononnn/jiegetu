/* 选框页贴边布局：长标签（保存并复制／另存并复制）下，动作条仍要留在视口内、按钮都点得到。
   真实页面 + 真实 CSS + 真实贴边放置逻辑；离屏窗口、不显示、不采桌面；stub preload 只为让页面跑起来。
   运行：VERIFY_PASSES=1 node_modules\electron\dist\electron.exe scripts\verify-save-copy-layout.cjs
   证据目录可用 VERIFY_EVIDENCE 覆盖（复跑不覆盖冻结证据）。 */
'use strict';
const { installProbeGuard } = require('./probe-safety.cjs');
const probeGuard = installProbeGuard({ name: 'verify-save-copy-layout', timeoutMs: 4 * 60 * 1000 });
const { app, BrowserWindow: RealBrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const EVIDENCE = process.env.VERIFY_EVIDENCE
  ? path.resolve(ROOT, process.env.VERIFY_EVIDENCE)
  : path.join(ROOT, 'evidence', '20261113-save-copy');
const results = [];
const failures = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures.push(name);
  console.log(`CHECK ${name} ${ok ? 'ok' : 'FAIL'} ${JSON.stringify(detail ?? null)}`);
  return Boolean(ok);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitUntil = async (probe, { timeout = 8000, interval = 60, label = 'condition' } = {}) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(interval);
  }
  console.log(`TRACE timeout:${label} ${last === undefined ? 'undefined' : JSON.stringify(last)}`);
  return undefined;
};

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
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
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      rows[y * (stride + 1) + 1 + x * 3] = 220;
      rows[y * (stride + 1) + 2 + x * 3] = 235;
      rows[y * (stride + 1) + 3 + x * 3] = 225;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-save-copy-layout-'));
const stubPreload = path.join(userData, 'selection-stub-preload.cjs');
fs.mkdirSync(EVIDENCE, { recursive: true });
const pngDataUrl = `data:image/png;base64,${makePng(64, 48).toString('base64')}`;
fs.writeFileSync(stubPreload, `'use strict';
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('selection', {
  init: async () => ({ dataUrl: ${JSON.stringify(pngDataUrl)}, mode: 'single' }),
  ready: async () => true,
  diagnostic: async () => {},
  cancel: async () => {},
  commit: async () => ({ ok: true }),
  requestExit: async () => true,
  editSource: async () => ({ token: 'stub' }),
  editState: async () => true,
  editPreview: async () => {},
  previewImage: async () => ({ dataUrl: ${JSON.stringify(pngDataUrl)}, width: 64, height: 48 }),
  longCapability: async () => ({ available: false })
});
`);
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

class OffscreenWindow extends RealBrowserWindow {
  constructor(options = {}) {
    super({ ...options, show: false, webPreferences: { ...(options.webPreferences || {}), offscreen: true } });
    this.__logicalVisible = false;
  }
  show() { this.__logicalVisible = true; }
  showInactive() { this.__logicalVisible = true; }
  focus() {}
  hide() { this.__logicalVisible = false; }
  isVisible() { return this.__logicalVisible; }
}

app.whenReady().then(async () => {
  const win = new OffscreenWindow({
    width: 1000, height: 800, show: false, frame: false,
    webPreferences: { preload: stubPreload, contextIsolation: true }
  });
  let frame = null;
  win.webContents.on('paint', (_event, _dirty, image) => { if (image && !image.isEmpty()) frame = image; });
  await win.loadFile(path.join(ROOT, 'renderer', 'selection.html'));
  await waitUntil(() => win.webContents.executeJavaScript('Boolean(window.__selectionReady)').catch(() => false),
    { timeout: 5000, label: 'page' }).catch(() => undefined);
  const ready = await waitUntil(async () => {
    const state = await win.webContents.executeJavaScript('(() => ({ ready: Boolean(document.querySelector("#desktop")?.src) }))()');
    return state && state.ready ? state : undefined;
  }, { timeout: 8000, label: 'image-loaded' });
  check('选框页真的加载了底图', Boolean(ready), ready);
  win.webContents.debugger.attach('1.3');
  const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
  const mouse = (type, x, y, buttons) => cdp('Input.dispatchMouseEvent',
    { type, x: Math.round(x), y: Math.round(y), button: 'left', buttons, clickCount: 1 });
  const run = code => win.webContents.executeJavaScript(code, true);

  for (const [width, height] of [[1000, 800], [1920, 1080], [800, 600]]) {
    win.setContentSize(width, height);
    await sleep(300);
    // 在右下角拖一个小选区：真实页面的贴边放置逻辑会自己把动作条夹回视口内。
    await mouse('mouseMoved', width - 80, height - 70, 0);
    await mouse('mousePressed', width - 80, height - 70, 1);
    await mouse('mouseMoved', width - 20, height - 20, 1);
    await mouse('mouseReleased', width - 20, height - 20, 0);
    await sleep(500);
    const geometry = await run(`(() => {
      const rect = sel => { const node = document.querySelector(sel); if (!node) return null;
        const r = node.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      const actions = document.querySelector('#actions');
      return { inner: [innerWidth, innerHeight], hidden: actions?.hidden === true,
        actions: rect('#actions'), save: rect('#save'), saveAs: rect('#save-as'), copy: rect('#copy'),
        labels: { save: document.querySelector('#save')?.textContent || '', saveAs: document.querySelector('#save-as')?.textContent || '' } };
    })()`);
    check(`${width}x${height} 动作条真的出现了`, geometry.hidden === false, geometry);
    const inside = rect => Boolean(rect) && rect.left >= -1 && rect.top >= -1
      && rect.right <= geometry.inner[0] + 1 && rect.bottom <= geometry.inner[1] + 1;
    check(`${width}x${height} 长标签下动作条仍在视口内`, inside(geometry.actions), geometry);
    check(`${width}x${height} 三个输出按钮都在视口内`, inside(geometry.save) && inside(geometry.saveAs) && inside(geometry.copy), geometry);
    check(`${width}x${height} 按钮互不重叠`, geometry.saveAs.right <= geometry.save.left + 1
      && geometry.save.right <= geometry.copy.left + 1, geometry);
    check(`${width}x${height} 标签写明并复制`, geometry.labels.save === '保存并复制' && geometry.labels.saveAs === '另存并复制', geometry.labels);
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    frame = null;
    win.webContents.invalidate();
    const captured = await waitUntil(() => frame, { timeout: 4000, label: `frame-${width}` });
    if (captured) {
      const target = path.join(EVIDENCE, `selection-bar-${width}x${height}.png`);
      fs.writeFileSync(target, captured.toPNG());
      check(`${width}x${height} 截图落盘`, fs.existsSync(target), path.relative(ROOT, target));
    } else {
      check(`${width}x${height} 截图落盘`, false, '没有拿到离屏帧');
    }
  }
  finish(failures.length ? 1 : 0);
}).catch(error => { console.error('FAIL', error); finish(1); });

function finish(code) {
  try {
    fs.writeFileSync(path.join(EVIDENCE, 'probe-layout.json'), `${JSON.stringify({ results, failures }, null, 1)}\n`);
  } catch { /* 证据写不下去也不能改结论。 */ }
  console.log(`RESULT ${JSON.stringify({ checks: results.length, failures })}`);
  probeGuard.finish();
  app.exit(code);
}
