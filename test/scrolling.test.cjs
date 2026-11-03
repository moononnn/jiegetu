'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { toPixels, outsideMask } = require('../core/coordinates.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const REFERENCE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4yIAAAAASUVORK5CYII=';
function harness({ noBar = false, deferStart = false, badSize = false, escapeFails = false, cancelKeyFails = false, shortcutThrows, dialogResponse = 1, deferDialog = false, protectionFails = false, protectionThrows = false, barCreateFails = false, dropProtectionOnShow = false, watcherThrows = false, wheelThrows = false, diagnostics, noGrowth = false, startError = false, maskReady = true, deferMaskPaint = false, maskBoundsMismatch = false, maskLoadFails = false, maskShowFails = false, barShowFails = false, nativeDeferred = false, scaleFactor = 1, displayBounds = { x: 0, y: 0, width: 1000, height: 800 }, physicalOrigin, physicalSizeMismatch = false, extraDisplays = [], barBoundsMismatch = false, barShowMismatch = false, physicalRect, canonicalRect, workArea, workRect, viewport, selection, mode = 'single', frameSize, resolveSelection, onLongResult, theme } = {}) {
  const handlers = new Map(), shortcuts = new Map(), windows = [], statuses = [], executions = [];
  // 主进程成图窗口的交接桩：只有显式传入时才走新路径，不传就是原来的同步预览。
  const longResults = [];
  const unregistered = [], raised = [], intervals = [], dialogs = [], registrations = [], watchers = [], wheels = [], cancelReasons = [], fileWrites = [], clipboardWrites = [];
  let imageDecodes = 0, resolveDialog;
  // 假解码：按IHDR报告尺寸、按PNG签名判定为空，便于验证换图后的严格校验与去重。
  const fakeDecode = value => {
    const raw = typeof value === 'string' && value.startsWith('data:image/png;base64,') ? Buffer.from(value.slice(22), 'base64') : Buffer.alloc(0);
    return { size: raw.length >= 24 ? { width: raw.readUInt32BE(16), height: raw.readUInt32BE(20) } : { width: 1, height: 1 },
      empty: !(raw.length >= 33 && raw[0] === 0x89 && raw[1] === 0x50) };
  };
  const output = { width: badSize ? 201 : 200, height: noGrowth ? 200 : 500 };
  let resolveStart, nativeDecodes = 0;
  let current;
  class Window extends EventEmitter {
    constructor(options = {}) {
      super(); this.isBar = options.webPreferences?.preload?.endsWith('scroll-bar-preload.cjs');
      if (this.isBar && barCreateFails) throw new Error('模拟浮条创建失败');
      this.bounds = this.isBar && (!Number.isInteger(options.x) || !Number.isInteger(options.y)) ?
        {...options,x:displayBounds.x+Math.floor((displayBounds.width-options.width)/2),y:displayBounds.y+Math.floor((displayBounds.height-options.height)/2)} : options;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = {}; this.sent = [];
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (name, value) => this.sent.push({ name, value });
      this.webContents.executeJavaScript = async (code, gesture) => {
        if (code === 'window.regionMaskReady === true') return maskReady;
        executions.push({ code, gesture });
        if (deferStart) await new Promise(resolve => { resolveStart = resolve; });
        if (startError) throw new Error('模拟取流失败');
        if (current && handlers.get('shot:scroll-ready')(event(), current.scroll.token) !== true) return false;
        return true;
      };
      windows.push(this);
    }
    isDestroyed() { return Boolean(this.destroyed); }
    destroy() { this.destroyed = true; this.emit('closed'); }
    setBounds(bounds) { this.bounds = { ...this.bounds, ...bounds }; }
    getBounds() { if(this.isBar && ((barBoundsMismatch && this.file) || (barShowMismatch && this.visible)))return {...this.bounds,x:displayBounds.x+100,y:displayBounds.y+100}; return maskBoundsMismatch && this.file?.endsWith('scroll-mask.html') ? { ...this.bounds, width: this.bounds.width - 1 } : this.bounds; }
    setIgnoreMouseEvents(value, options) { this.ignoreMouse = value; this.mouseOptions = options; (this.mouseChanges ??= []).push(value); }
    setAlwaysOnTop(value, level) { this.alwaysOnTop = { value, level }; }
    show() { this.visible = true; }
    hide() { this.visible = false; this.emit('hide'); }
    showInactive() { this.visible = !((maskShowFails && this.file?.endsWith('scroll-mask.html')) || (barShowFails && this.isBar)); this.shownAfterSelectionHidden = !host.isVisible(); if(this.isBar&&dropProtectionOnShow)this.protected=false; }
    moveTop() { this.raised = true; raised.push(this); }
    focus() { this.focused = true; }
    isFocused() { return Boolean(this.focused); }
    isVisible() { return Boolean(this.visible); }
    setTitle(value) { this.title = value; }
    setContentProtection(value) { (this.protectionChanges ??= []).push(value); if(value&&(protectionThrows||noBar))throw new Error('模拟保护设置异常');this.protected = value && !protectionFails; }
    isContentProtected() { return Boolean(this.protected); }
    async loadFile(file, options) {
      this.file = file; this.loadOptions = options;
      if (maskLoadFails && file.endsWith('scroll-mask.html')) throw new Error('模拟范围提示加载失败');
      if (!deferMaskPaint || !file.endsWith('scroll-mask.html')) this.emit('ready-to-show');
    }
  }
  const host = new Window(); host.show();
  const frameRect = frameSize ? { ...frameSize } : canonicalRect ? { width: canonicalRect.width, height: canonicalRect.height }
    : { width: displayBounds.width * scaleFactor, height: displayBounds.height * scaleFactor };
  current = { win: host, phase: 'selecting', display: { id: 7, scaleFactor,
    bounds: { ...displayBounds }, workArea: { ...(workArea ?? { ...displayBounds, height: displayBounds.height - 40 }) } },
    // 跨屏会话只多一个 mode：长截图后端必须据此先拒绝，不能等它拿到一张不可滚动的合成图。
    ...(mode === 'desktop' ? { mode: 'desktop' } : {}),
    // 选区基准＝ready 时读到的页面视口；默认与 DIP 边界相同，副屏 865/864 这类差异用 viewport 夹具。
    selectionBounds: selection ? { ...selection } : { x: 0, y: 0,
      width: viewport?.width ?? displayBounds.width, height: viewport?.height ?? displayBounds.height },
    image: { getSize: () => ({ ...frameRect }), crop: () => ({ toDataURL: () => 'data:seed' }) },
    ...(canonicalRect ? { nativeBounds: { ...canonicalRect },
      nativeHint: { ...(physicalRect ?? { x: displayBounds.x * scaleFactor, y: displayBounds.y * scaleFactor, width: displayBounds.width * scaleFactor, height: displayBounds.height * scaleFactor }) } } : {}) };
  // 多屏夹具：物理矩形按屏各自登记，原点故意可以不等于 DIP×缩放（混合 DPI 的真实情况）。
  const physicalRects = new Map([[current.display.id, physicalRect ? { ...physicalRect } : { x: physicalOrigin?.x ?? current.display.bounds.x * scaleFactor, y: physicalOrigin?.y ?? current.display.bounds.y * scaleFactor,
    width: current.display.bounds.width * scaleFactor + (physicalSizeMismatch ? 1 : 0), height: current.display.bounds.height * scaleFactor }]]);
  let displays = [structuredClone(current.display), ...extraDisplays.map(spec => {
    const entry = { id: spec.id, scaleFactor: spec.scaleFactor, bounds: { ...spec.bounds },
      workArea: { ...(spec.workArea ?? { ...spec.bounds, height: spec.bounds.height - 40 }) } };
    physicalRects.set(entry.id, spec.physical ? { ...spec.physical } : { x: Math.round(entry.bounds.x * entry.scaleFactor), y: Math.round(entry.bounds.y * entry.scaleFactor),
      width: Math.round(entry.bounds.width * entry.scaleFactor), height: Math.round(entry.bounds.height * entry.scaleFactor) });
    return entry;
  })], resolveNative;
  // 工作区物理投影：按屏自己的原点与缩放算，可被 patchWorkHint 改掉以模拟系统配置变化。
  let workHintOverride;
  const workHintFor = entry => {
    if (!entry || !physicalRects.has(entry.id)) return undefined;
    if (workHintOverride) return { ...workHintOverride };
    const p = physicalRects.get(entry.id);
    return { x: p.x + Math.round((entry.workArea.x - entry.bounds.x) * entry.scaleFactor),
      y: p.y + Math.round((entry.workArea.y - entry.bounds.y) * entry.scaleFactor),
      width: Math.round(entry.workArea.width * entry.scaleFactor), height: Math.round(entry.workArea.height * entry.scaleFactor) };
  };
  if (canonicalRect) {
    const projected = workHintFor(current.display);
    current.nativeWorkHint = projected;
    // 真实工作区一定被真实监视器包含：夹具按投影与监视器相交来代表系统返回值。
    current.nativeWorkArea = workRect ? { ...workRect } : {
      x: projected.x, y: projected.y,
      width: Math.min(projected.width, canonicalRect.x + canonicalRect.width - projected.x),
      height: Math.min(projected.height, canonicalRect.y + canonicalRect.height - projected.y) };
  }
  const captures = [], fitCalls = [];
  let fitMode = 'ok', fitTarget, resolveFit, rejectFit;
  const native = { nextCalls: 0, stops: 0,
    next() { this.nextCalls++; return nativeDeferred ? new Promise(resolve => { resolveNative = resolve; }) : Promise.resolve({ fresh: true, width: captures[0].width, height: captures[0].height, data: new Uint8ClampedArray(captures[0].width * captures[0].height * 4) }); },
    stop() { if (!this.stopped) { this.stopped = true; this.stops++; } } };
  const event = () => ({ sender: host.webContents, senderFrame: host.webContents.mainFrame });
  const electron = { screen: { getAllDisplays: () => displays, dipToScreenRect: (_win, bounds) => {
      const hit = displays.find(entry => entry.bounds.x === bounds.x && entry.bounds.y === bounds.y && entry.bounds.width === bounds.width && entry.bounds.height === bounds.height);
      if (hit && physicalRects.has(hit.id)) return { ...physicalRects.get(hit.id) };
      const workEntry = displays.find(entry => entry.workArea && entry.workArea.x === bounds.x && entry.workArea.y === bounds.y &&
        entry.workArea.width === bounds.width && entry.workArea.height === bounds.height);
      if (workEntry && physicalRects.has(workEntry.id)) return workHintFor(workEntry);
      return { x: Math.round(bounds.x * scaleFactor), y: Math.round(bounds.y * scaleFactor), width: bounds.width * scaleFactor, height: bounds.height * scaleFactor }; } },
    BrowserWindow: Window, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: { showMessageBox: async (parent,options) => { dialogs.push({parent,options,visible:host.isVisible()});return deferDialog?new Promise(resolve=>{resolveDialog=response=>resolve({response});}):{response:noBar?0:dialogResponse}; } },
    clipboard: { writeImage: image => clipboardWrites.push(image), writeBuffer: (...args) => clipboardWrites.push(args) },
    globalShortcut: { register: (key, fn) => { registrations.push({key,visible:host.isVisible()});if(shortcutThrows===key)throw new Error('模拟快捷键注册异常');if ((escapeFails&&key==='Escape')||(cancelKeyFails&&key==='CommandOrControl+Alt+Escape')) return false; shortcuts.set(key, fn); return true; },
      unregister: key => { unregistered.push(key); shortcuts.delete(key); } },
    nativeImage: { createFromBuffer: () => { imageDecodes++; return { getSize: () => output, isEmpty: () => false,
      resize: () => ({ toDataURL: () => 'data:preview' }) }; },
      createFromDataURL: value => { nativeDecodes++; return { getSize: () => fakeDecode(value).size, isEmpty: () => fakeDecode(value).empty }; } } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../main/scrolling.cjs'), 'utf8'), {
    module, Buffer, ArrayBuffer, __dirname: path.resolve(__dirname, '../main'),
    setTimeout: fn => ({ fn }), clearTimeout() {},
    setInterval: (fn,ms) => { const timer={fn,ms,unref(){}};intervals.push(timer);return timer; },
    clearInterval: timer => { if(timer)timer.cleared=true; },
    require: name => {
      if (name === 'electron') return electron;
      if (name === '../core/coordinates.cjs') return { toPixels, outsideMask };
      if (name === './scroll-cancel.cjs' || name === './scroll-wheel.cjs') throw new Error('测试必须注入假输入监听器，禁止启动真实进程');
      if (name === 'node:fs' || name === 'fs') return { ...fs,
        writeFileSync: (...args) => fileWrites.push(args),
        writeFile: (...args) => { fileWrites.push(args); args.at(-1)?.(); },
        promises: { ...fs.promises, writeFile: async (...args) => { fileWrites.push(args); } } };
      return require(name);
    }
  });
  let api;
  api = module.exports.installScrolling({ getActive: () => current,
    theme,
    onLongResult: typeof onLongResult === 'function'
      ? packet => { longResults.push(packet); return onLongResult(packet); }
      : undefined,
    allowed: e => Boolean(current) && e.sender === host.webContents && e.senderFrame === host.webContents.mainFrame,
    resolveSelection,
    fitWindow: (win, maskNonce, bounds, mode) => {
      const kind = win.isBar ? 'bar' : 'mask';
      fitCalls.push({ win, kind, nonce: maskNonce, mode, bounds: { ...bounds }, loadedBefore: Boolean(win.file) });
      if (fitMode === 'ok' || (fitTarget && fitTarget !== kind)) return Promise.resolve({ ...bounds });
      if (fitMode === 'reject') return Promise.reject(new Error('窗口物理布局失败'));
      if (fitMode === 'defer') return new Promise((resolve, reject) => { resolveFit = () => resolve({ ...bounds }); rejectFit = reject; });
      return Promise.resolve({ ...bounds });
    },
    createCapture: region => { captures.push({ ...region }); return native; },
    createWheelScroller: (region, onError) => {
      if (wheelThrows) throw new Error('模拟方向键组件不可用');
      const wheel = { region: { ...region }, onError, stops: 0, hidden: !host.isVisible(), phase: current.phase, stop() { this.stops++; } };
      wheels.push(wheel); return wheel;
    },
    createCancelWatcher: (onCancel, onError) => {
      if (watcherThrows) throw new Error('模拟右键监听启动失败');
      const watcher = { onCancel, onError, stops: 0, stop() { this.stops++; } };
      watchers.push(watcher); return watcher;
    },
    cancel: (reason = 'cancelled') => { cancelReasons.push(reason); api.cleanup(current); host.destroy(); current = undefined; diagnostics?.end(reason); }, onStatus: state => statuses.push(state), diagnostics });
  const invoke = (name, ...args) => handlers.get(name)(event(), ...args);
  const barInvoke = (name, ...args) => {
    const bar = current.scroll.bar;
    return handlers.get(name)({ sender: bar.webContents, senderFrame: bar.webContents.mainFrame }, ...args);
  };
  return { api, host, windows, invoke, barInvoke, handlers, statuses, executions, shortcuts, unregistered, nativeDecodes: () => nativeDecodes, longResults,
    raised, intervals, dialogs, registrations, watchers, wheels, cancelReasons, fileWrites, clipboardWrites, imageDecodes: () => imageDecodes, output,
    resolveDialog: response=>resolveDialog(response), closeSession:()=>{api.cleanup(current);host.destroy();current=undefined;}, getCurrent: () => current, resolveStart: () => resolveStart(), captures, native,
    resolveNative: image => resolveNative(image), changeDisplay: patch => { displays = [{ ...displays[0], ...patch }, ...displays.slice(1)]; },
    fitCalls, setFitMode: (value, target) => { fitMode = value; fitTarget = target; }, resolveFit: () => resolveFit?.(), rejectFit: error => rejectFit?.(error),
    dropDisplay: id => { displays = displays.filter(entry => entry.id !== id); },
    patchPhysical: rect => { physicalRects.set(7, { ...rect }); },
    patchWorkHint: rect => { workHintOverride = { ...rect }; } };
}
const rect = { x: 10, y: 20, width: 200, height: 200 };

