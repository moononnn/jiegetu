'use strict';
// 跨屏普通截图的定向集成测试：用 VM 夹具跑真实的 main/screenshot.cjs，
// 覆盖物理 union 合成、逐屏取帧、跳过 DIP 的回弹复核、视口基准裁切与各类拒绝路径。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const { toPixels } = require('../core/coordinates.cjs');
const { createDesktopFrame, blitDesktopFrame } = require('../core/desktop-frame.cjs');
const { fitDesktopWindow, checkDesktopWindow } = require('../main/win-capture.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (predicate, label) => {
  for (let index = 0; index < 500; index += 1) { if (predicate()) return; await tick(); }
  throw new Error(`等待超时：${label}`);
};
const key = rect => `${rect.x},${rect.y},${rect.width},${rect.height}`;
// 每屏一条确定性的 RGBA 真值：合成后必须逐字节等于「按屏换字节序、不缩放」的结果。
const sourcePixel = (index, x, y) => [(x * 3 + y * 5 + index * 50) & 255, (index * 40) & 255, (x * 7 + y * 11) & 255, 255];

// 极小的两屏几何：A 4×2@(0,0)，B 3×2@(4,2)，union 7×4，中间和两屏之间留有黑色空洞。
const TINY = [
  { id: 11, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 },
    physical: { x: 0, y: 0, width: 4, height: 2 }, workPhysical: { x: 0, y: 0, width: 4, height: 1 } },
  { id: 22, scaleFactor: 1.25, bounds: { x: 1920, y: 548, width: 1536, height: 864 }, workArea: { x: 1920, y: 548, width: 1536, height: 816 },
    physical: { x: 4, y: 2, width: 3, height: 2 }, workPhysical: { x: 4, y: 2, width: 3, height: 1 } }
];
// 真实尺寸的两屏：primary 200% 3840×2160@(0,0)；secondary 125% DIP 1920×274 / 1536×865
// （本机真实回读）→ 物理 1920×1080@(3840,548)。DIP 高 865 × 1.25 = 1081.25，与物理 1080 不整除，
// 正是「物理矩形只能信原生查询、不能由 bounds × scaleFactor 推」的现场；旧夹具把 DIP y 写成了物理的 548，
// 把两套坐标混写在一起，这里改成真实 DIP。workArea 仍为 DIP y 274 / 高 816。
const REAL = [
  { id: 1, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 },
    physical: { x: 0, y: 0, width: 3840, height: 2160 }, workPhysical: { x: 0, y: 0, width: 3840, height: 2064 } },
  { id: 2, scaleFactor: 1.25, bounds: { x: 1920, y: 274, width: 1536, height: 865 }, workArea: { x: 1920, y: 274, width: 1536, height: 816 },
    physical: { x: 3840, y: 548, width: 1920, height: 1080 }, workPhysical: { x: 3840, y: 548, width: 1920, height: 1020 } }
];
// 小几何的合规两屏（长截 owner 用例，只为减内存）：primary 200% DIP 192×108@(0,0)→物理 384×216；
// secondary 125% DIP 192×144@(192,27)→物理 240×180@(384,54)；union 624×234，页面视口 312×117。
const OWNER = [
  { id: 41, scaleFactor: 2, bounds: { x: 0, y: 0, width: 192, height: 108 }, workArea: { x: 0, y: 0, width: 192, height: 108 },
    physical: { x: 0, y: 0, width: 384, height: 216 }, workPhysical: { x: 0, y: 0, width: 384, height: 216 } },
  { id: 42, scaleFactor: 1.25, bounds: { x: 192, y: 27, width: 192, height: 144 }, workArea: { x: 192, y: 27, width: 192, height: 144 },
    physical: { x: 384, y: 54, width: 240, height: 180 }, workPhysical: { x: 384, y: 54, width: 240, height: 180 } }
];
// 同一组几何但副屏在负原点（Windows 真实可出现的左侧/上方屏）。
const NEG_OWNER = [
  { ...OWNER[0] },
  { ...OWNER[1], id: 52, bounds: { x: -192, y: 27, width: 192, height: 144 }, workArea: { x: -192, y: 27, width: 192, height: 144 },
    physical: { x: -240, y: 54, width: 240, height: 180 }, workPhysical: { x: -240, y: 54, width: 240, height: 180 } }
];
// 整链整合用：副屏工作区要真放得下浮条（OWNER 的 192×144 太小，真实代码会要求扩大工作区）。
// primary DIP 192×108@(0,0) → 物理 384×216；secondary DIP 400×296@(192,27) 125% → 物理 500×370@(384,54)。
// union 884×424，页面视口 442×212。
const PANEL = [
  { id: 41, scaleFactor: 2, bounds: { x: 0, y: 0, width: 192, height: 108 }, workArea: { x: 0, y: 0, width: 192, height: 108 },
    physical: { x: 0, y: 0, width: 384, height: 216 }, workPhysical: { x: 0, y: 0, width: 384, height: 216 } },
  { id: 43, scaleFactor: 1.25, bounds: { x: 192, y: 27, width: 400, height: 296 }, workArea: { x: 192, y: 27, width: 400, height: 296 },
    physical: { x: 384, y: 54, width: 500, height: 370 }, workPhysical: { x: 384, y: 54, width: 500, height: 370 } }
];

