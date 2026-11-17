/* 保存并复制：跨进程出口的真机短场景。
   走真实链路：编辑窗真实按钮 → renderer 真实 exportClipboard → 真实 IPC → 主进程真实校验 →
   真实写盘（只写本次隔离的临时目录）→ 发布替身（不碰真实系统剪贴板）。
   校验：磁盘文件与发布字节 SHA256 逐字节一致；主图保留笔迹、不含编号框；下方有说明区；
   取消另存不写不复制；复制失败如实回报“已保存但复制失败”。
   全程离屏窗口（offscreen、不显示、不采桌面），独立 userData；系统另存框用替身。
   运行：VERIFY_PASSES=1 node_modules\electron\dist\electron.exe scripts\verify-editor-save-copy.cjs
   证据目录可用 VERIFY_EVIDENCE 覆盖（复跑不覆盖冻结证据）。 */
'use strict';
// 生命周期保护先装（任何日志之前）：断管／未捕获异常／超时都落故障文件并非 0 退出。
const { installProbeGuard } = require('./probe-safety.cjs');
const probeGuard = installProbeGuard({ name: 'verify-editor-save-copy', timeoutMs: 6 * 60 * 1000 });
const Module = require('node:module');
const realElectron = require('electron');
const { app, BrowserWindow: RealBrowserWindow, dialog, nativeImage } = realElectron;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

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
const trace = (label, value) => console.log(`TRACE ${label} ${JSON.stringify(value)}`);
const waitUntil = async (probe, { timeout = 8000, interval = 60, label = 'condition' } = {}) => {
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

// —— 离屏窗口：永远不显示，也不抢焦点 ——
const lifecycle = { show: 0, focus: 0, hide: 0 };
const createdWindows = [];
class OffscreenWindow extends RealBrowserWindow {
  constructor(options = {}) {
    super({ ...options, show: false, webPreferences: { ...(options.webPreferences || {}), offscreen: true } });
    this.__logicalVisible = false;
    createdWindows.push(this);
  }
  show() { lifecycle.show += 1; this.__logicalVisible = true; }
  showInactive() { lifecycle.show += 1; this.__logicalVisible = true; }
  focus() { lifecycle.focus += 1; }
  restore() { this.__logicalVisible = true; }
  hide() { lifecycle.hide += 1; this.__logicalVisible = false; }
  isVisible() { return this.__logicalVisible; }
  isMinimized() { return false; }
}
// 主进程模块拿到的必须是离屏窗口：electron 的 BrowserWindow 是只读 getter，只能在模块装载层替换。
const fakeElectron = new Proxy(realElectron, {
  get(target, prop) {
    if (prop === 'BrowserWindow') return OffscreenWindow;
    if (prop === 'clipboard') return { write: async () => { throw new Error('探针不允许写真实系统剪贴板'); } };
    const value = target[prop];
    return typeof value === 'function' ? value.bind(target) : value;
  }
});
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

const { installScreenshot } = require('../main/screenshot.cjs');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
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
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      rows[y * (stride + 1) + 1 + x * 3] = SOURCE_RGB[0];
      rows[y * (stride + 1) + 2 + x * 3] = SOURCE_RGB[1];
      rows[y * (stride + 1) + 3 + x * 3] = SOURCE_RGB[2];
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const dataUrlOf = bytes => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function pixelsOf(buffer) {
  const image = nativeImage.createFromBuffer(Buffer.from(buffer));
  if (image.isEmpty()) return null;
  return { size: image.getSize(), bitmap: image.toBitmap() };
}
const pixelAt = (pixels, x, y) => {
  const index = (y * pixels.size.width + x) * 4;
  return [pixels.bitmap[index], pixels.bitmap[index + 1], pixels.bitmap[index + 2], pixels.bitmap[index + 3]];
};
const samePixel = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

const IMAGE_WIDTH = 480;
const IMAGE_HEIGHT = 360;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-editor-save-copy-'));
const shotsDir = path.join(userData, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });
fs.mkdirSync(EVIDENCE, { recursive: true });
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const published = [];
const statuses = [];
let publishMode = 'ok';
let dialogMode = 'ok';
let dialogCalls = 0;