test('跨屏会话没有 owner 归属时在后端就被拒绝长截图，不建浮条、不注册快捷键、不改阶段', async () => {
  const h = harness({ mode: 'desktop' });
  const windowCount = h.windows.length;
  await assert.rejects(h.invoke('shot:scroll-begin', rect), /选区跨屏或包含屏幕空隙，仅支持普通截图/);
  assert.equal(h.windows.length, windowCount);
  assert.equal(h.captures.length, 0);
  assert.deepEqual([...h.registrations], []);
  assert.equal(h.getCurrent().phase, 'selecting');
});

test('跨屏会话：resolver 未给出 owner 时同样原地拒绝，不落回 current.display', async () => {
  const h = harness({ mode: 'desktop', resolveSelection: () => undefined });
  const before = h.getCurrent();
  await assert.rejects(h.invoke('shot:scroll-begin', rect), /选区跨屏或包含屏幕空隙/);
  assert.equal(h.getCurrent(), before);
  assert.equal(h.getCurrent().phase, 'selecting'); assert.equal(h.getCurrent().scroll, undefined);
  assert.equal(h.captures.length, 0); assert.deepEqual([...h.registrations], []);
  assert.equal(h.windows.length, 1, '只剩原选区窗口，没有新浮条/遮罩');
});

test('跨屏 begin 等 resolver 重读视口期间取消：迟到结果不能造浮条/遮罩/采集', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ mode: 'desktop', resolveSelection: async () => {
    await gate;
    return { pixels: { x: 20, y: 30, width: 350, height: 500 }, env: {
      display: { id: 7, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 0, width: 1000, height: 760 } },
      frame: { width: 1000, height: 800 }, nativeBounds: { x: 0, y: 0, width: 1000, height: 800 }, nativeHint: { x: 0, y: 0, width: 1000, height: 800 } } };
  } });
  const current = h.getCurrent();
  const pending = h.invoke('shot:scroll-begin', rect);
  await tick();
  assert.equal(current.scroll, undefined, '等 resolver 期间还没有会话');
  h.closeSession();
  release();
  await assert.rejects(pending, /已失效/);
  assert.equal(h.windows.filter(win => win.isBar).length, 0, '迟到结果不能建浮条');
  assert.equal(h.windows.filter(win => win.file?.endsWith('scroll-mask.html')).length, 0, '也不能建遮罩');
  assert.deepEqual([...h.registrations], [], '不注册快捷键');
  assert.equal(h.captures.length, 0); assert.equal(h.executions.length, 0);
  assert.equal(h.getCurrent(), undefined, '不复活旧会话');
});

// —— 跨屏会话里的单屏长截：owner 由主进程 resolver 判定，所有单屏语义只读 env ——
// owner 是 175% 副屏（不是会话锚定的 current.display），真实帧 1920×1080，Electron hint 仍报 1922×1082。
function ownerEnvironment() {
  const bounds = { x: 1920, y: 274, width: 1098, height: 618 };
  const workArea = { x: 1920, y: 274, width: 1098, height: 570 };
  const physical = { x: 3840, y: 548, width: 1920, height: 1080 };
  const workPhysical = { x: 3840, y: 548, width: 1920, height: 996 };
  const scale = 1.75;
  // 与夹具的 dipToScreenRect 工作区投影同式：物理原点 + DIP 偏移 × 本屏缩放。
  const workHint = { x: physical.x + Math.round((workArea.x - bounds.x) * scale),
    y: physical.y + Math.round((workArea.y - bounds.y) * scale),
    width: Math.round(workArea.width * scale), height: Math.round(workArea.height * scale) };
  return { bounds, workArea, physical, workPhysical, scale, workHint };
}

test('跨屏会话：owner 副屏的长截全程读 resolver env，不落回 current.display', async () => {
  const owner = ownerEnvironment(), pixels = { x: 20, y: 30, width: 350, height: 500 };
  const traces = [];
  const h = harness({ mode: 'desktop', deferStart: true,
    diagnostics: { startAutomatic() {}, record: (event, fields) => traces.push({ event, ...fields }), end() {} },
    extraDisplays: [{ id: 9, scaleFactor: owner.scale, bounds: owner.bounds, workArea: owner.workArea, physical: owner.physical }],
    resolveSelection: () => ({ pixels: { ...pixels }, env: {
      display: { id: 9, scaleFactor: owner.scale, bounds: { ...owner.bounds }, workArea: { ...owner.workArea } },
      frame: { width: owner.physical.width, height: owner.physical.height },
      nativeBounds: { ...owner.physical }, nativeHint: { ...owner.physical },
      nativeWorkArea: { ...owner.workPhysical }, nativeWorkHint: { ...owner.workHint } } }) });
  const current = h.getCurrent(), viewport = { ...current.selectionBounds }, imageSize = current.image.getSize();
  const pending = h.invoke('shot:scroll-begin', { x: 200, y: 32, width: 40, height: 50 });
  await tick();
  const session = h.getCurrent();
  assert.deepEqual({ ...session.scroll.pixels }, pixels, '长截像素是 owner 局部物理像素');
  assert.deepEqual({ ...session.scroll.rect }, { x: 200, y: 32, width: 40, height: 50 }, 'scroll.rect 保留原 CSS 矩形');
  const request = traces.find(row => row.event === 'scroll-request');
  assert.equal(request.displayId, 9, '诊断报 owner 屏，不是会话锚定屏');
  assert.equal(request.frameWidth, 1920); assert.equal(request.frameHeight, 1080);
  assert.equal(request.scaleFactor, owner.scale);
  assert.deepEqual({ ...(await h.invoke('shot:scroll-config')).frame }, { width: 1920, height: 1080 }, 'scroll-config 交 owner 帧');
  assert.deepEqual({ ...(await h.invoke('shot:scroll-config')).pixels }, pixels);
  const mask = session.scroll.mask;
  assert.deepEqual(JSON.parse(mask.loadOptions.query.layout), { frame: { width: 1920, height: 1080 }, pixels }, '提示层只拿 owner 帧与局部像素');
  assert.deepEqual({ x: mask.bounds.x, y: mask.bounds.y, width: mask.bounds.width, height: mask.bounds.height }, owner.bounds, '遮罩只盖 owner 屏');
  const maskFit = h.fitCalls.find(entry => entry.kind === 'mask');
  assert.deepEqual({ ...maskFit.bounds }, owner.physical, '遮罩按 owner 真实物理矩形拟合');
  const bar = session.scroll.bar, barBounds = bar.getBounds();
  assert.ok(barBounds.x >= owner.workArea.x && barBounds.y >= owner.workArea.y &&
    barBounds.x + barBounds.width <= owner.workArea.x + owner.workArea.width &&
    barBounds.y + barBounds.height <= owner.workArea.y + owner.workArea.height, '浮条留在 owner 工作区');
  const barFit = h.fitCalls.find(entry => entry.kind === 'bar');
  assert.ok(barFit.bounds.x >= owner.workPhysical.x && barFit.bounds.y >= owner.workPhysical.y &&
    barFit.bounds.x + barFit.bounds.width <= owner.workPhysical.x + owner.workPhysical.width &&
    barFit.bounds.y + barFit.bounds.height <= owner.workPhysical.y + owner.workPhysical.height, '浮条拟合留在 owner 真实工作区');
  h.resolveStart();
  assert.equal((await pending).started, true);
  const region = { x: owner.physical.x + pixels.x, y: owner.physical.y + pixels.y, width: pixels.width, height: pixels.height };
  assert.deepEqual({ ...h.wheels[0].region }, region, '方向键采样落在 owner 物理 ROI');
  await h.invoke('shot:scroll-frame', session.scroll.token);
  assert.deepEqual({ ...h.captures[0] }, region, '原生取帧同样落在 owner 物理 ROI');
  assert.equal(h.api.captureRequest(h.host.webContents.mainFrame).displayId, 9, 'captureRequest 报 owner 屏');
  assert.equal(h.getCurrent().display.id, 7, '会话锚定屏不被改写');
  assert.deepEqual(h.getCurrent().image.getSize(), imageSize, 'union 源图不被裁替');
  assert.deepEqual({ ...h.getCurrent().selectionBounds }, viewport, 'union 视口基准不被改写');
  h.closeSession();
});

test('ready后显示器配置变化，长截图在创建浮条遮罩前拒绝', async () => {
  const h = harness(); const windowCount = h.windows.length; h.changeDisplay({ scaleFactor: 2 });
  await assert.rejects(h.invoke('shot:scroll-begin', rect), /显示器配置发生变化/);
  assert.equal(h.windows.length, windowCount); assert.equal(h.captures.length, 0);
  assert.equal(h.getCurrent().phase, 'selecting');
});

test('方向键组件仅收起选区并开始采集后创建，完成立即停止且不占用全局方向键', async()=>{
 const h=harness({deferStart:true});const start=h.invoke('shot:scroll-begin',rect);await tick();assert.equal(h.wheels.length,0);
 h.resolveStart();await start;assert.equal(h.wheels.length,1);const w=h.wheels[0];assert.equal(w.hidden,true);assert.equal(w.phase,'scrolling');assert.deepEqual(w.region,rect);
 assert.equal(h.shortcuts.has('Up'),false);assert.equal(h.shortcuts.has('Down'),false);
 h.api.finish();assert.equal(w.stops,1);h.closeSession();assert.equal(w.stops,1);
});
test('自动进入合成阶段也停止方向键，取消与迟到错误不影响新状态',async()=>{
 const h=harness();await h.invoke('shot:scroll-begin',rect);const w=h.wheels[0],token=h.getCurrent().scroll.token;
 h.invoke('shot:scroll-finishing',token);assert.equal(w.stops,1);h.closeSession();const count=h.statuses.length;w.onError(new Error('迟到'));assert.equal(h.statuses.length,count);
 const c=harness();await c.invoke('shot:scroll-begin',rect);const cw=c.wheels[0];c.barInvoke('scroll-bar:cancel');assert.equal(cw.stops,1);
});
test('方向键失败只降级到滚轮，不取消截图；键盘区域不再按正文范围缩小',async()=>{
 const f=harness({wheelThrows:true});await f.invoke('shot:scroll-begin',rect);assert.equal(f.getCurrent().phase,'scrolling');assert.match(f.getCurrent().scroll.status.message,/↑↓ 暂不可用/);f.closeSession();
 const h=harness({scaleFactor:1.5,physicalOrigin:{x:-1500,y:60}});await h.invoke('shot:scroll-begin',rect);
 assert.deepEqual(h.wheels[0].region,{x:-1485,y:90,width:300,height:300});
 h.wheels[0].onError(new Error('输入被拒绝'));assert.equal(h.getCurrent().phase,'scrolling');assert.match(h.getCurrent().scroll.status.message,/请用鼠标滚轮/);assert.equal(h.statuses.at(-1).error,false);
 h.invoke('shot:scroll-progress',h.getCurrent().scroll.token,{height:350,message:'正在接长'});assert.match(h.getCurrent().scroll.status.message,/正在接长.*请用鼠标滚轮/);h.closeSession();
});

test('浮条默认可点击且始终不透传，鼠标切换IPC完全不存在',async()=>{
 const h=harness();assert.equal(h.handlers.has('scroll-bar:pointer-interactive'),false);
 await h.invoke('shot:scroll-begin',rect);const bar=h.getCurrent().scroll.bar;
 assert.equal(bar.ignoreMouse,false);assert.ok(bar.mouseChanges.length>0);assert.ok(bar.mouseChanges.every(value=>value===false));
 assert.notEqual(bar.mouseOptions?.forward,true);
 h.barInvoke('scroll-bar:state');h.api.finish();
 assert.equal(bar.ignoreMouse,false);assert.equal(bar.mouseChanges.includes(true),false);
 assert.equal(h.handlers.has('scroll-bar:pointer-interactive'),false);
 h.closeSession();assert.equal(h.handlers.has('scroll-bar:pointer-interactive'),false);
});

for(const action of ['finish','cancel'])test(`浮条${action}拒绝选区页、子框架、陌生来源及过期窗口，不假成功`,async()=>{
 const h=harness();await h.invoke('shot:scroll-begin',rect);const current=h.getCurrent(),scroll=current.scroll,bar=scroll.bar;
 const handler=h.handlers.get(`scroll-bar:${action}`),before=h.statuses.length;
 for(const event of [
  {sender:h.host.webContents,senderFrame:h.host.webContents.mainFrame},
  {sender:bar.webContents,senderFrame:{}},
  {sender:{},senderFrame:bar.webContents.mainFrame},
  {sender:{},senderFrame:{}}
 ])assert.throws(()=>handler(event),/无效浮条/);
 assert.equal(h.getCurrent(),current);assert.equal(current.scroll,scroll);assert.equal(current.phase,'scrolling');
 assert.equal(h.statuses.length,before);assert.equal(h.cancelReasons.length,0);
 assert.equal(h.host.sent.some(row=>row.name==='shot:scroll-stop'),false);
 const oldEvent={sender:bar.webContents,senderFrame:bar.webContents.mainFrame};
 h.api.cleanup(current);current.phase='selecting';await h.invoke('shot:scroll-begin',rect);
 const next=current.scroll,nextCount=h.statuses.length;
 assert.throws(()=>handler(oldEvent),/无效浮条/);assert.equal(current.scroll,next);assert.equal(current.phase,'scrolling');
 assert.equal(h.statuses.length,nextCount);assert.equal(h.cancelReasons.length,0);
 h.closeSession();assert.throws(()=>handler(oldEvent),/无效浮条/);assert.equal(h.getCurrent(),undefined);
});
test('可信浮条的重复完成请求明确报错，不将不可完成状态冒充成功',async()=>{
 const h=harness();await h.invoke('shot:scroll-begin',rect);h.barInvoke('scroll-bar:finish');
 assert.equal(h.getCurrent().phase,'scroll-finishing');assert.throws(()=>h.barInvoke('scroll-bar:finish'),/当前不能完成/);
 assert.equal(h.host.sent.filter(row=>row.name==='shot:scroll-stop').length,1);h.api.cleanup(h.getCurrent());
});

test('合成期间桌面右键不丢弃已接内容，明确取消快捷键仍可中止',async()=>{
 const h=harness();await h.invoke('shot:scroll-begin',rect);const current=h.getCurrent();h.api.finish();
 h.watchers[0].onCancel();assert.equal(h.getCurrent(),current);assert.equal(current.phase,'scroll-finishing');assert.equal(h.cancelReasons.length,0);
 h.shortcuts.get('CommandOrControl+Alt+Escape')();assert.equal(h.getCurrent(),undefined);assert.equal(h.cancelReasons[0],'cancelled');
});