function harness({ displays = TINY, viewport = { width: 7, height: 4 }, cursor = { x: 0, y: 0 }, deferViewport = false,
  realScrolling = false, deferCapture = -1, captureFails = -1,
  fitMode = 'ok', checkMode = 'ok', settings, probeBusy = false,
  // 上屏几何：fitBounds 模拟原生 fit 真的把窗口撑到 union DIP；shrinkOnShow/viewportOnShow
  // 模拟 show 之后被系统缩回单屏或视口变了（这两条是 hidden 阶段的 check 看不到的）。
  fitBounds = null, shrinkOnShow = null, viewportOnShow = null,
  // 重入恢复：健康探针默认缺 ready 字段（unknown）；消息框默认保留（response 0）。
  probeMode = 'viewport', messageBoxResponse = 0, messageBoxFails = false } = {}) {
  // 页面视口会被跨屏页面 resize 定形：允许运行中改成新值，模拟前后端各自读到的真实 innerWidth/Height。
  let viewportValue = { ...viewport };
  let resolveViewport;
  const viewportProbes = [];
  const windowFits = [], wheelRegions = [], scrollCaptures = [], registrations = [];
  let realScrollingFactory;
  const handlers = new Map(), windows = [], statuses = [], fitCalls = [], checkCalls = [], captures = [];
  const probeCalls = [], messageBoxes = [];
  let currentProbeMode = probeMode;
  const bitmapInputs = [], crops = [], writes = [], clipboardWrites = [], sequence = [], singleFitCalls = [];
  let scrollHooks;
  const specs = displays.map(spec => ({ ...spec, workArea: { ...(spec.workArea ?? spec.bounds) },
    // hint 默认等于 physical；不想等真实坐标（175% 回读多 2px）在夹具里显式给 hint。
    hint: { ...(spec.hint ?? spec.physical) },
    physical: { ...spec.physical },
    workPhysical: { ...(spec.workPhysical ?? spec.physical) },
    workHint: { ...(spec.workHint ?? spec.workPhysical ?? spec.physical) } }));
  let visibleDisplays = specs.map(spec => ({ id: spec.id, bounds: { ...spec.bounds }, scaleFactor: spec.scaleFactor,
    workArea: { ...spec.workArea }, rotation: spec.rotation ?? 0 }));
  const physicalByKey = new Map(specs.map(spec => [key(spec.hint), spec.id]));
  const workByKey = new Map(specs.map(spec => [key(spec.workHint), spec.id]));
  const specById = new Map(specs.map(spec => [spec.id, spec]));
  const specByBounds = new Map(specs.map(spec => [key(spec.bounds), spec]));
  const specByWork = new Map(specs.map(spec => [key(spec.workArea), spec]));
  let releaseCapture;

  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options; this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.isBar = Boolean(options.webPreferences?.preload?.endsWith('scroll-bar-preload.cjs'));
      this.destroyed = false; this.visible = false; this.skipTaskbar = options.skipTaskbar === true;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.invalidate = () => { this.invalidates = (this.invalidates ?? 0) + 1; };
      this.webContents.send = (name, value) => {
        (this.sent ??= []).push({ name, value });
        // 独立编辑宿主：页面就绪握手由夹具代答（真实页面在 editor.open 完成后发 ready）。
        if (name === 'shot:editor-open' && value) {
          queueMicrotask(() => {
            try { handlers.get('shot:editor-ready')?.({ sender: this.webContents, senderFrame: this.webContents.mainFrame }, value.token); }
            catch { /* 代答失败只让被测代码自己超时。 */ }
          });
        }
      };
      this.webContents.executeJavaScript = async code => {
        // 主进程的页面健康探针：只回布尔形状，与视口读取分开夹具。
        if (code.includes('readyState')) {
          probeCalls.push(code);
          if (currentProbeMode === 'reject') throw new Error('探针失败');
          if (currentProbeMode === 'drawable') return { ready: true };
          if (currentProbeMode === 'blocked') return { ready: false };
          return { width: this.bounds.width, height: this.bounds.height };
        }
        // 真实 scrolling 会问提示页是否就绪；其余调用都是主进程读页面视口。
        if (code === 'window.regionMaskReady === true') return true;
        if (code === 'window.startScrollCapture()') return true;
        viewportProbes.push({ ...viewportValue });
        if (deferViewport) await new Promise(resolve => { resolveViewport = resolve; });
        return { ...viewportValue };
      };
      windows.push(this);
    }
    setBounds(bounds) { this.bounds = { ...this.bounds, ...bounds }; }
    getBounds() { return { ...this.bounds }; }
    getContentBounds() { return { ...this.bounds }; }
    getContentSize() { return [this.bounds.width, this.bounds.height]; }
    async loadFile(file, options) { this.file = file; this.loadOptions = options; sequence.push('load'); if (file.endsWith('scroll-mask.html')) this.emit('ready-to-show'); }
    setTitle(value) { this.title = value; }
    getTitle() { return this.title; }
    setIgnoreMouseEvents(value) { this.ignoreMouse = value; }
    setAlwaysOnTop(value, level) { this.alwaysOnTop = { value, level }; }
    isAlwaysOnTop() { return this.alwaysOnTop?.value ?? (this.options.alwaysOnTop === true); }
    setSkipTaskbar(value) { this.skipTaskbar = value; }
    setContentProtection(value) { this.protected = value; }
    isContentProtected() { return Boolean(this.protected); }
    showInactive() { this.visible = true; }
    moveTop() { this.raised = true; }
    isFocused() { return false; }
    getNativeWindowHandle() { const raw = Buffer.alloc(8); raw.writeBigUInt64LE(1234567890n, 0); return raw; }
    show() { this.visible = true; this.shows = (this.shows ?? 0) + 1; sequence.push('show');
      if (shrinkOnShow) this.bounds = { ...shrinkOnShow };
      if (viewportOnShow) viewportValue = { ...viewportOnShow }; }
    hide() { this.visible = false; }
    focus() {}
    minimize() { this.minimized = true; }
    isMinimized() { return Boolean(this.minimized); }
    restore() { this.minimized = false; this.restores = (this.restores ?? 0) + 1; }
    isVisible() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }

  const image = {
    getSize: () => ({ width: 0, height: 0 }), isEmpty: () => false
  };
  const electron = {
    BrowserWindow: Window,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    screen: {
      getAllDisplays: () => visibleDisplays.map(display => ({ ...display, bounds: { ...display.bounds }, workArea: { ...display.workArea } })),
      getDisplayNearestPoint: point => visibleDisplays.find(entry => point.x >= entry.bounds.x && point.x < entry.bounds.x + entry.bounds.width &&
        point.y >= entry.bounds.y && point.y < entry.bounds.y + entry.bounds.height) ?? visibleDisplays[0],
      getCursorScreenPoint: () => ({ ...cursor }),
      dipToScreenRect: (owner, rect) => {
        const byBounds = specByBounds.get(key(rect));
        if (byBounds) return { ...byBounds.hint };
        const byWork = specByWork.get(key(rect));
        if (byWork) return { ...byWork.workHint };
        return undefined;
      }
    },
    nativeImage: {
      createFromBitmap: (pixels, options) => {
        bitmapInputs.push({ pixels: Buffer.from(pixels), options: { ...options } });
        return { getSize: () => ({ width: options.width, height: options.height }), isEmpty: () => false,
          toPNG: () => Buffer.from('composite-png'),
          crop: rect => { crops.push({ ...rect });
            return { getSize: () => ({ width: rect.width, height: rect.height }), toPNG: () => Buffer.from('png'), toDataURL: () => 'data:cropped' }; } };
      },
      createFromBuffer: bytes => ({ isEmpty: () => false, toPNG: () => Buffer.from('edited-png'),
        getSize: () => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }) })
    },
    ClipboardItem: class ClipboardItem { constructor(items) { this.items = items; } },
    clipboard: { write: async values => { clipboardWrites.push(values); } },
    dialog: { showSaveDialog: async () => ({ canceled: true }), showMessageBox: async (ownerOrOptions, maybeOptions) => {
      messageBoxes.push({ parent: maybeOptions === undefined ? undefined : ownerOrOptions, options: maybeOptions === undefined ? ownerOrOptions : maybeOptions });
      if (messageBoxFails) throw new Error('dialog unavailable');
      return { response: messageBoxResponse };
    } },
    globalShortcut: { register: (key, fn) => { registrations.push({ key }); shortcuts.set(key, fn); return true; },
      unregister: key => { shortcuts.delete(key); } },
    desktopCapturer: { getSources: async () => [] }
  };
  const shortcuts = new Map();
  const fakeFs = { mkdir: async () => {}, writeFile: async (file, bytes) => { writes.push({ file, bytes }); } };
  // 真实 scrolling 模块单独建一个 VM：只提供它需要的 electron / 坐标 / 定时器，依赖全部由上面注入。
  const loadRealScrolling = () => {
    if (realScrollingFactory) return realScrollingFactory;
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../main/scrolling.cjs'), 'utf8'), {
      module: mod, exports: mod.exports, Buffer, ArrayBuffer, __dirname: path.resolve(__dirname, '../main'),
      setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {},
      require: name => {
        if (name === 'electron') return electron;
        if (name === '../core/coordinates.cjs') return { toPixels, outsideMask: require('../core/coordinates.cjs').outsideMask };
        if (name === './scroll-cancel.cjs' || name === './scroll-wheel.cjs') throw new Error('测试必须注入纯替身，禁止启动真实输入监听');
        return require(name);
      }
    });
    realScrollingFactory = mod.exports.installScrolling;
    return realScrollingFactory;
  };
  const control = { visible: true, hides: 0, shows: 0, isVisible() { return this.visible; },
    hide() { this.hides += 1; this.visible = false; }, show() { this.shows += 1; this.visible = true; } };

  const exports = {};
  const context = { module: { exports }, exports, Buffer, process: { platform: 'win32', pid: 4321 },
    __dirname: path.resolve(__dirname, '../main'),
    setTimeout: (fn, ms) => { if (ms === 220) queueMicrotask(fn); return { fn, ms, unref() {} }; }, clearTimeout() {},
    require: name => {
      if (name === 'electron') return electron;
      if (name === 'node:buffer') return { Blob: class Blob { constructor(parts) { this.parts = parts; } } };
      if (name === 'node:path') return path;
      if (name === 'node:fs/promises') return fakeFs;
      if (name === 'node:crypto') return require('node:crypto');
      if (name === '../core/coordinates.cjs') return { toPixels, outsideMask: require('../core/coordinates.cjs').outsideMask };
      if (name === '../core/desktop-frame.cjs') return { createDesktopFrame, blitDesktopFrame };
      if (name === './edited-image.cjs') return require('../main/edited-image.cjs');
      if (name === './image-editor-window.cjs') return require('../main/image-editor-window.cjs');
      // 本用例只验跨屏取帧与窗口几何，识别通道不在范围；给它一个固定空实现，不起子进程。
      if (name === './ocr.cjs') return { installOcrIpc: () => ({ cancel: () => false }) };
      if (name === './scrolling.cjs') {
        if (!realScrolling) return { installScrolling: hooks => { scrollHooks = hooks; return { cleanup() {}, finish() {}, captureRequest() {} }; } };
        // 真实 main/scrolling.cjs：只把会碰系统/进程的依赖全部换成替身（采集、窗口拟合、快捷键、方向键、右键监听）。
        return { installScrolling: options => {
          scrollHooks = options;
          return loadRealScrolling()({ ...options,
          createCapture: region => {
            scrollCaptures.push({ ...region });
            return { next: async () => ({ fresh: true, width: region.width, height: region.height,
              data: new Uint8ClampedArray(region.width * region.height * 4) }), stop() {} };
          },
          fitWindow: (win, nonce, bounds, mode) => {
            windowFits.push({ kind: win.isBar ? 'bar' : 'mask', nonce, mode, bounds: { ...bounds }, loadedBefore: Boolean(win.file) });
            return Promise.resolve({ ...bounds });
          },
          createCancelWatcher: () => ({ stop() {} }),
          createWheelScroller: region => { wheelRegions.push({ ...region }); return { stop() {} }; } });
        } };
      }
      if (name === './win-capture.cjs') return {
        handleToDecimal: require('../main/win-capture.cjs').handleToDecimal,
        createWinCapture: (region, options) => {
          const index = captures.length;
          const record = { region: { ...region }, options: { ...options }, stops: 0, index };
          captures.push(record); sequence.push(`capture:${index}`);
          return {
            next: async () => {
              if (index === captureFails) throw new Error('模拟采集失败');
              if (index === deferCapture) await new Promise(resolve => { releaseCapture = resolve; });
              const data = new Uint8ClampedArray(region.width * region.height * 4);
              for (let y = 0; y < region.height; y += 1) for (let x = 0; x < region.width; x += 1) {
                data.set(sourcePixel(index, x, y), (y * region.width + x) * 4);
              }
              return { fresh: true, width: region.width, height: region.height, data };
            },
            stop: () => { record.stops += 1; }
          };
        },
        queryMonitorBounds: hint => {
          const id = physicalByKey.get(key(hint));
          return id === undefined ? Promise.reject(new Error('显示器矩形查询失败')) : Promise.resolve({ ...specById.get(id).physical });
        },
        queryMonitorWorkArea: hint => {
          const id = workByKey.get(key(hint));
          return id === undefined ? Promise.reject(new Error('显示器矩形查询失败')) : Promise.resolve({ ...specById.get(id).workPhysical });
        },
        fitSelectionWindow: (handle, pid, nonce, bounds) => { singleFitCalls.push({ handle, pid, nonce, bounds: { ...bounds } }); return Promise.resolve({ ...bounds }); },
        fitDesktopWindow: (handle, pid, nonce, bounds) => {
          fitCalls.push({ handle, pid, nonce, bounds: { ...bounds } });
          sequence.push('fit');
          if (fitMode === 'reject') return Promise.reject(new Error('窗口物理布局失败'));
          // 原生 fit 是真的改 HWND：夹具里把窗口几何也改掉，show 前后才有可比对象。
          if (fitBounds) { const target = windows.at(-1); if (target) target.bounds = { ...fitBounds }; }
          return Promise.resolve({ ...bounds });
        },
        checkDesktopWindow: (handle, pid, nonce, bounds) => {
          checkCalls.push({ handle, pid, nonce, bounds: { ...bounds } });
          sequence.push('check');
          if (checkMode === 'reject') return Promise.reject(new Error('窗口物理矩形与目标不符'));
          return Promise.resolve({ ...bounds });
        }
      };
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../main/screenshot.cjs'), 'utf8'), context);
  const api = context.module.exports.installScreenshot({ getControl: () => control, isProbeBusy: () => probeBusy,
    directory: path.resolve('test-output-not-written'), settings, onStatus: status => statuses.push(status),
    queryForeground: () => 0 });
  const event = () => ({ sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame });
  const invoke = (name, ...values) => handlers.get(name)(event(), ...values);
  return { api, windows, statuses, fitCalls, singleFitCalls, checkCalls, captures, bitmapInputs, crops, writes, clipboardWrites, sequence, control,
    probeCalls, messageBoxes, setProbe: value => { currentProbeMode = value; },
    invalidates: () => windows.reduce((total, win) => total + (win.invalidates ?? 0), 0),
    invoke, handlers, releaseCapture: () => releaseCapture?.(),
    setViewport: next => { viewportValue = { ...next }; }, viewportProbes: () => viewportProbes,
    resolveViewport: () => resolveViewport?.(),
    windowFits: () => windowFits, wheelRegions: () => wheelRegions, scrollCaptures: () => scrollCaptures, registrations: () => registrations,
    getCurrent: () => scrollHooks?.getActive(), scrollHooks: () => scrollHooks,
    dropDisplay: id => { visibleDisplays = visibleDisplays.filter(display => display.id !== id); },
    patchDisplay: (id, patch) => { visibleDisplays = visibleDisplays.map(display => display.id === id ? { ...display, ...patch } : display); } };
}

test('跨屏：两屏物理矩形拼成 union，逐屏只取一帧且不改字节', async () => {
  const h = harness();
  await h.api.startDesktop();
  assert.equal(h.captures.length, 2, '一屏一次快照');
  assert.deepEqual(h.captures.map(record => ({ ...record.region })), [{ x: 0, y: 0, width: 4, height: 2 }, { x: 4, y: 2, width: 3, height: 2 }]);
  assert.deepEqual(h.captures.map(record => record.options.purpose), ['snapshot', 'snapshot']);
  assert.deepEqual(h.captures.map(record => record.stops), [1, 1], '每个 source 用完立即停止');
  assert.deepEqual({ ...h.bitmapInputs[0].options }, { width: 7, height: 4, scaleFactor: 1 });
  // 逐字节：按屏搬进 union，RGBA→BGRA 只换顺序；空洞保持不透明黑。
  const pixels = h.bitmapInputs[0].pixels;
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 7; x += 1) {
    const offset = (y * 7 + x) * 4;
    const actual = [...pixels.subarray(offset, offset + 4)];
    const insideA = x < 4 && y < 2; const insideB = x >= 4 && y >= 2;
    const [r, g, b, a] = insideA ? sourcePixel(0, x, y) : insideB ? sourcePixel(1, x - 4, y - 2) : [0, 0, 0, 255];
    assert.deepEqual(actual, [b, g, r, a], `像素 (${x},${y}) 必须逐字节等于原值`);
  }
});

