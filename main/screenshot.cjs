'use strict';
const { BrowserWindow, desktopCapturer, screen, ipcMain, nativeImage, clipboard, ClipboardItem, dialog, globalShortcut } = require('electron');
const { Blob } = require('node:buffer');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { toPixels } = require('../core/coordinates.cjs');
const { installScrolling } = require('./scrolling.cjs');
const { createWinCapture, handleToDecimal } = require('./win-capture.cjs');
const { checkEditSize, decodeEditedImage, expectedClipboardSize, resolveEditCrop } = require('./edited-image.cjs');
const { installOcrIpc } = require('./ocr.cjs');
const { installImageEditorWindow } = require('./image-editor-window.cjs');
// 跨屏普通截图：一块隐藏窗盖住整个物理 union，一张合成图按屏逐块拼出来。
const DESKTOP_MAX_PIXELS = 36_000_000;
const RECT_KEYS = ['x', 'y', 'width', 'height'];
const sameRect = (a, b) => Boolean(a && b) && RECT_KEYS.every(key => a[key] === b[key]);

// 普通截图只取一次屏幕快照；之后从这张快照裁切，不把选区遮罩截进去。
function installScreenshot({ getControl, isProbeBusy, directory, settings, theme, onStatus, diagnostics, onLifecycle = () => {}, onCaptureEnd = () => {},
  copyGif,
  queryForeground = options => require('./foreground.cjs').queryForegroundHwnd(options),
  queryMonitor = (hint, scaleFactor) => require('./win-capture.cjs').queryMonitorBounds(hint, { scaleFactor }),
  queryWorkArea = (hint, scaleFactor) => require('./win-capture.cjs').queryMonitorWorkArea(hint, { scaleFactor }),
  fitSelectionWindow = (handle, pid, nonce, bounds) => require('./win-capture.cjs').fitSelectionWindow(handle, pid, nonce, bounds),
  fitDesktopWindow = (handle, pid, nonce, bounds) => require('./win-capture.cjs').fitDesktopWindow(handle, pid, nonce, bounds),
  checkDesktopWindow = (handle, pid, nonce, bounds) => require('./win-capture.cjs').checkDesktopWindow(handle, pid, nonce, bounds),
  createDesktopFrame = rects => require('../core/desktop-frame.cjs').createDesktopFrame(rects),
  blitDesktopFrame = (canvas, rect, frame) => require('../core/desktop-frame.cjs').blitDesktopFrame(canvas, rect, frame) }) {
  let active;
  let lastFile;
  // 嵌套截图：最多 2 层父会话挂起 + 1 层 active（总 3 层）。只存会话对象，不引入管理器；
  // 父的窗口/图片/长图/编辑文档一律原样保留，子结束后直接复用。
  const suspended = [];
  const NESTED_MAX_PARENTS = 2;
  // GIF 录制事务：会话仍归 active，录制自己的窗口/源/编码器都挂在 current.recording 上。
  let recording;
  // 独立识别任务句柄：只在会话收尾/编辑关闭/放弃时取消，不改 phase、不影响保存与取消。
  let ocr;
  // —— 单屏预备（仅 Windows 单屏）——
  // 只保存一份：原生几何缓存 + 一个延迟启动的暖源 + 一个 about:blank 隐藏窗。
  // 任何身份不符/被替换/迟到/退出都直接丢弃；start 仍按原样做实时 hint/canonical/拓扑/尺寸守卫。
  let prepared = null;
  let prepareTask = null;
  let prepareGeneration = 0;
  let prepareEnabled = false;
  let disposed = false;
  // 预载页加载必须有界：本地页面也不允许把单飞/暖源/暖窗永久挂住。
  const PREPARE_LOAD_TIMEOUT_MS = 5000;
  // 预载页自身的失败标记：renderer 崩溃/主 frame 加载失败时 BrowserWindow 可能仍 alive，
  // 不能只靠 isDestroyed 判断。只标记这一扇预载窗，不向外层 active 会话报错。
  const failedSelectionPages = new WeakSet();
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  // 生命周期留痕只写固定事件与有限字段；日志本身失败绝不能挡住截图。
  const note = (event, fields = {}) => { try { onLifecycle(event, fields); } catch { /* 留痕失败不阻断截图。 */ } };
  // —— 图片编辑宿主：一扇独立的普通窗口（有标题栏/任务栏/可缩放），原选区窗只负责框选与预览 ——
  // 依赖全部从这里传进去：node:test 用替身替换 Electron，不把真实 Electron 拉进测试进程。
  const editorHost = installImageEditorWindow({
    BrowserWindow, screen, ipcMain,
    rendererFile: path.join(__dirname, '..', 'renderer', 'image-editor-window.html'),
    preloadFile: path.join(__dirname, 'image-editor-preload.cjs'),
    iconFile: path.join(__dirname, '..', 'assets', 'app-icon.ico'),
    // 编辑窗是带自定义标题栏的不透明窗：主题只给它背景/叠加色/强调色。
    theme,
    onLifecycle: (event, fields) => note(event, fields), onStatus,
    canInteract: doc => Boolean(active && active.phase === 'selecting' && active.editorOpen === true &&
      active.editorOpening !== true && active.editDocument && active.editDocument.token === doc?.token),
    onCommit: (action, edited, doc) => commitFromEditor(action, edited, doc),
    onClose: ({ doc, payload }) => returnToPreview(doc, payload),
    // 原生 X 与预览态 Esc/右键：先拦下，走与右键/Esc 同一条确认入口；只对这一份文档所属的那一轮生效。
    onExit: (doc, source) => exitFromEditor(doc, source)
  });
  // 按下到上屏的耗时只写阶段毫秒数：哪一段慢一眼能看出，不记画面、坐标、文字或窗口标题。
  function noteTiming(current, mode) {
    const timing = current.timing;
    if (!timing) return;
    const shown = Date.now();
    timing.shownAt = shown;
    const fields = { mode, geometryMs: timing.geometryAt ? timing.geometryAt - timing.startedAt : undefined,
      snapshotMs: timing.snapshotMs, windowMs: timing.windowMs, shownMs: shown - timing.startedAt };
    if (Number.isInteger(timing.frameMs)) fields.frameMs = timing.frameMs;
    if (Number.isInteger(timing.fitMs)) fields.fitMs = timing.fitMs;
    if (Number.isInteger(timing.initMs)) fields.initMs = timing.initMs;
    if (Number.isInteger(timing.readyMs)) fields.readyMs = timing.readyMs;
    if (Number.isInteger(timing.activateMs)) fields.activateMs = timing.activateMs;
    if (Number.isInteger(timing.initReplyMs)) fields.initReplyMs = timing.initReplyMs;
    if (Number.isInteger(timing.viewportMs)) fields.viewportMs = timing.viewportMs;
    // 应用管线从冻结底图到上屏的延迟；不等于 WGC 帧本身的时刻。
    if (Number.isInteger(timing.snapshotMs)) fields.snapshotAgeMs = Math.max(0, (shown - timing.startedAt) - timing.snapshotMs);
    if (timing.geometryCached === true) fields.geometryCached = true;
    if (timing.preparedSource === true) fields.preparedSource = true;
    if (timing.preparedWindow === true) fields.preparedWindow = true;
    if (timing.preparedPage === true) fields.preparedPage = true;
    note('capture-timing', fields);
  }
  // —— 窗口状态快照（只读，不改变显示/焦点/透明性/快捷键）——
  // 只调 Electron 自己的窗口状态方法；没有这个方法、返回值不是布尔、或单项读抛错，就省略该字段，
  // 绝不填假 false，也绝不让读状态挡住截图/唤回流程。
  const WINDOW_STATE_KEYS = [['visible', 'isVisible'], ['minimized', 'isMinimized'], ['focused', 'isFocused'], ['alwaysOnTop', 'isAlwaysOnTop']];
  function windowState(win) {
    const state = {};
    if (!win) return state;
    try { if (typeof win.isDestroyed === 'function' && win.isDestroyed() === true) return state; } catch { return state; }
    for (const [key, method] of WINDOW_STATE_KEYS) {
      try {
        if (typeof win[method] !== 'function') continue;
        const value = win[method]();
        if (typeof value === 'boolean') state[key] = value;
      } catch { /* 单项读失败只省略这一项，不影响窗口与唤回。 */ }
    }
    return state;
  }
  // 选区窗事件留痕：只记固定事件名与本进程读到的状态布尔，不记 Electron 原始 event/payload。
  // 每会话最多 32 条 + 一条 selection-window-limit，避免刷盘；不因诊断去 show/raise/focus/invalidate。
  const WINDOW_EVENT_LIMIT = 32;
  const windowEventBudget = new WeakMap();
  // 选区窗重新拿到 focus 时，把丢掉的置顶属性恢复回既有设计（不改创建窗、不抢焦点、不加定时器）。
  // 条件全部来自本进程读到的状态：活的同一 selecting 会话、可见、未最小化、确实 focused、置顶确为 false。
  // 调用前 getter 缺失/非布尔、或 setter 缺失，都直接跳过（不写失败日志）；
  // setAlwaysOnTop 返回 void，恢复与否只以调用后读回的 alwaysOnTop 为准，读不到/非 true 就记失败事件，不重试。
  // 可追踪的 Windows 候选改动：显式传 'pop-up-menu'。v44.9.2 里它与默认的 floating 同映射 kFloatingWindow，
  // 区别只在 Electron 额外那个以任务栏窗口作参照的 MoveBehindTaskBarIfNeeded 分支；其余平台保持默认调用形状。
  // 真实机器上「单次 setter 后仍为 false」的根因尚未证明，日志用 recoveryLevel 区分新旧路径，不当已修复。
  const topmostRecovery = new WeakSet();
  function recoverSelectionTopmost(current, win, mode) {
    if (!win || active !== current || current.win !== win || current.phase !== 'selecting') return;
    // 图片编辑页故意不当置顶窗：编辑中丢焦点也不能把窗口重新顶回最前。
    if (current.editorOpen === true) return;
    try {
      if (win.isDestroyed() === true || typeof win.setAlwaysOnTop !== 'function') return;
      const read = method => (typeof win[method] === 'function' ? win[method]() : undefined);
      if (read('isVisible') !== true || read('isMinimized') !== false) return;
      if (read('isFocused') !== true || read('isAlwaysOnTop') !== false) return;
      if (topmostRecovery.has(current)) return;
      topmostRecovery.add(current);
      const win32 = process.platform === 'win32';
      const level = win32 ? 'pop-up-menu' : 'floating';
      let state;
      try {
        // setter 是 void、也可能静默无效：只能看调用后读回的状态，不据此下结论。
        try { if (win32) win.setAlwaysOnTop(true, level); else win.setAlwaysOnTop(true); }
        catch { /* 调用抛错也要读回一次再记固定事件。 */ }
        state = windowState(win);
      } finally { topmostRecovery.delete(current); }
      // setter 可同步触发窗口事件；会话已结束/切换阶段时，不再给旧会话记恢复结果。
      if (active !== current || current.win !== win || current.phase !== 'selecting' || win.isDestroyed() === true) return;
      note(state.alwaysOnTop === true ? 'selection-topmost-recovered' : 'selection-topmost-recovery-failed',
        { mode, phase: current.phase, recoveryLevel: level, ...state });
    } catch { /* 读状态异常按未知跳过：既不恢复，也不写失败日志。 */ }
  }
  // —— 图片编辑交接：文档交给独立宿主，成功后收起原选区窗；失败一律回原窗，成图/冻结基准/原 DOM 都不动 ——
  // 原选区窗只 hide/show，不改 bounds/透明/置顶，也不动页面里的选框与预览。
  function overlayWindow(current) {
    const win = current && current.win;
    return win && win.isDestroyed() !== true ? win : null;
  }
  function hideOverlay(current) {
    const win = overlayWindow(current);
    if (!win) throw new Error('原截图窗口已失效');
    win.hide();
    let hidden;
    try { hidden = win.isVisible() !== true; } catch { hidden = false; }
    if (!hidden) throw new Error('原截图窗口没能收起');
  }
  function showOverlay(current) {
    const win = overlayWindow(current);
    if (!win) throw new Error('原截图窗口已失效');
    win.show();
    let visible;
    try { visible = win.isVisible() === true; } catch { visible = false; }
    if (!visible) throw new Error('原截图窗口没能重新显示');
    try { win.moveTop(); win.focus(); win.webContents.invalidate(); } catch { /* 置顶/重绘失败不丢页面。 */ }
  }
  // 长截图成图 → 普通非置顶成图窗口（同窗预览，点「编辑图片」才展开工具）。
  // 只用原有编辑宿主与同一份文档/画布/历史：这里生成 doc（token/longToken/pixels/size/warning/presentation），
  // 交接成功才把原选区窗收起并清 longPreviewPending；任何失败都保留 longImage，由 scrolling 回退旧预览。
  async function openLongResult(packet) {
    const current = packet?.current;
    const token = packet?.token;
    if (!current || active !== current || current.phase !== 'selecting') return false;
    if (current.longToken !== token || current.longImage !== packet.image) return false;
    if (current.editDocument) return false;
    const rect = packet.rect;
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 2 || rect.height < 2) return false;
    let doc;
    try {
      // 与提交同一契约：长图文档用冻结基准重算像素，提交时也是这么重算的。
      const pixels = toPixels(rect, selectionBasis(current, false), current.image.getSize());
      if (pixels.width < 1 || pixels.height < 1) return false;
      if (current.mode === 'desktop' && !desktopHasContent(current, pixels)) return false;
      checkEditSize(packet.size);
      // 先把旧选区窗收起再开会成图窗：采集阶段理论上已隐藏，这里仍显式做一次，不靠上游状态。
      hideOverlay(current);
      const dataUrl = packet.image.toDataURL();
      doc = { token: randomUUID(), pixels, rect: { ...rect }, longToken: token, ...packet.size, presentation: 'long-result' };
      current.editDocument = doc;
      await openEditorHost(current, doc, { dataUrl, warning: packet.warning });
    } catch (error) {
      // 交接失败：清掉这份新文档与半成品宿主，已生成的 longImage 原样留给旧预览。
      if (current.editDocument === doc) current.editDocument = undefined;
      if (doc) editorHost.cleanup(doc.token);
      note('long-result-handoff', { ok: false, reason: 'open' });
      // 旧窗可能已被这一步收起：交回前先放回去，回退预览才真的能看。
      if (active === current && current.phase === 'selecting') { try { showOverlay(current); } catch { /* 回退显示失败也只保留数据。 */ } }
      return false;
    }
    if (active !== current || current.phase !== 'selecting' || current.editDocument !== doc) {
      editorHost.cleanup(doc.token);
      return false;
    }
    // 宿主已就绪、已上屏：从这里起长图不再是“待出预览”，退出/F1/保存都按成图窗口的规则走。
    current.longPreviewPending = false;
    note('long-result-handoff', { ok: true, width: doc.width, height: doc.height });
    return true;
  }
  // 打开编辑宿主：ready 之后才收起原窗（如有）；长图结果路径已经先 hideOverlay 过一次，这里只是兼容兜底。
  // 交接期间用 editorOpening 互斥，不让 F1/提交/录制插进来。
  async function openEditorHost(current, doc, source = {}) {
    if (active !== current || current.phase !== 'selecting') throw new Error('选区会话已结束或已切换');
    if (current.editorOpening === true) throw new Error('编辑页正在打开，请稍候');
    current.editorOpening = true;
    try { await editorHost.open(doc, source); }
    finally { current.editorOpening = false; }
    // open 期间可能结束/换轮/换文档：只给仍然属于这一轮的会话换形态，其余把这一层的宿主收掉。
    if (active !== current || current.phase !== 'selecting' || current.editDocument !== doc) {
      throw new Error('选区会话已结束或已切换');
    }
    try { hideOverlay(current); } catch (error) {
      if (source.dataUrl !== undefined) editorHost.cleanup(doc.token);
      else { try { await editorHost.close(doc.token); } catch { /* 已失效则保留失败记录。 */ } }
      throw error;
    }
    current.editorOpen = true;
    note('editor-open', { width: doc.width, height: doc.height, hasImage: source.dataUrl !== undefined });
    return true;
  }
  // 编辑窗口返回预览：收起那一层宿主、显示原选区页，再把缩略图/输出尺寸交给原页面更新预览。
  async function returnToPreview(doc, payload) {
    const current = active;
    if (!current || current.phase !== 'selecting' || !current.editDocument || current.editDocument.token !== doc.token) throw new Error('编辑会话已失效');
    const originalDoc = current.editDocument;
    const outputSize = resolveEditCrop(originalDoc, payload?.crop);
    if (payload?.outputSize?.width !== outputSize.width || payload?.outputSize?.height !== outputSize.height) throw new Error('预览输出尺寸不符');
    const thumbnail = payload?.thumbnail;
    const prefix = 'data:image/png;base64,';
    if (typeof thumbnail !== 'string' || thumbnail.length > 4500000 || !thumbnail.startsWith(prefix)) throw new Error('预览缩略图无效或过大');
    const encoded = thumbnail.slice(prefix.length);
    if (!encoded || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('预览缩略图编码无效');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length < 33) throw new Error('预览缩略图无效');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (width < 1 || width > 1000 || height < 1 || height > 800) throw new Error('预览缩略图尺寸无效');
    const scale = Math.min(1, 1000 / outputSize.width, 800 / outputSize.height);
    const expected = { width: Math.max(1, Math.floor(outputSize.width * scale)), height: Math.max(1, Math.floor(outputSize.height * scale)) };
    if (width !== expected.width || height !== expected.height) throw new Error('预览缩略图尺寸不符');
    decodeEditedImage(bytes, expected, nativeImage);
    const win = current.win;
    const wasVisible = win.isVisible();
    const oldOpen = current.editorOpen;
    try {
      showOverlay(current);
      if (active !== current || current.phase !== 'selecting' || current.editDocument !== originalDoc) throw new Error('编辑会话已失效');
      win.webContents.send('shot:editor-preview', { token: doc.token, thumbnail, outputSize, ...(payload.crop !== undefined ? { crop: payload.crop } : {}) });
      if (active !== current || current.phase !== 'selecting' || current.editDocument !== originalDoc) throw new Error('编辑会话已失效');
      current.editorOpen = false;
      ocr?.cancel(current);
    } catch (error) {
      if (active === current && current.editDocument === originalDoc) {
        current.editorOpen = oldOpen;
        if (!wasVisible && !win.isDestroyed()) { try { win.hide(); } catch {} }
      }
      throw error;
    }
    return true;
  }
  function attachSelectionWindowEvents(current, win, mode) {
    if (!win || typeof win.on !== 'function') return;
    const live = () => {
      if (active !== current || current.win !== win) return false;
      try { return win.isDestroyed() !== true; } catch { return false; }
    };
    // windowEvent 是闭包里固定的标签，不是事件对象的拷贝。
    const trace = label => {
      try {
        if (!live()) return;
        const budget = windowEventBudget.get(current) || { sent: 0, limited: false };
        windowEventBudget.set(current, budget);
        if (budget.sent >= WINDOW_EVENT_LIMIT) {
          if (!budget.limited) { budget.limited = true; note('selection-window-limit', { mode, windowEvent: label, limit: WINDOW_EVENT_LIMIT }); }
          return;
        }
        budget.sent += 1;
        note('selection-window', { mode, phase: current.phase, windowEvent: label, ...windowState(win) });
      } catch { /* 诊断失败绝不反向影响窗口行为。 */ }
    };
    for (const label of ['show', 'hide', 'focus', 'blur', 'minimize', 'restore', 'always-on-top-changed']) {
      // 先记 focus 当时的原状态（日志里能看到 false→true），再走恢复；恢复不受 32 条预算限制。
      try { win.on(label, () => { trace(label); if (label === 'focus') recoverSelectionTopmost(current, win, mode); }); } catch { /* 单个事件挂不上不影响其它诊断。 */ }
    }
  }
  const allowed = event => active && active.win && !active.win.isDestroyed() &&
    event.sender === active.win.webContents && event.senderFrame === active.win.webContents.mainFrame;
  // 页面实际视口才是选区局部坐标的唯一基准：125% 副屏上窗口回读 865 DIP，页面 innerHeight 只有 864，
  // 拿 display.bounds 直接换算会把选区压偏几个像素。尺寸只信主进程读到的视口，不信渲染进程传来的值。
  const viewportProbe = '({width: innerWidth, height: innerHeight})';
  async function readPageViewport(win) {
    const value = await win.webContents.executeJavaScript(viewportProbe);
    if (!value || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) ||
        value.width <= 0 || value.height <= 0) throw new Error('选区页面视口尺寸无效');
    return { x: 0, y: 0, width: value.width, height: value.height };
  }
  // 选区内换算一律走 ready 时读到的视口；分辨率/缩放/工作区变了就不能再用旧基准裁切。
  function selectionBasis(current, verifyDisplay = true) {
    if (!current.selectionBounds) throw new Error('选区视口基准缺失，请重新框选');
    // 已成图/编辑文档只依赖冻结时的基准，不能因拔屏或调整任务栏就阻止取走内存中的图。
    if (verifyDisplay) {
      // 跨屏模式的基准是整组屏的拓扑指纹，不是某一块 display.bounds。
      if (current.mode === 'desktop') assertTopology(current);
      else {
        const latest = screen.getAllDisplays().find(item => item.id === current.display.id);
        if (!latest || latest.scaleFactor !== current.display.scaleFactor ||
            ['x', 'y', 'width', 'height'].some(key => latest.bounds[key] !== current.display.bounds[key] ||
              latest.workArea[key] !== current.display.workArea[key])) throw new Error('显示器分辨率或缩放已变化，请重新框选');
      }
    }
    return current.selectionBounds;
  }

  // 跨屏页面在 ready 之后还会按实际 innerWidth/innerHeight 重算物理框：主进程的裁切基准必须在同一时刻重读，
  // 否则拓扑没变、视口却被定形/resize 时会选错 owner、ROI 也会偏。只给 desktop 的「新 raw 选区」用。
  async function refreshSelectionBasis(current) {
    // 先用原基准做一次拓扑严格检查：基准缺失或拓扑变了直接拒绝，不白读一次视口。
    selectionBasis(current);
    const basis = await readPageViewport(current.win);
    // 读视口是异步的：期间取消/重截/换窗口都不能把旧回包写进会话。
    if (active !== current || current.phase !== 'selecting' || !current.win || current.win.isDestroyed()) {
      throw new Error('选区会话已失效，请重新框选');
    }
    assertTopology(current);
    // 全部复核通过才原子替换；不收渲染层自报尺寸，不猜容差、不夹框。
    current.selectionBounds = basis;
    return basis;
  }

  // 拓扑指纹：屏幕集合、每块屏的 bounds/workArea/缩放/旋转都进指纹，换屏、转屏、改缩放都算变化。
  function topologyNow() {
    return screen.getAllDisplays().map(display => ({ id: String(display.id), bounds: { ...display.bounds },
      workArea: { ...display.workArea }, scaleFactor: display.scaleFactor, rotation: display.rotation ?? 0 }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  function assertTopology(current) {
    if (!current.topology || JSON.stringify(topologyNow()) !== JSON.stringify(current.topology)) throw new Error('显示器配置发生变化，请重试');
  }

  function unionOf(rects) {
    const left = Math.min(...rects.map(rect => rect.x)); const top = Math.min(...rects.map(rect => rect.y));
    const right = Math.max(...rects.map(rect => rect.x + rect.width));
    const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  // 跨屏合成图的空白区（屏与屏之间的黑洞）没有屏幕内容：只选到空洞就明确拒绝，不交一张全黑图。
  function desktopHasContent(current, pixels) {
    const frame = current.desktop.frame;
    return current.desktop.screens.some(row => row.physical.x - frame.x < pixels.x + pixels.width &&
      row.physical.x - frame.x + row.physical.width > pixels.x &&
      row.physical.y - frame.y < pixels.y + pixels.height &&
      row.physical.y - frame.y + row.physical.height > pixels.y);
  }

  // 跨屏会话里的长截图只允许「恰好被一块冻结真实屏完整包含」的选区：映射到该屏局部物理像素，
  // 跨缝、包含屏幕空隙、多块屏共同归属、拓扑变化一概原地拒绝，不改会话状态。
  async function resolveScrollSelection(current, rect) {
    if (current.mode !== 'desktop') return undefined;
    // 与静态提交同一套严格复核：union 视口基准 + 整组屏拓扑指纹，基准按页面当前实际视口重读。
    const basis = await refreshSelectionBasis(current);
    const pixels = toPixels(rect, basis, current.image.getSize());
    const frame = current.desktop.frame;
    // union 局部像素 → 绝对物理坐标，再减 owner 原点：只平移，不缩放、不夹取。
    const absolute = { x: pixels.x + frame.x, y: pixels.y + frame.y, width: pixels.width, height: pixels.height };
    const owners = current.desktop.screens.filter(row => {
      const physical = row.physical;
      return absolute.x >= physical.x && absolute.y >= physical.y &&
        absolute.x + absolute.width <= physical.x + physical.width && absolute.y + absolute.height <= physical.y + physical.height;
    });
    if (owners.length !== 1) throw new Error('选区跨屏或包含屏幕空隙，仅支持普通截图');
    const owner = owners[0];
    const nativeBounds = { x: owner.physical.x, y: owner.physical.y, width: owner.physical.width, height: owner.physical.height };
    return {
      pixels: { x: absolute.x - owner.physical.x, y: absolute.y - owner.physical.y, width: absolute.width, height: absolute.height },
      env: { display: { id: owner.display.id, scaleFactor: owner.display.scaleFactor,
        bounds: { ...owner.display.bounds }, workArea: { ...owner.display.workArea } },
        frame: { width: nativeBounds.width, height: nativeBounds.height },
        nativeBounds, nativeHint: { ...owner.hint },
        nativeWorkArea: { ...owner.nativeWorkArea }, nativeWorkHint: { ...owner.nativeWorkHint } }
    };
  }

  // 32 位 BMP：合成画布本来就是 BGRA，负高度表示自上而下，不翻行、不重采样。
  function bmp32(bgra, width, height) {
    const header = Buffer.alloc(54);
    header.write('BM', 0); header.writeUInt32LE(54 + bgra.length, 2); header.writeUInt32LE(54, 10);
    header.writeUInt32LE(40, 14); header.writeInt32LE(width, 18); header.writeInt32LE(-height, 22);
    header.writeUInt16LE(1, 26); header.writeUInt16LE(32, 28); header.writeUInt32LE(bgra.length, 34);
    const bmp = Buffer.allocUnsafe(54 + bgra.length);
    header.copy(bmp, 0); bgra.copy(bmp, 54);
    return bmp;
  }

  // —— 嵌套截图（最多 3 层）：active 仍是唯一可操作会话 ——
  // 父会话只在「活跃且稳定 selecting + 窗口还可见可截」时挂起；不靠焦点或浏览器区分，也不引入管理器。
  // 保留层占用的「图像像素」：底图 + 长图 + GIF 预览的一帧（同一对象只算一次，不数帧、不估整段解码内存）；
  // 存在但尺寸不是合法正 safeint 就拒绝（不当 0）。这是图像像素预算，不是进程总内存，也不含 DOM/多副本等其它开销。
  function retainedPixels() {
    const seen = new Set();
    let total = 0;
    const addPixels = (owner, width, height) => {
      if (owner && seen.has(owner)) return true;
      if (owner) seen.add(owner);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return false;
      total += width * height;
      return true;
    };
    const addImage = source => {
      if (!source) return true;
      const size = typeof source.getSize === 'function' ? source.getSize() : null;
      if (!size) return false;
      return addPixels(source, size.width, size.height);
    };
    for (const parent of suspended) {
      if (!addImage(parent.image)) return null;
      if (!addImage(parent.longImage)) return null;
      // GIF 预览只按一帧宽高计入；尺寸未知同样当未知拒绝。
      const preview = parent.recording?.preview;
      if (preview && !addPixels(preview, preview.width, preview.height)) return null;
    }
    return total;
  }
  // 新帧分配/采集前判预算：保留层物理像素 + 新帧像素不能超既有 36M；尺寸未知不能当 0。
  function assertFrameBudget(current, width, height) {
    if (!suspended.length) return;
    const retained = retainedPixels();
    if (retained === null) throw new Error('无法确认保留截图的像素尺寸，已收回这次叠加截图');
    const frame = Number.isSafeInteger(width * height) ? width * height : 0;
    if (frame < 1 || retained + frame > DESKTOP_MAX_PIXELS) {
      throw new Error(`叠这一层 ${width}×${height}（${frame} 像素）会超过 3600 万像素上限（保留层 ${retained} 像素）`);
    }
  }
  // 挂起层只在子窗真正上屏后才隐藏：父窗保持可见直到新帧全有效且子 ready，避免桌面闪露。
  // 隐藏必须读回确认：抛错或仍可见都算失败（父会继续盖在子窗上），由调用方回滚这一层。
  function hideSuspendedWindows() {
    for (const parent of suspended) {
      const win = sessionVisibleWindow(parent);
      if (!win) return false;
      try { win.hide(); } catch { return false; }
      let visible;
      try { visible = win.isVisible(); } catch { return false; }
      if (visible !== false) return false;
    }
    return true;
  }
  // 挂起中的父窗被关掉/渲染进程消失：只标失效（子会话继续），不在这里结束整组。
  function markSuspendedInvalid(current, reason) {
    if (suspended.indexOf(current) < 0) return;
    current.invalid = true;
    current.exitPrompt?.settle('keep');
    note('nested-parent-lost', { mode: current.mode === 'desktop' ? 'desktop' : 'single', reason });
  }
  // 会话实际展示的窗口：GIF 预览/编辑父看的是录制控制条 rec.bar（current.win 是那张已隐藏的冻图窗）。
  // 录制阶段严格只看 bar：没有 bar 就是没有窗口，绝不回退成那张隐藏冻图。
  function sessionVisibleWindow(current) {
    const rec = current?.recording;
    if (current?.phase === 'record-preview' || current?.phase === 'record-editing') {
      const bar = rec?.bar;
      return bar && !bar.isDestroyed() ? bar : null;
    }
    // 编辑中真正展示的是那一份文档的独立宿主（有自己的真实 webContents），不是那张已隐藏的全屏选区窗。
    if (current?.editorOpen === true && current.editDocument) {
      const host = editorHost.getWindow(current.editDocument.token);
      if (host && !host.isDestroyed()) return host;
    }
    return current?.win && !current.win.isDestroyed() ? current.win : null;
  }
  // GIF 页是否已经停稳、可以叠一层：稳定预览，或失败后停稳的错误/重录页（无预览帧、资源已停）。
  // 录制中/收尾中/编辑编码中/仍有 capture 或 encoder 一律不算稳定；只有 error 但 aborted 未 true 也拒绕。
  function stableGifPage(current) {
    if (current?.phase !== 'record-preview') return false;
    const rec = current.recording;
    if (!rec || rec.editJob) return false;
    if (rec.preview) return true;
    return rec.aborted === true && Boolean(rec.error) && !rec.capture && !rec.encoder;
  }
  // 叠层时，待暂停的父必须都还活着：父在采帧或 ready 前消失，子图就是「父页消失后的桌面」，不能算合法套娃图。
  function suspendedParentsAlive() {
    for (const parent of suspended) {
      if (parent.invalid) return false;
      if (!sessionVisibleWindow(parent)) return false;
    }
    return true;
  }
  // 挂起父窗收到 Esc：子层还在准备（capturing/loading）时拦下来、撤掉子准备、回到父页；
  // 子层已就绪或已结束时只拦下，不让隐藏的父页越权去动任何一层。active 自己收到时返回 false，走原语义。
  function escapeOnSuspendedParent(event, current) {
    if (active === current || suspended.indexOf(current) < 0) return false;
    event.preventDefault();
    const child = active;
    if (child && (child.phase === 'capturing' || child.phase === 'loading')) {
      child.dismissSource = 'escape-key';
      end(child, true, 'cancelled');
      onStatus({ message: '已取消这次叠加截图，回到原来的选区页。' });
    }
    return true;
  }
  // 只恢复最近的有效父；失效层跳过并释放，不复活、不 restore 它们。
  function resumeSuspendedParent() {
    while (suspended.length) {
      const parent = suspended.pop();
      // 用同一份「实际展示窗」判定：GIF 预览父看控制条，丢了 bar 就不能回它身上。
      if (parent.invalid || !sessionVisibleWindow(parent)) { releaseSession(parent); continue; }
      parent.invalid = false;
      return parent;
    }
    return null;
  }
  // 恢复父页：复用原有显示/置顶/重绘动作，不 loadFile、不重采、不重建文档。
  // show 失败不丢父会话与文档（下一次 F1 会走已有 hidden 恢复语义再试），也不对旧窗继续置顶/重绘。
  function showParentWindow(parent) {
    const win = sessionVisibleWindow(parent);
    if (!win) return;
    // 不改阶段：展示窗与阶段都保留原样（show 内的同步回调即使换了会话也不被覆盖）。
    try { win.show(); }
    catch (error) {
      // 失败不 discard：会话/文档/草稿都留着，下一次 F1 再试；调用方据此不覆盖提示。
      parent.resumeFailed = true;
      note('nested-parent-show-failed', { mode: parent.mode === 'desktop' ? 'desktop' : 'single', reason: 'show' });
      onStatus({ message: `选区页没能重新显示：${error?.message || error}；内容还在，按 F1 可再试。`, error: true });
      return;
    }
    parent.resumeFailed = false;
    // 身份检查先于进一步副作用：show 同步换轮/结束就不再对旧窗 moveTop/focus/invalidate。
    if (active !== parent || sessionVisibleWindow(parent) !== win || win.isDestroyed()) return;
    // 读回确认：show 没抛错也可能实际上没显示，不能宣称已唤回。
    let visible;
    try { visible = win.isVisible() === true; } catch { visible = false; }
    if (!visible) {
      parent.resumeFailed = true;
      note('nested-parent-show-failed', { mode: parent.mode === 'desktop' ? 'desktop' : 'single', reason: 'hidden' });
      onStatus({ message: '选区页没能重新显示：窗口仍不可见；内容还在，按 F1 可再试。', error: true });
      return;
    }
    try { win.moveTop(); win.focus(); win.webContents.invalidate(); } catch { /* 置顶/重绘失败不丢父会话。 */ }
  }
  // 只释放一层自己的窗口/采集/识别/录制/预备件；不碰别的层、不恢复窗口、不发布状态。
  function releaseSession(current) {
    current.exitPrompt?.settle('keep');
    clearTimeout(current.timer);
    current.snapshotSource?.stop();
    releaseWarm(current);
    scrolling.cleanup(current);
    recording?.cleanup(current);
    ocr?.cancel(current);
    // 只收自己那一层的编辑宿主：叠层时父/子各有自己的 token，互不扫掉。
    if (current.editDocument) editorHost.cleanup(current.editDocument.token);
    if (current.win && !current.win.isDestroyed()) current.win.destroy();
    current.image = undefined;
    current.bmpBytes = undefined;
    current.dataUrl = undefined;
    current.snapshot = undefined;
    current.desktop = undefined;
    current.longImage = undefined;
    current.editDocument = undefined;
    current.editorOpen = false;
  }
  function end(current, restore = false, reason = 'capture-end') {
    if (active !== current) return;
    // 收尾也留一行固定字段：reason 能直接看出是完成、取消、超时还是用户确认放弃后重开。
    note('capture-end', { reason, phase: current.phase });
    diagnostics?.record('capture-end', { phase: current.phase, reason, hasLongImage: Boolean(current.longImage),
      previewPending: current.longPreviewPending === true, dismissSource: current.dismissSource, ...current.commitSummary });
    active = undefined;
    // 子会话先只释放自己这一层；父的窗口/图片/编辑文档不动。
    releaseSession(current);
    // 还有挂起层就恢复最近有效父，整组没结束：不发布 idle、不预备新暖件、不动控制页。
    const parent = disposed ? null : resumeSuspendedParent();
    if (parent) { active = parent; showParentWindow(parent); return parent.resumeFailed === true ? 'resume-failed' : 'resumed'; }
    diagnostics?.end(reason);
    // 诊断未开启或已经超时也须发布最终空闲态，不能只依赖诊断end的onChange。
    try { onCaptureEnd(); } catch { /* 菜单/状态界面失败不阻断截图收尾。 */ }
    if (restore && current.restoreControl) getControl()?.show();
    // 退出路上不再预备；其余结束都异步补一份，失败不影响任何东西，start 仍可按冷路径走。
    if (prepareEnabled && !disposed && reason !== 'app-quit' && !active) {
      setTimeout(() => { try { Promise.resolve(prepare()).catch(() => {}); } catch { /* 预备失败不影响截图。 */ } }, 0);
    }
  }

  // 同页确认：只等页面绘制的 ready 限时，用户选择本身不设时限。
  async function requestCaptureExit(current, source) {
    if (!current || active !== current || current.phase !== 'selecting' || current.editorOpening || current.longPreviewPending) return false;
    const phase = current.phase, doc = current.editDocument, longToken = current.longToken;
    const win = sessionVisibleWindow(current);
    if (!win || win.isDestroyed()) return false;
    current.phase = 'exit-confirming';
    let resolve;
    const result = new Promise(done => { resolve = done; });
    const prompt = { id: randomUUID(), win, doc, longToken, ready: false, timer: null, settle: null };
    const lost = () => prompt.settle('keep');
    prompt.settle = choice => {
      if (current.exitPrompt !== prompt) return;
      current.exitPrompt = null;
      clearTimeout(prompt.timer);
      win.removeListener('closed', lost);
      win.webContents.removeListener('render-process-gone', lost);
      try { if (!win.isDestroyed()) win.webContents.send('shot:exit-confirmation', { id: prompt.id, open: false }); } catch { /* 保留原图 */ }
      resolve(choice);
    };
    current.exitPrompt = prompt;
    win.once('closed', lost);
    win.webContents.once('render-process-gone', lost);
    prompt.timer = setTimeout(() => prompt.settle('keep'), 5000);
    try { win.webContents.send('shot:exit-confirmation', { id: prompt.id, open: true }); }
    catch { prompt.settle('keep'); }
    try {
      const choice = await result;
      if (choice !== 'discard') { note('capture-exit', { source, choice: 'keep' }); return false; }
      if (active !== current || current.phase !== 'exit-confirming' || current.editDocument !== doc || current.longToken !== longToken) {
        note('capture-exit', { source, choice: 'stale' }); return false;
      }
      note('capture-exit', { source, choice: 'discard' });
      current.phase = phase;
      current.dismissSource = source;
      const outcome = end(current, true, 'cancelled');
      if (outcome !== 'resume-failed') onStatus({ message: '已取消截图。' });
      return true;
    } finally {
      if (active === current && current.phase === 'exit-confirming') current.phase = phase;
    }
  }
  ipcMain.handle('shot:exit-confirmation-reply', (event, id, choice) => {
    const current = active, prompt = current?.exitPrompt;
    if (!prompt || current.phase !== 'exit-confirming' || prompt.id !== id ||
        current.editDocument !== prompt.doc || current.longToken !== prompt.longToken ||
        sessionVisibleWindow(current) !== prompt.win || prompt.win.isDestroyed() ||
        event.sender !== prompt.win.webContents || event.senderFrame !== prompt.win.webContents.mainFrame ||
        !['ready', 'keep', 'discard'].includes(choice)) throw new Error('退出确认已失效');
    if (choice === 'ready') {
      if (prompt.ready) throw new Error('退出确认已就绪');
      prompt.ready = true;
      clearTimeout(prompt.timer);
      prompt.timer = null;
      return true;
    }
    if (!prompt.ready) throw new Error('退出确认尚未就绪');
    prompt.settle(choice);
    return true;
  });
  // 原生 X 的归属：按编辑文档 token 找到它所属的那一轮；父层被挂起（子截图当班）时只提示，绝不借父窗关闭去结束子会话。
  async function exitFromEditor(doc, source) {
    const token = doc && doc.token;
    if (!token) return false;
    const from = source === 'context-menu' || source === 'escape-key' ? source : 'window-close';
    if (active && active.editDocument && active.editDocument.token === token) return requestCaptureExit(active, from);
    const parent = suspended.find(item => item.editDocument && item.editDocument.token === token);
    if (parent) {
      onStatus({ message: '当前还有一层截图在进行，先完成或取消它，再关闭这层编辑窗口。', error: true });
      return false;
    }
    return false;
  }

  const scrolling = installScrolling({ getActive: () => active, allowed,
    // 只给不透明浮条上色；遮罩是透明窗，不入主题。
    theme,
    cancel: (reason = 'cancelled') => { if (active && active.phase !== 'saving') end(active, true, reason); }, onStatus, diagnostics,
    // 长截图成功后直接把成图交给普通成图窗口；成功后不再发旧 complete、也不 show 旧选区窗。
    onLongResult: packet => openLongResult(packet),
    // 跨屏会话里的单屏长截图归属由主进程判定，渲染层无权自报 owner。
    resolveSelection: (current, rect) => resolveScrollSelection(current, rect) });
  // GIF 录制：录制事务、控制条/边框窗、原生源与编码器都在 recording.cjs；这里只交会话、选区归属和保存入口。
  // 用绝对路径 require：本文件的测试夹具按路径白名单替换依赖，相对路径会被解析到 test/ 下。
  const { installRecording } = require(path.join(__dirname, 'recording.cjs'));
  recording = installRecording({ getActive: () => active, allowed, onStatus, ipcMain, screen, BrowserWindow, globalShortcut,
    // 录制控制条（兼预览）是不透明 UI 窗；边框窗保持自己的颜色。
    theme,
    // 控制条就是 GIF 预览父的实际展示窗：它消失/挂起父按 Esc 都要先告知截图会话（窗口已挂起时 recording 会早退）。
    onWindowLost: (current, rec, reason) => markSuspendedInvalid(current, reason),
    onSuspendedEscape: (current, event) => escapeOnSuspendedParent(event, current),
    // 取消整轮录制：先结束会话（end 里再统一收掉录制窗口/源/编码器），不碰保存中的事务。
    cancel: (reason = 'cancelled') => {
      if (!active || active.phase === 'saving') return false;
      active.dismissSource = 'gif-cancel';
      end(active, true, reason);
      return true;
    },
    // GIF 保存成功：收掉事务但不把设置窗弹回来，与 PNG 保存成功同语义。
    finishSession: (current, reason = 'completed') => { if (active !== current) return false; end(current, false, reason); return true; },
    // 跨屏会话里的单屏录制沿用长截图那套 owner 复核：落在一屏内允许，跨屏/空隙拒绝。
    resolveSelection: (current, rect) => resolveScrollSelection(current, rect),
    resolveSaveFolder: () => typeof settings?.resolveSaveFolder === 'function' ? settings.resolveSaveFolder(directory) : directory,
    resolveAsFolder: () => typeof settings?.resolveAsFolder === 'function'
      ? settings.resolveAsFolder(lastFile ? path.dirname(lastFile) : directory)
      : (lastFile ? path.dirname(lastFile) : directory),
    onSaved: async (file, { action }) => {
      lastFile = file;
      if (action === 'save') {
        try { await settings?.update?.({ lastSaveFolder: path.dirname(file) }); } catch { /* 记目录失败不挡保存。 */ }
      }
    },
    copyGif,
    showSaveDialog: (owner, options) => dialog.showSaveDialog(owner, options),
    // 录制阶段的留痕只走 lifecycle：固定字段、无像素/坐标/路径，写不进去也不影响录制。
    onLifecycle: (event, fields) => note(event, fields),
    writeFile: (file, bytes, options) => fs.writeFile(file, bytes, options) });

  // 已有会话时的重入：有效 active 绝不静默丢弃。只有「用户明确选放弃」才结束旧会话；
  // 准备中、保存中、长截中、探针未知都保留原会话与内存里的源图/长图/编辑文档。
  const BUSY_PHASES = new Set(['saving', 'exporting', 'scroll-starting', 'scrolling', 'scroll-finishing']);
  // 一次性的轻量 DOM 健康读：只回一个布尔，不读文字、图片、URL、rect 内容。
  // 只判断 DOM/源图是否就绪，不能确认物理画面已经上屏；任何时候都不作为丢图依据。
  const healthProbe = `(() => {
    const desktop = document.getElementById('desktop');
    const hint = document.getElementById('hint');
    const box = hint ? hint.getBoundingClientRect() : null;
    return { ready: document.readyState === 'complete' &&
      Boolean(desktop) && desktop.complete === true && desktop.naturalWidth > 0 && desktop.naturalHeight > 0 &&
      Boolean(hint) && Boolean(box) && box.width > 0 && box.height > 0 &&
      window.innerWidth > 0 && window.innerHeight > 0 };
  })()`;
  const PROBE_TIMEOUT_MS = 1500;
  const PROBE_TIMEOUT = Symbol('probe-timeout');
  // 读一次就完，不挂心跳；一次 Promise.race，finally 里清定时器。
  // 超时只说明状态未知，并不能证明页面没有资产。
  async function probeDrawable(win) {
    let timer;
    try {
      const answer = await Promise.race([win.webContents.executeJavaScript(healthProbe),
        new Promise(resolve => { timer = setTimeout(() => resolve(PROBE_TIMEOUT), PROBE_TIMEOUT_MS); })]);
      if (answer === PROBE_TIMEOUT) return 'timeout';
      if (answer && answer.ready === true) return 'drawable';
      if (answer && answer.ready === false) return 'blocked';
      // 回包形状不对（旧协议、注入失败）只算未知：不当成健康，也不据此丢图。
      return 'unknown';
    } catch { return 'throw'; } finally { clearTimeout(timer); }
  }
  // 未能确认窗口恢复时询问一次；超时或未知都不证明资产已丢失，默认保留。
  // 确认框不挂在可能已隐藏/图形失效的全屏 always-on-top 选区窗上：先临时 hide（保留页面/源图/标注，
  // 不 destroy/reload/改 bounds），再用无 parent 的普通对话框问；问完只在会话仍属这一轮时把原窗放回去。
  async function askRestart(current) {
    // 实际展示窗：编辑中是独立宿主，不是那张已隐藏的全屏选区窗。
    const win = sessionVisibleWindow(current);
    const live = () => active === current && current.phase === 'selecting' && sessionVisibleWindow(current) === win;
    // 超时/未知只说明未能确认恢复，不能写成确定无响应。
    const options = { type: 'warning', title: '截图窗口未恢复',
      message: '当前截图窗口未能确认恢复。放弃后会丢失未保存的选框、长图或标注。',
      buttons: ['保留当前截图', '放弃并重新截图'], defaultId: 0, cancelId: 0, noLink: true };
    let hidden = false;
    if (win && !win.isDestroyed()) {
      // hide 失败也不能自动 discard：只是提示可能仍被盖住，数据照旧保留。
      try { win.hide(); hidden = true; } catch { /* 收不起来也照常问。 */ }
    }
    let response = -1;
    try {
      // 无 parent：不让旧全屏窗盖住提示，也不因 parent 已失效而弹不出来。
      const answer = await dialog.showMessageBox(options);
      // 返回值不认识（null/缺 response/抛错）一律当保留。
      response = Number.isInteger(answer?.response) ? answer.response : -1;
    } catch { response = -1; }
    // confirm 放弃时不再把旧窗闪回来；其余情况只在仍是同一轮时尝试还原。
    if (response !== 1 && hidden && live() && !win.isDestroyed()) {
      try { win.show(); win.moveTop(); win.focus(); win.webContents.invalidate(); } catch { /* 还原失败只保留数据。 */ }
    }
    return response;
  }
  // 旧会话唤回只追加“距上次上屏多久”的毫秒数，不改任何 UI 行为。
  function restoreResult(current, mode, probe, action) {
    const shownAt = current?.timing?.shownAt;
    const ageMs = Number.isInteger(shownAt) ? Math.max(0, Date.now() - shownAt) : undefined;
    note('restore-result', { mode, probe, action, ...(Number.isInteger(ageMs) ? { ageMs } : {}) });
  }
  // 唤回已有选区：只 restore/show/moveTop/focus + 整窗重绘（Electron 44 invalidate 支持全窗重绘），
  // 不改 bounds、不重采样、不 reload，页面里的选框/长图/编辑文档全部保留。
  async function restoreCapturedSelection(current, mode) {
    // 编辑中真正展示的是独立编辑宿主；唤回/探针都看它，不拿已隐藏的全屏窗冒充可见。
    const win = sessionVisibleWindow(current);
    // 旧回包只认这一轮：active/会话/selecting 阶段/展示窗三者都还得对得上。
    const live = () => active === current && current.phase === 'selecting' && sessionVisibleWindow(current) === win;
    if (!live()) { restoreResult(current, mode, 'stale', 'none'); return { restart: false }; }
    let gone = !win || win.isDestroyed();
    // minimized/visible 仍是“读不到就 false”的旧语义；focused/alwaysOnTop 是新补的布尔快照，未知就省略。
    const state = gone ? {} : windowState(win);
    const minimized = state.minimized === true;
    const visible = state.visible === true;
    note('restore-attempt', { mode, phase: current.phase, minimized, visible,
      ...(typeof state.focused === 'boolean' ? { focused: state.focused } : {}),
      ...(typeof state.alwaysOnTop === 'boolean' ? { alwaysOnTop: state.alwaysOnTop } : {}) });
    if (!gone) {
      try {
        if (minimized) win.restore();
        win.show();
        win.moveTop();
        win.focus();
        win.webContents.invalidate();
      } catch { /* 恢复动作失败交给下面的可见性与探针判定，不在这里丢会话。 */ }
    }
    if (!live()) { restoreResult(current, mode, 'stale', 'none'); return { restart: false }; }
    gone = gone || win.isDestroyed();
    const shown = !gone && win.isVisible() === true;
    // 编辑页有自己的根节点/画布，不能拿原选区页的 #hint 假判。
    const probe = gone ? 'gone' : !shown ? 'hidden'
      : current.editorOpen === true && current.editDocument ? await editorHost.probe(current.editDocument.token) : await probeDrawable(win);
    // await 之后复核：探针期间取消/关窗/转 saving/scrolling，旧回包一律不再动会话。
    if (!live()) { restoreResult(current, mode, 'stale', 'none'); return { restart: false }; }
    // 只有明确 drawable 才算唤回；形状未知一律走同一个默认保留的确认，不自动丢。
    if (probe === 'drawable') {
      restoreResult(current, mode, probe, 'resumed');
      // 只声明尝试过唤回与未清内容，不宣称透明窗已实测恢复。
      onStatus({ message: '已尝试唤回当前截图，未清除内容。' });
      return { restart: false };
    }
    restoreResult(current, mode, probe, 'dialog');
    const response = await askRestart(current);
    if (!live()) { note('restore-choice', { mode, choice: 'stale' }); return { restart: false }; }
    if (response !== 1) {
      // 取消、无回应、对话框失败都只保留：不清源图，不丢选框/长图。
      note('restore-choice', { mode, choice: 'keep' });
      onStatus({ message: '已保留当前截图数据，没有重新截图。' });
      return { restart: false };
    }
    note('restore-choice', { mode, choice: 'restart' });
    // end 前最后一次确认：active 仍是这一轮、phase 仍是 selecting（保存/长截中绝不终止）。
    // 不先恢复旧入口控制页：否则下一步 start({hideControl:false}) 会把本程序设置窗框进底图。
    end(current, false, 'restart-confirmed');
    return { restart: true };
  }
  // —— 单屏预备实现 ——
  function selectionWindowOptions(display) {
    return { ...display.bounds, show: false, frame: false, resizable: false,
      movable: false, roundedCorners: false, thickFrame: false, enableLargerThanScreen: true,
      alwaysOnTop: true, skipTaskbar: true, transparent: true, backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
        backgroundThrottling: false, preload: path.join(__dirname, 'selection-preload.cjs') } };
  }
  function lockSelectionWindow(win) {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
  }
  function createSelectionWindow(display) {
    const win = new BrowserWindow(selectionWindowOptions(display));
    // 预载的页面从一开始就要锁住导航/弹窗，不能等到真正消费时才挂。
    lockSelectionWindow(win);
    // 预载阶段的页面自身失败：只记在这一扇窗上，真正消费时的交互处理由 openSelectionWindow 挂。
    win.webContents.on('render-process-gone', () => { failedSelectionPages.add(win); });
    win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame === false) return;
      failedSelectionPages.add(win);
    });
    return win;
  }
  function displayIdentity(display) {
    return { id: display.id, bounds: { ...display.bounds }, workArea: { ...display.workArea }, scaleFactor: display.scaleFactor };
  }
  function sameDisplayIdentity(display, identity) {
    return Boolean(display) && Boolean(identity) && display.id === identity.id && display.scaleFactor === identity.scaleFactor &&
      ['x', 'y', 'width', 'height'].every(key => display.bounds[key] === identity.bounds[key] && display.workArea[key] === identity.workArea[key]);
  }
  function sameRect(a, b) {
    return Boolean(a) && Boolean(b) && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]);
  }
  function liveHint(display) { return screen.dipToScreenRect(null, display.bounds); }
  function liveWorkHint(display) { return screen.dipToScreenRect(null, display.workArea); }
  function releasePrepared(state) {
    if (!state) return;
    try { state.source?.stop?.(); } catch { /* 已退出就不用再停。 */ }
    state.source = undefined;
    const win = state.win;
    state.win = undefined;
    if (win && !win.isDestroyed()) { try { win.destroy(); } catch { /* 销毁失败也不能拦住下一步。 */ } }
  }
  // 预备件只有一份；单次使用。身份不符时先释放再重建，绝不让死源/旧窗被当成命中。
  function preparedMatches(state) {
    if (!state || state.generation !== prepareGeneration || disposed) return false;
    if (!state.source || state.source.alive !== true || state.source.status === 'failed') return false;
    const win = state.win;
    if (win && (failedSelectionPages.has(win) || win.isDestroyed() || win.webContents?.isDestroyed?.() === true ||
        (typeof win.webContents?.isCrashed === 'function' && win.webContents.isCrashed() === true))) return false;
    const displays = screen.getAllDisplays();
    if (displays.length !== 1) return false;
    const display = displays[0];
    if (!sameDisplayIdentity(display, state.display)) return false;
    if (JSON.stringify(topologyNow()) !== state.topology) return false;
    return sameRect(liveHint(display), state.hint) && sameRect(liveWorkHint(display), state.workHint);
  }
  function releaseWarm(current) {
    const warm = current?.warm;
    if (!warm) return;
    current.warm = undefined;
    try { warm.source?.stop?.(); } catch { /* 已退出就不用再停。 */ }
    const win = warm.window;
    if (win && win !== current.win && !win.isDestroyed()) { try { win.destroy(); } catch { /* 销毁失败不拦住收尾。 */ } }
  }
  // 取走预备件；之后它要么被使用，要么由 releaseWarm 回收。
  function takePrepared(current) {
    const state = prepared;
    if (!state) return false;
    if (!preparedMatches(state)) { releasePrepared(state); prepared = null; prepareGeneration++; return false; }
    prepared = null;
    current.warm = { source: state.source, window: state.win, pageLoaded: state.pageLoaded === true,
      geometry: { display: { ...state.display, bounds: { ...state.display.bounds }, workArea: { ...state.display.workArea } },
        nativeBounds: { ...state.nativeBounds }, nativeWorkArea: { ...state.nativeWorkArea },
        nativeHint: { ...state.hint }, nativeWorkHint: { ...state.workHint } } };
    state.source = undefined;
    state.win = undefined;
    return true;
  }
  // 只预建一份：原生几何缓存 + lazy 暖源 + 已载入 selection.html 的隐藏窗。
  // 页面会停在 preload 的激活门槛上：不取帧、不发 shot:init、不上屏、不 fit。
  async function prepare() {
    if (disposed) return { prepared: false, reason: 'disposed' };
    // 环境已不支持（掉到 0 屏/多屏）时也要先把旧预备件收掉，
    // 否则它要一直留到 dispose，或下一次真正可预建时才被替换。
    if (prepared && !preparedMatches(prepared)) { releasePrepared(prepared); prepared = null; prepareGeneration++; }
    if (process.platform !== 'win32' || screen.getAllDisplays().length !== 1) return { prepared: false, reason: 'unsupported' };
    prepareEnabled = true;
    if (prepared) return { prepared: true, reused: true };
    if (prepareTask) return prepareTask;
    if (active || isProbeBusy()) return { prepared: false, reason: 'busy' };
    const generation = ++prepareGeneration;
    const task = (async () => {
      const display = screen.getAllDisplays()[0];
      const identity = displayIdentity(display);
      const topology = JSON.stringify(topologyNow());
      const hint = liveHint(display), workHint = liveWorkHint(display);
      const stillValid = () => {
        if (disposed || generation !== prepareGeneration || active || isProbeBusy()) return false;
        const displays = screen.getAllDisplays();
        if (displays.length !== 1 || !sameDisplayIdentity(displays[0], identity)) return false;
        return JSON.stringify(topologyNow()) === topology && sameRect(liveHint(displays[0]), hint) && sameRect(liveWorkHint(displays[0]), workHint);
      };
      let nativeBounds, nativeWorkArea;
      try {
        [nativeBounds, nativeWorkArea] = await Promise.all([
          queryMonitor(hint, display.scaleFactor), queryWorkArea(workHint, display.scaleFactor)]);
      } catch { return { prepared: false, reason: 'geometry' }; }
      if (!stillValid()) return { prepared: false, reason: 'stale' };
      let source;
      try { source = createWinCapture(nativeBounds, { purpose: 'snapshot', deferredStart: true }); }
      catch { return { prepared: false, reason: 'source' }; }
      const discard = reason => { try { source.stop(); } catch { /* 已退出就不用再停。 */ } return { prepared: false, reason }; };
      if (source.alive !== true) return discard('source-exited');
      let win;
      try {
        win = createSelectionWindow(display);
        let loadTimer;
        const loadDeadline = new Promise((resolve, reject) => {
          loadTimer = setTimeout(() => reject(new Error('预载页加载超时')), PREPARE_LOAD_TIMEOUT_MS);
        });
        try { await Promise.race([win.loadFile(path.join(__dirname, '..', 'renderer', 'selection.html')), loadDeadline]); }
        finally { clearTimeout(loadTimer); }
        // 加载完成但主 frame 已报失败（或 renderer 已崩溃）：不留这扇窗。
        if (failedSelectionPages.has(win)) throw new Error('预载页加载失败');
      } catch {
        if (win && !win.isDestroyed()) { try { win.destroy(); } catch { /* 销毁失败也不能留下空白窗。 */ } }
        return discard('window');
      }
      if (!stillValid()) {
        if (win && !win.isDestroyed()) { try { win.destroy(); } catch { /* 丢弃即可。 */ } }
        return discard('stale');
      }
      if (failedSelectionPages.has(win)) {
        if (!win.isDestroyed()) { try { win.destroy(); } catch { /* 丢弃即可。 */ } }
        return discard('page-failed');
      }
      const previous = prepared;
      prepared = { generation, topology, display: identity, hint: { ...hint }, workHint: { ...workHint },
        nativeBounds: { ...nativeBounds }, nativeWorkArea: { ...nativeWorkArea }, source, win, pageLoaded: true };
      if (previous) releasePrepared(previous);
      return { prepared: true };
    })();
    prepareTask = task;
    try { return await task; } finally { if (prepareTask === task) prepareTask = null; }
  }

  // start / startDesktop 共用的重入处理。返回值 restart 只交给发起这一轮的调用方：
  // 连按快捷键的其余按键只等同一份恢复结果，既不会二次探针，也不会双重新开截图。
  async function handleExistingCapture(mode) {
    const current = active;
    if (!current) return { restart: false };
    if (current.phase === 'capturing' || current.phase === 'loading') {
      // 原生 fit 必须发生在隐藏窗上：这里不 show、不动控制页，也不显示任何隐藏准备窗。
      note('active-branch', { mode, phase: current.phase, action: 'preparing' });
      onStatus({ message: '截图正在准备中，稍等即可框选。' });
      return { restart: false };
    }
    // 编辑宿主还在就绪握手中：这一段既不能叠层也不能重开，否则会出现两层编辑/半迁移。
    if (current.editorOpening === true) {
      note('active-branch', { mode, phase: current.phase, action: 'busy' });
      onStatus({ message: '图片编辑正在打开，稍等一下。', error: true });
      return { restart: false };
    }
    // 录制/预览期间 F1 只回一句忙：不唤回、不展示那张已隐藏的冻结窗，也不碰录制事务。
    // GIF 页（稳定预览或停稳的错误/重录页）且实际控制条被隐藏（例如上次 show 失败）：F1 走同一 show 恢复并读回确认，
    // 不显旧冻图、不丢草稿；只有真显示成功才算唤回。其余录制阶段仍走下面的忙分支。
    if (stableGifPage(current)) {
      const bar = sessionVisibleWindow(current);
      let hidden = false;
      if (bar) { try { hidden = bar.isVisible() !== true; } catch { hidden = false; } }
      if (hidden) {
        note('active-branch', { mode, phase: current.phase, action: 'restore' });
        showParentWindow(current);
        if (current.resumeFailed !== true) onStatus({ message: '已尝试唤回 GIF 预览，未清除草稿。' });
        return { restart: false };
      }
    }
    if (current.recording) {
      note('active-branch', { mode, phase: current.phase, action: 'busy' });
      onStatus({ message: '正在录制或预览 GIF，完成后再按 F1。', error: true });
      return { restart: false };
    }
    if (BUSY_PHASES.has(current.phase)) {
      // 保存/长截各阶段：会话、采集、焦点都不动，只报实际忙的阶段，不新开窗、不弹 dialog。
      note('active-branch', { mode, phase: current.phase, action: 'busy' });
      onStatus({ message: current.phase === 'saving'
        ? '正在保存或复制当前截图，完成后再按 F1。'
        : current.phase === 'exporting'
          ? '正在向编辑窗口取导出结果，完成后再按 F1。'
          : '正在生成长截图，进行中不能重开；等它完成或按 Esc 收起。', error: true });
      return { restart: false };
    }
    if (current.phase !== 'selecting') {
      note('active-branch', { mode, phase: 'other', action: 'busy' });
      // 退出确认中不重开、不唤回：先让用户在原生对话框里选完。
      onStatus({ message: current.phase === 'exit-confirming'
        ? '正在等待退出确认，请先在弹窗里选择保留或放弃。'
        : '当前截图还在进行，稍后再试。', error: true });
      return { restart: false };
    }
    // 长图预览还在生成：这一段既不能叠层（preview-ready 会被 active 门拒），也不该弹恢复框，继续报忙。
    if (current.longImage && current.longPreviewPending === true) {
      note('active-branch', { mode, phase: current.phase, action: 'busy' });
      onStatus({ message: '长图预览还在生成，稍等一下再按 F1。', error: true });
      return { restart: false };
    }
    note('active-branch', { mode, phase: current.phase, action: 'restore' });
    const initiator = !current.restoring;
    if (initiator) current.restoring = restoreCapturedSelection(current, mode);
    const pending = current.restoring;
    let result = { restart: false };
    try { result = await pending; } catch { result = { restart: false }; }
    // 只清自己那一轮：期间新一轮恢复已经挂上时不能把它的 single-flight 抹掉。
    finally { if (current.restoring === pending) current.restoring = undefined; }
    return { restart: initiator && result.restart === true };
  }

  // nested 入口判定：只在「活跃且稳定的 selecting + 窗口还可见可截」时叠一层；
  // 其余（准备中/保存中/长截/GIF/隐藏/已毁/验证中）交回旧恢复或旧忙保护，不按焦点或程序分流。
  function nestedDecision() {
    if (!active) return { action: 'root' };
    if (isProbeBusy()) return { action: 'legacy' };
    // 编辑页就绪握手中：不叠层、不唤回，交回旧恢复/忙保护。
    if (active.editorOpening === true) return { action: 'legacy' };
    const win = sessionVisibleWindow(active);
    if (!win) return { action: 'legacy' };
    let visible;
    try { visible = win.isVisible() === true; } catch { visible = false; }
    if (!visible) return { action: 'legacy' };
    if (active.phase !== 'selecting' && !(active.phase === 'exit-confirming' && active.exitPrompt?.ready === true)) {
      // GIF 页：稳定预览或停稳的错误/重录页才允许叠一层；录制/收尾/编辑/保存等仍报忙。
      if (!stableGifPage(active)) return { action: 'legacy' };
    }
    // 长图预览还没 ready 的窗口期入栈会让 preview-ready 被 active 门拒：这一段继续报忙。
    if (active.longImage && active.longPreviewPending === true) return { action: 'legacy' };
    if (suspended.length >= NESTED_MAX_PARENTS) return { action: 'refused' };
    return { action: 'suspend' };
  }
  const NESTED_LIMIT_MESSAGE = `最多叠 ${NESTED_MAX_PARENTS + 1} 层截图，先完成或取消当前这层。`;

  async function start({ hideControl = true, nested = false } = {}) {
    // Windows 多屏：任何入口（含 F1）都先盖住整组屏，框选后按范围出图；单屏仍走原路径。
    if (process.platform === 'win32' && screen.getAllDisplays().length > 1) return startDesktop({ hideControl, nested });
    note('capture-request', { mode: 'single', hideControl: hideControl === true });
    const decision = nested ? nestedDecision() : { action: 'legacy' };
    if (decision.action === 'refused') { onStatus({ message: NESTED_LIMIT_MESSAGE, error: true }); return; }
    if (decision.action !== 'suspend' && (active || isProbeBusy())) {
      // 有效会话绝不静默丢：能唤回就唤回，只有用户明确确认放弃才重新开始。
      if (active) {
        const outcome = await handleExistingCapture('single');
        if (!outcome.restart) return;
        // 旧会话已按原恢复语义 end，重新进入原 start，保留本次 hideControl。
        return start({ hideControl });
      }
      onStatus({ message: '正在截图或验证，请先完成当前操作。', error: true });
      return;
    }
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    // 只在内存里记阶段完成时刻，结论写成固定字段的毫秒数，不记画面、坐标或文字。
    const current = { display, restoreControl: hideControl && getControl()?.isVisible(), phase: 'capturing', foregroundHwnd: 0,
      timing: { startedAt: Date.now() } };
    // 命中预备件就带上它的几何缓存/暖源/暖窗；不命中或已失效则完全走原冷路径。
    takePrepared(current);
    // 先入挂起层再设 active：父页的 IPC 立刻被 allowed 拒绕，不会与子会话争抢。
    if (decision.action === 'suspend') {
      const parent = active;
      current.nested = true;
      // 整组的「取消后回到设置页」意图跟着后代走：父或更上层带过 restoreControl 就继承。
      if (parent.restoreControl === true || suspended.some(entry => entry.restoreControl === true)) current.restoreControl = true;
      suspended.push(parent);
    }
    active = current;
    // Ask for the window that owns input right now; the selection window is about to take it.
    // An unresolved or zero handle only means the bridge skips the hand-back hint.
    try {
      Promise.resolve(queryForeground()).then(value => {
        if (active === current && Number.isSafeInteger(value) && value > 0) current.foregroundHwnd = value;
      }).catch(() => {});
    } catch { /* Hint failure never blocks the capture. */ }
    diagnostics?.record('capture-start', { displayId: display.id, width: display.bounds.width, height: display.bounds.height, scaleFactor: display.scaleFactor });
    current.timer = setTimeout(() => {
      end(current, true, 'timeout');
      onStatus({ message: '截图准备超时，已收回，可重新按 F1。', error: true });
    }, 15000);
    // 页面/托盘入口让设置窗口退场；快捷键保留眼前画面，也不先改窗口里的状态文案。
    if (hideControl) {
      onStatus({ message: '正在准备框选，松手固定，再选择保存或复制。' });
      getControl()?.hide();
    }
    try {
      // 只有可见控制页需要等待退场；托盘 F1 不应固定多等一拍。
      if (current.restoreControl) await delay(220);
      if (active !== current) return;
      // 开窗和取帧互不依赖：并行开工，不再等截图像素全准备好才建窗。
      current.snapshot = captureSnapshot(current);
      await Promise.all([current.snapshot, openSelectionWindow(current)]);
    } catch (error) {
      if (active !== current) return;
      diagnostics?.record('worker-error', { phase: current.phase, errorName: error.name, errorMessage: error.message });
      end(current, true, 'failed');
      onStatus({ message: `截图未完成：${error.message}`, error: true });
    }
  }

  // 跨屏普通截图：一次快照所有屏、拼一张物理 union 合成图，再用一块隐藏窗盖住整组屏。
  // 与单屏不同，这里必须先 await 元数据和合成图，才能知道窗口该多大；单屏仍保留并行。
  async function startDesktop({ hideControl = true, nested = false } = {}) {
    note('capture-request', { mode: 'desktop', hideControl: hideControl === true });
    const decision = nested ? nestedDecision() : { action: 'legacy' };
    if (decision.action === 'refused') { onStatus({ message: NESTED_LIMIT_MESSAGE, error: true }); return; }
    if (decision.action !== 'suspend' && (active || isProbeBusy())) {
      if (active) {
        const outcome = await handleExistingCapture('desktop');
        if (!outcome.restart) return;
        return startDesktop({ hideControl });
      }
      onStatus({ message: '正在截图或验证，请先完成当前操作。', error: true });
      return;
    }
    // 单屏没有跨屏可言：明确拒绝，不默默去采一屏。
    if (screen.getAllDisplays().length < 2) {
      onStatus({ message: '只有一块屏幕，跨屏截图用不上；请用普通截图或 F1 长截图。', error: true });
      return;
    }
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const control = getControl();
    // 跨屏会把本程序设置窗也算进画面，所以只要它现在可见就先收起来，取消时才恢复。
    // F1 与旧单屏同语义：不动控制页、不改窗口里的状态文案。
    const restoreControl = Boolean(hideControl && control?.isVisible());
    const current = { display, mode: 'desktop', restoreControl, phase: 'capturing', foregroundHwnd: 0,
      timing: { startedAt: Date.now() } };
    // 先入挂起层再设 active：父页的 IPC 立刻被 allowed 拒绕。
    if (decision.action === 'suspend') {
      const parent = active;
      current.nested = true;
      // 整组的「取消后回到设置页」意图跟着后代走。
      if (parent.restoreControl === true || suspended.some(entry => entry.restoreControl === true)) current.restoreControl = true;
      suspended.push(parent);
    }
    active = current;
    try {
      Promise.resolve(queryForeground()).then(value => {
        if (active === current && Number.isSafeInteger(value) && value > 0) current.foregroundHwnd = value;
      }).catch(() => {});
    } catch { /* 提示失败不影响跨屏截图。 */ }
    diagnostics?.record('capture-start', { mode: 'desktop', displayId: display.id, width: display.bounds.width,
      height: display.bounds.height, scaleFactor: display.scaleFactor });
    current.timer = setTimeout(() => {
      end(current, true, 'timeout');
      onStatus({ message: '跨屏截图准备超时，已收回，可重新开始。', error: true });
    }, 20000);
    if (restoreControl) {
      onStatus({ message: '正在准备跨屏截图，请稍候…' });
      try { control.hide(); } catch { /* 隐藏失败仍试一下采集，但不会把设置窗当成功。 */ }
      await delay(220);
    }
    try {
      if (active !== current) return;
      current.topology = topologyNow();
      const screens = await desktopScreens(current);
      if (active !== current) return;
      // 预算在分配任何画布之前判：超 36M 就只报错，不开始一屏采集。
      const union = unionOf(screens.map(row => row.physical));
      const pixels = union.width * union.height;
      if (!Number.isSafeInteger(pixels) || pixels > DESKTOP_MAX_PIXELS) {
        throw new Error(`跨屏范围 ${union.width}×${union.height}（${pixels} 像素）超出 3600 万像素上限，请降低分辨率后重试`);
      }
      // 叠加层时保留父图也算进同一份 36M 预算，超限不开始采集。
      assertFrameBudget(current, union.width, union.height);
      current.desktop = { screens, frame: union };
      // 采集与建窗只差同一个 union，两者并行：页面 init 会等同一份快照结果，上屏时机不变。
      current.snapshot = captureDesktopSnapshot(current);
      await Promise.all([current.snapshot, openDesktopWindow(current)]);
    } catch (error) {
      if (active !== current) return;
      diagnostics?.record('worker-error', { phase: current.phase, errorName: error.name, errorMessage: error.message });
      end(current, true, 'failed');
      onStatus({ message: `跨屏截图未完成：${error.message}`, error: true });
    }
  }

  // 每块屏的真实物理矩形：只信原生查询，不把 Electron 的 DIP 坐标或 hint 当 canonical。
  async function desktopScreens(current) {
    const displays = screen.getAllDisplays();
    if (displays.length < 2) throw new Error('只有一块屏幕，请用普通截图或 F1 长截图');
    const rows = [];
    for (const display of displays) {
      const hint = screen.dipToScreenRect(null, display.bounds);
      const workHint = screen.dipToScreenRect(null, display.workArea);
      if (!hint || !workHint) throw new Error('未能确认显示器真实像素范围，请重试');
      let answers;
      try { answers = await Promise.all([queryMonitor(hint, display.scaleFactor), queryWorkArea(workHint, display.scaleFactor)]); }
      catch { throw new Error('未能确认显示器真实像素范围，请重试'); }
      if (active !== current) return rows;
      const [physical, work] = answers;
      if (!physical || !work || work.x < physical.x || work.y < physical.y ||
          work.x + work.width > physical.x + physical.width || work.y + work.height > physical.y + physical.height) {
        throw new Error('显示器工作区不在监视器内，请重试');
      }
      rows.push({ display: { id: display.id, scaleFactor: display.scaleFactor,
        bounds: { x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height },
        workArea: { x: display.workArea.x, y: display.workArea.y, width: display.workArea.width, height: display.workArea.height } },
        hint: { ...hint }, physical: { x: physical.x, y: physical.y, width: physical.width, height: physical.height },
        nativeWorkArea: { x: work.x, y: work.y, width: work.width, height: work.height },
        nativeWorkHint: { x: workHint.x, y: workHint.y, width: workHint.width, height: workHint.height } });
    }
    // 查询是异步的：期间换屏/拔屏就必须放弃，不能拿半新半旧的物理矩形去拼。
    assertTopology(current);
    return rows;
  }

  // 逐屏取第一帧并搬进 union 画布：只同时存在一个原生 source，不把整组屏的帧都留在内存里。
  async function captureDesktopSnapshot(current) {
    const { screens, frame } = current.desktop;
    const canvas = createDesktopFrame(screens.map(row => row.physical));
    if (!sameRect(canvas.bounds, frame)) throw new Error('跨屏画布与屏幕并集不符');
    for (const row of screens) {
      assertTopology(current);
      const source = createWinCapture(row.physical, { purpose: 'snapshot' });
      current.snapshotSource = source;
      try {
        const captured = await source.next();
        if (active !== current) return;
        if (!captured.fresh || !captured.data || captured.width !== row.physical.width || captured.height !== row.physical.height ||
            captured.data.length !== row.physical.width * row.physical.height * 4) throw new Error('原生快照尺寸或像素不完整');
        // 原生给的是 RGBA（Uint8ClampedArray）；合成画布是 BGRA，只换字节顺序，不缩放、不重采样。
        // 直接交原生视图，不额外包一层 Uint8Array：零复制，也让集成测试触到真正的采集返回类型。
        blitDesktopFrame(canvas, row.physical, { width: captured.width, height: captured.height, data: captured.data });
      } finally { source.stop(); if (current.snapshotSource === source) current.snapshotSource = undefined; }
    }
    // 拼完之后再核一次：任何一屏在采集中途被换掉，这张图就不能算数。
    assertTopology(current);
    const size = { width: frame.width, height: frame.height };
    current.image = nativeImage.createFromBitmap(canvas.data, { ...size, scaleFactor: 1 });
    const actual = current.image.getSize();
    if (actual.width !== size.width || actual.height !== size.height) {
      throw new Error(`跨屏底图尺寸不完整：${actual.width}×${actual.height}，预期 ${size.width}×${size.height}`);
    }
    current.bmpBytes = bmp32(canvas.data, size.width, size.height);
    // 叠层时这张帧必须真的包含父页：父在采帧期间消失就不能算数。
    if (!suspendedParentsAlive()) throw new Error('原来的选区页已经不在了，这次叠加截图作废');
    if (current.timing) current.timing.snapshotMs = Date.now() - current.timing.startedAt;
    diagnostics?.record('snapshot-ready', { mode: 'desktop', screenCount: screens.length,
      width: size.width, height: size.height });
  }

  // 跨屏选区窗：初始 DIP 尺寸只是建窗提示，真正的矩形由原生物理 fit 决定。
  async function openDesktopWindow(current) {
    const frame = current.desktop.frame;
    const anchor = current.display;
    const hint = { x: anchor.bounds.x, y: anchor.bounds.y,
      width: Math.max(1, Math.min(Math.round(frame.width / anchor.scaleFactor), anchor.bounds.width)),
      height: Math.max(1, Math.min(Math.round(frame.height / anchor.scaleFactor), anchor.bounds.height)) };
    const win = new BrowserWindow({ ...hint, show: false, frame: false, resizable: false,
      movable: false, roundedCorners: false, thickFrame: false, enableLargerThanScreen: true,
      // 跨屏大窗必须是普通不透明窗：桌面底图本来就不透明（空洞也填不透明黑），不需要 layered/direct
      // composition 的透明模式；Electron 官方也明确透明窗不可 resize，原生 fit 会被这层限制挡住。
      alwaysOnTop: true, skipTaskbar: true, transparent: false, backgroundColor: '#000000',
      hasShadow: false, maximizable: false, fullscreenable: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
        backgroundThrottling: false, preload: path.join(__dirname, 'selection-preload.cjs') } });
    current.win = win;
    if (active !== current) { win.destroy(); return; }
    // 活性确认之后才绑：只记固定事件；焦点回来时只恢复原有置顶属性，不改显示/焦点/透明性/快捷键。
    attachSelectionWindowEvents(current, win, 'desktop');
    diagnostics?.record('window-created', { phase: current.phase, mode: 'desktop' });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key !== 'Escape' || input.type !== 'keyDown' || current.phase === 'saving') return;
      // 本窗被挂起时：Esc 只能用来撤掉还没就绪的子准备，不落到父页编辑器上。
      if (escapeOnSuspendedParent(event, current)) return;
      // 确认页就绪后首次 Esc 交给 DOM；准备中和重复按键一律吞掉。
      if (current.phase === 'exit-confirming') { if (active !== current || !current.exitPrompt?.ready || input.isAutoRepeat) event.preventDefault(); return; }
      // 编辑中的 Esc 先交给页面关编辑器：直接 end 会把整张底图和编辑文档一起销毁。
      // 与单屏同语义：已有编辑文档或已就绪成图的 Esc 都交给渲染层走确认退出（含关掉放大预览）；
      // 首次不拦，重复按下才拦下，避免一路连发退出截图。
      if (current.phase === 'selecting' && (current.editDocument || (current.longImage && !current.longPreviewPending))) {
        if (input.isAutoRepeat) event.preventDefault();
        return;
      }
      event.preventDefault();
      if (input.isAutoRepeat || active !== current) return;
      current.dismissSource = 'escape-key';
      const outcome = end(current, true, 'cancelled');
      if (outcome !== 'resume-failed') onStatus({ message: '已取消跨屏截图。' });
    });
    win.webContents.on('render-process-gone', () => {
      if (active !== current) { markSuspendedInvalid(current, 'renderer-gone'); return; }
      diagnostics?.record('renderer-error', { phase: current.phase, errorName: 'Error', errorCode: 'selection-renderer-gone' });
      end(current, true, 'failed');
      onStatus({ message: '选区窗口异常，已收回，可重新截图。', error: true });
    });
    win.on('closed', () => {
      if (active !== current) { markSuspendedInvalid(current, 'window-close'); return; }
      current.dismissSource = 'window-close';
      end(current, true, current.phase === 'saving' ? 'window-closed' : 'cancelled');
    });
    current.phase = 'loading';
    if (process.platform === 'win32') {
      assertTopology(current);
      // 一次性 nonce 写进窗口标题：原生侧先去校验这扇窗，再把它摆到整组屏的 union 上。
      const nonce = randomUUID().replace(/-/g, '');
      win.setTitle(nonce);
      await fitDesktopWindow(handleToDecimal(win.getNativeWindowHandle()), process.pid, nonce, frame);
      if (current.timing) current.timing.fitMs = Date.now() - current.timing.startedAt;
      diagnostics?.record('window-fitted', { phase: current.phase, mode: 'desktop' });
      if (win.isDestroyed()) return;
      if (active !== current) { win.destroy(); return; }
    }
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'selection.html'));
    if (current.timing) current.timing.windowMs = Date.now() - current.timing.startedAt;
    diagnostics?.record('window-loaded', { phase: current.phase, mode: 'desktop' });
    if (win.isDestroyed()) return;
    if (active !== current) { win.destroy(); return; }
    // 跨屏冷路径同样先等页面就绪，只发一次固定激活事件。
    if (current.timing) current.timing.activateMs = Date.now() - current.timing.startedAt;
    try { win.webContents.send('shot:activate'); } catch { /* 崩溃窗由 render-gone/超时兜底。 */ }
  }

  // 显示器真实物理矩形只查一次：建窗与取帧都要它，两条支路共用同一份结果，不重复起原生查询进程。
  function resolveGeometry(current) {
    if (current.geometry) return current.geometry;
    // 预备命中的几何缓存：只在实时 DIP hint 与单屏身份完全一致时使用；否则丢掉预备件走原冷查询。
    if (current.warm?.geometry) {
      const displays = screen.getAllDisplays();
      const display = current.display;
      const cache = current.warm.geometry;
      if (displays.length === 1 && sameDisplayIdentity(display, cache.display) &&
          sameRect(liveHint(display), cache.nativeHint) && sameRect(liveWorkHint(display), cache.nativeWorkHint)) {
        current.nativeBounds = { ...cache.nativeBounds };
        current.nativeWorkArea = { ...cache.nativeWorkArea };
        current.nativeHint = { ...cache.nativeHint };
        current.nativeWorkHint = { ...cache.nativeWorkHint };
        if (current.timing) { current.timing.geometryAt = Date.now(); current.timing.geometryCached = true; }
        current.geometry = Promise.resolve(current.nativeBounds);
        return current.geometry;
      }
      releaseWarm(current);
    }
    current.geometry = (async () => {
      const display = current.display;
      // Electron 在多屏混合缩放下给出的物理矩形可能比真实监视器多几像素（曾见 1098×618@1.75 → 1922×1082）。
      // 先只查真实监视器矩形，再按它裁切；hint 不拿去采。
      const hint = process.platform === 'win32' ? screen.dipToScreenRect(null, display.bounds) : undefined;
      // 浮条夹取要用真实工作区：任务栏/保留区由系统给出，不能用 DIP 推算。
      const workHint = hint ? screen.dipToScreenRect(null, display.workArea) : undefined;
      if (!hint) { if (current.timing) current.timing.geometryAt = Date.now(); return undefined; }
      let nativeBounds, nativeWorkArea;
      current.nativeHint = { x: hint.x, y: hint.y, width: hint.width, height: hint.height };
      let answers;
      try {
        answers = await Promise.all([queryMonitor(hint, display.scaleFactor), queryWorkArea(workHint, display.scaleFactor)]);
      } catch { throw new Error('未能确认显示器真实像素范围，请重试'); }
      // 查询是异步的：期间关闭截图或显示器被拔掉时，绝不能启动采集或留下冻结窗口。
      if (active !== current) return;
      [nativeBounds, nativeWorkArea] = answers;
      if (!nativeWorkArea || nativeWorkArea.x < nativeBounds.x || nativeWorkArea.y < nativeBounds.y ||
          nativeWorkArea.x + nativeWorkArea.width > nativeBounds.x + nativeBounds.width ||
          nativeWorkArea.y + nativeWorkArea.height > nativeBounds.y + nativeBounds.height) throw new Error('显示器工作区不在监视器内，请重试');
      if (!screen.getAllDisplays().some(item => item.id === display.id)) throw new Error('显示器配置发生变化，请重试');
      current.nativeBounds = { x: nativeBounds.x, y: nativeBounds.y, width: nativeBounds.width, height: nativeBounds.height };
      current.nativeWorkArea = { x: nativeWorkArea.x, y: nativeWorkArea.y, width: nativeWorkArea.width, height: nativeWorkArea.height };
      current.nativeWorkHint = { x: workHint.x, y: workHint.y, width: workHint.width, height: workHint.height };
      if (current.timing) current.timing.geometryAt = Date.now();
      return current.nativeBounds;
    })();
    return current.geometry;
  }

  // 冻结底图：原像素只留在内存，冻结成无压缩 BMP，避免开框前整屏 PNG 压缩。
  async function captureSnapshot(current) {
    const display = current.display;
    await resolveGeometry(current);
    if (active !== current) return;
    const nativeBounds = current.nativeBounds;
    const expected = nativeBounds ? { width: nativeBounds.width, height: nativeBounds.height } :
      { width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) };
    // 分配/采集前先算预算：叠加层时保留父图的物理像素也要算进去，超限就在这里停，不分配更大图。
    assertFrameBudget(current, expected.width, expected.height);
    if (nativeBounds) {
      // 与滚动采样共用已验证的无指针 WGC 源，避免缩略图链把线性值当 sRGB 显示。
      // 这张底图只冻结一次，按普通快照的像素预算走，不受长截图 1600 万限制。
      let source, warmSource = false;
      if (current.warm?.source) { source = current.warm.source; current.warm.source = undefined; warmSource = true; }
      else source = createWinCapture(nativeBounds, { purpose: 'snapshot' });
      current.snapshotSource = source;
      try {
        let frame;
        try { frame = await source.next(); }
        catch (error) {
          // 暖源（含旧 exe 不认 --snapshot-lazy）只回退一次普通快照；
          // 会话已取消/换轮时绝不另起进程，真错误仍由下面原样抛。
          if (!warmSource || current.warmRetried || active !== current) throw error;
          current.warmRetried = true;
          try { source.stop(); } catch { /* 已退出就不用再停。 */ }
          if (current.snapshotSource === source) current.snapshotSource = undefined;
          source = createWinCapture(nativeBounds, { purpose: 'snapshot' });
          current.snapshotSource = source;
          frame = await source.next();
          warmSource = false;
        }
        if (current.timing) {
          current.timing.frameMs = Date.now() - current.timing.startedAt;
          if (warmSource) current.timing.preparedSource = true;
        }
        if (active !== current) return;
        if (!frame.fresh || frame.width !== expected.width || frame.height !== expected.height ||
            !frame.data || frame.data.length !== expected.width * expected.height * 4) throw new Error('原生快照尺寸或像素不完整');
        // 普通快照是一次性取帧：win-capture 的 snapshot 源不留整帧参照（keepReference=false，回包后即释放 payload），
        // 这块缓冲区只属于本次调用，没有第二个人（长截图/录制各自留参照，不走这里）。
        // 因此直接对它的内存建 Buffer 视图再原地换 R/B：省掉一整帧复制，颜色与 alpha 字节不变。
        const pixels = frame.data;
        if (!ArrayBuffer.isView(pixels) || Object.prototype.toString.call(pixels) !== '[object Uint8ClampedArray]' ||
            pixels.BYTES_PER_ELEMENT !== 1 || pixels.byteLength !== expected.width * expected.height * 4 ||
            !pixels.buffer || typeof pixels.buffer.byteLength !== 'number' || pixels.byteOffset < 0 ||
            pixels.byteOffset + pixels.byteLength > pixels.buffer.byteLength) throw new Error('原生快照像素缓冲不可共享');
        // WGC 输出 RGBA；Electron Windows 位图输入使用 BGRA，固定 1x 物理像素。
        const bgra = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
        for (let i = 0; i < bgra.length; i += 4) { const r = bgra[i]; bgra[i] = bgra[i + 2]; bgra[i + 2] = r; }
        current.image = nativeImage.createFromBitmap(bgra, { ...expected, scaleFactor: 1 });
        // 直接给页面 BMP 字节，不再拼 44M 字符的 data URL：省掉一次 base64 编码和一次长串解析。
        // 32 位行本来就按 4 字节对齐，负高度表示自上而下；不翻行、不重采样、不改像素。
        const header = Buffer.alloc(54);
        header.write('BM', 0); header.writeUInt32LE(54 + bgra.length, 2); header.writeUInt32LE(54, 10);
        header.writeUInt32LE(40, 14); header.writeInt32LE(expected.width, 18); header.writeInt32LE(-expected.height, 22);
        header.writeUInt16LE(1, 26); header.writeUInt16LE(32, 28); header.writeUInt32LE(bgra.length, 34);
        const bmp = Buffer.allocUnsafe(54 + bgra.length);
        header.copy(bmp, 0);
        bgra.copy(bmp, 54);
        current.bmpBytes = bmp;
      } finally { source.stop(); if (current.snapshotSource === source) current.snapshotSource = undefined; }
    } else {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: expected });
      if (active !== current) return;
      const source = sources.find(item => item.display_id === String(display.id));
      if (!source || source.thumbnail.isEmpty()) throw new Error('未能取得鼠标所在屏幕的画面');
      // 非 Windows 保留既有规范化路径，不套用本机色彩修复。
      current.image = nativeImage.createFromBuffer(source.thumbnail.toPNG());
      current.dataUrl = current.image.toDataURL();
    }
    const actual = current.image.getSize();
    if (current.timing) current.timing.snapshotMs = Date.now() - current.timing.startedAt;
    diagnostics?.record('snapshot-ready', { displayId: display.id, width: actual.width, height: actual.height });
    if (actual.width !== expected.width || actual.height !== expected.height) {
      throw new Error(`屏幕快照尺寸不完整：${actual.width}×${actual.height}，预期 ${expected.width}×${expected.height}`);
    }
    // 叠层时这张帧必须真的包含父页：父在采帧期间消失就不能算数。
    if (!suspendedParentsAlive()) throw new Error('原来的选区页已经不在了，这次叠加截图作废');
    const latest = screen.getAllDisplays().find(item => item.id === display.id);
    if (!latest || JSON.stringify(latest.bounds) !== JSON.stringify(display.bounds) || latest.scaleFactor !== display.scaleFactor ||
        JSON.stringify(latest.workArea) !== JSON.stringify(display.workArea)) {
      throw new Error('显示器配置发生变化，请重试');
    }
  }

  // 选区窗口：透明底 + 未上屏时先不画任何东西，避免第一帧只剩一块纯色。
  async function openSelectionWindow(current) {
    const display = current.display;
    // 暖窗只在本次消费中使用：仍是同一个 BrowserWindow，之后的 setBounds/nonce/fit/loadFile/init/ready 全部原样。
    const warmWindow = current.warm?.window;
    const warmPage = Boolean(warmWindow && current.warm?.pageLoaded === true && !warmWindow.isDestroyed() &&
      !failedSelectionPages.has(warmWindow));
    if (current.warm) { current.warm.window = undefined; current.warm.pageLoaded = false; }
    // 暖窗在但页面未就绪/已毁：直接丢弃，避免换成新窗后旧实例泄漏。
    if (!warmPage && warmWindow && !warmWindow.isDestroyed()) { try { warmWindow.destroy(); } catch { /* 丢弃即可。 */ } }
    const win = warmPage ? warmWindow : createSelectionWindow(display);
    if (current.timing && warmPage) { current.timing.preparedWindow = true; current.timing.preparedPage = true; }
    current.win = win;
    if (active !== current) { win.destroy(); return; }
    // 活性确认之后才绑：只记固定事件；焦点回来时只恢复原有置顶属性，不改显示/焦点/透明性/快捷键。
    attachSelectionWindowEvents(current, win, 'single');
    diagnostics?.record('window-created', { phase: current.phase });
    win.setBounds(display.bounds);
    // 普通截图已在开窗前冻结；滚动采样要等此页隐藏后才开始。
    // 选区页不做捕获排除，避免远程软件看不到框选反馈。
    // 导航/弹窗锁在 createSelectionWindow 里挂（预载页从一开始就要锁）。
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key !== 'Escape' || input.type !== 'keyDown') return;
      // 本窗被挂起时：Esc 只能用来撤掉还没就绪的子准备，不落到父页编辑器上。
      if (escapeOnSuspendedParent(event, current)) return;
      // 确认页就绪后首次 Esc 交给 DOM；准备中和重复按键一律吞掉。
      if (current.phase === 'exit-confirming') { if (active !== current || !current.exitPrompt?.ready || input.isAutoRepeat) event.preventDefault(); return; }
      if (current.phase !== 'saving') {
        // 已完成长图由页面先关闭放大预览；缩略图状态再按Esc才退出截图。
        if (current.phase === 'selecting' && (current.editDocument || (current.longImage && !current.longPreviewPending))) {
          if (input.isAutoRepeat) event.preventDefault();
          return;
        }
        event.preventDefault();
        diagnostics?.record('escape-input', { phase: current.phase, repeat: input.isAutoRepeat === true,
          hasLongImage: Boolean(current.longImage), previewPending: current.longPreviewPending === true });
        if (input.isAutoRepeat || current.phase === 'scroll-finishing') return;
        if (current.phase === 'scrolling') { scrolling.finish(); return; }
        current.dismissSource = 'escape-key';
        const outcome = end(current, true, 'cancelled');
        if (outcome !== 'resume-failed') onStatus({ message: '已取消截图。' });
      }
    });
    win.webContents.on('render-process-gone', () => {
      if (active !== current) { markSuspendedInvalid(current, 'renderer-gone'); return; }
      diagnostics?.record('renderer-error', { phase: current.phase, errorName: 'Error', errorCode: 'selection-renderer-gone' });
      end(current, true, 'failed');
      onStatus({ message: '选区窗口异常，已收回，可重新截图。', error: true });
    });
    win.on('closed', () => {
      if (active !== current) { markSuspendedInvalid(current, 'window-close'); return; }
      // 提交中的窗口消失不等于系统写入失败，保留未知结果，不能冒称取消或成功。
      current.dismissSource = 'window-close';
      end(current, true, current.phase === 'saving' ? 'window-closed' : 'cancelled');
    });
    current.phase = 'loading';
    // Windows：先把隐藏窗适配到真实物理矩形，再加载页面；Electron 的 DIP 窗口尺寸在分数缩放下会多 1 DIP，
    // 只有物理 SetWindowPos 能让窗口刚好盖住监视器。ready 的严格等值检查保持不变。
    // 这里只等几何查询（和取帧共用同一份），不再等整张底图：开窗与采屏可以真正并行。
    if (process.platform === 'win32') {
      await resolveGeometry(current);
      if (win.isDestroyed()) return;
      if (active !== current) { win.destroy(); return; }
      const latest = screen.getAllDisplays().find(item => item.id === display.id);
      const hintNow = screen.dipToScreenRect(null, display.bounds);
      if (!latest || latest.scaleFactor !== display.scaleFactor || JSON.stringify(latest.bounds) !== JSON.stringify(display.bounds) ||
          JSON.stringify(latest.workArea) !== JSON.stringify(display.workArea) ||
          !current.nativeBounds || !current.nativeHint || !hintNow ||
          ['x', 'y', 'width', 'height'].some(key => hintNow[key] !== current.nativeHint[key])) throw new Error('显示器配置发生变化，请重试');
      // 一次性 nonce 写到隐藏窗标题：原生侧用 GetWindowText 核对，同 PID 下 HWND 被回收也不会改错窗。
      const nonce = randomUUID().replace(/-/g, '');
      win.setTitle(nonce);
      await fitSelectionWindow(handleToDecimal(win.getNativeWindowHandle()), process.pid, nonce, current.nativeBounds);
      if (current.timing) current.timing.fitMs = Date.now() - current.timing.startedAt;
      diagnostics?.record('window-fitted', { phase: current.phase });
      // 适配是异步的：期间取消/关窗就不能再加载页面，也不留在屏上。
      if (win.isDestroyed()) return;
      if (active !== current) { win.destroy(); return; }
    }
    let pageReady = warmPage;
    if (!pageReady) {
      await win.loadFile(path.join(__dirname, '..', 'renderer', 'selection.html'));
      if (win.isDestroyed()) return;
      if (active !== current) { win.destroy(); return; }
      pageReady = true;
    }
    if (win.isDestroyed()) return;
    if (active !== current) { win.destroy(); return; }
    if (current.timing) current.timing.windowMs = Date.now() - current.timing.startedAt;
    diagnostics?.record('window-loaded', { phase: current.phase });
    // 页面已就绪且本轮仍有效：只发一次固定激活事件，渲染层才允许 invoke shot:init。
    if (current.timing) current.timing.activateMs = Date.now() - current.timing.startedAt;
    try { win.webContents.send('shot:activate'); } catch { /* 崩溃窗由 render-gone/超时兜底。 */ }
  }

  ipcMain.handle('shot:init', async event => {
    if (!allowed(event)) throw new Error('无效选区窗口');
    const current = active;
    try {
      if (current.phase !== 'loading') throw new Error('无效选区窗口');
      if (current.timing && current.timing.initMs === undefined) {
        current.timing.initMs = Date.now() - current.timing.startedAt;
        diagnostics?.record('selection-init', { phase: current.phase });
      }
      // 窗口可能比冻结底图先就绪，这里等同一份快照结果，不另取一次屏。
      await current.snapshot;
      if (active !== current || !allowed(event)) throw new Error('无效选区窗口');
      if (current.timing && current.timing.initReplyMs === undefined) {
        current.timing.initReplyMs = Date.now() - current.timing.startedAt;
      }
      const shared = { bmpBytes: current.bmpBytes, dataUrl: current.dataUrl,
        diagnosticEnabled: diagnostics?.state().recording === true };
      if (current.mode === 'desktop') {
        const frame = current.desktop.frame;
        // 屏矩形改成相对 union 原点的物理像素：渲染层只拿它把控件留在真实屏幕上，不参与 canonical 决定。
        return { ...shared, mode: 'desktop', frame: { width: frame.width, height: frame.height },
          screens: current.desktop.screens.map(row => ({ x: row.physical.x - frame.x, y: row.physical.y - frame.y,
            width: row.physical.width, height: row.physical.height })) };
      }
      return { ...shared, mode: 'single', bounds: current.display.bounds };
    } catch (error) {
      diagnostics?.record('renderer-error', { phase: current.phase, errorName: error.name, errorCode: 'selection-init' });
      throw error;
    }
  });
  ipcMain.handle('shot:ready', async event => {
    if (!allowed(event) || active.phase !== 'loading') throw new Error('无效选区窗口');
    const current = active;
    if (current.timing && current.timing.readyMs === undefined) current.timing.readyMs = Date.now() - current.timing.startedAt;
    if (current.mode === 'desktop') return readyDesktop(current);
    const win = current.win;
    const bounds = win.getBounds();
    const desired = current.display.bounds;
    if (['x', 'y', 'width', 'height'].some(key => bounds[key] !== desired[key])) {
      diagnostics?.record('renderer-error', { phase: current.phase, errorName: 'Error', errorCode: 'selection-size-mismatch' });
      end(current, true, 'failed');
      onStatus({ message: '选区窗口未能覆盖完整显示器，请重试。', error: true });
      return;
    }
    let selectionBounds;
    try {
      selectionBounds = await readPageViewport(win);
      if (current.timing && current.timing.viewportMs === undefined) current.timing.viewportMs = Date.now() - current.timing.startedAt;
    } catch (error) {
      // 读视口是异步的：期间已经取消/关窗/换会话时不再碰这一轮。
      if (active !== current || current.phase !== 'loading' || current.win !== win || win.isDestroyed()) return;
      diagnostics?.record('renderer-error', { phase: current.phase, errorName: error.name, errorCode: 'selection-viewport' });
      end(current, true, 'failed');
      onStatus({ message: `选区页面尺寸读取失败：${error.message}`, error: true });
      throw error;
    }
    if (active !== current || current.phase !== 'loading' || current.win !== win || win.isDestroyed()) return;
    // 读视口是异步的：这期间窗口或显示器拓扑可能变了，落基准与上屏前必须重新核对（不复用 selectionBasis，
    // 那需要先赋值，会把未验证的基准写进会话）。
    const latest = screen.getAllDisplays().find(item => item.id === current.display.id);
    const settled = win.getBounds();
    if (!latest || latest.scaleFactor !== current.display.scaleFactor ||
        ['x', 'y', 'width', 'height'].some(key => latest.bounds[key] !== current.display.bounds[key] ||
          latest.workArea[key] !== current.display.workArea[key]) ||
        ['x', 'y', 'width', 'height'].some(key => settled[key] !== current.display.bounds[key])) {
      diagnostics?.record('renderer-error', { phase: current.phase, errorName: 'Error', errorCode: 'selection-viewport-stale' });
      end(current, true, 'failed');
      onStatus({ message: '选区窗口或显示器配置已变化，请重试。', error: true });
      throw new Error('选区窗口或显示器配置已变化，请重新框选');
    }
    // 上屏切换点再核一次待暂停父活性：父在准备期间没了，就不能把桌面当成套娃图。
    if (!suspendedParentsAlive()) {
      diagnostics?.record('renderer-error', { phase: current.phase, errorName: 'Error', errorCode: 'nested-parent-lost' });
      end(current, true, 'failed');
      onStatus({ message: '原来的选区页已经不在了，这次叠加截图已收回。', error: true });
      return;
    }
    // 上屏事务：子 show → 隐藏父 必须都成功，否则收回这一层、恢复父，不把子当成已就绪。
    try { win.show(); win.focus(); } catch (error) {
      diagnostics?.record('renderer-error', { phase: current.phase, errorName: error?.name || 'Error', errorCode: 'selection-show' });
      end(current, true, 'failed');
      onStatus({ message: `选区窗口没能上屏：${error?.message || error}`, error: true });
      return;
    }
    // show 内同步取消/换会话：立即停手，不碰已经恢复的父。
    if (active !== current || current.phase !== 'loading' || current.win !== win || win.isDestroyed()) return;
    if (!hideSuspendedWindows()) {
      diagnostics?.record('renderer-error', { phase: current.phase, errorName: 'Error', errorCode: 'nested-parent-hide' });
      end(current, true, 'failed');
      onStatus({ message: '原来的选区页没能隐藏，这次叠加截图已收回。', error: true });
      return;
    }
    if (active !== current || current.phase !== 'loading' || current.win !== win || win.isDestroyed()) return;
    current.selectionBounds = selectionBounds;
    clearTimeout(current.timer);
    current.timer = undefined;
    current.phase = 'selecting';
    current.bmpBytes = undefined;
    current.dataUrl = undefined;
    noteTiming(current, 'single');
    diagnostics?.record('selection-ready', { width: desired.width, height: desired.height,
      viewportWidth: selectionBounds.width, viewportHeight: selectionBounds.height });
  });
  // 跨屏 ready：页面会用自己的 title 改写窗口标题，所以先换 nonce，再纯读确认 load 后没被 Chromium 回弹，
  // 然后才读真实视口当唯一裁切基准，最后复核拓扑与会话仍活跃才上屏。
  // 上屏不是终点：隐藏阶段的 checkDesktopWindow 只看得到 HWND，看不到 show 之后的窗口/视口变化。
  // 所以 show/focus 之后立刻再读一次窗口几何与页面视口，任何不一致都按失败收回，绝不当成就绪。
  async function readyDesktop(current) {
    const win = current.win;
    const live = () => active !== current || current.phase !== 'loading' || current.win !== win || win.isDestroyed();
    if (process.platform === 'win32') {
      const nonce = randomUUID().replace(/-/g, '');
      win.setTitle(nonce);
      try {
        await checkDesktopWindow(handleToDecimal(win.getNativeWindowHandle()), process.pid, nonce, current.desktop.frame);
      } catch (error) {
        if (live()) return;
        diagnostics?.record('renderer-error', { phase: current.phase, errorName: error.name, errorCode: 'desktop-window-mismatch' });
        end(current, true, 'failed');
        onStatus({ message: `跨屏窗口没能盖住整组屏幕：${error.message}`, error: true });
        return;
      }
      if (live()) return;
    }
    let selectionBounds;
    try {
      selectionBounds = await readPageViewport(win);
      if (current.timing && current.timing.viewportMs === undefined) current.timing.viewportMs = Date.now() - current.timing.startedAt;
    } catch (error) {
      if (live()) return;
      diagnostics?.record('renderer-error', { phase: current.phase, errorName: error.name, errorCode: 'selection-viewport' });
      end(current, true, 'failed');
      onStatus({ message: `选区页面尺寸读取失败：${error.message}`, error: true });
      throw error;
    }
    if (live()) return;
    try { assertTopology(current); } catch (error) {
      diagnostics?.record('renderer-error', { phase: current.phase, errorName: error.name, errorCode: 'selection-viewport-stale' });
      end(current, true, 'failed');
      onStatus({ message: '显示器配置已变化，请重试。', error: true });
      throw error;
    }
    // show 之前的窗口几何与视口都先冻结：上屏之后必须逐字段一致，才允许落基准。
    const beforeShow = { ...win.getBounds() };
    // 上屏切换点再核一次待暂停父活性：父在准备期间没了，就不能把桌面当成套娃图。
    if (!suspendedParentsAlive()) {
      diagnostics?.record('renderer-error', { phase: current.phase, errorName: 'Error', errorCode: 'nested-parent-lost' });
      end(current, true, 'failed');
      onStatus({ message: '原来的选区页已经不在了，这次叠加截图已收回。', error: true });
      return;
    }
    try { win.show(); win.focus(); } catch (error) {
      if (live()) return;
      diagnostics?.record('renderer-error', { phase: current.phase, errorName: error.name, errorCode: 'desktop-window-mismatch' });
      end(current, true, 'failed');
      onStatus({ message: '跨屏窗口没能上屏，已收回，可重新截图。', error: true });
      return;
    }
    // show 内同步取消/换会话：立即停手，不碰已经恢复的父。
    if (live()) return;
    // 立刻（同一轮、不排队等别的 IPC）读回：窗口几何 + 页面视口。
    let shownViewport;
    try {
      shownViewport = await readPageViewport(win);
    } catch (error) {
      // 异步读回期间取消/关窗/换轮时只退出，不碰新会话。
      if (live()) return;
      diagnostics?.record('renderer-error', { phase: current.phase, errorName: error.name, errorCode: 'selection-viewport' });
      end(current, true, 'failed');
      onStatus({ message: '跨屏窗口上屏后读不到页面尺寸，已收回，可重新截图。', error: true });
      return;
    }
    if (live()) return;
    // 视口读取期间窗口仍可能改变，矩形必须在 await 返回后取，不能复用异步前的旧值。
    const shownBounds = win.getBounds();
    const changed = ['x', 'y', 'width', 'height'].some(key => shownBounds[key] !== beforeShow[key]) ||
      shownViewport.width !== selectionBounds.width || shownViewport.height !== selectionBounds.height;
    if (changed) {
      diagnostics?.record('renderer-error', { phase: current.phase, errorName: 'Error', errorCode: 'desktop-window-mismatch' });
      end(current, true, 'failed');
      onStatus({ message: '跨屏窗口上屏后尺寸发生变化，没能覆盖整组屏幕，已收回；请重试或改用单屏截图。', error: true });
      return;
    }
    try { assertTopology(current); } catch (error) {
      diagnostics?.record('renderer-error', { phase: current.phase, errorName: error.name, errorCode: 'selection-viewport-stale' });
      end(current, true, 'failed');
      onStatus({ message: '显示器配置已变化，请重试。', error: true });
      throw error;
    }
    current.selectionBounds = selectionBounds;
    clearTimeout(current.timer);
    current.timer = undefined;
    if (live()) return;
    // 上屏后还要 await 读回视口：这期间父可能已经 closed/render-gone；hide 前再核一次，失效就收回这一层。
    if (!suspendedParentsAlive()) {
      diagnostics?.record('renderer-error', { phase: current.phase, errorName: 'Error', errorCode: 'nested-parent-lost' });
      end(current, true, 'failed');
      onStatus({ message: '原来的选区页已经不在了，这次叠加截图已收回。', error: true });
      return;
    }
    // 子上屏后再隐藏父；隐藏失败（抛错或仍可见）同样算这层没起来，收回并恢复父。
    if (!hideSuspendedWindows()) {
      diagnostics?.record('renderer-error', { phase: current.phase, errorName: 'Error', errorCode: 'nested-parent-hide' });
      end(current, true, 'failed');
      onStatus({ message: '原来的选区页没能隐藏，这次叠加截图已收回。', error: true });
      return;
    }
    if (live()) return;
    current.phase = 'selecting';
    current.bmpBytes = undefined;
    current.dataUrl = undefined;
    noteTiming(current, 'desktop');
    diagnostics?.record('selection-ready', { mode: 'desktop', width: current.desktop.frame.width,
      height: current.desktop.frame.height, viewportWidth: selectionBounds.width, viewportHeight: selectionBounds.height });
  }
  ipcMain.handle('shot:preview-ready', (event, token) => {
    if (!allowed(event) || active.phase !== 'selecting' || !active.longImage || token !== active.longToken || !active.longPreviewPending) return false;
    active.longPreviewPending = false;
    diagnostics?.record('preview-dom-ready', { ...active.longImage.getSize(), ready: true, hasLongImage: true,
      hidden: !active.win.isVisible(), remoteVisibility: 'unobserved' });
    return true;
  });
  ipcMain.handle('shot:preview-image', (event, token) => {
    if (!allowed(event) || active.phase !== 'selecting' || !active.longImage ||
        active.longPreviewPending || typeof token !== 'string' || token !== active.longToken) throw new Error('长图预览已失效');
    // 仅点击查看时传原尺寸；初次结果页仍用有界缩略图，不写临时文件。
    return { dataUrl: active.longImage.toDataURL(), ...active.longImage.getSize() };
  });
  ipcMain.handle('shot:edit-source', async (event, rect, longToken, warning) => {
    if (!allowed(event) || active.phase !== 'selecting') throw new Error('编辑来源已失效');
    const current = active;
    if (current.editorOpening === true) throw new Error('编辑页正在打开，请稍候');
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 2 || rect.height < 2) throw new Error('选区无效');
    if (longToken !== undefined && (typeof longToken !== 'string' || longToken !== current.longToken || !current.longImage || current.longPreviewPending)) throw new Error('长图尚未就绪或已失效');
    if (warning !== undefined && typeof warning !== 'string') throw new Error('长图提示无效');
    // 选区坐标已经是页面局部坐标：直接对实际视口换算，不再叠屏的全局原点。
    // 跨屏的新 raw 选区按页面当前视口重读基准；已成图 / 已有编辑文档仍用冻结基准。
    const verifyDisplay = !longToken && !current.editDocument;
    const basis = verifyDisplay && current.mode === 'desktop' ? await refreshSelectionBasis(current)
      : selectionBasis(current, verifyDisplay);
    // await 之后重新确认：双击、取消、重截的迟到回包不能进旧会话，也不能碰新会话。
    if (!allowed(event) || active !== current || current.phase !== 'selecting') throw new Error('选区会话已失效，请重新框选');
    const pixels = toPixels(rect, basis, current.image.getSize());
    if (current.mode === 'desktop' && !desktopHasContent(current, pixels)) throw new Error('选区没有屏幕内容，请重新框选');
    const previous = current.editDocument;
    if (previous) {
      if (previous.longToken !== longToken || JSON.stringify(previous.pixels) !== JSON.stringify(pixels)) throw new Error('请先重新框选，再编辑另一张图');
      // 同 token 重开：只带元数据。DOM/草稿/操作历史只在那一层宿主里；宿主异常中断就拒绝，不用原图“重建”。
      await openEditorHost(current, previous, { warning });
      return { token: previous.token, width: previous.width, height: previous.height };
    }
    const source = longToken ? current.longImage : current.image.crop(pixels);
    const size = source.getSize();
    checkEditSize(size);
    const dataUrl = source.toDataURL();
    // 原 rect/longToken 留在主进程：编辑窗口提交时用来重算同一份像素，不让渲染层自报范围。
    // 源图只在这次 open 里交给宿主一次，主进程不长期缓存，也不拿它给已失败的编辑“重建”。
    current.editDocument = { token: randomUUID(), pixels, rect: { ...rect }, longToken, ...size };
    const created = current.editDocument;
    try {
      await openEditorHost(current, created, { dataUrl, warning });
    } catch (error) {
      // 首次打开失败：渲染层拿不到 token、也就无法 discard；只在仍是同一轮、同一份文档时清掉这份新文档，原图保留。
      if (active === current && current.editDocument === created) current.editDocument = undefined;
      throw error;
    }
    return { token: created.token, width: created.width, height: created.height };
  });
  ipcMain.handle('shot:edit-state', async (event, token, action) => {
    if (!allowed(event) || active.phase !== 'selecting' || typeof token !== 'string' || !active.editDocument || token !== active.editDocument.token || !['open', 'close', 'discard'].includes(action)) throw new Error('编辑会话已失效');
    // 拿到这一轮与这份文档的引用后只用它们：切换可能同步结束/换轮，不能再去改新轮的 editDocument。
    const current = active, doc = current.editDocument;
    if (current.editorOpening === true) throw new Error('编辑页正在打开，请稍候');
    if (action === 'open') {
      await openEditorHost(current, doc, {});
      return true;
    }
    // 关闭或放弃编辑器即取消在途识别；识别任务不参与保存/取消节奏。
    ocr?.cancel(current);
    if (active !== current || current.phase !== 'selecting' || current.editDocument !== doc) throw new Error('选区会话已结束或已切换');
    // close：收起宿主回到原选区页（兼容入口）；discard：连同这份文档一起释放宿主。
    if (action === 'close') await editorHost.close(doc.token);
    else editorHost.cleanup(doc.token);
    if (active !== current || current.phase !== 'selecting' || current.editDocument !== doc) throw new Error('选区会话已结束或已切换');
    current.editorOpen = false;
    if (action === 'discard') current.editDocument = undefined;
    showOverlay(current);
    return true;
  });
  // 编辑页最小化：只允许当前主 frame、active selecting、带有效文档 token 且确实在编辑中的会话。
  ipcMain.handle('shot:edit-minimize', (event, token) => {
    if (!allowed(event)) throw new Error('编辑窗口已失效');
    const current = active;
    if (current.phase !== 'selecting') throw new Error('当前不在编辑状态');
    if (!current.editDocument || typeof token !== 'string' || token !== current.editDocument.token) throw new Error('编辑会话已失效');
    if (current.editorOpen !== true) throw new Error('尚未进入图片编辑');
    const win = sessionVisibleWindow(current);
    if (!win) throw new Error('编辑窗口已失效');
    win.minimize();
    return true;
  });
  ipcMain.handle('shot:diagnostic', (event, name, fields) => {
    if (!allowed(event)) return false;
    if (!['selection-input', 'selection-dismiss', 'wheel', 'worker-start', 'media-request', 'config-ready', 'media-ready', 'seed-ready', 'video-ready',
      'sampling-start', 'sample', 'worker-finishing', 'png-ready', 'worker-error', 'renderer-error'].includes(name)) return false;
    return diagnostics?.record(name, fields) || false;
  });
  ipcMain.handle('shot:cancel', (event, reason) => {
    // 导出/保存阶段不接受渲染层取消：否则旧轮的取消会结束新会话，或把导出回包丢掉。
    if (!allowed(event) || active.phase === 'saving' || active.phase === 'exporting') return;
    const current = active;
    current.dismissSource = ['escape-key', 'context-menu'].includes(reason) ? reason : 'renderer-cancel';
    const outcome = end(current, true, reason === 'failed' ? 'failed' : 'cancelled');
    // 父页恢复失败时保留它自己的错误提示，不被「已取消」盖掉。
    if (outcome !== 'resume-failed') {
      onStatus({ message: reason === 'failed' ? '截图界面未完成，已收回。' : '已取消截图。', error: reason === 'failed' });
    }
  });
  // 成图退出：只接受当前主 frame、同一轮 selecting、与 payload 对齐的文档 token 和白名单来源。
  // 确认与结束都在 requestCaptureExit 里；确认中/保存中的重复请求直接拒绝，不弹第二个框。
  const EXIT_SOURCES = ['context-menu', 'escape-key'];
  ipcMain.handle('shot:request-exit', async (event, token, source) => {
    if (!allowed(event)) throw new Error('选区会话已失效，请重新框选');
    const current = active;
    if (!current || current.phase !== 'selecting') throw new Error('当前没有可退出的成图');
    if (!EXIT_SOURCES.includes(source)) throw new Error('无效的退出请求');
    // 有编辑文档时只认它的 token；否则只认已稳定预览的长图 token（就是 longToken，
    // longImage 是 NativeImage，没有 token 字段）。
    const expected = current.editDocument ? current.editDocument.token
      : (current.longPreviewPending !== true ? current.longToken : undefined);
    if (!expected) throw new Error('当前没有可退出的成图');
    if (typeof token !== 'string' || token !== expected) throw new Error('成图已失效，请重新框选');
    return requestCaptureExit(current, source);
  });
  // 共享提交：原选区页与独立编辑窗走同一份像素/尺寸/裁切校验与同一套写出/复制。
  // 调用方负责 sender/frame/token 授权；这里只核会话与文档，不再自己认窗口。
  async function commitCapture(current, { rect, action, longToken, edited, via = 'overlay' }) {
    const saving = action === 'save' || action === 'save-quick';
    if (!saving && action !== 'copy') throw new Error('请选择保存或复制');
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 2 || rect.height < 2) {
      throw new Error('选区太小，请重新框选');
    }
    // 跨屏的新 raw 选区按页面当前实际视口重读基准；已成图 / 已有编辑文档仍用冻结基准。
    const verifyDisplay = !longToken && !current.editDocument;
    const basis = verifyDisplay && current.mode === 'desktop' ? await refreshSelectionBasis(current)
      : selectionBasis(current, verifyDisplay);
    if (active !== current || current.phase !== 'selecting') throw new Error('选区会话已失效，请重新框选');
    const pixels = toPixels(rect, basis, current.image.getSize());
    if (pixels.width < 1 || pixels.height < 1) throw new Error('选区没有有效像素');
    // 跨屏模式下选框只压在屏幕之间的黑洞上时，合成图那块是不透明黑，没有真正内容可交。
    if (current.mode === 'desktop' && !desktopHasContent(current, pixels)) throw new Error('选区没有屏幕内容，请重新框选');
    if (longToken !== undefined && (typeof longToken !== 'string' || longToken !== current.longToken || !current.longImage)) throw new Error('长图已失效，请重新截图');
    if (longToken && current.longPreviewPending) throw new Error('长图预览尚未就绪');
    // 返回预览后从原选区页保存/复制：让那一份文档的编辑宿主导出当前画面，仍然走同一套校验。
    // 导出期间锁成 exporting：F1/退出/重选/渲染层取消一律不能插进来；await 之后必须重核会话与文档。
    if (current.editDocument && edited === undefined) {
      if (current.editorOpen === true) throw new Error('请先返回预览，再保存或复制');
      const doc = current.editDocument;
      current.phase = 'exporting';
      try {
        edited = await editorHost.export(doc.token, action === 'copy' ? 'copy' : 'png');
      } finally {
        // 只给同一活轮、同一份文档恢复阶段；已结束/换轮也不能把新会话的 phase 改掉。
        if (active === current && current.phase === 'exporting' && current.editDocument === doc) current.phase = 'selecting';
      }
      if (active !== current || current.phase !== 'selecting' || current.editDocument !== doc) {
        throw new Error('选区会话已结束或已切换，未输出原图');
      }
      if (!edited || typeof edited !== 'object' || edited.token !== doc.token) throw new Error('编辑结果缺失或已失效，未输出原图');
    }
    let cropped;
    if (current.editDocument) {
      const doc = current.editDocument;
      if (!edited || edited.token !== doc.token || longToken !== doc.longToken || JSON.stringify(pixels) !== JSON.stringify(doc.pixels)) throw new Error('编辑结果缺失或已失效，未输出原图');
      // 裁切只在页面确实应用过时带上 crop：先按文档尺寸严格验证，再用裁后尺寸去对 PNG 和解码。
      // clipboardSize 只在「复制」且带批注说明时才存在：尺寸由页面声明，但不能信：
      // 保存一律拒绝这个字段；复制按 max(裁后宽,720,可选的 insetWidth+40) 与「高度不低于裁后图」重算后
      // 走同一套容量与解码校验（insetWidth 缺省时与旧规则完全一致）。
      const editSize = resolveEditCrop(doc, edited.crop);
      if (edited.clipboardSize !== undefined) {
        if (action !== 'copy') throw new Error('保存不接受复制说明尺寸，未输出原图');
        cropped = decodeEditedImage(edited.png, expectedClipboardSize(editSize, edited.clipboardSize), nativeImage);
      } else {
        cropped = decodeEditedImage(edited.png, editSize, nativeImage);
      }
    } else {
      if (edited !== undefined) throw new Error('编辑会话已失效，未输出原图');
      cropped = longToken ? current.longImage : current.image.crop(pixels);
    }
    const outputSize = cropped.getSize();
    // 真实可见宿主：编辑中/预览中分别是编辑窗与原选区窗；写完、取消、失败都只动这一扇。
    const hostWin = sessionVisibleWindow(current) || current.win;
    current.phase = 'saving';
    current.commitSummary = { action, via };
    diagnostics?.record('commit-start', { phase: current.phase, ...current.commitSummary, hasLongImage: Boolean(longToken) });
    // 复制要把窗口留到写入成功之后（end() 关窗）；预隐藏只保留 save-quick 的原有节奏。
    if (action === 'save-quick' && hostWin && !hostWin.isDestroyed()) hostWin.hide();
    const errors = [];
    let file;
    let copied = false;
    try {
      if (saving) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${stamp}_${outputSize.width}x${outputSize.height}_${randomUUID().slice(0, 8)}.png`;
        if (action === 'save-quick') {
          // 直接存到设置里那个文件夹，不弹窗；目录没了就建。
          const folder = typeof settings?.resolveSaveFolder === 'function' ? settings.resolveSaveFolder(directory) : directory;
          await fs.mkdir(folder, { recursive: true });
          const target = path.join(folder, filename);
          await fs.writeFile(target, cropped.toPNG());
          file = target;
          lastFile = target;
        } else {
        const startFolder = typeof settings?.resolveAsFolder === 'function'
          ? settings.resolveAsFolder(lastFile ? path.dirname(lastFile) : directory)
          : (lastFile ? path.dirname(lastFile) : directory);
        const choice = await dialog.showSaveDialog(hostWin || current.win, {
          title: '保存截图', buttonLabel: '保存',
          defaultPath: path.join(startFolder, filename),
          filters: [{ name: 'PNG 图片', extensions: ['png'] }],
          properties: ['showOverwriteConfirmation', 'dontAddToRecent']
        });
        if (active !== current || (hostWin && hostWin.isDestroyed())) return { ok: false, canceled: true, action, copied: false, errors: [] };
        if (choice.canceled) {
          current.commitSummary = { action, ok: false, canceled: true };
          diagnostics?.record('commit-end', current.commitSummary);
          current.phase = 'selecting';
          if (hostWin && !hostWin.isDestroyed()) { hostWin.show(); hostWin.focus(); }
          onStatus({ message: '已取消保存，选框保留，可重新保存或复制。' });
          return { ok: false, canceled: true, action, copied: false, errors: [] };
        }
        if (!choice.filePath) throw new Error('未取得保存位置，请重新选择');
        const candidate = choice.filePath;
        if (hostWin && !hostWin.isDestroyed()) hostWin.hide();
        // 系统另存为窗口负责已有文件的覆盖确认，写入用户最终确认的路径。
        await fs.writeFile(candidate, cropped.toPNG());
        file = candidate;
        lastFile = candidate;
        // 下次另存为从这个目录开始。
        try { settings?.update?.({ lastSaveFolder: path.dirname(candidate) }); } catch { /* 记目录失败不挡保存。 */ }
        }
      } else {
        await clipboard.write([new ClipboardItem({
          'image/png': new Blob([cropped.toPNG()], { type: 'image/png' })
        })]);
        copied = true;
      }
    } catch (error) {
      errors.push(`${saving ? '保存' : '复制'}失败：${error.message}`);
      if (active === current) diagnostics?.record('worker-error', { phase: 'saving', errorName: error.name, errorMessage: error.message });
    }
    const ok = errors.length === 0;
    if (active === current) {
      current.commitSummary = { action, ok, canceled: false };
      diagnostics?.record('commit-end', current.commitSummary);
    }
    if (ok) end(current, false, 'completed');
    else if (active === current && hostWin && !hostWin.isDestroyed()) {
      current.phase = 'selecting';
      hostWin.show();
      hostWin.focus();
    }
    const message = `${outputSize.width} × ${outputSize.height} · ${ok ? (copied ? (edited?.clipboardSize ? '已复制，批注说明已随图附在下方，粘贴到其他应用即可' : '已复制') : '已保存') : errors.join('；')}`;
    onStatus({ message, file, copied, error: !ok, dimensions: outputSize });
    return { ok, action, file, copied, errors };
  }
  // 原选区页：只认原窗主 frame；带编辑文档时由主进程到隐藏的编辑宿主取导出结果。
  ipcMain.handle('shot:commit', async (event, rect, action, longToken, edited) => {
    if (!allowed(event) || active.phase !== 'selecting') throw new Error('无效截图请求');
    const current = active;
    if (current.editorOpening === true) throw new Error('编辑页正在打开，请稍候');
    return commitCapture(current, { rect, action, longToken, edited, via: 'overlay' });
  });
  // 独立编辑窗：只认它自己的主 frame/文档 token，像素与裁切仍由共享提交校验。
  async function commitFromEditor(action, edited, doc) {
    const current = active;
    if (!current || current.phase !== 'selecting' || current.editorOpen !== true) throw new Error('编辑会话已失效');
    const document = current.editDocument;
    if (!document || document.token !== doc.token || !edited || edited.token !== document.token) throw new Error('编辑文档已失效');
    if (action === 'save' || action === 'save-quick' || action === 'copy') {
      return commitCapture(current, { rect: document.rect, action, longToken: document.longToken, edited, via: 'editor' });
    }
    throw new Error('请选择保存或复制');
  }

  // 独立识别通道：只吃渲染层显式点击后送来的局部 PNG，主进程不读原图、不落盘、不联网。
  // 原 allowed 继续只授权原选区窗；编辑窗是另一扇真实窗口，单独按它的主 frame 授权。
  ocr = installOcrIpc({ ipcMain, allowed: event => Boolean(active && active.phase === 'selecting' && active.editorOpen === true && active.editDocument && editorHost.isSender(event, active.editDocument.token)), getActive: () => active, nativeImage });

  return { start, startDesktop, prepare, isActive: () => Boolean(active), canFinishScroll: () => active?.phase === 'scrolling', getLastFile: () => lastFile,
    getCaptureRequest: scrolling.captureRequest, finishScroll: scrolling.finish,
    cancel: (reason = 'cancelled') => {
      if (!active || active.phase === 'saving') return false;
      active.dismissSource = 'control-cancel';
      end(active, true, reason);
      return true;
    },
    dispose: () => { disposed = true; prepareEnabled = false; prepareGeneration++;
      if (prepared) { releasePrepared(prepared); prepared = null; }
      // 逐层释放：不恢复任何窗口、不弹设置、不复活中间层；编辑宿主最后单独收掉。
      const layers = suspended.splice(0, suspended.length);
      if (active) end(active, false, 'app-quit');
      for (const parent of layers) releaseSession(parent);
      try { editorHost.dispose(); } catch { /* 退出路上不再抛。 */ } } };
}
module.exports = { installScreenshot };