test('高DPI超过1600万物理像素在隐藏前拒绝，保留原框选且不启动采集',async()=>{
 const h=harness({scaleFactor:2,displayBounds:{x:0,y:0,width:3000,height:2000}});
 await assert.rejects(h.invoke('shot:scroll-begin',{x:10,y:20,width:2500,height:1800}),/1600 万像素/);
 assert.equal(h.getCurrent().phase,'selecting');assert.equal(h.host.isVisible(),true);assert.equal(h.host.destroyed,undefined);
 assert.equal(h.windows.length,1);assert.equal(h.captures.length,0);assert.equal(h.executions.length,0);assert.equal(h.shortcuts.size,0);
});
test('浮条可见时低频抬层不抢焦点，完成/隐藏/清理后不再抬',async()=>{
 const h=harness();await h.invoke('shot:scroll-begin',rect);
 const current=h.getCurrent(),bar=current.scroll.bar,timer=h.intervals[0];
 const barRaises=()=>h.raised.filter(item=>item===bar).length;
 const base=barRaises();
 assert.ok(timer);assert.equal(timer.ms,800);
 timer.fn();assert.equal(barRaises(),base+1);assert.equal(h.raised.at(-1),bar);
 // 采集范围提示也随同一拍抬层，否则交出焦点后会被置顶的页面盖住。
 assert.ok(h.raised.slice(0,-1).includes(current.scroll.mask));
 assert.equal(bar.focused,undefined);assert.equal(current.scroll.barRaises,1);
 const move=bar.moveTop;bar.moveTop=()=>{throw new Error('模拟抬层失败');};assert.doesNotThrow(()=>timer.fn());assert.equal(h.getCurrent(),current);bar.moveTop=move;
 bar.visible=false;timer.fn();assert.equal(barRaises(),base+1);bar.visible=true;
 current.phase='scroll-finishing';timer.fn();assert.equal(barRaises(),base+1);
 h.api.cleanup(current);assert.equal(timer.cleared,true);timer.fn();assert.equal(barRaises(),base+1);
});
test('抬层前复核选区外几何，偏入时不抬层也不主动取消，原采样护栏仍拒绝',async()=>{
 const h=harness();await h.invoke('shot:scroll-begin',rect);
 const current=h.getCurrent(),bar=current.scroll.bar,timer=h.intervals[0];assert.ok(timer);
 const before=h.raised.filter(item=>item===bar).length;bar.setBounds({...bar.getBounds(),x:rect.x,y:rect.y});timer.fn();
 assert.equal(h.getCurrent(),current);assert.equal(h.raised.filter(item=>item===bar).length,before);assert.equal(bar.destroyed,undefined);
 await assert.rejects(h.invoke('shot:scroll-frame',current.scroll.token),/偏入采集范围/);
 h.api.cleanup(current);assert.equal(timer.cleared,true);
});


test('旧 rect.content 明确拒绝，不静默按自动识别继续，也不启动采集',async()=>{
  for(const content of [{top:40.4,bottom:500.4},{top:-1,bottom:100},{top:1,bottom:999},{top:10,bottom:10},null]){
    const h=harness();
    await assert.rejects(h.invoke('shot:scroll-begin',{...rect,content}),/不再接收手动正文范围/);
    assert.equal(h.getCurrent().phase,'selecting');assert.equal(h.getCurrent().scroll,undefined);
    assert.equal(h.host.isVisible(),true);assert.equal(h.shortcuts.size,0);assert.equal(h.captures.length,0);
    h.closeSession();
  }
});
test('250%下选区换算为整数物理像素，配置不回传正文范围',async()=>{
  const h=harness({scaleFactor:2.5});
  await h.invoke('shot:scroll-begin',{x:10.4,y:20.4,width:400.4,height:600.4});
  // 启动后config入口不再开放；检查主进程冻结的同一配置。
  assert.throws(()=>h.invoke('shot:scroll-config'),/无效/);
  assert.equal(h.getCurrent().scroll.content,undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(h.getCurrent().scroll.pixels)),{x:26,y:51,width:1001,height:1501});
  h.api.cleanup(h.getCurrent());
});
test('半DIP坐标不能让真实Electron浮条默认居中落进选区', async () => {
  const h=harness({scaleFactor:2});const r={x:50.5,y:50.5,width:750,height:500};await h.invoke('shot:scroll-begin',r);
  const bar=h.getCurrent().scroll.bar,b=bar.getBounds();
  for(const key of ['x','y','width','height'])assert.equal(Number.isInteger(b[key]),true,key);
  assert.ok(b.x+b.width<=r.x||b.x>=r.x+r.width||b.y+b.height<=r.y||b.y>=r.y+r.height);
  assert.equal(b.movable,false);assert.equal(b.hasShadow,false);h.api.cleanup(h.getCurrent());
});
for(const mode of ['barBoundsMismatch','barShowMismatch'])test(`浮条实际位置异常时停止，不静默无提示采集（${mode}）`,async()=>{
  const h=harness({[mode]:true});await assert.rejects(h.invoke('shot:scroll-begin',{x:50,y:50,width:750,height:500}),/提示位置异常/);
  assert.equal(h.getCurrent(),undefined);
  const oldBar=h.windows.find(w=>w.isBar);assert.equal(oldBar.destroyed,true);assert.equal(h.shortcuts.size,0);
  oldBar.webContents.emit('render-process-gone');assert.equal(h.getCurrent(),undefined);
});
test('浮条调用显示后仍不可见则停止，不进入无提示采集',async()=>{
  const h=harness({barShowFails:true});await assert.rejects(h.invoke('shot:scroll-begin',rect),/提示未显示/);
  assert.equal(h.getCurrent(),undefined);assert.equal(h.captures.length,0);
  assert.ok(h.windows.every(w=>w.isDestroyed()));
});
test('250%缩放大选区：完整浮条放不下时显示窄版，不再省略提示', async () => {
  const h=harness({scaleFactor:2.5,displayBounds:{x:0,y:0,width:1536,height:864}});
  const roi={x:350.4,y:10.4,width:808.4,height:800.8};
  await h.invoke('shot:scroll-begin',roi);
  const bar=h.getCurrent().scroll.bar,b=bar.getBounds();
  assert.equal(b.width,240);assert.equal(bar.isVisible(),true);
  assert.ok(b.x+b.width<=roi.x||b.x>=roi.x+roi.width||b.y+b.height<=roi.y||b.y>=roi.y+roi.height);
  assert.equal(h.getCurrent().scroll.status.canFinish,true);h.api.cleanup(h.getCurrent());
});
test('仅顶部留空时使用短版浮条，按钮与提示仍然显示',async()=>{
  const h=harness();await h.invoke('shot:scroll-begin',{x:0,y:120,width:1000,height:600});
  const b=h.getCurrent().scroll.bar.getBounds();assert.equal(b.height,96);assert.equal(b.y+b.height<=120,true);
  h.api.cleanup(h.getCurrent());
});
for(const when of ['before','pending'])test(`浮条意外漂入ROI时不接受受污染帧（${when}）`,async()=>{
  const h=harness({nativeDeferred:when==='pending'});await h.invoke('shot:scroll-begin',rect);const c=h.getCurrent();
  const drift=()=>c.scroll.bar.setBounds({x:rect.x,y:rect.y,width:100,height:100});
  if(when==='before'){drift();await assert.rejects(h.invoke('shot:scroll-frame',c.scroll.token),/浮条偏入/);assert.equal(h.captures.length,0);}
  else{const job=h.invoke('shot:scroll-frame',c.scroll.token);drift();h.resolveNative({fresh:true});await assert.rejects(job,/浮条偏入/);}
  h.api.cleanup(c);
});
test('原生帧只能由本轮选区顶层页面和正确token请求，失败不启动进程', async () => {
  const h = harness(); await assert.rejects(h.invoke('shot:scroll-frame', 'none'), /不能采样/);
  await h.invoke('shot:scroll-begin', rect); const token = h.getCurrent().scroll.token;
  await assert.rejects(h.invoke('shot:scroll-frame', 'wrong'), /不能采样/);
  await assert.rejects(h.handlers.get('shot:scroll-frame')({ sender: {}, senderFrame: {} }, token), /不能采样/);
  assert.equal(h.captures.length, 0); await h.invoke('shot:scroll-frame', token); assert.equal(h.captures.length, 1); h.api.cleanup(h.getCurrent());
});
test('负原点及混合缩放用宿主转换后的物理原点，只采物理ROI且复用同一源', async () => {
  const h = harness({ scaleFactor: 1.5, displayBounds: { x: -1000, y: 200, width: 1000, height: 800 }, physicalOrigin: { x: -1777, y: 333 } });
  await h.invoke('shot:scroll-begin', rect); const token = h.getCurrent().scroll.token;
  const image = await h.invoke('shot:scroll-frame', token); await h.invoke('shot:scroll-frame', token);
  assert.equal(h.captures.length, 1); assert.deepEqual(h.captures[0], { x: -1762, y: 363, width: 300, height: 300 });
  assert.equal(image.data.length, 300 * 300 * 4); assert.equal(h.native.nextCalls, 2); h.api.cleanup(h.getCurrent()); assert.equal(h.native.stops, 1);
});
test('显示器/缩放更改或尺寸不符在原生取帧之前拒绝，不做缩放补偿', async () => {
  for (const kind of ['scale', 'removed', 'size']) {
    const h = harness({ physicalSizeMismatch: kind === 'size' }); await h.invoke('shot:scroll-begin', rect);
    if (kind === 'scale') h.changeDisplay({ scaleFactor: 2 }); if (kind === 'removed') h.changeDisplay({ id: 8 });
    await assert.rejects(h.invoke('shot:scroll-frame', h.getCurrent().scroll.token), /显示器|尺寸/);
    assert.equal(h.captures.length, 0); h.api.cleanup(h.getCurrent());
  }
});
test('原生取帧期间改分辨率，回包再次核验，不交付旧配置画面', async () => {
  const h = harness({ nativeDeferred: true }); await h.invoke('shot:scroll-begin', rect);
  const p = h.invoke('shot:scroll-frame', h.getCurrent().scroll.token); h.changeDisplay({ bounds: { x: 0, y: 0, width: 900, height: 800 } });
  h.resolveNative({ fresh: true }); await assert.rejects(p, /显示器/); h.api.cleanup(h.getCurrent());
});
test('完成不截断已经请求的原生帧，收尾桥接之后才关闭源，且禁止新增请求', async () => {
  const h = harness({ nativeDeferred: true }); await h.invoke('shot:scroll-begin', rect); const token = h.getCurrent().scroll.token;
  const p = h.invoke('shot:scroll-frame', token); assert.equal(h.api.finish(), true);
  await assert.rejects(h.invoke('shot:scroll-frame', token), /不能采样/); assert.equal(h.native.stops, 0);
  h.resolveNative({ fresh: true }); assert.equal((await p).fresh, true);
  await h.invoke('shot:scroll-finishing', token); assert.equal(h.native.stops, 1); h.api.cleanup(h.getCurrent()); assert.equal(h.native.stops, 1);
});
test('点完成时管道里尚未送达的一帧可排空，但不开放连续补采', async () => {
  const h = harness({ nativeDeferred: true }); await h.invoke('shot:scroll-begin', rect); const token = h.getCurrent().scroll.token;
  assert.equal(h.api.finish(), true);
  const p = h.invoke('shot:scroll-frame', token); // requested by renderer before it receives stop, IPC arrives after main finish
  assert.equal(h.native.nextCalls, 1);
  await assert.rejects(h.invoke('shot:scroll-frame', token), /不能采样/);
  h.resolveNative({ fresh: true }); assert.equal((await p).fresh, true);
  await assert.rejects(h.invoke('shot:scroll-frame', token), /不能采样/);
  await h.invoke('shot:scroll-finishing', token); assert.equal(h.native.stops, 1); h.api.cleanup(h.getCurrent());
});
test('渲染器确认收尾后，即使未使用末帧名额也不再启动采集', async () => {
  const h = harness(); await h.invoke('shot:scroll-begin', rect); const token = h.getCurrent().scroll.token;
  assert.equal(h.api.finish(), true); await h.invoke('shot:scroll-finishing', token);
  await assert.rejects(h.invoke('shot:scroll-frame', token), /不能采样/); assert.equal(h.native.nextCalls, 0); h.api.cleanup(h.getCurrent());
});
test('取消关闭原生源，旧采样晚到不能进入新事务', async () => {
  const h = harness({ nativeDeferred: true }); await h.invoke('shot:scroll-begin', rect); const current = h.getCurrent();
  const p = h.invoke('shot:scroll-frame', current.scroll.token); h.api.cleanup(current); assert.equal(h.native.stops, 1);
  h.resolveNative({ fresh: true }); await assert.rejects(p, /失效/);
});
test('浮条可信参照只接受有界PNG，非法和过大数据不能覆盖已有参照', async () => {
  const h = harness(); await h.invoke('shot:scroll-begin', rect);
  const token = h.getCurrent().scroll.token, reference = { dataUrl: REFERENCE_PNG, width: 1, height: 1 };
  const oversizedHeader = Buffer.from(REFERENCE_PNG.split(',')[1], 'base64'); oversizedHeader.writeUInt32BE(2147483647, 16);
  h.invoke('shot:scroll-progress', token, { height: 210, message: '已对齐', reference });
  assert.equal(h.getCurrent().scroll.status.reference.dataUrl, reference.dataUrl);
  for (const candidate of [{ ...reference, width: 361 }, { ...reference, height: 65 },
    { ...reference, dataUrl: 'data:image/svg+xml,PRIVATE' }, { ...reference, dataUrl: 'data:image/png;base64,' + 'A'.repeat(2000001) },
    { ...reference, dataUrl: 'data:image/png;base64,Yg==' }, { ...reference, width: 2 },
    { ...reference, dataUrl: 'data:image/png;base64,' + oversizedHeader.toString('base64') }]) {
    h.invoke('shot:scroll-progress', token, { height: 220, message: '未接上', reference: candidate });
    assert.equal(h.getCurrent().scroll.status.reference.dataUrl, reference.dataUrl);
  }
  assert.equal(h.nativeDecodes(), 1, '伪装小尺寸的大PNG必须在原生解码前拒绝');
  const bar = h.getCurrent().scroll.bar;
  assert.equal(bar.bounds.height, 520); assert.equal(bar.bounds.focusable, false); assert.equal(bar.isContentProtected(), false);
  assert.ok(bar.bounds.y + bar.bounds.height <= rect.y || bar.bounds.y >= rect.y + rect.height ||
    bar.bounds.x + bar.bounds.width <= rect.x || bar.bounds.x >= rect.x + rect.width);
  h.api.cleanup(h.getCurrent());
});

test('同一可信参照重复下发不重复解码，换图或非法图仍走严格校验', async () => {
  const h = harness(); await h.invoke('shot:scroll-begin', rect);
  const token = h.getCurrent().scroll.token, reference = { dataUrl: REFERENCE_PNG, width: 1, height: 1 };
  const send = (patch, height = 210) => h.invoke('shot:scroll-progress', token, { height, message: '已对齐', ...patch });
  send({ reference });
  assert.equal(h.nativeDecodes(), 1);
  assert.equal(h.getCurrent().scroll.status.reference.dataUrl, reference.dataUrl);
  for (let i = 0; i < 5; i++) send({ reference });
  assert.equal(h.nativeDecodes(), 1, '同一可信参照不重复解码');
  assert.equal(h.getCurrent().scroll.status.reference.width, 1);
  // 换图仍要走完整PNG协议校验；尺寸与IHDR不一致的图在任何解码前拒绝。
  const bytes = Buffer.from(REFERENCE_PNG.split(',')[1], 'base64'); bytes.writeUInt32BE(2, 16); bytes.writeUInt32BE(3, 20);
  const second = { dataUrl: 'data:image/png;base64,' + bytes.toString('base64'), width: 2, height: 3 };
  send({ reference: second });
  assert.equal(h.nativeDecodes(), 2, '不同的可信参照依旧只解码一次');
  assert.equal(h.getCurrent().scroll.status.reference.dataUrl, second.dataUrl);
  send({ reference: second });
  assert.equal(h.nativeDecodes(), 2, '已信任的参照同样不重复解码');
  assert.deepEqual(JSON.parse(JSON.stringify(h.getCurrent().scroll.status.reference)), second);
  for (const candidate of [{ ...second, width: 3 }, { ...second, dataUrl: 'data:image/svg+xml,PRIVATE' }, { ...second, dataUrl: REFERENCE_PNG }]) {
    send({ reference: candidate });
    assert.equal(h.getCurrent().scroll.status.reference.dataUrl, second.dataUrl, '非法或篡改尺寸的参照不能替换可信参照');
  }
  assert.equal(h.nativeDecodes(), 2, '被拒的参照不得进入解码');
  send({ reference });
  assert.equal(h.nativeDecodes(), 3, '合法的旧参照再次出现时作为新图重新校验');
  assert.equal(h.getCurrent().scroll.status.reference.dataUrl, reference.dataUrl);
  h.closeSession();
});

