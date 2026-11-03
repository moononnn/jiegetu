'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { toPixels } = require('../core/coordinates.cjs');
const { createDiagnostics } = require('../main/diagnostics.cjs');
const os = require('node:os');
function recordingFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'longshot-commit-test-'));
  const r = createDiagnostics({ directory });
  t.after(async () => { r.end('cancelled'); await r.flush(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { r, directory, rows: () => fs.readFileSync(r.getFile(), 'utf8').trim().split('\n').map(JSON.parse) };
}

function harness({ probeBusy = false, mismatch = false, saveFails = false, copyFails = false, deferCopy = false, cancelSave = false, dialogFails = false, diagnostics, onCaptureEnd, onLifecycle, controlVisible = true, scaleFactors = [1], platform = 'darwin', deferSnapshot = false, badNativeFrame = false, nativeFresh = true, warmFails = false, deferredDies = false, loadFails = false, deferLoad = false, displays, enumerate, cursor = { x: -500, y: 200 }, readySkew = 0, settings, foreground, skewUntilFit = false,
  // 健康探针夹具：默认只答视口对象（缺 ready 字段）→ 探针 unknown，不当成健康也不丢图。
  probeMode = 'viewport', messageBoxResponse = 0, messageBoxFails = false, deferMessageBox = false, stuckHidden = false,
  // 页面视口夹具：默认等于窗口回读的 DIP 边界；125% 副屏那种「窗口 865 / 页面 864」用 viewportDelta 造。
  viewportDelta, viewportOverride, deferViewport = false,
  // 独立编辑宿主夹具：默认页面就绪握手自动完成；失败开关模拟页面拒绝/窗不能上屏。
  editorReadyFails = false, editorShowFails = false, deferEditorReady = false,
  // 原生快照像素夹具：snapshotOffset 造出带 byteOffset 的视图，验证零复制时保留偏移；
  // nativeDataKind='uint8' 返回类型不符的帧，验证共享前的字节型校验。
  snapshotOffset = 0, nativeDataKind = 'clamped' } = {}) {
  const handlers = new Map();
  const windows = [];
  const writes = [];
  const dialogs = [];
  const chosenPath = path.resolve('chosen-folder-not-written', 'chosen-image.png');
  const statuses = [];
  const copied = [];
  let foregroundQueries = 0;
  const crops = [];
  const timers = [];
  let releaseCopy;
  const copyGate = deferCopy ? new Promise(resolve => { releaseCopy = resolve; }) : Promise.resolve();
  let sourceOptions;
  let loadDeferred = deferLoad, resolveLoad;
  let normalizationDecodes = 0;
  let scrollHooks;
  // 多屏夹具：每块屏带自己的 DIP 边界、缩放和真实物理矩形。物理原点由夹具直接给出，
  // 不按「DIP 原点 × 本屏缩放」推算，才能验到混合 DPI 下的取屏与裁切。
  const displaySpecs = displays ?? [{ id: 7, bounds: { x: -1920, y: 0, width: platform === 'win32' ? 4 : 1920, height: platform === 'win32' ? 3 : 1080 }, scaleFactor: 2 }];
  const physicalRects = new Map();
  const displayList = displaySpecs.map(spec => {
    const entry = { id: spec.id, bounds: { ...spec.bounds }, scaleFactor: spec.scaleFactor, workArea: { ...(spec.workArea ?? spec.bounds) } };
    physicalRects.set(entry.id, spec.physical ? { ...spec.physical } : { x: Math.round(entry.bounds.x * entry.scaleFactor), y: Math.round(entry.bounds.y * entry.scaleFactor),
      width: Math.round(entry.bounds.width * entry.scaleFactor), height: Math.round(entry.bounds.height * entry.scaleFactor) });
    return entry;
  });
  let visibleDisplays = displayList;
  let cursorPoint = { ...cursor };
  const cursorReads = [];
  const probeCalls = [];
  const messageBoxes = [];
  let currentProbeMode = probeMode, resolveProbe;
  let currentMessageBoxResponse = messageBoxResponse, resolveMessageBox;
  // 物理窗口适配：可成功/拒绝/挂起，用来验证顺序、取消与失败提示。
  const fitCalls = [];
  const viewportProbes = [];
  let resolveViewport;
  let fitMode = 'ok', resolveFit, rejectFit;
  // 监视器矩形查询：默认把 Electron 的物理矩形当真实矩形返回（旧用例行为不变）；hint 用例可指定真实矩形。
  const monitorQueries = [];
  let monitorQuery = 'ok', resolveMonitor, rejectMonitor;
  const workQueries = [];
  let workQuery = 'ok', resolveWork, rejectWork;
  const realRectFor = hint => {
    const spec = displaySpecs.find(value => value.hint && ['x', 'y', 'width', 'height'].every(key => value.hint[key] === hint[key]));
    if (spec) return { ...physicalRects.get(spec.id) };
    const entry = displayList.find(value => { const rect = physicalRects.get(value.id); return ['x', 'y', 'width', 'height'].every(key => rect[key] === hint[key]); });
    return entry ? { ...physicalRects.get(entry.id) } : undefined;
  };
  const workRectFor = hint => {
    const spec = displaySpecs.find(value => value.workHint && ['x', 'y', 'width', 'height'].every(key => value.workHint[key] === hint[key]));
    if (spec) return { ...(spec.workPhysical ?? physicalRects.get(spec.id)) };
    const entry = displayList.find(value => ['x', 'y', 'width', 'height'].every(key => physicalRects.get(value.id)[key] === hint[key]));
    return entry ? { ...physicalRects.get(entry.id) } : undefined;
  };
  const display = displayList[0];
  const physical = physicalRects.get(display.id);
  // 选区窗口在「鼠标所在屏」上；物理矩形按该屏自己的映射取，不全局乘一个缩放。
  const nearestDisplay = point => visibleDisplays.find(entry => point.x >= entry.bounds.x && point.x < entry.bounds.x + entry.bounds.width &&
    point.y >= entry.bounds.y && point.y < entry.bounds.y + entry.bounds.height) ??
    [...visibleDisplays].sort((a, b) => Math.hypot(a.bounds.x + a.bounds.width / 2 - point.x, a.bounds.y + a.bounds.height / 2 - point.y) -
      Math.hypot(b.bounds.x + b.bounds.width / 2 - point.x, b.bounds.y + b.bounds.height / 2 - point.y))[0];
  const bitmapInputs = [], nativeRegions = [], nativeOptions = [], frameDatas = [];
  let nativeStops = 0, nativeNexts = 0, rejectSnapshot, resolveSnapshot;
  let frameSize = { ...physical };
  const nativePixels = new Uint8ClampedArray(platform === 'win32' ? physical.width * physical.height * 4 : 0);
  for(let i=0;i<nativePixels.length;i+=4)nativePixels.set([(i+13)%256,(i+24)%256,(i+35)%256,255],i);
  // 真实 win-capture 每帧 new Uint8ClampedArray：普通快照会在原缓冲上原地换 R/B，夹具必须每帧一份独立副本，
  // 否则跨帧串味。snapshotOffset 用来造“带 byteOffset 的视图”，验零复制时偏移要原样保留。
  const nativeFrame = () => {
    const size = frameSize.width * frameSize.height * 4;
    let data;
    if (badNativeFrame) data = new Uint8Array(4);
    else if (nativePixels.length !== size) data = new Uint8ClampedArray(size);
    else if (nativeDataKind === 'uint8') data = new Uint8Array(nativePixels);
    else if (snapshotOffset > 0) {
      const backing = new Uint8ClampedArray(size + snapshotOffset * 2);
      backing.set(nativePixels, snapshotOffset);
      data = backing.subarray(snapshotOffset, snapshotOffset + size);
    } else data = new Uint8ClampedArray(nativePixels);
    frameDatas.push(data);
    return { fresh: nativeFresh, width: frameSize.width, height: frameSize.height, data };
  };
  // 每次 createWinCapture 一个独立源：预备源被停掉后不能影响后面的冷路径。
  const makeNativeSource = options => {
    let stopped = false, rejectPending;
    return {
      next: () => {
        nativeNexts++;
        if (deferSnapshot) return new Promise((resolve, reject) => { resolveSnapshot = () => resolve(nativeFrame()); rejectPending = reject; rejectSnapshot = reject; });
        if (warmFails && options?.deferredStart === true) return Promise.reject(new Error('原生采集已中断（exit code=1 signal=null）'));
        return Promise.resolve(nativeFrame());
      },
      stop: () => { if (stopped) return; stopped = true; nativeStops++; rejectPending?.(new Error('原生采集已取消')); },
      get alive() { return !stopped; },
      get status() { return stopped ? 'stopped' : 'ready'; },
      deferred: options?.deferredStart === true
    };
  };
  // 每块屏有自己的底图尺寸：缩略图路径按请求尺寸，原生路径按物理矩形。
  const mockImage = size => ({ isEmpty: () => false, getScaleFactors: () => scaleFactors, toPNG: () => Buffer.from('png'),
    getSize: () => ({ width: size.width + (mismatch ? 1 : 0), height: size.height }),
    toDataURL: () => 'data:image/png;base64,test', crop: rect => { crops.push(rect); return { getSize: () => ({ width: rect.width, height: rect.height }), toPNG: () => Buffer.from('png'), toDataURL: () => `data:image/png;base64,crop-${rect.width}x${rect.height}` }; } });
  let image = mockImage(frameSize);
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.bounds = options; this.destroyed = false; this.webContents = new EventEmitter();
      this.webContents.mainFrame = {}; this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (channel, ...args) => {
        (this.sent ??= []).push({ channel, args, fitCount: fitCalls.length, loads: (this.loads ?? []).length });
        // 独立编辑宿主：页面就绪握手由夹具代答（真实页面里是 editor.open 完成后的 ready IPC）。
        if (channel === 'shot:editor-open') {
          const payload = args[0];
          if (deferEditorReady) return;   // 由用例手动回 ready，用来测半熟悉状态的互斥
          queueMicrotask(() => {
            const handler = handlers.get(editorReadyFails ? 'shot:editor-open-failed' : 'shot:editor-ready');
            if (!handler || !payload) return;
            try {
              const event = { sender: this.webContents, senderFrame: this.webContents.mainFrame };
              if (editorReadyFails) handler(event, payload.token, '页面打不开');
              else handler(event, payload.token);
            } catch { /* 夹具代答失败只让被测代码自己超时。 */ }
          });
        }
      };
      this.webContents.invalidate = () => { this.invalidates = (this.invalidates ?? 0) + 1; };
      this.webContents.executeJavaScript = async code => {
        // 健康探针与视口读取分开：探针只回布尔元数据的形状，视口仍是原夹子。
        if (code.includes('readyState')) {
          probeCalls.push(code);
          if (currentProbeMode === 'reject') throw new Error('探针失败');
          if (currentProbeMode === 'defer') await new Promise(resolve => { resolveProbe = resolve; });
          if (currentProbeMode === 'drawable') return { ready: true };
          if (currentProbeMode === 'blocked') return { ready: false };
          return { width: this.bounds.width, height: this.bounds.height };
        }
        viewportProbes.push({ code, bounds: { ...this.bounds } });
        if (deferViewport) await new Promise(resolve => { resolveViewport = resolve; });
        if (viewportOverride !== undefined) return viewportOverride;
        return { width: this.bounds.width + (viewportDelta?.width ?? 0), height: this.bounds.height + (viewportDelta?.height ?? 0) };
      };
      this.params = undefined;
      this.alwaysOnTop = options.alwaysOnTop === true;
      this.skipTaskbar = options.skipTaskbar !== false;
      this.topmostCalls = [];
      // 模拟“未物理适配时回读多 1 DIP”，用来证明 ready 只在适配后才通过。
      this.skew = skewUntilFit;
      windows.push(this);
    }
    setAlwaysOnTop(value, level) { this.topmostCalls.push({ value, level }); this.alwaysOnTop = value; }
    isAlwaysOnTop() { return this.alwaysOnTop; }
    setSkipTaskbar(value) { this.skipTaskbar = value; }
    isSkipTaskbar() { return this.skipTaskbar; }
    setBounds(bounds) { this.bounds = bounds; }
    getBounds() { const base = readySkew ? { ...this.bounds, width: this.bounds.width + readySkew } : this.bounds;
      return this.skew ? { ...base, width: base.width + 1, height: base.height + 1 } : base; }
    setContentProtection(value) { this.contentProtected = value; }
    async loadFile(file) { (this.loads ??= []).push(file); if (loadFails) throw new Error('页面加载失败');
      if (loadDeferred && String(file).endsWith('selection.html')) await new Promise(resolve => { resolveLoad = resolve; }); }
    async loadURL(url) { (this.urls ??= []).push(url); }
    setTitle(value) { this.title = value; }
    getNativeWindowHandle() { const raw = Buffer.alloc(8); raw.writeBigUInt64LE(1234567890n, 0); return raw; }
    show() { this.shows = (this.shows ?? 0) + 1; if (editorShowFails && this.options?.title === '截个图 · 图片编辑') throw new Error('编辑窗无法显示'); if (!stuckHidden) this.visible = true; }
    isVisible() { return Boolean(this.visible); }
    hide() { this.visible = false; }
    focus() {}
    minimize() { this.minimized = true; }
    isMinimized() { return Boolean(this.minimized); }
    restore() { this.minimized = false; this.restores = (this.restores ?? 0) + 1; }
    moveTop() { this.raised = (this.raised ?? 0) + 1; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    // 模拟编辑页渲染进程援溃：只为独立编辑宿主用例提供。
    crashRenderer() { this.webContents.emit('render-process-gone', {}, { reason: 'crashed' }); }
  }
  const electron = { BrowserWindow: Window,
    dialog: { showMessageBox: async (ownerOrOptions, maybeOptions) => {
      // 有 parent 时 Electron 的签名是 (win, options)，无 parent 时只有 options。
      const options = maybeOptions === undefined ? ownerOrOptions : maybeOptions;
      messageBoxes.push({ parent: maybeOptions === undefined ? undefined : ownerOrOptions, options });
      if (messageBoxFails) throw new Error('dialog unavailable');
      if (deferMessageBox) await new Promise(resolve => { resolveMessageBox = resolve; });
      return currentMessageBoxResponse === undefined ? undefined : { response: currentMessageBoxResponse };
    }, showSaveDialog: async (owner, options) => {
      dialogs.push({ owner, options });
      if (dialogFails) throw new Error('dialog unavailable');
      return cancelSave ? { canceled: true } : { canceled: false, filePath: chosenPath };
    } },
    desktopCapturer: { getSources: async options => { sourceOptions = options; frameSize = { ...options.thumbnailSize }; image = mockImage(frameSize);
      return visibleDisplays.map(entry => ({ display_id: String(entry.id), thumbnail: image })); } },
    screen: { getDisplayNearestPoint: point => { cursorReads.push({ ...point }); return nearestDisplay(point); }, getCursorScreenPoint: () => ({ ...cursorPoint }),
      getAllDisplays: () => visibleDisplays.filter(entry => !enumerate || enumerate.includes(entry.id))
        .map(entry => ({ id: entry.id, bounds: { ...entry.bounds }, scaleFactor: entry.scaleFactor, workArea: { ...entry.workArea } })),
      getPrimaryDisplay: () => visibleDisplays[0],
      dipToScreenRect: (owner, rect) => { const hit = displayList.find(entry => entry.bounds.x === rect.x && entry.bounds.y === rect.y &&
          entry.bounds.width === rect.width && entry.bounds.height === rect.height);
        if (!hit) {
          const workSpec = displaySpecs.find(value => value.workArea && value.workArea.x === rect.x && value.workArea.y === rect.y &&
            value.workArea.width === rect.width && value.workArea.height === rect.height);
          if (workSpec) return workSpec.workHint ? { ...workSpec.workHint } : { ...physicalRects.get(workSpec.id) };
          return { x: Math.round(rect.x * 2), y: Math.round(rect.y * 2), width: Math.round(rect.width * 2), height: Math.round(rect.height * 2) };
        }
        const spec = displaySpecs.find(value => value.id === hit.id);
        return spec?.hint ? { ...spec.hint } : { ...physicalRects.get(hit.id) }; } },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    nativeImage: { createFromBuffer: bytes => { normalizationDecodes++; if (bytes?.length >= 33 && bytes.toString('ascii',12,16) === 'IHDR') return { isEmpty: () => false, getSize: () => ({width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)}), toPNG: () => Buffer.from('edited-png') }; return image; }, createFromBitmap: (pixels, options) => { bitmapInputs.push({pixels,options});return mockImage(options); } },
    // 以已安装 Electron 44 的接口声明为准，不提供旧版 writeImage。
    ClipboardItem: class ClipboardItem { constructor(items) { this.items = items; } },
    clipboard: { write: async values => {
      if (copyFails) throw new Error('clipboard busy');
      copied.push(values);
      await copyGate;
    } }
  };
  const fakeFs = { mkdir: async () => {}, writeFile: async (file, bytes, options) => {
    if (saveFails) throw new Error('disk unavailable');
    writes.push({ file, bytes, options });
  } };
  const control = { visible: controlVisible, hides: 0, shows: 0, isVisible() { return this.visible; }, hide() { this.hides++; this.visible = false; }, show() { this.shows++; this.visible = true; } };
  // 识别子进程夹具：只记录输入与 kill 次数，不真的起进程。
  let ocrOptions, ocrHelperExists = true;
  const ocrSpawns = [];
  const fakeOcrChild = () => { const child = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdin.chunks = []; child.stdin.ended = false;
    child.stdin.end = value => { child.stdin.chunks.push(Buffer.from(value)); child.stdin.ended = true; };
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.killed = 0;
    child.kill = () => { child.killed += 1; }; return child; };
  const exports = {};
  // GIF 录制替身（替换 installRecording）：截图只需 cleanup 与一条 record-preview 会话；
  // 真正的展示窗是控制条 bar，current.win 仍是那张已隐藏的冻图窗。不跑采集/编码。
  let recordingOptions = null, recordingApi = null;
  const context = { module: { exports }, exports, process: { platform, pid: 4321 }, __dirname: path.resolve(__dirname, '../main'), Buffer,
    setTimeout: (fn, ms) => {
      const timer = { ms, fn, cleared: false };
      timers.push(timer);
      if (ms === 220) queueMicrotask(fn);
      return timer;
    }, clearTimeout: timer => { if (timer) timer.cleared = true; },
    require: name => name === 'electron' ? electron : name === path.join(__dirname, '../main/recording.cjs') ? {
      installRecording: options => {
        recordingOptions = options;
        recordingApi = {
          cleanup: current => {
            const rec = current?.recording;
            if (rec?.bar && !rec.bar.isDestroyed()) { try { rec.bar.destroy(); } catch { /* 已毁。 */ } }
            if (current) current.recording = undefined;
          },
          beginPreview: (current, patch = {}) => {
            const bar = new electron.BrowserWindow({ width: 420, height: 100, show: false, frame: false });
            current.recording = { bar, preview: { bytes: new Uint8Array([1, 2, 3]), width: 4, height: 4, elapsedMs: 120, sourceId: 'src' }, ...patch };
            // 与真实录制一致：冻结窗退场，真正展示的是控制条。
            try { current.win?.hide?.(); } catch { /* 已隐藏。 */ }
            current.phase = 'record-preview';
            bar.show();
            return bar;
          } };
        return recordingApi;
      } } : name === './edited-image.cjs' ? require('../main/edited-image.cjs') : name === './image-editor-window.cjs' ? require('../main/image-editor-window.cjs') : name === 'node:fs/promises' ? fakeFs :
      name === '../core/coordinates.cjs' ? { toPixels } : name === './scrolling.cjs' ? {
        installScrolling: hooks => { scrollHooks = hooks; return { cleanup() {}, finish() {}, captureRequest() {} }; }
      } : name === './win-capture.cjs' ? { createWinCapture: (region, options) => {nativeRegions.push(region);nativeOptions.push(options ?? {});frameSize = { width: region.width, height: region.height };image = mockImage(frameSize);
        if (deferredDies && options?.deferredStart === true) { nativeStops++; return { next: () => Promise.reject(new Error('原生采集已中断（exit code=1 signal=null）')), stop: () => {}, alive: false, status: 'failed', deferred: true }; }
        return makeNativeSource(options);},
        handleToDecimal: require('../main/win-capture.cjs').handleToDecimal,
        fitSelectionWindow: (handle, pid, nonce, bounds) => {
          fitCalls.push({ handle, pid, nonce, bounds: { ...bounds } });
          if (fitMode === 'reject') return Promise.reject(new Error('窗口物理布局失败'));
          if (fitMode === 'defer') return new Promise((resolve, reject) => { resolveFit = () => resolve({ ...bounds }); rejectFit = reject; });
          // skip 模式：声称成功但不真的改窗口，用来验证 ready 仍会拦住 1099×619。
          if (fitMode !== 'skip') { const target = windows.at(-1); if (target) target.skew = false; }
          return Promise.resolve({ ...bounds });
        },
        queryMonitorBounds: hint => {
          monitorQueries.push({ ...hint });
          if (monitorQuery === 'reject') return Promise.reject(new Error('显示器矩形查询失败'));
          if (monitorQuery === 'defer') return new Promise((resolve, reject) => { resolveMonitor = () => resolve(realRectFor(hint)); rejectMonitor = reject; });
          const real = realRectFor(hint);
          return real ? Promise.resolve(real) : Promise.reject(new Error('显示器矩形查询失败'));
        },
        queryMonitorWorkArea: hint => {
          workQueries.push({ ...hint });
          if (workQuery === 'reject') return Promise.reject(new Error('显示器矩形查询失败'));
          if (workQuery === 'defer') return new Promise((resolve, reject) => { resolveWork = () => resolve(workRectFor(hint)); rejectWork = reject; });
          const real = workRectFor(hint);
          return real ? Promise.resolve(real) : Promise.reject(new Error('显示器矩形查询失败'));
        },
        fitDesktopWindow: (handle, pid, nonce, bounds) => { fitCalls.push({ mode: 'desktop', handle, pid, nonce, bounds: { ...bounds } }); return Promise.resolve({ ...bounds }); },
        checkDesktopWindow: (handle, pid, nonce, bounds) => Promise.resolve({ ...bounds }) } : name === './ocr.cjs' ? { installOcrIpc: options => {
        // 用真的识别模块 + 假 spawn/假 exists：守卫、单飞与取消都跑真实代码，进程不出场。
        ocrOptions = options;
        return require('../main/ocr.cjs').installOcrIpc({ ...options, platform: 'win32', timeoutMs: 200, exists: () => ocrHelperExists,
          spawn: (file, argv, options) => { const child = fakeOcrChild(); ocrSpawns.push({ file, argv, options, child }); return child; } });
      } } : require(name) };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../main/screenshot.cjs'), 'utf8'), context);
  const api = context.module.exports.installScreenshot({ getControl: () => control, isProbeBusy: () => probeBusy,
    directory: path.resolve('test-output-not-written'), settings, onStatus: status => statuses.push(status), diagnostics, onCaptureEnd, onLifecycle,
    queryForeground: options => { foregroundQueries++; return foreground === undefined ? 0 : foreground; } });
  const event = () => ({ sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame });
  const invoke = (name, ...values) => handlers.get(name)(event(), ...values);
  // 手动完成编辑宿主就绪握手（deferEditorReady 时用）。
  const readyEditor = () => {
    const win = windows.at(-1);
    const open = (win.sent ?? []).filter(item => item.channel === 'shot:editor-open').at(-1);
    if (!open) throw new Error('没有待就绪的编辑窗');
    return handlers.get('shot:editor-ready')({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, open.args[0].token);
  };
  // 嵌套截图时子窗不是 windows[0]：按指定窗口的 main frame 发 IPC（仍走真实 allowed 校验）。
  const invokeOn = (win, name, ...values) => handlers.get(name)({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...values);
  return { api, windows, writes, dialogs, chosenPath, statuses, copied, crops, timers, releaseCopy, control, invoke, invokeOn, handlers, readyEditor, sourceOptions: () => sourceOptions, normalizationDecodes: () => normalizationDecodes, bitmapInputs, nativeRegions, nativeOptions, nativePixels, nativeStops: () => nativeStops, nativeNexts: () => nativeNexts,    getCurrent: () => scrollHooks.getActive(),
    resolveLoad: () => resolveLoad?.(), setDeferLoad: value => { loadDeferred = Boolean(value); },
    // 主进程注入给长截会话的交接入口（真实入口，不是桩）：用例直接调它验证成图窗口流程。
    get hooks() { return scrollHooks; },
    fitCalls, setFitMode: value => { fitMode = value; }, resolveFit: () => resolveFit?.(), rejectFit: error => rejectFit?.(error),
    monitorQueries, setMonitorQuery: value => { monitorQuery = value; }, resolveMonitor: () => resolveMonitor?.(), rejectMonitor: error => rejectMonitor?.(error),
    workQueries, setWorkQuery: value => { workQuery = value; }, resolveWork: () => resolveWork?.(), rejectWork: error => rejectWork?.(error),
    cursorReads, setCursor: point => { cursorPoint = { ...point }; }, resolveSnapshot: () => resolveSnapshot?.(),
    setDeferSnapshot: value => { deferSnapshot = Boolean(value); },
    viewportProbes, resolveViewport: () => resolveViewport?.(), setDeferViewport: value => { deferViewport = Boolean(value); },
    probeCalls, messageBoxes, setProbe: value => { currentProbeMode = value; }, resolveProbe: value => resolveProbe?.(value), frameDatas,
    setMessageBoxResponse: value => { currentMessageBoxResponse = value; }, resolveMessageBox: value => resolveMessageBox?.(value),
    fireTimer: ms => { const timer = [...timers].reverse().find(entry => entry.ms === ms && !entry.cleared); timer?.fn(); },
    invalidates: () => windows.reduce((total, win) => total + (win.invalidates ?? 0), 0),
    dropDisplay: id => { visibleDisplays = visibleDisplays.filter(entry => entry.id !== id); },
    patchDisplay: (id, patch) => { visibleDisplays = visibleDisplays.map(entry => entry.id === id ? { ...entry, ...patch } : entry); },
    cancelScroll: reason => scrollHooks.cancel(reason),
    foregroundQueries: () => foregroundQueries,
    foregroundHwnd: () => scrollHooks.getActive()?.foregroundHwnd,
    setPhase: phase => { scrollHooks.getActive().phase = phase; },
    setLongOutput: (pending = false) => { const current = scrollHooks.getActive(); current.longToken = 'long-token'; current.longPreviewPending = pending;
      current.longImage = { getSize: () => ({ width: 20, height: 500 }), toPNG: () => Buffer.from('long-png'), toDataURL: () => 'data:image/png;base64,full-size' }; },
    recordingOptions: () => recordingOptions,
    beginRecordPreview: (patch = {}) => recordingApi.beginPreview(scrollHooks.getActive(), patch),
    ocrSpawns, ocrOptions: () => ocrOptions, setOcrHelper: value => { ocrHelperExists = Boolean(value); } };
}

for(const hideControl of [true,false])for(const controlVisible of [true,false])for(const outcome of ['cancel','copy'])test(`入口隐藏与完成恢复矩阵 hide=${hideControl} visible=${controlVisible} outcome=${outcome}`,async()=>{
  const h=harness({controlVisible});await h.api.start({hideControl});
  assert.equal(h.control.visible,hideControl?false:controlVisible);
  assert.equal(h.control.hides,hideControl?1:0);
  assert.equal(h.timers.some(t=>t.ms===220),hideControl&&controlVisible);
  if(!hideControl)assert.equal(h.statuses.length,0,'保留画面时不在冻结前改设置页文案');
  await h.invoke('shot:ready');
  if(outcome==='cancel')h.api.cancel();else await h.invoke('shot:commit',{x:0,y:0,width:10,height:10},'copy');
  assert.equal(h.control.visible,hideControl&&outcome==='copy'?false:controlVisible);
  assert.equal(h.control.shows,hideControl&&controlVisible&&outcome==='cancel'?1:0,'只恢复本次实际隐藏的窗口');
  assert.equal(h.api.isActive(),false);
});
for(const hideControl of [true,false])for(const controlVisible of [true,false])test(`冻结失败不额外弹出或隐藏设置页 hide=${hideControl} visible=${controlVisible}`,async()=>{
  const h=harness({hideControl,controlVisible,mismatch:true});await h.api.start({hideControl});
  assert.equal(h.api.isActive(),false);assert.equal(h.control.visible,controlVisible);
  assert.equal(h.control.shows,hideControl&&controlVisible?1:0);
});

test('F1：控制页已隐藏时不增加固定220ms等待，1x底图不做PNG解码往返', async () => {
  const h = harness({ controlVisible: false, platform: 'win32' }); await h.api.start();
  assert.equal(h.timers.some(t => t.ms === 220), false);
  assert.equal(h.normalizationDecodes(), 0);
  assert.equal(h.sourceOptions(), undefined, 'Windows 不再取 desktopCapturer 缩略图');
  assert.deepEqual([...h.bitmapInputs[0].pixels.slice(0,4)], [35,24,13,255]);
  assert.equal(h.bitmapInputs[0].pixels.buffer, h.frameDatas[0].buffer, '位图直接读原生帧内存，不再整帧复制');
  assert.deepEqual([...h.nativePixels.slice(0,4)], [13,24,35,255], '夹具模板保持 RGBA，换色发生在帧自己的独占缓冲上');
  assert.deepEqual({...h.bitmapInputs[0].options}, {width:8,height:6,scaleFactor:1}); assert.equal(h.nativeStops(), 1);
  assert.deepEqual({...h.nativeRegions[0]}, {x:-3840,y:0,width:8,height:6});
  assert.deepEqual(h.nativeOptions.map(option => ({ ...option })), [{ purpose: 'snapshot' }], '冻结底图是唯一按普通快照预算取屏的调用');
  const payload=await h.invoke('shot:init'),bmp=Buffer.from(payload.bmpBytes);
  assert.equal(payload.dataUrl,undefined,'Windows 不再把整屏拼成 base64 字符串');
  assert.equal(bmp.toString('ascii',0,2),'BM');
  assert.equal(bmp.length,54+8*6*4);
  assert.equal(bmp.readUInt32LE(2),54+8*6*4);assert.equal(bmp.readUInt32LE(10),54);
  assert.equal(bmp.readInt32LE(18),8);assert.equal(bmp.readInt32LE(22),-6);assert.equal(bmp.readUInt16LE(28),32);
  for(let i=0;i<h.nativePixels.length;i+=4){const p=h.nativePixels;assert.deepEqual([...bmp.subarray(54+i,54+i+4)],[p[i+2],p[i+1],p[i],p[i+3]]);}
  await h.invoke('shot:ready'); h.api.cancel(); assert.equal(h.control.visible, false);
});

test('普通快照零复制：带 byteOffset 的帧视图直接被位图读取，偏移与长度原样保留', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, snapshotOffset: 8 });
  await h.api.start({ hideControl: false });
  const frame = h.frameDatas[0], bitmap = h.bitmapInputs[0].pixels;
  assert.equal(bitmap.buffer, frame.buffer, '位图与原生帧共用同一个 ArrayBuffer');
  assert.equal(bitmap.byteOffset, 8, '偏移原样传递，没有被拷到 0 偏移的新缓冲');
  assert.equal(bitmap.byteLength, frame.byteLength, '长度等于帧本身，不带前后垫片');
  assert.deepEqual([...frame.subarray(0, 4)], [35, 24, 13, 255], '换色发生在这块独占缓冲上');
  assert.deepEqual([...bitmap.slice(0, 4)], [35, 24, 13, 255], '颜色与 alpha 与旧路径一致');
  const bmp = Buffer.from((await h.invoke('shot:init')).bmpBytes);
  assert.equal(bmp.length, 54 + 8 * 6 * 4);
  assert.deepEqual([...bmp.subarray(54, 58)], [35, 24, 13, 255], 'BMP 像素同样是 BGRA');
  h.api.cancel();
});

test('普通快照只接受单字节 Uint8ClampedArray：类型不符的帧明确拒绝且不建窗口', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, nativeDataKind: 'uint8' });
  await h.api.start({ hideControl: false });
  assert.equal(h.api.isActive(), false, '坏帧不得留会话');
  assert.match(h.statuses.at(-1).message, /像素缓冲不可共享/);
  assert.equal(h.bitmapInputs.length, 0, '不拿不可共享的缓冲去建位图');
  assert.ok(h.windows.every(win => win.isDestroyed()), '没把半成品窗口留在屏上');
});