test('跨屏：先原生物理 fit、再加载、ready 后纯读复核，缓慢到 show', async () => {
  const h = harness();
  await h.api.startDesktop();
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].visible, false, 'ready 之前不许上屏');
  assert.deepEqual(h.control.visible, false, '跨屏会把设置窗拍进去，先收起');
  assert.equal(h.fitCalls.length, 1);
  assert.deepEqual({ ...h.fitCalls[0].bounds }, { x: 0, y: 0, width: 7, height: 4 });
  assert.equal(h.fitCalls[0].handle, '1234567890');
  assert.equal(h.fitCalls[0].pid, 4321);
  assert.match(h.fitCalls[0].nonce, /^[0-9a-f]{32}$/);
  const fitNonce = h.fitCalls[0].nonce;
  // 两屏采集与建窗并行，所以 fit 可能落在两屏之间；但页面加载前必须先物理 fit，上屏必须在最后。
  assert.deepEqual([...h.sequence].sort(), ['capture:0', 'capture:1', 'fit', 'load'], '四步各发生一次');
  assert.ok(h.sequence.indexOf('fit') < h.sequence.indexOf('load'), '先物理 fit 再加载页面');

  const payload = await h.invoke('shot:init');
  assert.equal(payload.mode, 'desktop');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.frame)), { width: 7, height: 4 });
  assert.deepEqual(JSON.parse(JSON.stringify(payload.screens)), [{ x: 0, y: 0, width: 4, height: 2 }, { x: 4, y: 2, width: 3, height: 2 }],
    '屏矩形是相对 union 原点的物理像素');
  assert.equal(payload.bounds, undefined, '跨屏不伪造某个 display.bounds 当 canonical');
  assert.equal(Buffer.from(payload.bmpBytes).toString('ascii', 0, 2), 'BM');
  assert.deepEqual([Buffer.from(payload.bmpBytes).readInt32LE(18), Buffer.from(payload.bmpBytes).readInt32LE(22)], [7, -4]);

  await h.invoke('shot:ready');
  assert.equal(h.checkCalls.length, 1);
  assert.deepEqual({ ...h.checkCalls[0].bounds }, { x: 0, y: 0, width: 7, height: 4 }, '复核用的是 union，不是某块屏');
  assert.notEqual(h.checkCalls[0].nonce, fitNonce, 'load 覆盖标题后必须换新 nonce');
  assert.deepEqual(h.sequence.filter(step => ['fit', 'load', 'check', 'show'].includes(step)), ['fit', 'load', 'check', 'show'], '页面与复核都不早于 fit，show 在最后');
  assert.equal(h.windows[0].visible, true);
  assert.equal(h.viewportProbes().length, 2, 'show 前读一次基准，show 后立刻再复核一次');
  assert.deepEqual(h.windows[0].getBounds(), { x: 0, y: 0, width: 4, height: 2 }, '复核通过时窗口几何不变');
});