test('空间充足时优先使用选区右侧的竖向实时预览', async () => {
  const h = harness(); await h.invoke('shot:scroll-begin', rect);
  const b = h.getCurrent().scroll.bar.getBounds();
  assert.equal(b.width, 240); assert.equal(b.height, 520);
  assert.ok(b.x >= rect.x + rect.width + 10);
  assert.equal(h.getCurrent().scroll.protectedBar, false);
  h.closeSession();
});

test('完整预览PNG与真实长图高度绑定，视口越界或失配不冒称定位成功', async () => {
  const h = harness(); await h.invoke('shot:scroll-begin', rect);
  const token = h.getCurrent().scroll.token;
  const preview = { dataUrl: REFERENCE_PNG, width: 1, height: 1, sourceHeight: 250 };
  const send = patch => h.invoke('shot:scroll-progress', token, { height: 250, message: '已接长', ...patch });
  send({ preview, viewport: { top: 30, height: 200, matched: true } });
  assert.equal(h.getCurrent().scroll.status.preview.sourceHeight, 250);
  assert.deepEqual(JSON.parse(JSON.stringify(h.getCurrent().scroll.status.viewport)), { top: 30, height: 200, matched: true });
  send({ preview, viewport: { top: 10, height: 200, matched: false } });
  assert.equal(h.nativeDecodes(), 1, '同一可信PNG只解码一次，移动方框不重复解码');
  assert.equal(h.getCurrent().scroll.status.viewport.matched, false);
  for (const viewport of [{ top: -1, height: 200, matched: true }, { top: 100, height: 200, matched: true },
    { top: 2.5, height: 200, matched: true }, { top: 0, height: 0, matched: true }, { top: 0, height: 200, matched: 'yes' }]) {
    send({ viewport }); assert.notEqual(h.getCurrent().scroll.status.viewport?.matched, true);
  }
  h.invoke('shot:scroll-progress', token, { height: 300, message: '预览更新中', preview, viewport: { top: 0, height: 200, matched: true } });
  assert.equal(h.getCurrent().scroll.status.preview.sourceHeight, 250);
  assert.equal(h.getCurrent().scroll.status.viewport.matched, false, '新高度不能配旧图宣称对齐');
  h.closeSession();
});
test('完整预览拒绝超大/伪造PNG与跨会话投递，不写盘或写剪贴板', async () => {
  const rows = [], h = harness({ diagnostics: { startAutomatic() {}, record: (name, fields) => rows.push({ name, fields }), end() {} } });
  await h.invoke('shot:scroll-begin', rect); const token = h.getCurrent().scroll.token;
  const good = { dataUrl: REFERENCE_PNG, width: 1, height: 1, sourceHeight: 250 };
  for (const preview of [{ ...good, width: 241 }, { ...good, height: 481 }, { ...good, sourceHeight: 251 },
    { ...good, dataUrl: 'data:image/svg+xml,PRIVATE' }, { ...good, dataUrl: 'data:image/png;base64,' + 'A'.repeat(1000001) },
    { ...good, dataUrl: 'data:image/png;base64,Yg==' }, { ...good, width: 2 }]) {
    h.invoke('shot:scroll-progress', token, { height: 250, message: '采集中', preview });
    assert.equal(h.getCurrent().scroll.status.preview, undefined);
  }
  assert.equal(h.nativeDecodes(), 0, '坏IHDR必须在nativeImage解码前拒绝');
  h.handlers.get('shot:scroll-progress')({ sender: {}, senderFrame: {} }, token, { height: 250, message: '伪造', preview: good });
  h.invoke('shot:scroll-progress', 'stale-token', { height: 250, message: '旧会话', preview: good });
  assert.equal(h.getCurrent().scroll.status.preview, undefined);
  h.invoke('shot:scroll-progress', token, { height: 250, message: '采集中', preview: good });
  assert.equal(h.getCurrent().scroll.status.preview.dataUrl, good.dataUrl);
  assert.deepEqual(h.fileWrites, []); assert.deepEqual(h.clipboardWrites, []);
  for (const row of rows) assert.ok(!JSON.stringify(row.fields).includes('data:image'));
  h.closeSession();
});

test('后台记录覆盖长截图前置校验拒绝，同时保留选区供调整', async () => {
  const rows = [], h = harness({ diagnostics: { startAutomatic() {}, record: (event, fields) => rows.push({ event, fields }), end() {} } });
  await assert.rejects(h.invoke('shot:scroll-begin', { ...rect, width: 10 }), /至少/);
  assert.equal(h.getCurrent().phase, 'selecting'); assert.equal(h.windows.length, 1);
  assert.equal(rows.find(row => row.event === 'scroll-failure')?.fields.reason, 'invalid');
  assert.equal(h.executions.length, 0);
});

test('普通入口开始长截图时自动建立记录，先于屏幕流和worker启动', async () => {
  const trace = [], diagnostics = { startAutomatic: () => trace.push('automatic'), record: name => trace.push(name), end() {} };
  const h = harness({ diagnostics }); assert.deepEqual(trace, []);
  await h.invoke('shot:scroll-begin', rect);
  assert.equal(trace[0], 'automatic'); assert.ok(trace.indexOf('scroll-request') < trace.indexOf('worker-call'));
  assert.equal(h.getCurrent().phase, 'scrolling'); h.api.cleanup(h.getCurrent());
});
test('自动记录不可用不阻断截图，陌生窗口无权开始记录', async () => {
  let attempts = 0;
  const h = harness({ diagnostics: { startAutomatic() { attempts++; throw new Error('disk unavailable'); }, record() {}, end() {} } });
  await assert.rejects(h.handlers.get('shot:scroll-begin')({ sender: {}, senderFrame: {} }, rect), /当前不能/);
  assert.equal(attempts, 0); await h.invoke('shot:scroll-begin', rect);
  assert.equal(attempts, 1); assert.equal(h.getCurrent().phase, 'scrolling'); h.api.cleanup(h.getCurrent());
});

test('浮条基线：选区隐藏后才显示并提升浮条，不能提前藏在全屏选区下面', async () => {
  const h = harness({ deferStart: true }); const pending = h.invoke('shot:scroll-begin', rect); await tick();
  const bar = h.getCurrent().scroll.bar; assert.equal(bar.isVisible(), false);
  h.resolveStart(); await pending;
  assert.equal(bar.isVisible(), true); assert.equal(bar.shownAfterSelectionHidden, true);
  assert.equal(bar.raised, true); assert.notEqual(bar.focused, true);
  h.api.cleanup(h.getCurrent());
});

test('采集提示层先准备再显示，透明穿透且浮条最后置前；预览时完整清理', async () => {
  const h = harness({ deferStart: true }); const pending = h.invoke('shot:scroll-begin', rect); await tick();
  const { mask, bar } = h.getCurrent().scroll;
  assert.equal(mask.isVisible(), false); assert.equal(mask.bounds.transparent, true);
  assert.equal(mask.bounds.focusable, false); assert.equal(mask.bounds.hasShadow, false);
  assert.equal(mask.ignoreMouse, true); assert.equal(mask.protected, undefined);
  const layout = JSON.parse(mask.loadOptions.query.layout);
  // 主进程只交物理帧与已确认像素；色块由提示页按自己的视口生成（见 scroll-mask.test.cjs）。
  assert.deepEqual(layout, { frame: { width: 1000, height: 800 }, pixels: { x: 10, y: 20, width: 200, height: 200 } });
  h.resolveStart(); await pending;
  assert.equal(mask.shownAfterSelectionHidden, true); assert.notEqual(mask.focused, true);
  assert.deepEqual(h.raised, [mask, bar]);
  const token = h.getCurrent().scroll.token;
  h.invoke('shot:scroll-result', token, { png: new ArrayBuffer(4) });
  assert.equal(mask.isDestroyed(), true); assert.equal(bar.isDestroyed(), true);
  assert.equal(h.host.isVisible(), true); assert.equal(h.getCurrent().phase, 'selecting');
});
test('提示层DOM未就绪，不启动媒体请求且收回全部窗口', async () => {
  const h = harness({ maskReady: false });
  await assert.rejects(h.invoke('shot:scroll-begin', rect), /提示未就绪/);
  assert.equal(h.executions.length, 0); assert.equal(h.getCurrent(), undefined);
  assert.ok(h.windows.every(w => w.isDestroyed()));
});
for (const [name, options] of [['加载失败', { maskLoadFails: true }], ['窗口尺寸被系统改变', { maskBoundsMismatch: true }]]) test(`提示层${name}不开始采集且清理全部窗口`, async () => {
  const h = harness(options); await assert.rejects(h.invoke('shot:scroll-begin', rect));
  assert.equal(h.getCurrent(), undefined); assert.equal(h.executions.length, 0);
  assert.ok(h.windows.every(w => w.isDestroyed()));
});