test('跨屏合成仍只读原生帧：不原地换色、不共享合成画布', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, displays: [
    { id: 1, bounds: { x: 0, y: 0, width: 4, height: 3 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 4, y: 0, width: 4, height: 3 }, scaleFactor: 1 }] });
  await h.api.start({ hideControl: false });
  assert.equal(h.getCurrent().mode, 'desktop');
  assert.ok(h.frameDatas.length >= 2, '每屏一帧');
  for (const frame of h.frameDatas) assert.deepEqual([...frame.subarray(0, 4)], [13, 24, 35, 255], '跨屏路径不在原缓冲上换色');
  assert.ok(h.bitmapInputs.every(item => item.pixels.buffer !== h.frameDatas[0].buffer), '合成画布不借用屏幕帧内存');
  h.api.cancel();
});
test('只有冻结底图带 snapshot 用途，保存或复制不再新建原生采集', async () => {
  const h = harness({ platform: 'win32', controlVisible: false });
  await h.api.start(); await h.invoke('shot:init'); await h.invoke('shot:ready');
  assert.deepEqual(h.nativeOptions.map(option => ({ ...option })), [{ purpose: 'snapshot' }]);
  const result = await h.invoke('shot:commit', { x: 0, y: 0, width: 4, height: 2 }, 'copy');
  assert.equal(result.ok, true);
  assert.equal(h.nativeOptions.length, 1); assert.equal(h.nativeRegions.length, 1);
});
test('直接保存写进设置好的文件夹，不弹另存框', async () => {
  const folder = path.resolve('configured-folder-not-written');
  const settings = { resolveSaveFolder: () => folder, resolveAsFolder: () => folder, update: () => {} };
  const h = harness({ platform: 'win32', controlVisible: false, settings });
  await h.api.start(); await h.invoke('shot:init'); await h.invoke('shot:ready');
  const result = await h.invoke('shot:commit', { x: 0, y: 0, width: 2, height: 2 }, 'save-quick');
  assert.equal(result.ok, true);
  assert.equal(h.dialogs.length, 0, '直接保存不能弹另存框');
  assert.equal(h.writes.length, 1);
  assert.equal(path.dirname(h.writes[0].file), folder);
  assert.equal(h.writes[0].bytes.toString(), 'png');
});
test('另存为从上次手选的目录开始，保存成功后记住它', async () => {
  const picked = path.resolve('picked-folder-not-written');
  const updates = [];
  const settings = { resolveSaveFolder: fallback => fallback, resolveAsFolder: () => picked, update: patch => updates.push(patch) };
  const h = harness({ platform: 'win32', controlVisible: false, settings });
  await h.api.start(); await h.invoke('shot:init'); await h.invoke('shot:ready');
  const result = await h.invoke('shot:commit', { x: 0, y: 0, width: 2, height: 2 }, 'save');
  assert.equal(result.ok, true);
  assert.equal(path.dirname(h.dialogs[0].options.defaultPath), picked, '弹框起点是上次那个文件夹');
  assert.equal(updates.at(-1)?.lastSaveFolder, path.dirname(h.chosenPath), '下次再开还从这个位置开始');
});
test('Windows 普通截图仍保存PNG，不把临时BMP预览作为输出', async () => {
  const h=harness({platform:'win32',controlVisible:false});await h.api.start();
  const payload=await h.invoke('shot:init');assert.ok(payload.bmpBytes.length>54);assert.equal(payload.dataUrl,undefined);await h.invoke('shot:ready');
  const result=await h.invoke('shot:commit',{x:0,y:0,width:2,height:2},'save');
  assert.equal(result.ok,true);assert.equal(h.writes.length,1);assert.equal(h.writes[0].bytes.toString(),'png');assert.equal(h.copied.length,0);
});
test('底图未归时选区页已加载：开窗与取帧并行，上屏仍等页面 init', async () => {
  const events = [];
  const h = harness({ platform: 'win32', controlVisible: false, deferSnapshot: true,
    onLifecycle: (event, fields) => events.push({ event, ...fields }) });
  const job = h.api.start();
  await new Promise(resolve => setImmediate(resolve));
  const win = h.windows[0];
  assert.ok(win, '底图未归时窗口已建');
  assert.ok(win.loads?.some(file => file.endsWith('selection.html')), '底图未归时页面已加载完');
  assert.ok(!win.visible, '页面加载完也不能先上屏');
  assert.equal(h.fitCalls.length, 1, '物理适配只做一次');
  h.resolveSnapshot();
  await job;
  await h.invoke('shot:init'); await h.invoke('shot:ready');
  assert.equal(win.visible, true);
  h.api.cancel();
  const timing = events.find(row => row.event === 'capture-timing');
  assert.ok(Number.isInteger(timing.windowMs) && timing.windowMs >= 0, '开窗耗时要能读出来');
  assert.ok(timing.shownMs >= timing.windowMs, '上屏不早于开窗');
});

test('prepare 单屏预载真选区页 + 延迟源：不取帧、不激活 init、不上屏、不 fit', async () => {
  const h = harness({ platform: 'win32', controlVisible: false });
  const result = await h.api.prepare();
  assert.equal(result.prepared, true);
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].isVisible(), false, '暖窗一直隐藏');
  assert.ok(h.windows[0].loads.some(file => file.endsWith('selection.html')), '预载的是真选区页');
  assert.equal(h.windows[0].urls, undefined, '不再载 about:blank');
  assert.equal(h.windows[0].sent, undefined, '预载不发 activate');
  assert.equal(h.nativeRegions.length, 1);
  assert.equal(h.nativeOptions[0].deferredStart, true);
  assert.equal(h.nativeOptions[0].purpose, 'snapshot');
  assert.equal(h.nativeNexts(), 0, '预备不取帧/不发 N');
  assert.equal(h.fitCalls.length, 0, '预备不物理 fit');
  assert.equal(h.probeCalls.length, 0);
  assert.equal(h.nativeStops(), 0);
  h.api.dispose();
});

test('预载页加载失败：prepare 返回 false 并销毁窗/停源，不留暖件', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, loadFails: true });
  const result = await h.api.prepare();
  assert.equal(result.prepared, false);
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].isDestroyed(), true, '加载失败不留下暖窗');
  assert.equal(h.windows[0].sent, undefined, '不激活');
  assert.ok(h.nativeStops() >= 1, '暖源也停掉');
  h.api.dispose();
});

test('预载页 renderer 崩溃 / 主 frame 加载失败：start 丢弃暖件走冷回退', async () => {
  const invokeLast = (h, name) => h.handlers.get(name)({ sender: h.windows.at(-1).webContents, senderFrame: h.windows.at(-1).webContents.mainFrame });
  const crashed = harness({ platform: 'win32', controlVisible: false });
  assert.equal((await crashed.api.prepare()).prepared, true);
  const warm = crashed.windows[0];
  warm.webContents.emit('render-process-gone');
  await crashed.api.start({ hideControl: false });
  await invokeLast(crashed, 'shot:init'); await invokeLast(crashed, 'shot:ready');
  assert.equal(crashed.api.isActive(), true, '预载页崩了不影响正式截图冷路径');
  assert.equal(warm.destroyed, true, '崩掉的暖窗被回收');
  assert.equal(crashed.windows.length, 2, '另建一个冷窗');
  assert.equal(crashed.nativeRegions.length, 2, '暖源 + 冷源');
  crashed.api.cancel();

  const failed = harness({ platform: 'win32', controlVisible: false });
  assert.equal((await failed.api.prepare()).prepared, true);
  const page = failed.windows[0];
  page.webContents.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'file:///selection.html', false);
  assert.equal((await failed.api.prepare()).reused, true, '非主 frame 失败不算预载页失败');
  page.webContents.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'file:///selection.html', true);
  await failed.api.start({ hideControl: false });
  await invokeLast(failed, 'shot:init'); await invokeLast(failed, 'shot:ready');
  assert.equal(failed.api.isActive(), true);
  assert.equal(page.destroyed, true);
  assert.equal(failed.windows.length, 2);
  failed.api.cancel();
});

test('预载 loadFile 超时：5000ms 有界回收，下一次 prepare 可重试且迟到 load 不复活', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, deferLoad: true });
  const pending = h.api.prepare();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].isDestroyed(), false, '加载中窗口还在');
  h.fireTimer(5000);
  const result = await pending;
  assert.equal(result.prepared, false);
  assert.equal(h.windows[0].isDestroyed(), true, '超时后销毁预载窗');
  assert.ok(h.nativeStops() >= 1, '暖源也停掉');
  assert.equal(h.windows[0].sent, undefined, '不激活');

  h.resolveLoad(); // 晚到的 load 不得复活暖件
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.windows.length, 1);
  h.setDeferLoad(false);
  const retry = await h.api.prepare();
  assert.equal(retry.prepared, true, '下一次 prepare 能重新建一份');
  assert.equal(h.windows.length, 2);
  h.api.dispose();
});

test('命中预备后 start 复用暖页/延迟源/几何缓存，命中只一次载入并在 fit 后激活', async () => {
  const events = [];
  const h = harness({ platform: 'win32', controlVisible: false, onLifecycle: (event, fields) => events.push({ event, ...fields }) });
  assert.equal((await h.api.prepare()).prepared, true);
  assert.equal(h.monitorQueries.length, 1);
  await h.api.start({ hideControl: false });
  await h.invoke('shot:init'); await h.invoke('shot:ready');
  assert.equal(h.windows.length, 1, '同一个暖窗被消费，不新建');
  assert.equal(h.windows[0].loads.length, 1, '预载页不重复 loadFile');
  const sent = h.windows[0].sent;
  assert.equal(sent.length, 1, '只发一次 activate');
  assert.equal(sent[0].channel, 'shot:activate');
  assert.equal(sent[0].fitCount, 1, 'fit 完成才激活');
  assert.equal(sent[0].loads, 1, '激活时页面已经载过一次');
  assert.equal(h.monitorQueries.length, 1, '几何缓存命中后不再起原生查询');
  assert.equal(h.fitCalls.length, 1);
  assert.equal(h.nativeRegions.length, 1, '只用同一个预备源');
  assert.equal(h.nativeNexts(), 1);
  const timing = events.find(row => row.event === 'capture-timing');
  assert.equal(timing.geometryCached, true);
  assert.equal(timing.preparedSource, true);
  assert.equal(timing.preparedWindow, true);
  assert.equal(timing.preparedPage, true);
  for (const key of ['frameMs', 'fitMs', 'initMs', 'readyMs', 'activateMs', 'initReplyMs', 'viewportMs']) {
    assert.ok(Number.isInteger(timing[key]) && timing[key] >= 0, `${key} 必须是整数毫秒`);
  }
  assert.equal(timing.snapshotAgeMs, timing.shownMs - timing.snapshotMs, '快照龄是上屏减冻结，不是 WGC 帧时刻');
  h.api.cancel();
  assert.equal(h.windows[0].isDestroyed(), true);
  assert.ok(h.nativeStops() >= 1);
});

test('冷启动（单屏/非Windows）也要在 fit/load 后激活一次，且不重复 loadFile', async () => {
  const win = harness({ platform: 'win32', controlVisible: false });
  await win.api.start({ hideControl: false });
  await win.invoke('shot:init'); await win.invoke('shot:ready');
  assert.equal(win.windows[0].loads.length, 1);
  assert.deepEqual(win.windows[0].sent.map(row => row.channel), ['shot:activate']);
  assert.equal(win.windows[0].sent[0].fitCount, 1, 'Windows 冷路径 fit 后才激活');
  win.api.cancel();

  const other = harness({ platform: 'darwin', controlVisible: false });
  await other.api.start({ hideControl: false });
  await other.invoke('shot:init'); await other.invoke('shot:ready');
  assert.equal(other.windows[0].loads.length, 1);
  assert.deepEqual(other.windows[0].sent.map(row => row.channel), ['shot:activate']);
  assert.equal(other.windows[0].sent[0].fitCount, 0, '非 Windows 无物理 fit，载入后激活');
  other.api.cancel();
});

test('fit 失败或等待中取消：不发 activate、不留窗口', async () => {
  const failed = harness({ platform: 'win32', controlVisible: false });
  failed.setFitMode('reject');
  await failed.api.start({ hideControl: false });
  assert.equal(failed.api.isActive(), false);
  assert.equal((failed.windows[0].sent ?? []).length, 0, 'fit 失败不激活');
  assert.equal(failed.windows.every(row => row.isDestroyed()), true);

  const pending = harness({ platform: 'win32', controlVisible: false });
  pending.setFitMode('defer');
  const job = pending.api.start({ hideControl: false });
  await new Promise(resolve => setImmediate(resolve));
  pending.api.cancel();
  pending.resolveFit();
  await job;
  assert.equal((pending.windows[0].sent ?? []).length, 0, '取消后迟到 fit 也不激活');
  assert.equal(pending.windows[0].isDestroyed(), true);
});

test('跨屏冷路径同样在 fit+load 后发一次 activate', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, displays: [
    { id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 800, y: 0, width: 800, height: 600 }, scaleFactor: 1 }] });
  await h.api.start({ hideControl: false });
  assert.equal(h.api.isActive(), true, JSON.stringify(h.statuses));
  await h.invoke('shot:init'); await h.invoke('shot:ready');
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].loads.length, 1);
  assert.deepEqual(h.windows[0].sent.map(row => row.channel), ['shot:activate']);
  assert.equal(h.windows[0].sent[0].fitCount, 1, '跨屏 fit 后激活');
  h.api.cancel();
});

test('暖源首次 next 失败只回退一次普通快照，不吞真正校验错误', async () => {
  const events = [];
  const h = harness({ platform: 'win32', controlVisible: false, warmFails: true, onLifecycle: (event, fields) => events.push({ event, ...fields }) });
  await h.api.prepare();
  await h.api.start({ hideControl: false });
  await h.invoke('shot:init'); await h.invoke('shot:ready');
  assert.equal(h.nativeRegions.length, 2, '暖源 + 一次冷启动');
  assert.equal(h.nativeOptions[0].deferredStart, true);
  assert.notEqual(h.nativeOptions[1].deferredStart, true);
  assert.equal(h.windows.length, 1, '暖窗仍可用');
  const timing = events.find(row => row.event === 'capture-timing');
  assert.notEqual(timing.preparedSource, true, '冷回退后不记预备源命中');
  assert.equal(timing.preparedWindow, true);
  h.api.cancel();
});

test('旧 exe/已退出暖源不会被当命中：prepare 作废，start 走冷路径', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, deferredDies: true });
  assert.equal((await h.api.prepare()).prepared, false);
  assert.equal(h.windows.length, 0, '死源不建暖窗');
  await h.api.start({ hideControl: false });
  await h.invoke('shot:init'); await h.invoke('shot:ready');
  assert.equal(h.api.isActive(), true);
  assert.equal(h.nativeRegions.length, 2, '死暖源 + 冷启动');
  assert.equal(h.windows.length, 1);
  h.api.cancel();
});

test('暖源帧尺寸/新鲜度不过关照原样失败，不再偷偷冷启动', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, badNativeFrame: true });
  await h.api.prepare();
  await h.api.start({ hideControl: false });
  assert.equal(h.api.isActive(), false);
  assert.equal(h.nativeRegions.length, 1, '暖源帧已返回，不再重试冷启动');
  assert.equal(h.windows.every(win => win.isDestroyed()), true);
  assert.match(h.statuses.at(-1).message, /快照/);
});

test('取消清理：已消费的暖源/暖窗在 end 时都停掉并销毁', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, deferSnapshot: true });
  await h.api.prepare();
  const job = h.api.start({ hideControl: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.windows.length, 1);
  h.api.cancel();
  await job;
  assert.equal(h.windows[0].isDestroyed(), true);
  assert.ok(h.nativeStops() >= 1, '待采源码也停掉');
  assert.equal(h.api.isActive(), false);
});

test('迟到的 prepare：已有会话/已 dispose 都不建窗建源', async () => {
  const busy = harness({ platform: 'win32', controlVisible: false, deferSnapshot: true });
  const job = busy.api.start({ hideControl: false });
  await new Promise(resolve => setImmediate(resolve));
  const windowsBefore = busy.windows.length, regionsBefore = busy.nativeRegions.length;
  assert.equal((await busy.api.prepare()).prepared, false);
  assert.equal(busy.windows.length, windowsBefore);
  assert.equal(busy.nativeRegions.length, regionsBefore);
  busy.resolveSnapshot(); await job; busy.api.cancel();

  const late = harness({ platform: 'win32', controlVisible: false });
  late.setMonitorQuery('defer');
  const pending = late.api.prepare();
  await new Promise(resolve => setImmediate(resolve));
  late.api.dispose();
  late.resolveMonitor();
  assert.equal((await pending).prepared, false, 'dispose 后迟到结果作废');
  assert.equal(late.windows.length, 0);
  assert.equal(late.nativeRegions.length, 0);
});

test('非 Windows / 多屏 / 预备失败都直接回冷路径，不建任何暖窗', async () => {
  for (const options of [{ platform: 'darwin' }, { platform: 'win32', displays: [
    { id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 800, y: 0, width: 800, height: 600 }, scaleFactor: 1 }] }]) {
    const h = harness({ controlVisible: false, ...options });
    assert.equal((await h.api.prepare()).prepared, false);
    assert.equal(h.windows.length, 0);
    assert.equal(h.nativeRegions.length, 0);
  }
  const failed = harness({ platform: 'win32', controlVisible: false });
  failed.setMonitorQuery('reject');
  assert.equal((await failed.api.prepare()).prepared, false);
  assert.equal(failed.windows.length, 0);
  assert.equal(failed.nativeRegions.length, 0);
  failed.setMonitorQuery('ok');
  await failed.api.start({ hideControl: false });
  assert.equal(failed.api.isActive(), true, '预备失败不影响正式 start');
  failed.api.cancel();
});

test('身份变化/重复 prepare：旧暖窗在替换时销毁，dispose 全部回收', async () => {
  const h = harness({ platform: 'win32', controlVisible: false });
  assert.equal((await h.api.prepare()).prepared, true);
  const first = h.windows[0];
  assert.equal((await h.api.prepare()).reused, true, '身份未变时复用同一份');
  assert.equal(h.windows.length, 1);
  h.patchDisplay(7, { scaleFactor: 1.5 });
  assert.equal((await h.api.prepare()).prepared, true, '身份变了就重建一份');
  assert.equal(first.destroyed, true, '旧暖窗在替换时销毁');
  assert.equal(h.windows.length, 2);
  const second = h.windows[1];
  h.api.dispose();
  assert.equal(second.destroyed, true);
  assert.ok(h.nativeStops() >= 1);
});

test('屏数掉到 0：再次 prepare 先回收旧暖窗/暖源，不因 unsupported 早退而泄漏', async () => {
  const h = harness({ platform: 'win32', controlVisible: false });
  assert.equal((await h.api.prepare()).prepared, true);
  const warm = h.windows[0];
  assert.equal(warm.destroyed, false);
  h.dropDisplay(7);
  const result = await h.api.prepare();
  assert.equal(result.prepared, false);
  assert.equal(result.reason, 'unsupported');
  assert.equal(warm.destroyed, true, 'unsupported 早退前必须销毁旧暖窗');
  assert.ok(h.nativeStops() >= 1, '旧暖源也要停掉');
  assert.equal(h.windows.length, 1, '不新建窗口');
  assert.equal(h.nativeRegions.length, 1, '不新建采集进程');
  h.api.dispose();
});

test('prepare 单飞：并发调用只建一份暖窗/暖源', async () => {
  const h = harness({ platform: 'win32', controlVisible: false });
  h.setMonitorQuery('defer');
  const first = h.api.prepare(), second = h.api.prepare();
  h.resolveMonitor();
  const results = await Promise.all([first, second]);
  assert.equal(results.every(row => row.prepared === true), true);
  assert.equal(h.windows.length, 1);
  assert.equal(h.nativeRegions.length, 1);
  h.api.dispose();
});

test('预备件只能被消费一次；下一轮 start 回到冷路径', async () => {
  const h = harness({ platform: 'win32', controlVisible: false });
  await h.api.prepare();
  await h.api.start({ hideControl: false });
  await h.invoke('shot:init'); await h.invoke('shot:ready');
  h.api.cancel();
  assert.equal(h.windows[0].isDestroyed(), true);
  // 结束时会异步补一份；先不执行该定时器，第二轮应走冷路径。
  const invokeLast = name => h.handlers.get(name)({ sender: h.windows.at(-1).webContents, senderFrame: h.windows.at(-1).webContents.mainFrame });
  await h.api.start({ hideControl: false });
  await invokeLast('shot:init'); await invokeLast('shot:ready');
  assert.equal(h.windows.length, 2, '没有可用预备件就新建窗口');
  assert.equal(h.nativeRegions.length, 2);
  assert.notEqual(h.nativeOptions[1].deferredStart, true);
  h.api.cancel();
});

test('预备后现场 hint/身份变化：take 时丢弃暖件，start 仍按冷路径成功', async () => {
  const h = harness({ platform: 'win32', controlVisible: false });
  assert.equal((await h.api.prepare()).prepared, true);
  const warm = h.windows[0];
  h.patchDisplay(7, { scaleFactor: 1.5 });
  const invokeLast = name => h.handlers.get(name)({ sender: h.windows.at(-1).webContents, senderFrame: h.windows.at(-1).webContents.mainFrame });
  await h.api.start({ hideControl: false });
  await invokeLast('shot:init'); await invokeLast('shot:ready');
  assert.equal(h.api.isActive(), true, '身份变了也不阻塞正式截图');
  assert.equal(warm.destroyed, true, '旧暖窗被丢弃并销毁');
  assert.equal(h.windows.length, 2);
  assert.equal(h.nativeRegions.length, 2);
  assert.notEqual(h.nativeOptions[1].deferredStart, true);
  h.api.cancel();
});

test('Windows 原生底图等待时取消会停止采集且不留下窗口', async () => {
  const h=harness({platform:'win32',controlVisible:false,deferSnapshot:true});const job=h.api.start();
  // 监视器矩形查询是异步的：等它完成后原生源才建立，再取消。
  await new Promise(resolve=>setImmediate(resolve));assert.equal(h.nativeRegions.length,1);
  h.api.cancel();await job;
  assert.equal(h.nativeStops(),1);assert.equal(h.windows.every(w=>w.isDestroyed()),true,'取消后不留已建好的窗口');assert.equal(h.api.isActive(),false);
});
test('Windows 原生底图准备超时停止待收源，不留下过期窗口', async () => {
  const h=harness({platform:'win32',controlVisible:false,deferSnapshot:true});const job=h.api.start();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(h.nativeRegions.length,1);
  h.timers.find(t=>t.ms===15000).fn();await job;
  assert.equal(h.nativeStops(),1);assert.equal(h.windows.every(w=>w.isDestroyed()),true);assert.equal(h.api.isActive(),false);assert.match(h.statuses.at(-1).message,/超时/);
});
test('Windows 原生首帧不新鲜则明确失败，不接受陈旧底图', async () => {
  const h=harness({platform:'win32',controlVisible:false,nativeFresh:false});await h.api.start();
  assert.equal(h.nativeStops(),1);assert.equal(h.windows.every(w=>w.isDestroyed()),true);assert.equal(h.api.isActive(),false);
});
test('Windows 原生底图像素不完整明确失败，不静默回退偏色缩略图', async () => {
  const h=harness({platform:'win32',controlVisible:false,badNativeFrame:true});await h.api.start();
  assert.equal(h.nativeStops(),1);assert.equal(h.windows.every(w=>w.isDestroyed()),true);assert.equal(h.sourceOptions(),undefined);assert.equal(h.api.isActive(),false);
  assert.match(h.statuses.at(-1).message,/像素不完整/);
});
test('F1：仅可见控制页隐藏后保留退场等待；非Windows仍规范化', async () => {
  const h = harness({ scaleFactors: [2] }); await h.api.start();
  assert.equal(h.timers.filter(t => t.ms === 220).length, 1);
  assert.equal(h.control.visible, false); assert.equal(h.normalizationDecodes(), 1);
  await h.invoke('shot:ready'); h.api.cancel(); assert.equal(h.control.visible, true);
});

for (const diagnosticStarted of [true, false]) test(`选区窗口关闭后最终状态刷新，诊断入口不残留灰态（recording=${diagnosticStarted}）`, async () => {
  let recording = diagnosticStarted, menuEnabled = false, h;
  const refresh = () => { menuEnabled = !h.api.isActive() && !recording; };
  const diagnostics = { record() {}, end() { if (!recording) return; recording = false; refresh(); } };
  h = harness({ diagnostics, onCaptureEnd: refresh }); await h.api.start(); await h.invoke('shot:ready');
  refresh(); assert.equal(menuEnabled, false);
  h.windows[0].destroy();
  assert.equal(h.api.isActive(), false); assert.equal(recording, false); assert.equal(menuEnabled, true);
});
test('预览基线：同一次Esc的自动重复不能关掉刚返回的长图', async () => {
  const h = harness(); await h.api.start(); await h.invoke('shot:ready'); h.setLongOutput();
  h.windows[0].webContents.emit('before-input-event', { preventDefault() {} }, { key: 'Escape', type: 'keyDown', isAutoRepeat: true });
  assert.equal(h.api.isActive(), true); assert.equal(h.windows[0].isDestroyed(), false);
  h.windows[0].webContents.emit('before-input-event', { preventDefault() {} }, { key: 'Escape', type: 'keyDown', isAutoRepeat: false });
  assert.equal(h.api.isActive(), true, '完整长图的Esc先交给页面关闭放大预览');
  h.invoke('shot:cancel'); assert.equal(h.api.isActive(), false);
});
test('预览基线：合成过程中Esc不把完成请求改为取消', async () => {
  const h = harness(); await h.api.start(); await h.invoke('shot:ready'); h.setPhase('scroll-finishing');
  h.windows[0].webContents.emit('before-input-event', { preventDefault() {} }, { key: 'Escape', type: 'keyDown', isAutoRepeat: false });
  assert.equal(h.api.isActive(), true); h.api.cancel();
});

test('原图预览仅当前窗口及有效token可读，不写文件或剪贴板', async () => {
  const h = harness(); await h.api.start(); await h.invoke('shot:ready');
  assert.throws(() => h.invoke('shot:preview-image', 'long-token'), /失效/);
  h.setLongOutput(true); assert.throws(() => h.invoke('shot:preview-image', 'long-token'), /失效/);
  h.invoke('shot:preview-ready', 'long-token');
  assert.throws(() => h.invoke('shot:preview-image', 'stale'), /失效/);
  assert.throws(() => h.handlers.get('shot:preview-image')({ sender: {}, senderFrame: {} }, 'long-token'), /失效/);
  const image = h.invoke('shot:preview-image', 'long-token'); assert.equal(image.width, 20); assert.equal(image.height, 500);
  assert.equal(image.dataUrl, 'data:image/png;base64,full-size'); assert.equal(h.copied.length, 0);
  h.setPhase('saving'); assert.throws(() => h.invoke('shot:preview-image', 'long-token'), /失效/);
  h.api.cancel();
});
test('预览确认必须由当前窗口和token提交，就绪前不能写出长图', async () => {
  const traces = [], h = harness({ diagnostics: { record: (event, fields) => traces.push({ event, fields }), end() {} } });
  await h.api.start(); await h.invoke('shot:ready'); h.setLongOutput(true);
  assert.equal(h.invoke('shot:preview-ready', 'stale'), false);
  assert.equal(h.handlers.get('shot:preview-ready')({ sender: {}, senderFrame: {} }, 'long-token'), false);
  await assert.rejects(h.invoke('shot:commit', { x: 1, y: 1, width: 20, height: 20 }, 'copy', 'long-token'), /预览尚未就绪/);
  assert.equal(h.copied.length, 0);
  assert.equal(h.invoke('shot:preview-ready', 'long-token'), true);
  assert.equal(h.invoke('shot:preview-ready', 'long-token'), false);
  assert.equal(traces.filter(row => row.event === 'preview-dom-ready').length, 1);
  assert.equal(traces.at(-1).fields.remoteVisibility, 'unobserved');
  await h.invoke('shot:commit', { x: 1, y: 1, width: 20, height: 20 }, 'copy', 'long-token');
  assert.equal(h.copied.length, 1);
});

test('采集失败收回使用真实失败原因，不误报取消且释放全屏窗口', async () => {
  const ends = [], h = harness({ diagnostics: { record() {}, end: reason => ends.push(reason) } });
  await h.api.start(); await h.invoke('shot:ready'); h.cancelScroll('sample-error');
  assert.equal(h.api.isActive(), false); assert.equal(h.windows[0].isDestroyed(), true);
  assert.deepEqual(ends, ['sample-error']); assert.equal(h.control.visible, true);
  assert.equal(h.writes.length, 0); assert.equal(h.copied.length, 0);
});

test('诊断从快照前覆盖到取消，只接受当前选区主框架的已知事件', async () => {
  const traces = [], ends = [];
  const diagnostics = { state: () => ({ recording: true }), record: (event, fields) => { traces.push({ event, fields }); return true; }, end: reason => ends.push(reason) };
  const h = harness({ diagnostics }); await h.api.start();
  assert.equal((await h.invoke('shot:init')).diagnosticEnabled, true); await h.invoke('shot:ready');
  assert.equal(h.handlers.get('shot:diagnostic')({ sender: {}, senderFrame: {} }, 'sample', { height: 1 }), false);
  assert.equal(h.invoke('shot:diagnostic', 'unknown-event', {}), false);
  assert.equal(h.invoke('shot:diagnostic', 'wheel', { accepted: false }), true);
  h.api.cancel();
  assert.deepEqual(traces.map(row => row.event).filter(event => !['window-created', 'window-loaded', 'window-fitted'].includes(event)),
    ['capture-start', 'snapshot-ready', 'selection-init', 'selection-ready', 'wheel', 'capture-end']);
  assert.ok(traces.some(row => row.event === 'window-created'), '开窗与取帧并行，阶段要留痕');
  assert.deepEqual(ends, ['cancelled']); assert.doesNotMatch(JSON.stringify(traces), /data:image|base64/);
});

test('选区崩溃有明确错误代码，初始化失败取消不会伪装成用户取消', async () => {
  for (const crashed of [true, false]) {
    const traces = [], ends = [];
    const h = harness({ diagnostics: { state: () => ({ recording: true }), record: (event, fields) => traces.push({ event, fields }), end: reason => ends.push(reason) } });
    await h.api.start();
    if (crashed) h.windows[0].webContents.emit('render-process-gone');
    else h.invoke('shot:cancel', 'failed');
    assert.deepEqual(ends, ['failed']);
    if (crashed) assert.equal(traces.find(row => row.event === 'renderer-error').fields.errorCode, 'selection-renderer-gone');
    assert.equal(h.api.isActive(), false);
  }
});