test('跨屏：大窗必须是不透明普通窗，单屏 F1 窗保持原透明设置', async () => {
  const h = harness();
  await h.api.startDesktop();
  const options = h.windows[0].options;
  assert.equal(options.transparent, false, '底图不透明，不需要 layered 透明窗');
  assert.equal(options.backgroundColor, '#000000');
  assert.equal(options.hasShadow, false);
  assert.equal(options.maximizable, false);
  assert.equal(options.fullscreenable, false);
  assert.equal(options.resizable, false, '仍不可 resizable，几何只由原生 fit 决定');
  assert.equal(options.show, false, '仍先隐藏再 fit');
  h.api.cancel();
  assert.equal(h.windows[0].destroyed, true);

  const single = harness({ displays: [TINY[0]] });
  await single.api.start();
  assert.equal(single.windows[0].options.transparent, true, '单屏路径一律不动');
  assert.equal(single.windows[0].options.backgroundColor, '#00000000');
  single.api.cancel();
});

test('跨屏：show 把窗口缩回单屏就明确失败，不落基准也不允许保存', async () => {
  const h = harness({ displays: OWNER, viewport: { width: 312, height: 117 },
    fitBounds: { x: 0, y: 0, width: 312, height: 117 },
    shrinkOnShow: { x: 0, y: 0, width: 192, height: 108 } });
  await h.api.startDesktop();
  await h.invoke('shot:init');
  await h.invoke('shot:ready');
  assert.equal(h.windows[0].visible, true, '确实上过屏，才能发现这个错误');
  assert.equal(h.windows[0].destroyed, true, '几何不对就必须收回窗口');
  assert.equal(h.api.isActive(), false, '不能留着一个错误的 selecting 会话');
  assert.match(h.statuses.at(-1).message, /上屏后尺寸发生变化/, '明确告知是上屏后变化，不当成功');
  assert.equal(h.statuses.at(-1).error, true);
  await assert.rejects(h.invoke('shot:commit', { x: 0, y: 0, width: 312, height: 117 }, 'copy'), /无效截图请求|无效选区窗口/);
  assert.equal(h.crops.length, 0);
  assert.equal(h.clipboardWrites.length, 0);
});

test('跨屏：show 后视口变化也拒绝，不拿旧基准裁切', async () => {
  const h = harness({ displays: OWNER, viewport: { width: 312, height: 117 },
    fitBounds: { x: 0, y: 0, width: 312, height: 117 },
    viewportOnShow: { width: 96, height: 54 } });
  await h.api.startDesktop();
  await h.invoke('shot:init');
  await h.invoke('shot:ready');
  assert.equal(h.api.isActive(), false);
  assert.match(h.statuses.at(-1).message, /上屏后尺寸发生变化/);
  assert.equal(h.windows[0].destroyed, true);
  await assert.rejects(h.invoke('shot:commit', { x: 0, y: 0, width: 312, height: 117 }, 'copy'), /无效截图请求|无效选区窗口/);
  assert.equal(h.crops.length, 0);
});

test('跨屏：show 后复核还在等回包时取消，迟到的读回不碰会话也不报错', async () => {
  const h = harness({ displays: OWNER, viewport: { width: 312, height: 117 }, deferViewport: true,
    fitBounds: { x: 0, y: 0, width: 312, height: 117 } });
  await h.api.startDesktop();
  await h.invoke('shot:init');
  const ready = h.invoke('shot:ready');
  await settle(() => h.viewportProbes().length === 1, 'ready 读基准视口');
  h.resolveViewport();
  await settle(() => h.viewportProbes().length === 2, 'show 后复核读视口');
  h.api.cancel();
  h.resolveViewport();
  await ready;
  assert.equal(h.api.isActive(), false, '取消后仍是空闲态');
  assert.equal(h.statuses.some(row => /上屏后尺寸发生变化/.test(row.message || '')), false, '迟到回包不得把已取消的会话判成失败');
  assert.equal(h.windows[0].destroyed, true);
  assert.equal(h.crops.length, 0);
  assert.equal(h.viewportProbes().length, 2, '取消后不再多读一次视口');
});

test('跨屏：上屏视口回包期间窗口才缩小，也必须拒绝旧矩形', async () => {
  const h = harness({ displays: OWNER, viewport: { width: 312, height: 117 }, deferViewport: true,
    fitBounds: { x: 0, y: 0, width: 312, height: 117 } });
  await h.api.startDesktop();
  await h.invoke('shot:init');
  const ready = h.invoke('shot:ready');
  await settle(() => h.viewportProbes().length === 1, 'show 前读视口');
  h.resolveViewport();
  await settle(() => h.viewportProbes().length === 2, 'show 后等待视口');
  h.windows[0].setBounds({ x: 0, y: 0, width: 192, height: 108 });
  h.resolveViewport();
  await ready;
  assert.equal(h.api.isActive(), false);
  assert.equal(h.windows[0].destroyed, true);
  assert.match(h.statuses.at(-1).message, /上屏后尺寸发生变化/);
  assert.equal(h.crops.length, 0);
});

test('跨屏：只有一屏时明确拒绝，不采屏也不开窗', async () => {
  const h = harness({ displays: [TINY[0]] });
  await h.api.startDesktop();
  assert.equal(h.captures.length, 0);
  assert.equal(h.windows.length, 0);
  assert.equal(h.api.isActive(), false);
  assert.match(h.statuses.at(-1).message, /只有一块屏幕/);
  assert.equal(h.statuses.at(-1).error, true);
});

test('跨屏：union 超 36M 在分配画布前拒绝，一屏都不采', async () => {
  const h = harness({ displays: [
    { ...TINY[0], physical: { x: 0, y: 0, width: 7000, height: 3000 }, workPhysical: { x: 0, y: 0, width: 7000, height: 3000 } },
    { ...TINY[1], physical: { x: 7000, y: 0, width: 7000, height: 3000 }, workPhysical: { x: 7000, y: 0, width: 7000, height: 3000 } }
  ] });
  await h.api.startDesktop();
  assert.equal(h.captures.length, 0, '超预算不能先采集再失败');
  assert.equal(h.windows.length, 0);
  assert.equal(h.bitmapInputs.length, 0);
  assert.match(h.statuses.at(-1).message, /3600 万像素上限/);
  assert.equal(h.api.isActive(), false);
});

test('跨屏：采集中途取消会停掉当前 source，且不再开窗', async () => {
  const h = harness({ deferCapture: 1 });
  const pending = h.api.startDesktop();
  await settle(() => h.captures.length === 2, '第二屏开始采集');
  h.api.cancel();
  assert.equal(h.captures[1].stops, 1, '取消当场就要停掉在飞的那个 source');
  h.releaseCapture();
  await pending;
  assert.equal(h.captures.length, 2);
  assert.ok(h.captures.every(record => record.stops >= 1), '两个 source 都不能漏停（重复 stop 在生产侧是幂等的）');
  assert.ok(h.windows.every(win => !win.visible), '取消后不能留下在屏窗口');
  assert.ok(h.windows.every(win => win.destroyed === true), '与取帧并行建好的窗口必须销毁');
  assert.equal(h.bitmapInputs.length, 0, '迟到回包不能落进新一次会话');
  assert.equal(h.api.isActive(), false);
});

test('跨屏：取帧失败整体收回，窗口即使已建也不上屏', async () => {
  const h = harness({ captureFails: 1 });
  await h.api.startDesktop();
  assert.ok(h.windows.every(win => !win.visible), '失败不上屏');
  assert.ok(h.windows.every(win => win.destroyed === true), '已建窗口必须销毁');
  assert.equal(h.api.isActive(), false);
  assert.match(h.statuses.at(-1).message, /跨屏截图未完成/);
});

test('跨屏：ready 前屏幕集合变化就拒绝，且不上屏', async () => {
  const h = harness();
  await h.api.startDesktop();
  await h.invoke('shot:init');
  h.dropDisplay(22);
  await assert.rejects(h.invoke('shot:ready'), /显示器配置发生变化/);
  assert.equal(h.windows[0].visible, false);
  assert.equal(h.api.isActive(), false);
  assert.match(h.statuses.at(-1).message, /显示器配置已变化/);
});

test('跨屏：load 后窗口被回弹就明确失败，不硬当成就绪', async () => {
  const h = harness({ checkMode: 'reject' });
  await h.api.startDesktop();
  await h.invoke('shot:init');
  await h.invoke('shot:ready');
  assert.equal(h.windows[0].visible, false);
  assert.equal(h.api.isActive(), false);
  assert.match(h.statuses.at(-1).message, /没能盖住整组屏幕/);
});