test('提示层首帧未绘制由既有启动上限结束，迟到paint不重启采集', async () => {
  const h = harness({ deferMaskPaint: true }); const pending = h.invoke('shot:scroll-begin', rect); await tick();
  const current = h.getCurrent(), mask = current.scroll.mask;
  current.scroll.timer.fn();
  assert.equal((await pending).started, false); assert.equal(h.getCurrent(), undefined);
  assert.ok(h.windows.every(w => w.isDestroyed())); assert.equal(h.executions.length, 0);
  mask.emit('ready-to-show'); assert.equal(h.getCurrent(), undefined);
});
test('提示层调用显示后仍不可见就拒绝ready并收回，不以接口调用冒充可见', async () => {
  const h = harness({ maskShowFails: true }); const result = await h.invoke('shot:scroll-begin', rect);
  assert.equal(result.started, false); assert.equal(h.getCurrent(), undefined);
  assert.ok(h.windows.every(w => w.isDestroyed())); assert.equal(h.shortcuts.size, 0);
  assert.match(h.statuses.at(-1).message, /提示未显示/);
});
for (const crash of ['closed', 'render-process-gone', 'hide', 'cancel']) test(`提示层${crash}时收回事务、浮条、提示层与退出键`, async () => {
  const h = harness(); await h.invoke('shot:scroll-begin', rect); const mask = h.getCurrent().scroll.mask;
  if (crash === 'closed') mask.destroy();
  else if (crash === 'hide') mask.hide();
  else if (crash === 'cancel') h.barInvoke('scroll-bar:cancel');
  else mask.webContents.emit('render-process-gone');
  assert.equal(h.getCurrent(), undefined); assert.ok(h.windows.every(w => w.isDestroyed())); assert.equal(h.shortcuts.size, 0);
});
test('暂停取屏真正关闭源但保留窗口，仅当前浮条主框架可操作，恢复重建源',async()=>{
  const records=[],h=harness({diagnostics:{record:(name,data)=>records.push({name,...data}),end(){}}});
  await h.invoke('shot:scroll-begin',rect);const current=h.getCurrent(),scroll=current.scroll,token=scroll.token;
  assert.throws(()=>h.barInvoke('scroll-bar:toggle-capture'),/当前不能/);
  await h.invoke('shot:scroll-frame',token);
  assert.throws(()=>h.invoke('scroll-bar:toggle-capture'),/无效/);
  assert.throws(()=>h.handlers.get('scroll-bar:toggle-capture')({sender:scroll.bar.webContents,senderFrame:{}}),/无效/);
  assert.equal(h.barInvoke('scroll-bar:toggle-capture').paused,true);assert.equal(h.native.stops,1);
  assert.equal(h.barInvoke('scroll-bar:state').capturePaused,true);
  const before=h.native.nextCalls;assert.equal((await h.invoke('shot:scroll-frame',token)).fresh,false);assert.equal(h.native.nextCalls,before);
  assert.equal(scroll.mask.isVisible(),true);assert.equal(scroll.bar.isVisible(),true);assert.equal(current.phase,'scrolling');
  assert.equal(h.barInvoke('scroll-bar:toggle-capture').paused,false);
  assert.equal((await h.invoke('shot:scroll-frame',token)).fresh,true);assert.equal(h.captures.length,2);
  assert.deepEqual(records.filter(r=>r.name==='capture-toggle').map(r=>r.paused),[true,false]);
});
for(const rejectOld of [false,true])test(`暂停后旧代${rejectOld?'失败':'成功'}回包不终止恢复会话、不提交旧像素`,async()=>{
  const h=harness();await h.invoke('shot:scroll-begin',rect);const token=h.getCurrent().scroll.token;
  const frame=await h.invoke('shot:scroll-frame',token);let settle;
  h.native.next=()=>new Promise((resolve,reject)=>{settle=()=>rejectOld?reject(new Error('主动停止')):resolve(frame);});
  const pending=h.invoke('shot:scroll-frame',token);h.barInvoke('scroll-bar:toggle-capture');h.barInvoke('scroll-bar:toggle-capture');
  settle();assert.equal((await pending).fresh,false);assert.equal(h.getCurrent().phase,'scrolling');assert.equal(h.getCurrent().scroll.nativePending,false);
});
test('暂停后完成不重建源，不能收尾中再切换，取消清理全部窗口',async()=>{
  const h=harness();await h.invoke('shot:scroll-begin',rect);const token=h.getCurrent().scroll.token;
  await h.invoke('shot:scroll-frame',token);h.barInvoke('scroll-bar:toggle-capture');
  assert.equal(h.api.finish(),true);assert.throws(()=>h.barInvoke('scroll-bar:toggle-capture'),/当前不能/);
  assert.equal((await h.invoke('shot:scroll-frame',token)).fresh,false);assert.equal(h.captures.length,1);
  h.barInvoke('scroll-bar:cancel');assert.equal(h.getCurrent(),undefined);assert.ok(h.windows.every(w=>w.isDestroyed()));
});
test('暂停取屏不豁免遮罩意外消失的安全停止',async()=>{
  const h=harness();await h.invoke('shot:scroll-begin',rect);await h.invoke('shot:scroll-frame',h.getCurrent().scroll.token);
  h.barInvoke('scroll-bar:toggle-capture');h.getCurrent().scroll.mask.hide();assert.equal(h.getCurrent(),undefined);
});
const fullRect={x:0,y:0,width:1000,height:800};
test('全屏直接显示浮条且不弹确认：原范围、保护、双键和收尾不变',async()=>{
 const h=harness({dialogResponse:0});await h.invoke('shot:scroll-begin',fullRect);
 const c=h.getCurrent(),s=c.scroll,b=s.bar,bounds=b.getBounds();
 assert.equal(s.protectedBar,true);assert.equal(s.noBar,false);assert.equal(s.mask,undefined);
 assert.equal(b.isContentProtected(),true);assert.equal(b.isVisible(),true);assert.equal(b.shownAfterSelectionHidden,true);assert.notEqual(b.focused,true);
 assert.equal(bounds.width,800);assert.equal(bounds.height,400);assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=1000&&bounds.y+bounds.height<=760);
 assert.equal(h.registrations.length,2);assert.ok(h.registrations.every(r=>r.visible));assert.equal(h.shortcuts.size,2);assert.equal(s.escapeRegistered,true);assert.equal(s.cancelRegistered,true);
 assert.equal(h.dialogs.length,0);
 const frame=await h.invoke('shot:scroll-frame',s.token);assert.equal(frame.width,1000);assert.equal(frame.height,800);
 assert.deepEqual(h.captures[0],{x:0,y:0,width:1000,height:800});assert.equal(h.intervals.length,1);
 h.output.width=1000;h.output.height=860;h.barInvoke('scroll-bar:finish');assert.equal(c.phase,'scroll-finishing');
 assert.equal(h.invoke('shot:scroll-result',s.token,{png:new ArrayBuffer(4)}),true);
 assert.equal(c.phase,'selecting');assert.ok(c.longImage);assert.equal(b.isDestroyed(),true);assert.equal(h.shortcuts.size,0);assert.equal(h.host.isVisible(),true);
});
for(const options of [{protectionFails:true},{protectionThrows:true},{barCreateFails:true}])test(`保护初始化失败保留选框、撤回两键并允许改选无浮条 ${JSON.stringify(options)}`,async()=>{
 const h=harness({dialogResponse:1,...options});await assert.rejects(h.invoke('shot:scroll-begin',fullRect),/排除不可用/);
 assert.equal(h.getCurrent().phase,'selecting');assert.equal(h.getCurrent().scroll,undefined);assert.equal(h.host.isVisible(),true);assert.equal(h.host.isDestroyed(),false);
 assert.equal(h.shortcuts.size,0);assert.equal(h.executions.length,0);assert.equal(h.captures.length,0);assert.ok(h.windows.filter(w=>w.isBar).every(w=>w.isDestroyed()));
});
for(const options of [{escapeFails:true},{cancelKeyFails:true},{shortcutThrows:'Escape'},{shortcutThrows:'CommandOrControl+Alt+Escape'}])test(`受保护浮条双键失败在构造或显示前拒绝 ${JSON.stringify(options)}`,async()=>{
 const h=harness({dialogResponse:0,...options});await assert.rejects(h.invoke('shot:scroll-begin',fullRect),/快捷键未能注册/);
 assert.equal(h.getCurrent().phase,'selecting');assert.equal(h.host.isVisible(),true);assert.equal(h.windows.length,1);assert.equal(h.shortcuts.size,0);assert.equal(h.executions.length,0);
});
test('受保护浮条显示后保护掉线则不开始采集，窗口与两键完整收回',async()=>{
 const h=harness({dialogResponse:0,dropProtectionOnShow:true});await assert.rejects(h.invoke('shot:scroll-begin',fullRect),/排除状态或位置异常/);
 assert.equal(h.getCurrent(),undefined);assert.equal(h.captures.length,0);assert.equal(h.shortcuts.size,0);assert.ok(h.windows.every(w=>w.isDestroyed()));
});
for(const when of ['before','pending'])test(`浮条保护丢失不交付污染像素 ${when}`,async()=>{
 const h=harness({dialogResponse:0,nativeDeferred:when==='pending'});await h.invoke('shot:scroll-begin',fullRect);
 const c=h.getCurrent(),token=c.scroll.token;
 if(when==='before'){c.scroll.bar.setContentProtection(false);await assert.rejects(h.invoke('shot:scroll-frame',token),/排除已失效/);assert.equal(h.captures.length,0);}
 else{const job=h.invoke('shot:scroll-frame',token);c.scroll.bar.setContentProtection(false);h.resolveNative({fresh:true});await assert.rejects(job,/排除已失效/);}
 h.invoke('shot:scroll-error',token,'长截图浮条排除已失效','sample-error');assert.equal(h.getCurrent(),undefined);assert.equal(h.shortcuts.size,0);
});
test('声明protectedBar但窗口缺失不视为安全，取帧前拒绝',async()=>{
 const h=harness({dialogResponse:0});await h.invoke('shot:scroll-begin',fullRect);const c=h.getCurrent(),bar=c.scroll.bar;c.scroll.bar=undefined;
 await assert.rejects(h.invoke('shot:scroll-frame',c.scroll.token),/排除已失效/);assert.equal(h.captures.length,0);
 h.api.cleanup(c);bar.destroy();assert.equal(h.shortcuts.size,0);
});
for(const action of ['hide','closed','render-process-gone'])test(`受保护浮条${action}时安全结束并清掉两键`,async()=>{
 const h=harness({dialogResponse:0});await h.invoke('shot:scroll-begin',fullRect);const bar=h.getCurrent().scroll.bar;
 if(action==='hide')bar.hide();else if(action==='closed')bar.destroy();else bar.webContents.emit(action);
 assert.equal(h.getCurrent(),undefined);assert.equal(h.shortcuts.size,0);assert.ok(h.windows.every(w=>w.isDestroyed()));
});
test('受保护浮条暂停恢复仍需保护，位置移出工作区也不能采样',async()=>{
 const h=harness({dialogResponse:0});await h.invoke('shot:scroll-begin',fullRect);const c=h.getCurrent(),s=c.scroll;
 await h.invoke('shot:scroll-frame',s.token);assert.equal(h.barInvoke('scroll-bar:toggle-capture').paused,true);assert.equal(s.bar.isVisible(),true);assert.equal(s.bar.isContentProtected(),true);
 assert.equal((await h.invoke('shot:scroll-frame',s.token)).fresh,false);h.barInvoke('scroll-bar:toggle-capture');assert.equal((await h.invoke('shot:scroll-frame',s.token)).fresh,true);
 s.bar.setBounds({x:1001});await assert.rejects(h.invoke('shot:scroll-frame',s.token),/排除已失效/);h.api.cleanup(c);assert.equal(h.shortcuts.size,0);
});
test('受保护浮条启动期间全局取消，迟到启动不复活浮条或泄漏键',async()=>{
 const h=harness({dialogResponse:0,deferStart:true}),pending=h.invoke('shot:scroll-begin',fullRect);await tick();
 const cancel=h.shortcuts.get('CommandOrControl+Alt+Escape');assert.equal(typeof cancel,'function');cancel();h.resolveStart();assert.equal((await pending).started,false);
 assert.equal(h.getCurrent(),undefined);assert.equal(h.shortcuts.size,0);assert.ok(h.windows.every(w=>w.isDestroyed()));assert.doesNotThrow(cancel);
});
test('保护不可用才确认兼容无浮条，双键先于隐藏注册，原尺寸取屏且Esc完成可预览',async()=>{
 const h=harness({noBar:true});assert.equal((await h.invoke('shot:scroll-begin',fullRect)).started,true);
 const current=h.getCurrent(),scroll=current.scroll;assert.equal(scroll.noBar,true);assert.equal(scroll.bar,undefined);assert.equal(scroll.mask,undefined);assert.equal(h.windows.length,2);assert.equal(h.windows[1].isDestroyed(),true);assert.equal(h.intervals.length,0);
 assert.equal(h.dialogs.length,1);assert.equal(h.dialogs[0].parent,h.host);assert.equal(h.dialogs[0].visible,true);assert.match(h.dialogs[0].options.detail,/Esc/);assert.match(h.dialogs[0].options.detail,/Ctrl/);assert.match(h.dialogs[0].options.detail,/全局/);assert.match(h.dialogs[0].options.detail,/弹窗/);assert.equal(h.dialogs[0].options.defaultId,1);assert.equal(h.dialogs[0].options.cancelId,1);
 assert.equal(h.registrations.length,2);assert.ok(h.registrations.every(r=>r.visible));assert.equal(h.host.isVisible(),false);
 const frame=await h.invoke('shot:scroll-frame',scroll.token);assert.equal(frame.width,1000);assert.equal(frame.height,800);assert.deepEqual(h.captures[0],{x:0,y:0,width:1000,height:800});
 const oldFinish=h.shortcuts.get('Escape'),oldCancel=h.shortcuts.get('CommandOrControl+Alt+Escape');oldFinish();oldFinish();assert.equal(current.phase,'scroll-finishing');h.output.width=1000;h.output.height=900;
 assert.equal(h.invoke('shot:scroll-result',scroll.token,{png:new ArrayBuffer(4)}),true);assert.equal(current.phase,'selecting');assert.equal(h.host.isVisible(),true);assert.ok(current.longImage);assert.equal(h.shortcuts.size,0);
 await h.invoke('shot:scroll-begin',fullRect);oldFinish();oldCancel();assert.equal(h.getCurrent().phase,'scrolling');h.shortcuts.get('CommandOrControl+Alt+Escape')();assert.equal(h.shortcuts.size,0);
});
test('保护失败返回框选，兼容确认迟到也不启动或泄漏资源',async()=>{
 const h=harness({protectionFails:true,dialogResponse:1});await assert.rejects(h.invoke('shot:scroll-begin',fullRect),/排除不可用/);assert.equal(h.getCurrent().phase,'selecting');assert.equal(h.host.isVisible(),true);assert.equal(h.shortcuts.size,0);assert.equal(h.executions.length,0);
 const late=harness({protectionFails:true,deferDialog:true}),pending=late.invoke('shot:scroll-begin',fullRect);await tick();assert.equal(late.dialogs.length,1);await assert.rejects(late.invoke('shot:scroll-begin',fullRect),/当前不能/);assert.equal(late.dialogs.length,1);late.shortcuts.get('CommandOrControl+Alt+Escape')();late.resolveDialog(0);assert.equal((await pending).started,false);assert.equal(late.executions.length,0);assert.equal(late.shortcuts.size,0);
});
for(const options of [{escapeFails:true},{cancelKeyFails:true},{shortcutThrows:'Escape'},{shortcutThrows:'CommandOrControl+Alt+Escape'}])test(`全屏快捷键失败仍保留选框并撤回本轮注册：${JSON.stringify(options)}`,async()=>{
 const h=harness(options);await assert.rejects(h.invoke('shot:scroll-begin',fullRect),/快捷键未能注册/);
 assert.equal(h.getCurrent().phase,'selecting');assert.equal(h.host.isVisible(),true);assert.equal(h.host.destroyed,undefined);assert.equal(h.getCurrent().scroll,undefined);assert.equal(h.shortcuts.size,0);assert.equal(h.executions.length,0);assert.equal(h.captures.length,0);
 assert.deepEqual(h.registrations.map(row=>row.key),['Escape','CommandOrControl+Alt+Escape']);
 const acquired=options.escapeFails||options.shortcutThrows==='Escape'?'CommandOrControl+Alt+Escape':'Escape';
 assert.deepEqual(h.unregistered,[acquired]);assert.equal(h.watchers.length,0);
});
test('等待兼容模式选择不消耗准备超时预算，确认后恢复启动并清理',async()=>{
 const h=harness({noBar:true,deferDialog:true}),pending=h.invoke('shot:scroll-begin',fullRect);await tick();
 assert.equal(h.dialogs.length,1);assert.equal(h.getCurrent().scroll.timer,undefined);assert.equal(h.host.isVisible(),true);assert.equal(h.captures.length,0);
 h.resolveDialog(0);assert.equal((await pending).started,true);assert.equal(h.getCurrent().scroll.noBar,true);h.api.cleanup(h.getCurrent());assert.equal(h.shortcuts.size,0);
});
test('全屏快捷键冲突不注销别人的Escape，近全屏仍显示选区外遮罩',async()=>{
 const h=harness({escapeFails:true}),foreign=()=>{};h.shortcuts.set('Escape',foreign);await assert.rejects(h.invoke('shot:scroll-begin',fullRect),/快捷键未能注册/);assert.equal(h.shortcuts.get('Escape'),foreign);assert.equal(h.shortcuts.size,1);assert.equal(h.host.isVisible(),true);
 const near=harness({noBar:true});await near.invoke('shot:scroll-begin',{x:10,y:10,width:980,height:780});assert.equal(near.getCurrent().scroll.bar,undefined);assert.equal(near.getCurrent().scroll.mask.isVisible(),true);assert.equal(near.intervals.length,0);near.shortcuts.get('CommandOrControl+Alt+Escape')();assert.equal(near.shortcuts.size,0);
});
test('无浮条模式启动失败或采样报错都清掉两键，正常浮条不弹确认',async()=>{
 const start=harness({noBar:true,startError:true});await assert.rejects(start.invoke('shot:scroll-begin',fullRect),/取流失败/);assert.equal(start.getCurrent(),undefined);assert.equal(start.shortcuts.size,0);
 const active=harness({noBar:true});await active.invoke('shot:scroll-begin',fullRect);active.invoke('shot:scroll-error',active.getCurrent().scroll.token,'自有错误','sample-error');assert.equal(active.getCurrent(),undefined);assert.equal(active.shortcuts.size,0);
 const normal=harness();await normal.invoke('shot:scroll-begin',rect);assert.equal(normal.dialogs.length,0);assert.ok(normal.getCurrent().scroll.bar);assert.equal(normal.shortcuts.has('CommandOrControl+Alt+Escape'),true);normal.api.cleanup(normal.getCurrent());
});
test('全屏取消快捷键停止源并清理双键，迟到旧回调不影响下一轮',async()=>{
 const h=harness();await h.invoke('shot:scroll-begin',fullRect);const scroll=h.getCurrent().scroll;await h.invoke('shot:scroll-frame',scroll.token);const stop=h.shortcuts.get('CommandOrControl+Alt+Escape'),finish=h.shortcuts.get('Escape');stop();assert.equal(h.getCurrent(),undefined);assert.equal(h.native.stops,1);assert.equal(h.shortcuts.size,0);assert.doesNotThrow(()=>{stop();finish();});
});
test('取消监听仅在scroll-ready启动，准备超时清理后不能创建监听器',async()=>{
 const h=harness({deferStart:true}),pending=h.invoke('shot:scroll-begin',fullRect);await tick();
 assert.equal(h.watchers.length,0);assert.equal(h.dialogs.length,0);assert.ok(h.getCurrent().scroll.timer);
 h.getCurrent().scroll.timer.fn();assert.equal(h.getCurrent(),undefined);assert.equal(h.shortcuts.size,0);
 h.resolveStart();assert.equal((await pending).started,false);assert.equal(h.watchers.length,0);
});