test('选区页不启用捕获保护，避免屏蔽远程软件的框选画面', async () => {
  const h = harness();
  await h.api.start();
  assert.notEqual(h.windows[0].contentProtected, true);
  assert.equal(h.windows[0].options.transparent, true, '透明底才不会在上屏第一帧闪一块纯色');
  assert.match((await h.invoke('shot:init')).dataUrl, /^data:image/);
  h.api.dispose();
});
test('复制只写剪贴板，不创建文件：负坐标 200% 屏裁切', async () => {
  const h = harness();
  await h.api.start();
  assert.equal(h.api.isActive(), true);
  assert.equal(h.sourceOptions().thumbnailSize.width, 3840);
  await assert.rejects(() => h.handlers.get('shot:init')({ sender: {}, senderFrame: {} }), /无效/);
  assert.match((await h.invoke('shot:init')).dataUrl, /^data:image/);
  await h.invoke('shot:ready');
  const result = await h.invoke('shot:commit', { x: 100, y: 50, width: 200, height: 100 }, 'copy');
  assert.equal(result.copied, true);
  assert.equal(h.writes.length, 0);
  assert.equal(h.dialogs.length, 0);
  assert.equal(result.file, undefined);
  assert.deepEqual(h.crops[0], { x: 200, y: 100, width: 400, height: 200 });
  assert.equal(h.copied[0].length, 1);
  const payload = h.copied[0][0].items['image/png'];
  assert.equal(payload.type, 'image/png');
  assert.equal(Buffer.from(await payload.arrayBuffer()).toString(), 'png');
  assert.equal(h.api.isActive(), false);
  assert.equal(h.windows[0].destroyed, true);
  assert.equal(h.statuses.at(-1).error, false);
});
test('长图输出使用明确 token 和完整长图，不退回原始小选区', async () => {
  const h = harness();
  await h.api.start(); await h.invoke('shot:ready'); h.setLongOutput();
  await assert.rejects(h.invoke('shot:commit', { x: 0, y: 0, width: 10, height: 10 }, 'copy', 'old-token'), /失效/);
  const result = await h.invoke('shot:commit', { x: 0, y: 0, width: 10, height: 10 }, 'copy', 'long-token');
  assert.equal(result.ok, true);
  assert.equal(Buffer.from(await h.copied[0][0].items['image/png'].arrayBuffer()).toString(), 'long-png');
  assert.equal(h.statuses.at(-1).dimensions.height, 500);
});
test('保存先弹另存为，只写选择路径，不碰剪贴板', async () => {
  const h = harness();
  await h.api.start(); await h.invoke('shot:ready');
  const result = await h.invoke('shot:commit', { x: 0, y: 0, width: 10, height: 10 }, 'save');
  assert.equal(result.ok, true);
  assert.equal(result.copied, false);
  assert.equal(h.copied.length, 0);
  assert.equal(h.writes.length, 1);
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.dialogs[0].owner, h.windows[0]);
  assert.equal(h.dialogs[0].options.filters[0].extensions[0], 'png');
  assert.equal(h.writes[0].file, h.chosenPath);
  assert.equal(h.api.getLastFile(), result.file);
});
test('取消另存为保留选框，不写文件和剪贴板，还能选择复制', async () => {
  const h = harness({ cancelSave: true });
  await h.api.start(); await h.invoke('shot:ready');
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  const result = await h.invoke('shot:commit', rect, 'save');
  assert.equal(result.canceled, true);
  assert.equal(h.writes.length, 0);
  assert.equal(h.copied.length, 0);
  assert.equal(h.api.isActive(), true);
  assert.equal(h.windows[0].visible, true);
  assert.equal(h.api.getLastFile(), undefined);
  assert.equal((await h.invoke('shot:commit', rect, 'copy')).ok, true);
});
test('另存为窗口失败同样保留选框供重试', async () => {
  const h = harness({ dialogFails: true });
  await h.api.start(); await h.invoke('shot:ready');
  const result = await h.invoke('shot:commit', { x: 0, y: 0, width: 10, height: 10 }, 'save');
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /dialog unavailable/);
  assert.equal(h.api.isActive(), true);
  assert.equal(h.writes.length, 0);
  assert.equal(h.copied.length, 0);
  h.api.cancel();
});
test('遗漏或未知动作拒绝执行，不能默认捆绑', async () => {
  const h = harness();
  await h.api.start(); await h.invoke('shot:ready');
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  await assert.rejects(h.invoke('shot:commit', rect), /请选择/);
  await assert.rejects(h.invoke('shot:commit', rect, 'both'), /请选择/);
  assert.equal(h.copied.length, 0);
  assert.equal(h.writes.length, 0);
  h.api.cancel();
});
test('快照分辨率不完整则明确失败，不输出低清截图', async () => {
  const h = harness({ mismatch: true });
  await h.api.start();
  assert.equal(h.api.isActive(), false);
  assert.equal(h.control.visible, true);
  assert.match(h.statuses.at(-1).message, /尺寸不完整/);
  assert.equal(h.writes.length, 0);
});
test('验证进行时不启动截图', async () => {
  const h = harness({ probeBusy: true });
  await h.api.start();
  assert.equal(h.windows.length, 0);
  assert.equal(h.control.visible, true);
});
test('选区就绪后清除准备看门狗，不再限时自动清框', async () => {
  const h = harness();
  await h.api.start();
  const timer = h.timers.find(item => item.ms === 15000);
  assert.equal(timer.cleared, false);
  await h.invoke('shot:ready');
  assert.equal(timer.cleared, true);
  h.api.cancel();
});
test('取消截图不写盘也不碰剪贴板', async () => {
  const h = harness();
  await h.api.start();
  await h.invoke('shot:ready');
  h.invoke('shot:cancel');
  assert.equal(h.api.isActive(), false);
  assert.equal(h.control.visible, true);
  assert.equal(h.writes.length, 0);
  assert.equal(h.copied.length, 0);
});
test('越界、过小或重复提交均拒绝', async () => {
  const h = harness();
  await h.api.start(); await h.invoke('shot:ready');
  await assert.rejects(h.invoke('shot:commit', { x: 0, y: 0, width: 1, height: 10 }, 'save'), /太小/);
  await assert.rejects(h.invoke('shot:commit', { x: -1, y: 0, width: 50, height: 50 }, 'save'), /超出/);
  await h.invoke('shot:commit', { x: 0, y: 0, width: 10, height: 10 }, 'save');
  await assert.rejects(h.invoke('shot:commit', { x: 0, y: 0, width: 10, height: 10 }, 'save'), /无效/);
  assert.equal(h.writes.length, 1);
});
test('保存失败不擅自复制，保留选框供重试或改选复制', async () => {
  const h = harness({ saveFails: true });
  await h.api.start(); await h.invoke('shot:ready');
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  const result = await h.invoke('shot:commit', rect, 'save');
  assert.equal(result.ok, false);
  assert.equal(result.copied, false);
  assert.equal(h.copied.length, 0);
  assert.equal(h.api.isActive(), true);
  assert.equal(h.windows[0].visible, true);
  assert.match(h.statuses.at(-1).message, /保存失败/);
  const copied = await h.invoke('shot:commit', rect, 'copy');
  assert.equal(copied.ok, true);
});
for(const source of ['escape-key','context-menu'])test(`预览取消保留明确来源而非误记复制：${source}`,async t=>{
 const {r,rows}=recordingFixture(t),h=harness({diagnostics:r});await h.api.start();await h.invoke('shot:ready');r.startAutomatic();h.setLongOutput();
 h.invoke('shot:cancel',source);await r.flush();const end=rows().find(x=>x.event==='capture-end');
 assert.equal(end.reason,'cancelled');assert.equal(end.dismissSource,source);assert.equal(rows().some(x=>x.event==='commit-start'),false);
});
for (const [phase, reason] of [['selecting', 'cancelled'], ['saving', 'window-closed']]) {
  test(`后台记录明确关窗原因，保存中关窗不猜复制结果：${phase}`, async t => {
    const { r, rows } = recordingFixture(t), h = harness({ diagnostics: r });
    await h.api.start(); await h.invoke('shot:ready'); r.startAutomatic(); h.setPhase(phase);
    h.windows[0].destroy(); await r.flush();
    assert.equal(rows().at(-2).reason, reason); assert.equal(rows().at(-1).reason, reason);
    assert.equal(rows().at(-2).ok, undefined);assert.equal(rows().at(-2).dismissSource,'window-close');
  });
}
test('真实异步复制未返回就关窗：报告只保留动作，绝不猜结果', async t => {
  const { r, rows } = recordingFixture(t), h = harness({ diagnostics: r, deferCopy: true });
  await h.api.start(); await h.invoke('shot:ready'); r.startAutomatic(); h.setLongOutput();
  const pending = h.invoke('shot:commit', { x: 0, y: 0, width: 10, height: 10 }, 'copy', 'long-token');
  await r.flush(); assert.equal(rows().at(-1).event, 'commit-start');
  h.windows[0].destroy(); await r.flush();
  const final = rows().find(row => row.event === 'capture-end');
  assert.equal(final.action, 'copy'); assert.equal(final.phase, 'saving'); assert.equal(final.reason, 'window-closed');
  assert.equal(Object.hasOwn(final, 'ok'), false); assert.equal(Object.hasOwn(final, 'canceled'), false);
  assert.equal(rows().some(row => row.event === 'commit-end'), false);
  h.releaseCopy(); assert.equal((await pending).copied, true); await r.flush();
  assert.equal(rows().at(-1).reason, 'window-closed'); // 封口时确实未知，迟到结果不串入别轮。
});

test('后台结束摘要始终保留最终提交结果，不被此前大量重试挤掉', async t => {
  const { r, rows } = recordingFixture(t), h = harness({ diagnostics: r });
  await h.api.start(); await h.invoke('shot:ready'); r.startAutomatic(); h.setLongOutput();
  // 穷尽普通事件和附加结束事件额度，模拟极多重试后的最终成功。
  for (let i = 0; i < 2100; i++) r.record('sample', {});
  for (let i = 0; i < 40; i++) r.record('commit-end', { action: 'save', ok: false });
  assert.equal((await h.invoke('shot:commit', { x: 0, y: 0, width: 10, height: 10 }, 'copy', 'long-token')).ok, true);
  await r.flush(); const final = rows().find(row => row.event === 'capture-end');
  assert.equal(final.action, 'copy'); assert.equal(final.ok, true); assert.equal(final.canceled, false);
});

for (const action of ['save', 'copy']) test(`自动报告与真实提交对应：${action}完成才写成功和封口`, async t => {
  const { r, directory, rows } = recordingFixture(t);
  const h = harness({ diagnostics: r, deferCopy: action === 'copy' });
  await h.api.start(); await h.invoke('shot:ready');
  assert.equal(fs.readdirSync(directory).length, 0); // 普通单张阶段不生成报告。
  r.startAutomatic(); h.setLongOutput();
  const pending = h.invoke('shot:commit', { x: 0, y: 0, width: 10, height: 10 }, action, 'long-token');
  if (action === 'copy') {
    await r.flush(); assert.equal(r.state().recording, true);
    assert.equal(rows().at(-1).event, 'commit-start');
    assert.equal(rows().some(row => row.event === 'commit-end'), false); h.releaseCopy();
  }
  assert.equal((await pending).ok, true); await r.flush();
  const output = rows();
  assert.equal(output.find(row => row.event === 'commit-start').hasLongImage, true);
  assert.equal(output.find(row => row.event === 'commit-end').action, action);
  assert.equal(output.find(row => row.event === 'commit-end').ok, true);
  assert.equal(output.at(-2).event, 'capture-end'); assert.equal(output.at(-1).reason, 'completed');
  assert.doesNotMatch(JSON.stringify(output), /chosen-folder|chosen-image|long-png|filePath/);
});
for (const [option, action] of [['cancelSave', 'save'], ['saveFails', 'save'], ['copyFails', 'copy'], ['dialogFails', 'save']]) {
  test(`自动报告保留取消或失败，允许重试而不提前封口：${option}`, async t => {
    const { r, rows } = recordingFixture(t), h = harness({ diagnostics: r, [option]: true });
    await h.api.start(); await h.invoke('shot:ready'); r.startAutomatic(); h.setLongOutput();
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    const first = await h.invoke('shot:commit', rect, action, 'long-token'); await r.flush();
    assert.equal(first.ok, false); assert.equal(r.state().recording, true);
    assert.equal(rows().at(-1).event, 'commit-end'); assert.equal(rows().at(-1).ok, false);
    assert.equal(rows().at(-1).canceled, option === 'cancelSave');
    assert.equal(rows().some(row => row.event === 'diagnostic-end'), false);
    const second = await h.invoke('shot:commit', rect, action === 'copy' ? 'save' : 'copy', 'long-token');
    assert.equal(second.ok, true); await r.flush();
    assert.equal(rows().filter(row => row.event === 'commit-end').length, 2);
    assert.equal(rows().at(-1).reason, 'completed');
    assert.doesNotMatch(JSON.stringify(rows()), /disk unavailable|clipboard busy|dialog unavailable|chosen-folder/);
  });
}

test('必须等剪贴板异步写入完成才报告已复制', async () => {
  const h = harness({ deferCopy: true });
  await h.api.start(); await h.invoke('shot:ready');
  const pending = h.invoke('shot:commit', { x: 0, y: 0, width: 10, height: 10 }, 'copy');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.copied.length, 1);
  assert.equal(h.windows[0].visible, true, '写入还没完成，选择窗口不得提前隐藏');
  assert.equal(h.windows[0].destroyed, false, '写入还没完成，窗口不得提前销毁');
  assert.equal(h.api.isActive(), true);
  assert.equal(h.api.cancel(), false);
  assert.doesNotMatch(h.statuses.at(-1).message, /已复制/);
  h.releaseCopy();
  const result = await pending;
  assert.equal(result.copied, true);
  assert.equal(h.api.isActive(), false);
});
test('复制期间选择窗口保持可见，await 写入成功后才收尾关闭', async () => {
  const h = harness({ deferCopy: true });
  await h.api.start(); await h.invoke('shot:ready');
  const win = h.windows[0];
  assert.equal(win.visible, true, '就绪后选择窗口本来就是可见的');
  const pending = h.invoke('shot:commit', { x: 0, y: 0, width: 10, height: 10 }, 'copy');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.copied.length, 1, '写入已经交给系统剪贴板，但还没返回');
  assert.equal(win.visible, true, '复制期间的窗口必须留着，不能先藏再写');
  assert.equal(win.destroyed, false);
  assert.equal(h.api.isActive(), true);
  h.releaseCopy();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.copied, true);
  assert.equal(win.destroyed, true, '写入成功后仍由原有 end() 关闭窗口');
  assert.equal(h.api.isActive(), false);
});
test('复制异步失败不擅自存盘，保留选框供重试或改选保存', async () => {
  const h = harness({ copyFails: true });
  await h.api.start(); await h.invoke('shot:ready');
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  const result = await h.invoke('shot:commit', rect, 'copy');
  assert.equal(result.ok, false);
  assert.equal(result.copied, false);
  assert.equal(h.writes.length, 0);
  assert.equal(h.api.isActive(), true);
  assert.equal(h.windows[0].visible, true);
  assert.equal(h.windows[0].destroyed, false, '失败后窗口保留，可重试或改选保存');
  assert.match(h.statuses.at(-1).message, /复制失败：clipboard busy/);
  const saved = await h.invoke('shot:commit', rect, 'save');
  assert.equal(saved.ok, true);
  assert.equal(h.writes.length, 1);
});
function editedHeader(width, height) {
  const bytes = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  bytes.writeUInt32BE(13,8); bytes.write('IHDR',12); bytes.writeUInt32BE(width,16); bytes.writeUInt32BE(height,20); return bytes;
}
for (const kind of ['long', 'edit', 'long-edit']) test(`显示器移除后仍能复制内存中已确认的成图（${kind}）`, async () => {
  const h = harness(); await h.api.start(); await h.invoke('shot:ready');
  const rect = { x: 10, y: 20, width: 100, height: 100 };
  const token = kind === 'edit' ? undefined : 'long-token';
  if (token) h.setLongOutput();
  let doc;
  // edit-source 现在可能是异步的（跨屏 raw 选择会重读页面视口）：单屏路径内部不 await，但返回值统一按 Promise 用。
  if (kind === 'edit') doc = await h.invoke('shot:edit-source', rect);
  h.dropDisplay(h.getCurrent().display.id);
  if (kind === 'long-edit') doc = await h.invoke('shot:edit-source', rect, token);
  if (doc) assert.equal((await h.invoke('shot:edit-source', rect, token)).token, doc.token);
  const before = h.crops.length;
  const edited = doc ? { token: doc.token, png: editedHeader(doc.width, doc.height) } : undefined;
  const result = await h.invoke('shot:commit', rect, 'copy', token, edited);
  assert.equal(result.ok, true); assert.equal(h.copied.length, 1);
  assert.equal(h.crops.length, before, '已成图不重新裁切冻结底图');
});
for (const long of [false, true]) test(`编辑来源与原尺寸合成输出绑定（long=${long}）`, async () => {
  const h=harness(); await h.api.start(); await h.invoke('shot:ready'); if(long)h.setLongOutput();
  const rect={x:10,y:20,width:100,height:200}, token=long?'long-token':undefined;
  const source=await h.invoke('shot:edit-source',rect,token);
  assert.equal(source.width,long?20:200); assert.equal(source.height,long?500:400);
  // 原图不再回给选区页：它只存在主进程与独立编辑窗之间。
  assert.equal('dataUrl' in source,false,'选区页只拿元数据');
  const opened=h.windows.at(-1).sent.filter(item=>item.channel==='shot:editor-open').at(-1).args[0];
  assert.equal(opened.token,source.token); assert.equal(opened.width,source.width); assert.equal(opened.height,source.height);
  assert.match(opened.dataUrl,/full-size|crop-200x400/,'完整原图直接交给编辑窗');
  assert.deepEqual(opened.rect,{x:10,y:20,width:100,height:200},'原 rect 也交给编辑窗');
  assert.equal((await h.invoke('shot:edit-source',rect,token)).token,source.token,'同一成图使用同一文档');
  await assert.rejects(h.invoke('shot:commit',rect,'copy',token),/请先返回预览/,'编辑中不能从已收起的原页直接提交');
  await assert.rejects(h.invoke('shot:commit',rect,'copy',token,{token:'foreign',png:editedHeader(source.width,source.height)}),/未输出原图/);
  assert.equal(h.copied.length,0); assert.equal(h.writes.length,0); assert.equal(h.api.isActive(),true);
  await h.invoke('shot:edit-state',source.token,'close');
  const result=await h.invoke('shot:commit',rect,'copy',token,{token:source.token,png:editedHeader(source.width,source.height)});
  assert.equal(result.ok,true); assert.equal(h.copied.length,1);
  assert.equal(await h.copied[0][0].items['image/png'].text(),'edited-png');
});
test('编辑尺寸、选区、阶段和主框架校验失败不写剪贴板或文件', async()=>{
  const h=harness();await h.api.start();await h.invoke('shot:ready');const rect={x:0,y:0,width:100,height:100};
  const doc=await h.invoke('shot:edit-source',rect);
  for(const png of [new Uint8Array(4),editedHeader(1,1),new Uint16Array(32),{length:999999999}])await assert.rejects(h.invoke('shot:commit',rect,'copy',undefined,{token:doc.token,png}),/未输出原图/);
  await assert.rejects(h.invoke('shot:commit',{...rect,x:1},'save',undefined,{token:doc.token,png:editedHeader(200,200)}),/未输出原图/);
  await assert.rejects(h.invoke('shot:edit-source',{...rect,x:1}),/重新框选/);
  await assert.rejects(Promise.resolve(h.handlers.get('shot:edit-source')({sender:{},senderFrame:{}},rect)),/失效/);
  h.setPhase('scrolling');await assert.rejects(h.invoke('shot:edit-source',rect),/失效/);h.setPhase('selecting');
  assert.equal(h.copied.length,0);assert.equal(h.writes.length,0);h.api.cancel();
});
test('编辑裁切协议：保存带 crop 仍按裁后尺寸输出，文件名用输出尺寸', async () => {
  const h=harness();await h.api.start();await h.invoke('shot:ready');
  const rect={x:10,y:20,width:100,height:100};
  const doc=await h.invoke('shot:edit-source',rect);
  assert.deepEqual({width:doc.width,height:doc.height},{width:200,height:200});
  const result=await h.invoke('shot:commit',rect,'save',undefined,
    {token:doc.token,png:editedHeader(100,80),crop:{x:10,y:20,width:100,height:80}});
  assert.equal(result.ok,true);
  assert.equal(h.writes.length,1);
  assert.match(h.dialogs[0].options.defaultPath,/100x80/,'对话框默认文件名按裁后尺寸');
  assert.equal(await h.writes[0].bytes.text?.() ?? 'edited-png','edited-png');
});
test('编辑裁切协议：复制带 crop 与说明尺寸时按裁后宽高重算，PNG 必须一致', async () => {
  const h=harness();await h.api.start();await h.invoke('shot:ready');
  const rect={x:10,y:20,width:100,height:100};
  const doc=await h.invoke('shot:edit-source',rect);
  const result=await h.invoke('shot:commit',rect,'copy',undefined,
    {token:doc.token,png:editedHeader(720,300),crop:{x:10,y:20,width:100,height:80},clipboardSize:{width:720,height:300}});
  assert.equal(result.ok,true);
  assert.equal(result.copied,true);
  assert.equal(h.copied.length,1);
  assert.equal(await h.copied[0][0].items['image/png'].text(),'edited-png');
  assert.match(h.statuses.at(-1).message,/720 × 300/, '状态栏报实际交付尺寸（含说明区）');
});
test('编辑复制：带局部放大时按 insetWidth 扩宽，伪造宽度/倍率/尺寸全拒绝', async () => {
  const h=harness();await h.api.start();await h.invoke('shot:ready');
  const rect={x:10,y:20,width:500,height:500};
  const doc=await h.invoke('shot:edit-source',rect);
  assert.deepEqual({width:doc.width,height:doc.height},{width:1000,height:1000});
  const token=doc.token;const crop={x:0,y:0,width:600,height:600};
  // 裁后 600×600 的图：放大图 1200 宽（=裁后宽 2×）+ 左右各 20：画布 1240。
  // 先验全部失败关闭（不放宽成宽度区间，也不接受保存），再验合法扩宽。
  for (const clipboardSize of [
    {width:1240,height:1200,insetWidth:0},
    {width:1240,height:1200,insetWidth:-1200},
    {width:1240,height:1200,insetWidth:1200.5},
    {width:1240,height:1200,insetWidth:'1200'},
    {width:1240,height:1200,insetWidth:1201},
    {width:1240,height:1200,insetWidth:1199},
    {width:1239,height:1200,insetWidth:1200},
    {width:1240,height:599,insetWidth:1200},
    {width:1200,height:1200},
  ]) {
    await assert.rejects(h.invoke('shot:commit',rect,'copy',undefined,
      {token,png:editedHeader(1240,1200),crop,clipboardSize}),/未输出原图/);
  }
  await assert.rejects(h.invoke('shot:commit',rect,'save',undefined,
    {token,png:editedHeader(1240,1200),crop,clipboardSize:{width:1240,height:1200,insetWidth:1200}}),/未输出原图/);
  assert.equal(h.copied.length,0,'失败的都不得写剪贴板');
  assert.equal(h.writes.length,0,'保存一律拒 clipboardSize');
  assert.equal(h.api.isActive(),true,'失败不关窗口，编辑仍可重试');
  // 合法声明按主进程重算的宽度放行（提交成功会结束本次会话，所以放在最后）。
  const ok=await h.invoke('shot:commit',rect,'copy',undefined,
    {token,png:editedHeader(1240,1200),crop,clipboardSize:{width:1240,height:1200,insetWidth:1200}});
  assert.equal(ok.ok,true);
  assert.equal(h.copied.length,1);
  assert.match(h.statuses.at(-1).message,/1240 × 1200/,'状态栏报实际交付尺寸（含放大图）');
});
test('编辑裁切协议：长图裁切也按裁后尺寸输出', async () => {
  const h=harness();await h.api.start();await h.invoke('shot:ready');h.setLongOutput();
  const rect={x:0,y:0,width:10,height:10};
  const doc=await h.invoke('shot:edit-source',rect,'long-token');
  assert.deepEqual({width:doc.width,height:doc.height},{width:20,height:500});
  const result=await h.invoke('shot:commit',rect,'copy','long-token',
    {token:doc.token,png:editedHeader(20,200),crop:{x:0,y:100,width:20,height:200}});
  assert.equal(result.ok,true);
  assert.equal(h.copied.length,1);
  assert.match(h.statuses.at(-1).message,/20 × 200/);
});
test('编辑裁切协议：伪造负数/小数/越界/放大/PNG不符全部失败关闭，不写盘不复制', async () => {
  const h=harness();await h.api.start();await h.invoke('shot:ready');
  const rect={x:10,y:20,width:100,height:100};
  const doc=await h.invoke('shot:edit-source',rect);
  const token=doc.token;
  const bad=[null,{x:-1,y:0,width:10,height:10},{x:1.5,y:0,width:10,height:10},{x:0,y:0,width:10.5,height:10},
    {x:191,y:0,width:10,height:10},{x:0,y:0,width:201,height:10},{x:0,y:0,width:10,height:201},
    {x:0,y:0,width:0,height:10},{x:0,y:0,width:10,height:0},{x:'0',y:0,width:10,height:10}];
  for(const crop of bad) {
    await assert.rejects(h.invoke('shot:commit',rect,'copy',undefined,{token,png:editedHeader(200,200),crop}),/未输出原图|裁切/);
  }
  // 合法 crop 但 PNG 尺寸不符：失败关闭。
  await assert.rejects(h.invoke('shot:commit',rect,'copy',undefined,
    {token,png:editedHeader(200,200),crop:{x:10,y:20,width:100,height:80}}),/未输出原图/);
  // 保存不接受复制说明尺寸；伪造的说明尺寸与裁后图不符也拒绝。
  await assert.rejects(h.invoke('shot:commit',rect,'save',undefined,
    {token,png:editedHeader(720,300),crop:{x:10,y:20,width:100,height:80},clipboardSize:{width:720,height:300}}),/未输出原图/);
  await assert.rejects(h.invoke('shot:commit',rect,'copy',undefined,
    {token,png:editedHeader(720,300),crop:{x:10,y:20,width:100,height:80},clipboardSize:{width:719,height:300}}),/未输出原图/);
  await assert.rejects(h.invoke('shot:commit',rect,'copy',undefined,
    {token,png:editedHeader(720,300),crop:{x:10,y:20,width:100,height:80},clipboardSize:{width:720,height:79}}),/未输出原图/);
  assert.equal(h.copied.length,0);assert.equal(h.writes.length,0);
  assert.equal(h.api.isActive(),true,'失败不关窗口，编辑文档仍可重试');
  h.api.cancel();
});
test('编辑中Esc交给页面返回，关闭编辑后普通Esc仍取消；丢弃后旧token不可提交',async()=>{
  const h=harness();await h.api.start();await h.invoke('shot:ready');const rect={x:0,y:0,width:10,height:10};const doc=await h.invoke('shot:edit-source',rect);
  // 编辑窗开着：原窗已收起，主进程不拦 Esc 也不结束会话（Esc 属于另一扇窗里的编辑器）。
  let prevented=0;h.windows[0].webContents.emit('before-input-event',{preventDefault(){prevented++;}},{key:'Escape',type:'keyDown'});
  assert.equal(h.api.isActive(),true);assert.equal(prevented,0);
  await h.invoke('shot:edit-state',doc.token,'close');
  await h.invoke('shot:edit-state',doc.token,'open');
  await h.invoke('shot:edit-state',doc.token,'discard');
  await assert.rejects(h.invoke('shot:commit',rect,'copy',undefined,{token:doc.token,png:editedHeader(20,20)}),/失效/);
  h.windows[0].webContents.emit('before-input-event',{preventDefault(){prevented++;}},{key:'Escape',type:'keyDown'});
  assert.equal(h.api.isActive(),false);
});
test('托盘完成入口只认真实scrolling阶段，框选/准备/收尾/保存均不出现', async () => {
  const h=harness();assert.equal(h.api.canFinishScroll(),false);await h.api.start();await h.invoke('shot:ready');
  for(const phase of ['selecting','scroll-starting','scrolling','scroll-finishing','saving']) {
    h.setPhase(phase);assert.equal(h.api.canFinishScroll(),phase==='scrolling',phase);
  }
  h.setPhase('selecting');h.api.cancel();assert.equal(h.api.canFinishScroll(),false);
});

for(const options of [{cancelSave:true},{saveFails:true},{copyFails:true}])test(`编辑输出取消或失败保留文档且不回退原图 ${JSON.stringify(options)}`,async()=>{
  const h=harness(options);await h.api.start();await h.invoke('shot:ready');const rect={x:0,y:0,width:10,height:10};
  const doc=await h.invoke('shot:edit-source',rect);
  // 保存/复制发生在预览里：先回预览，再带着编辑窗导出的结果提交。
  await h.invoke('shot:edit-state',doc.token,'close');
  const result=await h.invoke('shot:commit',rect,options.copyFails?'copy':'save',undefined,{token:doc.token,png:editedHeader(20,20)});
  assert.equal(result.ok,false);assert.equal(h.api.isActive(),true);assert.equal((await h.invoke('shot:edit-source',rect)).token,doc.token);
  // 不带编辑结果时由主进程向隐藏的编辑窗要导出；页面回“导出失败”也不能回退成原图。
  const editor=h.windows.at(-1);
  await h.invoke('shot:edit-state',doc.token,'close');
  const pending=h.invoke('shot:commit',rect,'copy');
  await new Promise(resolve=>setImmediate(resolve));
  const request=editor.sent.filter(item=>item.channel==='shot:editor-export').at(-1);
  assert.ok(request,'真的向编辑窗发了导出请求');
  assert.equal(request.args[0].kind,'copy');
  h.handlers.get('shot:editor-export-reply')({sender:editor.webContents,senderFrame:editor.webContents.mainFrame},
    request.args[0].id,false,{message:'合成失败'});
  await assert.rejects(pending,/合成失败/);
  assert.equal(h.copied.length,0,'导出失败不写剪贴板');
  h.api.cancel();
});

test('预览里的保存/复制由主进程向隐藏编辑窗导出，回包后仍走尺寸校验', async () => {
  const h=harness();await h.api.start();await h.invoke('shot:ready');const rect={x:0,y:0,width:10,height:10};
  const doc=await h.invoke('shot:edit-source',rect);
  await h.invoke('shot:edit-state',doc.token,'close');
  const editor=h.windows.at(-1);
  const pending=h.invoke('shot:commit',rect,'copy');
  await new Promise(resolve=>setImmediate(resolve));
  const request=editor.sent.filter(item=>item.channel==='shot:editor-export').at(-1).args[0];
  assert.equal(request.kind,'copy');assert.equal(request.token,doc.token);
  h.handlers.get('shot:editor-export-reply')({sender:editor.webContents,senderFrame:editor.webContents.mainFrame},
    request.id,true,{token:doc.token,png:editedHeader(720,200),clipboardSize:{width:720,height:200}});
  const result=await pending;
  assert.equal(result.ok,true);assert.equal(h.copied.length,1);
  assert.match(h.statuses.at(-1).message,/720 × 200/,'按主进程重算后的交付尺寸报告');
});

test('导出回包必须来自编辑窗主 frame 且 id 属于当前请求，否则一律拒绝', async () => {
  const h=harness();await h.api.start();await h.invoke('shot:ready');const rect={x:0,y:0,width:10,height:10};
  const doc=await h.invoke('shot:edit-source',rect);
  await h.invoke('shot:edit-state',doc.token,'close');
  const editor=h.windows.at(-1);
  const pending=h.invoke('shot:commit',rect,'copy');
  await new Promise(resolve=>setImmediate(resolve));
  const request=editor.sent.filter(item=>item.channel==='shot:editor-export').at(-1).args[0];
  // 伪造 sender / 伪造 frame / 不存在的 id 都拒绝，不把结果交给提交。
  assert.throws(() => h.handlers.get('shot:editor-export-reply')({sender:{},senderFrame:{}},request.id,true,{token:doc.token,png:editedHeader(20,20)}),/无效|失效/);
  assert.throws(() => h.handlers.get('shot:editor-export-reply')({sender:editor.webContents,senderFrame:{}},request.id,true,{token:doc.token,png:editedHeader(20,20)}),/无效|失效/);
  assert.throws(() => h.handlers.get('shot:editor-export-reply')({sender:editor.webContents,senderFrame:editor.webContents.mainFrame},'nope',true,{token:doc.token,png:editedHeader(20,20)}),/导出请求已失效/);
  assert.equal(h.copied.length,0);
  h.handlers.get('shot:editor-export-reply')({sender:editor.webContents,senderFrame:editor.webContents.mainFrame},request.id,true,{token:doc.token,png:editedHeader(20,20)});
  const result=await pending;assert.equal(result.ok,true);
});

test('截图一开始就查前台窗口句柄，长截图拿它把焦点还回去',async()=>{
  const h=harness({foreground:3211506});await h.api.start();await h.invoke('shot:ready');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.foregroundQueries(),1);assert.equal(h.foregroundHwnd(),3211506);h.api.cancel();
});

test('前台句柄查不到或失败也不拦截图，长截图桥照样可建',async()=>{
  for(const foreground of [0,undefined]){
    const h=harness({foreground});await h.api.start();await h.invoke('shot:ready');await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.api.isActive(),true);assert.equal(h.foregroundHwnd(),0);h.api.cancel();
  }
  const h=harness({foreground:Promise.reject(new Error('查询失败'))});await h.api.start();await h.invoke('shot:ready');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(h.api.isActive(),true);h.api.cancel();
});

// —— 多屏第一阶段：鼠标所在屏、每屏独立物理原点/尺寸、配置变动安全拒绝 ——
// 物理矩形由夹具直接给出（故意不等于 DIP×缩放），模拟混合 DPI 下 Windows 返回的真实原点。
const multiDisplays = [
  { id: 11, label: '125% 左侧负x', bounds: { x: -1280, y: 0, width: 8, height: 6 }, scaleFactor: 1.25,
    physical: { x: -1597, y: 0, width: 10, height: 7 }, crop: { x: 1, y: 1, width: 3, height: 3 } },
  { id: 12, label: '150% 上方负y', bounds: { x: 0, y: -1080, width: 8, height: 6 }, scaleFactor: 1.5,
    physical: { x: 3, y: -1612, width: 12, height: 9 }, crop: { x: 2, y: 2, width: 3, height: 3 } },
  { id: 13, label: '100% 竖屏', bounds: { x: 0, y: 0, width: 6, height: 8 }, scaleFactor: 1,
    physical: { x: 0, y: 0, width: 6, height: 8 }, crop: { x: 1, y: 1, width: 2, height: 2 } },
  { id: 14, label: '200% 右侧', bounds: { x: 6, y: 0, width: 8, height: 6 }, scaleFactor: 2,
    physical: { x: 6, y: 0, width: 16, height: 12 }, crop: { x: 2, y: 2, width: 4, height: 4 } }
];
// 单屏回归：默认 start() 在 Windows 多屏下会走跨屏，这些用例只枚举被测那一块屏，
// 保留原「按本屏物理矩形取屏/裁切」的合同；多屏入口的新合同见 desktop-capture.test.cjs。
for (const target of multiDisplays) test(`混合DPI只取鼠标所在屏并不混淆物理原点：${target.scaleFactor * 100}% ${target.label}`, async () => {
  const h = harness({ platform: 'win32', controlVisible: false, displays: multiDisplays, enumerate: [target.id], cursor: { x: target.bounds.x + 2, y: target.bounds.y + 2 } });
  await h.api.start();
  assert.deepEqual(h.cursorReads, [{ x: target.bounds.x + 2, y: target.bounds.y + 2 }], '只用鼠标位置挑屏');
  assert.deepEqual({ ...h.nativeRegions[0] }, target.physical, '按该屏自己映射的物理矩形取屏');
  assert.deepEqual({ ...h.bitmapInputs[0].options }, { width: target.physical.width, height: target.physical.height, scaleFactor: 1 });
  const win = h.windows[0];
  assert.deepEqual({ x: win.bounds.x, y: win.bounds.y, width: win.bounds.width, height: win.bounds.height }, target.bounds, '选区窗口铺在 DIP 边界上');
  assert.deepEqual((await h.invoke('shot:init')).bounds, target.bounds);
  await h.invoke('shot:ready');
  // 页面里的选区坐标相对选区窗口（0 基点）。
  const rect = { x: 1, y: 1, width: 2, height: 2 };
  const result = await h.invoke('shot:commit', rect, 'copy');
  assert.equal(result.ok, true);
  assert.deepEqual(h.crops[0], target.crop, '裁切按该屏真实物理帧尺寸换算');
  assert.deepEqual(h.statuses.at(-1).dimensions, { width: target.crop.width, height: target.crop.height });
  assert.equal(h.copied.length, 1); assert.equal(h.writes.length, 0);
});

