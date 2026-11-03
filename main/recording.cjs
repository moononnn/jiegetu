'use strict';
// GIF 录制：选区提交后冻结窗退场，原生源按 10FPS 实时取帧，单飞驱动 gif-encoder 的 worker 编码；
// 停止后交出预览字节与保存/另存/动画文件复制入口；复制只调用注入服务，不碰 PNG 提交链。
// 选区归属与像素换算由调用方给出（跨屏会话复用长截图的 resolveSelection），主进程只认它算出来的矩形。
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { performance: monotonicClock } = require('node:perf_hooks');
const { toPixels } = require('../core/coordinates.cjs');

const RECT_KEYS = ['x', 'y', 'width', 'height'];
const MAX_EDGE = 4096;
// 与原生录制用途（record）和控制页的上限保持一致：超过就录不了，也显示不了。
const MAX_PIXELS = 4_000_000;
const MAX_RECORD_MS = 30000;
const FRAME_INTERVAL_MS = 100;
const MAX_GIF_BYTES = 48 * 1024 * 1024;
// 隐藏冻结窗到第一次取帧之间给 DWM 的恢复时间：不等这一拍，首帧很可能还是那张冻结底图。
const DWM_SETTLE_MS = 100;
const LOAD_TIMEOUT_MS = 4000;
// 与 gif-encoder 的单条命令超时（10s）相容：慢帧下 finish 绝不能和还没回包的 frame 并行。
const ENCODER_COMMAND_TIMEOUT_MS = 10000;
const INFLIGHT_WAIT_MS = ENCODER_COMMAND_TIMEOUT_MS + 1000;
const PLACE_MARGIN = 8;
// 物理拟合后回读的窗口矩形允许的取整误差；只用于「是否还在工作区内」，压进选区仍然按实际矩形判。
const BOUNDS_TOLERANCE = 2;
const BAR_SIZE = { width: 420, height: 100 };
// 录制边框：四条窄实体窗口，颜色与控制条底同属浅绿体系；厚度按 2 DIP 换算成物理像素。
const BORDER_COLOR = '#63ad8b';
const BORDER_THICKNESS_DIP = 2;
const PREVIEW_SIZE = { width: 900, height: 650 };
// 采样留痕的最短间隔：只写计数，不写像素、坐标或画面。
const SAMPLE_LOG_MS = 1000;
const ACTIONS = new Set(['stop', 'cancel', 'retry', 'save', 'save-quick', 'copy', 'edit', 'edit-close']);
const EDIT_ACTIONS = new Set(['begin', 'frame', 'finish', 'abort']);
const EDIT_IDLE_MS = 120000;
const DANGEROUS_PHASES = new Set(['record-starting', 'recording']);

const loadElectron = () => require('electron');