for(const options of [{escapeFails:true},{cancelKeyFails:true},{shortcutThrows:'Escape'},{shortcutThrows:'CommandOrControl+Alt+Escape'},{escapeFails:true,cancelKeyFails:true}])test(`普通外侧浮条双键独立尝试，冲突或抛错不阻止可用浮条 ${JSON.stringify(options)}`,async()=>{
 const h=harness(options);assert.equal((await h.invoke('shot:scroll-begin',rect)).started,true);
 const current=h.getCurrent(),scroll=current.scroll;
 assert.equal(scroll.noBar,false);assert.equal(scroll.bar.isVisible(),true);assert.equal(scroll.bar.ignoreMouse,false);
 assert.deepEqual(h.registrations.map(row=>row.key),['Escape','CommandOrControl+Alt+Escape']);
 const escapeOK=!options.escapeFails&&options.shortcutThrows!=='Escape';
 const cancelOK=!options.cancelKeyFails&&options.shortcutThrows!=='CommandOrControl+Alt+Escape';
 assert.equal(Boolean(scroll.escapeRegistered),escapeOK);assert.equal(Boolean(scroll.cancelRegistered),cancelOK);
 assert.equal(h.shortcuts.has('Escape'),escapeOK);assert.equal(h.shortcuts.has('CommandOrControl+Alt+Escape'),cancelOK);
 assert.equal(h.watchers.length,1);assert.equal(scroll.cancelWatcher,h.watchers[0]);
 assert.equal(h.api.finish(),true);h.api.cleanup(current);
 assert.deepEqual([...h.unregistered].sort(),[...(escapeOK?['Escape']:[]),...(cancelOK?['CommandOrControl+Alt+Escape']:[])].sort());
 assert.equal(h.watchers[0].stops,1);
});
for(const key of ['Escape','CommandOrControl+Alt+Escape'])test(`全屏失败仅撤销本轮持有键，不注销他人快捷键 ${key}`,async()=>{
 const h=harness({escapeFails:key==='Escape',cancelKeyFails:key!=='Escape'}),foreign=()=>{};
 h.shortcuts.set(key,foreign);await assert.rejects(h.invoke('shot:scroll-begin',fullRect),/快捷键未能注册/);
 assert.equal(h.shortcuts.get(key),foreign);assert.equal(h.shortcuts.size,1);assert.equal(h.unregistered.includes(key),false);
 assert.equal(h.getCurrent().phase,'selecting');assert.equal(h.windows.length,1);assert.equal(h.watchers.length,0);
});
for(const mode of ['outside','protected','noBar'])test(`右键监听取消停止原生、释放窗口及双键，绝不保存或复制 ${mode}`,async()=>{
 const ends=[],h=harness({noBar:mode==='noBar',diagnostics:{record(){},end:reason=>ends.push(reason)}});
 await h.invoke('shot:scroll-begin',mode==='outside'?rect:fullRect);const current=h.getCurrent(),scroll=current.scroll;
 assert.equal(h.watchers.length,1);assert.equal(scroll.cancelWatcher,h.watchers[0]);
 await h.invoke('shot:scroll-frame',scroll.token);assert.equal(h.native.stops,0);
 h.watchers[0].onCancel();
 assert.equal(h.getCurrent(),undefined);assert.equal(current.scroll,undefined);assert.equal(h.native.stops,1);
 assert.ok(h.windows.every(w=>w.isDestroyed()));assert.equal(h.shortcuts.size,0);assert.equal(h.watchers[0].stops,1);
 assert.deepEqual(h.cancelReasons,['cancelled']);assert.deepEqual(ends,['cancelled']);
 assert.equal(current.longImage,undefined);assert.equal(current.longToken,undefined);
 assert.equal(h.host.sent.some(row=>['shot:scroll-complete','shot:scroll-stop'].includes(row.name)),false);
 assert.equal(h.invoke('shot:scroll-result',scroll.token,{png:new ArrayBuffer(4)}),false);
 assert.equal(h.imageDecodes(),0);assert.deepEqual(h.fileWrites,[]);assert.deepEqual(h.clipboardWrites,[]);
 assert.match(h.statuses.at(-1).message,/取消/);assert.match(h.statuses.at(-1).message,/未保存|不保存/);
 const count=h.statuses.length;assert.doesNotThrow(()=>{h.watchers[0].onCancel();h.watchers[0].onError(new Error('迟到'));});
 assert.equal(h.statuses.length,count);assert.equal(h.native.stops,1);assert.equal(h.watchers[0].stops,1);
});
test('右键取消暂停中的当前会话，不意外提交长图',async()=>{
 const h=harness();await h.invoke('shot:scroll-begin',rect);const current=h.getCurrent(),scroll=current.scroll;
 await h.invoke('shot:scroll-frame',scroll.token);
 h.barInvoke('scroll-bar:toggle-capture');
 h.watchers[0].onCancel();assert.equal(h.getCurrent(),undefined);assert.equal(h.native.stops,1);
 assert.equal(h.watchers[0].stops,1);assert.equal(h.shortcuts.size,0);assert.ok(h.windows.every(w=>w.isDestroyed()));
 assert.equal(current.longImage,undefined);assert.equal(h.invoke('shot:scroll-result',scroll.token,{png:new ArrayBuffer(4)}),false);
 assert.equal(h.imageDecodes(),0);assert.deepEqual(h.fileWrites,[]);assert.deepEqual(h.clipboardWrites,[]);
 assert.equal(h.host.sent.some(row=>row.name==='shot:scroll-complete'),false);
});
test('右键取消在途原生帧后，迟到回包失效且不生成预览',async()=>{
 const h=harness({nativeDeferred:true});await h.invoke('shot:scroll-begin',rect);const scroll=h.getCurrent().scroll;
 const pending=h.invoke('shot:scroll-frame',scroll.token);
 h.watchers[0].onCancel();assert.equal(h.native.stops,1);assert.equal(h.watchers[0].stops,1);
 h.resolveNative({fresh:true});await assert.rejects(pending,/失效/);
 assert.equal(h.getCurrent(),undefined);assert.equal(h.imageDecodes(),0);
 assert.equal(h.host.sent.some(row=>row.name==='shot:scroll-complete'),false);
 assert.deepEqual(h.fileWrites,[]);assert.deepEqual(h.clipboardWrites,[]);
});
for(const phase of ['scrolling','scroll-finishing'])test(`监听清理后旧回调不影响新轮次或无会话 ${phase}`,async()=>{
 const h=harness();await h.invoke('shot:scroll-begin',rect);const current=h.getCurrent(),old=h.watchers[0];
 if(phase==='scroll-finishing')assert.equal(h.api.finish(),true);
 h.api.cleanup(current);assert.equal(old.stops,1);
 const idleCount=h.statuses.length;old.onCancel();old.onError(new Error('已清理'));
 assert.equal(h.getCurrent(),current);assert.equal(current.scroll,undefined);assert.equal(h.statuses.length,idleCount);
 current.phase='selecting';await h.invoke('shot:scroll-begin',rect);
 const next=current.scroll,newWatcher=h.watchers[1],before=h.statuses.length;
 old.onCancel();old.onError(new Error('旧轮次'));
 assert.equal(h.getCurrent(),current);assert.equal(current.scroll,next);assert.equal(current.phase,'scrolling');
 assert.equal(h.statuses.length,before);assert.equal(newWatcher.stops,0);assert.equal(h.shortcuts.size,2);
 assert.equal(h.cancelReasons.length,0);assert.equal(next.bar.isDestroyed(),false);assert.equal(next.mask.isDestroyed(),false);
 h.closeSession();assert.equal(newWatcher.stops,1);const closedCount=h.statuses.length;
 assert.doesNotThrow(()=>{old.onCancel();newWatcher.onCancel();old.onError(new Error('无会话'));newWatcher.onError(new Error('无会话'));});
 assert.equal(h.getCurrent(),undefined);assert.equal(h.statuses.length,closedCount);assert.equal(newWatcher.stops,1);
});
for(const mode of ['outside','protected','noBar'])test(`右键监听故障只提示替代取消方式，不中断会话 ${mode}`,async()=>{
 const h=harness({noBar:mode==='noBar'});await h.invoke('shot:scroll-begin',mode==='outside'?rect:fullRect);const current=h.getCurrent(),scroll=current.scroll;
 await h.invoke('shot:scroll-frame',scroll.token);
 assert.doesNotThrow(()=>h.watchers[0].onError(new Error('模拟监听进程退出')));
 assert.equal(h.getCurrent(),current);assert.equal(current.scroll,scroll);assert.equal(current.phase,'scrolling');assert.equal(h.native.stops,0);
 assert.match(h.statuses.at(-1).message,/右键/);assert.match(h.statuses.at(-1).message,/不可用|无法|失败/);
 assert.match(h.statuses.at(-1).message,/Ctrl\+Alt\+Esc/);assert.equal(h.shortcuts.has('CommandOrControl+Alt+Escape'),true);
 if(scroll.bar)assert.equal(scroll.bar.isVisible(),true);
 assert.equal((await h.invoke('shot:scroll-frame',scroll.token)).fresh,true);
 h.shortcuts.get('CommandOrControl+Alt+Escape')();assert.equal(h.getCurrent(),undefined);assert.equal(h.native.stops,1);
 assert.equal(h.watchers[0].stops,1);assert.deepEqual(h.fileWrites,[]);assert.deepEqual(h.clipboardWrites,[]);
});
test('右键监听启动抛错不崩会话，键盘取消仍能完整清理',async()=>{
 const h=harness({watcherThrows:true});assert.equal((await h.invoke('shot:scroll-begin',rect)).started,true);
 assert.equal(h.getCurrent().phase,'scrolling');assert.equal(h.watchers.length,0);
 assert.ok(h.statuses.some(row=>/右键/.test(row.message)&&/Ctrl\+Alt\+Esc/.test(row.message)));
 h.shortcuts.get('CommandOrControl+Alt+Escape')();assert.equal(h.getCurrent(),undefined);assert.equal(h.shortcuts.size,0);
 assert.ok(h.windows.every(w=>w.isDestroyed()));
});
test('普通浮条完成预览与重复清理均停止本轮监听且只停止一次',async()=>{
 const h=harness();await h.invoke('shot:scroll-begin',rect);const current=h.getCurrent(),watcher=h.watchers[0],token=current.scroll.token;
 assert.equal(h.api.finish(),true);assert.equal(h.invoke('shot:scroll-result',token,{png:new ArrayBuffer(4)}),true);
 assert.equal(watcher.stops,1);h.api.cleanup(current);assert.equal(watcher.stops,1);
 const before=h.statuses.length;watcher.onCancel();watcher.onError(new Error('预览后的旧错误'));
 assert.equal(h.getCurrent(),current);assert.equal(current.phase,'selecting');assert.ok(current.longImage);assert.equal(h.statuses.length,before);
});

test('预览基线：发送消息不等于显示成功，不应立即封口诊断', async () => {
  const ends = [], h = harness({ diagnostics: { record() {}, end: reason => ends.push(reason) } });
  await h.invoke('shot:scroll-begin', rect); const token = h.getCurrent().scroll.token;
  assert.equal(h.invoke('shot:scroll-result', token, { png: new ArrayBuffer(4) }), true);
  assert.deepEqual(ends, []); assert.equal(h.getCurrent().longPreviewPending, true);
});

test('残留基线：采集出错必须销毁全屏选框，不自动恢复交叉光标遮罩', async () => {
  const h = harness(); await h.invoke('shot:scroll-begin', rect);
  const token = h.getCurrent().scroll.token, bar = h.getCurrent().scroll.bar;
  h.invoke('shot:scroll-error', token, '采样已中断', 'sample-error');
  assert.equal(h.getCurrent(), undefined); assert.equal(h.host.isDestroyed(), true);
  assert.equal(bar.isDestroyed(), true); assert.equal(h.shortcuts.size, 0);
  assert.equal(h.api.captureRequest(h.host.webContents.mainFrame), undefined);
  assert.equal(h.host.sent.some(row => row.name === 'shot:scroll-complete' && row.value.ok === false), false);
  assert.equal(h.invoke('shot:scroll-result', token, { png: new ArrayBuffer(4) }), false);
});

test('普通浮条留在选区外且不屏蔽远程，无空位直接保护浮条', async () => {
  const h = harness();
  const roi = { x: 100, y: 10, width: 200, height: 700 };
  await h.invoke('shot:scroll-begin', roi);
  const bar = h.getCurrent().scroll.bar, b = bar.bounds;
  assert.equal(bar.isContentProtected(), false);
  assert.ok(b.x + b.width <= roi.x || b.x >= roi.x + roi.width || b.y + b.height <= roi.y || b.y >= roi.y + roi.height);
  h.api.cleanup(h.getCurrent());
  const full = harness(); assert.equal((await full.invoke('shot:scroll-begin', { x: 0, y: 0, width: 1000, height: 760 })).started,true);
  assert.equal(full.getCurrent().phase,'scrolling');assert.equal(full.getCurrent().scroll.protectedBar,true);assert.equal(full.getCurrent().scroll.noBar,false);assert.ok(full.getCurrent().scroll.bar);
  assert.equal(full.dialogs.length,0);assert.equal(full.host.isVisible(),false);assert.equal(full.captures.length,0);full.api.cleanup(full.getCurrent());
});
test('修复基线：零增长明确未接长且未保存，不伪装成长图成功', async () => {
  const h = harness({ noGrowth: true }); await h.invoke('shot:scroll-begin', rect);
  const token = h.getCurrent().scroll.token;
  assert.equal(h.invoke('shot:scroll-result', token, { png: new ArrayBuffer(4) }), false);
  assert.equal(h.host.sent.some(row => row.name === 'shot:scroll-complete'), false);
  assert.equal(h.getCurrent(), undefined); assert.equal(h.host.isDestroyed(), true);
  assert.match(h.statuses.at(-1).message, /未接长/);
  assert.match(h.statuses.at(-1).message, /未保存/);
});

for (const [edge, roi] of [
  ['below', { x: 10, y: 100, width: 980, height: 200 }],
  ['above', { x: 10, y: 600, width: 980, height: 140 }],
  ['right', { x: 100, y: 30, width: 200, height: 700 }],
  ['left', { x: 700, y: 30, width: 200, height: 700 }]
]) test(`浮条${edge}外置：负坐标工作区也不遮挡选区、不抢焦点`, async () => {
  const h = harness({ displayBounds: { x: -1920, y: -200, width: 1000, height: 800 },
    workArea: { x: -1920, y: -180, width: 1000, height: 740 } }), current = h.getCurrent();
  await h.invoke('shot:scroll-begin', roi);
  const bar = current.scroll.bar, b = bar.bounds, x = roi.x - 1920, y = roi.y - 200;
  assert.ok(b.x >= -1920 && b.y >= -180 && b.x + b.width <= -920 && b.y + b.height <= 560);
  assert.ok(edge === 'below' ? b.y >= y + roi.height : edge === 'above' ? b.y + b.height <= y : edge === 'right' ? b.x >= x + roi.width : b.x + b.width <= x);
  assert.notEqual(bar.focused, true); h.api.cleanup(current);
});
for(const via of ['api','escape','bar'])test(`完成路径统一通知菜单撤掉完成入口：${via}`,async()=>{
  const h=harness();await h.invoke('shot:scroll-begin',rect);const before=h.statuses.length;
  if(via==='api')h.api.finish();else if(via==='escape')h.shortcuts.get('Escape')();else h.barInvoke('scroll-bar:finish');
  assert.equal(h.getCurrent().phase,'scroll-finishing');assert.equal(h.statuses.length,before+1);assert.match(h.statuses.at(-1).message,/正在合成长图/);
  h.api.cleanup(h.getCurrent());
});

test('Escape占用时浮条和托盘使用的完成入口仍可收工', async () => {
  const h = harness({ escapeFails: true }); await h.invoke('shot:scroll-begin', rect);
  assert.equal(h.getCurrent().scroll.bar.isVisible(),true); assert.equal(h.api.finish(), true);
  assert.equal(h.host.sent.filter(row => row.name === 'shot:scroll-stop').length, 1);
  h.api.cleanup(h.getCurrent()); assert.deepEqual(h.unregistered, ['CommandOrControl+Alt+Escape']);
});

test('零增长断流保留中断原因，销毁选框且不产生token', async () => {
  const ends = [], h = harness({ diagnostics: { record() {}, end: reason => ends.push(reason) } });
  await h.invoke('shot:scroll-begin', rect); const token = h.getCurrent().scroll.token;
  h.invoke('shot:scroll-error', token, '屏幕流已中断', 'media-ended');
  assert.deepEqual(ends, ['media-ended']); assert.equal(h.getCurrent(), undefined);
  assert.equal(h.host.isDestroyed(), true); assert.match(h.statuses.at(-1).message, /屏幕流已中断/);
  assert.match(h.statuses.at(-1).message, /未保存/);
});

test('诊断记录窗口API状态但不冒充远程可见，结果只称预览已发送', async () => {
  const traces = [], ends = [];
  const h = harness({ diagnostics: { record: (event, fields) => traces.push({ event, fields }), end: reason => ends.push(reason) } });
  await h.invoke('shot:scroll-begin', rect);
  const token = h.getCurrent().scroll.token;
  assert.equal(h.invoke('shot:scroll-result', token, { png: new ArrayBuffer(4) }), true);
  assert.deepEqual(traces.map(row => row.event), ['scroll-request', 'worker-call', 'mask-ready', 'bar-ready', 'window-hidden', 'result-received', 'scroll-cleanup', 'preview-sent']);
  assert.equal(traces.find(row => row.event === 'bar-ready').fields.barProtected, false);
  assert.equal(traces.find(row => row.event === 'window-hidden').fields.remoteVisibility, 'unobserved');
  assert.deepEqual(ends, []); assert.equal(h.getCurrent().longPreviewPending, true);
  assert.doesNotMatch(JSON.stringify(traces), /data:|preview-dom-ready/);
});