test('等候取屏期间移动鼠标仍锁定启动时那块屏', async () => {
  const target = multiDisplays[3];
  const h = harness({ platform: 'win32', controlVisible: false, displays: multiDisplays, enumerate: [target.id], cursor: { x: target.bounds.x + 2, y: target.bounds.y + 2 }, deferSnapshot: true });
  const job = h.api.start(); await new Promise(resolve => setImmediate(resolve));
  h.setCursor({ x: -1278, y: 2 }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual({ ...h.nativeRegions[0] }, target.physical, '异步取屏用的还是启动那块屏');
  const win = h.windows[0];
  assert.deepEqual({ x: win.bounds.x, y: win.bounds.y, width: win.bounds.width, height: win.bounds.height }, target.bounds);
  h.resolveSnapshot(); await job;
  assert.equal(h.api.isActive(), true, '取屏完成后仍保留启动时的会话');
  assert.equal(h.cursorReads.length, 1, '取屏完成后也不重新按当前鼠标位置挑屏');
  assert.deepEqual((await h.invoke('shot:init')).bounds, target.bounds, '异步完成后底图与窗口仍属于启动屏');
  h.api.cancel();
  assert.equal(h.api.isActive(), false); assert.equal(h.writes.length, 0); assert.equal(h.copied.length, 0);
});

for (const kind of ['removed', 'scale', 'bounds']) test(`取屏期间显示器${kind === 'removed' ? '断开' : kind === 'scale' ? '缩放改变' : '尺寸改变'}保持安全拒绝`, async () => {
  const target = multiDisplays[3];
  const h = harness({ platform: 'win32', controlVisible: false, displays: multiDisplays, enumerate: [target.id], cursor: { x: target.bounds.x + 2, y: target.bounds.y + 2 }, deferSnapshot: true });
  const job = h.api.start(); await new Promise(resolve => setImmediate(resolve));
  if (kind === 'removed') h.dropDisplay(target.id);
  else if (kind === 'scale') h.patchDisplay(target.id, { scaleFactor: 1.75 });
  else h.patchDisplay(target.id, { bounds: { ...target.bounds, height: 7 } });
  h.resolveSnapshot(); await job;
  assert.equal(h.api.isActive(), false);
  assert.match(h.statuses.at(-1).message, /显示器配置发生变化/);
  assert.equal(h.statuses.at(-1).error, true);
  assert.equal(h.writes.length, 0); assert.equal(h.copied.length, 0);
  assert.equal(h.windows.every(win => win.isDestroyed()), true, '拒绝后不留过期选区窗口');
});

test('选区窗口边界差 1 DIP 仍按现有规则安全失败', async () => {
  const traces = [];
  const h = harness({ readySkew: 1, diagnostics: { state: () => ({ recording: true }), record: (event, fields) => traces.push({ event, fields }), end() {} } });
  await h.api.start(); await h.invoke('shot:ready');
  assert.equal(h.api.isActive(), false);
  assert.match(h.statuses.at(-1).message, /未能覆盖完整显示器/);
  assert.equal(traces.find(row => row.event === 'renderer-error').fields.errorCode, 'selection-size-mismatch');
  assert.equal(h.crops.length, 0); assert.equal(h.writes.length, 0); assert.equal(h.copied.length, 0);
  assert.equal(h.windows[0].isDestroyed(), true);
});

test('非Windows多屏按所选屏缩放申请缩略图并对应换算裁切', async () => {
  const displays = [{ id: 21, bounds: { x: 0, y: 0, width: 16, height: 12 }, scaleFactor: 1 },
    { id: 22, bounds: { x: 16, y: 0, width: 8, height: 8 }, scaleFactor: 1.5 }];
  const h = harness({ platform: 'darwin', controlVisible: false, displays, cursor: { x: 18, y: 2 } });
  await h.api.start();
  assert.equal(h.fitCalls.length, 0, '非Windows不做物理窗口适配');
  assert.deepEqual({ ...h.sourceOptions().thumbnailSize }, { width: 12, height: 12 }, '请求尺寸取鼠标所在屏，不是第一块屏');
  await h.invoke('shot:ready');
  const result = await h.invoke('shot:commit', { x: 1, y: 1, width: 2, height: 2 }, 'copy');
  assert.equal(result.ok, true);
  assert.deepEqual(h.crops[0], { x: 2, y: 2, width: 3, height: 3 });
});

test('capture-start 与 snapshot-ready 带所选屏 id，不写名称或坐标', async t => {
  const { r, rows } = recordingFixture(t);
  const target = multiDisplays[1];
  const h = harness({ platform: 'win32', controlVisible: false, displays: multiDisplays, enumerate: [target.id], cursor: { x: target.bounds.x + 2, y: target.bounds.y + 2 }, diagnostics: r });
  r.startAutomatic(); await h.api.start(); await h.invoke('shot:ready'); h.api.cancel(); await r.flush();
  const output = rows();
  const captureStart = output.find(row => row.event === 'capture-start');
  const snapshotReady = output.find(row => row.event === 'snapshot-ready');
  assert.equal(captureStart.displayId, target.id); assert.equal(snapshotReady.displayId, target.id);
  assert.equal(typeof captureStart.displayId, 'number');
  assert.equal(snapshotReady.width, target.physical.width); assert.equal(snapshotReady.height, target.physical.height);
  assert.doesNotMatch(JSON.stringify(output), /120%|显示器 1|physical|bounds":|label/);
});

// —— 175% 副屏现场：Electron 的 dipToScreenRect 给出 1922×1082，真实监视器是 1920×1080 ——
// hint 只用于挑监视器并做后续拓扑复核，快照与裁切一律按查询到的真实矩形，不放宽包含检查。
const fieldDisplay = [{ id: 4128785334, bounds: { x: 1920, y: 274, width: 1098, height: 618 }, scaleFactor: 1.75,
  hint: { x: 3840, y: 548, width: 1922, height: 1082 }, physical: { x: 3840, y: 548, width: 1920, height: 1080 },
  // 真实工作区（本机 --workarea-info 亲核）：440,548 1920×996，DIP 高度 570。
  workArea: { x: 1920, y: 274, width: 1098, height: 570 },
  workHint: { x: 3840, y: 548, width: 1922, height: 998 }, workPhysical: { x: 3840, y: 548, width: 1920, height: 996 } }];
const fieldCursor = { x: 1922, y: 276 };

test('175% 副屏：hint 1922×1082 只用于查询，真实 1920×1080 建图、BMP 与裁切', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, displays: fieldDisplay, cursor: fieldCursor });
  await h.api.start();
  assert.deepEqual(h.monitorQueries, [{ x: 3840, y: 548, width: 1922, height: 1082 }], '查询用 Electron 物理 hint');
  assert.deepEqual({ ...h.nativeRegions[0] }, { x: 3840, y: 548, width: 1920, height: 1080 }, '采屏用真实矩形，不是 1922');
  assert.equal(h.nativeOptions[0].purpose, 'snapshot');
  assert.deepEqual({ ...h.bitmapInputs[0].options }, { width: 1920, height: 1080, scaleFactor: 1 });
  const current = h.getCurrent();
  assert.deepEqual({ ...current.nativeBounds }, { x: 3840, y: 548, width: 1920, height: 1080 });
  assert.deepEqual({ ...current.nativeHint }, { x: 3840, y: 548, width: 1922, height: 1082 }, '原 hint 留下做拓扑复核');
  // 窗口先按原 DIP bounds 建，再用真实物理矩形适配；只有适配成功才加载页面。
  assert.deepEqual(h.fitCalls.map(({ handle, pid, bounds }) => ({ handle, pid, bounds })),
    [{ handle: '1234567890', pid: 4321, bounds: { x: 3840, y: 548, width: 1920, height: 1080 } }]);
  assert.match(h.fitCalls[0].nonce, /^[0-9a-f]{32}$/, 'nonce 只允许 32 位小写十六进制');
  assert.equal(h.windows[0].title, h.fitCalls[0].nonce, 'nonce 已写到隐藏窗标题供原生核对');
  assert.deepEqual(h.windows[0].loads?.map(file => path.basename(file)), ['selection.html']);
  const init = await h.invoke('shot:init');
  assert.equal(init.bmpBytes.length, 54 + 1920 * 1080 * 4);
  assert.equal(init.bmpBytes.readInt32LE(18), 1920); assert.equal(init.bmpBytes.readInt32LE(22), -1080);
  await h.invoke('shot:ready');
  const result = await h.invoke('shot:commit', { x: 0, y: 0, width: 1098, height: 618 }, 'copy');
  assert.equal(result.ok, true);
  assert.deepEqual(h.crops[0], { x: 0, y: 0, width: 1920, height: 1080 }, '整屏裁切不多 2px');
  h.api.cancel();
});

test('等待监视器矩形查询时取消：不启动采集，也不留过期选区窗口', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, displays: fieldDisplay, cursor: fieldCursor });
  h.setMonitorQuery('defer');
  const job = h.api.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.monitorQueries.length, 1);
  h.api.cancel();
  h.resolveMonitor(); await job;
  assert.equal(h.api.isActive(), false);
  assert.equal(h.nativeRegions.length, 0, '取消后不得再启动原生采集');
  assert.equal(h.windows.every(win => win.isDestroyed()), true);
});

test('监视器矩形查询被拒：安全提示，不采屏不留窗', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, displays: fieldDisplay, cursor: fieldCursor });
  h.setMonitorQuery('reject');
  await h.api.start();
  assert.equal(h.api.isActive(), false);
  assert.match(h.statuses.at(-1).message, /未能确认显示器真实像素范围/);
  assert.equal(h.statuses.at(-1).error, true);
  assert.equal(h.nativeRegions.length, 0);
  assert.equal(h.windows.every(win => win.isDestroyed()), true);
});

test('查询期间显示器断开：按配置变化拒绝，不拿旧矩形采屏', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, displays: fieldDisplay, cursor: fieldCursor });
  h.setMonitorQuery('defer');
  const job = h.api.start(); await new Promise(resolve => setImmediate(resolve));
  h.dropDisplay(fieldDisplay[0].id);
  h.resolveMonitor(); await job;
  assert.equal(h.api.isActive(), false);
  assert.match(h.statuses.at(-1).message, /显示器配置发生变化/);
  assert.equal(h.statuses.at(-1).error, true);
  assert.equal(h.nativeRegions.length, 0);
  assert.equal(h.windows.every(win => win.isDestroyed()), true);
});

test('物理窗口适配失败：安全结束，不加载选区页面不留窗', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, displays: fieldDisplay, cursor: fieldCursor });
  h.setFitMode('reject');
  await h.api.start();
  assert.equal(h.api.isActive(), false);
  assert.equal(h.fitCalls.length, 1);
  assert.match(h.statuses.at(-1).message, /截图未完成：窗口物理布局失败/);
  assert.equal(h.statuses.at(-1).error, true);
  assert.equal(h.windows[0].loads?.length ?? 0, 0, '适配失败不得加载选区页面');
  assert.equal(h.windows.every(win => win.isDestroyed()), true);
  assert.equal(h.windows[0].isVisible(), false, '失败路径不显示窗口');
});

test('物理窗口适配期间取消：迟到完成也不加载页面、不留在屏上', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, displays: fieldDisplay, cursor: fieldCursor });
  h.setFitMode('defer');
  const job = h.api.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.fitCalls.length, 1);
  h.api.cancel();
  h.resolveFit(); await job;
  assert.equal(h.api.isActive(), false);
  assert.equal(h.windows[0].loads?.length ?? 0, 0, '取消后不得再加载页面');
  assert.equal(h.windows.every(win => win.isDestroyed()), true);
});

test('175% 副屏：ready 只在物理适配后通过，未适配的 1099×619 仍被原严格检查拒绝', async () => {
  // 1) 适配声称成功但窗口没真的变：回读仍是 display.bounds+1，ready 必须失败。
  const bad = harness({ platform: 'win32', controlVisible: false, displays: fieldDisplay, cursor: fieldCursor, skewUntilFit: true });
  bad.setFitMode('skip');
  await bad.api.start();
  assert.equal(bad.windows[0].isVisible(), false);
  await bad.invoke('shot:ready');
  assert.equal(bad.api.isActive(), false);
  assert.match(bad.statuses.at(-1).message, /未能覆盖完整显示器/);
  assert.equal(bad.windows[0].isVisible(), false);
  // 2) 真适配后回读等于 display.bounds，同一 ready 检查通过并显示窗口。
  const ok = harness({ platform: 'win32', controlVisible: false, displays: fieldDisplay, cursor: fieldCursor, skewUntilFit: true });
  await ok.api.start();
  assert.equal(ok.fitCalls.length, 1);
  await ok.invoke('shot:ready');
  assert.equal(ok.api.isActive(), true);
  assert.equal(ok.windows[0].isVisible(), true);
  ok.api.cancel();
});

test('175% 副屏：监视器与真实工作区并行查询，工作区必须被监视器包含', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, displays: fieldDisplay, cursor: fieldCursor });
  await h.api.start();
  assert.deepEqual(h.monitorQueries, [{ x: 3840, y: 548, width: 1922, height: 1082 }]);
  assert.deepEqual(h.workQueries, [{ x: 3840, y: 548, width: 1922, height: 998 }], '工作区按 display.workArea 投影查询');
  const current = h.getCurrent();
  assert.deepEqual({ ...current.nativeWorkArea }, { x: 3840, y: 548, width: 1920, height: 996 });
  assert.deepEqual({ ...current.nativeWorkHint }, { x: 3840, y: 548, width: 1922, height: 998 });
  // 底图/裁切仍按监视器真实矩形，不被工作区缩小。
  assert.deepEqual({ ...h.nativeRegions[0] }, { x: 3840, y: 548, width: 1920, height: 1080 });
  h.api.cancel();
});

test('工作区查询结果超出监视器：安全拒绝，不采屏不留窗', async () => {
  const displays = [{ ...fieldDisplay[0], workPhysical: { x: 3840, y: 548, width: 1920, height: 1200 } }];
  const h = harness({ platform: 'win32', controlVisible: false, displays, cursor: fieldCursor });
  await h.api.start();
  assert.equal(h.api.isActive(), false);
  assert.match(h.statuses.at(-1).message, /显示器工作区不在监视器内/);
  assert.equal(h.statuses.at(-1).error, true);
  assert.equal(h.nativeRegions.length, 0);
  assert.equal(h.windows.every(win => win.isDestroyed()), true);
});

test('等待工作区查询时取消：不启动采集也不留窗口', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, displays: fieldDisplay, cursor: fieldCursor });
  h.setWorkQuery('defer');
  const job = h.api.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.workQueries.length, 1);
  h.api.cancel();
  h.resolveWork(); await job;
  assert.equal(h.api.isActive(), false);
  assert.equal(h.nativeRegions.length, 0);
  assert.equal(h.windows.every(win => win.isDestroyed()), true);
});

test('取屏完成后工作区配置变化同样拒绝', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, displays: fieldDisplay, cursor: fieldCursor, deferSnapshot: true });
  const job = h.api.start(); await new Promise(resolve => setImmediate(resolve));
  h.patchDisplay(fieldDisplay[0].id, { workArea: { x: 1920, y: 274, width: 1098, height: 560 } });
  h.resolveSnapshot(); await job;
  assert.equal(h.api.isActive(), false);
  assert.match(h.statuses.at(-1).message, /显示器配置发生变化/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.windows.every(win => win.isDestroyed()), true);
});

// —— 125% 副屏现场：窗口回读 865 DIP，页面 innerHeight 只有 864 ——
// 选区局部坐标的唯一基准是主进程读到的页面视口；旧写法用 display.bounds 会把整屏裁成 1079。
const scalingDisplay = [{ id: 77, label: '125% 副屏 865/864', bounds: { x: 1920, y: 274, width: 1536, height: 865 }, scaleFactor: 1.25,
  hint: { x: 3840, y: 548, width: 1920, height: 1081 }, physical: { x: 3840, y: 548, width: 1920, height: 1080 },
  workArea: { x: 1920, y: 274, width: 1536, height: 825 },
  workHint: { x: 3840, y: 548, width: 1920, height: 1031 }, workPhysical: { x: 3840, y: 548, width: 1920, height: 1030 } }];
const scalingCursor = { x: 1922, y: 276 };

test('125% 副屏：选区基准取页面视口 864，整屏裁切仍是 1080 像素', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, displays: scalingDisplay, cursor: scalingCursor, viewportDelta: { height: -1 } });
  await h.api.start();
  await h.invoke('shot:ready');
  assert.deepEqual({ ...h.getCurrent().selectionBounds }, { x: 0, y: 0, width: 1536, height: 864 }, '基准是主进程自己读到的视口');
  assert.equal(h.viewportProbes.length, 1, '尺寸由主进程读，不信任IPC传来的任意值');
  // 窗口回读的 865 不是页面坐标：多出来的那 1 DIP 必须按越界拒绝。
  await assert.rejects(h.invoke('shot:commit', { x: 0, y: 0, width: 1536, height: 865 }, 'save'), /超出/);
  const result = await h.invoke('shot:commit', { x: 0, y: 0, width: 1536, height: 864 }, 'copy');
  assert.equal(result.ok, true);
  assert.deepEqual(h.crops[0], { x: 0, y: 0, width: 1920, height: 1080 }, '按 864 视口换算正好整帧，不再少 1 像素');
});

test('125% 副屏：编辑来源同样按视口换算，不叠屏幕全局原点', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, displays: scalingDisplay, cursor: scalingCursor, viewportDelta: { height: -1 } });
  await h.api.start(); await h.invoke('shot:ready');
  const source = await h.invoke('shot:edit-source', { x: 0, y: 1, width: 1536, height: 863 });
  assert.deepEqual(h.crops[0], { x: 0, y: 1, width: 1920, height: 1079 });
  assert.equal(source.width, 1920); assert.equal(source.height, 1079);
  h.api.cancel();
});

for (const [label, viewportOverride] of [['0 宽', { width: 0, height: 864 }], ['负高', { width: 1536, height: -1 }],
  ['非整数', { width: 1536.5, height: 864 }], ['读不到', null], ['字符串', { width: '1536', height: '864' }]]) {
  test(`视口读取不是正安全整数就拒绝 ready：${label}`, async () => {
    const h = harness({ platform: 'win32', controlVisible: false, displays: scalingDisplay, cursor: scalingCursor, viewportOverride });
    await h.api.start();
    await assert.rejects(h.invoke('shot:ready'), /视口尺寸无效/);
    assert.equal(h.api.isActive(), false);
    assert.equal(h.windows[0].visible, undefined, '失败路径不把窗口显示出来');
    assert.equal(h.windows[0].isDestroyed(), true);
    assert.match(h.statuses.at(-1).message, /选区页面尺寸读取失败/);
    assert.equal(h.statuses.at(-1).error, true);
  });
}

test('读视口期间取消：过期 ready 不复活会话、不留窗口', async () => {
  const h = harness({ deferViewport: true });
  await h.api.start();
  const pending = h.invoke('shot:ready');
  h.api.cancel();
  h.resolveViewport();
  assert.equal(await pending, undefined);
  assert.equal(h.api.isActive(), false);
  assert.equal(h.windows[0].isDestroyed(), true);
  assert.equal(h.crops.length, 0); assert.equal(h.copied.length, 0);
});

test('读视口期间显示器配置变化：不 show、不进入 selecting，也不落半截基准', async () => {
  const h = harness({ deferViewport: true });
  await h.api.start();
  const win = h.windows[0];
  const pending = h.invoke('shot:ready');
  h.patchDisplay(7, { scaleFactor: 1.5 });
  h.resolveViewport();
  await assert.rejects(pending, /已变化/);
  assert.equal(h.api.isActive(), false);
  assert.equal(win.visible, undefined, '拓扑变了就不能 show');
  assert.equal(win.isDestroyed(), true);
  assert.equal(h.getCurrent(), undefined);
  assert.match(h.statuses.at(-1).message, /已变化/);
});

test('读视口期间宿主窗口尺寸变化：同样不 show、不进入 selecting', async () => {
  const h = harness({ deferViewport: true });
  await h.api.start();
  const win = h.windows[0];
  const pending = h.invoke('shot:ready');
  win.setBounds({ ...win.bounds, height: win.bounds.height + 1 });
  h.resolveViewport();
  await assert.rejects(pending, /已变化/);
  assert.equal(h.api.isActive(), false);
  assert.equal(win.visible, undefined);
  assert.equal(win.isDestroyed(), true);
});

test('缺少视口基准的提交与编辑请求一律拒绝，不回退 display.bounds', async () => {
  const h = harness();
  await h.api.start(); await h.invoke('shot:ready');
  delete h.getCurrent().selectionBounds;
  await assert.rejects(h.invoke('shot:commit', { x: 0, y: 0, width: 10, height: 10 }, 'copy'), /视口基准/);
  await assert.rejects(h.invoke('shot:edit-source', { x: 0, y: 0, width: 10, height: 10 }), /视口基准/);
  assert.equal(h.copied.length, 0); assert.equal(h.crops.length, 0);
  h.api.cancel();
});

test('选区就绪后缩放变化，提交按旧基准拒绝而不是错裁', async () => {
  const h = harness();
  await h.api.start(); await h.invoke('shot:ready');
  h.patchDisplay(7, { scaleFactor: 1.5 });
  await assert.rejects(h.invoke('shot:commit', { x: 0, y: 0, width: 10, height: 10 }, 'copy'), /分辨率或缩放/);
  assert.equal(h.copied.length, 0); assert.equal(h.crops.length, 0);
  h.api.cancel();
});

// ── F1 重入恢复链：唤回同一会话、保留未保存内容，只有明确确认才重开 ──
const selectingSession = async (options = {}) => {
  const h = harness(options);
  await h.api.start({ hideControl: options.hideControl ?? false });
  await h.invoke('shot:ready');
  return h;
};

test('F1 重入：唤回同一选区窗、只整窗重绘一次，不新建窗口、不重采样、不改 bounds', async () => {
  const h = await selectingSession({ controlVisible: false });
  const win = h.windows[0];
  const bounds = { ...win.bounds };
  h.setLongOutput();
  const capturesBefore = h.nativeRegions.length;
  h.setProbe('drawable');
  await h.api.start({ hideControl: false });
  assert.equal(h.windows.length, 1, '连按不新开选区窗口');
  assert.equal(win.invalidates, 1, 'Electron 44 的 invalidate 只排一次整窗重绘');
  assert.equal(win.raised, 1, 'moveTop 抬回原窗');
  assert.equal(win.shows, 2, 'ready 上屏一次 + 唤回一次，没有额外 show');
  assert.deepEqual({ ...win.bounds }, bounds, '不改 bounds，也不 fit 已可见窗');
  assert.equal(h.nativeRegions.length, capturesBefore, '不重新采样');
  assert.equal(h.getCurrent()?.longImage !== undefined, true, '长图状态保留');
  assert.equal(h.getCurrent()?.longToken, 'long-token');
  assert.equal(h.statuses.at(-1).message, '已尝试唤回当前截图，未清除内容。');
  assert.equal(h.messageBoxes.length, 0, '健康时不弹窗');
});

test('F1 重入：最小化的选区窗先 restore 再 show，仍保留原会话', async () => {
  const h = await selectingSession();
  h.setProbe('drawable');
  const win = h.windows[0];
  win.minimize();
  await h.api.start({ hideControl: false });
  assert.equal(win.isMinimized(), false);
  assert.equal(win.restores, 1);
  assert.equal(win.isVisible(), true);
  assert.equal(h.windows.length, 1);
  assert.equal(h.api.isActive(), true);
});

for (const phase of ['capturing', 'loading']) test(`重入遇到 ${phase}：只提示准备中，不 show 隐藏窗、不探针、不弹窗`, async () => {
  // capturing：快照未归、窗口未建；loading：物理 fit 完、页面未 ready。
  const capturing = phase === 'capturing';
  const h = harness(capturing ? { deferSnapshot: true } : { platform: 'win32' });
  const first = h.api.start();
  if (capturing) assert.equal(h.getCurrent().phase, 'capturing');
  else await first;
  assert.equal(h.getCurrent().phase, phase);
  await h.api.start();
  assert.equal(h.statuses.at(-1).message, '截图正在准备中，稍等即可框选。');
  assert.equal(h.probeCalls.length, 0);
  assert.equal(h.messageBoxes.length, 0);
  assert.equal(h.api.isActive(), true, '会话仍在');
  if (capturing) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].isVisible(), false, '原生 fit 必须发生在隐藏窗上');
  assert.equal(h.windows[0].shows, undefined, '不把准备中的窗提前显示');
  if (capturing) { h.resolveSnapshot(); await first; }
});

for (const phase of ['saving', 'scroll-starting', 'scrolling', 'scroll-finishing']) test(`重入遇到 ${phase}：会话/采集/焦点都不动，只报实际忙阶段`, async () => {
  const h = await selectingSession();
  h.setPhase(phase);
  const win = h.windows[0];
  const probesBefore = h.probeCalls.length;
  const showsBefore = win.shows;
  await h.api.start();
  assert.equal(h.api.isActive(), true, '保存/长截阶段绝不终止');
  assert.equal(h.getCurrent().phase, phase);
  assert.equal(h.windows.length, 1);
  assert.equal(win.invalidates, undefined, '不重绘');
  assert.equal(win.shows, showsBefore, '不改焦点/可见性');
  assert.equal(h.probeCalls.length, probesBefore, '不探针');
  assert.equal(h.messageBoxes.length, 0, '不新造 dialog');
  assert.equal(h.statuses.at(-1).error, true);
  assert.match(h.statuses.at(-1).message, phase === 'saving' ? /保存或复制/ : /长截图/);
});

test('探针明确 non-drawable 时弹原生 dialog：默认保留，唯一 response 1 才重开', async () => {
  const h = await selectingSession();
  const win = h.windows[0];
  h.setLongOutput();
  h.setProbe('blocked');
  h.setMessageBoxResponse(0);
  await h.api.start({ hideControl: false });
  assert.equal(h.messageBoxes.length, 1);
  const { parent, options } = h.messageBoxes[0];
  assert.equal(parent, undefined, '无 parent：不让全屏 always-on-top 旧窗盖住提示');
  assert.equal(options.title, '截图窗口未恢复');
  assert.equal(options.message, '当前截图窗口未能确认恢复。放弃后会丢失未保存的选框、长图或标注。');
  assert.deepEqual([...options.buttons], ['保留当前截图', '放弃并重新截图']);
  assert.deepEqual([options.defaultId, options.cancelId, options.noLink], [0, 0, true]);
  assert.equal(h.api.isActive(), true, '默认保留，不丢会话');
  assert.equal(h.getCurrent().longImage !== undefined, true, '不清源图/长图');
  assert.equal(win.destroyed, false);
  assert.equal(h.statuses.at(-1).message, '已保留当前截图数据，没有重新截图。');

  // 保留之后恢复 Promise 已清：再按一次会重新探针，这次健康就回到会话。
  h.setProbe('drawable');
  await h.api.start({ hideControl: false });
  assert.equal(h.probeCalls.length, 2, '第二轮的探针照常进行');
  assert.equal(h.messageBoxes.length, 1, '健康时不再弹窗');
  assert.equal(h.statuses.at(-1).message, '已尝试唤回当前截图，未清除内容。');
});

test('唯一明确 response 1 才结束旧会话，并按本次 hideControl 重开一次', async () => {
  const h = await selectingSession({ controlVisible: true });
  const old = h.windows[0];
  h.setProbe('blocked');
  h.setMessageBoxResponse(1);
  await h.api.start({ hideControl: false });
  assert.equal(old.destroyed, true, '旧会话按原恢复语义结束');
  assert.equal(h.windows.length, 2, '只重开一个新会话');
  assert.equal(h.api.isActive(), true, '新会话已建立');
  assert.equal(h.getCurrent().win, h.windows[1]);
  assert.equal(h.control.hides, 0, 'hideControl=false 的重开不隐藏控制页');
});

test('确认重截不先恢复旧控制页：设置窗不会中途入镜，新会话也不双开', async () => {
  const h = harness({ controlVisible: true });
  await h.api.start({ hideControl: true });
  assert.equal(h.control.visible, false, '页面入口先隐藏设置窗');
  await h.invoke('shot:ready');
  const old = h.windows[0];
  h.setProbe('blocked');
  h.setMessageBoxResponse(1);
  await h.api.start({ hideControl: false });
  assert.equal(h.control.shows, 0, 'end 不先恢复旧控制页，新 start 按本次 hideControl 决定');
  assert.equal(h.control.visible, false, '重截底图里不会框进本程序设置窗');
  assert.equal(old.destroyed, true);
  assert.equal(h.windows.length, 2, '只一个新会话');
  assert.equal(h.api.isActive(), true);
  assert.equal(h.getCurrent().win, h.windows[1]);
});

for (const [label, setup] of [
  ['探针超时', h => h.setProbe('defer')],
  ['探针抛错', h => h.setProbe('reject')],
  ['窗口销毁', h => { h.windows[0].destroyed = true; }]
]) test(`${label}：只算不可响应，弹窗默认保留，不自动重开`, async () => {
  const h = await selectingSession();
  setup(h);
  h.setMessageBoxResponse(0);
  const pending = h.api.start({ hideControl: false });
  if (label === '探针超时') { await new Promise(resolve => setImmediate(resolve)); h.fireTimer(1500); }
  await pending;
  assert.equal(h.messageBoxes.length, 1, '不可响应才问一次');
  if (label === '窗口销毁') assert.equal(h.messageBoxes[0].parent, undefined, '已销毁的窗不能当 parent');
  assert.equal(h.api.isActive(), true);
  assert.equal(h.statuses.at(-1).message, '已保留当前截图数据，没有重新截图。');
});

test('show 之后仍不可见：走 dialog，不当成已恢复', async () => {
  const h = await selectingSession({ stuckHidden: true });
  h.setProbe('drawable');
  h.setMessageBoxResponse(0);
  await h.api.start({ hideControl: false });
  assert.equal(h.probeCalls.length, 0, '仍隐藏就不白探一次');
  assert.equal(h.messageBoxes.length, 1);
  assert.equal(h.statuses.at(-1).message.includes('已保留'), true);
  assert.equal(h.api.isActive(), true);
});

test('dialog 等待期间取消：迟到的 response 1 也不得重开', async () => {
  const h = await selectingSession({ deferMessageBox: true });
  h.setProbe('blocked');
  const pending = h.api.start({ hideControl: false });
  await new Promise(resolve => setImmediate(resolve));
  h.api.cancel();
  h.resolveMessageBox(1);
  await pending;
  assert.equal(h.windows.length, 1, '已取消的会话不再建新窗');
  assert.equal(h.api.isActive(), false);
});

test('探针回包缺字段只算未知：不宣称已恢复、不自动丢，走同一默认保留确认', async () => {
  const h = await selectingSession();
  assert.equal(h.probeCalls.length, 0, '首轮 start 不做健康探针');
  await h.api.start({ hideControl: false });
  assert.equal(h.probeCalls.length, 1);
  assert.equal(h.messageBoxes.length, 1, '形状未知也要问，只默认保留');
  assert.equal(h.messageBoxes[0].options.title, '截图窗口未恢复');
  assert.deepEqual([h.messageBoxes[0].options.defaultId, h.messageBoxes[0].options.cancelId], [0, 0]);
  assert.equal(h.api.isActive(), true, '未知不自动 discard');
  assert.equal(h.windows.length, 1, '不自动重开');
  assert.equal(h.statuses.at(-1).message, '已保留当前截图数据，没有重新截图。');
});

test('unknown 且对话框缺 response：同样保留，不重开', async () => {
  const h = await selectingSession({ messageBoxResponse: undefined });
  await h.api.start({ hideControl: false });
  assert.equal(h.messageBoxes.length, 1);
  assert.equal(h.messageBoxes[0].options.defaultId, 0);
  assert.equal(h.api.isActive(), true);
  assert.equal(h.windows.length, 1);
  assert.equal(h.statuses.at(-1).message, '已保留当前截图数据，没有重新截图。');
});