function sameRect(a, b) {
  return Boolean(a) && Boolean(b) && RECT_KEYS.every(key => a[key] === b[key]);
}

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function installRecording(options = {}) {
  const {
    getActive, allowed, cancel, finishSession = cancel, onStatus = () => {}, resolveSelection, onLifecycle = () => {},
    // 控制条丢失/挂起父 Esc 的内部钩子：调用方（screenshot）需要在 recording 自己的活性早退前先知道。
    onWindowLost = () => {}, onSuspendedEscape = () => false,
    // 主题（可选）：只给不透明控制条（兼预览）上色；边框窗保持自己的颜色。
    theme = null,
    createCapture = region => require('./win-capture.cjs').createWinCapture(region, { purpose: 'record' }),
    // 本进程只新建一扇控制条，只按监视器内的子矩形拟合；原生只接受隐藏窗。
    fitWindow = (win, nonce, bounds) => {
      const mod = require('./win-capture.cjs');
      return mod.fitHiddenWindow(mod.handleToDecimal(win.getNativeWindowHandle()), process.pid, nonce, bounds);
    },
    createEncoder = encoderOptions => require('./gif-encoder.cjs').createGifEncoder(encoderOptions),
    resolveSaveFolder = () => loadElectron().app.getPath('pictures'),
    showSaveDialog = (owner, dialogOptions) => loadElectron().dialog.showSaveDialog(owner, dialogOptions),
    resolveAsFolder = () => loadElectron().app.getPath('pictures'),
    onSaved = () => {},
    copyGif = async () => { throw new Error('GIF 动画文件复制服务不可用'); },
    mkdir = (folder, options) => fs.mkdir(folder, options),
    writeFile = (file, bytes, options) => fs.writeFile(file, bytes, options),
    now = () => monotonicClock.now(),
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
    ipcMain = loadElectron().ipcMain,
    BrowserWindow = loadElectron().BrowserWindow,
    screen = loadElectron().screen,
    globalShortcut = loadElectron().globalShortcut
  } = options;
  let disposed = false;

  // 只写固定字段的留痕，与 screenshot 的 onLifecycle 同一条通道；留痕失败绝不阻断录制。
  const note = (event, fields = {}) => { try { onLifecycle(event, fields); } catch { /* 留痕失败不影响录制。 */ } };
  // 失败只归成固定代码：日志里绝不出现路径、图内容或原始异常文本。
  const ERROR_CODES = [
    ['屏幕采集中断', 'capture-interrupted'],
    ['原生帧尺寸不完整', 'frame-incomplete'],
    ['显示器', 'display-changed'],
    ['录制控制条', 'bar-unsafe'],
    ['录制范围', 'region-changed'],
    ['GIF 生成失败', 'encode-failed'],
    ['上限', 'size-limit'],
    ['放不下控制条', 'no-bar-space'],
    ['录制边框', 'border-unsafe'],
    ['未能隐藏', 'frozen-visible'],
    ['录制窗口', 'window-failed']
  ];
  function classifyError(message) {
    const text = typeof message === 'string' ? message : '';
    for (const [needle, code] of ERROR_CODES) if (text.includes(needle)) return code;
    return 'failed';
  }

  const live = (current, rec) => !disposed && Boolean(current) && getActive() === current &&
    current.recording === rec && rec.closing !== true;
  // 窗口回调专用：本轮的窗口职责已摘下（收尾中/半成品销毁中）就一律不动会话。
  const windowLive = (current, rec) => rec.closing !== true && rec.teardown !== true && live(current, rec);

  function barOwner(event, rec) {
    const bar = rec?.bar;
    if (!bar || bar.isDestroyed()) return false;
    const contents = bar.webContents;
    return Boolean(contents) && event?.sender === contents && event?.senderFrame === contents.mainFrame;
  }

  function send(rec, channel, payload) {
    const bar = rec.bar;
    if (!bar || bar.isDestroyed()) return false;
    try { bar.webContents.send(channel, payload); return true; } catch { return false; }
  }

  function statusPayload(current, rec) {
    let mode = 'preview';
    if (rec.error) mode = 'error';
    else if (current.phase === 'saving') mode = 'saving';
    else if (current.phase === 'record-starting') mode = 'starting';
    else if (current.phase === 'recording') mode = 'recording';
    else if (current.phase === 'record-finishing') mode = 'finishing';
    return { mode, elapsedMs: rec.elapsedMs, width: rec.preview?.width ?? rec.pixels.width,
      height: rec.preview?.height ?? rec.pixels.height, message: rec.message || '' };
  }

  function publish(current, rec, message) {
    if (message !== undefined) rec.message = message;
    const payload = statusPayload(current, rec);
    send(rec, 'gif:status', payload);
    return payload;
  }

  function sendPreview(rec) {
    if (!rec.preview) return false;
    return send(rec, 'gif:preview', { bytes: rec.preview.bytes, width: rec.preview.width,
      height: rec.preview.height, elapsedMs: rec.preview.elapsedMs, sourceId: rec.preview.sourceId });
  }

  // 选区局部像素 → 绝对物理矩形：只平移 owner 原点，不缩放、不夹取。
  function physicalRegion(env, pixels) {
    if (!env?.nativeBounds) throw new Error('缺少显示器物理矩形，无法录制');
    return { x: env.nativeBounds.x + pixels.x, y: env.nativeBounds.y + pixels.y,
      width: pixels.width, height: pixels.height };
  }

  // 每帧采样前的拓扑复核：整块屏的缩放/边界、DIP→物理映射、工作区与采集矩形都必须还是本轮冻结的那一份。
  function verifyGeometry(rec) {
    const env = rec.env, original = env.display;
    const display = screen.getAllDisplays().find(item => item.id === original.id);
    if (!display || display.scaleFactor !== original.scaleFactor ||
        RECT_KEYS.some(key => display.bounds[key] !== original.bounds[key])) {
      throw new Error('显示器分辨率或缩放发生变化，录制已停止');
    }
    const physical = screen.dipToScreenRect(null, display.bounds);
    if (!physical || !RECT_KEYS.every(key => Number.isInteger(physical[key])) || !env.nativeHint ||
        RECT_KEYS.some(key => physical[key] !== env.nativeHint[key])) {
      throw new Error('显示器物理映射发生变化，录制已停止');
    }
    if (env.nativeWorkHint) {
      const workNow = screen.dipToScreenRect(null, display.workArea);
      if (!workNow || !RECT_KEYS.every(key => Number.isInteger(workNow[key])) ||
          RECT_KEYS.some(key => workNow[key] !== env.nativeWorkHint[key])) {
        throw new Error('显示器工作区发生变化，录制已停止');
      }
    }
    if (!env.nativeBounds || !RECT_KEYS.every(key => Number.isSafeInteger(env.nativeBounds[key])) ||
        env.nativeBounds.width !== env.frame.width || env.nativeBounds.height !== env.frame.height) {
      throw new Error('原生显示器尺寸不匹配，录制已停止');
    }
    const region = physicalRegion(env, rec.pixels);
    if (!sameRect(region, rec.region)) throw new Error('录制范围发生变化，录制已停止');
    return region;
  }

  // 控制条必须整块在工作区内且完全不压选区：本轮不再用内容排除把控件压进 ROI。
  function barSafe(rec) {
    const bar = rec.bar;
    if (!bar || bar.isDestroyed()) return false;
    const bounds = bar.getBounds(), area = rec.barArea, roi = rec.roi;
    if (!RECT_KEYS.every(key => Number.isInteger(bounds[key])) || bounds.width <= 0 || bounds.height <= 0) return false;
    if (bounds.x < area.x - BOUNDS_TOLERANCE || bounds.y < area.y - BOUNDS_TOLERANCE ||
        bounds.x + bounds.width > area.x + area.width + BOUNDS_TOLERANCE ||
        bounds.y + bounds.height > area.y + area.height + BOUNDS_TOLERANCE) return false;
    return !overlaps(bounds, roi);
  }

  // 每次取帧前后都走这一道：拓扑/物理映射/采集矩形、控件几何与四条边框任一不安全就不继续。
  function assertSafe(rec) {
    verifyGeometry(rec);
    if (!barSafe(rec)) throw new Error('录制控制条压进了录制范围，已停止录制');
    if (!bordersSafe(rec)) throw new Error('录制边框位置或状态异常，已停止录制');
  }

  // 控制条只允许放在选区外的四边：下、上、右、左；四边都放不下就明确拒绝，绝不压进 ROI。
  function placeBar(area, roi, size) {
    const clampX = value => Math.max(area.x, Math.min(Math.round(value), area.x + area.width - size.width));
    const clampY = value => Math.max(area.y, Math.min(Math.round(value), area.y + area.height - size.height));
    const candidates = [
      { x: roi.x, y: roi.y + roi.height + PLACE_MARGIN },
      { x: roi.x, y: roi.y - size.height - PLACE_MARGIN },
      { x: roi.x + roi.width + PLACE_MARGIN, y: roi.y },
      { x: roi.x - size.width - PLACE_MARGIN, y: roi.y }
    ];
    for (const candidate of candidates) {
      const rect = { x: clampX(candidate.x), y: clampY(candidate.y), width: size.width, height: size.height };
      if (rect.x >= area.x && rect.y >= area.y && rect.x + rect.width <= area.x + area.width &&
          rect.y + rect.height <= area.y + area.height && !overlaps(rect, roi)) return rect;
    }
    throw new Error('录制区域外放不下控制条，请缩小选区');
  }

  // 与长截图浮条同一套物理换算：canonical + (DIP - bounds.origin) * scale，再夹进真实工作区。
  function physicalBarRect(env, placement) {
    const canonical = env.nativeBounds, bounds = env.display.bounds, scale = env.display.scaleFactor;
    const work = env.nativeWorkArea || canonical;
    if (!canonical || !work || !Number.isFinite(scale) || scale <= 0) return undefined;
    if (work.x < canonical.x || work.y < canonical.y ||
        work.x + work.width > canonical.x + canonical.width ||
        work.y + work.height > canonical.y + canonical.height) return undefined;
    const width = Math.round(placement.width * scale), height = Math.round(placement.height * scale);
    if (!(width > 0 && height > 0 && width <= work.width && height <= work.height)) return undefined;
    const x = canonical.x + Math.round((placement.x - bounds.x) * scale);
    const y = canonical.y + Math.round((placement.y - bounds.y) * scale);
    return { x: Math.min(Math.max(x, work.x), work.x + work.width - width),
      y: Math.min(Math.max(y, work.y), work.y + work.height - height), width, height };
  }

  // 选区像素 → 全局 DIP 的外包络：安全判定与摆放都用它，保证控件永远压不进真正采到的像素。
  function roiDip(env, pixels) {
    const bounds = env.display.bounds, scale = env.display.scaleFactor;
    const left = bounds.x + Math.floor(pixels.x / scale), top = bounds.y + Math.floor(pixels.y / scale);
    const right = bounds.x + Math.ceil((pixels.x + pixels.width) / scale);
    const bottom = bounds.y + Math.ceil((pixels.y + pixels.height) / scale);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  // 边框厚度：按该屏缩放算 2 DIP 对应的物理像素，至少 2 像素。
  function borderThickness(env) {
    const scale = Number(env?.display?.scaleFactor);
    return Math.max(2, Math.round(BORDER_THICKNESS_DIP * (Number.isFinite(scale) && scale > 0 ? scale : 1)));
  }

  // 只做矩形相交：裁到本屏，零面积返回 undefined（贴屏边那一侧就不建条）。
  function clipToMonitor(rect, monitor) {
    const left = Math.max(rect.x, monitor.x), top = Math.max(rect.y, monitor.y);
    const right = Math.min(rect.x + rect.width, monitor.x + monitor.width);
    const bottom = Math.min(rect.y + rect.height, monitor.y + monitor.height);
    if (![left, top, right, bottom].every(Number.isSafeInteger)) return undefined;
    const width = right - left, height = bottom - top;
    if (width <= 0 || height <= 0) return undefined;
    return { x: left, y: top, width, height };
  }

  // 四条边框的物理矩形：全部以 rec.region 的绝对物理像素为基准，横向允许含角向外扩 t。
  // 先裁到本屏，再要求正整数、与 region 严格零重叠、且不得整屏。
  function borderRects(env, region) {
    const t = borderThickness(env), native = env.nativeBounds;
    const candidates = [
      { x: region.x - t, y: region.y - t, width: region.width + t * 2, height: t },
      { x: region.x - t, y: region.y + region.height, width: region.width + t * 2, height: t },
      { x: region.x - t, y: region.y, width: t, height: region.height },
      { x: region.x + region.width, y: region.y, width: t, height: region.height }
    ];
    const rects = [];
    for (const candidate of candidates) {
      const rect = clipToMonitor(candidate, native);
      if (!rect) continue;
      if (!RECT_KEYS.every(key => Number.isSafeInteger(rect[key])) || rect.width < 1 || rect.height < 1) {
        throw new Error('录制边框几何不安全，录制没有开始');
      }
      if (overlaps(rect, region)) throw new Error('录制边框几何不安全，录制没有开始');
      if (rect.width >= native.width && rect.height >= native.height) throw new Error('录制边框几何不安全，录制没有开始');
      rects.push(rect);
    }
    return rects;
  }

  // BrowserWindow 初始 bounds 只要 DIP；真正的物理口径一律交给原生拟合。
  function dipRectFor(rect, env) {
    const bounds = env.display.bounds, native = env.nativeBounds, scale = env.display.scaleFactor;
    return { x: Math.round(bounds.x + (rect.x - native.x) / scale), y: Math.round(bounds.y + (rect.y - native.y) / scale),
      width: Math.max(1, Math.round(rect.width / scale)), height: Math.max(1, Math.round(rect.height / scale)) };
  }

  function lockWindow(win) {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
  }

  // 本地页面也不允许把准备流程永久挂住：加载与截止时间赛跑，不等 ready-to-show。
  async function loadPage(win, file, query) {
    let timer;
    const loading = query ? win.loadFile(file, { query }) : win.loadFile(file);
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('录制窗口加载超时')), LOAD_TIMEOUT_MS);
      timer?.unref?.();
    });
    try { await Promise.race([loading, deadline]); } finally { clearTimeout(timer); }
  }

  // 窗口一建就挂到 rec 上再装副作用：任何 setter/getter 抛异常都由这里自己收尾，
  // 绝不把一扇半成品隐藏窗留给 cleanup 去找不到。构造器本身抛异常时还没有窗口对象，不 destroy。
  function disposePartialWindow(rec, key, win) {
    if (rec[key] === win) rec[key] = undefined;
    if (!win || win.isDestroyed()) return;
    // 收自己建到一半的窗：先摘下本轮的取消职责，绝不让 closed/hide 回调把整个截图会话一起 cancel。
    rec.teardown = true;
    try { win.destroy(); } catch { /* 销毁失败也不能拦住上抛。 */ } finally { rec.teardown = false; }
  }

  function createBarWindow(current, rec, placement) {
    const bar = new BrowserWindow({ ...placement, frame: false, resizable: false, movable: false,
      thickFrame: false, hasShadow: false, roundedCorners: false, show: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: true, backgroundColor: '#f7faf6',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
        backgroundThrottling: false, preload: path.join(__dirname, 'gif-preload.cjs') } });
    rec.bar = bar;
    try {
      bar.setBounds(placement);
      // 控制条用同一个窗当预览：建好就和当前主题对齐，后续跟随系统变化。
      theme?.bind?.(bar);
      // 操作窗始终接受点击；它按 placeBar 的约束永远在选区外，不再依赖内容排除。
      bar.setIgnoreMouseEvents(false);
      bar.setAlwaysOnTop(true, 'screen-saver');
      lockWindow(bar);
    } catch (error) {
      disposePartialWindow(rec, 'bar', bar);
      throw error;
    }
    bar.webContents.on('render-process-gone', () => {
      // 先通知：父会话被挂起时 windowLive 会早退，但这一层已经失效必须被记下来。
      onWindowLost(current, rec, 'renderer-gone');
      if (!windowLive(current, rec)) return;
      // 保存中不能在这里 cancel（saving 会被拒）：只记账，交给保存回包后收尾。
      if (current.phase === 'saving') { rec.windowLost = true; return; }
      cancel('failed');
      onStatus({ message: '录制控制条异常，录制已停止。', error: true });
    });
    bar.on('closed', () => {
      if (rec.bar === bar) rec.bar = undefined;
      // 先通知（同上）：挂起父此时已经拿不到 windowLive。
      onWindowLost(current, rec, 'window-close');
      if (!windowLive(current, rec)) return;
      if (current.phase === 'saving') { rec.windowLost = true; return; }
      cancel('cancelled');
      onStatus({ message: '录制控制条已关闭，未保存 GIF。' });
    });
    bar.on('hide', () => {
      // 主动切预览会先改 phase 再 resize/show：这里只把「录制中被隐藏」当成危险。
      if (!windowLive(current, rec) || !DANGEROUS_PHASES.has(current.phase)) return;
      cancel('cancelled');
      onStatus({ message: '录制控制条已隐藏，录制已停止。', error: true });
    });
    bar.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape') return;
      // 挂起父：Esc 只用来撤掉还没就绪的子准备（在 live() 早退前处理）。
      if (onSuspendedEscape(current, event)) return;
      if (!live(current, rec) || current.phase !== 'recording') return;
      // Only recording owns native Esc; preview/editing must deliver it to the renderer.
      event.preventDefault();
      void finishRecording(current, rec, 'escape');
    });
    return bar;
  }

  // —— 录制边框：最多四条窄实体窗口，全在 ROI 外侧，只表示录制范围 ——
  // 归属先于副作用：一 new 就进 rec.borders，任何异常/取消都能按这份清单收尾。
  function attachBorder(current, rec, rect) {
    const dip = dipRectFor(rect, rec.env);
    const win = new BrowserWindow({ ...dip, frame: false, resizable: false, movable: false, thickFrame: false,
      hasShadow: false, roundedCorners: false, show: false, alwaysOnTop: true, skipTaskbar: true, focusable: false,
      backgroundColor: BORDER_COLOR, enableLargerThanScreen: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
        backgroundThrottling: false } });
    const border = { win, rect: { ...rect }, expectedBounds: undefined };
    if (!Array.isArray(rec.borders)) rec.borders = [];
    rec.borders.push(border);
    try {
      win.setBounds(dip);
      // 鼠标穿透、不抢焦点、无阴影、不做内容保护：这四条只是一圈实体色条。
      win.setIgnoreMouseEvents(true);
      win.setAlwaysOnTop(true, 'screen-saver');
      lockWindow(win);
    } catch (error) {
      detachBorder(rec, border);
      destroyWindow(win);
      throw error;
    }
    return border;
  }

  function windowClosedQuietly(win) {
    if (!win || win.isDestroyed()) return true;
    try { return win.webContents?.isDestroyed?.() === true; } catch { return true; }
  }

  // 只按宿主 BrowserWindow 本身早退：webContents 死并不等于窗口已销毁，
  // 那扇窄窗还可能在屏上/藏在屏上，必须继续 destroy。
  function destroyWindow(win) {
    if (!win || win.isDestroyed()) return;
    try { win.destroy(); } catch { /* 已关闭即可。 */ }
  }

  // 先摘归属再销毁：closed/hide 回调看到自己已不在清单里，就不会把自己判成「异常需停录」。
  function detachBorder(rec, border) {
    if (!Array.isArray(rec.borders)) { rec.borders = []; return; }
    const index = rec.borders.indexOf(border);
    if (index >= 0) rec.borders.splice(index, 1);
  }

  function destroyBorders(rec) {
    const list = Array.isArray(rec.borders) ? rec.borders : [];
    rec.borders = [];
    for (const border of list) destroyWindow(border?.win);
  }

  function ownsBorder(rec, border) {
    return Array.isArray(rec.borders) && rec.borders.includes(border) && !windowClosedQuietly(border.win);
  }

  // 边框关窗/崩溃/隐藏：本轮录制已不可信，停掉录制但保留选区与重录口。
  function borderFailure(current, rec, message) {
    if (!live(current, rec)) return;
    if (current.phase === 'saving') { rec.windowLost = true; return; }
    if (!DANGEROUS_PHASES.has(current.phase) && current.phase !== 'record-finishing') return;
    abortRecording(current, rec, message, 'border-unsafe');
  }

  function attachBorderHandlers(current, rec, border) {
    const win = border.win;
    const owned = () => Array.isArray(rec.borders) && rec.borders.includes(border);
    win.webContents.on('render-process-gone', () => {
      if (!owned() || !windowLive(current, rec)) return;
      // 出问题的那条也要收掉：先摘归属再销毁，自己不会把这次收尾再判一次取消。
      detachBorder(rec, border);
      destroyWindow(win);
      borderFailure(current, rec, '录制边框异常，录制已停止');
    });
    win.on('closed', () => {
      // 主动销毁会先摘归属；不在清单里的 closed 一律不动会话，绝不自己把自己判成取消。
      if (!owned() || !windowLive(current, rec)) return;
      detachBorder(rec, border);
      borderFailure(current, rec, '录制边框已关闭，录制已停止');
    });
    win.on('hide', () => {
      if (!owned() || !windowLive(current, rec) || !DANGEROUS_PHASES.has(current.phase)) return;
      detachBorder(rec, border);
      destroyWindow(win);
      borderFailure(current, rec, '录制边框已隐藏，录制已停止');
    });
  }

  // 建条：先隐藏建好 → 物理拟合 → 读 DIP 基线 → 载页 → 再核基线未变。
  async function prepareBorders(current, rec) {
    const rects = borderRects(rec.env, rec.region);
    if (!rects.length) throw new Error('录制边框几何不安全，录制没有开始');
    for (const rect of rects) {
      // 每个 await 之后、新建下一条之前都要确认本轮还活着：取消后绝不追加窗口。
      if (!live(current, rec)) return false;
      const border = attachBorder(current, rec, rect);
      attachBorderHandlers(current, rec, border);
      try {
        const nonce = randomUUID().replace(/-/g, '');
        border.win.setTitle(nonce);
        await fitWindow(border.win, nonce, rect);
        if (!live(current, rec) || !ownsBorder(rec, border)) return false;
        const baseline = border.win.getBounds();
        border.expectedBounds = baseline;
        await loadPage(border.win, path.join(__dirname, '..', 'renderer', 'gif-border.html'));
        if (!live(current, rec) || !ownsBorder(rec, border)) return false;
        // 载页后再核一次：拟合完成后到就绪之间被挪动就不算可信边框。
        if (!sameRect(border.win.getBounds(), baseline)) throw new Error('录制边框未能贴合屏幕，录制没有开始');
      } catch (error) {
        detachBorder(rec, border);
        destroyWindow(border.win);
        throw error;
      }
    }
    return live(current, rec);
  }

  function showBorders(rec) {
    for (const border of Array.isArray(rec.borders) ? rec.borders : []) {
      if (windowClosedQuietly(border.win)) continue;
      try { border.win.showInactive(); border.win.moveTop(); } catch { /* 显示失败由下一拍 assertSafe 拦住。 */ }
    }
  }

  // 每条：活着、在屏上、getBounds 仍等于拟合后的基线、物理矩形仍不压 ROI 且不是整屏。
  function bordersSafe(rec) {
    const list = Array.isArray(rec.borders) ? rec.borders : [];
    if (list.length < 1) return false;
    for (const border of list) {
      const win = border?.win;
      if (!win || windowClosedQuietly(win)) return false;
      if (win.isVisible() !== true) return false;
      if (!border.expectedBounds || !sameRect(win.getBounds(), border.expectedBounds)) return false;
      if (!RECT_KEYS.every(key => Number.isSafeInteger(border.rect[key]))) return false;
      if (border.rect.width < 1 || border.rect.height < 1) return false;
      if (overlaps(border.rect, rec.region)) return false;
      if (border.rect.width >= rec.env.nativeBounds.width && border.rect.height >= rec.env.nativeBounds.height) return false;
    }
    return true;
  }

  // 本轮不再建整屏边框层（屏上只留选区外的控制条与四条窄实体边），
  // 也不再引入任何全屏透明/受保护的合成面。renderer/gif-border.html 只做静态色条。
  // 控制条先隐藏建好、按真实物理矩形拟合；原生只接受隐藏窗，show 统一交给 startCapture。
  async function prepareWindows(current, rec) {
    const area = rec.env.display.workArea;
    const placement = placeBar(area, rec.roi, BAR_SIZE);
    rec.barArea = area;
    rec.placement = placement;
    const bar = createBarWindow(current, rec, placement);
    const barRect = physicalBarRect(rec.env, placement);
    if (barRect) {
      const nonce = randomUUID().replace(/-/g, '');
      bar.setTitle(nonce);
      // 拟合与载页都是会抛的副作用：抛了就自己收，不能把隐藏窗留在屏上。
      try { await fitWindow(bar, nonce, barRect); }
      catch (error) { disposePartialWindow(rec, 'bar', bar); throw error; }
      rec.barRect = barRect;
    }
    try { await loadPage(bar, path.join(__dirname, '..', 'renderer', 'gif-recorder.html')); }
    catch (error) { disposePartialWindow(rec, 'bar', bar); throw error; }
    if (!live(current, rec) || rec.bar !== bar || bar.isDestroyed()) return false;
    // 控制条先摆好（放不下就已在 placeBar 拒绝），再建边框条。
    if (!await prepareBorders(current, rec)) return false;
    if (!live(current, rec)) return false;
    return true;
  }

  function wakeLoop(rec) {
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = undefined; }
    const wake = rec.wake;
    rec.wake = undefined;
    if (wake) wake();
  }

  // 只等当前这一条 inflight；超时也不再等，后面 stop() 会把挂住的 next() 直接拒掉。
  async function settleLoop(rec) {
    const task = rec.loop;
    if (!task) return;
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeout(resolve, INFLIGHT_WAIT_MS); timer?.unref?.(); });
    try { await Promise.race([task.catch(() => {}), deadline]); } finally { clearTimeout(timer); }
  }

  function registerShortcuts(current, rec) {
    try {
      rec.escapeRegistered = globalShortcut.register('Escape', () => {
        if (!live(current, rec) || current.phase !== 'recording') return;
        void finishRecording(current, rec, 'escape');
      }) === true;
    } catch { rec.escapeRegistered = false; }
    try {
      rec.cancelRegistered = globalShortcut.register('CommandOrControl+Alt+Escape', () => {
        if (!live(current, rec) || current.phase === 'saving') return;
        cancel('cancelled');
        onStatus({ message: '已取消 GIF 录制，未保存。' });
      }) === true;
    } catch { rec.cancelRegistered = false; }
  }

  // 只注销自己成功注册的那两个键。
  function unregisterShortcuts(rec) {
    if (rec.escapeRegistered) { try { globalShortcut.unregister('Escape'); } catch { /* 已经没了就当没注册。 */ } rec.escapeRegistered = false; }
    if (rec.cancelRegistered) { try { globalShortcut.unregister('CommandOrControl+Alt+Escape'); } catch { /* 同上。 */ } rec.cancelRegistered = false; }
  }

  // 单飞驱动：每次 next() 之后才决定要不要编码、下一次什么时候来；时长只按单调钟算，不数帧。
  // 每步只记计数，不记像素/坐标/画面；留痕是观察结果，不当作任何根因的证据。
  function runLoop(current, rec) {
    const task = (async () => {
      while (live(current, rec)) {
        if (rec.stopping) return;
        assertSafe(rec);
        rec.requests += 1;
        const tickStart = now();
        let frame;
        try { frame = await rec.capture.next(); }
        catch (error) {
          if (rec.stopping || !live(current, rec)) return;
          throw new Error(`屏幕采集中断：${error.message}`);
        }
        // 收尾或取消之后才到的帧一律丢弃：绝不让旧会话借迟到回包复活。
        if (!live(current, rec) || rec.stopping) return;
        const arrived = now();
        if (rec.firstFrameAt === undefined) rec.firstFrameAt = arrived;
        const elapsed = Math.min(MAX_RECORD_MS, Math.max(rec.elapsedMs, Math.round(arrived - rec.firstFrameAt)));
        rec.elapsedMs = elapsed;
        if (frame.fresh === true) {
          // 取帧是异步的：编码前再核一次，等待期间控件位置/拓扑变了就绝不把这帧混进成品。
          assertSafe(rec);
          if (!frame.data || frame.width !== rec.region.width || frame.height !== rec.region.height ||
              frame.data.length !== rec.region.width * rec.region.height * 4) throw new Error('原生帧尺寸不完整，录制已停止');
          await rec.encoder.frame(frame.data, elapsed);
          rec.freshFrames += 1;
          if (!live(current, rec) || rec.stopping) return;
        } else {
          rec.duplicateFrames += 1;
        }
        publish(current, rec, `录制中 · ${(elapsed / 1000).toFixed(1)} / 30 秒`);
        // 每 ≥１ 秒留一行采样计数，只看得到节奏，看不到画面。
        if (elapsed >= rec.nextSampleLogAt) {
          rec.nextSampleLogAt = elapsed + SAMPLE_LOG_MS;
          note('gif-record-sample', { requests: rec.requests, freshFrames: rec.freshFrames,
            duplicateFrames: rec.duplicateFrames, elapsedMs: elapsed });
        }
        if (elapsed >= MAX_RECORD_MS) { rec.limitReached = true; return; }
        // 下一拍按基准间隔排：把本轮耗时扣掉，绝不排队补帧。
        const spent = now() - tickStart;
        await new Promise(resolve => {
          rec.wake = resolve;
          rec.timer = setTimeout(resolve, Math.max(0, FRAME_INTERVAL_MS - spent));
        });
        rec.timer = undefined;
        rec.wake = undefined;
      }
    })();
    rec.loop = task;
    task.then(() => {
      if (rec.loop === task) rec.loop = undefined;
      if (rec.limitReached && live(current, rec) && !rec.stopping) void finishRecording(current, rec, 'limit');
    }).catch(error => {
      if (rec.loop === task) rec.loop = undefined;
      if (!live(current, rec) || rec.stopping) return;
      abortRecording(current, rec, error.message);
    });
  }
  // 只摆位与物理拟合：原生拒绝可见窗，所以这里绝不 show；上屏统一由 startCapture 负责。
  async function layoutBar(current, rec) {
    const bar = rec.bar;
    if (!bar || bar.isDestroyed()) return false;
    const placement = placeBar(rec.barArea || rec.env.display.workArea, rec.roi, BAR_SIZE);
    rec.placement = placement;
    bar.setBounds(placement);
    const barRect = physicalBarRect(rec.env, placement);
    if (barRect) {
      const nonce = randomUUID().replace(/-/g, '');
      bar.setTitle(nonce);
      await fitWindow(bar, nonce, barRect);
      rec.barRect = barRect;
    }
    return live(current, rec);
  }

  // 冻结窗退场之后再取帧：这里决定 GIF 录到的是真实桌面，而不是那张冻结底图。
  async function startCapture(current, rec) {
    current.phase = 'record-starting';
    rec.error = undefined;
    rec.stopping = false;
    rec.limitReached = false;
    rec.aborted = false;
    rec.preview = undefined;
    rec.elapsedMs = 0;
    rec.firstFrameAt = undefined;
    rec.requests = 0;
    rec.freshFrames = 0;
    rec.duplicateFrames = 0;
    rec.nextSampleLogAt = 0;
    publish(current, rec, '正在准备录制…');
    const bar = rec.bar;
    if (bar && !bar.isDestroyed()) { bar.showInactive(); bar.moveTop(); }
    // 边框条与冻结窗退场同时上屏：它们全在 ROI 外侧，只当录制范围提示。
    showBorders(rec);
    const frozen = current.win;
    if (frozen && !frozen.isDestroyed()) frozen.hide();
    await delay(DWM_SETTLE_MS);
    // await 期间可能被取消、切窗或换轮：活性与控件位置都要在同一拍重核。
    if (!live(current, rec) || current.phase !== 'record-starting') return false;
    // 冻结窗必须真的退场：还在屏上就把选区放回来报错，绝不开始采一张冻结图。
    const frozenVisible = Boolean(frozen) && !frozen.isDestroyed() && frozen.isVisible() === true;
    if (frozenVisible) {
      try { frozen.show(); frozen.moveTop(); frozen.focus(); } catch { /* 还原失败只保留数据。 */ }
      throw new Error('选区窗口未能隐藏，录制没有开始');
    }
    assertSafe(rec);
    rec.capture = createCapture(rec.region);
    rec.encoder = createEncoder({ width: rec.region.width, height: rec.region.height, maxBytes: MAX_GIF_BYTES });
    registerShortcuts(current, rec);
    current.phase = 'recording';
    note('gif-record-start', { width: rec.region.width, height: rec.region.height, frozenVisible: false, border: true,
      borderCount: Array.isArray(rec.borders) ? rec.borders.length : 0 });
    publish(current, rec, '录制中 · 最多 30 秒，Esc 或点停止结束');
    onStatus({ message: '正在录制 GIF：Esc 停止并生成预览，Ctrl+Alt+Esc 取消。' });
    runLoop(current, rec);
    return true;
  }

  function stopResources(rec) {
    disposeEdit(rec);
    wakeLoop(rec);
    try { rec.capture?.stop(); } catch { /* 已退出就不用再停。 */ }
    rec.capture = undefined;
    try { rec.encoder?.cancel(); } catch { /* 线程可能已经结束。 */ }
    rec.encoder = undefined;
    unregisterShortcuts(rec);
  }

  // 运行期失败：停下采集与编码，留着可信区域让用户重录或取消，绝不假成功。
  function abortRecording(current, rec, message, code = classifyError(message)) {
    if (!live(current, rec) || rec.aborted) return false;
    const phase = current.phase;
    rec.aborted = true;
    rec.stopping = true;
    stopResources(rec);
    // 先摘归属再销毁：边框条的 closed/hide 回调不会把这次失败收尾再判一次取消。
    destroyBorders(rec);
    // 再把 phase 退出录制阶段：关窗/隐藏回调只把录制阶段当成危险。
    if (DANGEROUS_PHASES.has(current.phase) || current.phase === 'record-finishing') current.phase = 'record-preview';
    rec.preview = undefined;
    rec.error = message;
    note('gif-record-error', { phase, code });
    const bar = rec.bar;
    if (bar && !bar.isDestroyed() && !bar.isVisible()) { try { bar.showInactive(); } catch { /* 显示失败只影响重录入口。 */ } }
    publish(current, rec, message);
    onStatus({ message: `${message} 可重录或取消。`, error: true });
    return false;
  }

  // 开始阶段失败：录制事务整体作废，冻结选框重新上屏，选区与编辑状态一律保留。
  function abortStart(current, rec, message, code = classifyError(message)) {
    if (current.recording !== rec) return;
    const phase = current.phase;
    rec.closing = true;
    rec.stopping = true;
    stopResources(rec);
    destroyBorders(rec);
    current.recording = undefined;
    note('gif-record-error', { phase, code });
    const bar = rec.bar;
    rec.bar = undefined;
    if (bar && !bar.isDestroyed()) { try { bar.destroy(); } catch { /* 销毁失败不能拦住收尾。 */ } }
    rec.closing = false;
    if (getActive() !== current) return;
    // 准备期先后顺序可能被边框异常先推成 record-preview：两种录制期阶段都要把选区还原，
    // 否则会话会卡在一个没有 recording 的 record-preview 上。
    if (current.phase === 'record-starting' || current.phase === 'record-preview') {
      current.phase = 'selecting';
      const win = current.win;
      if (win && !win.isDestroyed()) {
        try { win.show(); win.moveTop(); win.focus(); } catch { /* 还原失败只保留数据。 */ }
      }
    }
    onStatus({ message, error: true });
  }

  async function presentPreview(current, rec, size = PREVIEW_SIZE, resend = true) {
    const bar = rec.bar;
    if (!bar || bar.isDestroyed()) return false;
    const area = rec.env.display.workArea;
    const width = Math.max(1, Math.min(size.width, area.width));
    const height = Math.max(1, Math.min(size.height, area.height));
    const bounds = { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2),
      width, height };
    bar.setBounds(bounds);
    bar.show();
    bar.focus();
    if (resend) sendPreview(rec);
    return true;
  }

  async function finishRecording(current, rec, reason) {
    if (!live(current, rec) || current.phase !== 'recording') return false;
    current.phase = 'record-finishing';
    rec.stopping = true;
    // 停录时长按点下停止的那一刻算：之后等编码/收尾的时间不算进录制长度。
    rec.elapsedMs = rec.firstFrameAt === undefined ? 0
      : Math.min(MAX_RECORD_MS, Math.max(0, Math.round(now() - rec.firstFrameAt)));
    wakeLoop(rec);
    publish(current, rec, '正在生成 GIF 预览…');
    onStatus({ message: '正在生成 GIF 预览…' });
    // 先停源：挂起的 next() 立刻被拒，收尾不会再等出新帧；再等已有的 encoder.frame 跑完。
    try { rec.capture?.stop(); } catch { /* 已退出就不用再停。 */ }
    rec.capture = undefined;
    await settleLoop(rec);
    // 收尾等待期间可能已被取消/失败收尾：编码器已丢，绝不在这里碰它。
    if (!live(current, rec) || rec.aborted === true || !rec.encoder) return false;
    let bytes;
    try { bytes = await rec.encoder.finish(rec.elapsedMs); }
    catch (error) { return abortRecording(current, rec, `GIF 生成失败：${error.message}`, 'encode-failed'); }
    rec.encoder = undefined;
    if (!live(current, rec)) return false;
    if (!bytes || typeof bytes.length !== 'number' || bytes.length < 1) {
      return abortRecording(current, rec, 'GIF 生成失败：没有拿到有效数据', 'encode-empty');
    }
    if (bytes.length > MAX_GIF_BYTES) {
      return abortRecording(current, rec, `GIF 超过 ${Math.round(MAX_GIF_BYTES / 1024 / 1024)}MiB 上限，已丢弃，请缩小录制区域`, 'size-limit');
    }
    note('gif-record-finish', { requests: rec.requests, freshFrames: rec.freshFrames,
      duplicateFrames: rec.duplicateFrames, elapsedMs: rec.elapsedMs, gifBytes: bytes.length });
    rec.preview = { bytes, width: rec.region.width, height: rec.region.height, elapsedMs: rec.elapsedMs, sourceId: randomUUID() };
    // 先停快捷键、再改 phase、最后才 resize/show：隐藏回调不会把主动切预览当成危险。
    unregisterShortcuts(rec);
    // 边框条只属于录制阶段：进预览前先摘归属再销毁，重录时再重建。
    destroyBorders(rec);
    current.phase = 'record-preview';
    await presentPreview(current, rec);
    if (!live(current, rec)) return true;
    publish(current, rec, `录制完成 · ${(rec.elapsedMs / 1000).toFixed(1)} 秒，可保存或重录`);
    onStatus({ message: `GIF 预览已就绪：${rec.region.width} × ${rec.region.height}，${(rec.elapsedMs / 1000).toFixed(1)} 秒。` });
    return true;
  }

  async function retryRecording(current, rec) {
    if (!live(current, rec)) throw new Error('录制会话已结束');
    if (current.phase !== 'record-preview') throw new Error('当前不能重新录制');
    verifyGeometry(rec);
    const bar = rec.bar;
    if (!bar || bar.isDestroyed()) throw new Error('录制控制条已失效，请重新框选');
    rec.error = undefined;
    rec.aborted = false;
    rec.preview = undefined;
    // 先收预览窗：还在 record-preview，hide 不会被当成危险；原生只接受隐藏窗做物理拟合。
    try { bar.hide(); } catch { /* 已隐藏即可。 */ }
    current.phase = 'record-starting';
    try {
      // 重录仍先隐藏预览窗再拟合（原生只接受隐藏窗），上屏仍由 startCapture 负责。
      if (!await layoutBar(current, rec)) throw new Error('录制控制条准备失败');
      if (!live(current, rec)) throw new Error('录制会话已结束');
      // 上一轮预览已把边框条销毁：重录按同一可信区重建。
      if (!await prepareBorders(current, rec)) throw new Error('录制边框准备失败');
      if (!live(current, rec)) throw new Error('录制会话已结束');
      const started = await startCapture(current, rec);
      if (!started) throw new Error('录制未能开始，请重试');
      return { started: true };
    } catch (error) {
      // 拟合/加载/起源任一环失败都回到可重试的错误态，绝不把会话卡在 record-starting。
      const reason = error?.message || '录制未能开始，请重试';
      abortRecording(current, rec, reason);
      throw new Error(reason);
    }
  }

  // 保存途中央去控制条（关闭或渲染进程崩溃）：先退出 saving 到可取消阶段，再整轮取消，
  // 绝不把会话留在“没人能点的忙态”，也不复活窗口。窗口本已没了，无事可做。
  function saveWindowLost(current, rec) {
    if (!live(current, rec)) return true;
    if (rec.windowLost === true) return true;
    const bar = rec.bar;
    if (!bar || bar.isDestroyed()) return true;
    try { return bar.webContents?.isDestroyed?.() === true; } catch { return true; }
  }

  function abandonSave(current, rec) {
    rec.windowLost = true;
    if (current.recording === rec && current.phase === 'saving') current.phase = 'record-preview';
    note('gif-record-error', { phase: 'saving', code: 'save-window-lost' });
    if (live(current, rec)) {
      cancel('cancelled');
      onStatus({ message: '输出窗口已关闭，本次 GIF 输出未完成。' });
    }
    return { ok: false, canceled: true };
  }

  async function saveRecording(current, rec, action) {
    if (!live(current, rec)) throw new Error('录制会话已结束');
    if (current.phase !== 'record-preview') throw new Error('当前不能保存 GIF');
    if (!rec.preview) throw new Error('GIF 预览还没准备好');
    const preview = rec.preview;
    // 保存沿用原来的 saving：外层取消与快捷键在这一段都被挡住，不会和另存为打架。
    current.phase = 'saving';
    rec.error = undefined;
    rec.windowLost = false;
    const copying = action === 'copy';
    const quick = action === 'save-quick';
    publish(current, rec, copying ? '正在复制 GIF…' : '正在保存 GIF…');
    if (copying) {
      try {
        if (saveWindowLost(current, rec)) return abandonSave(current, rec);
        await copyGif(preview.bytes, { isCurrent: () => !saveWindowLost(current, rec) });
      } catch (error) {
        if (saveWindowLost(current, rec)) return abandonSave(current, rec);
        current.phase = 'record-preview';
        const reason = `复制失败：${error.message}`;
        publish(current, rec, `${reason}，GIF 预览仍在，可重试`);
        onStatus({ message: reason, error: true, copied: false });
        throw new Error(reason);
      }
      // 发布剪贴板已成功就照实报告；迟到结果不得清理或修改新会话。
      if (live(current, rec)) rec.preview = undefined;
      onStatus({ message: 'GIF 动画文件已复制；实际粘贴效果取决于接收软件是否支持文件粘贴。', copied: true });
      if (live(current, rec)) finishSession(current, 'completed');
      return { ok: true, copied: true };
    }
    let choice;
    try {
      const folder = await Promise.resolve(quick ? resolveSaveFolder() : resolveAsFolder());
      // 每个 await 回包后都要看窗口还在不在：保存中关窗/崩溃不能拖到后面当成功或死等。
      if (saveWindowLost(current, rec)) return abandonSave(current, rec);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${stamp}_${preview.width}x${preview.height}_${randomUUID()}.gif`;
      if (quick) {
        await mkdir(folder, { recursive: true });
        if (saveWindowLost(current, rec)) return abandonSave(current, rec);
        choice = { filePath: path.join(folder, filename) };
      } else choice = await showSaveDialog(rec.bar, { title: '另存 GIF', buttonLabel: '保存',
        defaultPath: path.join(typeof folder === 'string' ? folder : '', filename),
        filters: [{ name: 'GIF 图片', extensions: ['gif'] }],
        properties: ['showOverwriteConfirmation', 'dontAddToRecent'] });
    } catch (error) {
      if (saveWindowLost(current, rec)) return abandonSave(current, rec);
      current.phase = 'record-preview';
      note('gif-record-error', { phase: 'saving', code: 'save-dialog-failed' });
      const reason = `${quick ? '保存目录准备失败' : '另存为窗口打开失败'}：${error.message}`;
      publish(current, rec, `${reason}，GIF 预览仍在。`);
      // 抛给页面：控制条要把失败说出口，而不是默默停在预览。
      throw new Error(reason);
    }
    // 对话框返回后就查：这之后到 writeFile 之间没有任何 await，这一处就是「回包与开始写盘之间」的唯一门。
    if (saveWindowLost(current, rec)) return abandonSave(current, rec);
    if (!choice || choice.canceled === true) {
      // 取消对话框只回到预览：字节留在内存里，可以再保存一次。
      current.phase = 'record-preview';
      publish(current, rec, '已取消保存，GIF 预览保留，可再点保存');
      onStatus({ message: '已取消保存 GIF，预览保留。' });
      return { ok: false, canceled: true };
    }
    if (typeof choice.filePath !== 'string' || !choice.filePath) {
      current.phase = 'record-preview';
      publish(current, rec, '未取得保存位置，GIF 预览保留，可重试保存');
      return { ok: false, canceled: true };
    }
    try {
      await writeFile(choice.filePath, preview.bytes, quick ? { flag: 'wx' } : undefined);
    } catch (error) {
      // 写失败且窗口也没了：不留忙态；否则回到可预览可重试的状态。
      if (saveWindowLost(current, rec)) return abandonSave(current, rec);
      current.phase = 'record-preview';
      note('gif-record-error', { phase: 'saving', code: 'save-write-failed' });
      const reason = `保存失败：${error.message}`;
      publish(current, rec, `${reason}，GIF 预览仍在，可重试`);
      onStatus({ message: `GIF 保存失败：${error.message}`, error: true });
      // 字节留在内存里；这次失败必须让页面看见。
      throw new Error(reason);
    }
    // 写入已经落盘就无法撤销：即使窗口在写的过程中没了，也照实算保存成功。
    const file = choice.filePath;
    if (live(current, rec)) {
      try { await onSaved(file, { action }); } catch { /* 记目录失败不挡已保存结果。 */ }
      if (live(current, rec)) rec.preview = undefined;
    }
    onStatus({ message: `GIF 已${quick ? '保存' : '另存'}：${preview.width} × ${preview.height}`, file, copied: false });
    // 成功即收掉本次截图事务；不碰 PNG 的提交结果，也不写剪贴板。
    if (live(current, rec)) finishSession(current, 'completed');
    return { ok: true, file };
  }

  function cleanup(current) {
    const rec = current?.recording;
    if (!rec) return;
    current.recording = undefined;
    rec.closing = true;
    rec.stopping = true;
    stopResources(rec);
    destroyBorders(rec);
    const bar = rec.bar;
    rec.bar = undefined;
    if (bar && !bar.isDestroyed()) { try { bar.destroy(); } catch { /* 销毁失败不能拦住收尾。 */ } }
    rec.preview = undefined;
  }

  ipcMain.handle('shot:record-begin', async (event, rect) => {
    const current = getActive();
    if (!current || !allowed(event)) throw new Error('无效选区窗口');
    if (current.phase !== 'selecting') throw new Error('当前不能开始录制，请先重新框选');
    if (current.recording) throw new Error('录制已在进行');
    // 长图、编辑文档、打开中的编辑器都不接受录制：入口只在普通选区可用。
    if (current.longImage || current.editDocument || current.editorOpen) throw new Error('当前选区已有长图或正在编辑，不能录制');
    if (!rect || !RECT_KEYS.every(key => Number.isFinite(rect[key]))) throw new Error('无效选区');
    if (!(rect.width >= 2) || !(rect.height >= 2)) throw new Error('录制区域太小，请重新框选');
    let pixels, env;
    if (current.mode === 'desktop') {
      // 跨屏会话只认落在一块冻结真实屏内的选区：归属与局部像素都由主进程算，跨屏/空隙直接拒绝。
      if (typeof resolveSelection !== 'function') throw new Error('跨屏会话不支持录制，请重新框选');
      const resolved = await resolveSelection(current, rect);
      if (getActive() !== current || current.phase !== 'selecting') throw new Error('选区会话已失效，请重新框选');
      if (!resolved) throw new Error('选区跨屏或包含屏幕空隙，仅支持单屏录制');
      ({ pixels, env } = resolved);
    } else {
      const baseline = current.selectionBounds;
      if (!baseline) throw new Error('选区视口基准缺失，请重新框选');
      const latest = screen.getAllDisplays().find(item => item.id === current.display.id);
      if (!latest || latest.scaleFactor !== current.display.scaleFactor ||
          RECT_KEYS.some(key => latest.bounds[key] !== current.display.bounds[key] ||
            latest.workArea[key] !== current.display.workArea[key])) throw new Error('显示器配置发生变化，请重新框选');
      const frame = current.image?.getSize?.();
      if (!frame || !(frame.width > 0) || !(frame.height > 0)) throw new Error('选区图已失效，请重新框选');
      if (!current.nativeBounds || !current.nativeHint) throw new Error('未能确认显示器物理矩形，无法录制');
      try { pixels = toPixels(rect, baseline, frame); }
      catch { throw new Error('选区超出可录制范围，请重新框选'); }
      env = { display: current.display, frame: { width: frame.width, height: frame.height },
        nativeBounds: { ...current.nativeBounds }, nativeHint: { ...current.nativeHint },
        nativeWorkArea: current.nativeWorkArea ? { ...current.nativeWorkArea } : undefined,
        nativeWorkHint: current.nativeWorkHint ? { ...current.nativeWorkHint } : undefined };
    }
    if (!pixels || !RECT_KEYS.every(key => Number.isSafeInteger(pixels[key])) || pixels.width < 2 || pixels.height < 2) {
      throw new Error('录制区域太小，请重新框选');
    }
    if (!RECT_KEYS.every(key => Number.isFinite(env?.nativeBounds?.[key]))) throw new Error('缺少显示器物理矩形，无法录制');
    if (pixels.width > MAX_EDGE || pixels.height > MAX_EDGE || pixels.width * pixels.height > MAX_PIXELS) {
      throw new Error(`录制区域不能超过 ${MAX_EDGE}×${MAX_EDGE} 或 ${MAX_PIXELS} 像素`);
    }
    const region = physicalRegion(env, pixels);
    if (!RECT_KEYS.every(key => Number.isSafeInteger(region[key])) || region.width < 2 || region.height < 2) {
      throw new Error('录制范围无效，请重新框选');
    }
    if (region.x < env.nativeBounds.x || region.y < env.nativeBounds.y ||
        region.x + region.width > env.nativeBounds.x + env.nativeBounds.width ||
        region.y + region.height > env.nativeBounds.y + env.nativeBounds.height) {
      throw new Error('录制范围超出显示器，请重新框选');
    }
    const rec = { token: randomUUID(), region, pixels: { ...pixels }, env,
      roi: roiDip(env, pixels), elapsedMs: 0, message: '', closing: false, stopping: false };
    current.recording = rec;
    current.phase = 'record-starting';
    try {
      const prepared = await prepareWindows(current, rec);
      if (!prepared || !live(current, rec)) throw new Error(getActive() === current ? '录制窗口准备失败' : '选区会话已结束');
      const started = await startCapture(current, rec);
      if (!started) throw new Error('录制未能开始');
      return { started: true };
    } catch (error) {
      // 抛给页面的只是原因：选区页自己会拼「GIF 录制未开始：…」前缀，不重复。
      const reason = error?.message || '未知原因';
      if (current.recording === rec) abortStart(current, rec, `GIF 录制未开始：${reason}`);
      throw new Error(reason);
    }
  });

  // 编辑只替换最终内存预览；验证失败不触碰原 GIF，编码失败则释放整份临时 job。
  function disposeEdit(rec) {
    const job = rec.editJob;
    if (!job) return;
    rec.editJob = undefined;
    clearTimeout(job.timer);
    try { job.encoder?.cancel(); } catch { /* 线程已退出。 */ }
  }

  function restoreEdit(current, rec, job, message) {
    if (rec.editJob !== job) return;
    disposeEdit(rec);
    if (!live(current, rec) || current.phase !== 'record-editing') return;
    current.phase = 'record-preview';
    publish(current, rec, message);
    // 不补发旧 preview：页面仍持有草稿，只有 finish 成功才发替换事件。
  }

  function refreshEdit(current, rec, job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      restoreEdit(current, rec, job, 'GIF 编辑等待超时，原预览保留，请重试');
    }, EDIT_IDLE_MS);
    job.timer.unref?.();
  }

  ipcMain.handle('gif:edit', async (event, action, payload = {}) => {
    const current = getActive();
    const rec = current?.recording;
    if (!rec || !live(current, rec) || !barOwner(event, rec)) throw new Error('无效录制窗口');
    if (!EDIT_ACTIONS.has(action) || !payload || typeof payload !== 'object') throw new Error('无效 GIF 编辑操作');
    const ownsJob = job => live(current, rec) && barOwner(event, rec) &&
      rec.editJob === job && current.phase === 'record-editing';
    if (action === 'abort') {
      const job = rec.editJob;
      if (!job) return { ok: true };
      if (payload.token !== job.token && payload.sourceId !== job.sourceId) throw new Error('GIF 编辑凭据已失效');
      restoreEdit(current, rec, job, '已取消编辑导出，原预览保留');
      return { ok: true };
    }
    if (action === 'begin') {
      const source = rec.preview;
      if (current.phase !== 'record-preview' || rec.editJob || !source ||
          typeof payload.sourceId !== 'string' || payload.sourceId !== source.sourceId) throw new Error('GIF 预览已失效');
      const { width, height, frames, durationMs } = payload;
      if (![width, height, frames, durationMs].every(Number.isSafeInteger) ||
          width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE ||
          width > source.width || height > source.height || width * height > MAX_PIXELS ||
          frames < 1 || frames > 512 || durationMs < 10 || durationMs > 31000 || durationMs % 10 !== 0 ||
          durationMs > Math.ceil(source.elapsedMs / 10) * 10 + 10 || frames > durationMs / 10) {
        throw new Error('GIF 编辑尺寸、帧数或时长无效');
      }
      const job = { token: randomUUID(), sourceId: source.sourceId, width, height, frames,
        durationMs, count: 0, lastElapsed: -10, busy: true };
      rec.editJob = job;
      current.phase = 'record-editing';
      rec.error = undefined;
      refreshEdit(current, rec, job);
      publish(current, rec, '正在生成编辑后的 GIF…');
      try {
        // 现有 createGifEncoder 同步建 worker 并先发送 init，无独立 ready API；
        // 命令由同一消息队列保证 init 在 frame 前。微任务后复核归属，防迟到初始化复活。
        job.encoder = createEncoder({ width, height, maxBytes: MAX_GIF_BYTES });
        await Promise.resolve();
        if (!ownsJob(job)) {
          if (rec.editJob === job) disposeEdit(rec);
          throw new Error('GIF 编辑会话已结束');
        }
        job.busy = false;
        return { token: job.token };
      } catch (error) {
        restoreEdit(current, rec, job, 'GIF 编辑初始化失败，原预览保留');
        throw error;
      }
    }
    const job = rec.editJob;
    if (!job || payload.token !== job.token || !ownsJob(job)) throw new Error('GIF 编辑凭据已失效');
    if (job.busy) throw new Error('GIF 编辑正在编码，请稍候');
    if (action === 'frame') {
      const { rgba, elapsedMs } = payload;
      const tag = Object.prototype.toString.call(rgba);
      if (!ArrayBuffer.isView(rgba) || (tag !== '[object Uint8Array]' && tag !== '[object Uint8ClampedArray]') ||
          rgba.byteLength !== job.width * job.height * 4 || !Number.isSafeInteger(elapsedMs) ||
          elapsedMs % 10 !== 0 || elapsedMs < 0 || elapsedMs >= job.durationMs ||
          (job.count === 0 ? elapsedMs !== 0 : elapsedMs < job.lastElapsed + 10) || job.count >= job.frames) {
        throw new Error('GIF 编辑帧或时间无效');
      }
      job.busy = true;
      try {
        await job.encoder.frame(rgba, elapsedMs);
        if (!ownsJob(job)) {
          if (rec.editJob === job) disposeEdit(rec);
          throw new Error('GIF 编辑会话已结束');
        }
        job.count += 1;
        job.lastElapsed = elapsedMs;
        job.busy = false;
        refreshEdit(current, rec, job);
        return { ok: true };
      } catch (error) {
        restoreEdit(current, rec, job, 'GIF 编辑编码失败，原预览保留');
        throw error;
      }
    }
    if (job.count !== job.frames) throw new Error('GIF 编辑帧数不完整');
    job.busy = true;
    try {
      const bytes = await job.encoder.finish(job.durationMs);
      if (!ownsJob(job)) {
        if (rec.editJob === job) disposeEdit(rec);
        throw new Error('GIF 编辑会话已结束');
      }
      if (!ArrayBuffer.isView(bytes) || bytes.byteLength < 1 || bytes.byteLength > MAX_GIF_BYTES) {
        throw new Error('GIF 编辑生成数据无效或超过上限');
      }
      rec.preview = { bytes, width: job.width, height: job.height,
        elapsedMs: job.durationMs, sourceId: randomUUID() };
      rec.elapsedMs = job.durationMs;
      disposeEdit(rec);
      current.phase = 'record-preview';
      publish(current, rec, 'GIF 编辑完成，可保存或继续编辑');
      sendPreview(rec);
      return { ok: true };
    } catch (error) {
      restoreEdit(current, rec, job, 'GIF 编辑生成失败，原预览保留');
      throw error;
    }
  });

  ipcMain.handle('gif:ready', event => {
    const current = getActive();
    const rec = current?.recording;
    if (!rec || !barOwner(event, rec)) throw new Error('无效录制窗口');
    rec.ready = true;
    // 页面握手可能晚于预览：这里补发一次，避免预览事件落在没有监听的页面上丢掉。
    if (rec.preview) sendPreview(rec);
    return statusPayload(current, rec);
  });

  ipcMain.handle('gif:action', async (event, action) => {
    const current = getActive();
    const rec = current?.recording;
    if (!rec || !barOwner(event, rec)) throw new Error('无效录制窗口');
    if (typeof action !== 'string' || !ACTIONS.has(action)) throw new Error('不支持的录制操作');
    if (current.phase === 'saving') throw new Error(rec.message || '正在输出 GIF，请稍候');
    if (action === 'stop') {
      if (current.phase === 'recording') return { ok: await finishRecording(current, rec, 'user') };
      // 准备阶段还没有可收的帧：停止等同取消，避免留下半个事务。
      if (current.phase === 'record-starting') { cancel('cancelled'); return { ok: true }; }
      return { ok: false };
    }
    if (action === 'cancel') {
      if (current.phase === 'saving') throw new Error('正在保存 GIF，请稍候');
      cancel('cancelled');
      onStatus({ message: '已取消 GIF 录制，未保存。' });
      return { ok: true };
    }
    if (action === 'edit' || action === 'edit-close') {
      if (!live(current, rec) || current.phase !== 'record-preview' || !rec.preview || rec.editJob) {
        throw new Error('当前不能切换 GIF 编辑');
      }
      await presentPreview(current, rec, action === 'edit' ? { width: 1100, height: 850 } : PREVIEW_SIZE, false);
      return { ok: true };
    }
    if (action === 'retry') return retryRecording(current, rec);
    return saveRecording(current, rec, action);
  });

  return {
    cleanup,
    dispose: () => {
      disposed = true;
      const current = getActive();
      if (current?.recording) cleanup(current);
    }
  };
}

module.exports = { installRecording, MAX_EDGE, MAX_PIXELS, MAX_RECORD_MS, MAX_GIF_BYTES, FRAME_INTERVAL_MS };