test('跨屏：截切前屏幕配置变化就拒绝，不拿旧基准裁歪', async () => {
  const h = harness();
  await h.api.startDesktop();
  await h.invoke('shot:init');
  await h.invoke('shot:ready');
  h.patchDisplay(22, { scaleFactor: 1.5 });
  await assert.rejects(h.invoke('shot:commit', { x: 0, y: 0, width: 7, height: 4 }, 'copy'), /显示器配置发生变化/);
  assert.equal(h.crops.length, 0);
  assert.equal(h.windows[0].visible, true, '拒绝裁切但窗口还在，用户可重新框选');
});

test('跨屏：viewport 是唯一裁切基准，不与 union 除以缩放的假设混用', async () => {
  const h = harness({ displays: REAL, viewport: { width: 2880, height: 1079 } });
  await h.api.startDesktop();
  await h.invoke('shot:init');
  await h.invoke('shot:ready');
  // 假设基准是 1080 就会接受这一块；真实视口只有 1079，必须由 toPixels 拒绝（先验拒绝，失败不结束会话）。
  await assert.rejects(h.invoke('shot:commit', { x: 0, y: 0, width: 2880, height: 1080 }, 'copy'), /选区超出显示器/);
  // 整块视口 → 整张 union：比例按 1079 算，高度仍是 2160。
  await h.invoke('shot:commit', { x: 0, y: 0, width: 2880, height: 1079 }, 'copy');
  assert.deepEqual(h.crops[0], { x: 0, y: 0, width: 5760, height: 2160 });
});

test('跨屏：只框到两屏之间的空洞时明确拒绝，不交全黑图', async () => {
  const h = harness();
  await h.api.startDesktop();
  await h.invoke('shot:init');
  await h.invoke('shot:ready');
  // TINY 的 union 7×4：A 在左 4×2，B 在右下 3×2，(4,0)-(7,2) 是既不属于 A 也不属于 B 的空洞。
  await assert.rejects(h.invoke('shot:commit', { x: 4, y: 0, width: 3, height: 2 }, 'copy'), /选区没有屏幕内容/);
  assert.equal(h.crops.length, 0);
  // 同一张图里压到真实屏幕就照常裁切。
  await h.invoke('shot:commit', { x: 4, y: 2, width: 3, height: 2 }, 'copy');
  assert.deepEqual(h.crops[0], { x: 4, y: 2, width: 3, height: 2 });
});

for (const mode of ['copy','save','bad-token','bad-width','short-height','over-limit','bad-png','null-size']) {
  test(`批注复制主进程边界：${mode}`, async()=>{
    const h=harness();await h.api.startDesktop();await h.invoke('shot:init');await h.invoke('shot:ready');
    const rect={x:0,y:0,width:4,height:2};
    const source=await h.invoke('shot:edit-source',rect);
    const png=Buffer.alloc(40);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
    png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(mode==='bad-png'?721:720,16);png.writeUInt32BE(150,20);
    const edited={token:mode==='bad-token'?'stale':source.token,png,clipboardSize:{width:720,height:150}};
    if(mode==='bad-width')edited.clipboardSize.width=721;
    if(mode==='short-height')edited.clipboardSize.height=1;
    if(mode==='over-limit')edited.clipboardSize.height=30001;
    if(mode==='null-size')edited.clipboardSize=null;
    const action=mode==='save'?'save-quick':'copy';
    if(mode==='copy'){
      const result=await h.invoke('shot:commit',rect,action,undefined,edited);
      assert.equal(result.ok,true);assert.equal(result.copied,true);assert.equal(h.clipboardWrites.length,1);
      assert.match(h.statuses.at(-1).message,/批注/);
    }else{
      await assert.rejects(h.invoke('shot:commit',rect,action,undefined,edited));
      assert.equal(h.clipboardWrites.length,0);assert.equal(h.writes.length,0);
      assert.equal(h.windows[0].isDestroyed(),false,'拒绝时保留当前编辑窗口');
    }
  });
}

test('跨屏：已经编辑的成图在拔屏后仍能保存带走', async () => {
  const settings = { resolveSaveFolder: () => path.resolve('configured-not-written'), update: () => {} };
  const h = harness({ settings });
  await h.api.startDesktop();
  await h.invoke('shot:init');
  await h.invoke('shot:ready');
  const source = await h.invoke('shot:edit-source', { x: 0, y: 0, width: 4, height: 2 });
  assert.deepEqual({ width: source.width, height: source.height }, { width: 4, height: 2 });
  const png = Buffer.alloc(40);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
  png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(4, 16); png.writeUInt32BE(2, 20);
  h.dropDisplay(22);
  const result = await h.invoke('shot:commit', { x: 0, y: 0, width: 4, height: 2 }, 'save-quick', undefined, { token: source.token, png });
  assert.equal(result.ok, true, `编辑结果只依赖冻结基准，不该被拔屏拦住：${JSON.stringify(result.errors)}`);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].bytes.toString(), 'edited-png');
});

test('入口：Windows 双屏时默认 start() 自动进入跨屏，union 初始化/提交不变', async () => {
  const h = harness();
  await h.api.start();
  assert.equal(h.captures.length, 2, '自动模式一屏一帧');
  assert.equal(h.singleFitCalls.length, 0, '不再走单屏 fit');
  assert.equal(h.fitCalls.length, 1, '改走跨屏 fit');
  assert.deepEqual({ ...h.fitCalls[0].bounds }, { x: 0, y: 0, width: 7, height: 4 });
  assert.equal(h.control.hides, 1, '页面入口仍先收起设置页');
  const payload = await h.invoke('shot:init');
  assert.equal(payload.mode, 'desktop');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.frame)), { width: 7, height: 4 });
  await h.invoke('shot:ready');
  const result = await h.invoke('shot:commit', { x: 0, y: 0, width: 7, height: 4 }, 'copy');
  assert.equal(result.ok, true);
  assert.deepEqual(h.crops[0], { x: 0, y: 0, width: 7, height: 4 }, '提交仍按 union 裁切');
});

test('入口：双屏 start() 在副屏启动也与光标屏无关，取消后按跨屏收回并恢复控制页', async () => {
  const h = harness({ cursor: { x: 2000, y: 600 } });
  await h.api.start();
  assert.equal(h.captures.length, 2);
  // 窗口初始 DIP 尺寸按启动屏缩放算（副屏 125%）：round(7/1.25)=6，主屏 200% 时是 4。
  assert.equal(h.windows[0].options.width, 6, '锚定屏只影响建窗提示，不影响 union');
  const payload = await h.invoke('shot:init');
  assert.equal(payload.mode, 'desktop');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.frame)), { width: 7, height: 4 });
  await h.invoke('shot:ready');
  h.api.cancel();
  assert.equal(h.api.isActive(), false);
  assert.equal(h.control.visible, true, '取消恢复本次隐藏的控制页');
  assert.equal(h.control.shows, 1);
  assert.equal(h.windows.every(win => win.isDestroyed()), true);
});

test('入口：F1 语义（hideControl=false）不隐藏、不恢复、不提前改状态文案', async () => {
  const h = harness();
  await h.api.start({ hideControl: false });
  assert.equal(h.control.hides, 0, 'F1 不收起控制页');
  assert.equal(h.statuses.some(row => /正在准备跨屏截图/.test(row.message || '')), false, '不在冻结前改设置页文案');
  assert.equal(h.captures.length, 2);
  await h.invoke('shot:init'); await h.invoke('shot:ready');
  h.api.cancel();
  assert.equal(h.control.visible, true);
  assert.equal(h.control.shows, 0, '没隐藏过就不能恢复');
});

test('入口：Windows 单屏 start() 仍走原单屏路径', async () => {
  const h = harness({ displays: [TINY[0]] });
  await h.api.start();
  assert.equal(h.fitCalls.length, 0, '单屏不得走跨屏 fit');
  assert.equal(h.checkCalls.length, 0, '单屏不做跨屏纯读复核');
  assert.equal(h.singleFitCalls.length, 1, '单屏仍用 --fit-selection-window');
  assert.deepEqual(JSON.parse(JSON.stringify(h.singleFitCalls[0].bounds)), TINY[0].physical);
  assert.equal(h.captures.length, 1);
  const payload = await h.invoke('shot:init');
  assert.equal(payload.mode, 'single');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.bounds)), TINY[0].bounds);
  h.api.cancel();
});