test('确认框弹出期间旧全屏窗已 hide：不被它盖住、不销毁不重载，保留后同一窗原样还回', async () => {
  const h = await selectingSession({ deferMessageBox: true });
  const win = h.windows[0];
  h.setLongOutput();
  h.getCurrent().editDocument = { token: 'edit-token', pixels: { x: 0, y: 0, width: 2, height: 2 } };
  h.setProbe('blocked');
  const pending = h.api.start({ hideControl: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.messageBoxes.length, 1);
  assert.equal(h.messageBoxes[0].parent, undefined, '只有一个 options 参数的 unparented 对话框');
  assert.equal(win.isVisible(), false, '对话框 pending 时旧窗已收起，不会盖住提示');
  assert.equal(win.destroyed, false, '只 hide，不 destroy/reload/改 bounds');
  assert.equal(win.loads.length, 1, '不 reload');
  h.resolveMessageBox(0);
  await pending;
  const current = h.getCurrent();
  assert.equal(current.win, win, '还是同一张选区窗');
  assert.equal(win.isVisible(), true, '保留后把原窗放回来');
  assert.equal(current.longToken, 'long-token', '长图 token 不丢');
  assert.equal(current.longImage !== undefined, true);
  assert.equal(current.editDocument?.token, 'edit-token', '编辑文档不丢');
  assert.equal(h.messageBoxes.length, 1, '只问一次');
  assert.equal(win.destroyed, false);
  assert.equal(h.statuses.at(-1).message, '已保留当前截图数据，没有重新截图。');
});

test('确认框抛错也只保留并还回同一窗，不重开', async () => {
  const h = await selectingSession({ messageBoxFails: true });
  const win = h.windows[0];
  h.setLongOutput();
  h.setProbe('blocked');
  await h.api.start({ hideControl: false });
  assert.equal(h.messageBoxes.length, 1);
  assert.equal(win.isVisible(), true, '对话框失败也要把原窗放回来');
  assert.equal(h.getCurrent().win, win);
  assert.equal(h.getCurrent().longToken, 'long-token');
  assert.equal(h.windows.length, 1);
  assert.equal(h.api.isActive(), true);
});

test('确认放弃：旧窗收起后不再闪回，也不 show 旧控制页，只新建一次', async () => {
  const h = await selectingSession({ controlVisible: true });
  const old = h.windows[0];
  const showsBefore = old.shows;
  h.setProbe('blocked');
  h.setMessageBoxResponse(1);
  const pending = h.api.start({ hideControl: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(old.isVisible(), false, '问的时候旧窗处于收起');
  const showsWhileAsking = old.shows;
  assert.equal(showsWhileAsking, showsBefore + 1, '只多一次唤回时的 show，再被 hide 收起');
  await pending;
  assert.equal(old.destroyed, true);
  assert.equal(old.shows, showsWhileAsking, 'response 1 时不再把旧窗 show 回去');
  assert.equal(h.control.shows, 0, '不先恢复旧控制页');
  assert.equal(h.windows.length, 2, '只新建一次');
  assert.equal(h.api.isActive(), true);
  assert.equal(h.getCurrent().win, h.windows[1]);
});

test('对话框在等时取消 / 转 saving：旧 finally 不再 show 旧窗，也不干扰新会话', async () => {
  const cancelled = await selectingSession({ deferMessageBox: true });
  const cancelledWin = cancelled.windows[0];
  cancelled.setProbe('blocked');
  const pendingCancel = cancelled.api.start({ hideControl: false });
  await new Promise(resolve => setImmediate(resolve));
  cancelled.api.cancel();
  cancelled.resolveMessageBox(0);
  await pendingCancel;
  assert.equal(cancelledWin.isVisible(), false, '取消后不会把旧窗放回屏幕');
  assert.equal(cancelled.api.isActive(), false);

  const saving = await selectingSession({ deferMessageBox: true });
  const savingWin = saving.windows[0];
  saving.setProbe('blocked');
  const pendingSave = saving.api.start({ hideControl: false });
  await new Promise(resolve => setImmediate(resolve));
  saving.setPhase('saving');
  saving.resolveMessageBox(0);
  await pendingSave;
  assert.equal(savingWin.isVisible(), false, '转 saving 后旧 finally 不重新 show');
  assert.equal(saving.getCurrent().phase, 'saving');
  assert.equal(saving.api.isActive(), true);
  assert.equal(saving.windows.length, 1, '不新开窗');
});

test('对话框失败或未知响应都保留，不重开、不丢图', async () => {
  for (const [label, options] of [['抛错', { messageBoxFails: true }], ['无 response', { messageBoxResponse: undefined }]]) {
    const h = await selectingSession(options);
    h.setProbe('blocked');
    await h.api.start({ hideControl: false });
    assert.equal(h.messageBoxes.length, 1, label);
    assert.equal(h.api.isActive(), true, `${label}：会话保留`);
    assert.equal(h.windows.length, 1, `${label}：不重开`);
    assert.match(h.statuses.at(-1).message, /已保留当前截图数据/, label);
  }
});

test('连按 F1 只做一次探针、只弹一个 dialog，也只重开一个新会话', async () => {
  const h = await selectingSession({ deferMessageBox: true });
  h.setProbe('blocked');
  h.setMessageBoxResponse(1);
  const first = h.api.start({ hideControl: false });
  const second = h.api.start({ hideControl: false });
  await new Promise(resolve => setImmediate(resolve));
  h.resolveMessageBox(1);
  await Promise.all([first, second]);
  assert.equal(h.probeCalls.length, 1, '只探一次');
  assert.equal(h.messageBoxes.length, 1, '只弹一个 dialog');
  assert.equal(h.windows.length, 2, '只多一个重开的新会话');
  assert.equal(h.api.isActive(), true);
});

test('探针等待期间取消 / 转 saving，旧回包一律不再动会话', async () => {
  const cancelled = await selectingSession({ probeMode: 'defer' });
  const pendingCancel = cancelled.api.start({ hideControl: false });
  await new Promise(resolve => setImmediate(resolve));
  cancelled.api.cancel();
  cancelled.resolveProbe({ ready: false });
  await pendingCancel;
  assert.equal(cancelled.messageBoxes.length, 0, '已取消的会话不再弹窗');
  assert.equal(cancelled.api.isActive(), false);

  const saving = await selectingSession({ probeMode: 'defer' });
  const pendingSave = saving.api.start({ hideControl: false });
  await new Promise(resolve => setImmediate(resolve));
  saving.setPhase('saving');
  saving.resolveProbe({ ready: false });
  await pendingSave;
  assert.equal(saving.messageBoxes.length, 0, '保存中不弹放弃框');
  assert.equal(saving.api.isActive(), true);
  assert.equal(saving.getCurrent().phase, 'saving');
});

test('生命周期只记固定事件与有限字段，日志抛错也不影响恢复', async () => {
  const rows = [];
  const h = await selectingSession({ onLifecycle: (event, fields) => rows.push({ event, ...fields }) });
  h.setLongOutput();
  h.setProbe('drawable');
  await h.api.start({ hideControl: false });
  h.api.cancel();
  assert.deepEqual(rows.filter(row => row.event !== 'capture-timing').map(row => row.event),
    ['capture-request', 'capture-request', 'active-branch', 'restore-attempt', 'restore-result', 'capture-end'], '每次请求与唤回都各记一条');
  const timings = rows.filter(row => row.event === 'capture-timing');
  assert.equal(timings.length, 1, '上屏时只记一条耗时');
  assert.equal(timings[0].mode, 'single');
  assert.ok(Number.isInteger(timings[0].shownMs) && timings[0].shownMs >= 0, '上屏时刻要记整数毫秒');
  for (const key of ['geometryMs', 'snapshotMs', 'windowMs']) {
    assert.ok(timings[0][key] === undefined || (Number.isInteger(timings[0][key]) && timings[0][key] >= 0), `${key} 只能是整数毫秒`);
  }
  assert.deepEqual(rows.find(row => row.event === 'active-branch'), { event: 'active-branch', mode: 'single', phase: 'selecting', action: 'restore' });
  assert.deepEqual({ ...rows.find(row => row.event === 'restore-result'), ageMs: 0 },
    { event: 'restore-result', mode: 'single', probe: 'drawable', action: 'resumed', ageMs: 0 });
  assert.ok(Number.isInteger(rows.find(row => row.event === 'restore-result').ageMs), '旧会话唤回只追加整数毫秒');
  for (const row of rows) for (const key of Object.keys(row)) {
    assert.ok(['event', 'mode', 'phase', 'action', 'probe', 'minimized', 'visible', 'choice', 'hideControl', 'reason', 'focused', 'alwaysOnTop', 'windowEvent', 'limit', 'recoveryLevel',
      'geometryMs', 'snapshotMs', 'windowMs', 'shownMs', 'frameMs', 'fitMs', 'initMs', 'readyMs', 'snapshotAgeMs', 'ageMs',
      'activateMs', 'initReplyMs', 'viewportMs', 'geometryCached', 'preparedSource', 'preparedWindow', 'preparedPage'].includes(key), `留痕不得出现额外字段：${key}`);
  }

  const broken = harness({ onLifecycle: () => { throw new Error('日志不可写'); } });
  await broken.api.start();
  await broken.invoke('shot:ready');
  broken.setProbe('drawable');
  await broken.api.start({ hideControl: false });
  assert.equal(broken.windows.length, 1);
  assert.equal(broken.statuses.at(-1).message, '已尝试唤回当前截图，未清除内容。');
});

// —— 选区窗状态诊断：只留痕，不改显示/焦点/透明性/快捷键 ——
// 真实读数、固定事件名、有限字段；focus 回来时只把丢掉的置顶属性恢复回既有设计，不抢焦点。
const selectingWindow = async (options = {}) => {
  const h = harness({ platform: 'win32', controlVisible: false, ...options });
  await h.api.start({ hideControl: false });
  await h.invoke('shot:init');
  await h.invoke('shot:ready');
  return h;
};
const WINDOW_EVENT_LABELS = ['show', 'hide', 'focus', 'blur', 'minimize', 'restore', 'always-on-top-changed'];

// 读状态的 getter 只有真方法且返回布尔才写；所以先拿真夹具跑一遍，再手动补两种读数。
test('选区窗事件留痕：单屏七种事件按真实读数记录，只监听不碰显示与焦点', async () => {
  const rows = [];
  const h = await selectingWindow({ onLifecycle: (event, fields) => rows.push({ event, ...fields }) });
  const win = h.windows[0];
  const before = { shows: win.shows ?? 0, raised: win.raised ?? 0, invalidates: win.invalidates ?? 0,
    loads: win.loads.length, sent: (win.sent ?? []).length, regions: h.nativeRegions.length };
  let focusCalls = 0;
  win.focus = () => { focusCalls++; };
  const events = () => rows.filter(row => row.event === 'selection-window');
  // 夹具没有 isFocused/isAlwaysOnTop：手动补上，验证记的是每次读数而不是固定常量。
  win.isFocused = () => false; win.isAlwaysOnTop = () => true;
  win.emit('blur');
  win.isFocused = () => true;
  win.emit('focus');
  win.isVisible = () => false; win.emit('hide');
  win.emit('minimize');
  win.isVisible = () => true; win.emit('show');
  win.emit('restore');
  win.isAlwaysOnTop = () => false; win.emit('always-on-top-changed', {}, true);
  assert.deepEqual(events().map(row => row.windowEvent), ['blur', 'focus', 'hide', 'minimize', 'show', 'restore', 'always-on-top-changed'],
    '七种事件各一条，顺序不畸');
  assert.deepEqual({ focused: events()[0].focused, alwaysOnTop: events()[0].alwaysOnTop }, { focused: false, alwaysOnTop: true }, 'blur 记当时读数');
  assert.deepEqual({ focused: events()[1].focused, alwaysOnTop: events()[1].alwaysOnTop }, { focused: true, alwaysOnTop: true }, 'focus 后读数跟着变');
  assert.equal(events()[2].visible, false, 'hide 记 isVisible=false');
  assert.equal(events()[4].visible, true, 'show 记 isVisible=true');
  assert.equal(events()[6].alwaysOnTop, false, 'always-on-top-changed 记改后的读数');
  const allowed = new Set(['event', 'mode', 'phase', 'windowEvent', 'visible', 'minimized', 'focused', 'alwaysOnTop']);
  for (const row of events()) {
    assert.equal(row.mode, 'single');
    assert.equal(row.phase, 'selecting');
    assert.deepEqual(Object.keys(row).filter(key => !allowed.has(key)), [], '不留额外字段，也不写原始 event/payload');
  }
  // 只监听：不 show/raise/focus/invalidate、不重载、不重采样、不改会话。
  assert.equal(focusCalls, 0, '事件不调用 focus 抢走外部截图程序焦点');
  assert.equal(win.shows ?? 0, before.shows, '事件不调用 show');
  assert.equal(win.raised ?? 0, before.raised, '事件不调用 moveTop');
  assert.equal(win.invalidates ?? 0, before.invalidates, '事件不调用 invalidate');
  assert.equal(win.loads.length, before.loads, '不重载页面');
  assert.equal((win.sent ?? []).length, before.sent, '不发新消息');
  assert.equal(h.nativeRegions.length, before.regions, '不重新取样');
  assert.equal(h.api.isActive(), true);
  assert.equal(h.windows.length, 1);
  h.api.cancel();
});

test('选区窗事件留痕：跨屏窗口同样七种事件，mode 记 desktop', async () => {
  const rows = [];
  const h = await selectingWindow({ onLifecycle: (event, fields) => rows.push({ event, ...fields }), displays: [
    { id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 800, y: 0, width: 800, height: 600 }, scaleFactor: 1 }] });
  assert.equal(h.windows.length, 1);
  const win = h.windows[0];
  const before = { shows: win.shows ?? 0, raised: win.raised ?? 0, invalidates: win.invalidates ?? 0, regions: h.nativeRegions.length };
  let focusCalls = 0;
  win.focus = () => { focusCalls++; };
  win.isFocused = () => true; win.isAlwaysOnTop = () => true;
  for (const label of WINDOW_EVENT_LABELS) win.emit(label, {}, true);
  const events = rows.filter(row => row.event === 'selection-window');
  assert.deepEqual(events.map(row => row.windowEvent), WINDOW_EVENT_LABELS);
  for (const row of events) assert.equal(row.mode, 'desktop');
  assert.equal(events.at(-1).alwaysOnTop, true);
  assert.equal(focusCalls, 0, '跨屏事件也不抢焦点');
  assert.equal(win.shows ?? 0, before.shows);
  assert.equal(win.raised ?? 0, before.raised);
  assert.equal(win.invalidates ?? 0, before.invalidates);
  assert.equal(h.nativeRegions.length, before.regions + 0, '跨屏事件不触发重新取屏');
  h.api.cancel();
});

test('选区窗事件留痕：取消后、以及换成新会话后的旧窗口事件一律不写', async () => {
  const rows = [];
  const h = await selectingWindow({ onLifecycle: (event, fields) => rows.push({ event, ...fields }) });
  const win = h.windows[0];
  const count = () => rows.filter(row => row.event === 'selection-window').length;
  win.emit('focus');
  assert.equal(count(), 1);
  h.api.cancel();
  assert.equal(h.api.isActive(), false);
  for (const label of WINDOW_EVENT_LABELS) win.emit(label, {}, true);
  assert.equal(count(), 1, '取消后旧窗口的事件不再留痕');
  // 新会话起来之后，旧窗口的迟到事件同样不算。
  await h.api.start({ hideControl: false });
  const fresh = h.windows.at(-1);
  assert.notEqual(fresh, win);
  // 新窗口的主 frame 才是合法发信者：直接用它的 event 驱动，不走绑在首窗上的 invoke。
  const freshEvent = { sender: fresh.webContents, senderFrame: fresh.webContents.mainFrame };
  await h.handlers.get('shot:init')(freshEvent);
  await h.handlers.get('shot:ready')(freshEvent);
  const afterNew = count();
  for (const label of WINDOW_EVENT_LABELS) win.emit(label, {}, true);
  assert.equal(count(), afterNew, '旧窗口迟到事件不串到新会话');
  fresh.emit('focus');
  assert.equal(count(), afterNew + 1, '新窗口自己的事件照常记');
  assert.equal(rows.at(-1).windowEvent, 'focus');
  h.api.cancel();
});

test('选区窗事件留痕：每会话 32 条上限，超限只补一条 selection-window-limit', async () => {
  const rows = [];
  const h = await selectingWindow({ onLifecycle: (event, fields) => rows.push({ event, ...fields }) });
  const win = h.windows[0];
  for (let index = 0; index < 40; index += 1) win.emit('show');
  const events = rows.filter(row => row.event === 'selection-window');
  const limits = rows.filter(row => row.event === 'selection-window-limit');
  assert.equal(events.length, 32, '只留 32 条');
  assert.equal(limits.length, 1, '限额只提示一次');
  assert.equal(limits[0].limit, 32);
  assert.equal(limits[0].windowEvent, 'show', '限额提示记触发它的固定事件名');
  assert.equal(limits[0].mode, 'single');
  win.emit('focus');
  assert.equal(rows.filter(row => row.event === 'selection-window').length, 32, '超限后不再增条');
  assert.equal(rows.filter(row => row.event === 'selection-window-limit').length, 1, '限额提示不重复');
  h.api.cancel();
});

test('选区窗留痕：读状态抛错只省略该字段，日志抛错也不影响唤回', async () => {
  const rows = [];
  const h = await selectingWindow({ onLifecycle: (event, fields) => rows.push({ event, ...fields }) });
  const win = h.windows[0];
  win.isFocused = () => { throw new Error('读不到焦点'); };
  win.isAlwaysOnTop = () => { throw new Error('读不到置顶'); };
  win.emit('focus');
  const row = rows.filter(item => item.event === 'selection-window').at(-1);
  assert.equal(row.windowEvent, 'focus');
  assert.equal('focused' in row, false, '读不到就不写假 false');
  assert.equal('alwaysOnTop' in row, false);
  assert.equal(row.visible, true, '其它字段照常读');
  // 唤回不受诊断读失败影响：探针可用即 resumed，不丢会话。
  h.setProbe('drawable');
  await h.api.start({ hideControl: false });
  assert.equal(h.api.isActive(), true);
  const attempt = rows.filter(item => item.event === 'restore-attempt').at(-1);
  assert.equal(attempt.minimized, false, '旧字段语义不变');
  assert.equal(attempt.visible, true);
  assert.equal('focused' in attempt, false);
  assert.equal('alwaysOnTop' in attempt, false);

  const broken = harness({ platform: 'win32', controlVisible: false, onLifecycle: () => { throw new Error('日志不可写'); } });
  await broken.api.start({ hideControl: false });
  await broken.invoke('shot:init');
  await broken.invoke('shot:ready');
  const bad = broken.windows[0];
  for (const label of WINDOW_EVENT_LABELS) bad.emit(label, {}, true);
  broken.setProbe('drawable');
  await broken.api.start({ hideControl: false });
  assert.equal(broken.api.isActive(), true, '日志写失败不影响窗口与唤回');
  assert.equal(broken.windows.length, 1);
});

// —— 置顶恢复：F2 失焦期间被外部程序降级，focus 回来恢复既有置顶设计 ——
// 用本进程的 getter/setter 夹具模拟：真 getter 为 false 才设，设一次就变 true。
const patchTopmost = (win, initial = true) => {
  const sets = [];
  let topmost = initial, focused = true;
  win.isFocused = () => focused;
  win.isAlwaysOnTop = () => topmost;
  win.setAlwaysOnTop = value => { sets.push(value); topmost = value; };
  return { sets, setFocused: value => { focused = value; }, demote: () => { topmost = false; }, current: () => topmost };
};
const topmostRows = (rows, event) => rows.filter(row => row.event === event);

test('置顶恢复：失焦期间被降级，focus 回来恢复置顶，不重开不重采样不抢焦点', async () => {
  const rows = [];
  const h = await selectingWindow({ onLifecycle: (event, fields) => rows.push({ event, ...fields }) });
  const win = h.windows[0];
  const top = patchTopmost(win, true);
  const session = h.getCurrent();
  const image = session.image, bmp = session.bmpBytes;
  const before = { shows: win.shows ?? 0, raised: win.raised ?? 0, invalidates: win.invalidates ?? 0,
    loads: win.loads.length, sent: (win.sent ?? []).length, regions: h.nativeRegions.length };
  // F2 先失焦：此刻仍置顶，就不该动它。
  top.setFocused(false); win.emit('blur');
  const blurRow = rows.filter(row => row.event === 'selection-window').at(-1);
  assert.equal(blurRow.windowEvent, 'blur');
  assert.equal(blurRow.alwaysOnTop, true, '失焦时仍置顶');
  assert.deepEqual(top.sets, [], '失焦不抢回置顶');
  // 外部程序置顶自己，本窗口属性被降级；然后焦点回来。
  top.demote(); top.setFocused(true); win.emit('focus');
  const focusRow = rows.filter(row => row.event === 'selection-window').at(-1);
  assert.equal(focusRow.windowEvent, 'focus');
  assert.equal(focusRow.alwaysOnTop, false, '先记 focus 原始状态 false');
  assert.deepEqual(top.sets, [true], '只恢复一次，启用值为 true；级别由独立参数测试验证');
  const recovered = topmostRows(rows, 'selection-topmost-recovered').at(-1);
  assert.equal(recovered.mode, 'single');
  assert.equal(recovered.phase, 'selecting');
  assert.equal(recovered.alwaysOnTop, true, '日志可看 false→true');
  assert.deepEqual(Object.keys(recovered).filter(key => !['event', 'mode', 'phase', 'visible', 'minimized', 'focused', 'alwaysOnTop', 'recoveryLevel'].includes(key)), [],
    '恢复事件只包含固定诊断字段');
  assert.equal(recovered.recoveryLevel, 'pop-up-menu', 'Windows 上走显式 pop-up-menu');
  // 同会话、同图、同采样，且不 show/focus/moveTop/invalidate。
  assert.equal(h.getCurrent(), session);
  assert.equal(session.image, image);
  assert.equal(session.bmpBytes, bmp);
  assert.equal(h.api.isActive(), true);
  assert.equal(h.windows.length, 1);
  assert.equal(win.loads.length, before.loads);
  assert.equal((win.sent ?? []).length, before.sent);
  assert.equal(h.nativeRegions.length, before.regions);
  assert.equal(win.shows ?? 0, before.shows, '不 show');
  assert.equal(win.raised ?? 0, before.raised, '不 moveTop');
  assert.equal(win.invalidates ?? 0, before.invalidates, '不 invalidate');
  // 再 focus 一次：真实 getter 已是 true，不重复设置。
  win.emit('focus');
  assert.deepEqual(top.sets, [true], '已置顶不重复调用 setAlwaysOnTop');
  assert.equal(topmostRows(rows, 'selection-topmost-recovered').length, 1, '不重复记恢复');
  h.api.cancel();
});

test('置顶恢复：跨屏窗口同样恢复，mode 记 desktop', async () => {
  const rows = [];
  const h = await selectingWindow({ onLifecycle: (event, fields) => rows.push({ event, ...fields }), displays: [
    { id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 800, y: 0, width: 800, height: 600 }, scaleFactor: 1 }] });
  const win = h.windows[0];
  const top = patchTopmost(win, true);
  const session = h.getCurrent();
  const image = session.image;
  const regions = h.nativeRegions.length;
  top.setFocused(false); win.emit('blur');
  top.demote(); top.setFocused(true); win.emit('focus');
  assert.deepEqual(top.sets, [true]);
  const recovered = topmostRows(rows, 'selection-topmost-recovered').at(-1);
  assert.equal(recovered.mode, 'desktop');
  assert.equal(recovered.alwaysOnTop, true);
  assert.equal(h.getCurrent(), session);
  assert.equal(session.image, image);
  assert.equal(h.nativeRegions.length, regions, '不重新取屏');
  assert.equal(h.windows.length, 1);
  h.api.cancel();
});

test('置顶恢复不受 32 条诊断预算限制', async () => {
  const rows = [];
  const h = await selectingWindow({ onLifecycle: (event, fields) => rows.push({ event, ...fields }) });
  const win = h.windows[0];
  const top = patchTopmost(win, true);
  for (let index = 0; index < 32; index += 1) win.emit('show');
  assert.equal(rows.filter(row => row.event === 'selection-window').length, 32, '预算已用尽');
  top.demote(); win.emit('focus');
  assert.deepEqual(top.sets, [true], '诊断预算满了仍然恢复置顶');
  assert.equal(topmostRows(rows, 'selection-topmost-recovered').length, 1);
  assert.equal(rows.filter(row => row.event === 'selection-window-limit').length, 1);
  h.api.cancel();
});

test('置顶恢复失败：只记固定事件，不影响会话与唤回', async () => {
  const rows = [];
  const h = await selectingWindow({ onLifecycle: (event, fields) => rows.push({ event, ...fields }) });
  const win = h.windows[0];
  const top = patchTopmost(win, false);
  win.setAlwaysOnTop = () => { throw new Error('无法设置置顶'); };
  win.emit('focus');
  const failed = topmostRows(rows, 'selection-topmost-recovery-failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].mode, 'single');
  assert.equal(failed[0].phase, 'selecting');
  assert.equal(failed[0].alwaysOnTop, false, '失败事件带读回状态');
  assert.equal(failed[0].recoveryLevel, 'pop-up-menu', '失败事件标明走了 Windows 候选级别');
  assert.deepEqual(Object.keys(failed[0]).filter(key => !['event', 'mode', 'phase', 'visible', 'minimized', 'focused', 'alwaysOnTop', 'recoveryLevel'].includes(key)), [],
    '失败事件只包含固定诊断字段，不写原始错误');
  assert.equal(topmostRows(rows, 'selection-topmost-recovered').length, 0, '失败不记成功');
  assert.equal(h.api.isActive(), true, '会话不受影响');
  h.setProbe('drawable');
  await h.api.start({ hideControl: false });
  assert.equal(h.api.isActive(), true, 'F1 唤回照常');
  assert.equal(h.windows.length, 1);
  h.api.cancel();
});

test('置顶恢复：setter 是 void，静默无效或读不回状态都只能记失败', async () => {
  const rows = [];
  const h = await selectingWindow({ onLifecycle: (event, fields) => rows.push({ event, ...fields }) });
  const win = h.windows[0];
  const session = h.getCurrent();
  const image = session.image;
  const sets = [];
  let topmost = false, afterSet = false, mode = 'silent';
  win.isFocused = () => true;
  win.isAlwaysOnTop = () => {
    if (afterSet && mode === 'throws') throw new Error('读不回来');
    if (afterSet && mode === 'unknown') return 'true';
    return topmost;
  };
  win.setAlwaysOnTop = value => { sets.push(value); afterSet = true; if (mode === 'silent') return; topmost = true; };
  const reset = () => { afterSet = false; topmost = false; sets.length = 0; };
  // 1) 静默无效：set 调用过、真 getter 仍是 false。
  win.emit('focus');
  assert.deepEqual(sets, [true], '确实试过恢复');
  assert.equal(topmostRows(rows, 'selection-topmost-recovered').length, 0, 'set 返回 void 不能据此报成功');
  const silent = topmostRows(rows, 'selection-topmost-recovery-failed').at(-1);
  assert.equal(silent.alwaysOnTop, false, '失败事件带同一组布尔：读回仍 false');
  assert.equal(silent.visible, true);
  assert.equal(silent.focused, true);
  // 2) set 之后读回抛错：状态未知，同样不冒报成功。
  reset(); mode = 'throws';
  win.emit('focus');
  assert.deepEqual(sets, [true], '调用前的读状态正常，所以确实试过恢复');
  const unreadable = topmostRows(rows, 'selection-topmost-recovery-failed').at(-1);
  assert.equal(topmostRows(rows, 'selection-topmost-recovery-failed').length, 2, '第二次也是失败');
  assert.equal('alwaysOnTop' in unreadable, false, '读不到的字段省略，不填假值');
  assert.equal(topmostRows(rows, 'selection-topmost-recovered').length, 0);
  // 3) set 之后读回非布尔：同样算未知。
  reset(); mode = 'unknown';
  win.emit('focus');
  const unknown = topmostRows(rows, 'selection-topmost-recovery-failed').at(-1);
  assert.equal(topmostRows(rows, 'selection-topmost-recovery-failed').length, 3);
  assert.equal('alwaysOnTop' in unknown, false, '非布尔不当 true');
  assert.equal(topmostRows(rows, 'selection-topmost-recovered').length, 0);
  // 会话、图与采样都没被这些失败影响。
  assert.equal(h.api.isActive(), true);
  assert.equal(h.getCurrent(), session);
  assert.equal(session.image, image);
  assert.equal(h.windows.length, 1);
  assert.equal(h.nativeRegions.length, 1, '没因失败重采样');
  h.api.cancel();
});

test('置顶恢复的拒绝条件：未知读数/失焦/隐藏/最小化/非 selecting/已失效都不设', async () => {
  const rows = [];
  const h = await selectingWindow({ onLifecycle: (event, fields) => rows.push({ event, ...fields }) });
  const win = h.windows[0];
  const sets = [];
  let topmost = false, focused = true, visible = true, minimized = false;
  win.isFocused = () => focused; win.isAlwaysOnTop = () => topmost;
  win.isVisible = () => visible; win.isMinimized = () => minimized;
  win.setAlwaysOnTop = value => { sets.push(value); topmost = value; };
  const failures = () => topmostRows(rows, 'selection-topmost-recovery-failed').length;
  // 缺 getter：直接跳过，不当 false，也不刷失败日志。
  delete win.isFocused;
  win.emit('focus');
  assert.deepEqual(sets, [], '缺 isFocused 不恢复');
  assert.equal(failures(), 0, '缺方法不刷失败日志');
  win.isFocused = () => focused;
  focused = false; win.emit('focus'); assert.deepEqual(sets, [], '失焦不恢复');
  focused = 'yes'; win.emit('focus'); assert.deepEqual(sets, [], '未知读数不当 false，也不恢复');
  focused = true;
  visible = false; win.emit('focus'); assert.deepEqual(sets, [], '隐藏不恢复');
  visible = true; minimized = true; win.emit('focus'); assert.deepEqual(sets, [], '最小化不恢复');
  minimized = false;
  h.setPhase('saving'); win.emit('focus'); assert.deepEqual(sets, [], '非 selecting 不恢复');
  h.setPhase('selecting');
  topmost = true; win.emit('focus'); assert.deepEqual(sets, [], '已经置顶不设置');
  assert.equal(failures(), 0);
  assert.equal(topmostRows(rows, 'selection-topmost-recovered').length, 0);
  // 条件全满足才恢复一次。
  topmost = false; win.emit('focus');
  assert.deepEqual(sets, [true]);
  assert.equal(topmostRows(rows, 'selection-topmost-recovered').length, 1);
  // 会话失效后旧窗口不再恢复。
  sets.length = 0; topmost = false;
  h.api.cancel();
  win.emit('focus');
  assert.deepEqual(sets, [], '取消后的旧窗口不恢复');
  assert.equal(failures(), 0);
});

test('置顶恢复的同步回调结束会话或切换阶段后，不记录旧会话的恢复结果', async () => {
  for (const action of ['cancel', 'phase']) {
    const rows = [];
    const h = await selectingWindow({ onLifecycle: (event, fields) => rows.push({ event, ...fields }) });
    const win = h.windows[0];
    const session = h.getCurrent();
    let topmost = false;
    win.isFocused = () => true;
    win.isAlwaysOnTop = () => topmost;
    win.setAlwaysOnTop = () => {
      topmost = true;
      if (action === 'cancel') h.api.cancel();
      else session.phase = 'saving';
    };
    win.emit('focus');
    assert.equal(topmostRows(rows, 'selection-topmost-recovered').length, 0, action);
    assert.equal(topmostRows(rows, 'selection-topmost-recovery-failed').length, 0, action);
    if (h.getCurrent() === session) session.phase = 'selecting';
    h.api.cancel();
  }
});

// 置顶恢复用的 level：Windows 显式 pop-up-menu，其它平台保持默认调用形状。
test('置顶恢复的 level：Windows 传 pop-up-menu，非 Windows 仍不传 level', async () => {
  const rows = [];
  const h = await selectingWindow({ onLifecycle: (event, fields) => rows.push({ event, ...fields }) });
  const win = h.windows[0];
  const calls = [];
  let topmost = false;
  win.isFocused = () => true;
  win.isAlwaysOnTop = () => topmost;
  win.setAlwaysOnTop = (...args) => { calls.push(args); topmost = true; };
  win.emit('focus');
  assert.deepEqual(calls, [[true, 'pop-up-menu']], 'Windows 只调一次且显式传文档级别');
  const recovered = topmostRows(rows, 'selection-topmost-recovered').at(-1);
  assert.equal(recovered.recoveryLevel, 'pop-up-menu');
  assert.equal(recovered.alwaysOnTop, true, '读回 true 才记成功');
  h.api.cancel();

  const other = [];
  const mac = await selectingSession({ onLifecycle: (event, fields) => other.push({ event, ...fields }) });
  const macWin = mac.windows[0];
  const macCalls = [];
  let macTop = false;
  macWin.isFocused = () => true;
  macWin.isAlwaysOnTop = () => macTop;
  macWin.setAlwaysOnTop = (...args) => { macCalls.push(args); macTop = true; };
  macWin.emit('focus');
  assert.deepEqual(macCalls, [[true]], '非 Windows 保持原来的单参数调用');
  const macRecovered = topmostRows(other, 'selection-topmost-recovered').at(-1);
  assert.equal(macRecovered.recoveryLevel, 'floating', '日志仍标明默认 floating 等级');
  assert.equal(macRecovered.alwaysOnTop, true);
  mac.api.cancel();
});

test('模型对照（源码分支模拟，不是现场重现）：floating 走任务栏参照会清掉原生位，pop-up-menu 不进这一步', async () => {
  const rows = [];
  const h = await selectingWindow({ onLifecycle: (event, fields) => rows.push({ event, ...fields }) });
  const win = h.windows[0];
  const calls = [];
  // 简模型：两个 level 同映射 kFloatingWindow；但默认/floating 之后还会按“非 topmost 参照窗”重排，
  // 本模型里那一步会把原生置顶位抹掉；pop-up-menu 不进该分支。
  const model = { topmost: true };
  win.isFocused = () => true;
  win.isAlwaysOnTop = () => model.topmost;
  win.setAlwaysOnTop = (...args) => {
    calls.push(args);
    const [value, level] = args;
    if (value !== true) { model.topmost = false; return; }
    model.topmost = level === undefined || level === 'floating' ? false : true;
  };
  // 先单独验证模型本身：两种 level 的差别就是这一步。
  win.setAlwaysOnTop(true, 'floating');
  assert.equal(model.topmost, false, '模型里 floating 会被任务栏参照重排清掉');
  win.setAlwaysOnTop(true, 'pop-up-menu');
  assert.equal(model.topmost, true, '模型里 pop-up-menu 不经过该分支');
  // 现场形态：外部降级后，产品走 Windows 分支 → 读回 true。
  model.topmost = false;
  calls.length = 0;
  win.emit('focus');
  assert.deepEqual(calls, [[true, 'pop-up-menu']], '产品只按候选 level 调一次');
  assert.equal(model.topmost, true);
  const recovered = topmostRows(rows, 'selection-topmost-recovered').at(-1);
  assert.equal(recovered.recoveryLevel, 'pop-up-menu');
  assert.equal(recovered.alwaysOnTop, true, '模型里走 pop-up-menu 能读回 true');
  // 若读回不是 true（模拟位被抹掉），只能记失败、不冒报成功。
  model.topmost = false;
  win.setAlwaysOnTop = (...args) => { calls.push(args); model.topmost = false; };
  win.emit('focus');
  assert.equal(topmostRows(rows, 'selection-topmost-recovered').length, 1, '失败的那次不再新增成功记录');
  const failed = topmostRows(rows, 'selection-topmost-recovery-failed').at(-1);
  assert.equal(failed.recoveryLevel, 'pop-up-menu');
  assert.equal(failed.alwaysOnTop, false);
  h.api.cancel();
});

// —— 嵌套截图（最多 3 层）：F1 在已有选区页上再截当前画面 ——
// 统一用 win32 单屏夹具：父窗在 windows[0]，子窗依次往后；IPC 按各自 main frame 发，allowed 照旧校验。
const readyOn = async (h, win) => { await h.invokeOn(win, 'shot:init'); await h.invokeOn(win, 'shot:ready'); return win; };
const nestedStart = async (h) => {
  const before = h.windows.length;
  await h.api.start({ hideControl: false, nested: true });
  return h.windows[before];
};

test('嵌套：父窗取图前不隐藏，子帧是新取的图，子取消后回原父页且文档/抓图不动', async () => {
  const h = await selectingWindow();
  const parent = h.getCurrent();
  const parentWin = h.windows[0];
  h.setLongOutput();
  const parentImage = parent.image, parentBmp = parent.bmpBytes, parentLong = parent.longImage;
  const regions = h.nativeRegions.length;
  assert.equal(parentWin.isVisible(), true);

  const childWin = await nestedStart(h);
  const child = h.getCurrent();
  assert.ok(childWin && childWin !== parentWin, '开了子窗');
  assert.equal(child.nested, true);
  assert.notEqual(child, parent);
  assert.equal(parentWin.isVisible(), true, '新帧还没 ready：父窗必须仍可见（子图里要有父页）');
  assert.notEqual(child.image, parentImage, '子图是重新采集的帧，不是父原图');
  assert.notEqual(child.bmpBytes, parentBmp, '不复用父的位图字节');
  assert.equal(h.nativeRegions.length, regions + 1, '子层真的重新取了帧');
  // 父页 IPC 已被 allowed 拒绕：唯一可操作会话是子。
  await assert.rejects(h.invoke('shot:init'), /无效选区窗口|失效/);

  await readyOn(h, childWin);
  assert.equal(h.getCurrent().phase, 'selecting');
  assert.equal(parentWin.isVisible(), false, '子窗上屏后才隐藏父窗');
  assert.equal(childWin.isVisible(), true);

  await h.invokeOn(childWin, 'shot:cancel', 'escape-key');
  assert.equal(h.api.isActive(), true);
  assert.equal(h.getCurrent(), parent, '子取消回到同一父会话');
  assert.equal(parent.image, parentImage, '父图没被重采');
  assert.equal(parent.bmpBytes, parentBmp);
  assert.equal(parent.longImage, parentLong, '父的长图/文档引用原样保留');
  assert.equal(parentWin.loads.length, 1, '父页没有重新 loadFile');
  assert.equal(parentWin.isVisible(), true, '父窗回到可见');
  assert.equal(childWin.isDestroyed(), true, '子窗已收回');
  assert.equal(h.getCurrent().phase, 'selecting');
});

for (const action of ['copy', 'save', 'save-quick']) test(`嵌套：子提交成功回到原父窗口 ${action}`, async () => {
  const h = await selectingWindow();
  const parent = h.getCurrent(), parentWin = h.windows[0];
  const childWin = await nestedStart(h);
  await readyOn(h, childWin);
  const result = await h.invokeOn(childWin, 'shot:commit', { x: 0, y: 0, width: 4, height: 2 }, action);
  assert.equal(result.ok, true);
  assert.equal(h.copied.length, action === 'copy' ? 1 : 0);
  assert.equal(h.writes.length, action === 'copy' ? 0 : 1);
  assert.equal(h.getCurrent(), parent);
  assert.equal(parentWin.isVisible(), true);
  assert.equal(parentWin.loads.length, 1);
  assert.equal(childWin.isDestroyed(), true);
});

for (const [action, options] of [['save', { cancelSave: true }], ['save-quick', { saveFails: true }]]) {
  test(`嵌套：另存取消或保存失败保留子图和父图 ${action}`, async () => {
    const h = await selectingWindow(options);
    const parent = h.getCurrent(), parentWin = h.windows[0], parentImage = parent.image;
    const childWin = await nestedStart(h);
    await readyOn(h, childWin);
    const child = h.getCurrent(), childImage = child.image;
    const result = await h.invokeOn(childWin, 'shot:commit', { x: 0, y: 0, width: 4, height: 2 }, action);
    assert.equal(result.ok, false);
    assert.equal(h.getCurrent(), child);
    assert.equal(child.phase, 'selecting');
    assert.equal(child.image, childImage);
    assert.equal(childWin.isVisible(), true);
    assert.equal(parentWin.isVisible(), false);
    assert.equal(parent.image, parentImage);
    assert.equal(h.writes.length, 0);
    assert.equal(h.copied.length, 0);
    await h.invokeOn(childWin, 'shot:cancel', 'escape-key');
    assert.equal(h.getCurrent(), parent);
    assert.equal(parentWin.isVisible(), true);
  });
}

test('嵌套：最多三层，第四层只提示不改会话', async () => {
  const h = await selectingWindow();
  const first = h.getCurrent();
  const secondWin = await nestedStart(h);
  await readyOn(h, secondWin);
  const second = h.getCurrent();
  const thirdWin = await nestedStart(h);
  await readyOn(h, thirdWin);
  const third = h.getCurrent();
  assert.equal(third.nested, true);
  assert.equal(h.windows.length, 3, '三层各一扇窗');
  assert.equal(secondWin.isVisible(), false, '上一层已隐藏');
  const windowsBefore = h.windows.length;
  await h.api.start({ hideControl: false, nested: true });
  assert.equal(h.windows.length, windowsBefore, '到限不新开窗');
  assert.equal(h.getCurrent(), third, '当前层不动');
  assert.equal(thirdWin.isDestroyed(), false);
  assert.match(h.statuses.at(-1).message, /最多叠 3 层/);
  // 逐层退回：三层 → 二层 → 一层
  await h.invokeOn(thirdWin, 'shot:cancel', 'escape-key');
  assert.equal(h.getCurrent(), second, '退回到第二层');
  assert.equal(secondWin.isVisible(), true);
  await h.invokeOn(secondWin, 'shot:cancel', 'escape-key');
  assert.equal(h.getCurrent(), first, '退回到最底层父会话');
  assert.equal(h.windows[0].isVisible(), true);
  assert.equal(h.api.isActive(), true);
});

test('嵌套：准备中连按不双开，保存/长截等阶段照旧报忙', async () => {
  const h = await selectingWindow();
  const parent = h.getCurrent();
  const pending = h.api.start({ hideControl: false, nested: true });
  await new Promise(resolve => setImmediate(resolve));
  const count = h.windows.length;
  await h.api.start({ hideControl: false, nested: true });
  assert.equal(h.windows.length, count, '准备中不新开第二层');
  assert.match(h.statuses.at(-1).message, /准备中/);
  await pending;
  const childWin = h.windows.at(-1);
  await readyOn(h, childWin);
  h.setPhase('saving');
  const before = h.windows.length;
  await h.api.start({ hideControl: false, nested: true });
  assert.equal(h.windows.length, before, '保存中不叠加');
  assert.equal(h.getCurrent().phase, 'saving');
  assert.match(h.statuses.at(-1).message, /正在保存|在进行|稍后/);
  h.setPhase('selecting');
  await h.invokeOn(childWin, 'shot:cancel', 'escape-key');
  assert.equal(h.getCurrent(), parent);
});

test('嵌套：加载/取帧失败与超时都把父窗恢复回来，不重建父页', async () => {
  const h = await selectingWindow();
  const parent = h.getCurrent(), parentWin = h.windows[0];
  const loads = parentWin.loads.length;
  h.setFitMode('reject');
  await h.api.start({ hideControl: false, nested: true });
  assert.equal(h.getCurrent(), parent, '新层创建失败就回父');
  assert.equal(h.api.isActive(), true);
  assert.equal(h.windows.at(-1).isDestroyed(), true, '失败的子窗已收回');
  assert.equal(parentWin.loads.length, loads, '父页没有重新加载');
  assert.equal(parentWin.isVisible(), true);
  h.setFitMode('ok');
  // 超时：子层卡在准备阶段，看门狗收掉子层并回父。
  const pending = h.api.start({ hideControl: false, nested: true });
  await new Promise(resolve => setImmediate(resolve));
  h.fireTimer(15000);
  await pending;
  assert.equal(h.getCurrent(), parent, '超时也回父');
  assert.equal(h.api.isActive(), true);
  assert.equal(parentWin.isVisible(), true);
});

test('嵌套：父窗关闭/渲染消失只标失效，子继续，子结束跳过失效父', async () => {
  const h = await selectingWindow();
  const parent = h.getCurrent(), parentWin = h.windows[0];
  const childWin = await nestedStart(h);
  await readyOn(h, childWin);
  parentWin.destroy();
  assert.equal(h.getCurrent().phase, 'selecting', '子会话继续');
  assert.equal(childWin.isDestroyed(), false);
  const result = await h.invokeOn(childWin, 'shot:commit', { x: 0, y: 0, width: 4, height: 2 }, 'copy');
  assert.equal(result.ok, true);
  assert.equal(h.api.isActive(), false, '失效父不再恢复；整组结束');
  assert.equal(h.getCurrent(), undefined);
});

test('嵌套：逐层释放无残留不闪回，诊断不因子层结束而误结束整组', async () => {
  const ends = [];
  const h = await selectingWindow({ diagnostics: { record: () => {}, state: () => ({ recording: false }), end: reason => ends.push(reason) } });
  const first = h.getCurrent();
  const second = await nestedStart(h);
  await readyOn(h, second);
  const third = await nestedStart(h);
  await readyOn(h, third);
  await h.invokeOn(third, 'shot:cancel', 'escape-key');
  assert.deepEqual(ends, [], '子层结束不结束整组诊断');
  assert.equal(h.getCurrent().nested, true);
  h.api.dispose();
  assert.equal(h.api.isActive(), false);
  assert.equal(h.windows.every(win => win.isDestroyed()), true, '全部层都释放');
  assert.equal(h.control.shows, 0, '退出不弹设置页');
  assert.deepEqual(ends, ['app-quit'], '只有退出才结束诊断');
});

test('嵌套：新帧+保留父图超 36M 预算时不取帧，直接回父', async () => {
  const h = await selectingWindow();
  const parent = h.getCurrent(), parentWin = h.windows[0];
  // 父图报 6000×6000 = 36M，再加子帧必超。
  parent.image = { getSize: () => ({ width: 6000, height: 6000 }) };
  const regions = h.nativeRegions.length;
  await h.api.start({ hideControl: false, nested: true });
  assert.equal(h.nativeRegions.length, regions, '超预算不开始采集、不分配更大图');
  assert.equal(h.getCurrent(), parent);
  assert.match(h.statuses.at(-1).message, /3600 万像素/);
  assert.equal(h.windows.at(-1).isDestroyed(), true, '子窗已收回');
  assert.equal(parentWin.isVisible(), true);
});

test('嵌套：跨屏同样支持，子取消回跨屏父会话', async () => {
  const h = await selectingWindow({ displays: [
    { id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 800, y: 0, width: 800, height: 600 }, scaleFactor: 1 }] });
  const parent = h.getCurrent();
  assert.equal(parent.mode, 'desktop');
  const childWin = await nestedStart(h);
  await readyOn(h, childWin);
  assert.equal(h.getCurrent().mode, 'desktop');
  assert.equal(h.getCurrent().nested, true);
  await h.invokeOn(childWin, 'shot:cancel', 'escape-key');
  assert.equal(h.getCurrent(), parent);
  assert.equal(parent.win.isVisible(), true);
});

test('嵌套：默认 start（不带 nested）保持旧唤回语义，不叠层', async () => {
  const h = await selectingWindow();
  const parent = h.getCurrent();
  h.setProbe('drawable');
  await h.api.start({ hideControl: false });
  assert.equal(h.windows.length, 1, '不新开窗');
  assert.equal(h.getCurrent(), parent);
  assert.equal(parent.win.isVisible(), true);
});

test('嵌套：子准备中父窗收到 Esc 会撤掉子准备并回到父页，不落到父编辑器', async () => {
  const h = await selectingWindow();
  const parent = h.getCurrent();
  const parentWin = h.windows[0];
  h.setLongOutput(); // 父页有长图/编辑态：旧行为会把这个 Esc 直接放给父 renderer
  const longImage = parent.longImage;
  const pending = h.api.start({ hideControl: false, nested: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(h.getCurrent().phase, 'selecting', '子还在准备中');
  assert.equal(parentWin.isVisible(), true, '准备期间父窗仍可见');
  let prevented = 0;
  parentWin.webContents.emit('before-input-event', { preventDefault: () => { prevented += 1; } },
    { key: 'Escape', type: 'keyDown', isAutoRepeat: false });
  assert.equal(prevented, 1, 'Esc 被拦下，不交给父页 renderer');
  assert.equal(h.getCurrent(), parent, '回到父会话');
  assert.equal(parentWin.isVisible(), true, '父窗继续可见');
  assert.equal(parent.longImage, longImage, '父的长图/编辑态没被动过');
  assert.equal(parent.phase, 'selecting');
  assert.match(h.statuses.at(-1).message, /已取消这次叠加截图/);
  await pending;
  assert.equal(h.api.isActive(), true);
});

test('嵌套：子已就绪后隐藏父窗收到 Esc 只拦下，不动任何一层', async () => {
  const h = await selectingWindow();
  const parent = h.getCurrent(), parentWin = h.windows[0];
  const childWin = await nestedStart(h);
  await readyOn(h, childWin);
  const child = h.getCurrent();
  const showsBefore = parentWin.shows;
  let prevented = 0;
  parentWin.webContents.emit('before-input-event', { preventDefault: () => { prevented += 1; } },
    { key: 'Escape', type: 'keyDown', isAutoRepeat: false });
  assert.equal(prevented, 1, '隐藏父窗的 Esc 被拦下');
  assert.equal(h.getCurrent(), child, '子会话不受影响');
  assert.equal(child.phase, 'selecting');
  assert.equal(parentWin.isVisible(), false, '父窗不会被唤起');
  assert.equal(parentWin.shows, showsBefore, '父窗没有重新 show');
  assert.equal(childWin.isDestroyed(), false);
});

test('嵌套：子准备期间父页 IPC 仍被 allowed 拒绕', async () => {
  const h = await selectingWindow();
  const pending = h.api.start({ hideControl: false, nested: true });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(h.invoke('shot:init'), /无效选区窗口/);
  await assert.rejects(h.invoke('shot:ready'), /无效选区窗口/);
  await assert.rejects(h.invoke('shot:commit', { x: 0, y: 0, width: 4, height: 2 }, 'copy'), /无效截图请求/);
  await pending;
  assert.equal(h.copied.length, 0, '父页发起不了任何交付');
});

test('嵌套：父在采帧期间消失，新帧作废并回滚到最近可用祖先', async () => {
  const h = await selectingWindow();
  const first = h.getCurrent(), firstWin = h.windows[0];
  const secondWin = await nestedStart(h);
  await readyOn(h, secondWin);
  const second = h.getCurrent();
  // 三层：第二个父（中间层）在子层采帧期间消失。
  h.setDeferSnapshot(true);
  const pending = h.api.start({ hideControl: false, nested: true });
  await new Promise(resolve => setImmediate(resolve));
  const thirdWin = h.windows.at(-1);
  secondWin.destroy();
  h.resolveSnapshot();
  await pending;
  assert.equal(h.getCurrent(), first, '回滚到最近可用祖先');
  assert.equal(thirdWin.isDestroyed(), true, '作废的子层已收回');
  assert.equal(second.invalid, true, '中间层已标失效');
  assert.equal(firstWin.isVisible(), true);
  assert.equal(h.api.isActive(), true);
});

test('嵌套：父在 ready 切换点前消失，子层不上屏并回滚', async () => {
  const h = await selectingWindow();
  const first = h.getCurrent(), firstWin = h.windows[0];
  const secondWin = await nestedStart(h);
  await readyOn(h, secondWin);
  const second = h.getCurrent();
  const thirdWin = await nestedStart(h); // 三层：已采到帧，未 ready
  assert.notEqual(h.getCurrent().phase, 'selecting');
  secondWin.destroy();
  await readyOn(h, thirdWin);
  assert.equal(h.getCurrent(), first, '上屏前发现父没了 → 回滚');
  assert.equal(thirdWin.isDestroyed(), true);
  assert.equal(thirdWin.isVisible(), false, '从未上屏');
  assert.equal(second.invalid, true);
  assert.equal(firstWin.isVisible(), true);
  assert.match(h.statuses.at(-1).message, /原来的选区页已经不在了/);
});

// —— 上屏事务/隐藏读回/恢复失败/预算与整组恢复意图的反例 ——

test('嵌套：子窗 show 抛错不上屏，收回子层并找回父页', async () => {
  const h = await selectingWindow();
  const parent = h.getCurrent(), parentWin = h.windows[0];
  const childWin = await nestedStart(h);
  const child = h.getCurrent();
  childWin.show = () => { throw new Error('show 失败'); };
  await readyOn(h, childWin);
  assert.equal(child.phase, 'loading', '不能标记成 selecting');
  assert.equal(childWin.isDestroyed(), true, '子窗收回');
  assert.equal(h.getCurrent(), parent);
  assert.equal(parentWin.isVisible(), true);
  assert.match(h.statuses.at(-1).message, /没能上屏/);
});

test('嵌套：父窗 hide 抛错或静默无效都算没起来，收回子层并找回父', async () => {
  for (const mode of ['throw', 'noop']) {
    const h = await selectingWindow();
    const parent = h.getCurrent(), parentWin = h.windows[0];
    const childWin = await nestedStart(h);
    const child = h.getCurrent();
    parentWin.hide = mode === 'throw' ? () => { throw new Error('hide 失败'); } : () => {};
    await readyOn(h, childWin);
    assert.equal(child.phase, 'loading', `${mode}：不能当成已就绪`);
    assert.equal(childWin.isDestroyed(), true, `${mode}：子窗收回`);
    assert.equal(h.getCurrent(), parent, `${mode}：回到父会话`);
    assert.equal(parentWin.isVisible(), true, `${mode}：父仍在`);
    assert.match(h.statuses.at(-1).message, /没能隐藏/);
  }
});

test('嵌套：子 show 内同步取消时不再继续上屏流程', async () => {
  const h = await selectingWindow();
  const parent = h.getCurrent(), parentWin = h.windows[0];
  const childWin = await nestedStart(h);
  const child = h.getCurrent();
  childWin.show = () => { h.api.cancel(); };
  await readyOn(h, childWin);
  assert.equal(child.phase, 'loading', '子层从未进入 selecting');
  assert.equal(h.getCurrent(), parent, '父会话已恢复');
  assert.equal(parentWin.isVisible(), true);
  assert.equal(childWin.isDestroyed(), true);
});

test('嵌套：跨屏子窗 hide 失败同样收回并恢复父', async () => {
  const h = await selectingWindow({ displays: [
    { id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 800, y: 0, width: 800, height: 600 }, scaleFactor: 1 }] });
  const parent = h.getCurrent(), parentWin = h.windows[0];
  const childWin = await nestedStart(h);
  const child = h.getCurrent();
  parentWin.hide = () => { throw new Error('hide 失败'); };
  await readyOn(h, childWin);
  assert.equal(child.phase, 'loading');
  assert.equal(childWin.isDestroyed(), true);
  assert.equal(h.getCurrent(), parent);
  assert.match(h.statuses.at(-1).message, /没能隐藏/);
});

test('嵌套预算：保留层的 longImage 也算像素，未知尺寸就拒绝，同一对象只算一次', async () => {
  // ① 底图很小但长图 6000×6000：计上后超限。
  const over = await selectingWindow();
  const overParent = over.getCurrent();
  overParent.longImage = { getSize: () => ({ width: 6000, height: 6000 }), toPNG: () => Buffer.from('x'), toDataURL: () => 'data:,' };
  const regions = over.nativeRegions.length;
  await over.api.start({ hideControl: false, nested: true });
  assert.equal(over.nativeRegions.length, regions, '不开始采集');
  assert.equal(over.getCurrent(), overParent);
  assert.match(over.statuses.at(-1).message, /3600 万像素/);

  // ② 长图尺寸不可确认：拒绝，不当 0。
  const unknown = await selectingWindow();
  const unknownParent = unknown.getCurrent();
  unknownParent.longImage = { getSize: () => ({ width: NaN, height: 1 }) };
  await unknown.api.start({ hideControl: false, nested: true });
  assert.equal(unknown.getCurrent(), unknownParent);
  assert.match(unknown.statuses.at(-1).message, /无法确认保留截图的像素尺寸/);

  // ③ longImage 与 image 是同一对象：只算一次，能正常叠一层。
  const same = await selectingWindow();
  const sameParent = same.getCurrent();
  sameParent.longImage = sameParent.image;
  const childWin = await nestedStart(same);
  assert.ok(childWin, '同一对象不重复计，不误拦');
  await readyOn(same, childWin);
  assert.equal(same.getCurrent().nested, true);
});

test('嵌套恢复意图：根层从设置页启动时，失效后子层取消要把设置页恢复', async () => {
  const restored = harness({ platform: 'win32', controlVisible: true });
  await restored.api.start({ hideControl: true });
  await restored.invoke('shot:init');
  await restored.invoke('shot:ready');
  const parent = restored.getCurrent(), parentWin = restored.windows[0];
  assert.equal(parent.restoreControl, true, '根层带走恢复意图');
  const childWin = await nestedStart(restored);
  assert.equal(restored.getCurrent().restoreControl, true, '后代继承整组意图');
  await readyOn(restored, childWin);
  parentWin.destroy();
  const showsBefore = restored.control.shows;
  await restored.invokeOn(childWin, 'shot:cancel', 'escape-key');
  assert.equal(restored.control.shows, showsBefore + 1, '整组取消后回设置页');

  // 完成成功不回设置页。
  const ok = harness({ platform: 'win32', controlVisible: true });
  await ok.api.start({ hideControl: true });
  await ok.invoke('shot:init');
  await ok.invoke('shot:ready');
  const okParent = ok.getCurrent(), okParentWin = ok.windows[0];
  const okChild = await nestedStart(ok);
  await readyOn(ok, okChild);
  okParentWin.destroy();
  const okShows = ok.control.shows;
  const result = await ok.invokeOn(okChild, 'shot:commit', { x: 0, y: 0, width: 4, height: 2 }, 'copy');
  assert.equal(result.ok, true);
  assert.equal(ok.control.shows, okShows, '成功完成不弹设置页');
});

test('嵌套：父窗恢复 show 抛错时保留会话与文档并告知', async () => {
  const h = await selectingWindow();
  const parent = h.getCurrent(), parentWin = h.windows[0];
  h.setLongOutput();
  const image = parent.image, longImage = parent.longImage;
  const childWin = await nestedStart(h);
  await readyOn(h, childWin);
  parentWin.show = () => { throw new Error('show 失败'); };
  const raised = parentWin.raised, invalidates = parentWin.invalidates;
  await h.invokeOn(childWin, 'shot:cancel', 'escape-key');
  assert.equal(h.getCurrent(), parent, '父会话保留');
  assert.equal(parent.image, image);
  assert.equal(parent.longImage, longImage, '文档不丢');
  assert.equal(parentWin.raised, raised, '不再对旧窗 moveTop');
  assert.equal(parentWin.invalidates, invalidates, '不再对旧窗 invalidate');
  assert.match(h.statuses.at(-1).message, /没能重新显示/);
});

test('嵌套：父窗 show 内同步结束时不再继续置顶/重绘', async () => {
  const h = await selectingWindow();
  const parent = h.getCurrent(), parentWin = h.windows[0];
  const childWin = await nestedStart(h);
  await readyOn(h, childWin);
  const raised = parentWin.raised, invalidates = parentWin.invalidates;
  parentWin.show = () => { h.api.cancel(); };
  await h.invokeOn(childWin, 'shot:cancel', 'escape-key');
  assert.equal(h.api.isActive(), false, '整组已结束');
  assert.equal(parentWin.raised, raised);
  assert.equal(parentWin.invalidates, invalidates);
});

test('嵌套（跨屏）：子窗上屏后读视口期间父消失，hide 前再核验即收回', async () => {
  const h = await selectingWindow({ displays: [
    { id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 800, y: 0, width: 800, height: 600 }, scaleFactor: 1 }] });
  const first = h.getCurrent(), firstWin = h.windows[0];
  const secondWin = await nestedStart(h);
  await readyOn(h, secondWin);
  const second = h.getCurrent();
  // 只给子层挂住视口读：上屏后的那次 await 里让父消失。
  h.setDeferViewport(true);
  const probesBefore = h.viewportProbes.length;
  await h.api.start({ hideControl: false, nested: true });
  const thirdWin = h.windows.at(-1);
  const waitProbes = async count => {
    for (let index = 0; index < 400 && h.viewportProbes.length < probesBefore + count; index += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  await h.invokeOn(thirdWin, 'shot:init');
  const readyPromise = h.invokeOn(thirdWin, 'shot:ready');
  await waitProbes(1); // show 之前的视口读
  h.resolveViewport();
  await waitProbes(2); // show 之后的视口读（就在这里挂住）
  secondWin.destroy();
  h.resolveViewport();
  await readyPromise;
  assert.equal(h.getCurrent(), first, '回滚到最近可用祖先');
  assert.equal(thirdWin.shows, 1, '子窗确实已经上过屏（失效发生在 show 之后的视口 await 里）');
  assert.equal(thirdWin.isDestroyed(), true, '子层已收回');
  assert.equal(second.invalid, true, '消失的父已标失效');
  assert.equal(firstWin.isVisible(), true);
  assert.match(h.statuses.at(-1).message, /原来的选区页已经不在了/);
  h.setDeferViewport(false);
});

// —— GIF 预览父（record-preview）叠层：实际展示窗是控制条 bar，不是旧冻图窗 ——
const previewParent = async () => {
  const h = await selectingWindow();
  const parent = h.getCurrent();
  const frozen = parent.win;
  const bar = h.beginRecordPreview();
  return { h, parent, frozen, bar };
};

test('GIF 预览父：新帧前不隐藏控制条，子就绪后隐藏的是 bar，子取消回原 bar 且草稿不丢', async () => {
  const { h, parent, frozen, bar } = await previewParent();
  assert.equal(parent.phase, 'record-preview');
  assert.equal(bar.isVisible(), true);
  const preview = parent.recording.preview;
  const loads = bar.loads?.length ?? 0;
  const childWin = await nestedStart(h);
  assert.equal(h.getCurrent().nested, true);
  assert.equal(bar.isVisible(), true, '新帧完成前父控制条仍可见（子图里得有它）');
  assert.equal(frozen.isVisible(), false, '冻图窗始终隐藏');
  await readyOn(h, childWin);
  assert.equal(bar.isVisible(), false, '子就绪后隐藏的是控制条');
  assert.equal(frozen.isVisible(), false, '冻图窗不因此显示');
  await h.invokeOn(childWin, 'shot:cancel', 'escape-key');
  assert.equal(h.getCurrent(), parent);
  assert.equal(parent.phase, 'record-preview', '恢复保留 record-preview，不改写成 selecting');
  assert.equal(parent.recording.preview, preview, '草稿不丢');
  assert.equal(bar.isVisible(), true, '控制条重新显示');
  assert.equal(frozen.isVisible(), false, '冻图窗仍隐藏');
  assert.equal(bar.loads?.length ?? 0, loads, 'bar 没有重载');
});

test('GIF 预览父：子复制成功回原 bar，预览与阶段原样保留', async () => {
  const { h, parent, bar } = await previewParent();
  const preview = parent.recording.preview;
  const childWin = await nestedStart(h);
  await readyOn(h, childWin);
  const result = await h.invokeOn(childWin, 'shot:commit', { x: 0, y: 0, width: 4, height: 2 }, 'copy');
  assert.equal(result.ok, true);
  assert.equal(h.getCurrent(), parent);
  assert.equal(parent.phase, 'record-preview');
  assert.equal(parent.recording.preview, preview);
  assert.equal(bar.isVisible(), true);
});

test('GIF 预览父：三层后第四层只提示；退出逐层释放包括控制条', async () => {
  const { h, bar } = await previewParent();
  const secondWin = await nestedStart(h);
  await readyOn(h, secondWin);
  const thirdWin = await nestedStart(h);
  await readyOn(h, thirdWin);
  const before = h.windows.length;
  await h.api.start({ hideControl: false, nested: true });
  assert.equal(h.windows.length, before, '到限不新开窗');
  assert.match(h.statuses.at(-1).message, /最多叠 3 层/);
  h.api.dispose();
  assert.equal(h.api.isActive(), false);
  assert.equal(h.windows.every(win => win.isDestroyed()), true, '所有层（含控制条）都释放');
  assert.equal(bar.isDestroyed(), true);
  assert.equal(h.control.shows, 0);
});

test('GIF 预览父：子准备中控制条消失 → 子作废，回最近可用祖先', async () => {
  const h = await selectingWindow();
  const first = h.getCurrent(), firstWin = h.windows[0];
  const secondWin = await nestedStart(h);
  await readyOn(h, secondWin);
  const gifParent = h.getCurrent();
  const bar = h.beginRecordPreview();
  const thirdWin = await nestedStart(h);
  bar.destroy(); // 控制条在子层准备期间消失
  // 真实 recording 会在自己的早退前先通知截图会话（控制条已丢）。
  h.recordingOptions().onWindowLost(gifParent, gifParent.recording, 'window-close');
  await readyOn(h, thirdWin);
  assert.equal(h.getCurrent(), first, '跳过失去控制条的父，回到最近可用祖先');
  assert.equal(thirdWin.isDestroyed(), true);
  assert.equal(gifParent.invalid, true, '失效层已标记');
  assert.equal(firstWin.isVisible(), true);
});

test('GIF 预览父：子已就绪后控制条坏掉，子继续，结束后跳失效父', async () => {
  const h = await selectingWindow();
  const first = h.getCurrent();
  const secondWin = await nestedStart(h);
  await readyOn(h, secondWin);
  const gifParent = h.getCurrent();
  const bar = h.beginRecordPreview();
  const thirdWin = await nestedStart(h);
  await readyOn(h, thirdWin);
  const third = h.getCurrent();
  bar.destroy();
  h.recordingOptions().onWindowLost(gifParent, gifParent.recording, 'window-close');
  assert.equal(h.getCurrent(), third, '子会话继续');
  assert.equal(thirdWin.isDestroyed(), false);
  await h.invokeOn(thirdWin, 'shot:cancel', 'escape-key');
  assert.equal(h.getCurrent(), first, '结束后跳过失效父');
  assert.equal(gifParent.invalid, true);
});

test('GIF 预览父：挂起期间父页 IPC 被拒；Esc 与窗口丢失钩子只影响子准备', async () => {
  const { h, parent, bar } = await previewParent();
  const pending = h.api.start({ hideControl: false, nested: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(h.getCurrent(), parent);
  await assert.rejects(h.invoke('shot:init'), /无效选区窗口/);
  // 挂起父的 Esc 钩子：在 recording 的活动性早退前先到截图会话。
  let prevented = 0;
  const handled = h.recordingOptions().onSuspendedEscape(parent, { preventDefault: () => { prevented += 1; } });
  assert.equal(handled, true, '挂起父的 Esc 由截图会话处理');
  assert.equal(prevented, 1);
  await pending;
  assert.equal(h.getCurrent(), parent, '子准备被撤掉，回到父');
  assert.equal(bar.isVisible(), true);
  // 窗口丢失钩子：挂起时标失效（子结束后跳过）。
  const childWin = await nestedStart(h);
  await readyOn(h, childWin);
  h.recordingOptions().onWindowLost(parent, parent.recording, 'renderer-gone');
  assert.equal(parent.invalid, true, '挂起父被标失效');
});

test('GIF 预览父：只有稳定预览才允许叠层，录制/收尾/编辑/保存继续报忙', async () => {
  for (const [phase, patch, pattern] of [
    ['record-starting', {}, /录制|GIF|稍后|还在进行/],
    ['recording', {}, /录制|GIF|稍后|还在进行/],
    ['record-finishing', {}, /录制|GIF|稍后|还在进行/],
    ['record-editing', { editJob: { token: 'job' } }, /录制|GIF|稍后|还在进行/],
    ['saving', {}, /正在保存|录制|GIF|稍后|还在进行/]
  ]) {
    const h = await selectingWindow();
    const parent = h.getCurrent();
    h.beginRecordPreview(patch);
    parent.phase = phase;
    const before = h.windows.length;
    await h.api.start({ hideControl: false, nested: true });
    assert.equal(h.windows.length, before, `${phase}：不新开窗`);
    assert.equal(h.getCurrent(), parent, `${phase}：会话不变`);
    assert.match(h.statuses.at(-1).message, pattern);
  }
});

test('长图预览未就绪的窗口期不入栈；ready 之后稳定长图可以叠层', async () => {
  const h = await selectingWindow();
  const parent = h.getCurrent();
  h.setLongOutput(true);
  const before = h.windows.length;
  await h.api.start({ hideControl: false, nested: true });
  assert.equal(h.windows.length, before, '预览未 ready 不叠层');
  assert.match(h.statuses.at(-1).message, /长图预览还在生成/);
  assert.equal(h.getCurrent(), parent);
  h.setLongOutput(false);
  const childWin = await nestedStart(h);
  assert.ok(childWin, '稳定长图可以叠层');
  await readyOn(h, childWin);
  const longImage = parent.longImage;
  await h.invokeOn(childWin, 'shot:cancel', 'escape-key');
  assert.equal(h.getCurrent(), parent);
  assert.equal(parent.longImage, longImage, '长图引用原样保留');
});

test('GIF 预览父：恢复 show 静默无效时不冒报成功，下次 F1 能重试并读回确认', async () => {
  const { h, parent, frozen, bar } = await previewParent();
  const preview = parent.recording.preview;
  const childWin = await nestedStart(h);
  await readyOn(h, childWin);
  assert.equal(bar.isVisible(), false);
  const raised = bar.raised, invalidates = bar.invalidates;
  bar.show = () => {}; // show 不报错但窗口仍隐藏
  await h.invokeOn(childWin, 'shot:cancel', 'escape-key');
  assert.equal(h.getCurrent(), parent, '会话保留');
  assert.equal(parent.recording.preview, preview, '草稿不丢');
  assert.equal(parent.resumeFailed, true, '读回未显示 → 不冒报成功');
  assert.match(h.statuses.at(-1).message, /没能重新显示/);
  assert.equal(bar.raised, raised, '未显示就不置顶');
  assert.equal(bar.invalidates, invalidates, '未显示就不重绘');
  assert.equal(frozen.isVisible(), false, '不显旧冻图窗');
  // 下一次 F1：走同一 show 恢复并读回确认（这次真的能显示）。
  delete bar.show;
  const before = h.windows.length;
  await h.api.start({ hideControl: false });
  assert.equal(h.windows.length, before, '不新开窗');
  assert.equal(h.getCurrent(), parent);
  assert.equal(parent.phase, 'record-preview', '阶段原样保留');
  assert.equal(parent.resumeFailed, false);
  assert.equal(bar.isVisible(), true, '控制条实际显示');
  assert.equal(frozen.isVisible(), false, '冻图窗仍隐藏');
  assert.match(h.statuses.at(-1).message, /已尝试唤回 GIF 预览/);
});

test('GIF 预览父：控制条已丢时 F1 不假装能恢复，也不新开会话', async () => {
  const { h, parent, bar } = await previewParent();
  bar.destroy();
  const before = h.windows.length;
  await h.api.start({ hideControl: false });
  assert.equal(h.windows.length, before, '不新开窗');
  assert.equal(h.getCurrent(), parent, '会话保留等用户处理');
  assert.match(h.statuses.at(-1).message, /录制|GIF/);
});

test('GIF 预览父预算：预览一帧计入 36M，恰好等于上限允许，多一像素就拒绝', async () => {
  // 单屏新帧 8×6=48；预览 4×4=16。恰好 36M → 底图 35,999,936 = 16 × 2,249,996。
  const exact = await selectingWindow();
  const exactParent = exact.getCurrent();
  exact.beginRecordPreview({ preview: { bytes: new Uint8Array([1]), width: 4, height: 4, elapsedMs: 1, sourceId: 'p' } });
  exactParent.image = { getSize: () => ({ width: 16, height: 2249996 }) };
  const childWin = await nestedStart(exact);
  assert.ok(childWin, '恰好 36M 允许叠层');
  await readyOn(exact, childWin);
  assert.equal(exact.getCurrent().nested, true);

  // 多一像素：35,999,952 + 16 + 48 = 36,000,016 > 36M → 拒绝。
  const over = await selectingWindow();
  const overParent = over.getCurrent();
  over.beginRecordPreview({ preview: { bytes: new Uint8Array([1]), width: 4, height: 4, elapsedMs: 1, sourceId: 'p' } });
  overParent.image = { getSize: () => ({ width: 16, height: 2249997 }) };
  const regions = over.nativeRegions.length;
  const live = over.windows.filter(win => !win.isDestroyed()).length;
  await over.api.start({ hideControl: false, nested: true });
  assert.equal(over.nativeRegions.length, regions, '超限不开始采集');
  assert.equal(over.windows.filter(win => !win.isDestroyed()).length, live, '不留下新窗');
  assert.equal(over.windows.at(-1).isDestroyed(), true, '子窗已收回');
  assert.equal(over.getCurrent(), overParent);
  assert.match(over.statuses.at(-1).message, /3600 万像素/);
  assert.equal(overParent.phase, 'record-preview', '退回时阶段不变');
});

test('GIF 预览父预算：预览尺寸未知就拒绝，不当 0', async () => {
  const h = await selectingWindow();
  const parent = h.getCurrent();
  h.beginRecordPreview({ preview: { bytes: new Uint8Array([1]), width: 4, elapsedMs: 1, sourceId: 'p' } });
  const live = h.windows.filter(win => !win.isDestroyed()).length;
  await h.api.start({ hideControl: false, nested: true });
  assert.equal(h.windows.filter(win => !win.isDestroyed()).length, live, '不留下新窗');
  assert.equal(h.windows.at(-1).isDestroyed(), true, '子窗已收回');
  assert.equal(h.getCurrent(), parent);
  assert.match(h.statuses.at(-1).message, /无法确认保留截图的像素尺寸/);
  assert.equal(parent.phase, 'record-preview');
});

test('GIF 错误/重录页：停稳后 F1 能叠层，子返回仍同 bar，error 与阶段不丢', async () => {
  const h = await selectingWindow();
  const parent = h.getCurrent();
  const bar = h.beginRecordPreview({ preview: undefined, aborted: true, error: 'GIF 生成失败：编码超时', elapsedMs: 0 });
  assert.equal(parent.phase, 'record-preview');
  assert.equal(parent.recording.preview, undefined);
  const childWin = await nestedStart(h);
  assert.ok(childWin, '停稳的错误页可以再叠一层');
  assert.equal(h.getCurrent().nested, true);
  await readyOn(h, childWin);
  assert.equal(bar.isVisible(), false, '子就绪后隐藏的是控制条');
  await h.invokeOn(childWin, 'shot:cancel', 'escape-key');
  assert.equal(h.getCurrent(), parent);
  assert.equal(parent.phase, 'record-preview', '阶段原样保留');
  assert.equal(parent.recording.error, 'GIF 生成失败：编码超时', '错误提示不丢');
  assert.equal(parent.recording.preview, undefined, '仍是无预览的错误页');
  assert.equal(bar.isVisible(), true, '回到同一个控制条');
  // 错误页没有预览帧：不额外计预算（只留底图）。
  assert.equal(parent.recording.preview, undefined);
});

test('GIF 错误页但资源未停：不叠层，仍报忙', async () => {
  for (const leak of ['capture', 'encoder']) {
    const h = await selectingWindow();
    const parent = h.getCurrent();
    h.beginRecordPreview({ preview: undefined, aborted: true, error: 'GIF 生成失败：编码超时', [leak]: { token: 'x' } });
    const live = h.windows.filter(win => !win.isDestroyed()).length;
    await h.api.start({ hideControl: false, nested: true });
    assert.equal(h.windows.filter(win => !win.isDestroyed()).length, live, `${leak} 未停：不新开窗`);
    assert.equal(h.getCurrent(), parent, `${leak} 未停：会话不变`);
    assert.match(h.statuses.at(-1).message, /录制|GIF|稍后|还在进行/);
  }
  // error 存在但 aborted 未 true：同样拒绝。
  const h = await selectingWindow();
  const parent = h.getCurrent();
  h.beginRecordPreview({ preview: undefined, error: 'GIF 生成失败：编码超时' });
  await h.api.start({ hideControl: false, nested: true });
  assert.equal(h.getCurrent(), parent);
  assert.match(h.statuses.at(-1).message, /录制|GIF|稍后|还在进行/);
});

// —— 离线文字识别接线：固定 payload / 单飞 / 会话收尾取消 ——
function ocrPngHeader(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  bytes[24] = 8; bytes[25] = 6;
  return new Uint8Array(bytes);
}
async function openEditorSession(options = {}) {
  const h = harness({ controlVisible: false, ...options });
  await h.api.start(); await h.invoke('shot:init'); await h.invoke('shot:ready');
  const source = await h.invoke('shot:edit-source', { x: 10, y: 20, width: 100, height: 100 });
  return { h, source };
}
const ocrReply = (child, value) => {
  child.stdout.emit('data', Buffer.from(JSON.stringify(value), 'utf8'));
  child.emit('close', 0, null);
};
const ocrPayload = token => ({ token, png: ocrPngHeader(200, 200), width: 200, height: 200 });
const editorOcr = (h, token) => h.invokeOn(h.windows.at(-1), 'shot:recognize-text', ocrPayload(token));
test('识别入口只在真选区主frame、框选态且编辑器打开时存在', async () => {
  const idle = harness();
  assert.equal(idle.handlers.has('shot:recognize-text'), true);
  const foreign = { sender: { spoofed: true }, senderFrame: { spoofed: true } };
  await assert.rejects(Promise.resolve(idle.handlers.get('shot:recognize-text')(foreign, ocrPayload('x'))), /识别请求已失效/);
  const { h, source } = await openEditorSession();
  // 同一通道换成伪造 sender：仍被选区 allowed 拦住。
  await assert.rejects(Promise.resolve(h.handlers.get('shot:recognize-text')(foreign, ocrPayload(source.token))), /识别请求已失效/);
  // 编辑器关闭后同一个 token 也不能再用。
  await h.invoke('shot:edit-state', source.token, 'close');
  await assert.rejects(h.invoke('shot:recognize-text', ocrPayload(source.token)), /识别请求已失效/);
  // 换一份文档后旧 token 失效。
  await h.invoke('shot:edit-state', source.token, 'discard');
  await assert.rejects(h.invoke('shot:recognize-text', ocrPayload(source.token)), /识别请求已失效/);
  assert.equal(h.ocrSpawns.length, 0);
});
test('识别复用选区 allowed/getActive/nativeImage，PNG 整块走 stdin 且无用户参数', async () => {
  const { h, source } = await openEditorSession();
  const options = h.ocrOptions();
  assert.equal(typeof options.allowed, 'function');
  assert.equal(typeof options.getActive, 'function');
  assert.equal(typeof options.nativeImage.createFromBuffer, 'function');
  assert.equal(options.allowed({ sender: 'foreign', senderFrame: 'foreign' }), false, '非法 sender 由同一条守卫拒绝');
  const pending = editorOcr(h, source.token);
  assert.equal(h.ocrSpawns.length, 1);
  assert.match(h.ocrSpawns[0].file, /ocr-helper\.exe$/);
  assert.deepEqual([...h.ocrSpawns[0].argv], [], '固定 exe + 无用户参数');
  assert.deepEqual({ ...h.ocrSpawns[0].options }, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(h.ocrSpawns[0].child.stdin.ended, true);
  assert.deepEqual([...h.ocrSpawns[0].child.stdin.chunks[0]], [...Buffer.from(ocrPngHeader(200, 200))]);
  await assert.rejects(editorOcr(h, source.token), /识别正忙/);
  assert.equal(h.ocrSpawns.length, 1, '重复请求不再起第二个进程');
  ocrReply(h.ocrSpawns[0].child, { ok: true, text: '保存按钮', language: 'zh-Hans-CN', width: 200, height: 200 });
  assert.deepEqual({ ...(await pending) }, { text: '保存按钮', language: 'zh-Hans-CN' });
  assert.equal(h.getCurrent().ocrJob, undefined, '结束后不留 job');
  assert.equal(h.getCurrent().phase, 'selecting', '识别不改 phase');
});
test('会话取消时终止在途识别，但仍是原来的取消语义', async () => {
  const { h, source } = await openEditorSession();
  const pending = editorOcr(h, source.token);
  assert.equal(h.ocrSpawns[0].child.killed, 0);
  h.api.cancel();
  await assert.rejects(pending, /文字识别已取消/);
  assert.equal(h.ocrSpawns[0].child.killed, 1);
  assert.equal(h.api.isActive(), false);
});
test('编辑会话关闭与放弃都会取消在途识别', async () => {
  const closeCase = await openEditorSession();
  const pendingClose = editorOcr(closeCase.h, closeCase.source.token);
  await closeCase.h.invoke('shot:edit-state', closeCase.source.token, 'close');
  await assert.rejects(pendingClose, /文字识别已取消/);
  assert.equal(closeCase.h.ocrSpawns[0].child.killed, 1);

  const discardCase = await openEditorSession();
  await discardCase.h.invoke('shot:edit-state', discardCase.source.token, 'open');
  const pendingDiscard = editorOcr(discardCase.h, discardCase.source.token);
  await discardCase.h.invoke('shot:edit-state', discardCase.source.token, 'discard');
  await assert.rejects(pendingDiscard, /文字识别已取消/);
  assert.equal(discardCase.h.ocrSpawns[0].child.killed, 1);
});
test('helper 缺失时只说明不可用，编辑器与手填字段照常', async () => {
  const { h, source } = await openEditorSession();
  h.setOcrHelper(false);
  await assert.rejects(editorOcr(h, source.token), /离线文字识别组件缺失/);
  assert.equal(h.ocrSpawns.length, 0);
  // 识别不可用不影响编辑会话继续存在。
  await h.invoke('shot:edit-state', source.token, 'close');
  assert.equal(h.api.isActive(), true);
});

test('F1：录制各阶段只回一句忙，不唤回、不展示冻结窗、不新建窗口', async () => {
  for (const phase of ['record-starting', 'recording', 'record-finishing', 'record-preview']) {
    const h = harness({ platform: 'win32', controlVisible: false });
    await h.api.start();
    await h.invoke('shot:init');
    await h.invoke('shot:ready');
    const current = h.getCurrent();
    assert.ok(current, '选区会话已建立');
    current.phase = phase;
    current.recording = { token: 'owned' };
    const windowsBefore = h.windows.length;
    const win = current.win;
    const visibleBefore = win.isVisible();
    await h.api.start();
    const last = h.statuses.at(-1);
    assert.equal(last.error, true, `${phase} 期间 F1 只提示忙`);
    assert.match(last.message, /录制|GIF/);
    assert.equal(h.windows.length, windowsBefore, `${phase} 期间不新建窗口`);
    assert.equal(win.isVisible(), visibleBefore, `${phase} 期间不展示冻结窗`);
    assert.equal(current.phase, phase, 'F1 不改录制阶段');
  }
});

// —— 图片编辑页当普通窗口：进编辑取消置顶/回任务栏，退出恢复；最小化 IPC 只认有效编辑文档 ——
const EDIT_DISPLAY = { id: 7, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 };
const EDIT_RECT = { x: 20, y: 20, width: 100, height: 80 };
const expectedTopmostLevel = () => (process.platform === 'win32' ? 'pop-up-menu' : undefined);
const editWindow = () => selectingWindow({ displays: [EDIT_DISPLAY] });
// edit-minimize/ edit-state 是同步 handler：同步 throw 要包成 rejection 才能用 assert.rejects。
const rejectsInvoke = (h, name, ...args) => assert.rejects(async () => { await h.invoke(name, ...args); });

test('独立编辑窗是普通窗口，原选区窗的几何与置顶/任务栏一律不动', async () => {
  const h = await editWindow();
  const win = h.windows[0];
  const boundsBefore = { ...win.bounds };
  assert.equal(win.alwaysOnTop, true, '选区窗默认置顶');
  assert.equal(win.skipTaskbar, true, '选区窗默认不进任务栏');
  const doc = await h.invoke('shot:edit-source', EDIT_RECT, undefined);
  const editor = h.windows.at(-1);
  assert.notEqual(editor, win, '编辑在另一扇窗里');
  assert.equal(h.getCurrent().editorOpen, true);
  assert.equal(win.alwaysOnTop, true, '原选区窗的置顶不变');
  assert.equal(win.skipTaskbar, true, '原选区窗的任务栏状态不变');
  assert.deepEqual(win.bounds, boundsBefore, '原选区窗几何不变');
  assert.equal(win.visible, false, '编辑期间原窗只收起');
  assert.equal(editor.options.frame, true, '编辑窗有系统标题栏');
  assert.equal(editor.options.resizable, true);
  assert.equal(editor.options.skipTaskbar, false, '编辑窗进任务栏');
  assert.equal(editor.options.alwaysOnTop, false, '编辑窗不置顶');
  assert.equal(editor.options.transparent, false);
  assert.equal(editor.visible, true, '编辑窗上屏');
  assert.equal(h.windows.length, 2, '只多这一扇窗');
  const again = await h.invoke('shot:edit-source', EDIT_RECT, undefined);
  assert.equal(again.token, doc.token);
  assert.equal(h.windows.length, 2, '同 token 重开不新建窗口');
  h.api.cancel();
});

test('放弃编辑（discard）释放编辑窗并清掉文档，原选区窗恢复可见', async () => {
  const h = await editWindow();
  const win = h.windows[0];
  const doc = await h.invoke('shot:edit-source', EDIT_RECT, undefined);
  const editor = h.windows.at(-1);
  await h.invoke('shot:edit-state', doc.token, 'discard');
  assert.equal(h.getCurrent().editorOpen, false);
  assert.equal(h.getCurrent().editDocument, undefined);
  assert.equal(editor.isDestroyed(), true, '重选/结束才释放宿主');
  assert.equal(win.visible, true, '原选区窗重新显示');
  assert.equal(win.alwaysOnTop, true);
  h.api.cancel();
});

test('首次取图失败不改窗口形态，仍是选区窗', async () => {
  const h = await editWindow();
  const win = h.windows[0];
  await assert.rejects(h.invoke('shot:edit-source', { x: 20, y: 20, width: 1, height: 1 }, undefined), /选区无效/);
  assert.equal(win.alwaysOnTop, true);
  assert.equal(win.skipTaskbar, true);
  assert.notEqual(h.getCurrent().editorOpen, true, '仍在选区态');
  assert.equal(h.getCurrent().editDocument, undefined);
  h.api.cancel();
});

test('编辑页就绪失败：首次新建的文档被清掉，重试能在新宿主上正常进入', async () => {
  const failing = await selectingWindow({ displays: [EDIT_DISPLAY], editorReadyFails: true });
  const win = failing.windows[0];
  const bounds = { ...win.bounds };
  await assert.rejects(failing.invoke('shot:edit-source', EDIT_RECT, undefined), /打开失败|没有就绪/);
  assert.notEqual(failing.getCurrent().editorOpen, true, '没打开就不算进编辑');
  assert.equal(failing.getCurrent().editDocument, undefined, '首次失败不留下半成品文档');
  assert.ok(failing.getCurrent().image, '原图仍保留');
  assert.deepEqual(win.bounds, bounds, '原选区窗几何不变');
  assert.equal(win.visible, true, '失败后原选区窗仍可见');
  const broken = failing.windows.at(-1);
  assert.equal(broken.isDestroyed(), true, '打不开的宿主当场收掉');

  // 重试（正常夹具）：全新宿主，拿 token 进编辑。
  const ok = await selectingWindow({ displays: [EDIT_DISPLAY] });
  const doc = await ok.invoke('shot:edit-source', EDIT_RECT, undefined);
  assert.equal(typeof doc.token, 'string');
  assert.equal(ok.getCurrent().editorOpen, true);
  assert.equal(ok.windows[0].visible, false);
  ok.api.cancel();
});

test('编辑中窗口丢焦点不恢复置顶；回到预览后恢复逻辑照旧', async () => {
  const rows = [];
  const h = await selectingWindow({ displays: [EDIT_DISPLAY], onLifecycle: (event, fields) => rows.push({ event, ...fields }) });
  const win = h.windows[0];
  const doc = await h.invoke('shot:edit-source', EDIT_RECT, undefined);
  win.isFocused = () => true;
  win.emit('focus');
  assert.equal(topmostRows(rows, 'selection-topmost-recovered').length, 0, '编辑中不恢复置顶');
  assert.equal(win.alwaysOnTop, true, '原窗置顶本来就没动');

  await h.invoke('shot:edit-state', doc.token, 'close');
  win.alwaysOnTop = false; // 模拟回预览后被外部程序降级
  win.emit('focus');
  assert.equal(topmostRows(rows, 'selection-topmost-recovered').length, 1, '回预览后照常恢复');
  assert.equal(win.alwaysOnTop, true);
  h.api.cancel();
});

test('编辑页最小化 IPC 只接受当前会话的有效编辑文档，最小化发到独立宿主', async () => {
  const h = await editWindow();
  await rejectsInvoke(h, 'shot:edit-minimize', 'nope');
  const doc = await h.invoke('shot:edit-source', EDIT_RECT, undefined);
  const editor = h.windows.at(-1);
  await h.invoke('shot:edit-minimize', doc.token);
  assert.equal(editor.minimized, true, '最小化真的发到独立编辑窗');

  await rejectsInvoke(h, 'shot:edit-minimize', 'stale-token');
  const session = h.getCurrent();
  const phase = session.phase;
  session.phase = 'saving';
  await rejectsInvoke(h, 'shot:edit-minimize', doc.token);
  session.phase = phase;

  await h.invoke('shot:edit-state', doc.token, 'close');
  await rejectsInvoke(h, 'shot:edit-minimize', doc.token);
  await h.invoke('shot:edit-state', doc.token, 'discard');
  await rejectsInvoke(h, 'shot:edit-minimize', doc.token);

  const foreign = { sender: { mainFrame: {} }, mainFrame: {}, senderFrame: {} };
  assert.throws(() => h.handlers.get('shot:edit-minimize')(foreign, doc.token), /编辑窗口已失效/, '别的 sender 一律拒绝');
  h.api.cancel();
});

test('嵌套：父页在编辑态时 F1 截子图，回来把编辑宿主重新显示', async () => {
  const h = await editWindow();
  const parentWin = h.windows[0];
  const doc = await h.invoke('shot:edit-source', EDIT_RECT, undefined);
  const editor = h.windows.at(-1);
  const childWin = await nestedStart(h);
  await readyOn(h, childWin);
  assert.equal(editor.isVisible(), false, '叠层时父的编辑宿主被收起');
  assert.equal(h.getCurrent().win, childWin, '子层当班');
  h.api.cancel(); // 取消子层 → 回父页
  assert.equal(h.getCurrent().win, parentWin, '回到父页会话');
  assert.equal(editor.isVisible(), true, '回到父层时重新显示编辑宿主');
  assert.equal(parentWin.isVisible(), false, '原选区窗仍是收起的');
  assert.equal(h.getCurrent().editDocument.token, doc.token, '编辑文档保留');
  h.api.cancel();
});

test('编辑中取消截图会一并收掉编辑宿主，不留悬挂窗', async () => {
  const h = await editWindow();
  await h.invoke('shot:edit-source', EDIT_RECT, undefined);
  const editor = h.windows.at(-1);
  h.api.cancel();
  assert.equal(editor.isDestroyed(), true, '会话结束就释放宿主');
  assert.equal(h.api.isActive(), false);
});

test('新一轮截图重新建宿主，旧文档 token 不会串到新轮', async () => {
  const h = await editWindow();
  const docA = await h.invoke('shot:edit-source', EDIT_RECT, undefined);
  const editorA = h.windows.at(-1);
  h.api.cancel();
  assert.equal(editorA.isDestroyed(), true);

  await h.api.start({ hideControl: false });
  const freshWin = h.windows.at(-1);
  await readyOn(h, freshWin);
  await rejectsInvoke(h, 'shot:edit-state', docA.token, 'open');
  const docB = await h.invokeOn(freshWin, 'shot:edit-source', EDIT_RECT, undefined);
  assert.notEqual(docB.token, docA.token);
  assert.equal(h.getCurrent().editDocument.token, docB.token, '新轮文档就位');
  assert.equal('dataUrl' in docB, false, '原图不再回给选区页');
  h.api.cancel();
});

test('编辑窗提交：只认编辑宿主主 frame 与当前文档 token，仍走同一套裁切/尺寸校验', async () => {
  const h = await editWindow();
  const doc = await h.invoke('shot:edit-source', EDIT_RECT, undefined);
  const editor = h.windows.at(-1);
  const commit = h.handlers.get('shot:editor-commit');
  const ev = { sender: editor.webContents, senderFrame: editor.webContents.mainFrame };
  await assert.rejects(commit({ sender: {}, senderFrame: {} }, 'copy', { token: doc.token, png: editedHeader(doc.width, doc.height) }), /已失效/);
  await assert.rejects(commit(ev, 'copy', { token: 'foreign', png: editedHeader(doc.width, doc.height) }), /缺失或已失效/);
  await assert.rejects(commit(ev, 'save', { token: doc.token, png: editedHeader(1, 1) }), /未输出原图/);
  assert.equal(h.copied.length, 0); assert.equal(h.writes.length, 0);
  const result = await commit(ev, 'copy', { token: doc.token, png: editedHeader(doc.width, doc.height) });
  assert.equal(result.ok, true);
  assert.equal(h.copied.length, 1);
  assert.equal(h.api.isActive(), false, '提交成功才结束会话');
  assert.equal(editor.isDestroyed(), true, '会话结束收掉编辑窗');
});

function exitPrompt(h, win) {
  const item = (win.sent ?? []).filter(entry => entry.channel === 'shot:exit-confirmation' && entry.args[0].open).at(-1);
  assert.ok(item, '实际 owner 页面收到确认消息');
  return item.args[0].id;
}
async function exitReply(h, win, id, choice) {
  return h.invokeOn(win, 'shot:exit-confirmation-reply', id, choice);
}

test('编辑窗原生 X：先拦下问确认，保留时窗口与文档都在；确认放弃才结束整轮', async () => {
  const h = await selectingWindow({ displays: [EDIT_DISPLAY], messageBoxResponse: 0 });
  const overlay = h.windows[0];
  const doc = await h.invoke('shot:edit-source', EDIT_RECT, undefined);
  const editor = h.windows.at(-1);
  let prevented = 0;
  editor.emit('close', { preventDefault() { prevented += 1; } });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, 1, '原生关闭先被拦下');
  const id = exitPrompt(h, editor);
  await exitReply(h, editor, id, 'ready');
  await exitReply(h, editor, id, 'keep');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.getCurrent().editDocument.token, doc.token, '保留时文档不动');
  assert.equal(editor.isDestroyed(), false, '保留时窗口不动');
  assert.equal(overlay.isDestroyed(), false, '原选区窗也还在（收起状态）');

  editor.emit('close', { preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  const second = exitPrompt(h, editor);
  assert.notEqual(second, id);
  await exitReply(h, editor, second, 'ready');
  await exitReply(h, editor, second, 'discard');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.api.isActive(), false, '确认放弃后才结束整轮');
  assert.equal(editor.isDestroyed(), true);
  assert.equal(overlay.isDestroyed(), true);
});

test('编辑宿主丢了：拒绝重开与导出，提示中断，不用原图重建、不假装保住草稿', async () => {
  const h = await editWindow();
  const doc = await h.invoke('shot:edit-source', EDIT_RECT, undefined);
  const first = h.windows.at(-1);
  const loadsBefore = first.loads.length;
  await h.invoke('shot:edit-state', doc.token, 'close');
  first.crashRenderer();                     // 模拟宿主渲染进程援溃
  assert.equal(h.getCurrent().editDocument.token, doc.token, '文档记录仍在，等用户明确重选/退出');
  await assert.rejects(h.invoke('shot:edit-source', EDIT_RECT, undefined), /已异常中断/);
  assert.equal(h.windows.length, 2, '没有新建宿主窗口');
  assert.equal(first.loads.length, loadsBefore, '没有重载页面');
  assert.equal((first.sent ?? []).filter(item => item.channel === 'shot:editor-open').length, 1, '没有再发一次源图');
  // 预览里的保存/复制也拒绝：不输出原图，也不写盘。
  await assert.rejects(h.invoke('shot:commit', EDIT_RECT, 'copy'), /已异常中断/);
  assert.equal(h.copied.length, 0);
  assert.equal(h.writes.length, 0);
  // 明确重选才释放这一层并清掉文档。
  await h.invoke('shot:edit-state', doc.token, 'discard');
  assert.equal(h.getCurrent().editDocument, undefined);
  h.api.cancel();
});

test('叠层：父层编辑后 F1 开子并编辑，子用自己的 host/token，结束不毁父，父重开同 DOM 仍可导出', async () => {
  const h = await editWindow();
  const parentWin = h.windows[0];
  const parentDoc = await h.invoke('shot:edit-source', EDIT_RECT, undefined);
  const parentHost = h.windows.at(-1);
  const parentOpens = (parentHost.sent ?? []).filter(item => item.channel === 'shot:editor-open').length;

  const childWin = await nestedStart(h);
  await readyOn(h, childWin);
  assert.equal(parentHost.isVisible(), false, '叠层时父层编辑窗被收起');
  assert.equal(parentWin.isVisible(), false, '父选区窗也仍是收起的');

  const childDoc = await h.invokeOn(childWin, 'shot:edit-source', EDIT_RECT, undefined);
  assert.equal(h.windows.length, 4, '父/子各有自己的选区窗与编辑窗');
  const childHost = h.windows.at(-1);
  assert.notEqual(childHost, parentHost);
  assert.notEqual(childDoc.token, parentDoc.token, '子层是新 token');
  assert.equal(h.getCurrent().editDocument.token, childDoc.token);

  // 子层结束（取消截图）：只收子层，父层 DOM 与窗口都留着。
  h.api.cancel();
  assert.equal(childHost.isDestroyed(), true);
  assert.equal(parentHost.isDestroyed(), false, '父层宿主不被子层结束带走');
  assert.equal(h.getCurrent().editDocument.token, parentDoc.token);
  assert.equal(parentHost.isVisible(), true, '回到父层时父编辑窗重新显示');

  // 父层同 token 重开不重载、不重发源图；导出仍走父层宿主。
  const again = await h.invoke('shot:edit-source', EDIT_RECT, undefined);
  assert.equal(again.token, parentDoc.token);
  assert.equal((parentHost.sent ?? []).filter(item => item.channel === 'shot:editor-open').length, parentOpens + 1);
  assert.equal(parentHost.loads.length, 1, '父层页面没有重载');
  await h.invoke('shot:edit-state', parentDoc.token, 'close');
  const pending = h.invoke('shot:commit', EDIT_RECT, 'copy');
  await new Promise(resolve => setImmediate(resolve));
  const request = (parentHost.sent ?? []).filter(item => item.channel === 'shot:editor-export').at(-1);
  assert.ok(request, '向父层宿主要导出');
  h.handlers.get('shot:editor-export-reply')({ sender: parentHost.webContents, senderFrame: parentHost.webContents.mainFrame },
    request.args ? request.args[0].id : request.payload.id, true, { token: parentDoc.token, png: editedHeader(parentDoc.width, parentDoc.height) });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(h.copied.length, 1);
});

test('子层活跃时父层 renderer 的提交/导出回包都不得对子层生效', async () => {
  const h = await editWindow();
  await h.invoke('shot:edit-source', EDIT_RECT, undefined);
  const parentHost = h.windows.at(-1);
  const childWin = await nestedStart(h);
  await readyOn(h, childWin);
  const childDoc = await h.invokeOn(childWin, 'shot:edit-source', EDIT_RECT, undefined);
  const commitsBefore = h.copied.length;
  const parentToken = (parentHost.sent ?? []).find(item => item.channel === 'shot:editor-open').args[0].token;
  const shows = parentHost.shows;
  assert.equal(parentHost.isVisible(), false);
  await assert.rejects(h.handlers.get('shot:editor-close')(
    { sender: parentHost.webContents, senderFrame: parentHost.webContents.mainFrame }, { token: parentToken }), /失效/);
  assert.equal(parentHost.isVisible(), false, '迟到 close 不能显示挂起父窗');
  assert.equal(parentHost.shows, shows);
  assert.equal(h.getCurrent().editDocument.token, childDoc.token);
  // 父层宿主直接发提交：会话不归它，拒绝。
  await assert.rejects(h.handlers.get('shot:editor-commit')(
    { sender: parentHost.webContents, senderFrame: parentHost.webContents.mainFrame },
    'copy', { token: (parentHost.sent ?? []).find(item => item.channel === 'shot:editor-open').args[0].token, png: editedHeader(10, 10) }),
    /已失效/);
  assert.equal(h.copied.length, commitsBefore);
  assert.equal(h.getCurrent().editDocument.token, childDoc.token, '子层文档没被动过');
  h.api.cancel();
});

test('编辑宿主握手未完成：第二次打开、提交、叠层都被挡下，就绪后继续', async () => {
  const h = await selectingWindow({ displays: [EDIT_DISPLAY], deferEditorReady: true });
  const overlay = h.windows[0];
  const opening = h.invoke('shot:edit-source', EDIT_RECT, undefined);
  await new Promise(resolve => setImmediate(resolve));
  const editor = h.windows.at(-1);
  assert.equal(h.getCurrent().editorOpening, true, '交接中标记在');
  assert.equal(overlay.isVisible(), true, '就绪前原选区窗仍在上屏');
  // 半熟悉阶段：再次打开、提交、叠层都拒绝，不出现两层编辑。
  await assert.rejects(h.invoke('shot:edit-source', EDIT_RECT, undefined), /正在打开/);
  await assert.rejects(h.invoke('shot:commit', EDIT_RECT, 'copy'), /正在打开/);
  await h.api.start({ hideControl: false, nested: true });
  assert.equal(h.windows.length, 2, '叠层被拒，没有新建子窗');
  h.readyEditor();
  await opening;
  assert.equal(h.getCurrent().editorOpen, true);
  assert.equal(overlay.isVisible(), false, '就绪后才收起原窗');
  assert.equal(editor.isVisible(), true);
  h.api.cancel();
});

test('识别入口在独立编辑窗里同样只认它的主 frame 与当前文档 token', async () => {
  const h = await editWindow();
  const doc = await h.invoke('shot:edit-source', EDIT_RECT, undefined);
  const editor = h.windows.at(-1);
  const handle = h.handlers.get('shot:recognize-text');
  const ev = { sender: editor.webContents, senderFrame: editor.webContents.mainFrame };
  // 伪 sender / 伪 frame：连参数校验都不该走到，直接报失效。
  await assert.rejects(async () => handle({ sender: {}, senderFrame: {} }, { token: doc.token }), /失效/);
  await assert.rejects(async () => handle({ sender: editor.webContents, senderFrame: {} }, { token: doc.token }), /失效/);
  // 真 sender 但参数无效：报的是参数/格式错误，证明编辑窗授权已放行。
  await assert.rejects(async () => handle(ev, { token: doc.token }), /参数无效|格式无效/);
  await assert.rejects(async () => handle(ev, { token: 'foreign', png: [] }), /失效/);
  h.api.cancel();
});

test('导出期间锁阶段：F1/右键退出/渲染层取消都插不进来；强制换轮后旧回包不写剪贴板也不改新会话', async () => {
  const h = await editWindow();
  const doc = await h.invoke('shot:edit-source', EDIT_RECT, undefined);
  await h.invoke('shot:edit-state', doc.token, 'close');
  const host = h.windows.at(-1);
  const pending = h.invoke('shot:commit', EDIT_RECT, 'copy');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.getCurrent().phase, 'exporting', '导出期间锁成 exporting');
  const request = (host.sent ?? []).filter(item => item.channel === 'shot:editor-export').at(-1).args[0];
  // F1：只报忙，不新开窗、不重建会话。
  const before = h.windows.length;
  await h.api.start({ hideControl: false });
  assert.equal(h.windows.length, before);
  assert.match(h.statuses.at(-1).message, /正在向编辑窗口取导出结果/);
  // 渲染层右键/Esc 退出与取消都被拒，阶段不变。
  await assert.rejects(h.invoke('shot:request-exit', doc.token, 'context-menu'), /当前没有可退出的成图/);
  await h.invoke('shot:cancel', 'cancelled');
  assert.equal(h.api.isActive(), true);
  assert.equal(h.getCurrent().phase, 'exporting');
  // 强制结束整轮：在途导出当场作废，不写任何东西。
  h.api.cancel();
  await assert.rejects(pending, /编辑窗口已关闭|已结束|已切换/);
  assert.equal(h.copied.length, 0);
  assert.equal(h.writes.length, 0);
  // 新会话照常开始；旧回包既进不来，也不能改新会话。
  await h.api.start({ hideControl: false });
  const freshWin = h.windows.at(-1);
  await readyOn(h, freshWin);
  assert.equal(h.getCurrent().phase, 'selecting');
  assert.throws(() => h.handlers.get('shot:editor-export-reply')(
    { sender: host.webContents, senderFrame: host.webContents.mainFrame }, request.id, true,
    { token: doc.token, png: editedHeader(20, 20) }), /已失效|导出请求已失效/);
  assert.equal(h.copied.length, 0);
  assert.equal(h.getCurrent().phase, 'selecting');
  h.api.cancel();
});

test('重开已有编辑时原窗无法收起，回滚不销毁已有宿主', async () => {
  const h = await editWindow();
  const doc = await h.invoke('shot:edit-source', EDIT_RECT);
  const editor = h.windows.at(-1), overlay = h.windows[0];
  await h.invoke('shot:edit-state', doc.token, 'close');
  const hide = overlay.hide; overlay.hide = () => {};
  await assert.rejects(h.invoke('shot:edit-state', doc.token, 'open'), /没能收起/);
  assert.equal(editor.isDestroyed(), false);
  assert.equal(editor.isVisible(), false);
  assert.equal(h.getCurrent().editDocument.token, doc.token);
  overlay.hide = hide;
  await h.invoke('shot:edit-state', doc.token, 'open');
  assert.equal(h.windows.at(-1), editor);
  h.api.cancel();
});

test('子层预览后重新框选只清子文档，父编辑窗仍活', async () => {
  const h = await editWindow();
  const parent = await h.invoke('shot:edit-source', EDIT_RECT);
  const parentHost = h.windows.at(-1);
  const child = await nestedStart(h); await readyOn(h, child);
  const doc = await h.invokeOn(child, 'shot:edit-source', EDIT_RECT);
  const childHost = h.windows.at(-1);
  await h.invokeOn(child, 'shot:edit-state', doc.token, 'close');
  await h.invokeOn(child, 'shot:edit-state', doc.token, 'discard');
  assert.equal(childHost.isDestroyed(), true);
  assert.equal(parentHost.isDestroyed(), false);
  h.api.cancel();
  assert.equal(h.getCurrent().editDocument.token, parent.token);
  h.api.cancel();
});

test('编辑器成功返回预览时取消在途 OCR', async () => {
  const { h, source } = await openEditorSession();
  const editor = h.windows.at(-1);
  const pending = editorOcr(h, source.token);
  assert.equal(h.ocrSpawns.length, 1);
  const payload = { token: source.token, thumbnail: 'data:image/png;base64,' + editedHeader(source.width, source.height).toString('base64'), outputSize: { width: source.width, height: source.height } };
  await h.handlers.get('shot:editor-close')({ sender: editor.webContents, senderFrame: editor.webContents.mainFrame }, payload);
  await assert.rejects(pending, /文字识别已取消/);
  assert.equal(h.ocrSpawns[0].child.killed, 1);
  h.api.cancel();
});

test('返回预览验证缩略图、输出尺寸与裁切，坏数据不显示原窗', async () => {
  const h = await editWindow();
  const doc = await h.invoke('shot:edit-source', EDIT_RECT);
  const editor = h.windows.at(-1), overlay = h.windows[0];
  const close = h.handlers.get('shot:editor-close');
  const event = { sender: editor.webContents, senderFrame: editor.webContents.mainFrame };
  const valid = { token: doc.token, thumbnail: 'data:image/png;base64,' + editedHeader(doc.width, doc.height).toString('base64'), outputSize: { width: doc.width, height: doc.height } };
  for (const bad of [
    { ...valid, thumbnail: 'data:image/png;base64,!!!!' },
    { ...valid, thumbnail: 'data:image/png;base64,' + 'A'.repeat(4500000) },
    { ...valid, thumbnail: 'data:image/png;base64,' + editedHeader(1001, 1).toString('base64') },
    { ...valid, outputSize: { width: 1, height: 1 } },
    { ...valid, crop: { x: -1, y: 0, width: 1, height: 1 } }
  ]) {
    await assert.rejects(close(event, bad));
    assert.equal(h.getCurrent().editorOpen, true);
    assert.equal(overlay.isVisible(), false);
    assert.equal(editor.isVisible(), true);
  }
  const send = overlay.webContents.send;
  overlay.webContents.send = () => { throw new Error('send failed'); };
  await assert.rejects(close(event, valid), /send failed/);
  assert.equal(h.getCurrent().editorOpen, true);
  assert.equal(overlay.isVisible(), false);
  assert.equal(editor.isVisible(), true);
  overlay.webContents.send = send;
  await close(event, valid);
  assert.equal(h.getCurrent().editorOpen, false);
  assert.equal(overlay.isVisible(), true);
  h.api.cancel();
});

test('OCR 只允许当前编辑主 frame：原选区和挂起父窗冒用子 token 都拒绝', async () => {
  const h = await editWindow();
  await h.invoke('shot:edit-source', EDIT_RECT);
  const parentHost = h.windows.at(-1);
  const child = await nestedStart(h); await readyOn(h, child);
  const doc = await h.invokeOn(child, 'shot:edit-source', EDIT_RECT);
  const handler = h.handlers.get('shot:recognize-text');
  for (const win of [parentHost, child]) {
    await assert.rejects(handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ocrPayload(doc.token)), /失效/);
  }
  assert.equal(h.ocrSpawns.length, 0);
  h.api.cancel(); h.api.cancel();
});

// —— 成图退出确认（右键 / Esc）：只有明确确认才丢，拒绝、失败、换轮一律保留 ——
test('成图右键申请退出：确认消息发给当前选区窗，保留不动会话', async () => {
  const h = await selectingWindow();
  const current = h.getCurrent(), win = h.windows[0];
  h.setLongOutput();
  const longImage = current.longImage;
  const pending = h.invoke('shot:request-exit', 'long-token', 'context-menu');
  const id = exitPrompt(h, win);
  await exitReply(h, win, id, 'ready');
  await exitReply(h, win, id, 'keep');
  assert.equal(await pending, false);
  assert.equal(h.messageBoxes.length, 0, '不使用系统对话框');
  assert.deepEqual(win.sent.filter(item => item.channel === 'shot:exit-confirmation').map(item => [item.args[0].id, item.args[0].open]), [[id, true], [id, false]]);
  assert.equal(h.getCurrent(), current); assert.equal(current.phase, 'selecting', '保留后恢复原阶段');
  assert.equal(current.longImage, longImage, '长图原样保留');
  assert.equal(win.isDestroyed(), false); assert.equal(h.api.isActive(), true);
  h.api.cancel();
});
test('确认放弃后按原取消语义结束，并留一条确认记录', async () => {
  const rows = [];
  const h = await selectingWindow({ messageBoxResponse: 1, onLifecycle: (event, fields) => rows.push({ event, ...fields }) });
  h.setLongOutput();
  const pending = h.invoke('shot:request-exit', 'long-token', 'escape-key');
  const win = h.windows[0], id = exitPrompt(h, win);
  await exitReply(h, win, id, 'ready'); await exitReply(h, win, id, 'discard');
  assert.equal(await pending, true);
  assert.equal(h.api.isActive(), false, '确认后才结束会话');
  assert.equal(h.windows[0].isDestroyed(), true);
  assert.match(h.statuses.at(-1).message, /已取消截图/);
  assert.deepEqual(rows.filter(row => row.event === 'capture-exit').map(row => row.choice), ['discard']);
  const end = rows.filter(row => row.event === 'capture-end').at(-1);
  assert.equal(end.reason, 'cancelled'); assert.equal(end.phase, 'selecting', '收尾留痕的 phase 与直接取消一致');
});
test('确认消息发送失败或页面崩溃均按保留结果结算', async () => {
  for (const mode of ['send', 'crash']) {
    const h = await selectingWindow(), win = h.windows[0];
    h.setLongOutput();
    const send = win.webContents.send;
    if (mode === 'send') win.webContents.send = () => { throw new Error('send failed'); };
    const pending = h.invoke('shot:request-exit', 'long-token', 'context-menu');
    if (mode === 'crash') win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.equal(await pending, false);
    if (mode === 'send') {
      assert.equal(h.api.isActive(), true); assert.equal(h.getCurrent().phase, 'selecting');
      assert.ok(h.getCurrent().longImage);
    } else assert.equal(h.api.isActive(), false, '原有 renderer 崩溃处理收回失效窗口');
    win.webContents.send = send; h.api.cancel();
  }
});
test('退出申请只认主 frame、白名单来源和当前文档 token', async () => {
  const h = await editWindow();
  const win = h.windows[0];
  await assert.rejects(h.invoke('shot:request-exit', 'long-token', 'context-menu'), /可退出的成图/, '没有成图不接申请');
  h.setLongOutput();
  await assert.rejects(h.invoke('shot:request-exit', 'long-token', 'window-close'), /无效的退出请求/, '只认白名单来源');
  await assert.rejects(h.invoke('shot:request-exit', 'fake-token', 'context-menu'), /已失效/);
  await assert.rejects(h.handlers.get('shot:request-exit')({ sender: win.webContents, senderFrame: {} }, 'long-token', 'context-menu'), /选区会话已失效/, 'iframe 等非主 frame 被拒');
  assert.equal(h.messageBoxes.length, 0, '被拒的请求一个框都不弹');
  // 有编辑文档时只认文档 token；editorOpen=true 也允许申请（原生宿主后续复用同一 helper）。
  const doc = await h.invoke('shot:edit-source', EDIT_RECT, undefined);
  assert.equal(h.getCurrent().editorOpen, true);
  await assert.rejects(h.invoke('shot:request-exit', 'long-token', 'context-menu'), /已失效/);
  const pending = h.invoke('shot:request-exit', doc.token, 'context-menu');
  const editor = h.windows.at(-1), id = exitPrompt(h, editor);
  await exitReply(h, editor, id, 'ready'); await exitReply(h, editor, id, 'keep');
  assert.equal(await pending, false);
  assert.equal(h.getCurrent().editDocument.token, doc.token);
  h.api.cancel();
});
test('确认中不重弹：F1、提交与重复申请都被挡，Escape 也不结束会话', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, deferMessageBox: true });
  await h.api.start({ hideControl: false }); await h.invoke('shot:init'); await h.invoke('shot:ready');
  h.setLongOutput();
  const current = h.getCurrent();
  const pending = h.invoke('shot:request-exit', 'long-token', 'context-menu');
  await new Promise(resolve => setImmediate(resolve));
  const win = h.windows[0], id = exitPrompt(h, win);
  assert.equal(current.phase, 'exit-confirming', '临时阶段挡住重入');
  await assert.rejects(h.invoke('shot:request-exit', 'long-token', 'escape-key'), /可退出的成图/);
  await assert.rejects(h.invoke('shot:commit', { x: 0, y: 0, width: 10, height: 10 }, 'copy'), /无效截图请求/);
  await h.api.start({ hideControl: false });
  assert.match(h.statuses.at(-1).message, /等待退出确认/);
  assert.equal(h.getCurrent(), current, 'F1 不换轮、不唤回');
  let prevented = 0;
  h.windows[0].webContents.emit('before-input-event', { preventDefault: () => { prevented += 1; } }, { key: 'Escape', type: 'keyDown', isAutoRepeat: false });
  assert.equal(prevented, 1); assert.equal(h.api.isActive(), true, '确认中的 Esc 不结束会话');
  assert.equal(win.sent.filter(item => item.channel === 'shot:exit-confirmation' && item.args[0].open).length, 1);
  await exitReply(h, win, id, 'ready');
  await exitReply(h, win, id, 'keep');
  assert.equal(await pending, false);
  assert.equal(current.phase, 'selecting', '保留后回到选择态');
  h.api.cancel();
});
test('确认中旧轮消失：迟到的放弃不结束新一轮，也不改写它的阶段', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, deferMessageBox: true });
  await h.api.start({ hideControl: false }); await h.invoke('shot:init'); await h.invoke('shot:ready');
  h.setLongOutput();
  const old = h.getCurrent();
  const pending = h.invoke('shot:request-exit', 'long-token', 'context-menu');
  await new Promise(resolve => setImmediate(resolve));
  h.api.cancel();
  assert.equal(h.api.isActive(), false);
  await h.api.start({ hideControl: false });
  const freshWin = h.windows.at(-1); await readyOn(h, freshWin);
  const fresh = h.getCurrent(); assert.notEqual(fresh, old);
  assert.equal(await pending, false, '旧轮释放时立即按保留结束');
  assert.equal(h.api.isActive(), true); assert.equal(h.getCurrent(), fresh);
  assert.equal(fresh.phase, 'selecting', '新轮阶段不被旧轮 finally 覆盖');
  assert.equal(freshWin.isDestroyed(), false);
  h.api.cancel();
});
test('保存中不弹退出确认；嵌套子成图的确认挂子窗并回到父页', async () => {
  const h = await selectingWindow();
  h.setLongOutput(); h.setPhase('saving');
  await assert.rejects(h.invoke('shot:request-exit', 'long-token', 'context-menu'), /可退出的成图/);
  assert.equal(h.messageBoxes.length, 0, '保存中不弹框');
  h.setPhase('selecting'); h.api.cancel();

  const nested = await selectingWindow();
  const parent = nested.getCurrent(), parentWin = nested.windows[0];
  const childWin = await nestedStart(nested); await readyOn(nested, childWin);
  nested.setLongOutput();
  const pending = nested.invokeOn(childWin, 'shot:request-exit', 'long-token', 'escape-key');
  const id = exitPrompt(nested, childWin);
  await exitReply(nested, childWin, id, 'ready'); await exitReply(nested, childWin, id, 'discard');
  assert.equal(await pending, true);
  assert.equal(nested.getCurrent(), parent, '确认放弃后回到父页');
  assert.equal(parentWin.isVisible(), true);
  assert.equal(nested.messageBoxes.length, 0, '不创建系统对话框');
  assert.match(nested.statuses.at(-1).message, /已取消截图/);
});
test('确认 ready 后 F1 套娃，挂起父回复拒绝，子取消后原确认仍等待', async () => {
  const h = await selectingWindow(); h.setLongOutput();
  const parent = h.getCurrent(), win = h.windows[0];
  const pending = h.invoke('shot:request-exit', 'long-token', 'context-menu');
  const id = exitPrompt(h, win);
  await assert.rejects(exitReply(h, win, id, 'discard'), /尚未就绪/);
  await assert.rejects(exitReply(h, win, 'wrong', 'ready'), /失效/);
  await assert.rejects(Promise.resolve().then(() => h.handlers.get('shot:exit-confirmation-reply')({ sender: win.webContents, senderFrame: {} }, id, 'ready')), /失效/);
  await exitReply(h, win, id, 'ready');
  await assert.rejects(exitReply(h, win, id, 'ready'), /已就绪/);
  parent.longToken = 'changed';
  await assert.rejects(exitReply(h, win, id, 'discard'), /失效/);
  parent.longToken = 'long-token';
  const child = await nestedStart(h); await readyOn(h, child);
  await assert.rejects(exitReply(h, win, id, 'discard'), /失效/);
  assert.notEqual(h.getCurrent(), parent);
  h.api.cancel();
  assert.equal(h.getCurrent(), parent); assert.equal(parent.phase, 'exit-confirming');
  assert.equal(win.sent.filter(item => item.channel === 'shot:exit-confirmation' && !item.args[0].open).length, 0);
  await exitReply(h, win, id, 'keep'); assert.equal(await pending, false);
  await assert.rejects(exitReply(h, win, id, 'discard'), /失效/);
  h.api.cancel();
});