test('精确窗口＋事务授权，流就绪后隐藏选区；结束释放 Escape', async () => {
  const h = harness();
  assert.equal(h.api.captureRequest(h.host.webContents.mainFrame), undefined);
  const result = await h.invoke('shot:scroll-begin', rect);
  assert.equal(result.started, true);
  const current = h.getCurrent();
  assert.equal(current.phase, 'scrolling');
  assert.equal(h.host.visible, false);
  assert.equal(h.executions[0].gesture, true);
  assert.equal(h.api.captureRequest({}), undefined);
  assert.equal(h.api.captureRequest(h.host.webContents.mainFrame).token, current.scroll.token);
  h.api.cleanup(current);
  assert.equal(h.api.captureRequest(h.host.webContents.mainFrame), undefined);
  assert.ok(h.unregistered.includes('Escape'));
});
test('多个完成入口只发一次停采样，结果只接收当前 token', async () => {
  const h = harness();
  await h.invoke('shot:scroll-begin', rect);
  const token = h.getCurrent().scroll.token;
  assert.equal(h.api.finish(), true);
  assert.equal(h.api.finish(), false);
  assert.equal(h.host.sent.filter(item => item.name === 'shot:scroll-stop').length, 1);
  assert.equal(h.getCurrent().phase, 'scroll-finishing');
  assert.equal(h.invoke('shot:scroll-result', 'stale', { png: new ArrayBuffer(4) }), false);
  assert.equal(h.invoke('shot:scroll-result', token, { png: new ArrayBuffer(4) }), true);
  assert.equal(h.getCurrent().phase, 'selecting');
  assert.equal(h.getCurrent().longImage.getSize().height, 500);
  assert.equal(h.host.visible, true);
  assert.equal(h.host.sent.filter(item => item.name === 'shot:scroll-complete' && item.value.ok).length, 1);
  assert.equal(h.invoke('shot:scroll-result', token, { png: new ArrayBuffer(4) }), false);
});
test('错误尺寸不能伪造成功长图，不重开全屏选框', async () => {
  const h = harness({ badSize: true });
  await h.invoke('shot:scroll-begin', rect);
  const token = h.getCurrent().scroll.token;
  assert.equal(h.invoke('shot:scroll-result', token, { png: new ArrayBuffer(4) }), false);
  assert.equal(h.getCurrent(), undefined);
  assert.equal(h.host.isDestroyed(), true);
  assert.match(h.statuses.at(-1).message, /尺寸无效/);
});
test('启动期间取消，迟到的媒体启动不会恢复或留下浮条', async () => {
  const h = harness({ deferStart: true });
  const pending = h.invoke('shot:scroll-begin', rect);
  await tick();
  h.barInvoke('scroll-bar:cancel');
  h.resolveStart();
  assert.equal((await pending).started, false);
  assert.equal(h.getCurrent(), undefined);
  assert.equal(h.windows[1].destroyed, true);
  assert.equal(h.api.captureRequest(h.host.webContents.mainFrame), undefined);
});
test('启动取流失败彻底结束选区与浮条，不依赖Esc或重新聚焦', async () => {
  const h = harness({ startError: true }); await assert.rejects(h.invoke('shot:scroll-begin', rect), /模拟取流失败/);
  assert.equal(h.getCurrent(), undefined); assert.ok(h.windows.every(w => w.isDestroyed()));
  assert.match(h.statuses.at(-1).message, /按 F1/);
});
test('启动超时结束后，迟到任务不重显窗口或重新授权', async () => {
  const h = harness({ deferStart: true }); const pending = h.invoke('shot:scroll-begin', rect); await tick();
  h.getCurrent().scroll.timer.fn(); assert.equal(h.getCurrent(), undefined);
  h.resolveStart(); assert.equal((await pending).started, false);
  assert.ok(h.windows.every(w => w.isDestroyed())); assert.equal(h.api.captureRequest(h.host.webContents.mainFrame), undefined);
});
test('小选区预检失败无采集资源，仍保留普通选框供调整', async () => {
  const h = harness(); await assert.rejects(h.invoke('shot:scroll-begin', { ...rect, width: 10 }), /至少/);
  assert.equal(h.getCurrent().phase, 'selecting'); assert.equal(h.host.isDestroyed(), false);
  assert.equal(h.windows.length, 1);
});

test('Escape 被占用不阻止捕获，也不误注销别人的快捷键', async () => {
  const h = harness({ escapeFails: true });
  await h.invoke('shot:scroll-begin', rect);
  assert.match(h.getCurrent().scroll.status.message, /点完成/);
  h.api.cleanup(h.getCurrent());
  assert.deepEqual(h.unregistered, ['CommandOrControl+Alt+Escape']);
});

test('异常恢复：recovered 且带明确警告时允许首屏高度进预览，仍不自动保存或复制', async () => {
  const h = harness({ noGrowth: true });
  await h.invoke('shot:scroll-begin', rect);
  const token = h.getCurrent().scroll.token;
  assert.equal(h.invoke('shot:scroll-result', token, { png: new ArrayBuffer(4), warning: '计算中断，仅保留首屏，后续未拼入', recovered: true }), true);
  const complete = h.host.sent.find(row => row.name === 'shot:scroll-complete');
  assert.ok(complete, '恢复预览必须走既有预览出口');
  assert.equal(complete.value.ok, true);
  assert.match(complete.value.warning, /计算中断/);
  assert.equal(h.getCurrent().phase, 'selecting');
  assert.equal(h.getCurrent().longImage.getSize().height, 200);
  assert.equal(h.imageDecodes(), 1);
  assert.deepEqual(h.fileWrites, []); assert.deepEqual(h.clipboardWrites, []);
  assert.match(h.statuses.at(-1).message, /仅保留已接部分/);
  assert.match(h.statuses.at(-1).message, /尚未保存/);
});
test('异常恢复的放行条件严格：空警告、非布尔真值或缺标志仍按零增长拒绝', async () => {
  const packets = [
    { png: new ArrayBuffer(4), warning: '', recovered: true },
    { png: new ArrayBuffer(4), warning: '   ', recovered: true },
    { png: new ArrayBuffer(4), warning: '有恢复说明', recovered: 'true' },
    { png: new ArrayBuffer(4), warning: '有恢复说明', recovered: 1 },
    { png: new ArrayBuffer(4), warning: '有恢复说明' },
  ];
  for (const packet of packets) {
    const h = harness({ noGrowth: true });
    await h.invoke('shot:scroll-begin', rect);
    const token = h.getCurrent().scroll.token;
    assert.equal(h.invoke('shot:scroll-result', token, packet), false);
    assert.equal(h.host.sent.some(row => row.name === 'shot:scroll-complete'), false);
    assert.match(h.statuses.at(-1).message, /未接长/);
    assert.equal(h.getCurrent(), undefined);
  }
});

// —— 多屏第一阶段：多屏列表里只按本屏 id 换算，竖屏/负原点/偏移工作区 ——
test('多屏列表：竖屏125%只按本屏id换算物理ROI，方向键与原生取帧同一矩形', async () => {
  const bounds = { x: -1600, y: -900, width: 720, height: 1280 };
  const h = harness({ scaleFactor: 1.25, displayBounds: bounds, physicalOrigin: { x: -2003, y: -1129 },
    extraDisplays: [
      { id: 9, scaleFactor: 2, bounds: { x: 0, y: 0, width: 800, height: 600 }, physical: { x: 0, y: 0, width: 1600, height: 1200 } },
      { id: 10, scaleFactor: 1.5, bounds: { x: -1280, y: -900, width: 900, height: 1200 }, physical: { x: -1924, y: -1351, width: 1350, height: 1800 } }
    ] });
  await h.invoke('shot:scroll-begin', rect);
  await h.invoke('shot:scroll-frame', h.getCurrent().scroll.token);
  // 屏内 10,20 起 200x200，125% 下为 13,25 起 250x250；原点用系统给的 -2003/-1129，不是 DIP×缩放。
  assert.deepEqual(h.captures[0], { x: -1990, y: -1104, width: 250, height: 250 });
  assert.deepEqual(h.wheels[0].region, h.captures[0], '方向键与原生取帧共用同一物理矩形');
  const area = h.getCurrent().display.workArea, bar = h.getCurrent().scroll.bar.bounds;
  assert.ok(bar.x >= area.x && bar.y >= area.y && bar.x + bar.width <= area.x + area.width && bar.y + bar.height <= area.y + area.height);
  h.api.cleanup(h.getCurrent());
});

test('竖屏＋左偏工作区：遮罩盖整屏，浮条留工作区，取屏仍用真实物理原点', async () => {
  const bounds = { x: 1280, y: -200, width: 720, height: 1280 };
  const h = harness({ scaleFactor: 1.25, displayBounds: bounds, physicalOrigin: { x: 1597, y: -253 },
    workArea: { x: 1340, y: -200, width: 660, height: 1220 } });
  const current = h.getCurrent();
  await h.invoke('shot:scroll-begin', { x: 10, y: 20, width: 300, height: 300 });
  const area = current.display.workArea, bar = current.scroll.bar.bounds;
  assert.ok(bar.x >= area.x && bar.y >= area.y && bar.x + bar.width <= area.x + area.width && bar.y + bar.height <= area.y + area.height, '浮条留在偏移后的工作区');
  // 与全局 DIP 选区比较，不能拿带屏原点的浮条坐标去比本地 10,20（会恒真）。
  // 物理端点取整后，x=1280+round(10*1.25)/1.25=1290.4。
  const roi = { x: 1290.4, y: -180, width: 300, height: 300 };
  assert.ok(bar.x >= roi.x + roi.width || bar.y >= roi.y + roi.height || bar.x + bar.width <= roi.x || bar.y + bar.height <= roi.y, '浮条不压进全局选区');
  const mask = h.windows.find(win => win.file?.endsWith('scroll-mask.html')), layout = JSON.parse(mask.loadOptions.query.layout);
  assert.deepEqual({ x: mask.bounds.x, y: mask.bounds.y, width: mask.bounds.width, height: mask.bounds.height }, bounds, '遮罩仍盖整块屏，不缩到工作区');
  assert.deepEqual(layout.frame, { width: 900, height: 1600 }, '交出去的是真实物理帧，不是 DIP 边界');
  assert.deepEqual(layout.pixels, { x: 13, y: 25, width: 375, height: 375 });
  await h.invoke('shot:scroll-frame', current.scroll.token);
  assert.deepEqual(h.captures[0], { x: 1610, y: -228, width: 375, height: 375 });
  assert.deepEqual(h.wheels[0].region, h.captures[0]);
  h.api.cleanup(current);
});

test('多屏中断开当前屏：剩下的屏不允许顶上，直接拒绝取帧', async () => {
  const h = harness({ extraDisplays: [{ id: 9, scaleFactor: 2, bounds: { x: 0, y: 0, width: 800, height: 600 }, physical: { x: 0, y: 0, width: 1600, height: 1200 } }] });
  await h.invoke('shot:scroll-begin', rect);
  h.dropDisplay(7);
  await assert.rejects(h.invoke('shot:scroll-frame', h.getCurrent().scroll.token), /显示器/);
  assert.equal(h.captures.length, 0); assert.equal(h.wheels.length, 1);
  h.api.cleanup(h.getCurrent());
});

test('scroll-request 只多一个数值 displayId，不带屏名或物理矩形', async () => {
  const traces = [];
  const h = harness({ scaleFactor: 1.5, displayBounds: { x: -1000, y: 200, width: 1000, height: 800 }, physicalOrigin: { x: -1489, y: 301 },
    diagnostics: { startAutomatic() {}, record: (event, fields) => traces.push({ event, ...fields }), end() {} } });
  await h.invoke('shot:scroll-begin', rect);
  const start = traces.find(row => row.event === 'scroll-request');
  assert.equal(start.displayId, 7);
  assert.deepEqual(Object.keys(start).sort(), ['displayId', 'event', 'frameHeight', 'frameWidth', 'height', 'phase', 'scaleFactor', 'width']);
  assert.doesNotMatch(JSON.stringify(traces), /-1489|physical|bounds|显示器/);
  h.api.cleanup(h.getCurrent());
});

// —— 175% 副屏现场：真实帧 1920×1080，Electron 的 dipToScreenRect 仍报 1922×1082 ——
// hint 只用来复核物理映射没变；屏内 ROI 以查询到的真实矩形为基准，不每帧启动元数据程序。
const fieldGeometry = { scaleFactor: 1.75, displayBounds: { x: 1920, y: 274, width: 1098, height: 618 },
  physicalRect: { x: 3840, y: 548, width: 1922, height: 1082 }, canonicalRect: { x: 3840, y: 548, width: 1920, height: 1080 } };

test('175% 副屏：真实 1920×1080 帧按 nativeBounds 映射屏内 ROI，不拿 1922 hint 当基准', async () => {
  const h = harness(fieldGeometry);
  await h.invoke('shot:scroll-begin', rect);
  const current = h.getCurrent();
  const pixels = toPixels(rect, current.selectionBounds, current.image.getSize());
  const expected = { x: 3840 + pixels.x, y: 548 + pixels.y, width: pixels.width, height: pixels.height };
  assert.equal(pixels.width, 350, '屏内换算按真实帧宽 1920，不是 1922');
  assert.deepEqual({ ...h.wheels[0].region }, expected);
  const frame = await h.invoke('shot:scroll-frame', current.scroll.token);
  assert.equal(frame.fresh, true);
  assert.deepEqual(h.captures[0], expected, '原生 ROI 落在真实 1920×1080 内');
  assert.ok(expected.y + expected.height <= 548 + 1080);
  h.closeSession();
});

test('长截中物理映射变化（hint 变了）安全拒绝，不按旧矩形继续采屏', async () => {
  const h = harness(fieldGeometry);
  await h.invoke('shot:scroll-begin', rect);
  const current = h.getCurrent();
  h.patchPhysical({ x: 3840, y: 548, width: 1924, height: 1082 });
  await assert.rejects(h.invoke('shot:scroll-frame', current.scroll.token), /显示器物理映射发生变化/);
  h.closeSession();
});

test('真实矩形与冻结帧尺寸不一致时拒绝，不缩放拼接', async () => {
  // env 在 begin 时就冻结：帧与真实矩形不一致（而不是事后改会话字段）也必须拒绝。
  const h = harness({ ...fieldGeometry, frameSize: { width: 1918, height: 1080 } });
  await h.invoke('shot:scroll-begin', rect);
  await assert.rejects(h.invoke('shot:scroll-frame', h.getCurrent().scroll.token), /原生显示器尺寸不匹配/);
  h.closeSession();
});

test('没有真实矩形的内部合成实验仍走旧的严格同等比较', async () => {
  // 无 canonical：physical 与帧尺寸一致时才通过；多 1px 仍拒绝（旧断言不变）。
  const ok = harness({ scaleFactor: 1.5, physicalOrigin: { x: -1500, y: 60 } });
  await ok.invoke('shot:scroll-begin', rect);
  assert.deepEqual({ ...ok.wheels[0].region }, { x: -1485, y: 90, width: 300, height: 300 });
  ok.closeSession();
  const bad = harness({ scaleFactor: 1.5, physicalSizeMismatch: true });
  await bad.invoke('shot:scroll-begin', rect);
  await assert.rejects(bad.invoke('shot:scroll-frame', bad.getCurrent().scroll.token), /原生显示器尺寸不匹配/);
  bad.closeSession();
});