app.whenReady().then(async () => {
  console.log('STEP ready');
  // 系统另存框替身：只写本次隔离的临时目录，不碰真实对话框。
  dialog.showSaveDialog = async () => {
    dialogCalls += 1;
    if (dialogMode === 'cancel') return { canceled: true };
    return { canceled: false, filePath: path.join(shotsDir, 'probe-save-as.png') };
  };
  const shots = installScreenshot({
    getControl: () => undefined,
    isProbeBusy: () => false,
    directory: shotsDir,
    settings: { resolveSaveFolder: () => shotsDir, resolveAsFolder: () => shotsDir, update: () => {}, getClipboard: () => ({ enabled: false }) },
    theme: undefined,
    onStatus: status => { statuses.push(status); console.log('STATUS ' + JSON.stringify(status)); },
    // 发布替身：接住真实成图字节，绝不写真实系统剪贴板。
    publishPng: async bytes => {
      if (publishMode === 'throw') throw new Error('发布通道不可用');
      published.push(Buffer.from(bytes));
      return true;
    },
    copyGif: async () => ({}),
    onExternalEditorClosed: () => {}
  });
  console.log('STEP installed');

  const opened = await shots.openExternalEditor({ bytes: makePng(IMAGE_WIDTH, IMAGE_HEIGHT) });
  check('外部编辑会话真的开了', opened?.ok === true && typeof opened.token === 'string', opened);
  const win = await waitUntil(() => createdWindows.find(item => {
    try { return item.webContents.getURL().includes('image-editor-window.html'); } catch { return false; }
  }), { timeout: 9000, label: 'editor-window' });
  check('编辑窗真的建出来了', Boolean(win), {
    created: createdWindows.length,
    urls: createdWindows.map(item => { try { return item.webContents.getURL(); } catch { return 'unknown'; } })
  });
  if (!win) { finish(1); return; }
  let frame = null;
  win.webContents.on('paint', (_event, _dirty, image) => { if (image && !image.isEmpty()) frame = image; });
  await waitUntil(() => win.webContents.executeJavaScript('Boolean(window.__imageEditorDebug)').catch(() => false),
    { timeout: 9000, label: 'page-ready' });
  win.setContentSize(900, 700);
  await sleep(400);
  check('编辑窗没有真的显示在桌面上', RealBrowserWindow.prototype.isVisible.call(win) === false,
    { nativeVisible: RealBrowserWindow.prototype.isVisible.call(win), showCalls: lifecycle.show });

  const run = code => win.webContents.executeJavaScript(code, true);
  win.webContents.debugger.attach('1.3');
  const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
  const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent',
    { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra });
  const clickAt = async (x, y) => {
    await mouse('mouseMoved', x, y, { buttons: 0 });
    await mouse('mousePressed', x, y, { buttons: 1 });
    await mouse('mouseReleased', x, y, { buttons: 0 });
    await sleep(120);
  };
  const dragAt = async (from, to) => {
    await mouse('mouseMoved', from.x, from.y, { buttons: 0 });
    await mouse('mousePressed', from.x, from.y, { buttons: 1 });
    for (let step = 1; step <= 8; step += 1) {
      await mouse('mouseMoved', from.x + ((to.x - from.x) * step) / 8, from.y + ((to.y - from.y) * step) / 8, { buttons: 1 });
    }
    await mouse('mouseReleased', to.x, to.y, { buttons: 0 });
    await sleep(150);
  };
  const center = sel => run(`(() => { const node = document.querySelector(${JSON.stringify(sel)});
    if (!node) return null; const r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const debug = () => run('__imageEditorDebug()');
  // 源图像素 → 客户端坐标：按当前真正看得见的那块图投影，不拿画布比例冒充分数。
  const toClient = async (x, y) => {
    const d = await debug();
    const rect = await run(`(() => { const r = document.querySelector('.ie-scroll').getBoundingClientRect();
      return { left: r.left, top: r.top }; })()`);
    return { x: rect.left + d.origin.x + x * d.zoom, y: rect.top + d.origin.y + y * d.zoom };
  };

  // 1) 一处点批注 + 一句说明（共同说明写在批注里）。
  const pointTool = await center('[data-tool="point"]');
  await clickAt(pointTool.x, pointTool.y);
  await waitUntil(async () => (await debug()).tool === 'point', { label: 'tool-point' });
  const markerSource = { x: 120, y: 90 };
  const markerAt = await toClient(markerSource.x, markerSource.y);
  await clickAt(markerAt.x, markerAt.y);
  const notes = await waitUntil(async () => { const d = await debug(); return d.notes.length === 1 && d; }, { label: 'note-created' });
  check('真的落下一处批注', Boolean(notes) && notes.notes.length === 1, notes && notes.notes);
  await run(`(() => { const node = document.querySelector('.ie-bubble-text'); if (!node) return false;
    node.focus(); node.select(); return true; })()`);
  await cdp('Input.insertText', { text: '这条说明要出现在图片下方。' });
  await sleep(150);

  // 2) 一笔笔迹：主图里要看得见，编号框不能进图。
  const penTool = await center('[data-tool="pen"]');
  await clickAt(penTool.x, penTool.y);
  await waitUntil(async () => (await debug()).tool === 'pen', { label: 'tool-pen' });
  const strokeFrom = await toClient(200, 250);
  const strokeTo = await toClient(380, 300);
  await dragAt(strokeFrom, strokeTo);
  const painted = await debug();
  check('笔迹进到了编辑历史', painted.paint.length > 0, painted.paint.length);

  // 3) 点「保存并复制」：真实按钮 → 真实 IPC → 真实写盘 → 发布替身。
  const before = published.length;
  const saveButton = await center('[data-action="save"]');
  await clickAt(saveButton.x, saveButton.y);
  const saved = await waitUntil(async () => (published.length > before ? published[published.length - 1] : undefined),
    { timeout: 20000, label: 'save-published' });
  check('保存并复制真的发布了成图', Boolean(saved), saved && saved.length);
  const files = fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir).filter(name => name.endsWith('.png')) : [];
  check('保存并复制真的写盘了', files.length === 1, files);
  if (saved && files.length === 1) {
    const disk = fs.readFileSync(path.join(shotsDir, files[0]));
    check('磁盘文件与发布字节逐字节一致', sha256(disk) === sha256(saved),
      { disk: sha256(disk), published: sha256(saved), bytes: disk.length });
    const source = pixelsOf(makePng(IMAGE_WIDTH, IMAGE_HEIGHT));
    const out = pixelsOf(disk);
    check('成图宽度按说明区规则补白到 720', out && out.size.width === 720, out && out.size);
    check('成图高度大于原图（说明区在下方）', out && out.size.height > IMAGE_HEIGHT, out && out.size);
    if (out) {
      const markerPixel = pixelAt(out, markerSource.x, markerSource.y);
      const sourcePixel = pixelAt(source, markerSource.x, markerSource.y);
      check('主图里没有编号框：批注落点仍是原图像素', samePixel(markerPixel, sourcePixel),
        { markerPixel, sourcePixel });
      const midX = 290;
      const midY = 275;
      const strokePixel = pixelAt(out, midX, midY);
      check('主图里保留了笔迹', !samePixel(strokePixel, sourcePixel), { strokePixel, sourcePixel });
      let darkInFooter = 0;
      for (let y = IMAGE_HEIGHT + 2; y < Math.min(out.size.height, IMAGE_HEIGHT + 120); y += 2) {
        for (let x = 0; x < Math.min(out.size.width, 700); x += 2) {
          const p = pixelAt(out, x, y);
          if (p[0] < 120 && p[1] < 120 && p[2] < 120) darkInFooter += 1;
        }
      }
      check('下方说明区画上了文字', darkInFooter > 4, darkInFooter);
      fs.writeFileSync(path.join(EVIDENCE, 'saved-image.png'), disk);
    }
  }
  const saveStatus = await run(`(() => document.querySelector('.ie-status')?.textContent || '')()`);
  check('界面回报已保存并复制', /已保存并复制/.test(saveStatus), saveStatus);

  // 4) 点「复制图片」：只复制，不写第二个文件。
  const filesBeforeCopy = fs.readdirSync(shotsDir).filter(name => name.endsWith('.png')).length;
  const copyBefore = published.length;
  const copyButton = await center('[data-action="copy"]');
  await clickAt(copyButton.x, copyButton.y);
  const copied = await waitUntil(async () => (published.length > copyBefore ? published[published.length - 1] : undefined),
    { timeout: 20000, label: 'copy-published' });
  check('复制图片真的发布了成图', Boolean(copied), copied && copied.length);
  check('复制图片不写文件', fs.readdirSync(shotsDir).filter(name => name.endsWith('.png')).length === filesBeforeCopy,
    fs.readdirSync(shotsDir));

  // 5) 另存并复制：系统另存框被取消 → 不写不复制，界面说清没复制。
  dialogMode = 'cancel';
  const publishBeforeCancel = published.length;
  const saveAsButton = await center('[data-action="save-as"]');
  await clickAt(saveAsButton.x, saveAsButton.y);
  await sleep(1200);
  check('取消另存没有发布任何东西', published.length === publishBeforeCancel, published.length);
  check('取消另存没有多写文件', fs.readdirSync(shotsDir).filter(name => name.endsWith('.png')).length === filesBeforeCopy,
    fs.readdirSync(shotsDir));
  const cancelStatus = await run(`(() => document.querySelector('.ie-status')?.textContent || '')()`);
  check('取消另存时界面说清没有复制', /没有复制/.test(cancelStatus), cancelStatus);

  // 6) 复制通道失败：文件留下，界面如实说“已保存但复制失败”。
  dialogMode = 'ok';
  publishMode = 'throw';
  const publishBeforeFail = published.length;
  const saveButton2 = await center('[data-action="save"]');
  await clickAt(saveButton2.x, saveButton2.y);
  await sleep(2500);
  const failStatus = await run(`(() => document.querySelector('.ie-status')?.textContent || '')()`);
  check('复制失败时界面如实回报已保存但复制失败', /已保存到/.test(failStatus) && /复制失败/.test(failStatus), failStatus);
  check('复制失败时不谎报成功发布', published.length === publishBeforeFail, published.length);
  publishMode = 'ok';

  // 7) 窄窗与宽窗的真实布局：长标签也要在视口内、按钮都点得到。
  for (const [width, height] of [[1280, 800], [640, 480], [560, 402]]) {
    win.setContentSize(width, height);
    await sleep(500);
    const geometry = await run(`(() => {
      const rect = sel => { const node = document.querySelector(sel); if (!node) return null;
        const r = node.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      return { inner: [innerWidth, innerHeight], header: rect('.ie-header'), exports: rect('.ie-exports'),
        save: rect('[data-action="save"]'), saveAs: rect('[data-action="save-as"]'), copy: rect('[data-action="copy"]'),
        segments: rect('[data-action="segments"]'), labels: {
          save: document.querySelector('[data-action="save"]')?.textContent || '',
          saveAs: document.querySelector('[data-action="save-as"]')?.textContent || '' } };
    })()`);
    const inside = rect => Boolean(rect) && rect.left >= -1 && rect.top >= -1
      && rect.right <= geometry.inner[0] + 1 && rect.bottom <= geometry.inner[1] + 1;
    check(`${width}x${height} 三个输出按钮都在视口内`, inside(geometry.save) && inside(geometry.saveAs) && inside(geometry.copy),
      geometry);
    check(`${width}x${height} 按钮互不重叠`, geometry.save && geometry.saveAs && geometry.copy
      && geometry.saveAs.right <= geometry.save.left + 1 && geometry.save.right <= geometry.copy.left + 1, geometry);
    check(`${width}x${height} 标签写明并复制`, geometry.labels.save === '保存并复制' && geometry.labels.saveAs === '另存并复制…', geometry.labels);
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    frame = null;
    win.webContents.invalidate();
    const captured = await waitUntil(() => frame, { timeout: 4000, label: `frame-${width}` });
    if (captured) {
      const target = path.join(EVIDENCE, `editor-${width}x${height}.png`);
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
    fs.writeFileSync(path.join(EVIDENCE, 'probe-save-copy.json'), `${JSON.stringify({ results, failures }, null, 1)}\n`);
  } catch { /* 证据写不下去也不能改结论。 */ }
  console.log(`RESULT ${JSON.stringify({ checks: results.length, failures })}`);
  probeGuard.finish();
  app.exit(code);
}