test('确认未 ready 超时只保留，旧 ready 不能重开', async () => {
  const h = await selectingWindow(); h.setLongOutput();
  const win = h.windows[0], current = h.getCurrent();
  const pending = h.invoke('shot:request-exit', 'long-token', 'context-menu');
  const id = exitPrompt(h, win);
  assert.equal(current.exitPrompt.timer.ms, 5000);
  current.exitPrompt.timer.fn();
  assert.equal(await pending, false);
  assert.equal(h.getCurrent(), current); assert.equal(current.phase, 'selecting');
  assert.equal(current.exitPrompt, null);
  await assert.rejects(exitReply(h, win, id, 'ready'), /失效/);
  h.api.cancel();
});

test('确认父在子准备期按 Esc 取消子准备，返回原 modal', async () => {
  const h = await selectingWindow(); h.setLongOutput();
  const current = h.getCurrent(), win = h.windows[0];
  const pending = h.invoke('shot:request-exit', 'long-token', 'context-menu');
  const id = exitPrompt(h, win); await exitReply(h, win, id, 'ready');
  h.setDeferSnapshot(true);
  const start = h.api.start({ hideControl: false, nested: true });
  await new Promise(resolve => setImmediate(resolve));
  let prevented = 0;
  win.webContents.emit('before-input-event', { preventDefault: () => { prevented++; } }, { key: 'Escape', type: 'keyDown', isAutoRepeat: false });
  await start;
  assert.equal(prevented, 1); assert.equal(h.getCurrent(), current); assert.equal(current.phase, 'exit-confirming');
  await exitReply(h, win, id, 'keep'); assert.equal(await pending, false); h.api.cancel();
});