test('175% 副屏：长截遮罩先按真实物理矩形拟合，再走原严格尺寸检查', async () => {
  const h = harness(fieldGeometry);
  await h.invoke('shot:scroll-begin', rect);
  const current = h.getCurrent();
  const maskCalls = h.fitCalls.filter(entry => entry.kind === 'mask');
  assert.equal(maskCalls.length, 1, '遮罩必须拟合一次');
  const fit = maskCalls[0];
  assert.equal(fit.win, current.scroll.mask);
  assert.equal(fit.win.title, fit.nonce, 'nonce 写在隐藏遮罩标题上');
  assert.match(fit.nonce, /^[0-9a-f]{32}$/);
  assert.deepEqual({ ...fit.bounds }, { x: 3840, y: 548, width: 1920, height: 1080 });
  assert.equal(fit.loadedBefore, false, '必须先拟合再 loadFile');
  assert.ok(fit.win.file.endsWith('scroll-mask.html'));
  const fittedBounds = fit.win.getBounds();
  assert.deepEqual(['x', 'y', 'width', 'height'].map(key => fittedBounds[key]),
    ['x', 'y', 'width', 'height'].map(key => current.display.bounds[key]), '拟合后 getBounds 等于 DIP 边界');
  assert.equal(fit.win.isVisible(), true, 'scroll-ready 后才显示遮罩');
  h.closeSession();
});

test('175% 副屏：遮罩拟合失败即停止长截，不加载提示页也不留窗口', async () => {
  const h = harness(fieldGeometry);
  h.setFitMode('reject', 'mask');
  await assert.rejects(h.invoke('shot:scroll-begin', rect), /窗口物理布局失败/);
  assert.ok(h.statuses.some(state => /长截图未开始：窗口物理布局失败/.test(state.message)), '安全提示带明确原因');
  const maskCalls = h.fitCalls.filter(entry => entry.kind === 'mask');
  assert.equal(maskCalls.length, 1);
  assert.equal(maskCalls[0].win.file, undefined, '拟合失败不得加载提示页');
  assert.equal(maskCalls[0].win.destroyed, true);
  assert.equal(h.captures.length, 0);
  assert.deepEqual(h.cancelReasons, ['failed']);
});

test('175% 副屏：遮罩拟合期间取消，迟到完成不加载提示页也不残留', async () => {
  const h = harness(fieldGeometry);
  h.setFitMode('defer', 'mask');
  const job = h.invoke('shot:scroll-begin', rect);
  await new Promise(resolve => setImmediate(resolve));
  const maskCalls = h.fitCalls.filter(entry => entry.kind === 'mask');
  assert.equal(maskCalls.length, 1);
  const mask = maskCalls[0].win;
  h.closeSession();
  h.resolveFit();
  assert.equal((await job).started, false);
  assert.equal(mask.file, undefined, '取消后不得再加载遮罩页');
  assert.equal(mask.destroyed, true);
  assert.equal(h.captures.length, 0);
});

test('175% 副屏：浮条在加载前按真实物理子矩形拟合，仍夹在监视器内', async () => {
  const h = harness(fieldGeometry);
  await h.invoke('shot:scroll-begin', rect);
  const current = h.getCurrent(), bar = current.scroll.bar;
  const call = h.fitCalls.find(entry => entry.win === bar);
  assert.ok(call, '浮条必须拟合一次');
  assert.equal(call.kind, 'bar');
  assert.equal(call.mode, 'inside', '浮条用监视器内子矩形模式');
  assert.match(call.nonce, /^[0-9a-f]{32}$/);
  assert.equal(bar.title, call.nonce);
  assert.equal(call.loadedBefore, false, '必须先拟合再 loadFile');
  assert.ok(bar.file.endsWith('scroll-bar.html'));
  const width = Math.round(bar.bounds.width * 1.75), height = Math.round(bar.bounds.height * 1.75);
  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
  assert.deepEqual({ ...call.bounds }, {
    x: clamp(3840 + Math.round((bar.bounds.x - 1920) * 1.75), 3840, 3840 + 1920 - width),
    y: clamp(548 + Math.round((bar.bounds.y - 274) * 1.75), 548, 548 + 1080 - height),
    width, height }, '位置按真实物理原点换算并夹在监视器内');
  h.closeSession();
});

test('175% 副屏：浮条拟合失败即停止长截，不加载浮条页', async () => {
  const h = harness(fieldGeometry);
  h.setFitMode('reject', 'bar');
  await assert.rejects(h.invoke('shot:scroll-begin', rect), /窗口物理布局失败/);
  const barCall = h.fitCalls.find(entry => entry.kind === 'bar');
  assert.equal(barCall.win.file, undefined);
  assert.equal(barCall.win.destroyed, true);
  assert.equal(h.fitCalls.some(entry => entry.kind === 'mask'), false, '浮条失败不再创建遮罩');
  assert.equal(h.captures.length, 0);
});

test('175% 副屏：浮条夹取改用真实工作区，贴底时向上夹进工作区', async () => {
  // 工作区 DIP 高 540（bottom=814）刚好容纳 520 高浮条；真实物理工作区底边 1484 比 DIP 投影更短，
  // 必须按真实工作区向上夹 9px，否则窗口底边会顶出工作区。
  const h = harness({ scaleFactor: 1.75, displayBounds: { x: 1920, y: 274, width: 1098, height: 618 },
    physicalRect: { x: 3840, y: 548, width: 1922, height: 1082 }, canonicalRect: { x: 3840, y: 548, width: 1920, height: 1080 },
    workArea: { x: 1920, y: 274, width: 1098, height: 540 }, workRect: { x: 3840, y: 548, width: 1920, height: 936 } });
  await h.invoke('shot:scroll-begin', rect);
  const bar = h.getCurrent().scroll.bar;
  const call = h.fitCalls.find(entry => entry.win === bar);
  assert.ok(call, '浮条必须拟合');
  assert.equal(call.bounds.height, 910);
  assert.equal(call.bounds.y, 574, '底边夹到真实工作区底边 1484');
  assert.equal(call.bounds.y + call.bounds.height, 1484);
  assert.ok(call.bounds.y >= 548, '不越过工作区上边');
  h.closeSession();
});

test('175% 副屏：长截中工作区投影变化安全拒绝，不用过期工作区继续采样', async () => {
  const h = harness(fieldGeometry);
  await h.invoke('shot:scroll-begin', rect);
  const current = h.getCurrent();
  h.patchWorkHint({ x: 3840, y: 548, width: 1922, height: 978 });
  await assert.rejects(h.invoke('shot:scroll-frame', current.scroll.token), /显示器工作区发生变化/);
  h.closeSession();
});

// —— 125% 副屏现场：窗口回读 865 DIP，页面视口只有 864；长截图也以视口为局部基准 ——
const scalingGeometry = { scaleFactor: 1.25, displayBounds: { x: 1920, y: 274, width: 1536, height: 865 },
  physicalRect: { x: 3840, y: 548, width: 1920, height: 1080 }, canonicalRect: { x: 3840, y: 548, width: 1920, height: 1080 } };

test('125% 副屏：选区按 864 视口换算，遮罩 layout 也只报 864', async () => {
  const h = harness({ ...scalingGeometry, viewport: { width: 1536, height: 864 } });
  await h.invoke('shot:scroll-begin', { x: 100, y: 100, width: 1000, height: 600 });
  const current = h.getCurrent();
  // 旧写法拿窗口 865 当基准：sy=1080/865，高度会算成 749；按页面 864 才是 750。
  assert.deepEqual({ ...current.scroll.pixels }, { x: 125, y: 125, width: 1250, height: 750 });
  const mask = h.windows.find(win => win.file?.endsWith('scroll-mask.html'));
  const layout = JSON.parse(mask.loadOptions.query.layout);
  assert.deepEqual(layout, { frame: { width: 1920, height: 1080 }, pixels: { x: 125, y: 125, width: 1250, height: 750 } },
    '只交物理帧与已确认像素，主进程不再替提示页做 DIP 投影');
  assert.deepEqual({ x: mask.bounds.x, y: mask.bounds.y, width: mask.bounds.width, height: mask.bounds.height },
    { x: 1920, y: 274, width: 1536, height: 865 }, '遮罩窗口本身仍按真实监视器拟合盖满 DIP 边界');
  h.closeSession();
});

test('125% 副屏：浮条 ROI 从 pixels/比例反推 DIP，四边向外取整成保守包络', async () => {
  const h = harness({ ...scalingGeometry, viewport: { width: 1536, height: 864 } });
  await h.invoke('shot:scroll-begin', { x: 100.5, y: 100.5, width: 200.4, height: 300.4 });
  const current = h.getCurrent();
  assert.deepEqual({ ...current.scroll.pixels }, { x: 126, y: 126, width: 250, height: 375 });
  assert.deepEqual({ ...current.scroll.barRoi }, { x: 2020, y: 374, width: 201, height: 301 },
    'left/top floor、right/bottom ceil，原点仍加回本屏全局 DIP 原点');
  assert.ok(current.scroll.barRoi.y + current.scroll.barRoi.height <= 274 + 864, '不拿窗口 865 盲转');
  const bar = current.scroll.bar?.getBounds();
  if (bar) assert.ok(bar.x + bar.width <= current.scroll.barRoi.x || bar.x >= current.scroll.barRoi.x + current.scroll.barRoi.width ||
    bar.y + bar.height <= current.scroll.barRoi.y || bar.y >= current.scroll.barRoi.y + current.scroll.barRoi.height, '浮条不压进采集像素');
  h.closeSession();
});

test('175% 副屏：barRoi 用 pixels/scale 反推，不等于 CSS 矩形加屏原点', async () => {
  // 帧 1080 / 视口 618 = 1.74757…，与 DPI 1.75 不等于同一比例；本例能区分两种算法。
  const h = harness(fieldGeometry);
  const localRect = { x: 900, y: 20, width: 100, height: 200 };
  await h.invoke('shot:scroll-begin', localRect);
  const current = h.getCurrent();
  assert.deepEqual({ ...current.scroll.pixels }, { x: 1574, y: 35, width: 175, height: 349 });
  assert.deepEqual({ ...current.scroll.barRoi }, { x: 2819, y: 294, width: 101, height: 200 });
  // CSS 算法会得出 bounds.x + rect.x = 2820；按 DPI 反推是 2819（真实位置 1574/1.75 = 899.43）。
  assert.equal(current.scroll.barRoi.x, current.display.bounds.x + localRect.x - 1, '不是 rect + 屏原点');
  assert.equal(current.scroll.barRoi.y + current.scroll.barRoi.height, 494);
  // 原生 ROI 仍按 canonical + pixels 原样平移，不受提示区舍入影响。
  await h.invoke('shot:scroll-frame', current.scroll.token);
  assert.deepEqual(h.captures[0], { x: 3840 + 1574, y: 548 + 35, width: 175, height: 349 });
  assert.deepEqual(h.wheels[0].region, h.captures[0]);
  // 浮条护栏用同一份 barRoi：既不压采集像素，也不出工作区。
  const area = current.display.workArea, bar = current.scroll.bar?.getBounds();
  if (bar) {
    assert.ok(bar.x + bar.width <= current.scroll.barRoi.x || bar.x >= current.scroll.barRoi.x + current.scroll.barRoi.width ||
      bar.y + bar.height <= current.scroll.barRoi.y || bar.y >= current.scroll.barRoi.y + current.scroll.barRoi.height, '浮条不压采集像素');
    assert.ok(bar.x >= area.x && bar.y >= area.y && bar.x + bar.width <= area.x + area.width && bar.y + bar.height <= area.y + area.height, '浮条留工作区');
  }
  h.closeSession();
});

test('缺少选区视口基准时长截图直接拒绝，不回退 display.bounds', async () => {
  const h = harness();
  delete h.getCurrent().selectionBounds;
  await assert.rejects(h.invoke('shot:scroll-begin', rect), /视口基准/);
  assert.equal(h.getCurrent().scroll, undefined);
  assert.equal(h.captures.length, 0);
  assert.equal(h.windows.some(win => win.isBar), false);
  h.closeSession();
});

// —— 长截图成图 → 主进程成图窗口的交接（生产注入）——
test('注入交接：成功后不再发旧 complete、不 show 旧选区窗，交出去的 rect 是原选区', async () => {
  const h = harness({ onLongResult: async () => true });
  const rect = { x: 10, y: 20, width: 200, height: 200 };
  await h.invoke('shot:scroll-begin', rect);
  const current = h.getCurrent(), token = current.scroll.token;
  h.api.finish();
  const before = h.host.shows ?? 0;
  assert.equal(await h.invoke('shot:scroll-result', token, { png: new ArrayBuffer(4) }), true);
  assert.equal(h.longResults.length, 1, '交接只调一次');
  const packet = h.longResults[0];
  assert.equal(packet.token, token);
  assert.deepEqual({ ...packet.rect }, rect, '交原选区，交给主进程用同一基准重算像素');
  assert.equal(packet.image, current.longImage, '交的是已解码的同一张长图');
  assert.deepEqual({ ...packet.size }, { width: 200, height: 500 });
  assert.equal('preview' in packet, true);
  assert.equal(h.host.sent.some(row => row.name === 'shot:scroll-complete'), false, '成功路径不发旧 complete');
  assert.equal(h.host.shows ?? 0, before, '成功路径不再 show 旧预览');
  assert.equal(current.longPreviewPending, true, '还没被新宿主接管前仍算待出预览');
  h.api.cleanup(current);
});

test('注入交接失败或抛错：保留成图与警告，回退旧预览并显示旧选区窗', async () => {
  for (const mode of ['false', 'throw']) {
    const h = harness({ onLongResult: async () => { if (mode === 'throw') throw new Error('宿主不可用'); return false; } });
    await h.invoke('shot:scroll-begin', rect);
    const current = h.getCurrent(), token = current.scroll.token;
    h.api.finish();
    const image = current.longImage;
    assert.equal(await h.invoke('shot:scroll-result', token, { png: new ArrayBuffer(4) }), true, mode);
    assert.equal(h.longResults.length, 1);
    assert.equal(current.longImage !== undefined, true, '成图没有被销毁');
    const complete = h.host.sent.filter(row => row.name === 'shot:scroll-complete');
    assert.equal(complete.length, 1, `${mode}：回退要发旧 complete`);
    assert.equal(complete[0].value.ok, true);
    assert.equal(complete[0].value.token, token);
    assert.equal(current.longPreviewPending, true, '回退后仍等页面 preview-ready');
    assert.equal(h.host.isVisible(), true, '回退要显示旧预览');
    assert.match(h.statuses.at(-1).message, /成图窗口未能打开，已回到预览，图片保留/, '失败要说得出来，不能只说长图已生成');
    h.api.cleanup(current);
  }
});

test('未注入交接：保持原同步返回 bool', async () => {
  const h = harness();
  await h.invoke('shot:scroll-begin', rect);
  const token = h.getCurrent().scroll.token;
  const result = h.invoke('shot:scroll-result', token, { png: new ArrayBuffer(4) });
  assert.equal(result, true, '老调用方拿到同步 true，不是 Promise');
  assert.equal(h.host.sent.filter(row => row.name === 'shot:scroll-complete').length, 1);
  h.api.cleanup(h.getCurrent());
});

test('主题：只给不透明浮条绑色，透明遮罩与选区窗不绑', async () => {
  const bound = [];
  const theme = { bind: (win, options) => { bound.push({ win, options }); return () => {}; } };
  const h = harness({ theme });
  await h.invoke('shot:scroll-begin', { x: 10, y: 20, width: 200, height: 200 });
  const current = h.getCurrent();
  assert.equal(bound.length, 1, '一轮长截图只绑一扇窗');
  assert.equal(bound[0].win, current.scroll.bar, '绑的是不透明浮条');
  assert.equal(bound[0].options, undefined, '浮条没有自定义标题栏，不传叠加参数');
  const boundWindows = bound.map(entry => entry.win);
  assert.equal(boundWindows.includes(h.host), false, '选区窗不绑');
  assert.equal(boundWindows.includes(current.scroll.mask), false, '透明遮罩不绑');
  h.api.cleanup(current);
});
