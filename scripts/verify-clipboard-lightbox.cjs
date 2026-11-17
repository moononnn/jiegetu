/* 剪贴板看大图的缩放/平移与「编辑图片」入口验收：真实页面 + 真实主进程，只换发布、设置和编辑宿主。
   证明：点缩略图能开图、滚轮能放大、拖动会平移、「适应」能复位、放大后取原图、编辑按钮把原图交给编辑入口。
   运行：node_modules\electron\dist\electron.exe scripts\verify-clipboard-lightbox.cjs */
'use strict';
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createClipboardStore } = require('../main/clipboard-store.cjs');
const { installClipboardWindow } = require('../main/clipboard-window.cjs');

const ROOT = path.join(__dirname, '..');
const results = [];
const failures = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures.push(name);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makePng(width, height, paint) {
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
      const [r, g, b] = paint(x, y);
      rows[y * (stride + 1) + 1 + x * 3] = r;
      rows[y * (stride + 1) + 2 + x * 3] = g;
      rows[y * (stride + 1) + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clipboard-lightbox-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();

class HiddenWindow extends BrowserWindow {
  constructor(options = {}) { super({ ...options, show: false }); }
  show() {}
  showInactive() {}
}

app.whenReady().then(async () => {
  const store = createClipboardStore({ root: path.join(userData, 'clipboard') });
  await store.open();
  const settingsState = { enabled: true, paused: false, hotkey: 'Ctrl+Alt+V', retentionDays: 30,
    maxHistoryItems: 1000, maxStorageBytes: 2 * 1024 * 1024 * 1024, excludedApps: [] };
  const service = {
    status: () => ({ phase: 'ready' }),
    publish: async () => ({ published: true }),
    paste: async () => true,
    setExcludedApps: () => {}
  };
  const settings = {
    getClipboard: () => ({ ...settingsState, excludedApps: [] }),
    updateClipboard: patch => { Object.assign(settingsState, patch); return { ...settingsState, excludedApps: [] }; }
  };

  // 一张够大的图：预览会被压到 1600 宽，原图仍是 2400 宽，能区分“换了原图”。
  const firstEntry = await store.addEntry({ entries: [{ key: 'png', bytes: makePng(2400, 1400, (x, y) => (y < 700 ? [210, 90, 120] : [245, 245, 240])) }], source: 'verify' });
  // 第二张只看“慢 image 回包”：主进程预览缓存按条目分，全程不去开它，它就一直未缓存。
  const slowEntry = await store.addEntry({ entries: [{ key: 'png',
    bytes: makePng(1800, 1100, (x, y) => (x < 900 ? [80, 150, 200] : [250, 250, 240])) }], source: 'verify-slow' });
  // 第二张只用来看“慢 image 回包”：主进程缓存按条目分，未预览过的条目才会真去读盘。
  const editorCalls = [];
  const windowHost = installClipboardWindow({
    BrowserWindow: HiddenWindow, ipcMain, theme: undefined, nativeImage,
    rendererFile: path.join(ROOT, 'renderer', 'clipboard-history.html'),
    preloadFile: path.join(ROOT, 'main', 'clipboard-preload.cjs'),
    iconFile: path.join(ROOT, 'assets', 'app-icon.ico'),
    store, service, settings,
    onStatus: () => {}, getPasteTarget: () => undefined, getRevision: () => 0,
    multiCopyDir: path.join(userData, 'clipboard', 'multi-copy'),
    onOpenWorkspace: () => ({ ok: true }), onOpenGroup: () => ({ ok: true }),
    openEditor: async bytes => { editorCalls.push(bytes?.length || 0); return { ok: true, token: 'verify' }; }
  });

  await windowHost.show();
  const win = windowHost.getWindow();
  // 观察窗口生命周期：× 在预览里不应该收起窗口。
  const lifecycle = { hides: 0 };
  const realHide = win.hide.bind(win);
  win.hide = (...args) => { lifecycle.hides += 1; return realHide(...args); };
  // 让 image / imageFull 可以慢，用来验证“关掉后晚回包不能复活预览”。
  let slowReadMs = 0;
  const realReadBlob = store.readBlob.bind(store);
  store.readBlob = async hash => { if (slowReadMs) await sleep(slowReadMs); return realReadBlob(hash); };
  const consoleErrors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) consoleErrors.push(message); });
  await sleep(1400);
  const run = code => win.webContents.executeJavaScript(code, true);

  // 1. 点缩略图开大图。
  await run(`document.querySelector('#list .clip-row[data-id="${firstEntry.id}"] .clip-thumb')?.click()`);
  await sleep(900);
  const opened = await run(`(() => {
    const box = document.getElementById('lightbox');
    const img = document.getElementById('lightboxImage');
    return { hidden: box.hidden, hasSrc: Boolean(img.getAttribute('src')),
      transform: img.style.transform, editHidden: document.getElementById('lightboxEdit').hidden,
      zoomLabel: document.getElementById('zoomReset').textContent };
  })()`);
  check('点缩略图打开大图', opened.hidden === false && opened.hasSrc === true, JSON.stringify(opened));
  check('编辑器入口可见', opened.editHidden === false, String(opened.editHidden));
  check('初始是适应窗口', opened.zoomLabel === '适应', opened.zoomLabel);
  // 刚打开必须居中：图片中心要落在舞台中心。
  const centered = await run(`(() => {
    const img = document.getElementById('lightboxImage').getBoundingClientRect();
    const st = document.getElementById('lightboxStage').getBoundingClientRect();
    return { dx: Math.round((img.x + img.width / 2) - (st.x + st.width / 2)),
      dy: Math.round((img.y + img.height / 2) - (st.y + st.height / 2)),
      pannable: document.getElementById('lightboxStage').classList.contains('pannable') };
  })()`);
  check('刚打开是居中的', Math.abs(centered.dx) <= 2 && Math.abs(centered.dy) <= 2, JSON.stringify(centered));
  check('适应窗口时不给拖动（图已完整可见）', centered.pannable === false, JSON.stringify(centered));

  // 未放大时按住拖：位置不能变。
  const noDrag = await run(`(() => {
    const stage = document.getElementById('lightboxStage');
    const r = stage.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const send = (t, x, y) => stage.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true,
      pointerId: 9, button: 0, buttons: t === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
    send('pointerdown', cx, cy); send('pointermove', cx - 200, cy - 200); send('pointerup', cx - 200, cy - 200);
    return document.getElementById('lightboxImage').style.transform;
  })()`);
  check('没放大时拖不动', /translate\(0px, 0px\)/.test(noDrag), noDrag);

  // 2. 滚轮放大：以指针为中心，缩放比例往上走。
  const zoomed = await run(`(() => {
    const stage = document.getElementById('lightboxStage');
    const rect = stage.getBoundingClientRect();
    for (let i = 0; i < 4; i += 1) {
      stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    }
    const img = document.getElementById('lightboxImage');
    return { transform: img.style.transform, label: document.getElementById('zoomReset').textContent,
      zoomedClass: stage.classList.contains('zoomed') };
  })()`);
  const scaleMatch = /scale\(([\d.]+)\)/.exec(zoomed.transform || '');
  const scale = scaleMatch ? Number(scaleMatch[1]) : 0;
  check('滚轮能放大', scale > 1.2, `${zoomed.transform} · ${zoomed.label}`);
  check('放大后显示百分比', /%$/.test(zoomed.label), zoomed.label);
  check('放大时舞台加深底色', zoomed.zoomedClass === true);

  // 3. 拖动平移。
  const dragged = await run(`(() => {
    const stage = document.getElementById('lightboxStage');
    const rect = stage.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const send = (type, x, y) => stage.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
      pointerId: 5, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
    send('pointerdown', cx, cy);
    send('pointermove', cx - 60, cy - 40);
    send('pointerup', cx - 60, cy - 40);
    return document.getElementById('lightboxImage').style.transform;
  })()`);
  check('拖动会平移', /translate\(-?\d+(\.\d+)?px, -?\d+(\.\d+)?px\)/.test(dragged) && !/translate\(0px, 0px\)/.test(dragged), dragged);
  // 狠拖一把：图片四边不能进到舞台里面（也就不会把图拖到看不见）。
  const clamped = await run(`(() => {
    const stage = document.getElementById('lightboxStage');
    const r = stage.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const send = (t, x, y) => stage.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true,
      pointerId: 4, button: 0, buttons: t === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
    send('pointerdown', cx, cy);
    for (let i = 1; i <= 8; i += 1) send('pointermove', cx - i * 300, cy - i * 300);
    send('pointerup', cx - 2400, cy - 2400);
    const img = document.getElementById('lightboxImage');
    const ir = img.getBoundingClientRect();
    return { raw: img.style.transform,
      gapLeft: Math.round(ir.left - r.left), gapTop: Math.round(ir.top - r.top),
      gapRight: Math.round(r.right - ir.right), gapBottom: Math.round(r.bottom - ir.bottom) };
  })()`);
  check('拖到底会被边界兜住', clamped.gapLeft <= 1 && clamped.gapTop <= 1 && clamped.gapRight <= 1 && clamped.gapBottom <= 1,
    JSON.stringify(clamped));
  // 浏览器在 pointerup 之后会再派一次 click；那一下不能把大图关掉。
  const afterRelease = await run(`(() => {
    const stage = document.getElementById('lightboxStage');
    stage.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return document.getElementById('lightbox').hidden;
  })()`);
  check('拖完松手不会关掉大图', afterRelease === false, `hidden=${afterRelease}`);

  // 4. 放大后应该去要原图：预览被压到 1600 宽，原图是 2400 宽。
  await sleep(1200);
  const fullLoaded = await run(`(() => {
    const img = document.getElementById('lightboxImage');
    return { nw: img.naturalWidth, nh: img.naturalHeight };
  })()`);
  check('放大后换成原图（天然宽度从 1600 变 2400）', fullLoaded.nw === 2400, JSON.stringify(fullLoaded));

  // 5. 「适应」复位。
  const reset = await run(`(() => {
    document.getElementById('zoomReset').click();
    const img = document.getElementById('lightboxImage');
    return { transform: img.style.transform, label: document.getElementById('zoomReset').textContent };
  })()`);
  check('点适应回到原始大小', /scale\(1\)/.test(reset.transform) && reset.label === '适应', JSON.stringify(reset));

  // 6. 编辑按钮把原图交给编辑入口。
  await run(`document.getElementById('lightboxEdit').click()`);
  await sleep(900);
  check('编辑按钮把图送去编辑', editorCalls.length === 1 && editorCalls[0] > 1000, JSON.stringify(editorCalls));
  const afterEdit = await run(`document.getElementById('lightbox').hidden`);
  check('送去编辑后大图收起', afterEdit === true, String(afterEdit));

  check('页面无运行时错误', consoleErrors.length === 0, consoleErrors.slice(0, 3));

  // —— 预览关闭与重新呼出：× / 原生关闭 / 晚回包 ——
  const openPreview = async () => {
    await run(`document.querySelector('#list .clip-row[data-id="${firstEntry.id}"] .clip-thumb')?.click()`);
    await sleep(800);
    return run(`document.getElementById('lightbox').hidden`);
  };
  // 指定条目：慢回包用例要用从没预览过的图（主进程缓存按条目分）。
  const openPreviewOf = async id => {
    await run(`document.querySelector('#list .clip-row[data-id="${id}"] .clip-thumb')?.click()`);
    await sleep(200);
    return run(`document.getElementById('lightbox').hidden`);
  };

  // 7. 预览里点×：先退回列表，窗口继续用。
  const openedAgain = await openPreview();
  check('重开预览成功（后续用例前提）', openedAgain === false, String(openedAgain));
  const hidesBeforeX = lifecycle.hides;
  await run(`document.getElementById('close').click()`);
  await sleep(400);
  const afterX = await run(`({ hidden: document.getElementById('lightbox').hidden,
    rows: document.querySelectorAll('#list .clip-row[data-id]').length,
    listHidden: document.getElementById('list').hidden })`);
  check('预览中点×：回到列表、窗口不收起', afterX.hidden === true && lifecycle.hides === hidesBeforeX, afterX);
  check('回到列表后列表仍可用', afterX.rows > 0 && afterX.listHidden === false, afterX);

  // 8. 列表里点×：这时候才收起窗口。
  await run(`document.getElementById('close').click()`);
  await sleep(300);
  check('列表状态点×才收起窗口', lifecycle.hides === hidesBeforeX + 1, lifecycle);

  // 9. 原生 close（标题栏系统关闭/Alt+F4）：预览时只回列表，列表才收起；连做两轮。
  for (const round of [1, 2]) {
    await windowHost.show();
    await sleep(500);
    const afterShow = await run(`document.getElementById('lightbox').hidden`);
    check(`第 ${round} 轮重新呼出：没有残留预览`, afterShow === true, String(afterShow));
    const opened = await openPreview();
    check(`第 ${round} 轮：呼出后还能正常开预览`, opened === false, String(opened));
    const hidesBeforeNative = lifecycle.hides;
    win.close();
    await sleep(450);
    const afterNative = await run(`({ hidden: document.getElementById('lightbox').hidden,
      rows: document.querySelectorAll('#list .clip-row[data-id]').length })`);
    check(`第 ${round} 轮：预览中原生关闭只回列表、不收起窗口`,
      afterNative.hidden === true && lifecycle.hides === hidesBeforeNative, { ...afterNative, hides: lifecycle.hides });
    check(`第 ${round} 轮：原生关闭后列表仍可用`, afterNative.rows > 0, afterNative);
    win.close();
    await sleep(350);
    check(`第 ${round} 轮：列表状态原生关闭才收起窗口`, lifecycle.hides === hidesBeforeNative + 1, lifecycle);
  }
  await windowHost.show();
  await sleep(500);
  check('原生关闭再呼出：同样不带预览', (await run(`document.getElementById('lightbox').hidden`)) === true);

  // 10. 慢 image 回包：还没打开就被收起，晚到的图不能把预览又从列表顶出来。
  // slowEntry 全程没开过，所以它不在预览缓存里，slowReadMs 会真的拖慢这次读盘。
  slowReadMs = 700;
  await openPreviewOf(slowEntry.id);
  await openPreviewOf(slowEntry.id);
  await sleep(100);
  const hidesBeforeSlow = lifecycle.hides;
  win.close();
  await sleep(200);
  await sleep(900); // 越过慢读取的延迟，让旧回包真的回来
  const afterSlow = await run(`document.getElementById('lightbox').hidden`);
  check('慢图回包晚到也不会打开预览', afterSlow === true, `hidden=${afterSlow}`);
  check('慢图期间关闭确实收起了窗口', lifecycle.hides === hidesBeforeSlow + 1, { before: hidesBeforeSlow, now: lifecycle.hides });
  await windowHost.show();
  await sleep(600);
  check('慢图之后重新呼出仍是列表', (await run(`document.getElementById('lightbox').hidden`)) === true);
  slowReadMs = 0;
  const reopenAfterSlow = await openPreview();
  check('慢图作废后预览仍能正常打开', reopenAfterSlow === false, String(reopenAfterSlow));

  // 11. 慢 imageFull 回包：预览中原生关闭后，晚到的原图不能复活预览。
  slowReadMs = 600;
  await run(`(() => {
    const stage = document.getElementById('lightboxStage');
    const rect = stage.getBoundingClientRect();
    for (let i = 0; i < 4; i += 1) stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    return true;
  })()`);
  await sleep(120);
  const hidesBeforeSlowFull = lifecycle.hides;
  win.close();
  await sleep(1000);
  const afterSlowFull = await run(`document.getElementById('lightbox').hidden`);
  check('慢原图晚到也不会复活预览', afterSlowFull === true, `hidden=${afterSlowFull}`);
  check('慢原图期间原生关闭只关预览，窗口还在', lifecycle.hides === hidesBeforeSlowFull, lifecycle);
  win.close();
  await sleep(350);
  await windowHost.show();
  await sleep(600);
  check('慢原图之后重新呼出仍是列表', (await run(`document.getElementById('lightbox').hidden`)) === true);
  slowReadMs = 0;

  // 12. Esc / 点空白：先关预览，不关列表；列表状态按 Esc 才收起窗口。
  const escOpen = await openPreview();
  check('Esc 用例前提：预览已打开', escOpen === false, String(escOpen));
  const hidesBeforeEsc = lifecycle.hides;
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);
  const afterEsc = await run(`document.getElementById('lightbox').hidden`);
  check('Esc 先关预览、不收起窗口', afterEsc === true && lifecycle.hides === hidesBeforeEsc, { afterEsc, hides: lifecycle.hides });
  await run(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);
  check('列表状态按 Esc 才收起窗口', lifecycle.hides === hidesBeforeEsc + 1, lifecycle);
  await windowHost.show();
  await sleep(500);

  check('页面无新的运行时错误', consoleErrors.length === 0, consoleErrors.slice(0, 3));

  console.log(JSON.stringify({ results, failures }, null, 1));
  await store.close?.();
  app.exit(failures.length ? 1 : 0);
}).catch(error => { console.error('FAIL', error); app.exit(1); });