test('跨屏确认 ready 后叠层复制，返回时确认仍打开', async () => {
  const h = await selectingWindow({ displays: [
    { id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 800, y: 0, width: 800, height: 600 }, scaleFactor: 1 }] });
  h.setLongOutput();
  const parent = h.getCurrent(), win = h.windows[0];
  const pending = h.invoke('shot:request-exit', 'long-token', 'context-menu');
  const id = exitPrompt(h, win); await exitReply(h, win, id, 'ready');
  const child = await nestedStart(h); await readyOn(h, child);
  const result = await h.invokeOn(child, 'shot:commit', { x: 0, y: 0, width: 10, height: 10 }, 'copy');
  assert.equal(result.ok, true);
  assert.equal(h.getCurrent(), parent); assert.equal(parent.phase, 'exit-confirming');
  assert.equal(win.sent.filter(item => item.channel === 'shot:exit-confirmation' && !item.args[0].open).length, 0);
  await exitReply(h, win, id, 'keep'); assert.equal(await pending, false); h.api.cancel();
});

test('跨屏成图的 Esc 也交给页面走确认，主进程不再直接丢弃', async () => {
  const h = await selectingWindow({ displays: [
    { id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 800, y: 0, width: 800, height: 600 }, scaleFactor: 1 }] });
  assert.equal(h.getCurrent().mode, 'desktop');
  h.setLongOutput();
  const longImage = h.getCurrent().longImage;
  let prevented = 0;
  h.windows[0].webContents.emit('before-input-event', { preventDefault: () => { prevented += 1; } }, { key: 'Escape', type: 'keyDown', isAutoRepeat: false });
  assert.equal(prevented, 0, '首次 Esc 不拦，留给渲染层申请确认');
  assert.equal(h.api.isActive(), true);
  assert.equal(h.getCurrent().longImage, longImage, '成图没被直接丢掉');
  h.api.cancel();
});