test('win-capture：跨屏两个模式复用严格回读，参数不合法或回读不符一律拒绝', async () => {
  const calls = [];
  const execFile = (file, args, options, callback) => { calls.push({ file, args, options }); callback(null, execReply); };
  let execReply = '{"x":0,"y":0,"width":7,"height":4}';
  const target = { x: 0, y: 0, width: 7, height: 4 };
  assert.deepEqual(await fitDesktopWindow('123', 4, 'a'.repeat(32), target, { execFile }), target);
  assert.equal(calls[0].args[0], '--fit-desktop-window');
  assert.deepEqual(calls[0].args.slice(1), ['123', '4', 'a'.repeat(32), '0', '0', '7', '4']);
  assert.deepEqual(await checkDesktopWindow('123', 4, 'b'.repeat(32), target, { execFile }), target);
  assert.equal(calls[1].args[0], '--check-desktop-window');

  execReply = '{"x":0,"y":0,"width":8,"height":4}';
  await assert.rejects(fitDesktopWindow('123', 4, 'a'.repeat(32), target, { execFile }), /窗口物理矩形与目标不符/);
  execReply = '{"x":0,"y":0,"width":7,"height":4}';
  const before = calls.length;
  await assert.rejects(fitDesktopWindow('123', 4, 'not-a-nonce', target, { execFile }), /无效窗口标识/);
  await assert.rejects(fitDesktopWindow('123', 0, 'a'.repeat(32), target, { execFile }), /无效进程标识/);
  await assert.rejects(fitDesktopWindow('', 4, 'a'.repeat(32), target, { execFile }), /无效窗口句柄/);
  await assert.rejects(checkDesktopWindow('123', 4, 'a'.repeat(32), { x: 0, y: 0, width: 0, height: 4 }, { execFile }), /无效窗口目标矩形/);
  assert.equal(calls.length, before, '参数不合法时不能拉起进程');
});

test('原生跨屏模式：非法句柄/PID/nonce 与超预算目标在动窗前拒绝', () => {
  const exe = path.join(__dirname, '..', 'native', 'wgc-capture.exe');
  const run = args => {
    try { execFileSync(exe, args, { encoding: 'utf8', timeout: 15000 }); return ''; }
    catch (error) { return `${error.stdout ?? ''}${error.stderr ?? ''}`; }
  };
  const nonce = 'a'.repeat(32);
  assert.match(run(['--fit-desktop-window', '12345', String(process.pid), nonce, '0', '0', '7', '4']), /window-not-found/);
  assert.match(run(['--check-desktop-window', '12345', String(process.pid), nonce, '0', '0', '7', '4']), /window-not-found/);
  assert.match(run(['--fit-desktop-window', '12345', '0', nonce, '0', '0', '7', '4']), /invalid-owner/);
  assert.match(run(['--fit-desktop-window', '0', String(process.pid), nonce, '0', '0', '7', '4']), /invalid-window/);
  assert.match(run(['--fit-desktop-window', '12345', String(process.pid), 'zz', '0', '0', '7', '4']), /invalid-nonce/);
  assert.match(run(['--fit-desktop-window', '12345', String(process.pid), nonce, '0', '0', '6001', '6000']), /invalid-region/);
  assert.match(run(['--fit-desktop-window', '12345', String(process.pid), nonce]), /invalid-arguments/);
});

test('preload：跨屏入口单独暴露，默认 start 仍走 shot:start', () => {
  const invoked = [], exposed = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main/preload.cjs'), 'utf8'), {
    require: name => name === 'electron' ? {
      contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
      ipcRenderer: { invoke: (...args) => { invoked.push(args); return Promise.resolve(); }, on() {}, removeListener() {} }
    } : require(name)
  });
  exposed.shot.startDesktop();
  exposed.shot.start();
  assert.deepEqual(invoked, [['shot:start-desktop'], ['shot:start']], '跨屏与默认入口各走各的通道');
});

test('跨屏：编辑中的 Esc 只关编辑器，不销毁底图与会话', async () => {
  const h = harness();
  await h.api.startDesktop();
  await h.invoke('shot:init');
  await h.invoke('shot:ready');
  const source = await h.invoke('shot:edit-source', { x: 0, y: 0, width: 4, height: 2 });
  const prevented = [];
  const fire = repeat => h.windows[0].webContents.emit('before-input-event',
    { preventDefault: () => prevented.push(repeat) }, { key: 'Escape', type: 'keyDown', isAutoRepeat: repeat });
  fire(false);
  assert.deepEqual(prevented, [], '首次 Esc 交给页面自己关编辑器，不由主进程拦下');
  assert.equal(h.api.isActive(), true, '编辑中的 Esc 不能结束跨屏会话');
  assert.equal(h.windows[0].destroyed, false, '底图与编辑文档不能被一起销毁');
  assert.equal(h.statuses.some(row => /已取消跨屏截图/.test(row.message || '')), false);
  assert.equal(await h.invoke('shot:edit-state', source.token, 'open'), true, '编辑会话仍可用');
  fire(true);
  assert.deepEqual(prevented, [true], '重复 Esc 只 preventDefault，不销毁');
  assert.equal(h.api.isActive(), true);
  assert.equal(h.windows[0].destroyed, false);
  // 显式丢弃编辑后，普通 Esc 才恢复取消语义。
  await h.invoke('shot:edit-state', source.token, 'discard');
  fire(false);
  assert.equal(h.api.isActive(), false);
  assert.equal(h.windows[0].destroyed, true);
  assert.match(h.statuses.at(-1).message, /已取消跨屏截图/);
});

test('跨屏：未编辑时普通 Esc 仍然直接取消', async () => {
  const h = harness();
  await h.api.startDesktop();
  await h.invoke('shot:init');
  await h.invoke('shot:ready');
  const prevented = [];
  h.windows[0].webContents.emit('before-input-event', { preventDefault: () => prevented.push(true) },
    { key: 'Escape', type: 'keyDown', isAutoRepeat: false });
  assert.deepEqual(prevented, [true], '普通 Esc 必须由主进程拦下');
  assert.equal(h.api.isActive(), false);
  assert.match(h.statuses.at(-1).message, /已取消跨屏截图/);
});

// —— 跨屏会话里的长截归属：resolver 只认「恰好被一块冻结真实屏完整包含」的选区 ——
// 选区 CSS {200,32,40,50} → union 物理 {400,64,80,100} → 副屏局部 {16,10,80,100}。
const ownerSelection = { x: 200, y: 32, width: 40, height: 50 };
for (const [label, displays, selection, expected] of [
  ['正原点', OWNER, ownerSelection, { x: 16, y: 10, width: 80, height: 100 }],
  ['负原点', NEG_OWNER, { x: 10, y: 32, width: 40, height: 50 }, { x: 20, y: 10, width: 80, height: 100 }]
]) test(`resolver：${label}副屏 owner 只平移，局部宽高不变`, async () => {
  const h = harness({ displays, viewport: { width: 312, height: 117 } });
  await h.api.start();
  await h.invoke('shot:init'); await h.invoke('shot:ready');
  const current = h.getCurrent(), owner = displays[1];
  assert.equal(current.display.id, displays[0].id, '会话锚定屏仍是启动屏，owner 是另一块');
  const resolved = await h.scrollHooks().resolveSelection(current, selection);
  assert.deepEqual({ ...resolved.pixels }, expected, 'union → 绝对 → owner 局部，只平移');
  assert.equal(resolved.pixels.width, expected.width, '宽不变，不缩放');
  assert.equal(resolved.pixels.height, expected.height, '高不变，不缩放');
  assert.equal(resolved.env.display.id, owner.id);
  assert.deepEqual({ ...resolved.env.display.bounds }, owner.bounds);
  assert.deepEqual({ ...resolved.env.display.workArea }, owner.workArea);
  assert.equal(resolved.env.display.scaleFactor, owner.scaleFactor);
  assert.deepEqual({ ...resolved.env.frame }, { width: owner.physical.width, height: owner.physical.height });
  assert.deepEqual({ ...resolved.env.nativeBounds }, owner.physical);
  assert.deepEqual({ ...resolved.env.nativeHint }, owner.physical);
  assert.deepEqual({ ...resolved.env.nativeWorkArea }, owner.workPhysical);
  assert.deepEqual({ ...resolved.env.nativeWorkHint }, owner.workPhysical);
  assert.deepEqual(Object.keys(resolved.env).sort(), ['display', 'frame', 'nativeBounds', 'nativeHint', 'nativeWorkArea', 'nativeWorkHint'], 'env 只有冻结几何，不含用户数据');
  assert.deepEqual(Object.keys(resolved.env.display).sort(), ['bounds', 'id', 'scaleFactor', 'workArea']);
  // 解析不碰会话：union 基准、底图、阶段都照旧，普通静态提交不受影响。
  assert.equal(h.api.isActive(), true); assert.equal(current.phase, 'selecting');
  assert.deepEqual({ ...current.desktop.frame }, { x: Math.min(0, owner.physical.x), y: 0, width: 624, height: 234 });
  const result = await h.invoke('shot:commit', selection, 'copy');
  assert.equal(result.ok, true);
  assert.deepEqual(h.crops[0], { x: selection.x * 2, y: selection.y * 2, width: selection.width * 2, height: selection.height * 2 }, '静态提交仍按 union 裁切');
});

