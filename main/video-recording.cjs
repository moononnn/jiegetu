'use strict';

// 视频录制（主进程侧）：独立的一次短录制会话。
//
// 采集源只走应用自己授权的那条路：录制页跑在一个**专用非持久分区**里，该分区上同时装
// displayMedia 请求处理与权限请求/检查处理；只有本轮录制页自己的 frame、且只认本地
// 录制页这一个 URL，才拿得到屏幕；授权用过即废，不做长期授权，也不给默认会话开口子。
// 麦克风默认不申请：只有用户在开始前明确打开才申请，且只给这一轮录制页。
//
// 渲染层契约（主审拥有 renderer，这里只定名字）：
//   录制页暴露 globalThis.startVideoRecording(config?)；主进程在页面加载完成后用
//   executeJavaScript('globalThis.startVideoRecording(<JSON>)', true) 调它 —— 第二参数
//   true 就是 Electron 的正式 userGesture，录制页因此能拿到可信手势。
//   渲染层不自动开录；config 只是快捷通道，拿不到时它可以走 bridge 的 video:config。

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { planAudio, placeIndicator, validateOutput, VIDEO_LIMITS } = require(path.join(__dirname, '..', 'core', 'video-session.mjs'));
const { timingDiagnostics } = require(path.join(__dirname, 'video-export.cjs'));

const PARTITION = 'jiegechang-video-recorder';
// 指示条做成一条扁条：全屏录制时它停在任务栏那一条（工作区外、屏幕内），看得见又录不到。
// 宽度按自己的内容定（状态 + 音源选项 + 三两个按钮），不用占满一整屏。
const INDICATOR_SIZE = { width: 500, height: 44 };
const INDICATOR_GAP = 8;
const RECORDER_TIMEOUT_MS = 20_000;   // 录制页多久内没进入录制就算失败
const OWNER_PHASE = 'video-recording';
// DEV 观测指标白名单：只放行这些键、且只收有限非负整数（写进主进程生命周期日志）。
const FREEZE_OBSERVE_KEYS = Object.freeze([
  'windowMs', 'elapsedMs', 'sourceFrames', 'sourceGapMs', 'sourceSupported',
  'paintCount', 'paintGapMs', 'outputFrames', 'outputGapMs', 'outputSupported',
]);
// 只在这些录制进行态收观测；别的阶段（还没开始、已结束、已进编辑器）一律不收。
const FREEZE_OBSERVE_STATES = new Set(['starting', 'recording', 'paused']);
const FREEZE_OBSERVE_MAX = 600_000;   // 指标上限：十分钟量级的整数