test('交接成功后 F1 仍可叠一层：父文档/宿主不动，子图结束回父', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, deferEditorReady: true });
  const { current, packet } = await longResultPacket(h);
  const opening = h.hooks.onLongResult(packet);
  await tickOnce();
  const hostWin = h.windows.at(-1);
  const doc = current.editDocument;
  h.handlers.get('shot:editor-ready')({ sender: hostWin.webContents, senderFrame: hostWin.webContents.mainFrame }, doc.token);
  assert.equal(await opening, true);
  const windowsBefore = h.windows.length;
  const childWin = await nestedStart(h);
  assert.equal(h.windows.length, windowsBefore + 1, 'F1 叠了一层');
  assert.notEqual(h.getCurrent(), current, '子会话当班');
  await readyOn(h, childWin);
  await h.invokeOn(childWin, 'shot:cancel', 'escape-key');
  assert.equal(h.getCurrent(), current, '子取消回父');
  assert.equal(current.editDocument, doc, '父文档原样');
  assert.equal(current.longImage, packet.image, '父成图原样');
  assert.equal(hostWin.isVisible(), true, '父成图窗口回来了');
  assert.equal(hostWin.isDestroyed(), false);
  h.api.cancel();
});

test('成图窗口里的保存/复制走同一套提交：未编辑长图也按同一份文档尺寸校验', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, deferEditorReady: true });
  const { packet } = await longResultPacket(h);
  const opening = h.hooks.onLongResult(packet);
  await tickOnce();
  const hostWin = h.windows.at(-1);
  const doc = h.getCurrent().editDocument;
  h.handlers.get('shot:editor-ready')({ sender: hostWin.webContents, senderFrame: hostWin.webContents.mainFrame }, doc.token);
  assert.equal(await opening, true);
  const event = { sender: hostWin.webContents, senderFrame: hostWin.webContents.mainFrame };
  const copied = await h.handlers.get('shot:editor-commit')(event, 'copy', { token: doc.token, png: editedHeader(8, 600) });
  assert.equal(copied.ok, true, JSON.stringify(copied));
  assert.equal(h.copied.length, 1, '未编辑就按原图尺寸复制');
  h.api.cancel();
});

test('成图窗口的退出申请走同一套浅绿确认：保留不动草稿，放弃才结束', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, deferEditorReady: true });
  const { packet } = await longResultPacket(h);
  const opening = h.hooks.onLongResult(packet);
  await tickOnce();
  const hostWin = h.windows.at(-1);
  const doc = h.getCurrent().editDocument;
  h.handlers.get('shot:editor-ready')({ sender: hostWin.webContents, senderFrame: hostWin.webContents.mainFrame }, doc.token);
  assert.equal(await opening, true);
  const event = { sender: hostWin.webContents, senderFrame: hostWin.webContents.mainFrame };
  const confirmOf = () => hostWin.sent.filter(row => row.channel === 'shot:exit-confirmation').at(-1).args[0];

  const kept = h.handlers.get('shot:editor-exit-request')(event, doc.token, 'escape-key');
  await tickOnce();
  const first = confirmOf();
  assert.equal(first.open, true, '确认面板发给成图窗口本身');
  assert.equal(h.getCurrent().phase, 'exit-confirming');
  assert.equal(h.getCurrent().editDocument, doc, '确认期间文档不动');
  h.handlers.get('shot:exit-confirmation-reply')(event, first.id, 'ready');
  h.handlers.get('shot:exit-confirmation-reply')(event, first.id, 'keep');
  assert.equal(await kept, false);
  assert.equal(h.api.isActive(), true);
  assert.equal(h.getCurrent().phase, 'selecting');
  assert.equal(hostWin.isDestroyed(), false);

  const dropped = h.handlers.get('shot:editor-exit-request')(event, doc.token, 'context-menu');
  await tickOnce();
  const second = confirmOf();
  h.handlers.get('shot:exit-confirmation-reply')(event, second.id, 'ready');
  h.handlers.get('shot:exit-confirmation-reply')(event, second.id, 'discard');
  assert.equal(await dropped, true);
  assert.equal(h.api.isActive(), false, '确认放弃才结束整轮');
  assert.equal(hostWin.isDestroyed(), true);
});

// —— 长截图完成 → 普通成图窗口（presentation='long-result'）——
// 长截会话把成图交过来：这里只模拟 scrolling.cjs 的交接调用，真实解码/校验在各自己的用例里。
const longResultPacket = async (h) => {
  await h.api.start({ hideControl: false });
  await h.invoke('shot:init');
  await h.invoke('shot:ready');
  const current = h.getCurrent();
  const image = { getSize: () => ({ width: 8, height: 600 }), toPNG: () => Buffer.from('long-png'),
    toDataURL: () => 'data:image/png;base64,long-result' };
  current.longImage = image;
  current.longToken = 'long-token';
  current.longPreviewPending = true;
  return { current, image, rect: { x: 0, y: 0, width: 4, height: 3 },
    packet: { current, token: 'long-token', image, size: { width: 8, height: 600 }, preview: 'data:image/png;base64,thumb',
      warning: '仅保留已接部分', rect: { x: 0, y: 0, width: 4, height: 3 } } };
};
const tickOnce = () => new Promise(resolve => setImmediate(resolve));

test('长截图完成交接：先收起旧窗再开成图窗口，成功后保持收起并清待出预览', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, deferEditorReady: true });
  const { current, image, rect, packet } = await longResultPacket(h);
  const overlay = h.windows[0];
  const hideOrder = [];
  const realHide = overlay.hide.bind(overlay);
  overlay.hide = () => { hideOrder.push({ windows: h.windows.length }); realHide(); };
  assert.equal(overlay.isVisible(), true, '开窗前旧窗在显示');
  const opening = h.hooks.onLongResult(packet);
  assert.equal(hideOrder.length, 1, '交接一开始就收起旧窗');
  assert.equal(hideOrder[0].windows, 1, '收起旧窗时成图窗口还没建：先 hide 再 open');
  assert.equal(overlay.isVisible(), false);
  await tickOnce();
  const hostWin = h.windows.at(-1);
  assert.notEqual(hostWin, overlay, '成图窗口是新开的普通窗');
  const doc = current.editDocument;
  assert.ok(doc, '交接中已登记新文档');
  assert.equal(doc.presentation, 'long-result');
  assert.equal(doc.longToken, 'long-token');
  assert.deepEqual({ ...doc.rect }, rect, '原选区留在主进程');
  assert.deepEqual({ ...doc.pixels }, { x: 0, y: 0, width: 8, height: 6 }, '按原选区与冻结基准重算像素');
  assert.deepEqual({ width: doc.width, height: doc.height }, { width: 8, height: 600 });
  assert.equal(typeof opening.then, 'function', '交接是异步的（等宿主就绪）');
  assert.equal(current.phase, 'selecting');
  h.handlers.get('shot:editor-ready')({ sender: hostWin.webContents, senderFrame: hostWin.webContents.mainFrame }, doc.token);
  assert.equal(await opening, true);
  assert.equal(current.editDocument, doc, '文档身份不变');
  assert.equal(current.editorOpen, true);
  assert.equal(current.longPreviewPending, false, '新宿主就绪后才清待出预览');
  assert.equal(overlay.isVisible(), false, '旧选区窗只收起不销毁');
  assert.equal(overlay.isDestroyed(), false);
  assert.equal(current.longImage, image, '成图仍归会话');
  const sent = hostWin.sent.filter(row => row.channel === 'shot:editor-open').at(-1);
  assert.equal(sent.args[0].presentation, 'long-result');
  assert.equal(sent.args[0].longToken, 'long-token');
  assert.equal(sent.args[0].warning, '仅保留已接部分');
  assert.equal(sent.args[0].dataUrl, 'data:image/png;base64,long-result');
  h.api.cancel();
  assert.equal(hostWin.isDestroyed(), true, '结束后才收掉宿主');
});

test('交接失败：清新文档与宿主，保留成图，返回 false 交给旧预览回退', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, editorReadyFails: true });
  const { current, image, packet } = await longResultPacket(h);
  const overlay = h.windows[0];
  const opening = h.hooks.onLongResult(packet);
  await tickOnce(); await tickOnce();
  const hostWin = h.windows.at(-1);
  assert.equal(await opening, false);
  assert.equal(current.editDocument, undefined, '失败不留下半成品文档');
  assert.equal(current.longImage, image, '成图不能因交接失败被销毁');
  assert.equal(current.longToken, 'long-token');
  assert.equal(current.longPreviewPending, true, '仍是旧预览的待出状态，交给回退路径');
  assert.ok(!current.editorOpen, '没假装已进入编辑');
  assert.equal(hostWin.isDestroyed(), true, '半成品宿主被收掉');
  assert.equal(overlay.isVisible(), true, '旧窗仍在，可继续显示回退预览');
  h.api.cancel();
});

test('交接期间 F1/重复交接都被挡住，不会叠出第二层', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, deferEditorReady: true });
  const { current, packet } = await longResultPacket(h);
  const windowsBefore = h.windows.length;
  const opening = h.hooks.onLongResult(packet);
  await tickOnce();
  await h.api.start({ hideControl: false, nested: true });
  assert.match(h.statuses.at(-1).message, /编辑正在打开|稍等/);
  assert.equal(h.windows.length, windowsBefore + 1, '只多出那一扇成图窗');
  assert.equal(h.getCurrent(), current, '没有换轮');
  // 第二次交接：已有文档，不抢。
  assert.equal(await h.hooks.onLongResult(packet), false);
  const hostWin = h.windows.at(-1);
  h.handlers.get('shot:editor-ready')({ sender: hostWin.webContents, senderFrame: hostWin.webContents.mainFrame }, current.editDocument.token);
  assert.equal(await opening, true);
  h.api.cancel();
});

test('迟到交接不污染已换轮会话（旧轮结束/新轮开始后返回 false）', async () => {
  const h = harness({ platform: 'win32', controlVisible: false, deferEditorReady: true });
  const { current, packet } = await longResultPacket(h);
  const opening = h.hooks.onLongResult(packet);
  await tickOnce();
  const hostWin = h.windows.at(-1);
  const doc = current.editDocument;
  h.api.cancel();
  assert.equal(h.api.isActive(), false);
  // 整轮结束后宿主已经被收掉：迟到 ready 连 sender 都对不上，更不可能把成图接走。
  assert.throws(() => h.handlers.get('shot:editor-ready')({ sender: hostWin.webContents, senderFrame: hostWin.webContents.mainFrame }, doc.token), /已失效/);
  assert.equal(await opening, false, '旧轮已结束就不算交接成功');
  assert.equal(h.api.isActive(), false);
});