test('resolver：175% 帧与 hint 不整除时按真实物理矩形平移，不缩放不夹取', async () => {
  const displays = [{ ...OWNER[0] },
    { id: 62, scaleFactor: 1.75, bounds: { x: 192, y: 27, width: 1098, height: 618 }, workArea: { x: 192, y: 27, width: 1098, height: 570 },
      hint: { x: 384, y: 54, width: 1922, height: 1082 }, physical: { x: 384, y: 54, width: 1920, height: 1080 },
      workPhysical: { x: 384, y: 54, width: 1920, height: 996 }, workHint: { x: 384, y: 54, width: 1922, height: 998 } }];
  const h = harness({ displays, viewport: { width: 1152, height: 567 } });
  await h.api.start();
  assert.equal(h.captures.length, 2);
  const payload = await h.invoke('shot:init');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.frame)), { width: 2304, height: 1134 });
  await h.invoke('shot:ready');
  const current = h.getCurrent();
  const resolved = await h.scrollHooks().resolveSelection(current, { x: 200, y: 30, width: 20, height: 30 });
  assert.deepEqual({ ...resolved.pixels }, { x: 16, y: 6, width: 40, height: 60 });
  assert.deepEqual({ ...resolved.env.frame }, { width: 1920, height: 1080 }, '帧按真实物理矩形，不是 1922 hint');
  assert.deepEqual({ ...resolved.env.nativeBounds }, { x: 384, y: 54, width: 1920, height: 1080 });
  assert.deepEqual({ ...resolved.env.nativeHint }, { x: 384, y: 54, width: 1922, height: 1082 }, 'hint 原样保留做后续复核');
  h.api.cancel();
});

test('resolver：跨缝 1 像素、屏幕空隙都原地拒绝，union 会话照常静态提交', async () => {
  const h = harness({ displays: OWNER, viewport: { width: 312, height: 117 } });
  await h.api.start(); await h.invoke('shot:init'); await h.invoke('shot:ready');
  const current = h.getCurrent();
  const resolve = rect => h.scrollHooks().resolveSelection(current, rect);
  // union 383..463：左 1 物理像素压在主屏右边界内，两边都不完整包含。
  await assert.rejects(resolve({ x: 191.5, y: 27, width: 40, height: 50 }), /选区跨屏或包含屏幕空隙，仅支持普通截图/);
  // 副屏上方的黑色空洞（y 4..24 在副屏顶边 54 之上）。
  await assert.rejects(resolve({ x: 200, y: 2, width: 20, height: 10 }), /选区跨屏或包含屏幕空隙/);
  assert.equal(h.api.isActive(), true); assert.equal(current.phase, 'selecting');
  const result = await h.invoke('shot:commit', ownerSelection, 'copy');
  assert.equal(result.ok, true);
  assert.deepEqual(h.crops[0], { x: 400, y: 64, width: 80, height: 100 }, 'union 裁切源没被换掉');
});

test('resolver：两块屏重叠导致归属不唯一时同样拒绝', async () => {
  const displays = [OWNER[0], { ...OWNER[1], bounds: { x: 180, y: 27, width: 192, height: 144 },
    workArea: { x: 180, y: 27, width: 192, height: 144 },
    physical: { x: 360, y: 54, width: 240, height: 180 }, workPhysical: { x: 360, y: 54, width: 240, height: 180 } }];
  const h = harness({ displays, viewport: { width: 300, height: 117 } });
  await h.api.start(); await h.invoke('shot:init'); await h.invoke('shot:ready');
  // union 600×234：CSS {185,30,5,5} → union {370,60,10,10}，两块屏都完整包含。
  await assert.rejects(h.scrollHooks().resolveSelection(h.getCurrent(), { x: 185, y: 30, width: 5, height: 5 }),
    /选区跨屏或包含屏幕空隙/);
  h.api.cancel();
});

test('resolver：拔屏后原有选区不再换算，拒绝且不动 union', async () => {
  const h = harness({ displays: OWNER, viewport: { width: 312, height: 117 } });
  await h.api.start(); await h.invoke('shot:init'); await h.invoke('shot:ready');
  const current = h.getCurrent();
  h.dropDisplay(OWNER[1].id);
  await assert.rejects(h.scrollHooks().resolveSelection(current, ownerSelection), /显示器配置发生变化/);
  assert.equal(h.api.isActive(), true); assert.equal(current.phase, 'selecting');
  await assert.rejects(h.invoke('shot:commit', ownerSelection, 'copy'), /显示器配置发生变化/);
  assert.equal(h.crops.length, 0);
});

// —— 基准同源：前端 desktop 每次拿实时 innerWidth/Height 重算物理框，主进程新 raw 选择也必须重读 ——
const editedPng = (width, height) => {
  const png = Buffer.alloc(40);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
  png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20);
  return png;
};

test('基准同源：视口 312→313 后 resolver/静态 copy 都按新基准映射 owner', async () => {
  const h = harness({ displays: OWNER, viewport: { width: 312, height: 117 } });
  await h.api.start(); await h.invoke('shot:init'); await h.invoke('shot:ready');
  const current = h.getCurrent(), owner = OWNER[1];
  const frozen = await h.scrollHooks().resolveSelection(current, ownerSelection);
  assert.deepEqual({ ...frozen.pixels }, { x: 16, y: 10, width: 80, height: 100 }, '初始基准 312 的映射');
  h.setViewport({ width: 313, height: 117 });
  // 渲染层用的就是同一套端点取整（core/coordinates.toPixels）；这里以它为口径验收主进程。
  const expected = toPixels(ownerSelection, { x: 0, y: 0, width: 313, height: 117 }, { width: 624, height: 234 });
  const live = await h.scrollHooks().resolveSelection(current, ownerSelection);
  assert.deepEqual({ ...live.pixels }, { x: expected.x - owner.physical.x, y: expected.y - owner.physical.y,
    width: expected.width, height: expected.height }, 'resolver 按新视口映射到同一 owner');
  assert.equal(live.pixels.width, expected.width, '宽高只随端点取整，不再套旧比例');
  assert.notDeepEqual({ ...frozen.pixels }, { ...live.pixels }, '前后确实不同源，刷新真的生效了');
  assert.equal(live.env.display.id, owner.id, 'owner 没变');
  assert.deepEqual({ ...live.env.nativeBounds }, owner.physical);
  assert.equal(live.env.nativeBounds.x + live.pixels.x, expected.x, 'owner 物理 ROI 与前端算的一致');
  assert.deepEqual({ ...current.selectionBounds }, { x: 0, y: 0, width: 313, height: 117 }, '新基准原子落回会话');
  const result = await h.invoke('shot:commit', ownerSelection, 'copy');
  assert.equal(result.ok, true);
  assert.deepEqual(h.crops[0], expected, '静态 copy 同样按新基准裁切');
});

test('基准同源：raw edit-open 跟新视口裁切，已有 doc 之后 resize 不再重算 pixels', async () => {
  const h = harness({ displays: OWNER, viewport: { width: 312, height: 117 } });
  await h.api.start(); await h.invoke('shot:init'); await h.invoke('shot:ready');
  h.setViewport({ width: 313, height: 117 });
  const expected = toPixels(ownerSelection, { x: 0, y: 0, width: 313, height: 117 }, { width: 624, height: 234 });
  const doc = await h.invoke('shot:edit-source', ownerSelection);
  assert.deepEqual({ width: doc.width, height: doc.height }, { width: expected.width, height: expected.height });
  assert.deepEqual(h.crops[0], expected, '编辑来源按新视口裁切');
  // doc 建成后再 resize：提交必须继续用 doc 自己的 pixels，不再刷新映射。
  h.setViewport({ width: 340, height: 120 });
  const result = await h.invoke('shot:commit', ownerSelection, 'copy', undefined,
    { token: doc.token, png: editedPng(expected.width, expected.height) });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(h.clipboardWrites.length, 1);
  assert.equal(h.crops.length, 1, 'doc 路线不重新裁切底图');
});

