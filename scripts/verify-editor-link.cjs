/* 单图编辑页「随时关联」的真实验收：真实 installImageEditorWindow + 真实 renderer/preload/IPC。
   窗口用 BrowserWindow 子类注入：show/focus/showInactive/restore 一律不真执行，只记账；
   并用原生 BrowserWindow.prototype.isVisible 断言底层始终不可见（不碰桌面、不抢焦点）。
   所有鼠标动作走 CDP Input.dispatchMouseEvent，输入走 Input.insertText（先聚焦、清空）；
   每步条件等待，失败即停并保留 trace；不手动 dispatch pointer，不屏蔽 setPointerCapture 异常。
   运行：node_modules\electron\dist\electron.exe scripts\verify-editor-link.cjs */
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
// 默认跑 3 遍，每遍都有 9s 级等待和独立 framePick 场景，正常耗时长于 layout，留 10 分钟。
const probeGuard = installProbeGuard({ name: 'verify-editor-link', timeoutMs: 10 * 60 * 1000 });
const results = [];
const failures = [];
const events = [];
// 本次定点诊断的时间轴（只看真实 toBlob/arrayBuffer 何时开始、何时回来），不改任何判定。
const copyDiagnostics = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures.push(name);
  return Boolean(ok);
};
const trace = (label, value) => { events.push({ label, value }); console.log(`TRACE ${label} ${JSON.stringify(value)}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const lifecycle = { show: 0, focus: 0, showInactive: 0, restore: 0 };
const commitLog = [];
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
// 原生可见性：绕过子类覆写，直接问底层 BrowserWindow。
const nativeVisible = win => BrowserWindow.prototype.isVisible.call(win);
const nativeShown = [];

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

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-editor-link-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

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

let sharedHost = null;
function ensureHost() {
  if (sharedHost) return sharedHost;
  sharedHost = installImageEditorWindow({
    BrowserWindow: HiddenWindow,
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
  return sharedHost;
}

async function runSuite(pass) {
  const host = ensureHost();
  const token = `verify-${Date.now()}-${pass}`;
  const png = makePng(480, 360);
  const opened = host.open({ token, width: 480, height: 360, rect: { x: 0, y: 0, width: 480, height: 360 } },
    { dataUrl: dataUrlOf(png) });
  const win = await waitUntil(async () => host.getWindow(token), { timeout: 9000, label: 'window' });
  if (!win) { host.dispose(); return { ok: false, reason: 'window' }; }
  nativeShown.push(nativeVisible(win));
  const run = code => win.webContents.executeJavaScript(code, true);
  // 页面所有级别 console 全收：旧的位置参数（_event, level, message）在 Electron 44 已废弃，
  // 别再拿“没捕获到 console”当“没有异常”；页面 error/unhandledrejection 另在下面装。
  const pageMessages = [];
  win.webContents.on('console-message', (...args) => {
    const [first, level, message] = args;
    const entry = first && typeof first === 'object' && 'message' in first
      ? { level: first.level, line: first.lineNumber, message: String(first.message || '') }
      : { level, line: undefined, message: String(message || '') };
    pageMessages.push({ at: Date.now(), level: entry.level, line: entry.line, message: entry.message.slice(0, 300) });
  });
  await waitUntil(() => run('Boolean(window.__imageEditorDebug)').catch(() => false), { timeout: 9000, label: 'page' });
  await opened;
  win.webContents.debugger.attach('1.3');
  // —— 定点诊断（只装在测试页上，不进生产、不改业务、不参与判定）——
  // toBlob / blob.arrayBuffer 只在原型层透明包装：照常调用原方法、把真实回调原样接回去，
  // 只额外记调用/回调时间与画布尺寸、Blob 大小；不模拟成功、不 setTimeout 手动回调、不绕真实导出。
  await run(`(() => {
    if (window.__copyDiag) return true;
    const now = () => Math.round(performance.now());
    const diag = window.__copyDiag = { createdAt: now(),
      visibility: [{ at: now(), state: document.visibilityState, hidden: document.hidden }],
      blobs: [], arrayBuffers: [], frames: [], idles: [], errors: [] };
    document.addEventListener('visibilitychange', () => diag.visibility.push({ at: now(),
      state: document.visibilityState, hidden: document.hidden }));
    window.addEventListener('error', event => diag.errors.push({ at: now(), kind: 'error',
      message: String((event && event.message) || event) }));
    window.addEventListener('unhandledrejection', event => { const reason = event && event.reason;
      diag.errors.push({ at: now(), kind: 'unhandledrejection',
        message: String((reason && (reason.message || reason)) || 'unknown') }); });
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      const entry = { id: diag.blobs.length, calledAt: now(), width: this.width, height: this.height,
        requestedType: type === undefined ? null : String(type), visibility: document.visibilityState,
        callbackAt: null, size: null, type: null, error: null };
      diag.blobs.push(entry);
      const wrapped = function (blob) {
        entry.callbackAt = now(); entry.size = blob ? blob.size : null; entry.type = blob ? blob.type : null;
        try { return callback.apply(this, arguments); }
        catch (error) { entry.error = String((error && (error.message || error)) || error);
          diag.errors.push({ at: entry.callbackAt, kind: 'toBlob-callback', message: entry.error }); throw error; }
      };
      try { return originalToBlob.call(this, wrapped, type, quality); }
      catch (error) { entry.error = String((error && (error.message || error)) || error);
        diag.errors.push({ at: now(), kind: 'toBlob-throw', message: entry.error }); throw error; }
    };
    const originalArrayBuffer = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      const entry = { calledAt: now(), size: this.size, doneAt: null, bytes: null, error: null };
      diag.arrayBuffers.push(entry);
      const pending = originalArrayBuffer.call(this);
      if (!pending || typeof pending.then !== 'function') return pending;
      return pending.then(buffer => { entry.doneAt = now(); entry.bytes = buffer.byteLength; return buffer; },
        error => { entry.doneAt = now(); entry.error = String((error && (error.message || error)) || error); throw error; });
    };
    window.__copyDiagFrame = label => { const entry = { label, scheduledAt: now(), firedAt: null };
      diag.frames.push(entry); requestAnimationFrame(() => { entry.firedAt = now(); }); return true; };
    window.__copyDiagIdle = label => { const entry = { label, scheduledAt: now(), firedAt: null };
      diag.idles.push(entry); requestIdleCallback(() => { entry.firedAt = now(); }, { timeout: 4000 }); return true; };
    return true;
  })()`);
  // 宿主侧事实：底层原生可见性、逻辑可见性、webContents 实际的 backgroundThrottling。
  const mainSideFacts = () => ({
    nativeVisible: nativeVisible(win), logicalVisible: win.isVisible(), minimized: win.isMinimized(),
    backgroundThrottling: typeof win.webContents.getBackgroundThrottling === 'function'
      ? win.webContents.getBackgroundThrottling() : 'unsupported',
    offscreen: typeof win.webContents.isOffscreen === 'function' ? win.webContents.isOffscreen() : 'n/a'
  });
  const copyDiagState = () => run(`(() => { const diag = window.__copyDiag; if (!diag) return null;
    return { at: Math.round(performance.now()), visibility: diag.visibility, blobs: diag.blobs,
      arrayBuffers: diag.arrayBuffers, frames: diag.frames, idles: diag.idles, errors: diag.errors }; })()`);
  const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
  const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent',
    { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra });
  const moveTo = async (x, y) => { await mouse('mouseMoved', x, y, { buttons: 0 }); };
  const clickAt = async (x, y) => {
    await mouse('mouseMoved', x, y, { buttons: 0 });
    await mouse('mousePressed', x, y, { buttons: 1 });
    await mouse('mouseReleased', x, y, { buttons: 0 });
  };
  const dragAt = async (from, to) => {
    await mouse('mouseMoved', from.x, from.y, { buttons: 0 });
    await mouse('mousePressed', from.x, from.y, { buttons: 1 });
    for (let step = 1; step <= 8; step += 1) {
      await mouse('mouseMoved', from.x + ((to.x - from.x) * step) / 8, from.y + ((to.y - from.y) * step) / 8, { buttons: 1 });
    }
    await mouse('mouseReleased', to.x, to.y, { buttons: 0 });
  };
  const pressEnter = async () => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };

  const probe = {
    center: sel => run(`(() => { const node = document.querySelector(${JSON.stringify(sel)});
      if (!node) return null; const r = node.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`),
    marker: (id, index = 0) => run(`(() => {
      const button = document.querySelector('.ie-marker[data-annotation-id="' + ${JSON.stringify(id)} + '"][data-target-index="' + ${index} + '"]')
        || document.querySelector('.ie-marker[data-annotation-id="' + ${JSON.stringify(id)} + '"]');
      if (!button) return null;
      const figure = button.closest('.ie-marker-figure');
      const ring = figure && figure.querySelector('.ie-marker-ring');
      const badge = button.getBoundingClientRect();
      const anchor = (ring || button).getBoundingClientRect();
      return { x: badge.left + badge.width / 2, y: badge.top + badge.height / 2,
        ringX: anchor.left + anchor.width / 2, ringY: anchor.top + anchor.height / 2 }; })()`),
    debug: () => run('__imageEditorDebug()'),
    focusAndClear: sel => run(`(() => { const node = document.querySelector(${JSON.stringify(sel)});
      if (!node) return false; node.focus(); node.select(); return document.activeElement === node; })()`),
    cropSize: () => run(`document.querySelector('.ie-crop-size')?.textContent || ''`),
    elementAt: (x, y) => run(`(() => { const node = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
      return node ? (node.className || node.tagName) : 'none'; })()`),
    status: () => run(`document.querySelector('.ie-status')?.textContent || ''`),
    cursor: () => run(`document.querySelector('.ie-scroll').style.cursor`),
    relationVisible: () => run(`!document.querySelector('.ie-relation-bubble').hidden`),
    scrollRect: () => run(`(() => { const r = document.querySelector('.ie-scroll').getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`)
  };

  const debug0 = await probe.debug();
  const scrollRect = await probe.scrollRect();
  const toClient = (x, y) => ({ x: scrollRect.left + debug0.origin.x + x, y: scrollRect.top + debug0.origin.y + y });
  // 画布上的 fillText 日志：证明关系中间标签真的画进了 canvas，不只是停在 DOM 输入框里。
  await run(`(() => { if (!window.__fillTextHook) { const proto = CanvasRenderingContext2D.prototype;
    const orig = proto.fillText;
    proto.fillText = function (text, ...rest) { (window.__fillTextLog = window.__fillTextLog || []).push(String(text));
      return orig.call(this, text, ...rest); };
    window.__fillTextHook = true; }
    window.__fillTextLog = []; return true; })()`);
  // 沿关系曲线读真实 canvas 像素：只等下一个完成帧，不靠滚动/缩放/拖动/取消选择补画。
  const curvePixels = async (points, predicate) => {
    if (!Array.isArray(points) || points.length < 2) return { hit: 0, total: 0 };
    const d = await probe.debug();
    return run(`(() => {
      const canvas = document.querySelector('.ie-display');
      const ctx = canvas.getContext('2d');
      const dpr = canvas.width / Math.max(1, document.querySelector('.ie-scroll').clientWidth);
      let hit = 0, total = 0;
      for (const p of ${JSON.stringify(points)}) {
        const x = Math.round((${d.origin.x} + p.x * ${d.zoom}) * dpr);
        const y = Math.round((${d.origin.y} + p.y * ${d.zoom}) * dpr);
        if (x < 1 || y < 1 || x >= canvas.width - 1 || y >= canvas.height - 1) continue;
        total += 1;
        const px = ctx.getImageData(x, y, 1, 1).data;
        if (${predicate}) hit += 1;
      }
      return { hit, total };
    })()`);
  };
  const DARK_LINE = 'px[0] < 130 && px[1] < 140 && px[2] < 130';
  const PINK_LINE = 'px[0] > 190 && px[1] > 110 && px[1] < 205 && px[2] > 140 && px[2] < 215';
  const nextFrame = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  const tool = async name => {
    const center = await probe.center(`[data-tool="${name}"]`);
    if (!center) throw new Error(`找不到工具 ${name}`);
    await clickAt(center.x, center.y);
    return waitUntil(async () => (await probe.debug()).tool === name, { label: `tool-${name}` });
  };
  const action = async selector => {
    const center = await probe.center(selector);
    if (!center) throw new Error(`找不到按钮 ${selector}`);
    await clickAt(center.x, center.y);
  };
  const fillText = async (selector, text) => {
    const focused = await probe.focusAndClear(selector);
    if (!focused) throw new Error(`无法聚焦 ${selector}`);
    await cdp('Input.insertText', { text });
  };

  // —— 段 0：先画真实笔迹 + 纯色遮盖，无批注时复制一份安全基线 ——
  await tool('pen');
  await dragAt(toClient(20, 20), toClient(150, 100));
  const penReady = await waitUntil(async () => { const d = await probe.debug(); return (d.paint || []).some(op => op.tool === 'pen') && d; }, { label: 'baseline-pen' });
  await tool('rect');
  await run(`(() => { const box = document.querySelector('[data-setting="fill"]');
    if (box) { box.checked = true; box.dispatchEvent(new Event('input', { bubbles: true })); }
    return Boolean(box && box.checked); })()`);
  await dragAt(toClient(300, 250), toClient(430, 340));
  const maskReady = await waitUntil(async () => { const d = await probe.debug(); return (d.paint || []).some(op => op.tool === 'rect' && op.fill) && d; }, { label: 'baseline-mask' });
  const baselinePaints = maskReady || penReady;
  const penBox = (() => {
    const stroke = baselinePaints && (baselinePaints.paint || []).find(op => op.tool === 'pen');
    if (!stroke || !stroke.points || !stroke.points.length) return undefined;
    const xs = stroke.points.map(point => point.x), ys = stroke.points.map(point => point.y);
    return { x1: Math.min(...xs) - 8, x2: Math.max(...xs) + 8, y1: Math.min(...ys) - 8, y2: Math.max(...ys) + 8 };
  })();
  const maskBox = (() => {
    const mask = baselinePaints && (baselinePaints.paint || []).find(op => op.tool === 'rect' && op.fill);
    return mask && mask.rect ? mask.rect : undefined;
  })();
  check(`第${pass}遍 基线前已画真实笔迹与遮盖`, Boolean(penBox) && Boolean(maskBox), { penBox, maskBox });
  const baselineBefore = commitLog.length;
  const pageConsole = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) pageConsole.push(String(message).slice(0, 200));
  });
  // 这是整轮里第一次走到真实 toBlob 出口：先挂一帧/一次空闲调度，再点真实「复制」。
  await run(`(() => { window.__copyDiagFrame('before-copy'); window.__copyDiagIdle('before-copy'); return true; })()`);
  const baselineCopyAt = Date.now();
  await action('[data-action="copy"]');
  const baselineCommit = await waitUntil(() => commitLog.length > baselineBefore && commitLog[commitLog.length - 1], { label: 'baseline-copy' });
  // 无论成败都留一份时间轴：真实 toBlob 何时被调用、回调何时（有没有）回来、arrayBuffer 何时完成。
  const copyDiagAtSettle = await copyDiagState().catch(() => null);
  const copyDiagRecord = { pass, tookMs: Date.now() - baselineCopyAt, committed: Boolean(baselineCommit),
    mainFacts: mainSideFacts(), atSettle: copyDiagAtSettle, late: null, reference: null, final: null };
  copyDiagnostics.push(copyDiagRecord);
  trace(`pass${pass}-copy-diag`, { tookMs: copyDiagRecord.tookMs, committed: copyDiagRecord.committed,
    mainFacts: copyDiagRecord.mainFacts, blobs: copyDiagAtSettle && copyDiagAtSettle.blobs,
    arrayBuffers: copyDiagAtSettle && copyDiagAtSettle.arrayBuffers,
    frames: copyDiagAtSettle && copyDiagAtSettle.frames, idles: copyDiagAtSettle && copyDiagAtSettle.idles,
    errors: copyDiagAtSettle && copyDiagAtSettle.errors });
  if (!baselineCommit) {
    // 只收固定字段：判断是点击没生效、导出卡住，还是页面时序问题。
    const snapshot = await probe.debug().catch(() => null);
    // 被动观察（不重试、不改判定）：判定已经落成失败，这里只补时间轴——真实回调会不会迟到。
    const realBlob = diag => (diag && (diag.blobs || []).find(entry => entry.width === 480 && entry.height === 360)) || null;
    const lateDiag = await waitUntil(async () => {
      const diag = await copyDiagState().catch(() => null);
      const blob = realBlob(diag);
      return blob && blob.callbackAt !== null ? diag : undefined;
    }, { timeout: 8000, interval: 200, label: 'baseline-copy-late-callback' });
    // 独立小 canvas 参考：只看这条页面里小画布 toBlob 能不能回来，不替代真实导出/像素对照。
    const reference = await run(`(async () => {
      const start = Math.round(performance.now());
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, 64, 64);
      return await new Promise(resolve => {
        let settled = false;
        const timer = setTimeout(() => { if (!settled) resolve({ callbackAt: null, waitedMs: Math.round(performance.now()) - start }); }, 2000);
        canvas.toBlob(blob => { if (!settled) { settled = true; clearTimeout(timer);
          resolve({ callbackAt: Math.round(performance.now()), waitedMs: Math.round(performance.now()) - start, size: blob ? blob.size : null, type: blob ? blob.type : null }); } }, 'image/png');
      });
    })()`).catch(error => ({ error: String(error && error.message || error) }));
    copyDiagRecord.late = { callbackArrived: Boolean(lateDiag), blob: realBlob(lateDiag || copyDiagAtSettle) };
    copyDiagRecord.reference = reference;
    copyDiagRecord.final = await copyDiagState().catch(() => null);
    trace(`pass${pass}-baseline-copy-late`, { late: copyDiagRecord.late, reference, final: copyDiagRecord.final,
      pageMessages: pageMessages.slice(0, 12) });
    trace(`pass${pass}-baseline-diagnose`, {
      status: await probe.status().catch(() => 'unreadable'),
      commits: commitLog.length,
      actions: commitLog.map(item => item.action),
      editor: snapshot && { busy: snapshot.busy, draft: snapshot.draft, editing: snapshot.editing,
        tool: snapshot.tool, preview: snapshot.preview, cursor: snapshot.cursor, ops: snapshot.ops,
        paint: (snapshot.paint || []).length },
      pageConsole: pageConsole.slice(0, 6),
      pageMessages: pageMessages.slice(0, 12),
      copyButton: await probe.center('[data-action="copy"]').then(Boolean).catch(() => false),
      hidden: await probe.center('[data-action="copy"]') ? 'button-present' : 'button-missing'
    });
  }
  const baselineBytes = baselineCommit && baselineCommit.edited && baselineCommit.edited.png;
  check(`第${pass}遍 拿到无批注的安全合成基线`, Boolean(baselineBytes), { commits: commitLog.length });
  if (!baselineBytes) { host.cleanup(token); return { ok: false, reason: 'baseline' }; }
  const baselineImage = nativeImage.createFromBuffer(Buffer.from(baselineBytes));
  const baselineSize = baselineImage.getSize();
  const baselineBitmap = baselineImage.toBitmap();
  const baselineBody = (x, y) => {
    const offset = (y * baselineSize.width + x) * 4;
    return [baselineBitmap[offset], baselineBitmap[offset + 1], baselineBitmap[offset + 2]];
  };
  check(`第${pass}遍 基线图宽度就是主图宽度且含下方说明区`,
    baselineSize.width === 480 && baselineSize.height >= 360, baselineSize);
  // 基线本身要真的和原图不同：笔迹区与遮盖区都要有变化，否则这条验收是空的。整幅扫，不抽样。
  let penProof = 0, maskProof = 0;
  for (let y = 0; y < 360; y += 1) {
    for (let x = 0; x < 480; x += 1) {
      const [r, g, b] = baselineBody(x, y);
      const differs = Math.abs(r - SOURCE_RGB[0]) > 2 || Math.abs(g - SOURCE_RGB[1]) > 2 || Math.abs(b - SOURCE_RGB[2]) > 2;
      if (!differs) continue;
      if (penBox && x >= penBox.x1 && x <= penBox.x2 && y >= penBox.y1 && y <= penBox.y2) penProof += 1;
      if (maskBox && x >= maskBox.x && x <= maskBox.x + maskBox.width && y >= maskBox.y && y <= maskBox.y + maskBox.height) maskProof += 1;
    }
  }
  check(`第${pass}遍 基线里确有笔迹像素`, penProof > 0, { penProof });
  check(`第${pass}遍 基线里遮盖确实盖住了原像素`, maskProof > 0, { maskProof });

  // —— 段 1：连续创建 点 + 框（落位即提交，说明区直接写）；选择工具分别命中 ——
  const selectedTargets = () => run('__imageEditorDebug().selectedTargets');
  await tool('point');
  const pointAt = toClient(120, 120);
  await clickAt(pointAt.x, pointAt.y);
  const pointCreated = await waitUntil(async () => { const d = await probe.debug(); return d.notes.length === 1 && d; }, { label: 'point-created' });
  if (!check(`第${pass}遍 点工具一次点击就落一个正式标记`, Boolean(pointCreated), pointCreated && pointCreated.notes)) { host.dispose(); return { ok: false, reason: 'point commit' }; }
  await fillText('.ie-bubble-text', 'A 点');
  // 真实输入里的 Ctrl+Z 属于文本框原生撤销，不应被编辑器历史抢走。
  {
    const cursorBefore = (await probe.debug()).cursor;
    await fillText('.ie-bubble-text', '临时字');
    const typedValue = await run(`document.querySelector('.ie-bubble-text').value`);
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 });
    await new Promise(resolve => setTimeout(resolve, 120));
    const afterUndo = await run(`document.querySelector('.ie-bubble-text').value`);
    const cursorAfter = (await probe.debug()).cursor;
    check(`第${pass}遍 文本框 Ctrl+Z 走原生撤销，不劫持编辑器历史`,
      typedValue === '临时字' && afterUndo !== typedValue && cursorAfter === cursorBefore,
      { typedValue, afterUndo, cursorBefore, cursorAfter });
    await fillText('.ie-bubble-text', 'A 点');
  }
  const afterPoint = await waitUntil(async () => { const d = await probe.debug(); return d.notes.length === 1 && d.notes[0].text === 'A 点' && d; }, { label: 'point-text' });
  if (!check(`第${pass}遍 点批注文字已写回`, Boolean(afterPoint), afterPoint && afterPoint.notes)) { host.dispose(); return { ok: false, reason: 'point text' }; }

  await tool('region');
  await dragAt(toClient(240, 180), toClient(360, 280));
  const regionCreated = await waitUntil(async () => { const d = await probe.debug(); return d.notes.length === 2 && d; }, { label: 'region-created' });
  if (!check(`第${pass}遍 框工具拖完就落正式标记`, Boolean(regionCreated))) { host.dispose(); return { ok: false, reason: 'region commit' }; }
  await fillText('.ie-bubble-text', 'B 框');
  const afterRegion = await waitUntil(async () => { const d = await probe.debug(); return d.notes.length === 2 && d.notes[1].text === 'B 框' && d; }, { label: 'region-text' });
  if (!check(`第${pass}遍 框批注文字已写回`, Boolean(afterRegion), afterRegion && afterRegion.notes)) { host.dispose(); return { ok: false, reason: 'region text' }; }
  const [noteA, noteB] = afterRegion.notes;
  check(`第${pass}遍 两条批注原文正确`, noteA.text === 'A 点' && noteB.text === 'B 框', [noteA.text, noteB.text]);

  await tool('select');
  const markerA = await probe.marker(noteA.id);
  await clickAt(markerA.x, markerA.y);
  const selectedA = await waitUntil(async () => { const d = await probe.debug(); return d.editing && d; }, { label: 'select-A' });
  check(`第${pass}遍 选择工具点已有点能选中`, Boolean(selectedA), selectedA && { editing: selectedA.editing, tool: selectedA.tool });
  const markerB = await probe.marker(noteB.id);
  await clickAt(markerB.x, markerB.y);
  const selectedB = await waitUntil(async () => { const d = await probe.debug(); return d.editing && d; }, { label: 'select-B' });
  check(`第${pass}遍 选择工具点已有框能选中`, Boolean(selectedB), selectedB && { editing: selectedB.editing });

  // —— 段 2：连线工具从 A 拖到 B（独立于像素直线），入历史并选中 ——
  const relationText = () => run(`document.querySelector('.ie-relation-text')?.value ?? ''`);
  const targetChips = () => run(`document.querySelectorAll('.ie-bubble-targets [data-action="target-remove"]').length`);
  const framesBeforeCreate = (await probe.debug()).frames;
  await tool('connect');
  const connectReady = await waitUntil(async () => { const d = await probe.debug(); return d.tool === 'connect' && d; }, { label: 'connect-tool' });
  check(`第${pass}遍 连线是独立工具，切过去后画布不再画点/框`, Boolean(connectReady), connectReady && { tool: connectReady.tool });
  const startA = { x: markerA.ringX, y: markerA.ringY };
  await dragAt(startA, toClient(300, 230));
  const relationMade = await waitUntil(async () => { const d = await probe.debug(); return d.relations.length === 1 && d.selectedRelationId && d; }, { label: 'relation-created' });
  const endKey = end => (end ? `${end.annotationId}::${end.targetId}` : null);
  const endsKey = value => [value.a, value.b].map(endKey).filter(Boolean).sort().join('|');
  const wantEnds = [noteA, noteB]
    .map(note => `${note.id}::${note.targets[0].targetId}`).sort().join('|');
  check(`第${pass}遍 建立关系时立即入历史，两端条目（批注+目标）都指原批注`,
    Boolean(relationMade) && endsKey(relationMade.relations[0]) === wantEnds,
    { got: relationMade && relationMade.relations, wantEnds });

  // —— 门禁 A：建立关联后紧接着的完成帧就得有线；不滚、不缩、不拖、不取消选择 ——
  {
    const curve = relationMade && relationMade.relations[0] && relationMade.relations[0].curve;
    await nextFrame();
    const afterCreate = await probe.debug();
    const pink = await curvePixels(curve, PINK_LINE);
    check(`第${pass}遍 建立关联后的第一个完成帧就画出选中关系线（不靠后续无关动作）`,
      afterCreate.frames > framesBeforeCreate && Boolean(curve) && pink.total >= 12 && pink.hit >= 8,
      { framesBeforeCreate, framesAfter: afterCreate.frames, curve: curve && curve.length, pink });
  }
  // 标签门禁的基线必须在触发输入之前取：写完字可能当场就把那一帧画完，事后再排一帧
  // 已经不能证明“这次输入画出来的”，所以先取帧数、先清日志，操作后只等自然帧。
  const framesBeforeLabel = (await probe.debug()).frames;
  await run('window.__fillTextLog = []');
  await fillText('.ie-relation-text', '这两处颜色一致');
  const relationTexted = await waitUntil(async () => { const d = await probe.debug(); return d.relations[0].text === '这两处颜色一致' && d; }, { label: 'relation-text' });
  check(`第${pass}遍 关系文字写回同一条 op（不拆新历史）`,
    Boolean(relationTexted) && relationTexted.notes.map(note => note.text).join('|') === 'A 点|B 框',
    relationTexted && relationTexted.relations);
  // 中间标签：输入写回后自然的那一帧就得把字画进 canvas（不是只存在 textarea 里）。
  const labelLog = await waitUntil(async () => {
    const lines = ((await run('window.__fillTextLog || []')) || []).join('');
    return lines.includes('这两处颜色一致') ? lines : undefined;
  }, { label: 'relation-label', timeout: 2500 });
  const framesAfterLabel = (await probe.debug()).frames;
  check(`第${pass}遍 关系中间标签画在画布上`,
    Boolean(labelLog) && framesAfterLabel > framesBeforeLabel,
    { framesBeforeLabel, framesAfterLabel, label: String(labelLog || '').slice(0, 40) });

  // 关系纯改字不加历史：撤销只退关系。
  {
    const before = await probe.debug();
    await action('[data-action="undo"]');
    const undone = await waitUntil(async () => { const d = await probe.debug(); return d.relations.length === 0 && d; }, { label: 'undo-relation' });
    check(`第${pass}遍 离开输入后第一次画布撤销只退关系，两端与原文都保留`,
      Boolean(undone) && undone.notes.length === 2 && undone.cursor === before.cursor - 1
        && undone.notes.map(note => note.text).join('|') === 'A 点|B 框',
      undone && { notes: undone.notes, cursor: undone.cursor, before: before.cursor });
    await action('[data-action="redo"]');
    const redone = await waitUntil(async () => { const d = await probe.debug(); return d.relations.length === 1 && d; }, { label: 'redo-relation' });
    check(`第${pass}遍 重做恢复同一对端点与关系文字`,
      Boolean(redone) && endsKey(redone.relations[0]) === wantEnds && redone.relations[0].text === '这两处颜色一致',
      redone && redone.relations);
  }

  // —— 门禁 A2：从这条批注的「更多」选回连线立即高亮、删线立即消失，都只看下一个完成帧 ——
  {
    const curve = (await probe.debug()).relations[0].curve;
    await nextFrame();
    const plain = await curvePixels(curve, DARK_LINE);
    check(`第${pass}遍 未选中时连线也在（墨色）`, plain.total >= 12 && plain.hit >= 8, plain);
    await tool('select');
    await clickAt(markerA.x, markerA.y);
    await waitUntil(async () => (await probe.debug()).editing, { label: 'reopen-A' });
    const more = await probe.center('[data-action="bubble-more-toggle"]');
    if (more) await clickAt(more.x, more.y);
    const relationItem = await probe.center('.ie-bubble-relations [data-action="bubble-relation"]');
    check(`第${pass}遍 批注「更多」里有可点的连线入口`, Boolean(relationItem), relationItem);
    if (relationItem) {
      await clickAt(relationItem.x, relationItem.y);
      await waitUntil(async () => (await probe.debug()).selectedRelationId, { label: 'relation-selected-from-more' });
      await nextFrame();
      const highlighted = await curvePixels(curve, PINK_LINE);
      check(`第${pass}遍 从批注「更多」选中后立即高亮（下一个完成帧）`, highlighted.hit >= 8, highlighted);
    }
    await action('[data-action="relation-delete"]');
    await waitUntil(async () => (await probe.debug()).relations.length === 0, { label: 'relation-removed' });
    await nextFrame();
    const gone = await curvePixels(curve, DARK_LINE);
    check(`第${pass}遍 移除关系后同一位置立即没有线（不留残影）`,
      plain.hit >= 8 && gone.hit * 3 < plain.hit, { plain, gone });
    await action('[data-action="undo"]');
    const restored = await waitUntil(async () => { const d = await probe.debug(); return d.relations.length === 1 && d; }, { label: 'relation-restored' });
    check(`第${pass}遍 撤销移除后关系回到原位置，供后续用例继续`, Boolean(restored), restored && restored.relations);
  }

  // 便签「更多」里的「＋位置（框）」：追加立即一次可撤销变更；撤销只退追加。
  {
    await clickAt(markerB.x, markerB.y);
    await waitUntil(async () => (await probe.debug()).editing, { label: 'append-open-B' });
    const more = await probe.center('[data-action="bubble-more-toggle"]');
    if (more) await clickAt(more.x, more.y);
    const addRegion = await probe.center('[data-action="bubble-add-region"]');
    if (addRegion) await clickAt(addRegion.x, addRegion.y);
    await dragAt(toClient(40, 300), toClient(160, 340));
    const appended = await waitUntil(async () => { const count = await targetChips(); return count === 2 ? count : undefined; }, { label: 'append-region' });
    check(`第${pass}遍 便签「更多」＋位置（框）追加成功`, appended === 2, { chips: await targetChips() });
    const cursorBeforeAppend = (await probe.debug()).cursor;
    await action('[data-action="undo"]');
    const rolledBack = await waitUntil(async () => { const count = await targetChips(); return count === 1 ? count : undefined; }, { label: 'append-undo' });
    const cursorAfterAppendUndo = (await probe.debug()).cursor;
    check(`第${pass}遍 追加也是一条正式可撤销变更（撤销只退追加）`,
      rolledBack === 1 && cursorAfterAppendUndo === cursorBeforeAppend - 1,
      { chips: rolledBack, cursor: cursorAfterAppendUndo, cursorBeforeAppend });
  }

  // 连线入口在便签里：从「更多」再选回关系。
  const relationListItem = await probe.center('.ie-bubble-relations [data-action="bubble-relation"]');
  check(`第${pass}遍 便签「更多」里有可点的连线入口`, Boolean(relationListItem), relationListItem);
  if (relationListItem) {
    await clickAt(relationListItem.x, relationListItem.y);
    const fromList = await waitUntil(async () => { const d = await probe.debug(); return d.selectedRelationId && d; }, { label: 'relation-from-more' });
    check(`第${pass}遍 从便签「更多」能选中连线并编辑文字`,
      Boolean(fromList) && (await relationText()) === '这两处颜色一致', fromList && fromList.relations);
  }


  // —— 段 3：退出说明编辑不删标记；关系与原文都保留 ——
  {
    for (let i = 0; i < 2; i += 1) {
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    }
    const idle = await waitUntil(async () => { const d = await probe.debug(); return !d.editing && !d.selectedRelationId && d; }, { label: 'leave-editing' });
    check(`第${pass}遍 退出编辑只放下选中，关系与两处标记都保留`,
      Boolean(idle) && idle.relations.length === 1 && idle.notes.length === 2,
      idle && { relations: idle.relations, notes: idle.notes.length });
  }

  // —— 段 4：有批注/关系时再复制：主图与安全基线逐像素完整 RGBA 比较（不排除笔迹/遮盖）——
  const beforeFinal = commitLog.length;
  await action('[data-action="copy"]');
  const finalCommit = await waitUntil(() => commitLog.length > beforeFinal && commitLog[commitLog.length - 1], { label: 'final-copy', timeout: 6000 });
  // 只加诊断、不改门禁：这次复制没回来时，把当时的状态与时间轴一并留下。
  if (!finalCommit) {
    trace(`pass${pass}-final-copy-stall`, {
      status: await probe.status().catch(() => 'unreadable'),
      snapshot: await probe.debug().catch(() => null),
      copyButton: await run(`(() => { const n = document.querySelector('[data-action="copy"]');
        return n ? { disabled: n.disabled, hidden: n.hidden } : null; })()`).catch(() => null),
      commits: commitLog.map(item => ({ action: item.action, bytes: item.edited && item.edited.png ? item.edited.png.length : 0 })),
      pageMessages: pageMessages.slice(0, 8), pageConsole: pageConsole.slice(0, 8)
    });
  }
  const finalBytes = finalCommit && finalCommit.edited && finalCommit.edited.png;
  check(`第${pass}遍 有批注时复制出口出图`, Boolean(finalBytes), { commits: commitLog.length });
  // 不重试、不改判定：门禁已经落成失败；这里只把迟到的同一个 commit 等回来做像素对照，并单独记一条迟到项。
  let lateFinal = null;
  if (!finalBytes) {
    lateFinal = await waitUntil(() => commitLog.length > beforeFinal && commitLog[commitLog.length - 1],
      { label: 'final-copy-late', timeout: 25000, interval: 250 });
    trace(`pass${pass}-final-copy-late`, { arrived: Boolean(lateFinal),
      bytes: lateFinal && lateFinal.edited && lateFinal.edited.png ? lateFinal.edited.png.length : 0 });
  }
  const finalBytesUsable = finalBytes || (lateFinal && lateFinal.edited && lateFinal.edited.png);
  if (finalBytesUsable) {
    const finalImage = nativeImage.createFromBuffer(Buffer.from(finalBytesUsable));
    const finalSize = finalImage.getSize();
    const finalBitmap = finalImage.toBitmap();
    let samples = 0, mismatches = 0;
    const bad = [];
    const areaWidth = Math.min(480, finalSize.width, baselineSize.width);
    const areaHeight = Math.min(360, finalSize.height, baselineSize.height);
    for (let y = 0; y < areaHeight; y += 1) {
      for (let x = 0; x < areaWidth; x += 1) {
        const offset = (y * finalSize.width + x) * 4;
        const [r, g, b, a] = [finalBitmap[offset], finalBitmap[offset + 1], finalBitmap[offset + 2], finalBitmap[offset + 3]];
        const [br, bg, bb, ba] = [baselineBitmap[(y * baselineSize.width + x) * 4], baselineBitmap[(y * baselineSize.width + x) * 4 + 1],
          baselineBitmap[(y * baselineSize.width + x) * 4 + 2], baselineBitmap[(y * baselineSize.width + x) * 4 + 3]];
        samples += 1;
        if (r !== br || g !== bg || b !== bb || a !== ba) {
          mismatches += 1;
          if (bad.length < 5) bad.push({ x, y, got: [r, g, b, a], want: [br, bg, bb, ba] });
        }
      }
    }
    check(`第${pass}遍 主图区域RGBA逐像素完整一致（0..w×0..h，含笔迹/遮盖区）`,
      areaWidth === 480 && areaHeight === 360 && samples === 480 * 360 && mismatches === 0,
      { samples, mismatches, areaWidth, areaHeight, size: finalSize, baselineSize, bad });
    check(`第${pass}遍 复制图仍带下方说明区`, finalSize.height > 360, finalSize);
  }

  // —— 关系线可见性：直接读真实 canvas 像素（隐藏窗口的 capturePage 不支持做帧差分，已改为画布取样）——
  // 沿 relationCurvePoints 的几何逐点取样，比“两帧差分”更能说明线就在那个位置。
  const sampleCurve = async points => {
    const d = await probe.debug();
    await run('new Promise(resolve => requestAnimationFrame(() => resolve(true)))');
    return run(`(() => {
      const canvas = document.querySelector('.ie-display');
      const ctx = canvas.getContext('2d');
      const dpr = canvas.width / Math.max(1, document.querySelector('.ie-scroll').clientWidth);
      const points = ${JSON.stringify(points)};
      let dark = 0, light = 0, total = 0;
      for (const p of points) {
        const x = Math.round((${d.origin.x} + p.x * ${d.zoom}) * dpr);
        const y = Math.round((${d.origin.y} + p.y * ${d.zoom}) * dpr);
        if (x < 1 || y < 1 || x >= canvas.width - 1 || y >= canvas.height - 1) continue;
        total += 1;
        const px = ctx.getImageData(x, y, 1, 1).data;
        if (px[0] < 130 && px[1] < 140 && px[2] < 130) dark += 1; else light += 1;
      }
      return { total, dark, light, width: canvas.width, height: canvas.height, dpr };
    })()`);
  };
  await clickAt(markerA.x, markerA.y);
  await waitUntil(async () => (await probe.debug()).editing, { label: 'reopen-A-before-copy-2' });
  for (let i = 0; i < 2; i += 1) {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }
  await waitUntil(async () => !(await probe.debug()).editing, { label: 'close-before-line' });
  const debugWithLine = await probe.debug();
  const curvePoints = debugWithLine.relations[0] && debugWithLine.relations[0].curve;
  check(`第${pass}遍 关系曲线几何可用（两点以上）`, Boolean(curvePoints) && curvePoints.length > 2, curvePoints && curvePoints.length);
  const withLine = curvePoints ? await sampleCurve(curvePoints) : { total: 0, dark: 0 };
  await action('[data-action="undo"]');
  await waitUntil(async () => (await probe.debug()).relations.length === 0, { label: 'undo-for-line' });
  const withoutLine = curvePoints ? await sampleCurve(curvePoints) : { total: 0, dark: 0 };
  await action('[data-action="redo"]');
  await waitUntil(async () => (await probe.debug()).relations.length === 1, { label: 'redo-for-line' });
  const withLine2 = curvePoints ? await sampleCurve(curvePoints) : { total: 0, dark: 0 };
  trace(`pass${pass}-relation-line`, { withLine, withoutLine, withLine2 });
  check(`第${pass}遍 关系线上的画布像素确实被画上（线可见）`,
    withLine.total >= 12 && withLine.dark >= 8 && withLine.dark > withLine.total / 2, { withLine });
  check(`第${pass}遍 撤销后同一位置关系线消失（不被其他东西冒充）`,
    withoutLine.dark * 3 < withLine.dark, { withLine, withoutLine });
  check(`第${pass}遍 重做后关系线又回到同一位置`, withLine2.dark >= 8, { withLine2 });

  // —— 裁切：真实裁掉一整处（B 框 240..360 × 180..280 与 200×160 零交集），再验两种导出语义 ——
  const cropTo = async (width, height) => {
    await tool('crop');
    const live = await probe.debug();
    const bounds = await probe.scrollRect();
    const view = live.view;
    const to = (x, y) => ({ x: bounds.left + live.origin.x + x * live.zoom,
      y: bounds.top + live.origin.y + y * live.zoom });
    const from = to(view.x + view.width, view.y + view.height);
    const traceInfo = { tool: live.tool, zoom: live.zoom, origin: live.origin, view, bounds, from,
      at: await probe.elementAt(from.x, from.y), size: await probe.cropSize() };
    trace(`pass${pass}-crop-live`, traceInfo);
    check(`第${pass}遍 进裁切后按实时坐标取到右下句柄`, live.tool === 'crop' && Boolean(from), traceInfo);
    await dragAt(from, to(view.x + width, view.y + height));
    const afterDrag = await probe.cropSize();
    trace(`pass${pass}-crop-after-drag`, { size: afterDrag, expect: `${width} × ${height}` });
    check(`第${pass}遍 拖右下句柄把裁切收成 ${width}×${height}`, afterDrag.includes(`${width} × ${height}`), afterDrag);
    await action('[data-action="crop-apply"]');
    return waitUntil(async () => { const d = await probe.debug(); return d.view.width === width && !d.busy && d; },
      { label: 'crop-applied', timeout: 3000 });
  };

  const cropped = await cropTo(200, 160);
  check(`第${pass}遍 裁到 200×160`, Boolean(cropped), cropped && cropped.view);
  if (!cropped) { host.dispose(); return { ok: false, reason: 'crop' }; }
  check(`第${pass}遍 被整块裁掉的 B 已从批注列表消失`,
    cropped.notes.length === 1 && cropped.notes[0].text === 'A 点', cropped.notes);
  const liveEnds = [cropped.relations[0].a, cropped.relations[0].b].map(endKey).filter(Boolean);
  check(`第${pass}遍 关系标为不完整，幸存的一端仍指原批注、被裁掉的一端为空（不把 B 冒成 A）`,
    cropped.relations[0].complete === false && liveEnds.length === 1
      && liveEnds[0] === `${noteA.id}::${noteA.targets[0].targetId}`, cropped.relations);

  // A 自己有正文：缺端不禁止成图，但说明区必须写清另一端不在画面，且不能伪造它的坐标。
  await run(`(() => { if (!window.__fillTextHook) { const proto = CanvasRenderingContext2D.prototype;
    const orig = proto.fillText;
    proto.fillText = function (text, ...rest) { (window.__fillTextLog = window.__fillTextLog || []).push(String(text));
      return orig.call(this, text, ...rest); };
    window.__fillTextHook = true; } window.__fillTextLog = []; return true; })()`);
  const beforeCopy = commitLog.length;
  await action('[data-action="copy"]');
  const copyCommit = await waitUntil(() => commitLog.length > beforeCopy && commitLog[commitLog.length - 1],
    { label: 'crop-copy', timeout: 6000 });
  const copyIdle = await waitUntil(async () => { const d = await probe.debug(); return !d.busy && d; },
    { label: 'copy-idle', timeout: 6000 });
  const descLines = (await run('window.__fillTextLog || []')) || [];
  // 说明区按字格换行，同一句话可能被拆成多次 fillText，拼回去再断言。
  const descText = descLines.join('');
  trace(`pass${pass}-crop-copy`, { commits: commitLog.length, desc: descLines.slice(0, 12) });
  check(`第${pass}遍 缺一端时仍允许成图（A 自己有正文）`,
    Boolean(copyCommit && copyCommit.edited && copyCommit.edited.png) && Boolean(copyIdle), { commits: commitLog.length });
  check(`第${pass}遍 说明区写明另一端不在当前画面、未画线`,
    /另一端不在当前画面，未画线/.test(descText), descLines.slice(0, 12));
  check(`第${pass}遍 说明区没有给被裁掉的一端伪造框坐标`, !/框 \(/.test(descText),
    descLines.filter(line => /框 \(/.test(line)));

  // 异步出口结束后再撤销：先等 busy 落、拿到新 commit，再点撤销，并核对 cursor/ops/view。
  const beforeUndo = await probe.debug();
  await action('[data-action="undo"]');
  const restoredCrop = await waitUntil(async () => { const d = await probe.debug(); return d.view.width === 480 && !d.busy && d; },
    { label: 'crop-undo', timeout: 3000 });
  const afterUndoDebug = await probe.debug();
  trace(`pass${pass}-crop-undo`, { before: { cursor: beforeUndo.cursor, ops: beforeUndo.ops, view: beforeUndo.view },
    after: { cursor: afterUndoDebug.cursor, ops: afterUndoDebug.ops, view: afterUndoDebug.view } });
  check(`第${pass}遍 撤销只回退裁切这一条（复制不进历史）`,
    Boolean(restoredCrop) && beforeUndo.cursor - afterUndoDebug.cursor === 1 && beforeUndo.ops === afterUndoDebug.ops,
    { before: beforeUndo.cursor, after: afterUndoDebug.cursor, opsBefore: beforeUndo.ops, opsAfter: afterUndoDebug.ops });
  check(`第${pass}遍 撤销裁切后两端条目与完整状态恢复`,
    Boolean(restoredCrop) && afterUndoDebug.notes.length === 2 && afterUndoDebug.relations[0].complete === true
      && endsKey(afterUndoDebug.relations[0]) === wantEnds, { notes: afterUndoDebug.notes, relations: afterUndoDebug.relations });

  // 第二个 fixture：两处都空、只有一条共同关系说明；裁掉一端后空的那处失去覆盖，必须拦成品。
  const liveNow = await probe.debug();
  const rectNow = await probe.scrollRect();
  const toClientNow = (x, y) => ({ x: rectNow.left + liveNow.origin.x + x * liveNow.zoom,
    y: rectNow.top + liveNow.origin.y + y * liveNow.zoom });
  await tool('point');
  const emptyPoint = toClientNow(60, 60);
  await clickAt(emptyPoint.x, emptyPoint.y);
  const afterEmptyA = await waitUntil(async () => { const d = await probe.debug(); return d.notes.length === 3 && d; },
    { label: 'empty-a', timeout: 4000 });
  await tool('region');
  await dragAt(toClientNow(300, 200), toClientNow(420, 320));
  const afterEmptyB = await waitUntil(async () => { const d = await probe.debug(); return d.notes.length === 4 && d; },
    { label: 'empty-b', timeout: 4000 });
  check(`第${pass}遍 两处空目标都能落位（不逼填假字）`,
    Boolean(afterEmptyB) && afterEmptyB.notes.slice(2).every(note => note.text === ''), afterEmptyB && afterEmptyB.notes);
  if (!afterEmptyB) { host.dispose(); return { ok: false, reason: 'empty notes' }; }

  const [emptyNoteA, emptyNoteB] = afterEmptyB.notes.slice(2);
  await tool('connect');
  await dragAt(toClientNow(60, 60), toClientNow(360, 260));
  await waitUntil(async () => { const d = await probe.debug(); return d.relations.length === 2 && d; }, { label: 'empty-relation', timeout: 4000 });
  await fillText('.ie-relation-text', '这两处是同一面墙');
  const twoRelations = await waitUntil(async () => { const d = await probe.debug();
    return d.relations.length === 2 && d.relations.every(relation => relation.text.trim()) && d; }, { label: 'empty-relation-text', timeout: 4000 });
  check(`第${pass}遍 两端都在时，一句共同关系说明就够（空目标不被逼写假字）`,
    Boolean(twoRelations) && twoRelations.relations.every(relation => relation.complete === true), twoRelations && twoRelations.relations);

  // 退出说明编辑（不删标记）。
  for (let i = 0; i < 2; i += 1) {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }
  await waitUntil(async () => { const d = await probe.debug(); return !d.editing && !d.selectedRelationId; }, { label: 'close-before-second-crop' });
  const cropped2 = await cropTo(200, 160);
  check(`第${pass}遍 第二次裁切成功`, Boolean(cropped2), cropped2 && cropped2.view);
  if (cropped2) {
    check(`第${pass}遍 裁掉互连的一端后两条关系都不完整`,
      cropped2.relations.length === 2 && cropped2.relations.every(relation => relation.complete === false), cropped2.relations);
    const beforeBlocked = commitLog.length;
    await action('[data-action="copy"]');
    const blockedStatus = await waitUntil(async () => { const text = await probe.status();
      return /既没正文|覆盖/.test(text) ? text : undefined; }, { label: 'blocked-status', timeout: 3000 });
    check(`第${pass}遍 空目标失去有效关系覆盖时拦住成品并点名`,
      commitLog.length === beforeBlocked && Boolean(blockedStatus)
        && /第 2 条的/.test(blockedStatus) && /关系1|关系2/.test(blockedStatus),
      { commits: commitLog.length, status: blockedStatus || (await probe.status()) });
  }

  // —— 隐藏验收：原生可见性 ——
  check(`第${pass}遍 窗口底层始终不可见`, nativeVisible(win) === false, { nativeVisible: nativeVisible(win), lifecycle: { ...lifecycle } });
  host.cleanup(token);
  return { ok: true };
}

// —— 真实 CDP 独立场景：先选外框，再点框内的点 / 框（回归 B 的现场）——
// 用自己的合成文档（新 token 的 480×360 纯色图）：外框包住一个点和一个更小的框。
// 每次点击先只按下、读一次 debug.drag：正确行为是“选中目标”，绝不能是开始 frame-move；
// 再看选中的目标、多选数量、几何与历史有没有被拖框改掉。
async function runFramePickSuite() {
  const failedBefore = failures.length;
  const host = ensureHost();
  const token = `verify-frame-pick-${Date.now()}`;
  const opened = host.open({ token, width: 480, height: 360, rect: { x: 0, y: 0, width: 480, height: 360 } },
    { dataUrl: dataUrlOf(makePng(480, 360)) });
  const win = await waitUntil(async () => host.getWindow(token), { timeout: 9000, label: 'frame-pick-window' });
  if (!win) { host.dispose(); return { ok: false, reason: 'window' }; }
  nativeShown.push(nativeVisible(win));
  const run = code => win.webContents.executeJavaScript(code, true);
  await waitUntil(() => run('Boolean(window.__imageEditorDebug)').catch(() => false), { timeout: 9000, label: 'frame-pick-page' });
  await opened;
  win.webContents.debugger.attach('1.3');
  const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
  const mouse = (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent',
    { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra });
  const clickAt = async (x, y, modifiers = 0) => {
    await mouse('mouseMoved', x, y, { buttons: 0, modifiers });
    await mouse('mousePressed', x, y, { buttons: 1, modifiers });
    await mouse('mouseReleased', x, y, { buttons: 0, modifiers });
  };
  const dragAt = async (from, to) => {
    await mouse('mouseMoved', from.x, from.y, { buttons: 0 });
    await mouse('mousePressed', from.x, from.y, { buttons: 1 });
    for (let step = 1; step <= 8; step += 1) {
      await mouse('mouseMoved', from.x + ((to.x - from.x) * step) / 8, from.y + ((to.y - from.y) * step) / 8, { buttons: 1 });
    }
    await mouse('mouseReleased', to.x, to.y, { buttons: 0 });
  };
  const escapeOnce = async () => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  };
  const probe = {
    debug: () => run('__imageEditorDebug()'),
    center: sel => run(`(() => { const node = document.querySelector(${JSON.stringify(sel)});
      if (!node) return null; const r = node.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`),
    marker: id => run(`(() => { const button = document.querySelector('.ie-marker[data-annotation-id="' + ${JSON.stringify(id)} + '"]');
      if (!button) return null; const figure = button.closest('.ie-marker-figure');
      const ring = figure && figure.querySelector('.ie-marker-ring');
      const badge = button.getBoundingClientRect(); const anchor = (ring || button).getBoundingClientRect();
      return { x: badge.left + badge.width / 2, y: badge.top + badge.height / 2,
        ringX: anchor.left + anchor.width / 2, ringY: anchor.top + anchor.height / 2 }; })()`),
    elementAt: (x, y) => run(`(() => { const node = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
      return node ? (node.className || node.tagName) : 'none'; })()`),
    status: () => run(`document.querySelector('.ie-status')?.textContent || ''`),
    scrollRect: () => run(`(() => { const r = document.querySelector('.ie-scroll').getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`),
    selection: () => run(`(() => { const connect = __imageEditorDebug().connect;
      return { active: Boolean(connect), phase: connect ? connect.phase : null }; })()`)
  };
  // 源图坐标 → 客户端坐标：每次读当前 origin/zoom，不受前面的动作影响。
  const at = async (x, y) => {
    const d = await probe.debug(), rect = await probe.scrollRect();
    return { x: rect.left + d.origin.x + x * d.zoom, y: rect.top + d.origin.y + y * d.zoom };
  };
  const tool = async name => {
    const center = await probe.center(`[data-tool="${name}"]`);
    if (!center) throw new Error(`找不到工具 ${name}`);
    await clickAt(center.x, center.y);
    return waitUntil(async () => (await probe.debug()).tool === name, { label: `frame-pick-tool-${name}` });
  };
  // 选择态 + 几何/历史指纹：paint 里就是批注矩形，view/origin/zoom 是画面几何。
  const shape = async () => {
    const d = await probe.debug();
    return { selected: d.selectedTargets, drag: d.drag ?? null, editing: d.editing, connect: d.connect,
      cursor: d.cursor, ops: d.ops,
      frame: JSON.stringify({ paint: d.paint, view: d.view, origin: d.origin, zoom: d.zoom }) };
  };
  const keyOf = list => list.map(end => `${end.annotationId}::${end.targetId}`).sort().join('|');
  // 只按下、读一次、再松手：拖框一旦接手，这里就会看到 drag=frame-move。
  const pressProbe = async (spot, modifiers = 0) => {
    await mouse('mouseMoved', spot.x, spot.y, { buttons: 0, modifiers });
    await mouse('mousePressed', spot.x, spot.y, { buttons: 1, modifiers });
    const held = await probe.debug();
    await mouse('mouseReleased', spot.x, spot.y, { buttons: 0, modifiers });
    const after = await probe.debug();
    return { dragAtPress: held.drag ?? null, selected: after.selectedTargets, editing: after.editing };
  };
  // 一次 Esc 只能收口一次：已经没有选中就不再按（再按会向宿主请求关窗）。
  const clearSelection = async label => {
    const before = await probe.debug();
    if (before.noteId || before.selectedRelationId || before.selectedTargets.length) {
      await escapeOnce();
      await waitUntil(async () => { const d = await probe.debug(); return !d.editing && !d.selectedTargets.length; },
        { label: `frame-pick-clear-${label}` });
    }
    const after = await probe.debug();
    return !after.editing && after.selectedTargets.length === 0;
  };

  // —— 合成现场：外框 (60,60)-(400,300) 包住框内点 (180,180) 与更小的内框 (255,150)-(345,240) ——
  await tool('region');
  await dragAt(await at(60, 60), await at(400, 300));
  const madeOuter = await waitUntil(async () => { const d = await probe.debug(); return d.notes.length === 1 && d; },
    { label: 'frame-pick-outer', timeout: 4000 });
  const outerCleared = await clearSelection('outer');
  await tool('point');
  const firstPointSpot = await at(180, 180);
  await clickAt(firstPointSpot.x, firstPointSpot.y);
  const madePoint = await waitUntil(async () => { const d = await probe.debug(); return d.notes.length === 2 && d; },
    { label: 'frame-pick-point', timeout: 4000 });
  const pointCleared = await clearSelection('point');
  await tool('region');
  await dragAt(await at(255, 150), await at(345, 240));
  const madeInner = await waitUntil(async () => { const d = await probe.debug(); return d.notes.length === 3 && d; },
    { label: 'frame-pick-inner', timeout: 4000 });
  const innerCleared = await clearSelection('inner');
  await tool('select');
  check('框内选点场景：外框、框内点、框内小框都落位并已放下选中',
    Boolean(madeOuter && madePoint && madeInner) && outerCleared && pointCleared && innerCleared,
    madeInner && { notes: madeInner.notes, outerCleared, pointCleared, innerCleared });
  if (!madeInner || !outerCleared || !pointCleared || !innerCleared) { host.cleanup(token); return { ok: false, reason: 'scene' }; }
  trace('frame-pick-scene', { tool: (await probe.debug()).tool });
  const ground = await probe.debug();
  const [outer, pointNote, inner] = ground.notes;
  const outerEnd = `${outer.id}::${outer.targets[0].targetId}`;
  const pointEnd = `${pointNote.id}::${pointNote.targets[0].targetId}`;
  const innerEnd = `${inner.id}::${inner.targets[0].targetId}`;
  const rects = (ground.paint || []).filter(op => op.rect).map(op => op.rect);
  const hasRect = (x, y, width, height) => rects.some(rect => Math.abs(rect.x - x) <= 2
    && Math.abs(rect.y - y) <= 2 && Math.abs(rect.width - width) <= 2 && Math.abs(rect.height - height) <= 2);
  check('框内选点场景：外框与内框几何就是拖出来的那两个框（点与内框都在外框里）',
    hasRect(60, 60, 340, 240) && hasRect(255, 150, 90, 90), rects);
  // 框内点的真实屏幕位置：读它自己的标记圈中心（圈就画在落点上），每次点之前现算，
  // 不缓存前面的坐标——面板/滚动一变，同一对客户端坐标就不是同一个源图点了。
  const pointSpot = async () => {
    const marker = await probe.marker(pointNote.id);
    return marker && marker.ringX != null ? { x: marker.ringX, y: marker.ringY } : at(180, 180);
  };
  trace('frame-pick-point-spot', { ring: await pointSpot(), byCoord: await at(180, 180) });

  // —— 先选外框：点它的编号（真实 DOM 点击），外框成为可拖动/可缩放的当前框 ——
  const beforePick = await shape();
  const markerOuter = await probe.marker(outer.id);
  await clickAt(markerOuter.x, markerOuter.y);
  const selectedOuter = await waitUntil(async () => { const d = await probe.debug();
    return d.editing && d.selectedTargets.length === 1 && d.selectedTargets[0].annotationId === outer.id ? d : undefined; },
    { label: 'frame-pick-select-outer' });
  check('先选外框：编号点击把外框选成当前框（可拖动状态）', Boolean(selectedOuter), selectedOuter && selectedOuter.selectedTargets);
  trace('frame-pick-outer-selected', selectedOuter && selectedOuter.selectedTargets);

  // —— 普通点击框内点：必须选中那个点，不能变成拖外框 ——
  const plainSpot = await pointSpot();
  const onCanvas = await probe.elementAt(plainSpot.x, plainSpot.y);
  const plain = await pressProbe(plainSpot);
  check('先选外框后普通点击框内点：按住时没有开始 frame-move',
    Boolean(selectedOuter) && plain.dragAtPress === null, { dragAtPress: plain.dragAtPress, at: onCanvas });
  const pickedPoint = await waitUntil(async () => { const d = await probe.debug();
    return d.selectedTargets.length === 1 && keyOf(d.selectedTargets) === pointEnd && d; }, { label: 'frame-pick-pick-point' });
  check('先选外框后普通点击框内点：选中的是那个点，不是外框',
    Boolean(pickedPoint) && keyOf(pickedPoint.selectedTargets) === pointEnd, pickedPoint && pickedPoint.selectedTargets);
  const afterPlain = await shape();
  check('普通点击框内点不动几何与历史（外框没被拖走）',
    afterPlain.cursor === beforePick.cursor && afterPlain.ops === beforePick.ops && afterPlain.frame === beforePick.frame,
    { cursor: [beforePick.cursor, afterPlain.cursor], ops: [beforePick.ops, afterPlain.ops] });

  // —— Shift 点击框内点：现在是普通替换选择（多选开关已撤），仍不拖框 ——
  await clickAt(markerOuter.x, markerOuter.y);
  await waitUntil(async () => { const d = await probe.debug();
    return d.selectedTargets.length === 1 && d.selectedTargets[0].annotationId === outer.id; }, { label: 'frame-pick-reselect-outer' });
  const shift = await pressProbe(await pointSpot(), 8);
  check('先选外框后 Shift 点击框内点：按住时没有开始 frame-move', shift.dragAtPress === null, { dragAtPress: shift.dragAtPress });
  const single = await waitUntil(async () => { const d = await probe.debug();
    return d.selectedTargets.length === 1 && keyOf(d.selectedTargets) === pointEnd && d; }, { label: 'frame-pick-shift-single' });
  check('Shift 点击框内点：单选到那个点（不再靠 Shift 拼两处）',
    Boolean(single) && keyOf(single.selectedTargets) === pointEnd, single && single.selectedTargets);
  const afterShift = await shape();
  check('Shift 点击框内点后几何与历史不变',
    afterShift.cursor === beforePick.cursor && afterShift.ops === beforePick.ops && afterShift.frame === beforePick.frame,
    { cursor: [beforePick.cursor, afterShift.cursor] });

  // —— 连线工具里点框/点：只当连线起点，不拖当前框、不新建批注 ——
  await clickAt(markerOuter.x, markerOuter.y);
  await waitUntil(async () => { const d = await probe.debug();
    return d.selectedTargets.length === 1 && d.selectedTargets[0].annotationId === outer.id; }, { label: 'frame-pick-reselect-outer-2' });
  await tool('connect');
  const connectSpot = await pointSpot();
  const onCanvasConnect = await probe.elementAt(connectSpot.x, connectSpot.y);
  const gStart = await pressProbe(connectSpot);
  check('连线工具里按框内已有点：按住时没有开始 frame-move',
    gStart.dragAtPress === null, { dragAtPress: gStart.dragAtPress, at: onCanvasConnect });
  const armed = await waitUntil(async () => { const d = await probe.debug();
    return d.connect && d.connect.phase === 'armed' && d; }, { label: 'frame-pick-connect-armed' });
  check('连线工具第一击只记起点、等第二击，不新建批注也不写历史',
    Boolean(armed) && armed.notes.length === 3 && armed.ops === beforePick.ops, armed && { notes: armed.notes.length, ops: armed.ops });
  const gesture = await probe.selection();
  check('连线暂态在画布上可见（等第二击）', gesture.active === true && gesture.phase === 'armed', gesture);
  const afterConnectPick = await shape();
  check('连线点选没动几何与历史',
    afterConnectPick.cursor === beforePick.cursor && afterConnectPick.ops === beforePick.ops && afterConnectPick.frame === beforePick.frame,
    { cursor: [beforePick.cursor, afterConnectPick.cursor], ops: [beforePick.ops, afterConnectPick.ops] });
  await escapeOnce();
  const cleared = await waitUntil(async () => { const d = await probe.debug(); return d.connect === null && d; }, { label: 'frame-pick-connect-esc' });
  check('连线中 Esc 只取消手势，不删任何批注',
    Boolean(cleared) && cleared.notes.length === 3 && cleared.ops === beforePick.ops, cleared && { notes: cleared.notes.length });

  check('框内选点场景窗口底层始终不可见', nativeVisible(win) === false, { nativeVisible: nativeVisible(win) });
  host.cleanup(token);
  return { ok: failures.length === failedBefore, failed: failures.slice(failedBefore) };
}

app.whenReady().then(async () => {
  const minimal = new HiddenWindow({ width: 600, height: 400, frame: false,
    webPreferences: { contextIsolation: false, sandbox: false } });
  await minimal.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><body style="margin:0">
    <div id="pad" style="position:absolute;inset:0;background:#eef"></div>
    <script>window.__log=[];const pad=document.getElementById('pad');
      for (const type of ['pointerdown','pointerup']) pad.addEventListener(type, event => {
        let captured='n/a'; if (type==='pointerdown') { try { pad.setPointerCapture(event.pointerId); captured='ok'; }
        catch (error) { captured='throw:'+error.name; } }
        window.__log.push({ type, isTrusted:event.isTrusted, pointerId:event.pointerId, isPrimary:event.isPrimary,
          buttons:event.buttons, captured });
      });
    </script></body>`));
  minimal.webContents.debugger.attach('1.3');
  const mSend = (type, x, y, extra = {}) => minimal.webContents.debugger.sendCommand('Input.dispatchMouseEvent',
    { type, x, y, button: 'left', clickCount: 1, ...extra });
  await mSend('mouseMoved', 80, 80, { buttons: 0 });
  await mSend('mousePressed', 80, 80, { buttons: 1 });
  await mSend('mouseReleased', 80, 80, { buttons: 0 });
  const log = await waitUntil(async () => {
    const value = await minimal.webContents.executeJavaScript('window.__log', true);
    return value.length >= 2 ? value : undefined;
  }, { label: 'minimal-events' });
  check('最小页：CDP 鼠标是真事件', Boolean(log) && log.every(item => item.isTrusted === true), log);
  check('最小页：setPointerCapture 能成功', Boolean(log) && log.some(item => item.captured === 'ok'), log);
  check('最小页：窗口底层不可见', nativeVisible(minimal) === false, { nativeVisible: nativeVisible(minimal) });
  nativeShown.push(nativeVisible(minimal));
  minimal.destroy();

  const passes = [];
  const passesToRun = Number(process.env.VERIFY_PASSES || 3) || 3;
  for (let pass = 1; pass <= passesToRun; pass += 1) {
    const result = await runSuite(pass);
    passes.push({ pass, ok: result.ok, reason: result.reason });
    if (!result.ok) break;
  }
  check(`连续 ${passesToRun} 遍同一路径都通过`, passes.length === passesToRun && passes.every(item => item.ok), passes);
  // 独立合成文档只跑一遍：先选外框，再点框内的点/框（回归 B 的真实现场）。
  let framePick = { ok: false, reason: 'not-run' };
  try { framePick = await runFramePickSuite(); } catch (error) { framePick = { ok: false, reason: String(error && error.message || error) }; }
  check('独立合成文档：先选外框再点框内点/框整段通过', framePick.ok === true, framePick);
  check('所有测试窗口底层始终不可见', nativeShown.every(value => value === false), nativeShown);
  console.log(JSON.stringify({ results, failures, passes, framePick, lifecycle, copyDiagnostics }, null, 1));
  probeGuard.finish();
  app.exit(failures.length ? 1 : 0);
}).catch(error => {
  console.error('FAIL', error);
  app.exit(1);
});