function installVideoRecording(options = {}) {
  const {
    BrowserWindow, ipcMain, screen, session, desktopCapturer,
    getActive, allowed, cancel, finishSession = cancel, onLifecycle = () => {}, onStatus = () => {},
    resolveSelection, resolveSaveFolder, writeFile, showSaveDialog, getOwnerWindow = () => null,
    rendererDir = path.join(__dirname, '..', 'renderer'),
    preloadPath = path.join(__dirname, 'video-preload.cjs'),
    editorPreloadPath = path.join(__dirname, 'video-editor-preload.cjs'), exportVideo, resolveVideoExporter,
    // DEV 试用开关：让“已经可见的指示条”兼任录制页（同一扇窗）。默认关；
    // 安装版与普通开发路径继续用隐藏录制窗 + 独立指示条。
    visibleRecorder = false,
    // DEV 观测开关：只在显式开始录制后统计源帧交付/裁切绘制/输出出帧，默认关。
    // 安装版永远走不到这里（主进程只在未打包时才传 true）。
    freezeObserve = false,
    limits = VIDEO_LIMITS, platform = process.platform, powerMonitor = null,
    fitMask = (win, nonce, bounds) => {
      const capture = require(path.join(__dirname, 'win-capture.cjs'));
      return capture.fitSelectionWindow(capture.handleToDecimal(win.getNativeWindowHandle()), process.pid, nonce, bounds);
    },
    checkMask = (win, nonce, bounds) => {
      const capture = require(path.join(__dirname, 'win-capture.cjs'));
      return capture.checkSelectionWindow(capture.handleToDecimal(win.getNativeWindowHandle()), process.pid, nonce, bounds);
    },
    recoverMask = (win, nonce, bounds) => {
      const capture = require(path.join(__dirname, 'win-capture.cjs'));
      return capture.fitVisibleMaskWindow(capture.handleToDecimal(win.getNativeWindowHandle()), process.pid, nonce, bounds);
    },
  } = options;

  let rec = null;                 // 当前这一轮录制会话
  let recorderSession = null;      // 专用分区会话
  let savedBytes = null;           // 用户取消保存时留下的产物，等重试

  // 导出/保存失败只对外给固定代码 + 一句中文；不把 stderr、路径或原始报错带到界面与日志。
  const EXPORT_MESSAGES = Object.freeze({
    'timeline-invalid': '剪辑参数无效，请重新调整范围',
    'timeline-too-many-cuts': '一次最多删除 24 段，请合并相邻的删除区间',
    'timeline-too-short': '有保留片段太短，请放宽删除区间',
    'export-input': '这段录像无法用于剪辑导出；原视频仍保留',
    'export-audio': '这段录像的声音时间轴不连续或不一致，暂时无法剪辑导出；原视频仍保留',
    'export-timing': '这段录像的时间轴暂时不支持剪辑导出；原视频仍保留',
    'export-encoder': '编码器未能完成剪辑导出；原视频仍保留',
    'export-tool': '本机视频工具不可用或校验失败；原视频仍保留',
    'export-cleanup': '临时文件未能清理；原视频仍保留，请检查用户数据目录的 video-editor-trial-scratch',
    'export-aborted': '剪辑已中止；原视频仍保留',
    'disk-exists': '同名文件已存在，请换个文件名',
    'disk-write': '写入文件失败，原视频仍保留',
    'save-path': '保存扩展名需与视频格式一致',
    'export-busy': '正在处理，请稍候',
    'export-failed': '剪辑导出失败，原视频仍保留，可重试或保存原视频',
  });
  const exportMessage = code => EXPORT_MESSAGES[code] || EXPORT_MESSAGES['export-failed'];
  const exportCode = error => {
    const raw = typeof error?.code === 'string' ? error.code : '';
    if (raw === 'TRIAL_CLEANUP_FAILED') return 'export-cleanup';
    return Object.hasOwn(EXPORT_MESSAGES, raw) ? raw : 'export-failed';
  };

  const surfacePage = path.join(rendererDir, 'video-surface.html');
  const surfaceURL = pathToFileURL(surfacePage).href;
  // 权限门只认这一轮“录制面”的精确 URL：可见面与隐藏录制页二选一，不再放其他页面。
  const recorderPageURL = visibleRecorder ? surfaceURL : pathToFileURL(path.join(rendererDir, 'video-recorder.html')).href;

  function note(event, fields = {}) {
    try { onLifecycle(event, fields); } catch { /* 留痕失败不挡录制。 */ }
  }
  function status(message) {
    try { onStatus(message); } catch { /* 状态显示失败不挡录制。 */ }
  }
  function live() { return Boolean(rec) && rec.closed !== true; }

  // —— 专用分区：录制页只活在这里，录完就拆 ——
  function ensureRecorderSession() {
    if (recorderSession) return recorderSession;
    if (!session || typeof session.fromPartition !== 'function') throw new Error('缺少可用的会话分区');
    recorderSession = session.fromPartition(PARTITION);
    if (typeof recorderSession.setDisplayMediaRequestHandler !== 'function') throw new Error('这个 Electron 不支持屏幕采集授权');

    // 权限门只认录制面的精确文件 URL：可见面（DEV）与隐藏录制页各自一套，互不兼容。
    const recorderURL = recorderPageURL;
    // 采集源身份：本轮未关、确实是当前录制窗的 mainFrame、状态还在 starting、URL 仍是那个精确页面、
    // 且该会话仍是前台会话。异步枚举前后都用同一个判定，不靠页面配合。
    const trustedCaptureSource = (current, frame) => Boolean(current && !current.closed && current.recorder && frame &&
      frame === current.recorder.webContents.mainFrame && current.videoState === 'starting' &&
      current.recorder.webContents.getURL?.() === recorderURL && getActive() === current.owner);

    // 请求处理：只有本轮录制页自己的 mainFrame、且目标屏幕就是这一轮选定的屏幕时才给。
    recorderSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const current = rec;
        const frame = request?.frame;
        if (!trustedCaptureSource(current, frame)) {
          note('video-source-rejected', { accepted: false });
          return callback({});
        }
        if (request?.videoRequested !== true || request?.userGesture !== true) {
          note('video-source-rejected', { accepted: false });
          return callback({});
        }
        // 授权用过即废：同一轮里第二次来要不给。
        if (current.grantConsumed) {
          note('video-source-rejected', { accepted: false });
          return callback({});
        }
        const allowLoopback = current.plan.wantSystem && platform === 'win32';
        if (request?.audioRequested === true && !allowLoopback) {
          note('video-source-rejected', { accepted: false });
          return callback({});
        }
        // 真的去桌面抓一份可用源：不用占位的 {id:'screen'}。
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        // 枚举是异步的：回来之后再用同一套身份条件重核一遍（关闭/换页/已授权/退出 starting 一律拒）。
        if (!trustedCaptureSource(current, frame) || current.grantConsumed || !live() || rec !== current) {
          note('video-source-rejected', { accepted: false });
          return callback({});
        }
        const source = sources.find(item => String(item.display_id) === String(current.displayId));
        if (!source) {
          note('video-source-rejected', { accepted: false });
          return callback({});
        }
        current.grantConsumed = true;
        note('video-source-granted', { accepted: true, systemAudio: allowLoopback });
        return callback(allowLoopback ? { video: source, audio: 'loopback' } : { video: source });
      } catch (error) {
        note('video-source-rejected', { accepted: false });
        return callback({});
      }
    }, { useSystemPicker: false });

    // Permission callback names depend on Electron/Chromium; the dedicated display
    // source handler still requires its own one-shot frame and gesture checks.
    // Electron 44.9.2 requests `media` with an explicit [] for display capture;
    // microphone and camera requests carry typed arrays. Never infer from missing metadata.
    const trustedRecorder = (webContents, details) => {
      const current = rec;
      return Boolean(current && !current.closed && current.videoState === 'starting' && getActive() === current.owner &&
        current.recorder && webContents === current.recorder.webContents && details?.isMainFrame === true &&
        webContents.getURL?.() === recorderURL);
    };
    const allowDisplay = (webContents, details) => trustedRecorder(webContents, details) && !rec.grantConsumed;
    const allowMediaRequest = (webContents, details) => {
      const current = rec;
      if (!trustedRecorder(webContents, details) || details?.requestingUrl !== recorderURL ||
          !Object.prototype.hasOwnProperty.call(details, 'mediaTypes') || !Array.isArray(details.mediaTypes)) return false;
      const types = details.mediaTypes;
      if (types.length === 0 && details.mediaType == null && !current.grantConsumed && !current.emptyDisplayMediaGranted) {
        current.emptyDisplayMediaGranted = true;
        return true;
      }
      return Boolean(current.grantConsumed && current.plan.wantMicrophone && types.length === 1 && types[0] === 'audio' &&
        (details.mediaType == null || details.mediaType === 'audio'));
    };
    const allowMediaCheck = (webContents, origin, details) => Boolean(trustedRecorder(webContents, details) &&
      origin === 'file://' && rec.grantConsumed && rec.plan.wantMicrophone && details?.mediaType === 'audio' &&
      (!Object.prototype.hasOwnProperty.call(details, 'mediaTypes') ||
        (Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio')));
    // Fixed categories only: never log origins, frame identities, device names or raw details.
    function notePermissionGate(webContents, permission, details, gate, allowed) {
      const current = rec;
      if (!current || current.closed || current.videoState !== 'starting' || webContents !== current.recorder?.webContents ||
          (permission !== 'media' && permission !== 'display-capture')) return;
      let types = 'absent';
      if (Array.isArray(details?.mediaTypes)) {
        const values = details.mediaTypes;
        types = values.length === 0 ? 'empty' : values.every(x => x === 'audio') ? 'audio' :
          values.every(x => x === 'video') ? 'video' : values.every(x => x === 'audio' || x === 'video') ? 'audio-video' : 'other';
      }
      note('video-permission-gate', { gate, permission: permission === 'media' ? 'media' : 'display-capture', types, allowed });
    }
    if (typeof recorderSession.setPermissionRequestHandler === 'function') {
      recorderSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const allowed = permission === 'display-capture' ? allowDisplay(webContents, details) :
          permission === 'media' ? allowMediaRequest(webContents, details) : false;
        notePermissionGate(webContents, permission, details, 'request', allowed);
        callback(allowed);
      });
    }
    if (typeof recorderSession.setPermissionCheckHandler === 'function') {
      recorderSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
        const origin = String(requestingOrigin || '');
        const allowed = permission === 'display-capture' ? allowDisplay(webContents, details) :
          permission === 'media' ? allowMediaCheck(webContents, origin, details) : false;
        notePermissionGate(webContents, permission, details, 'check', allowed);
        return allowed;
      });
    }
    return recorderSession;
  }

  function dropRecorderSession() {
    if (!recorderSession) return;
    try {
      if (typeof recorderSession.setDisplayMediaRequestHandler === 'function') recorderSession.setDisplayMediaRequestHandler(null);
      if (typeof recorderSession.setPermissionCheckHandler === 'function') recorderSession.setPermissionCheckHandler(null);
      if (typeof recorderSession.setPermissionRequestHandler === 'function') recorderSession.setPermissionRequestHandler(null);
    } catch { /* 已经没了就当拆干净。 */ }
    recorderSession = null;
  }

  function destroyWindow(win) {
    if (!win || win.isDestroyed()) return;
    try { win.destroy(); } catch { /* 关掉即可。 */ }
  }

  // 收尾：拆窗口、拆授权、结束会话、清掉待保存产物。任何结束路径都走这里。
  function cleanup(reason = 'video-ended') {
    const current = rec;
    if (!current) return false;
    // 先摘归属再收窗口：窗口的 closed 回调看到自己不在清单里，就不会把收尾当成异常。
    rec = null;
    current.closed = true;
    current.exportController?.abort();
    destroyWindow(current.editor);
    current.editor = undefined;
    if (current.timer) { clearTimeout(current.timer); current.timer = null; }
    if (current.detachPower) { try { current.detachPower(); } catch { /* 拆不掉就算了。 */ } current.detachPower = undefined; }
    const recorder = current.recorder;
    const indicator = current.indicator;
    const masks = current.masks || [];
    current.recorder = undefined;
    current.indicator = undefined;
    current.masks = [];
    for (const mask of masks) destroyWindow(mask);
    destroyWindow(recorder);
    destroyWindow(indicator);
    dropRecorderSession();
    savedBytes = null;
    note('video-cleanup', { reason });
    if (current.onClosed) { try { current.onClosed(reason); } catch { /* 回调失败不挡收尾。 */ } }
    return true;
  }

  function fail(reason, message) {
    const current = rec;
    if (!current || current.closed) return false;
    note('video-failed', { reason });
    status(message);
    if (current.videoState !== 'failed' && current.indicator && !current.indicator.isDestroyed()) {
      current.videoState = 'failed';
      clearTimeout(current.timer); current.timer = null;
      current.detachPower?.(); current.detachPower = undefined;
      if (sendToIndicator('video:indicator', { state: 'failed', message }) && current.recorder !== current.indicator) {
        const recorder = current.recorder;
        current.recorder = undefined;
        destroyWindow(recorder);
        return true;
      }
    }
    // 可见录制面（DEV）时录制页就是那扇窗：失败/超时/锁屏一律同步收掉采集面与遮罩，
    // 不靠页面配合停轨；cleanup + cancel 会把选区窗口恢复出来，status 已先行上报。
    cleanup(reason);
    if (getActive() === current.owner) cancel?.(reason);
    return true;
  }

  function sendToRecorder(channel, payload) {
    const current = rec;
    if (!current || current.closed || !current.recorder || current.recorder.isDestroyed()) return false;
    try { current.recorder.webContents.send(channel, payload); return true; } catch { return false; }
  }
  function sendToIndicator(channel, payload) {
    const current = rec;
    if (!current || current.closed || !current.indicator || current.indicator.isDestroyed()) return false;
    try { current.indicator.webContents.send(channel, payload); return true; } catch { return false; }
  }

  function fromWindow(win, event) {
    return Boolean(win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame);
  }
  function lockWindow(win) {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
  }

  // 屏幕的物理矩形：DIP 边界 × 缩放系数，采集流就是按这个口径裁的。
  function physicalDisplay(display) {
    const bounds = display?.bounds || {};
    const scale = Number(display?.scaleFactor) > 0 ? Number(display.scaleFactor) : 1;
    return { x: Math.round((Number(bounds.x) || 0) * scale), y: Math.round((Number(bounds.y) || 0) * scale),
      width: Math.round((Number(bounds.width) || 0) * scale), height: Math.round((Number(bounds.height) || 0) * scale) };
  }

  // 指示条位置：DIP 口径（工作区是 DIP，选区也是 DIP）。先在选区外找，再退到工作区外的
  // 任务栏条带（录制永远碰不到那一条），最后才进框内。
  function indicatorPlacement(current) {
    const display = screen?.getAllDisplays?.().find(item => String(item.id) === String(current.displayId));
    const area = display?.workArea;
    if (!area) return undefined;
    return placeIndicator({ area, bounds: display?.bounds, selection: current.dip, size: INDICATOR_SIZE, gap: INDICATOR_GAP });
  }

  async function loadPage(win, file, label) {
    await win.loadFile(file);
    note('video-page-loaded', { page: label });
  }

  async function createWindows(current) {
    // 先找指示条的安全位置：选区外四处、再试框内四角；都放不下才拒绝。
    const placement = indicatorPlacement(current);
    if (!placement) throw new Error('选区和屏幕上都放不下录制指示条，请调整选区大小或位置');
    ensureRecorderSession();

    let recorder, indicator;
    if (visibleRecorder) {
      // 可见录制面：同一扇窗既是指示条也是录制页，位置仍是选区外那块。
      // 不新增窗口、不做预览、不隐藏任何东西。
      const surface = new BrowserWindow({
        ...placement, show: false, frame: false, resizable: false, movable: false, alwaysOnTop: true, skipTaskbar: true,
        focusable: true, hasShadow: false, thickFrame: false, transparent: true, backgroundColor: '#00000000',
        backgroundThrottling: false,
        webPreferences: { partition: PARTITION, preload: preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      recorder = surface;
      indicator = surface;
      current.recorder = surface;
      current.indicator = surface;
      lockWindow(surface);
      surface.on('closed', () => {
        // 只有它还是当前录制面时才算“意外关闭”：openEditor/cleanup 会先摘引用再销毁，
        // 那两次的 closed 事件不能反过来触发 fail()。
        if (rec === current && !current.closed && current.recorder === surface) fail('video-surface-closed', '录制窗口意外关闭');
      });
      await loadPage(surface, surfacePage, 'surface');
    } else {
      const hidden = new BrowserWindow({
        show: false, frame: false, skipTaskbar: true, focusable: false, movable: false, resizable: false,
        backgroundColor: '#000000', width: 320, height: 240,
        webPreferences: { partition: PARTITION, preload: preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
      });
      current.recorder = hidden;
      lockWindow(hidden);
      hidden.on('closed', () => { if (rec === current && current.recorder === hidden) fail('video-recorder-closed', '录制窗口意外关闭'); });

      const bar = new BrowserWindow({
        ...placement, show: false, frame: false, resizable: false, movable: false, alwaysOnTop: true, skipTaskbar: true,
        focusable: true, hasShadow: false, thickFrame: false, transparent: true, backgroundColor: '#00000000',
        backgroundThrottling: false,
        webPreferences: { partition: PARTITION, preload: preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      current.indicator = bar;
      lockWindow(bar);
      bar.on('closed', () => { if (live() && current.indicator === bar) fail('video-indicator-closed', '录制指示条意外关闭'); });

      await loadPage(hidden, path.join(rendererDir, 'video-recorder.html'), 'recorder');
      if (rec !== current || current.closed) throw new Error('录制准备已取消');
      await loadPage(bar, path.join(rendererDir, 'video-indicator.html'), 'indicator');

      recorder = hidden;
      indicator = bar;
    }
    if (rec !== current || current.closed) throw new Error('录制准备已取消');

    // Compute the only clear opening before drawing the four dim panels.
    const bounds = current.display.bounds, roi = current.dip;
    const values = [bounds?.x, bounds?.y, bounds?.width, bounds?.height, roi?.x, roi?.y, roi?.width, roi?.height];
    if (!values.every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 || roi.width <= 0 || roi.height <= 0) throw new Error('遮罩几何无效');
    const left = Math.ceil(bounds.x), top = Math.ceil(bounds.y);
    const right = Math.floor(bounds.x + bounds.width), bottom = Math.floor(bounds.y + bounds.height);
    const x0 = Math.max(left, Math.floor(roi.x) - 2), y0 = Math.max(top, Math.floor(roi.y) - 2);
    const x1 = Math.min(right, Math.ceil(roi.x + roi.width) + 2), y1 = Math.min(bottom, Math.ceil(roi.y + roi.height) + 2);
    if (left >= right || top >= bottom || x0 >= x1 || y0 >= y1 || roi.x < bounds.x || roi.y < bounds.y ||
        roi.x + roi.width > bounds.x + bounds.width || roi.y + roi.height > bounds.y + bounds.height) throw new Error('遮罩选区不在目标屏幕内');
    // Windows may enforce a minimum top-level window width even when minWidth is 1;
    // thin side windows can therefore leave a large unshaded gap. Use the existing
    // monitor-sized scroll mask instead, with four painted panels and one clear hole.
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger)) throw new Error('遮罩屏幕边界无效');
    const mask = new BrowserWindow({ ...bounds, frame: false, transparent: true, backgroundColor: '#00000000',
      show: false, alwaysOnTop: true, skipTaskbar: true, focusable: false, resizable: false, movable: false,
      enableLargerThanScreen: true, hasShadow: false, roundedCorners: false, thickFrame: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    current.masks = [mask];
    lockWindow(mask);
    mask.setIgnoreMouseEvents(true);
    mask.setAlwaysOnTop(true, 'screen-saver');
    mask.on('closed', () => { if (rec === current && !current.closed && current.masks.includes(mask)) fail('video-mask-closed', '录制遮罩意外关闭'); });
    mask.on('hide', () => { if (rec === current && !current.closed && current.masks.includes(mask)) fail('video-mask-hidden', '录制遮罩意外隐藏'); });
    mask.webContents.on('render-process-gone', () => { if (rec === current && !current.closed && current.masks.includes(mask)) fail('video-mask-crashed', '录制遮罩异常'); });
    const nonce = randomUUID().replace(/-/g, '');
    mask.setTitle(nonce);
    await fitMask(mask, nonce, current.displayPhysical);
    if (rec !== current || current.closed) throw new Error('录制准备已取消');
    // The fit helper has checked the actual PMv2 physical monitor rectangle. Project
    // the capture's physical ROI through the mask page's *own* viewport; Electron's
    // getBounds() may report virtualised DIP geometry and is not authoritative here.
    const physical = current.displayPhysical, region = current.physical;
    if (!physical || !region || ![physical.x, physical.y, physical.width, physical.height, region.x, region.y, region.width, region.height].every(Number.isSafeInteger) ||
        physical.width <= 0 || physical.height <= 0 || region.width <= 0 || region.height <= 0 ||
        region.x < physical.x || region.y < physical.y || region.x + region.width > physical.x + physical.width || region.y + region.height > physical.y + physical.height) throw new Error('录制遮罩物理区域无效');
    // scroll-mask.js expands by one viewport pixel plus outward rounding (<2 DIP).
    const px0 = region.x - physical.x, py0 = region.y - physical.y;
    const px1 = px0 + region.width, py1 = py0 + region.height;
    const layout = { frame: { width: physical.width, height: physical.height }, pixels: {
      x: px0, y: py0, width: px1 - px0, height: py1 - py0 } };
    if (layout.pixels.width <= 0 || layout.pixels.height <= 0) throw new Error('录制遮罩安全区域无效');
    await mask.loadFile(path.join(rendererDir, 'scroll-mask.html'), { query: { layout: JSON.stringify(layout) } });
    if (rec !== current || current.closed) throw new Error('录制准备已取消');
    // Loading the document may replace the BrowserWindow title; restore its identity nonce.
    mask.setTitle(nonce);
    const view = await mask.webContents.executeJavaScript('({ ready: window.regionMaskReady === true, width: innerWidth, height: innerHeight })');
    if (rec !== current || current.closed || !view?.ready || !Number.isSafeInteger(view.width) || !Number.isSafeInteger(view.height) || view.width <= 0 || view.height <= 0) throw new Error('录制遮罩页面未就绪');
    async function verifyMask(phase) {
      try { await checkMask(mask, nonce, physical); } catch (error) {
        const reason = require('./win-capture.cjs').maskCheckReason(error);
        note('video-mask-check-failed', { phase, reason });
        const failure = new Error(`录制遮罩显示${phase === 'before-show' ? '前' : '后'}物理校验失败（${reason}）`);
        failure.maskCheckReason = reason;
        throw failure;
      }
    }
    await verifyMask('before-show');
    if (rec !== current || current.closed) throw new Error('录制准备已取消');
    mask.showInactive();
    if (!mask.isVisible()) throw new Error('录制遮罩未显示');
    const ownerValid = () => rec === current && !current.closed && getActive() === current.owner &&
      current.owner.phase === OWNER_PHASE && current.ownerWindow && !current.ownerWindow.isDestroyed?.() && !mask.isDestroyed() && mask.isVisible();
    try { await verifyMask('after-show'); } catch (error) {
      // Only the observed post-show outer-rectangle mismatch gets one repair attempt.
      if (error.maskCheckReason !== 'window-rect-mismatch' || !ownerValid()) throw error;
      try { await recoverMask(mask, nonce, physical); } catch {
        note('video-mask-recovery', { result: 'failed' });
        throw new Error('录制遮罩显示后物理恢复失败');
      }
      if (!ownerValid()) throw new Error('录制准备已取消');
      await verifyMask('after-show');
      note('video-mask-recovery', { result: 'physical-verified' });
    }
    if (!ownerValid()) throw new Error('录制准备已取消');
    const shownView = await mask.webContents.executeJavaScript('({ ready: window.regionMaskReady === true, width: innerWidth, height: innerHeight })');
    if (!ownerValid() || !shownView?.ready || shownView.width !== view.width || shownView.height !== view.height) throw new Error('录制遮罩视口已变化');
    indicator.setAlwaysOnTop(true, 'screen-saver');
    indicator.showInactive?.();
    return { recorder, indicator };
  }

  // 系统锁定/挂起：录制必须停，并且明确算“未保存”，不留一条黑着的采集口。
  function attachPowerWatch(current) {
    const monitor = powerMonitor;
    if (!monitor || typeof monitor.on !== 'function') return;
    const onLocked = () => {
      if (!live()) return;
      if ((typeof current.exportVideo === 'function' || current.resolvingTrial) && savedBytes) {
        if (current.resolvingTrial) current.trialInterrupted = true;
        current.exportController?.abort();
        status('系统锁定或挂起，剪辑已中止；原视频仍保留');
      } else fail('video-locked', '系统锁定或挂起，录制已停止（结果未保存）');
    };
    monitor.on('lock-screen', onLocked);
    monitor.on('suspend', onLocked);
    current.detachPower = () => {
      try { monitor.removeListener?.('lock-screen', onLocked); } catch { /* 已经没了。 */ }
      try { monitor.removeListener?.('suspend', onLocked); } catch { /* 已经没了。 */ }
    };
  }

  ipcMain.handle('shot:video-begin', async (event, payload = {}) => {
    const current = getActive();
    if (!current || !allowed(event)) throw new Error('无效选区窗口');
    if (rec) throw new Error('已经有一轮视频录制在进行');
    const rect = payload?.rect || {};
    if (current.phase !== 'selecting' || current.editDocument) throw new Error('当前选区不能录制视频');
    const resolved = await resolveSelection(current, rect);
    if (rec || getActive() !== current || !allowed(event) || current.phase !== 'selecting') throw new Error('选区已变化，请重新录制');
    if (!resolved || !resolved.display || !resolved.physical || !resolved.dip) throw new Error('无法确定录制归属');
    if (!(resolved.physical.width > 1 && resolved.physical.height > 1)) throw new Error('选区太小');
    const owner = getOwnerWindow();
    const session = {
      plan: null, display: resolved.display, displayId: resolved.display.id,
      physical: resolved.physical, dip: resolved.dip, closed: false, timer: null, onClosed: null,
      grantConsumed: false, emptyDisplayMediaGranted: false, ownerWindow: owner, owner: current, displayPhysical: resolved.displayPhysical || physicalDisplay(resolved.display),
    };
    rec = session;
    current.phase = OWNER_PHASE;
    let loadTimer;
    try {
      await Promise.race([createWindows(session), new Promise((_, reject) => {
        loadTimer = setTimeout(() => reject(new Error('录制窗口加载超时')), RECORDER_TIMEOUT_MS);
      })]);
      if (rec !== session || getActive() !== current || !owner || owner.isDestroyed?.()) throw new Error('选区已关闭');
      owner.hide();
      if (owner.isVisible?.()) throw new Error('截图蒙版未收起，不能开始录制');
    } catch (error) {
      if (rec === session) cleanup('video-begin-failed');
      if (getActive() === current && current.phase === OWNER_PHASE) { current.phase = 'selecting'; owner?.show?.(); }
      throw error;
    } finally { clearTimeout(loadTimer); }
    attachPowerWatch(session);
    session.videoState = 'ready';
    note('video-begin', {});
    status('已准备好 · 点击开始录制');
    return { started: true };
  });

  ipcMain.handle('video:config', event => {
    const current = rec;
    if (!current || current.closed) throw new Error('没有进行中的视频录制');
    if (!fromWindow(current.recorder, event)) throw new Error('无效的录制窗口');
    if (!current.plan) throw new Error('录制尚未开始');
    return {
      selection: current.physical, displayPhysical: current.displayPhysical,
      displayId: String(current.displayId),
      plan: current.plan, limits: { maxDurationMs: limits.MAX_DURATION_MS, maxBytes: limits.MAX_BYTES },
      ...(freezeObserve ? { observe: true } : {}),
    };
  });

  // DEV 观测上报：只放行固定白名单里的整数指标（不收字符串、路径、媒体或任意字段），
  // 写进主进程自己的生命周期日志；渲染层传什么都不照抄。
  // 只在本轮录制的进行态收（开始中/录制中/暂停中），每轮最多收一次，数值必须是范围内的安全整数。
  ipcMain.handle('video:observe', (event, payload = {}) => {
    const current = rec;
    if (!current || current.closed) return false;
    if (!fromWindow(current.recorder, event)) return false;
    if (!freezeObserve) return false;
    if (!FREEZE_OBSERVE_STATES.has(current.videoState)) return false;
    if (current.freezeObserved) return false;
    const metrics = {};
    for (const key of FREEZE_OBSERVE_KEYS) {
      const value = payload?.[key];
      if (!Number.isSafeInteger(value) || value < 0 || value > FREEZE_OBSERVE_MAX) continue;
      metrics[key] = value;
    }
    if (!Object.keys(metrics).length) return false;
    current.freezeObserved = true;
    note('video-freeze-observe', metrics);
    return true;
  });

  ipcMain.handle('video:state', (event, payload = {}) => {
    const current = rec;
    if (!current || current.closed) return false;
    if (!fromWindow(current.recorder, event)) return false;
    if (payload?.state === 'recording' && current.videoState === 'starting') {
      current.videoState = 'recording';
      if (current.timer) { clearTimeout(current.timer); current.timer = null; }
      sendToIndicator('video:indicator', { state: 'recording' });
      status('正在录制视频');
      return true;
    }
    if (payload?.state === 'paused' && current.videoState === 'recording') current.videoState = 'paused';
    else if (payload?.state === 'resumed' && current.videoState === 'paused') current.videoState = 'recording';
    if (payload?.state === 'failed') {
      fail('video-failed', String(payload?.message || '录制失败'));
      return true;
    }
    sendToIndicator('video:indicator', { state: payload?.state || 'unknown' });
    return true;
  });

  ipcMain.handle('video:action', async (event, action, choices = {}) => {
    const current = rec;
    if (!current || current.closed) return false;
    if (!fromWindow(current.indicator, event)) return false;
    if (current.videoState === 'editing') return false;
    if (action === 'start' && current.videoState === 'ready') {
      current.plan = Object.freeze(planAudio({ systemAudio: choices?.systemAudio === true, microphone: choices?.microphone === true }));
      current.videoState = 'starting';
      note('video-start', { systemAudio: current.plan.wantSystem, microphone: current.plan.wantMicrophone });
      const config = { selection: current.physical, displayPhysical: current.displayPhysical,
        displayId: String(current.displayId), plan: current.plan, limits: { maxDurationMs: limits.MAX_DURATION_MS, maxBytes: limits.MAX_BYTES },
        ...(freezeObserve ? { observe: true } : {}) };
      current.timer = setTimeout(() => { if (rec === current) fail('video-start-timeout', '录制没有在时限内开始'); }, RECORDER_TIMEOUT_MS);
      try {
        await current.recorder.webContents.executeJavaScript(`globalThis.startVideoRecording(${JSON.stringify(config)})`, true);
        return rec === current;
      } catch (error) { fail('video-start-failed', `录制页没能启动：${error.message}`); return false; }
    }
    if (action === 'pause' && current.videoState === 'recording') return sendToRecorder('video:pause', {});
    if (action === 'resume' && current.videoState === 'paused') return sendToRecorder('video:resume', {});
    if (action === 'stop' && ['recording', 'paused'].includes(current.videoState)) return sendToRecorder('video:stop', {});
    if (action === 'retry-save') {
      if (!savedBytes || current.saving) return false;
      return saveCurrent(current);
    }
    if (action === 'cancel') {
      note('video-cancelled', {});
      cleanup('video-cancel');
      if (typeof cancel === 'function') { try { cancel('video-cancel'); } catch { /* 会话可能已经结束。 */ } }
      status('视频录制已取消');
      return true;
    }
    return false;
  });

  ipcMain.handle('video:result', async (event, payload = {}) => {
    const current = rec;
    if (!current || current.closed) throw new Error('没有进行中的视频录制');
    if (!fromWindow(current.recorder, event)) throw new Error('无效的录制窗口');
    if (savedBytes || current.saving || !(payload?.bytes instanceof Uint8Array)) throw new Error('无效的录制结果');
    const bytes = payload.bytes;
    const extension = payload?.extension === 'mp4' ? 'mp4' : payload?.extension === 'webm' ? 'webm' : '';
    validateOutput({ bytes, mimeType: payload?.mimeType, extension, limits });
    savedBytes = { bytes: Uint8Array.from(bytes), extension, mimeType: payload.mimeType, hasAudio: Boolean(current.plan?.wantSystem || current.plan?.wantMicrophone), encoderInterrupted: payload.encoderInterrupted === true };
    let selectedExporter = exportVideo;
    if (typeof selectedExporter !== 'function' && typeof resolveVideoExporter === 'function') {
      current.resolvingTrial = true; current.saving = true;
      try { selectedExporter = await resolveVideoExporter(); } catch { selectedExporter = null; }
      finally { current.resolvingTrial = false; current.saving = false; }
      if (rec !== current || current.closed) return { saved:false, canceled:false };
      if (current.trialInterrupted) {
        current.videoState = 'unsaved';
        sendToIndicator('video:indicator', { state:'unsaved', message:'系统锁定或挂起，原视频保留，可重试保存' });
        return { saved:false, canceled:false, message:'原视频保留，可重试保存' };
      }
    }
    current.exportVideo = typeof selectedExporter === 'function' ? selectedExporter : null;
    if (current.exportVideo) {
      if (!['recording', 'paused'].includes(current.videoState)) { savedBytes = null; throw new Error('录制尚未结束'); }
      try { await openEditor(current); return { saved: false, canceled: false, editing: true }; }
      catch {
        if (rec !== current || current.closed) return { saved: false, canceled: false };
        current.videoState = 'unsaved';
        status('编辑器未能打开，原视频仍保留，请保存原视频');
      }
    }
    return saveCurrent(current);
  });

  ipcMain.handle('video:retry-save', async event => {
    const current = rec;
    if (!current) throw new Error('没有待保存的录制结果');
    if (!fromWindow(current.recorder, event)) throw new Error('无效的录制窗口');
    if (!savedBytes) throw new Error('没有待保存的录制结果');
    return saveCurrent(current);
  });

  function editorEvent(event) {
    const current = rec;
    const url = pathToFileURL(path.join(rendererDir, 'video-editor.html')).href;
    if (!current || current.closed || current.videoState !== 'editing' || !savedBytes ||
        !fromWindow(current.editor, event) || current.editor.webContents.getURL() !== url) throw new Error('无效的视频编辑窗口');
    return current;
  }

  // 新的剪辑契约：{durationMs,startMs,endMs,cuts?:[{startMs,endMs}]}；空数组等于不删。
  // 旧的单段 cutStartMs/cutEndMs 仍可用；两种形式同时出现一律拒绝。
  function normalizeEditPayload(payload) {
    const { normalizeVideoEdit, TIMELINE_CODES } = require(path.join(__dirname, '..', 'core', 'video-edit.mjs'));
    const invalid = message => {
      const error = new Error(message);
      error.code = TIMELINE_CODES.invalid;
      return error;
    };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid('剪辑参数必须是对象');
    const allowed = new Set(['durationMs', 'startMs', 'endMs', 'cuts', 'cutStartMs', 'cutEndMs']);
    if (Object.keys(payload).some(key => !allowed.has(key))) throw invalid('剪辑参数包含未知字段');
    if (!['durationMs', 'startMs', 'endMs'].every(key => Number.isSafeInteger(payload[key]))) throw invalid('剪辑时间必须是整数毫秒');
    const legacy = 'cutStartMs' in payload || 'cutEndMs' in payload;
    const listed = 'cuts' in payload;
    if (legacy && listed) throw invalid('不能同时提交单段删除和删除列表');
    if (legacy && !('cutStartMs' in payload && 'cutEndMs' in payload)) throw invalid('单段删除需要同时给出起止时间');
    if (listed && payload.cuts !== undefined && !Array.isArray(payload.cuts)) throw invalid('删除区间必须是数组');
    return normalizeVideoEdit({ durationMs: payload.durationMs, startMs: payload.startMs, endMs: payload.endMs,
      cuts: listed ? (payload.cuts ?? []) : null,
      remove: legacy ? { startMs: payload.cutStartMs, endMs: payload.cutEndMs } : null });
  }

  function closeEditor(current, discard) {
    if (current.saving || rec !== current || current.closed) return { canceled: true, message: '正在保存，请稍候' };
    if (discard !== true) return { confirmationRequired: true };
    cleanup('video-editor-discard');
    if (typeof finishSession === 'function') { try { finishSession(current.owner, 'video-editor-discard'); } catch { /* 会话可能已经结束。 */ } }
    return { canceled: false };
  }

  async function openEditor(current) {
    // 自绘标题栏：没有系统标题栏与系统菜单；拖动/关闭由页面上的 .titlebar 负责，
    // 关闭仍走同一个 closeEditor 确认，不绕过草稿保护。
    const editor = new BrowserWindow({ width: 840, height: 700, minWidth: 480, minHeight: 520, show: false,
      frame: false, roundedCorners: true, resizable: true, movable: true, maximizable: false, fullscreenable: false,
      autoHideMenuBar: true, title: '截个图', icon: path.join(__dirname, '..', 'assets', 'app-icon.ico'), backgroundColor: '#fbf8f2',
      webPreferences: { preload: editorPreloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } });
    current.editor = editor;
    current.videoState = 'editing';
    lockWindow(editor);
    editor.removeMenu?.();
    // 页面里有自己的 <title>：不让它把任务栏标题从「截个图」改走。窗口标题与分组身份不变。
    editor.on('page-title-updated', event => event.preventDefault());
    editor.on('close', event => {
      event.preventDefault();
      if (rec === current && !current.closed && current.editor === editor && !editor.isDestroyed()) editor.webContents.send('video-editor:close-requested');
    });
    editor.on('closed', () => {
      if (rec !== current || current.closed || current.editor !== editor) return;
      current.editor = undefined; current.videoState = 'unsaved';
      current.exportController?.abort();
      current.indicator?.show?.();
      sendToIndicator('video:indicator', { state: 'unsaved', message: '编辑器已关闭，原视频保留，可重试保存' });
    });
    try {
      await editor.loadFile(path.join(rendererDir, 'video-editor.html'));
      if (rec !== current || current.closed || editor.isDestroyed()) throw new Error('编辑器已关闭');
      // 录制结果只会在所有轨道释放后才上交，所以这里已经不存在“继续采集”。
      // 顺序：先把编辑器显示出来，再拆采集面——万一显示失败，采集面还在，原视频还能重试保存。
      const recorder = current.recorder;
      const aliased = current.indicator === recorder;
      try { current.indicator?.hide?.(); } catch { /* 已经没了。 */ }
      editor.show();
      if (editor.isVisible() !== true) throw new Error('编辑器未能显示');
      // 先摘掉两个别名引用，再销毁：销毁会同步发 'closed'，不能让它把刚打开的编辑当失败收掉。
      current.recorder = undefined;
      if (aliased) current.indicator = undefined;
      const masks = current.masks; current.masks = []; for (const mask of masks) destroyWindow(mask);
      dropRecorderSession();
      destroyWindow(recorder);
    } catch (error) {
      current.editor = undefined;
      destroyWindow(editor);
      // 回到“可重试保存原视频”的状态：采集面（可见面或指示条）还在。
      current.videoState = 'unsaved';
      if (current.indicator && !current.indicator.isDestroyed?.()) {
        current.indicator.show?.();
        sendToIndicator('video:indicator', { state: 'unsaved', message: '编辑器未能打开，原视频保留，可重试保存' });
      }
      throw error;
    }
  }

  ipcMain.handle('video-editor:load', event => {
    const current = editorEvent(event);
    if (current.editorLoaded) throw new Error('视频已加载');
    current.editorLoaded = true;
    return { bytes: Uint8Array.from(savedBytes.bytes), mimeType: savedBytes.mimeType, originalExtension: savedBytes.extension,
      warning: savedBytes.encoderInterrupted ? '编码中断，视频可能不完整' : undefined };
  });
  ipcMain.handle('video-editor:save-original', event => saveCurrent(editorEvent(event)));
  ipcMain.handle('video-editor:close', (event, discard) => closeEditor(editorEvent(event), discard));
  ipcMain.handle('video-editor:export', async (event, payload) => {
    const current = editorEvent(event);
    if (current.saving) return { saved: false, canceled: false, code: 'export-busy', message: exportMessage('export-busy') };
    try {
      const normalized = normalizeEditPayload(payload);
      if (normalized.noOp) return await saveCurrent(current);
      current.saving = true;
      const controller = new AbortController(); current.exportController = controller;
      let output;
      try {
        output = await current.exportVideo({ original: { bytes: Uint8Array.from(savedBytes.bytes), extension: savedBytes.extension,
          mimeType: savedBytes.mimeType, hasAudio: savedBytes.hasAudio },
          plan: { durationMs: normalized.durationMs, ranges: normalized.spans.map(span => ({ ...span })), totalMs: normalized.totalMs }, signal: controller.signal });
        if (controller.signal.aborted || rec !== current || current.closed) throw new Error('剪辑已中止');
        if (!(output?.bytes instanceof Uint8Array)) throw new Error('导出结果无效');
        validateOutput({ bytes: output.bytes, extension: output.extension, mimeType: output.mimeType, hasAudio: savedBytes.hasAudio, limits });
        output = { bytes: Uint8Array.from(output.bytes), extension: output.extension, mimeType: output.mimeType };
      } finally { current.exportController = undefined; current.saving = false; }
      return await saveCurrent(current, output);
    } catch (error) {
      const code = exportCode(error);
      // 只附带白名单子码 + 粗粒度数值指标（导出器已净化）；不帯原始报错、路径或 stderr。
      const diagnostics = timingDiagnostics(error);
      note('video-export-failed', { code, ...diagnostics });
      const message = code.startsWith('timeline-') && typeof error?.message === 'string' && error.message ? error.message : exportMessage(code);
      return { saved: false, canceled: false, code, message, ...diagnostics };
    }
  });

  async function saveCurrent(current, payload = savedBytes) {
    if (!payload || rec !== current || current.saving) return { saved: false, canceled: false, message: '正在处理，请稍候' };
    const editorSave = Boolean(current.editor);
    current.saving = true;
    try {
    const folder = typeof resolveSaveFolder === 'function' ? resolveSaveFolder() : undefined;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const suggested = `录制-${stamp}.${payload.extension}`;
    const options = { title: payload.encoderInterrupted ? '编码中断，视频可能不完整 — 保存视频' : '保存视频', defaultPath: folder ? path.join(folder, suggested) : suggested,
      filters: [{ name: payload.extension === 'mp4' ? 'MP4 视频' : 'WebM 视频', extensions: [payload.extension] }] };
    // 本地保存对话框，挂在指示条上（用户正看着它）。
    const result = await showSaveDialog(current.editor || current.indicator, options);
    if (rec !== current || current.closed) return false;
    if (!result || result.canceled || !result.filePath) {
      // 用户取消保存：产物留着，可以重试，不做静默丢弃。
      sendToIndicator('video:indicator', { state: 'unsaved', message: payload.encoderInterrupted ? '编码中断，视频可能不完整；结果保留，可重试保存' : '已取消保存，录制结果保留，可重试' });
      note('video-save-cancelled', {});
      return { saved: false, canceled: true, message: '已取消保存，录制结果保留' };
    }
    if (path.extname(result.filePath).toLowerCase() !== `.${payload.extension}`) {
      const error = new Error('保存扩展名需与视频格式一致');
      error.code = 'save-path';
      throw error;
    }
    await writeFile(result.filePath, payload.bytes, { flag: 'wx' });
    if (rec !== current || current.closed) return false;
    savedBytes = null;
    note('video-saved', { extension: payload.extension, bytes: payload.bytes.length });
    sendToIndicator('video:indicator', { state: 'saved' });
    cleanup('video-saved');
    if (typeof finishSession === 'function') { try { finishSession(current.owner, 'video-saved'); } catch { /* 会话可能已经结束。 */ } }
    status('视频已保存');
    return editorSave ? { saved: true } : { saved: true, filePath: result.filePath };
    } catch (error) {
      const code = error?.code === 'EEXIST' ? 'disk-exists' : error?.code === 'save-path' ? 'save-path' : 'disk-write';
      note('video-save-failed', { code });
      if (rec === current && !current.closed) sendToIndicator('video:indicator', { state: 'unsaved', message: exportMessage(code) });
      return { saved: false, canceled: false, code, message: exportMessage(code) };
    } finally { current.saving = false; }
  }

  return {
    dispose() {
      cleanup('video-dispose');
      savedBytes = null;
    },
    // 供测试与上层查询：当前是否有录制会话。
    current: () => rec,
    saved: () => savedBytes,
  };
}

module.exports = { installVideoRecording, PARTITION, INDICATOR_SIZE, RECORDER_TIMEOUT_MS, OWNER_PHASE };