test('基准同源：display 拓扑变化时 raw 仍拒绝，不白读视口也不改基准', async () => {
  const h = harness({ displays: OWNER, viewport: { width: 312, height: 117 } });
  await h.api.start(); await h.invoke('shot:init'); await h.invoke('shot:ready');
  const before = { ...h.getCurrent().selectionBounds }, probes = h.viewportProbes().length;
  h.dropDisplay(OWNER[1].id);
  await assert.rejects(h.invoke('shot:commit', ownerSelection, 'copy'), /显示器配置发生变化/);
  await assert.rejects(h.scrollHooks().resolveSelection(h.getCurrent(), ownerSelection), /显示器配置发生变化/);
  assert.equal(h.viewportProbes().length, probes, '拓扑不通过就不读视口');
  assert.deepEqual({ ...h.getCurrent().selectionBounds }, before);
  assert.equal(h.crops.length, 0);
});

test('迟到视口：raw commit 等待重读期间取消，不写剪贴板也不写磁盘', async () => {
  const h = harness({ displays: OWNER, viewport: { width: 312, height: 117 }, deferViewport: true });
  await h.api.start(); await h.invoke('shot:init');
  const ready = h.invoke('shot:ready');
  await settle(() => h.viewportProbes().length === 1, 'ready 读视口');
  h.resolveViewport();
  await settle(() => h.viewportProbes().length === 2, 'show 后复核读视口');
  h.resolveViewport(); await ready;
  const job = h.invoke('shot:commit', ownerSelection, 'copy');
  await settle(() => h.viewportProbes().length === 3, 'commit 读视口');
  h.api.cancel();
  h.resolveViewport();
  await assert.rejects(job, /已失效/);
  assert.equal(h.clipboardWrites.length, 0); assert.equal(h.writes.length, 0);
  assert.equal(h.api.isActive(), false);
});

test('缓存成图：long 在 resize 与拔屏后仍按冻结像素输出，不重算映射', async () => {
  const h = harness({ displays: OWNER, viewport: { width: 312, height: 117 } });
  await h.api.start(); await h.invoke('shot:init'); await h.invoke('shot:ready');
  const current = h.getCurrent(), probes = h.viewportProbes().length;
  current.longImage = { getSize: () => ({ width: 80, height: 100 }), toPNG: () => Buffer.from('long-png'), toDataURL: () => 'data:,' };
  current.longToken = 'long-owner';
  h.setViewport({ width: 313, height: 117 });
  h.dropDisplay(OWNER[1].id);
  const result = await h.invoke('shot:commit', ownerSelection, 'copy', 'long-owner');
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(h.viewportProbes().length, probes, 'long 路线不读视口');
  assert.equal(h.crops.length, 0, '不重新裁切底图');
  assert.equal(h.clipboardWrites.length, 1);
});

// 真实 main/scrolling.cjs 跑完整链路：默认 start()（自动跨屏）→ ready → 副屏整块下沿选区 → 长截准备。
// 所有会碰系统的东西（取屏、窗口拟合、快捷键、方向键、右键监听）全部注入纯替身。
test('整合：默认 start 自动跨屏后，副屏选区走真实 scrolling 的 config/遮罩/取帧/请求归属', async () => {
  const h = harness({ displays: PANEL, viewport: { width: 442, height: 212 }, realScrolling: true });
  await h.api.start();
  assert.equal(h.captures.length, 2, '先走自动跨屏的两屏合成');
  await h.invoke('shot:init'); await h.invoke('shot:ready');
  const owner = PANEL[1];
  // 选区在副屏内：CSS {300,80,40,60} → union {600,160,80,120} → 副屏局部 {216,106,80,120}。
  const selection = { x: 300, y: 80, width: 40, height: 60 };
  const started = await h.invoke('shot:scroll-begin', selection);
  const current = h.getCurrent();
  assert.equal(started.started, false, '未收到 page scroll-ready 前不报已开始');
  assert.equal(current.phase, 'scroll-starting');
  assert.deepEqual({ ...current.scroll.pixels }, { x: 216, y: 106, width: 80, height: 120 }, '真实 SC 拿到 owner 局部像素');
  const config = await h.invoke('shot:scroll-config');
  assert.deepEqual({ ...config.frame }, { width: 500, height: 370 }, 'config 帧是 owner 物理帧');
  assert.deepEqual({ ...config.pixels }, { x: 216, y: 106, width: 80, height: 120 });
  const mask = current.scroll.mask;
  assert.deepEqual({ x: mask.bounds.x, y: mask.bounds.y, width: mask.bounds.width, height: mask.bounds.height }, owner.bounds, '遮罩只盖 owner 屏');
  assert.deepEqual(JSON.parse(mask.loadOptions.query.layout), { frame: { width: 500, height: 370 }, pixels: { x: 216, y: 106, width: 80, height: 120 } });
  const fits = h.windowFits();
  const maskFit = fits.find(entry => entry.kind === 'mask'), barFit = fits.find(entry => entry.kind === 'bar');
  assert.deepEqual({ ...maskFit.bounds }, owner.physical, '遮罩按 owner 真实物理矩形拟合');
  assert.ok(barFit && barFit.bounds.x >= owner.workPhysical.x && barFit.bounds.y >= owner.workPhysical.y &&
    barFit.bounds.x + barFit.bounds.width <= owner.workPhysical.x + owner.workPhysical.width &&
    barFit.bounds.y + barFit.bounds.height <= owner.workPhysical.y + owner.workPhysical.height, '浮条拟合在 owner 真实工作区内');
  await h.invoke('shot:scroll-ready', current.scroll.token);
  assert.equal(current.phase, 'scrolling');
  const region = { x: owner.physical.x + 216, y: owner.physical.y + 106, width: 80, height: 120 };
  await h.invoke('shot:scroll-frame', current.scroll.token);
  assert.deepEqual({ ...h.scrollCaptures()[0] }, region, '原生帧落在 owner 物理 ROI');
  assert.deepEqual({ ...h.wheelRegions()[0] }, region, '方向键与取帧同一 ROI');
  assert.equal(h.api.getCaptureRequest(h.windows[0].webContents.mainFrame).displayId, owner.id, '捕获请求报 owner 屏');
  assert.equal(current.display.id, PANEL[0].id, '会话锚定屏仍是启动屏');
  h.api.cancel();
});

// ── 跨屏入口的重入：同一个 union 窗口唤回，不重新拼图、不重新 fit ──
test('跨屏重入：唤回同一 union 窗口并重绘，不重采、不重 fit、不新建窗口', async () => {
  const h = harness();
  await h.api.startDesktop({ hideControl: false });
  await h.invoke('shot:ready');
  const win = h.windows[0];
  const bounds = { ...win.bounds };
  const capturesBefore = h.captures.length, fitsBefore = h.fitCalls.length;
  const current = h.getCurrent();
  current.longImage = { getSize: () => ({ width: 7, height: 4 }), toPNG: () => Buffer.from('long') };
  h.setProbe('drawable');
  await h.api.startDesktop({ hideControl: false });
  assert.equal(h.windows.length, 1, '不新开跨屏窗口');
  assert.equal(h.invalidates(), 1, '整窗重绘一次');
  assert.equal(win.raised, true);
  assert.deepEqual({ ...win.bounds }, bounds, '不改 bounds，也不重 fit 已可见窗');
  assert.equal(h.captures.length, capturesBefore, '不重新拼图');
  assert.equal(h.fitCalls.length, fitsBefore, '不再走原生 fit');
  assert.equal(h.getCurrent().longImage !== undefined, true, '长图保留');
  assert.equal(h.statuses.at(-1).message, '已尝试唤回当前截图，未清除内容。');
  assert.equal(h.messageBoxes.length, 0);
  assert.equal(h.api.isActive(), true);
});

test('跨屏重入遇 scrolling：不终止、不探针、不弹窗，只报实际忙阶段', async () => {
  const h = harness();
  await h.api.startDesktop({ hideControl: false });
  await h.invoke('shot:ready');
  h.getCurrent().phase = 'scrolling';
  const probesBefore = h.probeCalls.length;
  await h.api.startDesktop({ hideControl: false });
  assert.equal(h.getCurrent()?.phase, 'scrolling');
  assert.equal(h.api.isActive(), true);
  assert.equal(h.probeCalls.length, probesBefore);
  assert.equal(h.messageBoxes.length, 0);
  assert.match(h.statuses.at(-1).message, /长截图/);
});
