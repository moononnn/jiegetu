'use strict';
// GIF 录制事务的定向测试：用 VM 夹具跑真实的 main/recording.cjs。
// 采集、编码、窗口、快捷键、另存框全是替身；断言只看接口契约与安全护栏，不采桌面。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { toPixels } = require('../core/coordinates.cjs');

// 让所有 await 链跑完：录制主循环里每一步都是 Promise 链，只等一个 setImmediate 不够。
const drain = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness(options = {}) {
  const {
    scaleFactor = 1,
    displayBounds = { x: 0, y: 0, width: 1000, height: 800 },
    workArea = { x: 0, y: 0, width: 1000, height: 760 },
    physical = { x: 0, y: 0, width: 1000, height: 800 },
    physicalWork = { x: 0, y: 0, width: 1000, height: 760 },
    mode = 'single',
    deferDelay = false,
    barLoadFails = false,
    frozenHideFails = false,
    encoderFinishFails = false,
    saveCanceled = false,
    saveFails = false,
    saveFile = 'C:\\Users\\test\\Pictures\\out.gif',
    deferDialog = false,
    deferWrite = false,
    deferBorderFit = false,
    deferBorderLoad = false,
    borderFitFails = false,
    borderLoadFails = false,
    windowFaults = {},
    escapeFails = false,
    cancelKeyFails = false,
    selection = { x: 100, y: 120, width: 300, height: 200 },
    frame,
    resolveSelection,
    extraCurrent = {}
  } = options;
  const frameSize = frame ? { ...frame } : { ...physical };
  const handlers = new Map(), windows = [], events = [], statuses = [], cancels = [], finishes = [];
  const registrations = [], unregistered = [], shortcuts = new Map(), writes = [], dialogs = [], fits = [], cancelsCalled = [];
  const lifecycles = [], directories = [], copies = [], remembered = [], folders = [];
  let dialogGate, writeGate;
  const borderFitGates = [];
  const borderLoadGates = [];
  const delayCalls = [];
  const timers = new Map();
  const captureState = { next: 0, stops: 0, queue: [], deferred: [] };
  const captures = [];
  const encoders = [];
  const frameGates = [];
  const encoderBytes = Uint8Array.from({ length: 64 }, (_value, index) => index);
  let timerSeq = 0, clock = 0, destroyed = false, failCaptureOnce = false;
  let displays = [{ id: 7, scaleFactor, bounds: { ...displayBounds }, workArea: { ...workArea } }];
  let physicalNow = { ...physical }, physicalWorkNow = { ...physicalWork };
  let delayResolvers = [];

  const schedule = (fn, ms = 0) => {
    const timer = { id: ++timerSeq, at: clock + Math.max(0, Number(ms) || 0), unref() {} };
    timers.set(timer.id, { ...timer, fn });
    return timer;
  };
  const unschedule = timer => { if (timer && typeof timer.id === 'number') timers.delete(timer.id); };
  async function advance(ms = 0) {
    clock += Math.max(0, ms);
    for (;;) {
      const due = [...timers.values()].filter(timer => timer.at <= clock).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.delete(due.id);
      due.fn();
      await drain();
    }
    await drain();
  }
  const delay = ms => {
    delayCalls.push(ms);
    if (!deferDelay) { clock += ms; return Promise.resolve(); }
    return new Promise(resolve => delayResolvers.push(resolve));
  };
  const releaseDelay = () => { const list = delayResolvers; delayResolvers = []; list.forEach(resolve => resolve()); };

  // 冻结的选区窗：录制前必须真的退场，所以这里带上可见性跟踪。
  const frozen = { hidden: 0, shown: 0, raised: 0, focused: 0, visible: true,
    webContents: { mainFrame: {}, send: () => {} },
    isDestroyed: () => destroyed,
    isVisible() { return this.visible === true; },
    hide() { this.hidden += 1; events.push('frozen-hide'); if (!frozenHideFails) this.visible = false; },
    show() { this.shown += 1; this.visible = true; events.push('frozen-show'); },
    moveTop() { this.raised += 1; },
    focus() { this.focused += 1; },
    destroy() { destroyed = true; } };

  class Window extends EventEmitter {
    constructor(windowOptions = {}) {
      super();
      this.options = windowOptions;
      this.isBar = String(windowOptions.webPreferences?.preload || '').endsWith('gif-preload.cjs');
      this.isBorder = windowOptions.backgroundColor === '#63ad8b';
      this.bounds = { x: windowOptions.x ?? 0, y: windowOptions.y ?? 0,
        width: windowOptions.width ?? 0, height: windowOptions.height ?? 0 };
      this.sent = [];
      this.visible = false;
      this.protected = false;
      this.destroyed = false;
      this.ignoreMouse = undefined;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (channel, value) => { this.sent.push({ channel, value }); };
      this.webContents.executeJavaScript = async () => true;
      const kind = this.isBar ? 'bar' : this.isBorder ? 'border' : 'other';
      this.faults = new Set(Array.isArray(windowFaults[kind]) ? windowFaults[kind] : []);
      if (this.isBar) events.push('bar-created');
      if (this.isBorder) events.push('border-created');
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
    setBounds(bounds) { this.throwIfFaulty('setBounds'); this.bounds = { ...this.bounds, ...bounds }; }
    getBounds() { this.throwIfFaulty('getBounds'); return { ...this.bounds }; }
    setIgnoreMouseEvents(value) { this.throwIfFaulty('setIgnoreMouseEvents'); this.ignoreMouse = value; }
    setAlwaysOnTop(value, level) { this.throwIfFaulty('setAlwaysOnTop'); this.alwaysOnTop = { value, level }; }
    throwIfFaulty(name) { if (this.faults.has(name)) throw new Error(`模拟 ${name} 异常`); }
    show() { this.visible = true; this.emit('show'); }
    showInactive() { this.visible = true; this.emit('show'); }
    hide() { if (!this.visible) return; this.visible = false; this.emit('hide'); }
    moveTop() { this.raised = (this.raised ?? 0) + 1; }
    focus() { this.focused = true; }
    isVisible() { return this.visible; }
    setTitle(value) { this.title = value; }
    setContentProtection(value) { this.throwIfFaulty('setContentProtection'); this.protected = value === true; }
    isContentProtected() { return this.protected === true; }
    loadFile(file, loadOptions) {
      this.file = file;
      this.query = loadOptions?.query;
      if (this.isBar && barLoadFails) return Promise.reject(new Error('模拟录制页加载失败'));
      if (this.isBorder) {
        if (borderLoadFails) return Promise.reject(new Error('模拟录制边框加载失败'));
        if (deferBorderLoad) return new Promise((resolve, reject) => borderLoadGates.push({ resolve, reject }));
      }
      return Promise.resolve();
    }
  }

  const screen = {
    getAllDisplays: () => displays.map(entry => ({ id: entry.id, scaleFactor: entry.scaleFactor,
      bounds: { ...entry.bounds }, workArea: { ...entry.workArea } })),
    dipToScreenRect: (_owner, rect) => {
      const same = (a, b) => ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]);
      if (same(rect, displayBounds)) return { ...physicalNow };
      if (same(rect, workArea)) return { ...physicalWorkNow };
      return { ...physicalNow };
    }
  };
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  const globalShortcut = {
    register: (accelerator, fn) => {
      registrations.push(accelerator);
      if ((escapeFails && accelerator === 'Escape') || (cancelKeyFails && accelerator === 'CommandOrControl+Alt+Escape')) return false;
      shortcuts.set(accelerator, fn);
      return true;
    },
    unregister: accelerator => { unregistered.push(accelerator); shortcuts.delete(accelerator); }
  };
  const electron = { BrowserWindow: Window, ipcMain, screen, globalShortcut,
    dialog: { showSaveDialog: async () => ({ canceled: true }) }, app: { getPath: () => 'C:\\Users\\test\\Pictures' } };

  const current = {
    phase: 'selecting', mode,
    display: { id: 7, scaleFactor, bounds: { ...displayBounds }, workArea: { ...workArea } },
    selectionBounds: { x: 0, y: 0, width: displayBounds.width, height: displayBounds.height },
    image: { getSize: () => ({ ...frameSize }) },
    nativeBounds: { ...physical }, nativeHint: { ...physical },
    nativeWorkArea: { ...physicalWork }, nativeWorkHint: { ...physicalWork },
    win: frozen, ...extraCurrent
  };
  let session = current;

  const createCapture = region => {
    if (failCaptureOnce) { failCaptureOnce = false; throw new Error('模拟原生源不可用'); }
    captures.push({ ...region });
    events.push('create-capture');
    return {
      stopped: false,
      next() {
        captureState.next += 1;
        const item = captureState.queue.shift();
        if (!item) return Promise.resolve({ fresh: true, width: region.width, height: region.height,
          data: new Uint8ClampedArray(region.width * region.height * 4) });
        if (item.defer) return new Promise((resolve, reject) => captureState.deferred.push({ resolve, reject, item }));
        if (item.error) return Promise.reject(item.error);
        return Promise.resolve({ fresh: item.fresh !== false, width: region.width, height: region.height,
          ...(item.fresh === false ? {} : { data: item.data || new Uint8ClampedArray(region.width * region.height * 4) }) });
      },
      stop() {
        if (this.stopped) return;
        this.stopped = true;
        captureState.stops += 1;
        events.push('capture-stop');
        const pending = captureState.deferred.splice(0);
        pending.forEach(entry => entry.reject(new Error('原生采集已取消')));
      }
    };
  };

  const createEncoder = encoderOptions => {
    const encoder = {
      width: encoderOptions.width, height: encoderOptions.height, maxBytes: encoderOptions.maxBytes,
      frames: [], finishCalls: [], cancels: 0, active: 0, peak: 0,
      async frame(data, elapsedMs) {
        this.active += 1;
        this.peak = Math.max(this.peak, this.active);
        this.frames.push({ data, elapsedMs });
        events.push(`encode-start-${elapsedMs}`);
        const gate = frameGates.shift();
        if (gate) await gate.promise;
        this.active -= 1;
        events.push(`encode-end-${elapsedMs}`);
      },
      async finish(elapsedMs) {
        this.finishCalls.push(elapsedMs);
        events.push('encoder-finish');
        // 永远不允许和一条还没回包的 frame 并行：insift 时才置位，用来直接断言。
        if (this.active > 0) this.finishWhileBusy = true;
        if (encoderFinishFails) throw new Error('模拟编码收尾失败');
        return encoderBytes;
      },
      cancel() { this.cancels += 1; }
    };
    options.configureEncoder?.(encoder, encoderOptions, encoders.length);
    encoders.push(encoder);
    return encoder;
  };

  const fitWindow = (win, nonce, bounds, fitMode) => {
    // 真实原生契约：只拟合隐藏窗；可见窗一律拒绝，夹具必须与之一致。
    if (win.isVisible()) return Promise.reject(new Error('窗口物理布局失败（可见窗不接受拟合）'));
    const target = win.isBar ? 'bar' : win.isBorder ? 'border' : 'other';
    if (target === 'border' && borderFitFails) return Promise.reject(new Error('模拟录制边框拟合失败'));
    fits.push({ nonce, mode: fitMode, bounds: { ...bounds }, target, visible: false,
      hidden: win.isVisible() !== true });
    if (target === 'border' && deferBorderFit) return new Promise((resolve, reject) => borderFitGates.push({ resolve, reject, win, bounds }));
    // 真实原生把物理矩形塞进窗口；夹具按 DIP 回写，好让 getBounds 基线跟真机一样可读。
    win.setBounds(dipFor(bounds));
    return Promise.resolve({ ...bounds });
  };
  const dipFor = rect => ({ x: Math.round(displayBounds.x + (rect.x - physicalNow.x) / scaleFactor),
    y: Math.round(displayBounds.y + (rect.y - physicalNow.y) / scaleFactor),
    width: Math.max(1, Math.round(rect.width / scaleFactor)), height: Math.max(1, Math.round(rect.height / scaleFactor)) });
  const releaseBorderFit = () => { const gates = borderFitGates.splice(0); gates.forEach(gate => { gate.win.setBounds(dipFor(gate.bounds)); gate.resolve({ ...gate.bounds }); }); };
  const releaseBorderLoad = () => { const gates = borderLoadGates.splice(0); gates.forEach(gate => gate.resolve()); };
  const showSaveDialog = async (owner, dialogOptions) => {
    dialogs.push({ owner, options: dialogOptions });
    if (deferDialog) return new Promise((resolve, reject) => { dialogGate = { resolve, reject }; });
    return saveCanceled ? { canceled: true } : { canceled: false, filePath: saveFile };
  };
  const writeFile = (file, bytes, writeOptions) => {
    if (deferWrite) return new Promise((resolve, reject) => { writeGate = { resolve, reject, file, bytes }; });
    if (saveFails) return Promise.reject(new Error('磁盘不可用'));
    writes.push({ file, bytes, options: writeOptions });
    return Promise.resolve();
  };

  const context = { module: { exports: {} }, exports: {}, Buffer, ArrayBuffer,
    process: { platform: 'win32', pid: 4321 }, __dirname: path.resolve(__dirname, '../main'),
    setTimeout: schedule, clearTimeout: unschedule,
    require: name => {
      if (name === 'electron') return electron;
      if (name === '../core/coordinates.cjs') return { toPixels };
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../main/recording.cjs'), 'utf8'), context);
  const api = context.module.exports.installRecording({
    getActive: () => session,
    onWindowLost: options.onWindowLost,
    onSuspendedEscape: options.onSuspendedEscape,
    allowed: event => Boolean(session) && event.sender === frozen.webContents && event.senderFrame === frozen.webContents.mainFrame,
    onStatus: status => statuses.push(status),
    onLifecycle: (eventName, fields) => lifecycles.push({ event: eventName, fields: { ...fields } }),
    cancel: reason => { cancels.push(reason); cancelsCalled.push(reason); if (session) api.cleanup(session); session = undefined; },
    finishSession: (target, reason) => {
      if (session !== target) return false;
      finishes.push(reason);
      api.cleanup(session);
      session = undefined;
      return true;
    },
    resolveSelection,
    createCapture, createEncoder, fitWindow, showSaveDialog, writeFile,
    resolveSaveFolder: () => { folders.push('quick'); return 'C:\\Users\\test\\Pictures'; },
    resolveAsFolder: () => { folders.push('as'); return 'C:\\Users\\test\\Other'; },
    mkdir: async (folder, mkdirOptions) => {
      directories.push({ folder, options: mkdirOptions });
      if (options.mkdirFails) throw new Error('目录不可用');
      if (options.mkdirGate) await options.mkdirGate;
    },
    onSaved: async (file, detail) => { remembered.push({ file, action: detail.action }); if (options.rememberFails) throw new Error('记忆失败'); },
    copyGif: async (bytes, guard) => {
      copies.push({ bytes, guard });
      if (options.copyGate) await options.copyGate;
      if (options.guardCopy && !guard.isCurrent()) throw new Error('复制会话已失效');
      if (options.copyFails) throw new Error('剪贴板忙');
    },
    delay, now: () => clock,
    ipcMain, BrowserWindow: Window, screen, globalShortcut
  });

  const event = () => ({ sender: frozen.webContents, senderFrame: frozen.webContents.mainFrame });
  const invoke = (name, ...args) => handlers.get(name)(event(), ...args);
  const bar = () => windows.find(win => win.isBar);
  const borderWindows = () => windows.filter(win => win.isBorder && !win.isDestroyed());
  const allBorderWindows = () => windows.filter(win => win.isBorder);
  // 真机 render-process-gone：webContents 死了，宿主 BrowserWindow 仍然存在。
  const crashWindow = win => {
    win.webContents.destroyed = true;
    win.webContents.isDestroyed = () => true;
    win.webContents.emit('render-process-gone', {}, {}, 'crashed');
  };
  const fullScreenWindows = () => windows.filter(win => !win.isDestroyed() &&
    win.bounds.width * win.bounds.height >= displayBounds.width * displayBounds.height);
  const barInvoke = (name, ...args) => {
    const target = bar();
    return handlers.get(name)({ sender: target.webContents, senderFrame: target.webContents.mainFrame }, ...args);
  };
  const gifStatuses = () => (bar()?.sent || []).filter(entry => entry.channel === 'gif:status').map(entry => entry.value);
  const previews = () => (bar()?.sent || []).filter(entry => entry.channel === 'gif:preview').map(entry => entry.value);
  const holdEncoding = () => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    frameGates.push({ promise });
    return () => release();
  };
  const startRecording = async (rect = selection) => {
    const task = invoke('shot:record-begin', rect);
    // 先挂一个空 catch，避免拒绝发生在 drain 期间被当成 unhandledRejection；返回的仍是原始 promise。
    task.catch(() => {});
    await drain();
    return task;
  };
  const changeDisplay = patch => { displays = [{ ...displays[0], ...patch }]; };
  const dropDisplay = () => { displays = []; };
  const patchPhysical = rect => { physicalNow = { ...rect }; };
  const patchPhysicalWork = rect => { physicalWorkNow = { ...rect }; };
  const setSession = value => { session = value; };

  return { api, window: { frozen }, windows, handlers, invoke, barInvoke, bar, events, statuses, cancels,
    finishes, registrations, unregistered, shortcuts, writes, dialogs, fits, delayCalls, captures, captureState,
    encoders, encoderBytes, gifStatuses, previews, advance, drain, releaseDelay, holdEncoding, startRecording,
    changeDisplay, dropDisplay, patchPhysical, patchPhysicalWork, setSession, getSession: () => session,
    failNextCapture: () => { failCaptureOnce = true; },
    lifecycles, directories, copies, remembered, folders,
    lifecycleFor: name => lifecycles.filter(entry => entry.event === name).map(entry => entry.fields),
    fullScreenWindows,
    closeBar: () => bar()?.destroy(),
    resolveDialog: choice => dialogGate?.resolve(choice),
    rejectDialog: error => dialogGate?.reject(error),
    resolveWrite: () => { const gate = writeGate; writeGate = undefined; writes.push({ file: gate.file, bytes: gate.bytes }); gate.resolve(); },
    rejectWrite: error => { const gate = writeGate; writeGate = undefined; gate.reject(error); },
    pendingWrite: () => Boolean(writeGate),
    windowsAlive: () => windows.filter(win => !win.isDestroyed()),
    borderWindows, allBorderWindows, releaseBorderFit, releaseBorderLoad,
    crashBorder: index => crashWindow(borderWindows()[index]),
    crashBar: () => crashWindow(bar()),
    borderRectsOf: () => [...(session?.recording?.borders || [])].map(entry => ({ ...entry.rect })),
    borderEntries: () => [...(session?.recording?.borders || [])],
    frameGates: () => frameGates.length, timers: () => timers.size };
}

const settle = async () => { await drain(); };

// 编辑测试沿用同一录制/窗口/IPC 夹具；不复制宿主，不读取桌面。
async function editHarness(options = {}) {
  const h = harness(options);
  await h.startRecording();
  await h.advance(100);
  await h.barInvoke('gif:action', 'stop');
  h.original = h.getSession().recording.preview;
  h.edit = (action, payload) => h.barInvoke('gif:edit', action, payload);
  h.beginPayload = { sourceId: h.original.sourceId, width: 2, height: 3, frames: 2, durationMs: 100 };
  h.beginEdit = patch => h.edit('begin', { ...h.beginPayload, ...patch });
  h.editFrame = (token, elapsedMs = 0) => h.edit('frame', { token, elapsedMs, rgba: new Uint8ClampedArray(24) });
  return h;
}

test('GIF 挂起父：真实录制模块先通知控制条失效，不越权取消子会话', async () => {
  for (const reason of ['window-close', 'renderer-gone']) {
    const seen = [];
    const h = await editHarness({ onWindowLost: (...args) => seen.push(args) });
    const parent = h.getSession(), rec = parent.recording, bar = h.bar();
    const child = { phase: 'selecting' };
    h.setSession(child);
    if (reason === 'window-close') bar.destroy();
    else bar.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.equal(seen.length, 1, 'active 已换成子层，失效钩子仍必须收到');
    assert.equal(seen[0][0], parent);
    assert.equal(seen[0][1], rec);
    assert.equal(seen[0][2], reason);
    if (reason === 'window-close') assert.equal(rec.bar, undefined);
    assert.equal(h.getSession(), child);
    assert.equal(h.cancels.length, 0, '父层失效不能取消子层');
    h.api.cleanup(parent);
  }
});

test('GIF 挂起父：Esc 先交截图栈处理，不走录制活性早退或取消子层', async () => {
  const seen = [];
  const h = await editHarness({ onSuspendedEscape: (current, event) => {
    seen.push(current); event.preventDefault(); return true;
  } });
  const parent = h.getSession(), bar = h.bar(), child = { phase: 'capturing' };
  h.setSession(child);
  let prevented = 0;
  const event = { preventDefault() { prevented += 1; } };
  bar.webContents.emit('before-input-event', event, { type: 'keyDown', key: 'ArrowLeft' });
  assert.equal(seen.length, 0);
  bar.webContents.emit('before-input-event', event, { type: 'keyDown', key: 'Escape' });
  assert.equal(prevented, 1);
  assert.deepEqual(seen, [parent]);
  assert.equal(h.getSession(), child);
  assert.equal(h.cancels.length, 0);
  h.api.cleanup(parent);
});

test('GIF 挂起父：ready/action/edit 均不能借父控制条访问子会话', async () => {
  const h = await editHarness(), parent = h.getSession(), child = { phase: 'selecting' };
  h.setSession(child);
  assert.throws(() => h.barInvoke('gif:ready'), /无效录制窗口/);
  await assert.rejects(h.barInvoke('gif:action', 'save-quick'), /无效录制窗口/);
  await assert.rejects(h.beginEdit(), /无效录制窗口/);
  assert.equal(h.getSession(), child);
  assert.equal(h.writes.length, 0);
  assert.equal(h.copies.length, 0);
  assert.equal(h.cancels.length, 0);
  h.api.cleanup(parent);
});

test('GIF 三出口：快捷保存不弹框、递归目录、独占写，保存最新编辑字节', async () => {
  for (const action of ['save-quick', 'save', 'copy']) {
    const h = await editHarness();
    const job = await h.beginEdit();
    await h.editFrame(job.token, 0); await h.editFrame(job.token, 50);
    await h.edit('finish', { token: job.token });
    const preview = h.getSession().recording.preview;
    const result = await h.barInvoke('gif:action', action, { bytes: new Uint8Array([0]), file: 'evil' });
    assert.equal(result.ok, true);
    assert.equal(h.getSession(), undefined);
    assert.deepEqual(h.finishes, ['completed']);
    if (action === 'copy') {
      assert.equal(h.copies[0].bytes, preview.bytes);
      assert.equal(h.writes.length, 0); assert.equal(h.dialogs.length, 0); assert.equal(h.directories.length, 0);
      assert.equal(h.statuses.at(-1).copied, true);
    } else {
      assert.equal(h.writes[0].bytes, preview.bytes);
      assert.equal(h.remembered[0].action, action);
      assert.equal(h.dialogs.length, action === 'save' ? 1 : 0);
      assert.deepEqual(h.folders, [action === 'save' ? 'as' : 'quick']);
      if (action === 'save-quick') {
        assert.equal(h.directories[0].options.recursive, true);
        assert.equal(h.writes[0].options.flag, 'wx');
        assert.match(result.file, /_2x3_[0-9a-f-]+\.gif$/);
      } else assert.ok(h.dialogs[0].options.properties.includes('showOverwriteConfirmation'));
    }
  }
});

test('GIF 快存目录/写入与复制失败均保预览；目录记忆失败不挡落盘', async () => {
  for (const [options, action, error] of [
    [{ mkdirFails: true }, 'save-quick', /目录不可用/],
    [{ saveFails: true }, 'save-quick', /磁盘不可用/],
    [{ copyFails: true }, 'copy', /剪贴板忙/]
  ]) {
    const h = await editHarness(options), preview = h.original;
    await assert.rejects(h.barInvoke('gif:action', action), error);
    assert.equal(h.getSession().phase, 'record-preview');
    assert.equal(h.getSession().recording.preview, preview);
    assert.match(h.gifStatuses().at(-1).message, /失败/);
    assert.equal(h.finishes.length, 0);
  }
  const h = await editHarness({ rememberFails: true });
  assert.equal((await h.barInvoke('gif:action', 'save')).ok, true);
});

test('GIF 复制互斥、未授权与过期请求均拒绝，guard 在关窗后失效', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await editHarness({ copyGate: gate, guardCopy: true });
  const task = h.barInvoke('gif:action', 'copy');
  assert.equal(h.getSession().phase, 'saving');
  assert.match(h.gifStatuses().at(-1).message, /正在复制 GIF/);
  for (const action of ['copy', 'save', 'save-quick', 'retry', 'edit', 'cancel']) {
    await assert.rejects(h.barInvoke('gif:action', action), /正在复制/);
  }
  await assert.rejects(h.handlers.get('gif:action')({ sender: {}, senderFrame: {} }, 'copy'), /无效录制窗口/);
  h.closeBar(); assert.equal(h.copies[0].guard.isCurrent(), false);
  release(); assert.equal((await task).ok, false);
  assert.equal(h.getSession(), undefined);
  assert.equal(h.finishes.length, 0);
  await assert.rejects(h.barInvoke('gif:action', 'copy'), /无效录制窗口/);
});

test('GIF 输出迟到回包不改新会话；剪贴板已成功即使关窗也照实完成', async () => {
  for (const replace of [false, true]) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = await editHarness({ copyGate: gate });
    const task = h.barInvoke('gif:action', 'copy');
    const old = h.getSession();
    h.closeBar();
    const next = { phase: 'selecting' };
    if (replace) { h.api.cleanup(old); h.setSession(next); }
    release();
    assert.equal((await task).copied, true);
    assert.equal(h.statuses.at(-1).copied, true);
    if (replace) { assert.equal(h.getSession(), next); assert.equal(next.phase, 'selecting'); }
    else { assert.equal(h.getSession(), undefined); assert.deepEqual(h.finishes, ['completed']); }
  }
});

test('GIF 快存 mkdir 迟到后关窗不得写盘，取消另存保编辑成品', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await editHarness({ mkdirGate: gate });
  const task = h.barInvoke('gif:action', 'save-quick'); await drain();
  h.closeBar(); release(); await task;
  assert.equal(h.writes.length, 0); assert.equal(h.getSession(), undefined);
  const canceled = await editHarness({ saveCanceled: true });
  const job = await canceled.beginEdit();
  await canceled.editFrame(job.token, 0); await canceled.editFrame(job.token, 50);
  await canceled.edit('finish', { token: job.token });
  const edited = canceled.getSession().recording.preview;
  assert.equal((await canceled.barInvoke('gif:action', 'save')).canceled, true);
  assert.equal(canceled.getSession().recording.preview, edited);
  assert.equal(canceled.remembered.length, 0);
});

const unchangedEdit = h => {
  assert.equal(h.getSession().recording.preview, h.original, '原预览对象/字节不变');
  assert.equal(h.getSession().phase, 'record-preview');
  assert.equal(h.getSession().recording.editJob, undefined);
};

test('GIF 编辑：原生 Esc 只在录制阶段拦截，预览和编辑必须交给页面', async () => {
  const h = harness();
  await h.startRecording();
  await h.advance(100);
  let prevented = 0;
  const event = { preventDefault() { prevented += 1; } };
  const key = { type: 'keyDown', key: 'Escape' };
  // Real createBarWindow installed this listener; a DOM KeyboardEvent cannot exercise it.
  h.bar().webContents.emit('before-input-event', event, key);
  assert.equal(prevented, 1, '录制时 Esc 被主进程消费');
  await drain();
  assert.equal(h.getSession().phase, 'record-preview');
  h.bar().webContents.emit('before-input-event', event, key);
  assert.equal(prevented, 1, '预览 Esc 要抵达 renderer');
  const sourceId = h.getSession().recording.preview.sourceId;
  const { token } = await h.barInvoke('gif:edit', 'begin', { sourceId, width: 2, height: 3, frames: 1, durationMs: 100 });
  h.bar().webContents.emit('before-input-event', event, key);
  assert.equal(prevented, 1, '生成阶段也要放行 Esc，供页面决定取消');
  assert.equal(h.getSession().phase, 'record-editing');
  await h.barInvoke('gif:edit', 'abort', { token });
  await h.barInvoke('gif:action', 'edit');
  h.bar().webContents.emit('before-input-event', event, key);
  h.bar().webContents.emit('before-input-event', event, { type: 'keyUp', key: 'Escape' });
  assert.equal(prevented, 1, '编辑窗口和 keyUp 都不能提前吞键');
  assert.equal(h.cancels.length, 0);
  h.api.dispose();
});

test('GIF 编辑：IPC 只认主框架、固定操作、当前 sourceId/token', async () => {
  const h = await editHarness();
  assert.match(h.original.sourceId, /^[0-9a-f-]{36}$/);
  assert.equal(h.previews().at(-1).sourceId, h.original.sourceId);
  const handler = h.handlers.get('gif:edit');
  for (const event of [{}, { sender: h.bar().webContents, senderFrame: {} },
    { sender: {}, senderFrame: h.bar().webContents.mainFrame }]) {
    await assert.rejects(handler(event, 'begin', h.beginPayload), /无效录制窗口/);
  }
  await assert.rejects(h.edit('anything', {}), /无效/);
  await assert.rejects(h.beginEdit({ sourceId: 'stale' }), /失效/);
  const { token } = await h.beginEdit();
  await assert.rejects(h.beginEdit(), /失效/);
  for (const action of ['frame', 'finish', 'abort']) await assert.rejects(h.edit(action, { token: 'stale' }), /失效/);
  await assert.rejects(h.barInvoke('gif:action', 'save'), /不能保存/);
  await assert.rejects(h.barInvoke('gif:action', 'retry'), /不能重新/);
  await assert.rejects(h.barInvoke('gif:action', 'edit-close'), /不能切换/);
  await h.edit('abort', { token });
  unchangedEdit(h);
  await h.edit('abort');
});

test('GIF 编辑：begin 严格限制尺寸、时长、帧数且不建编码器', async () => {
  const h = await editHarness();
  const invalid = [{ width: 0 }, { width: 301 }, { width: 4097 }, { width: 1.1 },
    { height: 201 }, { height: NaN }, { frames: 0 }, { frames: 513 }, { frames: 11 },
    { frames: 1.1 }, { durationMs: 0 }, { durationMs: 99 }, { durationMs: 120 },
    { durationMs: 31010 }, { durationMs: Number.MAX_SAFE_INTEGER }];
  for (const patch of invalid) {
    await assert.rejects(h.beginEdit(patch), /无效/);
    unchangedEdit(h);
  }
  assert.equal(h.encoders.length, 1);
  // 大源也受 4M 像素独立约束，不能只依赖原宽高。
  h.original.width = 4096; h.original.height = 4096;
  await assert.rejects(h.beginEdit({ width: 3000, height: 2000 }), /无效/);
  h.original.elapsedMs = 30000;
  await assert.rejects(h.beginEdit({ durationMs: 30020 }), /无效/);
});

test('GIF 编辑：首帧零、10ms递增、尺寸类型和 declared frames 校验', async () => {
  const h = await editHarness();
  const { token } = await h.beginEdit();
  await assert.rejects(h.edit('finish', { token }), /帧数/);
  for (const patch of [{ elapsedMs: 10 }, { elapsedMs: -10 }, { elapsedMs: 0.5 },
    { rgba: new Uint16Array(12) }, { rgba: new Uint8Array(23) }, { rgba: new Array(24) }]) {
    await assert.rejects(h.edit('frame', { token, elapsedMs: 0, rgba: new Uint8Array(24), ...patch }), /帧或时间/);
  }
  await h.editFrame(token);
  for (const elapsedMs of [0, -10, 1, 100, 110]) await assert.rejects(h.editFrame(token, elapsedMs), /帧或时间/);
  await h.editFrame(token, 20);
  await assert.rejects(h.editFrame(token, 30), /帧或时间/);
  assert.deepEqual(h.encoders.at(-1).frames.map(frame => frame.elapsedMs), [0, 20]);
  await h.edit('abort', { token });
  unchangedEdit(h);
});

test('GIF 编辑：frame 单飞，成功才计数，finish 不与 frame 并行', async () => {
  const h = await editHarness();
  const { token } = await h.beginEdit();
  const release = h.holdEncoding();
  const frame = h.editFrame(token);
  assert.equal(h.getSession().recording.editJob.count, 0);
  await assert.rejects(h.editFrame(token, 10), /正在编码/);
  await assert.rejects(h.edit('finish', { token }), /正在编码/);
  release(); await frame;
  await h.editFrame(token, 10);
  await h.edit('finish', { token });
  const rec = h.getSession().recording;
  assert.equal(rec.preview.width, 2); assert.equal(rec.preview.height, 3);
  assert.equal(rec.preview.elapsedMs, 100); assert.equal(rec.elapsedMs, 100);
  assert.notEqual(rec.preview.sourceId, h.original.sourceId);
  assert.equal(rec.editJob, undefined);
  assert.equal(h.encoders.at(-1).frames.every(frame => frame.data.byteLength === 24), true);
  assert.deepEqual(h.encoders.at(-1).finishCalls, [100]);
  assert.equal(h.encoders.at(-1).peak, 1);
  assert.equal(h.encoders.at(-1).cancels, 1);
  assert.equal(h.previews().at(-1).sourceId, rec.preview.sourceId);
  assert.equal(h.gifStatuses().at(-1).width, 2);
  assert.equal(h.gifStatuses().at(-1).height, 3);
  await assert.rejects(h.beginEdit(), /失效/);
  await assert.rejects(h.editFrame(token), /失效/);
});

test('GIF 编辑：begin 回包前可按 sourceId 取消，不复活旧 job', async () => {
  const h = await editHarness();
  const previews = h.previews().length;
  const begin = h.beginEdit();
  await h.edit('abort', { sourceId: h.original.sourceId });
  await assert.rejects(begin, /已结束/);
  unchangedEdit(h);
  assert.equal(h.encoders.at(-1).cancels, 1);
  assert.equal(h.previews().length, previews, 'abort 不发原预览覆盖草稿');
});

test('GIF 编辑：begin/frame/finish await 中取消、换 active、关窗、崩溃均不复活', async () => {
  for (const stage of ['begin', 'frame', 'finish']) {
    for (const end of ['cancel', 'active', 'close', 'crash']) {
      const h = await editHarness();
      let task, release = () => {};
      if (stage === 'begin') task = h.beginEdit();
      else {
        const { token } = await h.beginEdit();
        if (stage === 'frame') { release = h.holdEncoding(); task = h.editFrame(token); }
        else {
          await h.editFrame(token); await h.editFrame(token, 10);
          let resolve;
          const gate = new Promise(done => { resolve = done; });
          h.encoders.at(-1).finish = () => gate;
          release = () => resolve(new Uint8Array([1, 2, 3]));
          task = h.edit('finish', { token });
        }
      }
      task.catch(() => {});
      const current = h.getSession(), rec = current.recording, encoder = h.encoders.at(-1);
      const previews = h.previews().length;
      if (end === 'active') h.setSession({ phase: 'selecting' });
      else if (end === 'cancel') await h.barInvoke('gif:action', 'cancel');
      else if (end === 'close') h.closeBar();
      else h.crashBar();
      release();
      await assert.rejects(task, /已结束/);
      assert.equal(rec.editJob, undefined, `${stage}/${end} 无残留`);
      assert.equal(encoder.cancels, 1, `${stage}/${end} worker 被销毁`);
      assert.equal(h.previews().length, previews);
      if (end === 'active') assert.equal(rec.preview, h.original);
      assert.equal(h.writes.length, 0);
    }
  }
});

test('GIF 编辑：编码/初始化/finish 失败与超限保留原 GIF', async () => {
  const init = await editHarness({ configureEncoder: (_encoder, _opts, index) => {
    if (index > 0) throw new Error('init failed');
  } });
  await assert.rejects(init.beginEdit(), /init failed/);
  unchangedEdit(init);
  for (const stage of ['frame', 'finish', 'oversize', 'empty']) {
    const h = await editHarness();
    const { token } = await h.beginEdit();
    const encoder = h.encoders.at(-1);
    const previews = h.previews().length;
    if (stage === 'frame') {
      encoder.frame = async () => { throw new Error('frame failed'); };
      await assert.rejects(h.editFrame(token), /frame failed/);
    } else {
      await h.editFrame(token); await h.editFrame(token, 10);
      encoder.finish = async () => {
        if (stage === 'finish') throw new Error('finish failed');
        return new Uint8Array(stage === 'empty' ? 0 : 48 * 1024 * 1024 + 1);
      };
      await assert.rejects(h.edit('finish', { token }), /failed|数据无效/);
    }
    unchangedEdit(h);
    assert.equal(encoder.cancels, 1);
    assert.equal(h.previews().length, previews);
    assert.equal(h.writes.length, 0);
  }
});

test('GIF 编辑：空闲 120 秒回预览，成功帧刷新期限，超时可见且无草稿覆盖', async () => {
  const h = await editHarness();
  const { token } = await h.beginEdit();
  await h.advance(119000);
  await h.editFrame(token);
  await h.advance(119000);
  assert.equal(h.getSession().phase, 'record-editing');
  const previews = h.previews().length;
  await h.advance(1000);
  unchangedEdit(h);
  assert.match(h.gifStatuses().at(-1).message, /超时/);
  assert.equal(h.encoders.at(-1).cancels, 1);
  assert.equal(h.previews().length, previews);
  await assert.rejects(h.editFrame(token, 10), /失效/);
});

test('GIF 编辑：编辑窗尺寸居中夹进工作区，不 show 冻结窗、不补发旧预览', async () => {
  const h = await editHarness();
  const before = h.previews().length;
  await h.barInvoke('gif:action', 'edit');
  assert.deepEqual(h.bar().getBounds(), { x: 0, y: 0, width: 1000, height: 760 });
  await h.barInvoke('gif:action', 'edit-close');
  assert.deepEqual(h.bar().getBounds(), { x: 50, y: 55, width: 900, height: 650 });
  assert.equal(h.window.frozen.shown, 0);
  assert.equal(h.previews().length, before);
});

test('GIF 编辑：保存对话框取消保留编辑成品，随后保存只写成品字节', async () => {
  const h = await editHarness({ deferDialog: true });
  const { token } = await h.beginEdit();
  await h.editFrame(token); await h.editFrame(token, 10);
  const bytes = new Uint8Array([71, 73, 70, 9]);
  h.encoders.at(-1).finish = async () => bytes;
  await h.edit('finish', { token });
  const edited = h.getSession().recording.preview;
  const save = h.barInvoke('gif:action', 'save');
  await drain(); h.resolveDialog({ canceled: true }); await save;
  assert.equal(h.getSession().recording.preview, edited);
  assert.equal(h.writes.length, 0);
  const again = h.barInvoke('gif:action', 'save');
  await drain(); h.resolveDialog({ canceled: false, filePath: 'C:\\out.gif' }); await again;
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].bytes, bytes);
  assert.equal(h.getSession(), undefined);
});

test('GIF 编辑：真实 worker 导出统一尺寸与首尾时长，无中间文件', async () => {
  let real;
  const h = await editHarness({ configureEncoder: (encoder, opts, index) => {
    if (index !== 1) return;
    real = require('../main/gif-encoder.cjs').createGifEncoder(opts);
    encoder.frame = real.frame; encoder.finish = real.finish; encoder.cancel = real.cancel;
  } });
  try {
    const { token } = await h.beginEdit();
    await h.editFrame(token, 0); await h.editFrame(token, 30);
    await h.edit('finish', { token });
    const bytes = Buffer.from(h.getSession().recording.preview.bytes);
    assert.equal(bytes.toString('ascii', 0, 6), 'GIF89a');
    assert.equal(bytes.readUInt16LE(6), 2); assert.equal(bytes.readUInt16LE(8), 3);
    let cursor = 13, delayCs, trailer = false;
    if (bytes[10] & 128) cursor += 3 * (1 << ((bytes[10] & 7) + 1));
    const frames = [];
    const skipBlocks = () => { while (bytes[cursor]) cursor += bytes[cursor] + 1; cursor += 1; };
    while (cursor < bytes.length) {
      const marker = bytes[cursor++];
      if (marker === 0x3b) { trailer = true; break; }
      if (marker === 0x21) {
        const label = bytes[cursor++];
        if (label === 0xf9) delayCs = bytes.readUInt16LE(cursor + 2);
        skipBlocks();
      } else {
        assert.equal(marker, 0x2c);
        const width = bytes.readUInt16LE(cursor + 4), height = bytes.readUInt16LE(cursor + 6);
        const packed = bytes[cursor + 8]; cursor += 9;
        if (packed & 128) cursor += 3 * (1 << ((packed & 7) + 1));
        cursor += 1; skipBlocks(); frames.push({ width, height, delayCs });
      }
    }
    assert.deepEqual(frames, [{ width: 2, height: 3, delayCs: 3 }, { width: 2, height: 3, delayCs: 7 }]);
    assert.equal(trailer, true);
    assert.equal(h.writes.length, 0);
  } finally { real?.cancel(); h.api.dispose(); }
});

test('单屏：像素归属按主进程基准换算，冻结窗先隐藏再建源', async () => {
  const h = harness();
  const task = await h.startRecording({ x: 100, y: 120, width: 300, height: 200 });
  const result = await task;
  assert.deepEqual({ ...result }, { started: true });
  assert.deepEqual(h.captures[0], { x: 100, y: 120, width: 300, height: 200 }, '物理矩形 = nativeBounds 原点 + 局部像素');
  const hideAt = h.events.indexOf('frozen-hide');
  const createAt = h.events.indexOf('create-capture');
  assert.ok(hideAt >= 0 && createAt > hideAt, '冻结底图窗必须先退场，之后才允许新建采集');
  assert.equal(h.window.frozen.hidden, 1);
  assert.equal(h.getSession().phase, 'recording');
  assert.ok(h.encoders.length === 1 && h.encoders[0].frames.length === 1, '首帧到达就编码一次');
});

test('按键到首帧之间不建源：DWM 恢复等待完成前没有任何采集', async () => {
  const h = harness({ deferDelay: true });
  const task = h.startRecording();
  await settle();
  assert.equal(h.captures.length, 0, '等待期间绝不建原生源');
  assert.equal(h.window.frozen.hidden, 1, '冻结窗已退场');
  assert.equal(h.delayCalls[0], 100);
  h.releaseDelay();
  await settle();
  assert.deepEqual({ ...(await task) }, { started: true });
  assert.equal(h.captures.length, 1);
});

test('非法选区在动窗前拒绝：越界、超尺寸、长图或编辑中的选区都不录', async () => {
  const over = harness();
  await assert.rejects(over.startRecording({ x: 950, y: 120, width: 100, height: 200 }), /超出可录制范围/);
  assert.equal(over.captures.length, 0);
  assert.equal(over.windows.length, 0, '拒绝时不留任何窗口');
  assert.equal(over.getSession().phase, 'selecting', '选区会话原样保留');

  // 4096 上限：用 2x 屏把 2100 DIP 换算成 4200 物理像素。
  const wide = harness({ scaleFactor: 2, displayBounds: { x: 0, y: 0, width: 2100, height: 900 },
    physical: { x: 0, y: 0, width: 4200, height: 1800 }, physicalWork: { x: 0, y: 0, width: 4200, height: 1700 },
    frame: { width: 4200, height: 1800 } });
  await assert.rejects(wide.startRecording({ x: 0, y: 0, width: 2050, height: 400 }), /不能超过 4096/);
  assert.equal(wide.captures.length, 0);

  for (const extraCurrent of [{ longImage: { getSize: () => ({ width: 10, height: 10 }) } }, { editDocument: { token: 't' } }, { editorOpen: true }]) {
    const h = harness({ extraCurrent });
    await assert.rejects(h.startRecording(), /不能录制/);
    assert.equal(h.captures.length, 0);
  }
});

test('跨屏会话：落在一屏内允许并只平移 owner 原点，跨屏或空隙直接拒绝', async () => {
  const ownerPhysical = { x: -1920, y: 0, width: 1920, height: 1080 };
  const ownerDisplay = { id: 7, scaleFactor: 1, bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    workArea: { x: -1920, y: 0, width: 1920, height: 1040 } };
  const cross = harness({ mode: 'desktop', displayBounds: { ...ownerDisplay.bounds }, workArea: { ...ownerDisplay.workArea },
    physical: { ...ownerPhysical }, physicalWork: { ...ownerDisplay.workArea }, frame: { width: 1920, height: 1080 },
    resolveSelection: async (_current, rect) => {
      if (rect.x > 500) return undefined;
      return { pixels: { x: 40, y: 60, width: 200, height: 150 },
        env: { display: { ...ownerDisplay, bounds: { ...ownerDisplay.bounds }, workArea: { ...ownerDisplay.workArea } },
          frame: { width: 1920, height: 1080 }, nativeBounds: { ...ownerPhysical },
          nativeHint: { ...ownerPhysical }, nativeWorkArea: { ...ownerDisplay.workArea },
          nativeWorkHint: { ...ownerDisplay.workArea } } };
    } });
  await cross.startRecording({ x: 10, y: 20, width: 200, height: 150 });
  assert.deepEqual(cross.captures[0], { x: -1880, y: 60, width: 200, height: 150 });

  const rejected = harness({ mode: 'desktop', resolveSelection: async () => undefined });
  await assert.rejects(rejected.startRecording({ x: 10, y: 10, width: 100, height: 100 }), /跨屏或包含屏幕空隙/);
  assert.equal(rejected.captures.length, 0);
});

test('单飞：编码在飞时不请求下一帧；无变化帧跳过编码但时间继续', async () => {
  const h = harness();
  const release = h.holdEncoding();
  await h.startRecording();
  assert.equal(h.captureState.next, 1);
  await h.advance(1000);
  assert.equal(h.captureState.next, 1, '上一帧没编码完就绝不再取帧');
  h.captureState.queue.push({ fresh: false });
  release();
  await h.advance(0);
  assert.equal(h.captureState.next, 1, '编码收尾后才有下一拍');
  await h.advance(100);
  assert.equal(h.captureState.next, 2);
  await h.advance(100);
  assert.equal(h.captureState.next, 3, '一次推进只取一帧');
  const encoder = h.encoders[0];
  // 编码被挂住的这 1 秒里时间照走：下一帧的 elapsedMs 是真实走过的 1200ms，而不是补拍出来的帧数。
  assert.deepEqual(encoder.frames.map(frame => frame.elapsedMs), [0, 1200], '无变化帧不编码，但时间照走');
  assert.equal(encoder.peak, 1, '编码永远单飞');
});

test('30 秒自动收尾：先停源再 finish，预览事件立即送达', async () => {
  const h = harness();
  await h.startRecording();
  await h.advance(31000);
  const encoder = h.encoders[0];
  assert.deepEqual(encoder.finishCalls, [30000], '收尾时长不超过 30 秒');
  const stopAt = h.events.indexOf('capture-stop');
  const finishAt = h.events.indexOf('encoder-finish');
  assert.ok(stopAt >= 0 && finishAt > stopAt, '先停原生源再收尾编码');
  assert.equal(h.getSession().phase, 'record-preview');
  const preview = h.previews().at(-1);
  assert.equal(preview.width, 300);
  assert.equal(preview.height, 200);
  assert.equal(preview.elapsedMs, 30000);
  assert.equal(preview.bytes.length, h.encoderBytes.length);
  assert.equal(h.gifStatuses().at(-1).mode, 'preview');
  assert.equal(h.bar().bounds.width, 900, '预览态把控制条扩到预览大小');
});

test('手动停止与 ready 握手：预览只补发一次，状态字段齐全', async () => {
  const h = harness();
  await h.startRecording();
  await h.advance(500);
  const result = await h.barInvoke('gif:action', 'stop');
  assert.deepEqual({ ...result }, { ok: true });
  const sent = h.previews().length;
  assert.equal(sent, 1, '收尾时主动推一次预览');
  const status = await h.barInvoke('gif:ready');
  assert.equal(status.mode, 'preview');
  for (const key of ['mode', 'elapsedMs', 'width', 'height', 'message']) assert.ok(key in status, `状态必须带 ${key}`);
  assert.equal(h.previews().length, sent + 1, '握手时补发预览，避免丢事件');
  assert.deepEqual(h.unregistered, ['Escape', 'CommandOrControl+Alt+Escape'], '收尾后注销自己注册的全局键');
});

test('保存：取消对话框保留预览，写失败保留字节，成功只收事务不碰剪贴板', async () => {
  const cancel = harness({ saveCanceled: true });
  await cancel.startRecording();
  await cancel.barInvoke('gif:action', 'stop');
  const canceled = await cancel.barInvoke('gif:action', 'save');
  assert.deepEqual({ ...canceled }, { ok: false, canceled: true });
  assert.equal(cancel.getSession().phase, 'record-preview', '取消保存回到预览态');
  assert.match(cancel.gifStatuses().at(-1).message, /已取消保存/);
  await cancel.barInvoke('gif:ready');
  assert.equal(cancel.previews().length, 2, '预览字节仍在，可再次保存');
  assert.equal(cancel.dialogs[0].options.filters[0].extensions[0], 'gif');
  assert.match(cancel.dialogs[0].options.defaultPath, /\.gif$/);

  const failing = harness({ saveFails: true });
  await failing.startRecording();
  await failing.barInvoke('gif:action', 'stop');
  // 写失败必须报出来（控制条靠拒绝显示错误），同时保留预览字节。
  await assert.rejects(failing.barInvoke('gif:action', 'save'), /保存失败：磁盘不可用/);
  assert.equal(failing.getSession().phase, 'record-preview');
  assert.match(failing.gifStatuses().at(-1).message, /保存失败/);
  await failing.barInvoke('gif:ready');
  assert.equal(failing.previews().length, 2, '写失败也要留着字节供重试');

  const ok = harness({ saveFile: 'C:\\Users\\test\\Pictures\\done.gif' });
  await ok.startRecording();
  await ok.barInvoke('gif:action', 'stop');
  const saved = await ok.barInvoke('gif:action', 'save');
  assert.deepEqual({ ...saved }, { ok: true, file: 'C:\\Users\\test\\Pictures\\done.gif' });
  assert.equal(ok.writes.length, 1);
  assert.equal(ok.writes[0].bytes.length, ok.encoderBytes.length, '保存的是主进程内存里的字节');
  assert.deepEqual(ok.finishes, ['completed']);
  assert.equal(ok.getSession(), undefined, '保存成功后整轮事务结束');
  assert.equal(ok.window.frozen.shown, 0, '不把设置窗弹回来');
});

test('取消与关窗：清源、编码、窗口与自己注册的快捷键，会话一起结束', async () => {
  const h = harness();
  await h.startRecording();
  const bar = h.bar();
  const result = await h.barInvoke('gif:action', 'cancel');
  assert.deepEqual({ ...result }, { ok: true });
  assert.deepEqual(h.cancels, ['cancelled']);
  assert.equal(h.captureState.stops, 1);
  assert.equal(h.encoders[0].cancels, 1);
  assert.equal(bar.isDestroyed(), true);
  assert.deepEqual(h.unregistered, ['Escape', 'CommandOrControl+Alt+Escape']);
  assert.equal(h.getSession(), undefined);

  const closing = harness();
  await closing.startRecording();
  closing.bar().destroy();
  await settle();
  assert.deepEqual(closing.cancels, ['cancelled'], '录制中关掉控制条就是取消');
  assert.equal(closing.getSession(), undefined);
});

test('重录：只清本次 GIF 与编码器，按同一可信区域从实时桌面重开', async () => {
  const h = harness();
  await h.startRecording({ x: 30, y: 40, width: 320, height: 240 });
  await h.barInvoke('gif:action', 'stop');
  assert.equal(h.getSession().phase, 'record-preview');
  assert.equal(h.encoders.length, 1);
  const result = await h.barInvoke('gif:action', 'retry');
  assert.deepEqual({ ...result }, { started: true });
  assert.equal(h.getSession().phase, 'recording');
  assert.equal(h.encoders.length, 2, '重录换一只编码器，不留上一轮帧');
  assert.deepEqual(h.captures.at(-1), { x: 30, y: 40, width: 320, height: 240 }, '区域还是那次可信矩形');
  assert.equal(h.captureState.next, 2, '新的一轮重新从实时桌面取帧');
  assert.equal(h.window.frozen.hidden, 2, '重录前再让冻结窗退场一次');
});

test('重录失败：回到可重试的错误态，不把会话卡在准备中', async () => {
  const h = harness();
  await h.startRecording();
  await h.barInvoke('gif:action', 'stop');
  assert.equal(h.getSession().phase, 'record-preview');
  h.failNextCapture();
  await assert.rejects(h.barInvoke('gif:action', 'retry'), /模拟原生源不可用/);
  assert.equal(h.getSession().phase, 'record-preview', '失败后回到预览/错误态，而不是停在 record-starting');
  assert.equal(h.gifStatuses().at(-1).mode, 'error');
  // 还能再试一次：不允许因为一次失败就变成死路。
  const retry = await h.barInvoke('gif:action', 'retry');
  assert.deepEqual({ ...retry }, { started: true });
  assert.equal(h.getSession().phase, 'recording');
});

test('未授权帧与非法动作：外来 webContents 一律拒绝', async () => {
  const h = harness();
  await h.startRecording();
  const foreign = { sender: { mainFrame: {} }, senderFrame: {} };
  await assert.rejects(h.handlers.get('gif:action')(foreign, 'stop'), /无效录制窗口/);
  await assert.rejects(async () => h.handlers.get('gif:ready')(foreign), /无效录制窗口/);
  await assert.rejects(async () => h.handlers.get('shot:record-begin')(foreign, { x: 1, y: 1, width: 50, height: 50 }), /无效选区窗口/);
  await assert.rejects(h.barInvoke('gif:action', 'explode'), /不支持的录制操作/);
  await assert.rejects(h.barInvoke('gif:action', { action: 'stop' }), /不支持的录制操作/);
  assert.equal(h.getSession().phase, 'recording', '被拒绝的请求不动会话');
});

test('采集中断：错误状态保留重录入口，不假成功', async () => {
  const h = harness();
  await h.startRecording();
  h.captureState.queue.push({ error: new Error('原生采集已中断（exit code=1 signal=null）') });
  await h.advance(100);
  assert.equal(h.getSession().phase, 'record-preview');
  assert.match(h.gifStatuses().at(-1).message, /屏幕采集中断/);
  assert.equal(h.gifStatuses().at(-1).mode, 'error');
  assert.equal(h.captureState.stops, 1);
  assert.equal(h.encoders[0].cancels, 1);
  assert.equal(h.previews().length, 0, '失败不能交出伪造的预览');
  const retry = await h.barInvoke('gif:action', 'retry');
  assert.deepEqual({ ...retry }, { started: true });
});

test('控制条被挪进选区或挪出工作区：下一次采样就停，不靠内容排除兜底', async () => {
  // 选区铺满整屏：按新规则根本不允许开录，明确拒绝。
  const covered = harness({ selection: { x: 0, y: 0, width: 1000, height: 800 } });
  await assert.rejects(covered.startRecording({ x: 0, y: 0, width: 1000, height: 800 }), /录制区域外放不下控制条/);
  assert.equal(covered.captures.length, 0);
  assert.equal(covered.getSession().phase, 'selecting');

  // 录制中把控制条挪进选区：不靠排除兜底，直接停。
  const pushed = harness();
  await pushed.startRecording();
  const roi = pushed.getSession().recording.roi;
  pushed.bar().setBounds({ x: roi.x + 10, y: roi.y + 10, width: 420, height: 100 });
  await pushed.advance(100);
  assert.equal(pushed.getSession().phase, 'record-preview');
  assert.match(pushed.gifStatuses().at(-1).message, /控制条压进了录制范围/);
  assert.deepEqual(pushed.lifecycleFor('gif-record-error').at(-1), { phase: 'recording', code: 'bar-unsafe' });

  // 位置被挪出工作区：同样立即停，不带着控件继续录。
  const moved = harness();
  await moved.startRecording();
  moved.bar().setBounds({ x: -400, y: -400, width: 420, height: 100 });
  await moved.advance(100);
  assert.match(moved.gifStatuses().at(-1).message, /控制条压进了录制范围/);
});

test('拓扑变化：换缩放、换物理映射都在采样前拒绝', async () => {
  const h = harness();
  await h.startRecording();
  h.changeDisplay({ scaleFactor: 2 });
  await h.advance(100);
  assert.match(h.gifStatuses().at(-1).message, /显示器分辨率或缩放发生变化/);
  assert.equal(h.captureState.stops, 1);

  const mapping = harness();
  await mapping.startRecording();
  mapping.patchPhysical({ x: 0, y: 0, width: 1000, height: 800 - 1 });
  await mapping.advance(100);
  assert.match(mapping.gifStatuses().at(-1).message, /物理映射|物理矩形|尺寸/);
});

test('cleanup 之后迟到的帧不复活，也不再编码', async () => {
  const h = harness();
  await h.startRecording();
  h.captureState.queue.push({ defer: true });
  await h.advance(100);
  const framesBefore = h.encoders[0].frames.length;
  const statusesBefore = h.gifStatuses().length;
  const session = h.getSession();
  h.api.cleanup(session);
  assert.equal(session.recording, undefined, 'cleanup 摘掉录制状态');
  // 迟到的帧回包：既不编码，也不改状态，更不重建会话。
  h.captureState.deferred.splice(0).forEach(entry => entry.resolve({ fresh: true, width: 300, height: 200,
    data: new Uint8ClampedArray(300 * 200 * 4) }));
  await h.advance(500);
  assert.equal(h.encoders[0].frames.length, framesBefore);
  assert.equal(h.encoders[0].cancels, 1);
  assert.equal(h.gifStatuses().length, statusesBefore);
  assert.equal(h.timers(), 0, '收尾后不留定时器');
});

test('快捷键注册失败时只注销自己成功注册的那个', async () => {
  const h = harness({ escapeFails: true });
  await h.startRecording();
  assert.deepEqual(h.registrations, ['Escape', 'CommandOrControl+Alt+Escape']);
  await h.barInvoke('gif:action', 'stop');
  assert.deepEqual(h.unregistered, ['CommandOrControl+Alt+Escape'], '没注册成功的 Esc 不能去注销');
});

test('准备阶段失败：录制事务作废，冻结选框重新上屏且不留下源', async () => {
  const h = harness({ barLoadFails: true });
  await assert.rejects(h.startRecording(), /模拟录制页加载失败/);
  assert.equal(h.getSession().phase, 'selecting');
  assert.equal(h.window.frozen.shown, 1, '选区窗重新显示，选区数据保留');
  assert.equal(h.captures.length, 0);
  assert.equal(h.bar().isDestroyed(), true, '失败后控制条已销毁');
  assert.equal(h.getSession().recording, undefined);
});

test('启动只建 1 扇控制条 + 最多 4 条录屏边：全都不整屏、全在选区外', async () => {
  const h = harness();
  await h.startRecording();
  const borders = h.allBorderWindows();
  assert.ok(borders.length >= 1 && borders.length <= 4, `边框条数 ${borders.length} 应在 1..4`);
  assert.equal(h.windowsAlive().length, 1 + borders.length, '除控制条外只有边框条');
  assert.deepEqual(h.fullScreenWindows(), [], '不得出现整屏大小的窗口');
  assert.equal(h.bar().file.endsWith('gif-recorder.html'), true);
  for (const win of borders) assert.equal(String(win.file || '').endsWith('gif-border.html'), true, '每条都加载静态色条页');
  const region = h.getSession().recording.region;
  for (const rect of h.borderRectsOf()) {
    const overlap = rect.x < region.x + region.width && rect.x + rect.width > region.x &&
      rect.y < region.y + region.height && rect.y + rect.height > region.y;
    assert.equal(overlap, false, '边框物理矩形必须与录制区零重叠');
  }
  const roi = h.getSession().recording.roi;
  const bounds = h.bar().getBounds();
  const barOverlap = bounds.x < roi.x + roi.width && bounds.x + bounds.width > roi.x &&
    bounds.y < roi.y + roi.height && bounds.y + bounds.height > roi.y;
  assert.equal(barOverlap, false, '控制条必须完全在选区外');
  assert.equal(h.bar().isContentProtected(), false, '不靠内容排除把控件压进选区');
  assert.equal(borders.every(win => win.isContentProtected() === false), true, '边框条一律不做内容保护');
});

test('控件放不下：近全屏选区直接拒绝，不建源也不留窗', async () => {
  // 工作区只剩一条比控制条还窄的空间，四边都放不下。
  for (const selection of [{ x: 0, y: 0, width: 1000, height: 800 }, { x: 0, y: 30, width: 1000, height: 740 }]) {
    const h = harness();
    await assert.rejects(h.startRecording(selection), /录制区域外放不下控制条，请缩小选区/);
    assert.equal(h.captures.length, 0, '放不下就不建原生源');
    assert.deepEqual(h.windowsAlive(), [], '不留下任何窗口');
    assert.equal(h.getSession().phase, 'selecting', '选区会话原样保留');
    assert.equal(h.window.frozen.visible, true, '冻结选区仍在屏上');
  }
});

test('物理拟合只对隐藏窗：首录与重录都先隐藏再 fit，上屏在 fit 之后', async () => {
  const h = harness();
  await h.startRecording();
  const first = h.fits.map(fit => fit.target);
  assert.equal(first[0], 'bar', '先摆控制条');
  assert.deepEqual(first.slice(1), first.slice(1).map(() => 'border'), '其余全是边框条');
  assert.equal(h.fits.every(fit => fit.visible === false), true, '可见窗一律不接受拟合');
  assert.equal(h.bar().isVisible(), true, '拟合完成后才上屏');
  assert.equal(h.borderWindows().every(win => win.isVisible()), true, '边框条也在 startCapture 里上屏');
  await h.barInvoke('gif:action', 'stop');
  assert.equal(h.bar().isVisible(), true, '预览态控制条可见');
  const before = h.fits.length;
  const retry = await h.barInvoke('gif:action', 'retry');
  assert.deepEqual({ ...retry }, { started: true });
  const retried = h.fits.slice(before);
  assert.equal(retried[0].target, 'bar', '重录先重拟合控制条');
  assert.equal(retried.length, 1 + h.borderWindows().length, '重录重新拟合控制条与全部边框条');
  assert.equal(retried.every(fit => fit.visible === false), true, '重录也只在隐藏窗上拟合');
});

test('重录：仍先隐藏→拟合→上屏，边框条重建且不出现整屏窗', async () => {
  const h = harness();
  await h.startRecording();
  const firstCount = h.allBorderWindows().length;
  assert.ok(firstCount >= 1);
  await h.barInvoke('gif:action', 'stop');
  assert.deepEqual(h.allBorderWindows().filter(win => !win.isDestroyed()), [], '收尾（预览前）销毁全部边框条');
  assert.equal(h.getSession().recording.borders.length, 0, '归属已先摘干净');
  const retry = await h.barInvoke('gif:action', 'retry');
  assert.deepEqual({ ...retry }, { started: true });
  assert.equal(h.borderWindows().length, firstCount, '重录重建同数量边框条');
  assert.deepEqual(h.fullScreenWindows(), []);
  assert.equal(h.captures.length, 2, '重录仍按同一可信矩形重新建源');
  const roi = h.getSession().recording.roi;
  const bounds = h.bar().getBounds();
  const overlap = bounds.x < roi.x + roi.width && bounds.x + bounds.width > roi.x &&
    bounds.y < roi.y + roi.height && bounds.y + bounds.height > roi.y;
  assert.equal(overlap, false, '重录后控制条仍完全在选区外');
});

test('取帧在途被篡改：数据回来后编码前复核，拓扑/控件位置变了就不编码', async () => {
  const topology = harness();
  await topology.startRecording();
  topology.captureState.queue.push({ defer: true });
  await topology.advance(100);
  assert.equal(topology.captureState.deferred.length, 1, 'next 挂在途中');
  topology.changeDisplay({ scaleFactor: 2 });
  topology.captureState.deferred.splice(0).forEach(entry => entry.resolve({ fresh: true, width: 300, height: 200,
    data: new Uint8ClampedArray(300 * 200 * 4) }));
  await topology.advance(0);
  assert.equal(topology.encoders[0].frames.length, 1, '首帧之后这帧没有被编码');
  assert.match(topology.gifStatuses().at(-1).message, /显示器分辨率或缩放发生变化/);

  const pushed = harness();
  await pushed.startRecording();
  pushed.captureState.queue.push({ defer: true });
  await pushed.advance(100);
  const roi = pushed.getSession().recording.roi;
  pushed.bar().setBounds({ x: roi.x + 5, y: roi.y + 5, width: 420, height: 100 });
  pushed.captureState.deferred.splice(0).forEach(entry => entry.resolve({ fresh: true, width: 300, height: 200,
    data: new Uint8ClampedArray(300 * 200 * 4) }));
  await pushed.advance(0);
  assert.equal(pushed.encoders[0].frames.length, 1, '控件压进选区后到手的帧也不编码');
  assert.match(pushed.gifStatuses().at(-1).message, /控制条压进了录制范围/);
});

test('停止时长取点击时刻：不把等待编码的时间算成录制长度', async () => {
  const h = harness();
  const release = h.holdEncoding();
  await h.startRecording();
  await h.advance(500);
  assert.deepEqual(h.encoders[0].frames.map(frame => frame.elapsedMs), [0]);
  const stop = h.barInvoke('gif:action', 'stop');
  stop.catch(() => {});
  await drain();
  assert.deepEqual(h.encoders[0].finishCalls, [], '挂起的 frame 没结束前不 finish');
  release();
  assert.deepEqual({ ...(await stop) }, { ok: true });
  assert.deepEqual(h.encoders[0].finishCalls, [500], 'finish 用点击时的 500ms，而不是最后帧的 0ms');
  assert.equal(h.encoders[0].finishWhileBusy, undefined, 'finish 与 frame 从不并行');
  const encodeEnd = h.events.indexOf('encode-end-0');
  const finishAt = h.events.indexOf('encoder-finish');
  assert.ok(encodeEnd >= 0 && finishAt > encodeEnd, '先等帧编码收尾，再 finish');
  assert.equal(h.previews().at(-1).elapsedMs, 500);
});

test('慢帧超过 3 秒也不提前收尾：等满编码超时窗口后再 finish', async () => {
  const h = harness();
  const release = h.holdEncoding();
  await h.startRecording();
  await h.advance(10500);
  const stop = h.barInvoke('gif:action', 'stop');
  stop.catch(() => {});
  await h.advance(4000);
  assert.deepEqual(h.encoders[0].finishCalls, [], '仍在等挂起的那条 frame，没有抢跑去 finish');
  assert.equal(h.getSession().phase, 'record-finishing');
  release();
  assert.deepEqual({ ...(await stop) }, { ok: true });
  assert.deepEqual(h.encoders[0].finishCalls, [10500]);
  assert.equal(h.encoders[0].finishWhileBusy, undefined);
});

test('收尾等待中取消：编码晚到不复活，也不再 finish', async () => {
  const h = harness();
  const release = h.holdEncoding();
  await h.startRecording();
  const stop = h.barInvoke('gif:action', 'stop');
  stop.catch(() => {});
  await drain();
  assert.equal(h.getSession().phase, 'record-finishing');
  const result = await h.barInvoke('gif:action', 'cancel');
  assert.deepEqual({ ...result }, { ok: true });
  assert.equal(h.getSession(), undefined);
  release();
  await h.advance(1000);
  assert.equal(h.encoders[0].finishCalls.length, 0, '取消后绝不再 finish');
  assert.deepEqual({ ...(await stop) }, { ok: false }, '迟到的 stop 只回失败，不复活事务');
});

test('停止先停源：挂起的 next 立刻被拒，不会再等出一帧', async () => {
  const h = harness();
  await h.startRecording();
  h.captureState.queue.push({ defer: true });
  await h.advance(200);
  assert.equal(h.captureState.deferred.length, 1, 'next 挂在途中');
  const stop = h.barInvoke('gif:action', 'stop');
  stop.catch(() => {});
  // 真实计时器兜底：旧实现会先等 inflight（最多 11 秒）才停源，这里必须很快收尾。
  const guarded = Promise.race([stop, new Promise((resolve, reject) => setTimeout(() => reject(new Error('停止没有立即完成')), 500))]);
  const result = await guarded;
  assert.deepEqual({ ...result }, { ok: true });
  assert.equal(h.captureState.stops, 1, '停止那一刻就停源');
  assert.equal(h.encoders[0].frames.length, 1, '挂起的那帧没有被编码');
  assert.deepEqual(h.encoders[0].finishCalls, [200], '用点击时长收尾');
  assert.equal(h.getSession().phase, 'record-preview');
});

test('保存中关闭控制条：取消/无路径/抛错/迟到成功四种回包都不留事务、也不新写', async () => {
  const cases = [
    { name: '取消', reply: h => h.resolveDialog({ canceled: true }) },
    { name: '无路径', reply: h => h.resolveDialog({ canceled: false }) },
    { name: '抛错', reply: h => h.rejectDialog(new Error('dialog unavailable')) },
    { name: '迟到成功', reply: h => h.resolveDialog({ canceled: false, filePath: 'C:\\late\\never.gif' }) }
  ];
  for (const item of cases) {
    const h = harness({ deferDialog: true });
    await h.startRecording();
    await h.barInvoke('gif:action', 'stop');
    const save = h.barInvoke('gif:action', 'save');
    save.catch(() => {});
    await drain();
    assert.equal(h.dialogs.length, 1, `${item.name}：另存框已打开`);
    h.closeBar();
    await drain();
    assert.equal(h.getSession().phase, 'saving', '关窗不改变保存中的阶段（不能留着不动的忙态）');
    item.reply(h);
    const result = await save;
    assert.deepEqual({ ...result }, { ok: false, canceled: true }, `${item.name}：回包后整轮取消`);
    assert.equal(h.getSession(), undefined, `${item.name}：不留 recording 事务`);
    assert.equal(h.writes.length, 0, `${item.name}：一个字节都不新写`);
    assert.deepEqual(h.cancels.at(-1), 'cancelled', `${item.name}：走整轮取消而不是死等`);
  }
});

test('保存写盘期间控制条崩溃：写失败不留忙态，写成功照实算成功并收会话', async () => {
  const failing = harness({ deferWrite: true });
  await failing.startRecording();
  await failing.barInvoke('gif:action', 'stop');
  const save = failing.barInvoke('gif:action', 'save');
  save.catch(() => {});
  await drain();
  assert.equal(failing.pendingWrite(), true, '写盘已开始');
  failing.crashBar();
  await drain();
  failing.rejectWrite(new Error('写盘中断'));
  const failed = await save;
  assert.deepEqual({ ...failed }, { ok: false, canceled: true });
  assert.equal(failing.getSession(), undefined, '崩溃后不留 recording 事务');
  assert.equal(failing.writes.length, 0);
  assert.equal(failing.finishes.length, 0, '没写成不能算完成');

  const ok = harness({ deferWrite: true, saveFile: 'C:\\Users\\test\\Pictures\\crashed-but-saved.gif' });
  await ok.startRecording();
  await ok.barInvoke('gif:action', 'stop');
  const saving = ok.barInvoke('gif:action', 'save');
  saving.catch(() => {});
  await drain();
  ok.crashBar();
  await drain();
  ok.resolveWrite();
  const saved = await saving;
  assert.deepEqual({ ...saved }, { ok: true, file: 'C:\\Users\\test\\Pictures\\crashed-but-saved.gif' });
  assert.equal(ok.writes.length, 1, '已经落盘的写不能撤');
  assert.deepEqual(ok.finishes, ['completed'], '写成功就照实结束事务');
  assert.equal(ok.getSession(), undefined);
  assert.match(ok.statuses.at(-1).message, /GIF 已另存/);
});

test('控制条关闭发生在对话框回包与写盘之间：一个字节都不新写', async () => {
  const h = harness({ deferDialog: true });
  await h.startRecording();
  await h.barInvoke('gif:action', 'stop');
  const save = h.barInvoke('gif:action', 'save');
  save.catch(() => {});
  await drain();
  // 对话框先回来（带路径），紧接着窗才没：回包与写盘之间的窗口丢失必须挡住写入。
  const gate = h.handlers.get('gif:action');
  h.resolveDialog({ canceled: false, filePath: 'C:\\Users\\test\\Pictures\\too-late.gif' });
  h.closeBar();
  const result = await save;
  assert.ok(gate, '动作处理器存在');
  assert.deepEqual({ ...result }, { ok: false, canceled: true });
  assert.equal(h.writes.length, 0);
  assert.equal(h.getSession(), undefined);
});

test('构窗副作用抛异常：自建窗口全部销毁、选区恢复、绝不建源', async () => {
  const cases = [
    { kind: 'bar', method: 'setBounds' },
    { kind: 'bar', method: 'setIgnoreMouseEvents' },
    { kind: 'bar', method: 'setAlwaysOnTop' }
  ];
  for (const item of cases) {
    const h = harness({ windowFaults: { [item.kind]: [item.method] } });
    await assert.rejects(h.startRecording(), new RegExp(`模拟 ${item.method} 异常`), `${item.kind}.${item.method} 必须上抛`);
    assert.equal(h.getSession().phase, 'selecting', `${item.kind}.${item.method}：选区会话恢复`);
    assert.equal(h.getSession().recording, undefined, '不留录制事务');
    assert.equal(h.captures.length, 0, '不建原生源');
    assert.deepEqual(h.windowsAlive(), [], `${item.kind}.${item.method}：不能遗留隐藏窗`);
    assert.equal(h.window.frozen.shown, 1, '冻结选框重新上屏');
    assert.equal(h.window.frozen.hidden, 0, '失败发生在隐藏之前');
    assert.deepEqual(h.cancels, [], '收自己建到一半的窗，不能顺带 cancel 整个截图会话');
  }
});

test('采样前读窗口几何抛异常：不建源、不留窗、选区恢复', async () => {
  const h = harness({ windowFaults: { bar: ['getBounds'] } });
  await assert.rejects(h.startRecording(), /模拟 getBounds 异常/);
  assert.equal(h.captures.length, 0);
  assert.equal(h.getSession().phase, 'selecting');
  assert.deepEqual(h.windowsAlive(), []);
});

test('冻结窗隐藏失败：恢复选区、拒绝开录、不建源，并记 frozen-visible', async () => {
  const h = harness({ frozenHideFails: true });
  await assert.rejects(h.startRecording(), /选区窗口未能隐藏，录制没有开始/);
  assert.equal(h.captures.length, 0, '隐藏没生效就绝不建原生源');
  assert.equal(h.getSession().phase, 'selecting');
  assert.equal(h.getSession().recording, undefined);
  assert.deepEqual(h.windowsAlive(), [], '不留下控制条');
  assert.equal(h.window.frozen.visible, true, '选区窗仍在屏上，数据保留');
  assert.deepEqual(h.lifecycleFor('gif-record-error').at(-1), { phase: 'record-starting', code: 'frozen-visible' });
  assert.deepEqual(h.lifecycleFor('gif-record-start'), [], '没开始就不该有 start 留痕');
});

test('留痕只记固定计数：start / 每秒 sample / finish 与 gifBytes', async () => {
  const h = harness();
  await h.startRecording();
  // 首帧已到，之后 3 变化帧 + 2 重复帧。
  h.captureState.queue.push({ fresh: true }, { fresh: false }, { fresh: true }, { fresh: false }, { fresh: true });
  for (let i = 0; i < 5; i += 1) await h.advance(100);
  const started = h.lifecycleFor('gif-record-start')[0];
  assert.deepEqual(started, { width: 300, height: 200, frozenVisible: false, border: true, borderCount: 4 });
  // 时间轴：首帧 0ms，5 次推进后到 500ms；至少应有一次 0ms 采样与一次 ≥1s 采样。
  await h.advance(600);
  const samples = h.lifecycleFor('gif-record-sample');
  assert.ok(samples.length >= 2, `每秒至少一行采样，实际 ${samples.length}`);
  for (const sample of samples) {
    assert.deepEqual(Object.keys(sample).sort(), ['duplicateFrames', 'elapsedMs', 'freshFrames', 'requests']);
    for (const value of Object.values(sample)) assert.equal(Number.isSafeInteger(value), true, '计数只能是整数');
  }
  const monotonic = samples.map(entry => entry.elapsedMs);
  assert.deepEqual(monotonic, [...monotonic].sort((a, b) => a - b), '采样时间单调');
  for (let i = 1; i < samples.length; i += 1) assert.ok(samples[i].elapsedMs - samples[i - 1].elapsedMs >= 1000, '采样间隔不小于 1 秒');
  const lastSample = samples.at(-1);
  assert.ok(lastSample.requests >= 6 && lastSample.freshFrames >= 4 && lastSample.duplicateFrames >= 2,
    `计数应累计本次采样：${JSON.stringify(lastSample)}`);

  const encoder = h.encoders[0];
  await h.barInvoke('gif:action', 'stop');
  const finished = h.lifecycleFor('gif-record-finish')[0];
  assert.ok(finished.requests >= lastSample.requests, '计数只增不减');
  assert.equal(finished.freshFrames, encoder.frames.length, 'freshFrames 等于真正送进编码器的帧数');
  assert.ok(finished.duplicateFrames >= 2, '两次无变化都要算进 duplicateFrames');
  // 请求数 = 已分类的帧 + 至多一条收尾时还在飞的那一条。
  assert.ok(finished.requests >= finished.freshFrames + finished.duplicateFrames);
  assert.ok(finished.requests <= finished.freshFrames + finished.duplicateFrames + 1);
  assert.equal(finished.gifBytes, h.encoderBytes.length, '只记字节数，不记内容');
  assert.equal(typeof finished.elapsedMs, 'number');
  // 留痕里不得出现像素/坐标/路径这类字段。
  const flat = JSON.stringify(h.lifecycles);
  for (const forbidden of ['C:\\\\', 'pixels', 'region', 'dataUrl', 'hash']) {
    assert.equal(flat.includes(forbidden), false, `留痕不得包含 ${forbidden}`);
  }
});

// —— 录制边框：几何以绝对物理像素为准 ——
const clipTo = (rect, native) => {
  const left = Math.max(rect.x, native.x), top = Math.max(rect.y, native.y);
  const right = Math.min(rect.x + rect.width, native.x + native.width);
  const bottom = Math.min(rect.y + rect.height, native.y + native.height);
  if (right - left <= 0 || bottom - top <= 0) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
};
// 规格：上/下条横向含角外扩 t，左/右条纵向只覆盖选区高度。
const specBorders = (region, t, native) => [
  { x: region.x - t, y: region.y - t, width: region.width + t * 2, height: t },
  { x: region.x - t, y: region.y + region.height, width: region.width + t * 2, height: t },
  { x: region.x - t, y: region.y, width: t, height: region.height },
  { x: region.x + region.width, y: region.y, width: t, height: region.height }
].map(rect => clipTo(rect, native)).filter(Boolean);
const overlapsRect = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test('四边几何：屏幕中央选区得到 4 条，坐标与厚度按物理像素算', async () => {
  const h = harness();
  await h.startRecording({ x: 100, y: 120, width: 300, height: 200 });
  const rec = h.getSession().recording;
  assert.deepEqual({ ...rec.region }, { x: 100, y: 120, width: 300, height: 200 });
  assert.deepEqual(h.borderRectsOf(), [
    { x: 98, y: 118, width: 304, height: 2 },
    { x: 98, y: 320, width: 304, height: 2 },
    { x: 98, y: 120, width: 2, height: 200 },
    { x: 400, y: 120, width: 2, height: 200 }
  ]);
  assert.equal(h.borderWindows().length, 4);
  // 原生拟合用的就是这四条物理矩形（不是 DIP 推出来的）。
  assert.deepEqual(h.fits.filter(fit => fit.target === 'border').map(fit => ({ ...fit.bounds })), h.borderRectsOf());
  for (const rect of h.borderRectsOf()) assert.equal(overlapsRect(rect, rec.region), false);
});

test('贴屏边：零面积的侧条跳过，用屏边本身当那一侧边界', async () => {
  const leftTop = harness({ selection: { x: 0, y: 0, width: 300, height: 200 } });
  await leftTop.startRecording({ x: 0, y: 0, width: 300, height: 200 });
  assert.equal(leftTop.borderWindows().length, 2, '左上贴边只剩右下两条');
  assert.deepEqual(leftTop.borderRectsOf(), [
    { x: 0, y: 200, width: 302, height: 2 },
    { x: 300, y: 0, width: 2, height: 200 }
  ]);

  // 只贴左边：三条（上、下、右），上/下条被裁到 x=0 起。
  const leftOnly = harness({ selection: { x: 0, y: 100, width: 300, height: 200 } });
  await leftOnly.startRecording({ x: 0, y: 100, width: 300, height: 200 });
  assert.equal(leftOnly.borderWindows().length, 3);
  assert.deepEqual(leftOnly.borderRectsOf(), [
    { x: 0, y: 98, width: 302, height: 2 },
    { x: 0, y: 300, width: 302, height: 2 },
    { x: 300, y: 100, width: 2, height: 200 }
  ]);
  const region = leftOnly.getSession().recording.region;
  for (const rect of leftOnly.borderRectsOf()) assert.equal(overlapsRect(rect, region), false);
});

test('DPI：125%/175%/200% 的厚度与物理矩形都按缩放换算', async () => {
  const cases = [
    { scaleFactor: 1.25, t: 3, physical: { x: 0, y: 0, width: 1250, height: 1000 } },
    { scaleFactor: 1.75, t: 4, physical: { x: 0, y: 0, width: 1750, height: 1400 } },
    { scaleFactor: 2, t: 4, physical: { x: 0, y: 0, width: 2000, height: 1600 } }
  ];
  for (const item of cases) {
    const h = harness({ scaleFactor: item.scaleFactor, physical: item.physical,
      physicalWork: { ...item.physical, height: item.physical.height - 80 }, frame: item.physical });
    await h.startRecording({ x: 100, y: 120, width: 300, height: 200 });
    const rec = h.getSession().recording;
    assert.deepEqual(h.borderRectsOf(), specBorders(rec.region, item.t, item.physical),
      `${item.scaleFactor}x：矩形必须按规格与厚度 ${item.t} 算`);
    for (const rect of h.borderRectsOf()) {
      assert.equal(overlapsRect(rect, rec.region), false, `${item.scaleFactor}x：零重叠`);
      assert.equal(rect.width * rect.height < item.physical.width * item.physical.height, true, '单条不得整屏');
    }
    for (const win of h.borderWindows()) {
      assert.equal([win.options.x, win.options.y, win.options.width, win.options.height]
        .every(value => Number.isInteger(value) && value >= 0), true, 'DIP 初始 bounds 必须是正整数');
    }
  }
});

test('负原点副屏：边框跟着 owner 物理原点走，不越出本屏', async () => {
  const native = { x: -1920, y: 0, width: 1920, height: 1080 };
  const h = harness({ displayBounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    workArea: { x: -1920, y: 0, width: 1920, height: 1040 }, physical: native,
    physicalWork: { x: -1920, y: 0, width: 1920, height: 1040 }, frame: native });
  await h.startRecording({ x: 100, y: 120, width: 300, height: 200 });
  const rec = h.getSession().recording;
  assert.deepEqual({ ...rec.region }, { x: -1820, y: 120, width: 300, height: 200 });
  assert.deepEqual(h.borderRectsOf(), [
    { x: -1822, y: 118, width: 304, height: 2 },
    { x: -1822, y: 320, width: 304, height: 2 },
    { x: -1822, y: 120, width: 2, height: 200 },
    { x: -1520, y: 120, width: 2, height: 200 }
  ]);
  for (const rect of h.borderRectsOf()) {
    assert.ok(rect.x >= native.x && rect.x + rect.width <= native.x + native.width, '不越出本屏横向');
    assert.equal(overlapsRect(rect, rec.region), false);
  }
});

test('边框窗口属性：全鼠标穿透、不抢焦点、无保护、无 preload、只加载静态色条', async () => {
  const h = harness();
  await h.startRecording();
  const borders = h.borderWindows();
  assert.equal(borders.length, 4);
  for (const win of borders) {
    assert.equal(win.ignoreMouse, true, '必须鼠标穿透');
    assert.equal(win.isContentProtected(), false, '不做内容保护');
    assert.equal(win.options.focusable, false, '不抢焦点');
    assert.equal(win.options.skipTaskbar, true);
    assert.equal(win.options.alwaysOnTop, true);
    assert.equal(win.options.hasShadow, false);
    assert.equal(win.options.backgroundColor, '#63ad8b', '实体浅绿');
    assert.equal(win.options.transparent, undefined, '不做透明窗');
    assert.equal(win.options.webPreferences?.preload, undefined, '无 preload');
    assert.equal(win.options.webPreferences?.nodeIntegration, false);
    assert.equal(win.options.webPreferences?.sandbox, true);
    assert.equal(String(win.file).endsWith('gif-border.html'), true);
  }
});

test('停止、取消、错误三条路径都销毁边框并先摘归属', async () => {
  const stopped = harness();
  await stopped.startRecording();
  const stoppedWins = stopped.borderWindows();
  await stopped.barInvoke('gif:action', 'stop');
  assert.equal(stoppedWins.some(win => !win.isDestroyed()), false, '停止后全部销毁');
  assert.equal(stopped.getSession().recording.borders.length, 0);

  const canceled = harness();
  await canceled.startRecording();
  const canceledWins = canceled.borderWindows();
  await canceled.barInvoke('gif:action', 'cancel');
  assert.equal(canceledWins.some(win => !win.isDestroyed()), false, '取消后全部销毁');
  assert.equal(canceled.getSession(), undefined, '取消即整轮结束');
  assert.deepEqual(canceled.cancels, ['cancelled']);

  const failed = harness();
  await failed.startRecording();
  const failedWins = failed.borderWindows();
  failed.borderWindows()[0].webContents.emit('render-process-gone', {}, {}, 'crashed');
  await drain();
  assert.equal(failedWins.some(win => !win.isDestroyed()), false, '边框崩溃后全部销毁');
  assert.equal(failed.getSession().phase, 'record-preview');
  assert.deepEqual(failed.lifecycleFor('gif-record-error').at(-1), { phase: 'recording', code: 'border-unsafe' });
});

test('边框异常：关闭 / 隐藏 / 被挪动 都要停录', async () => {
  const closed = harness();
  await closed.startRecording();
  closed.borderWindows()[0].destroy();
  await drain();
  assert.equal(closed.getSession().phase, 'record-preview');
  assert.match(closed.gifStatuses().at(-1).message, /录制边框已关闭/);
  assert.equal(closed.captureState.stops, 1);

  const hidden = harness();
  await hidden.startRecording();
  hidden.borderWindows()[0].hide();
  await drain();
  assert.match(hidden.gifStatuses().at(-1).message, /录制边框已隐藏/);
  assert.equal(hidden.captureState.stops, 1);

  const moved = harness();
  await moved.startRecording();
  const roi = moved.getSession().recording.roi;
  moved.borderWindows()[0].setBounds({ x: roi.x + 10, y: roi.y + 10, width: 40, height: 4 });
  await moved.advance(100);
  assert.match(moved.gifStatuses().at(-1).message, /录制边框位置或状态异常/);
  assert.equal(moved.captureState.stops, 1);
});

test('准备期间异步取消：不留半成品、不追加后续条、不复活窗口', async () => {
  const h = harness({ deferBorderFit: true });
  const task = h.invoke('shot:record-begin', { x: 100, y: 120, width: 300, height: 200 });
  task.catch(() => {});
  await drain();
  assert.equal(h.allBorderWindows().length, 1, '第一条正在拟合');
  await h.barInvoke('gif:action', 'cancel');
  assert.equal(h.getSession(), undefined, '取消已结束整轮');
  h.releaseBorderFit();
  await drain();
  assert.equal(h.allBorderWindows().length, 1, '取消后绝不追加后续条');
  assert.equal(h.allBorderWindows().some(win => !win.isDestroyed()), false, '半成品也已销毁');
  assert.deepEqual(h.windowsAlive(), [], '屏上不留任何窗口');
  assert.equal(h.captures.length, 0);
});

test('边框拟合 / 载页 / 属性异常：全部释放，选区恢复，不建源', async () => {
  const cases = [
    { options: { borderFitFails: true }, pattern: /模拟录制边框拟合失败/ },
    { options: { borderLoadFails: true }, pattern: /模拟录制边框加载失败/ },
    { options: { windowFaults: { border: ['setIgnoreMouseEvents'] } }, pattern: /模拟 setIgnoreMouseEvents 异常/ },
    { options: { windowFaults: { border: ['setAlwaysOnTop'] } }, pattern: /模拟 setAlwaysOnTop 异常/ }
  ];
  for (const item of cases) {
    const h = harness(item.options);
    await assert.rejects(h.startRecording(), item.pattern);
    assert.equal(h.getSession().phase, 'selecting', '选区会话恢复');
    assert.equal(h.getSession().recording, undefined);
    assert.equal(h.captures.length, 0, '不建原生源');
    assert.deepEqual(h.windowsAlive(), [], '不留任何窗口（含半成品边框）');
    assert.equal(h.window.frozen.visible, true, '冻结选区仍在屏上');
  }
});

test('录制中隐藏一条边框：被隐藏那扇也要销毁，源停下且可重录不留孤儿', async () => {
  const h = harness();
  await h.startRecording();
  assert.equal(h.windowsAlive().length, 5, '1 控制条 + 4 条边框');
  h.borderWindows()[1].hide();
  await drain();
  assert.equal(h.allBorderWindows().some(win => !win.isDestroyed()), false, '含被隐藏那扇在内全部销毁');
  assert.deepEqual(h.windowsAlive().map(win => win.isBar), [true], '屏上只剩控制条');
  assert.equal(h.captureState.stops, 1, '采集源停掉');
  assert.equal(h.getSession().phase, 'record-preview');
  assert.match(h.gifStatuses().at(-1).message, /录制边框已隐藏/);
  const retry = await h.barInvoke('gif:action', 'retry');
  assert.deepEqual({ ...retry }, { started: true });
  assert.equal(h.borderWindows().length, 4, '重录重建 4 条');
  assert.equal(h.windowsAlive().length, 5, '重录不多孤儿');
});

test('render-process-gone：webContents 死了但宿主仍活，那扇窄窗也要 destroy', async () => {
  const h = harness();
  await h.startRecording();
  const target = h.borderWindows()[2];
  assert.equal(target.isDestroyed(), false);
  h.crashBorder(2);
  await drain();
  assert.equal(target.webContents.isDestroyed(), true, '夹具：webContents 已死');
  assert.equal(target.isDestroyed(), true, '宿主 BrowserWindow 也必须销毁');
  assert.equal(h.allBorderWindows().some(win => !win.isDestroyed()), false, '其余条全部清');
  assert.deepEqual(h.windowsAlive().map(win => win.isBar), [true], '屏上只剩控制条');
  assert.equal(h.captureState.stops, 1);
  assert.equal(h.getSession().phase, 'record-preview');
  assert.deepEqual(h.lifecycleFor('gif-record-error').at(-1), { phase: 'recording', code: 'border-unsafe' });
  const retry = await h.barInvoke('gif:action', 'retry');
  assert.deepEqual({ ...retry }, { started: true });
  assert.equal(h.borderWindows().length, 4);
  assert.equal(h.windowsAlive().length, 5, '重录不多孤儿');
});

test('准备期 fit / load await 中边框崩溃：不卡录制阶段，选区恢复且零遗留', async () => {
  for (const mode of ['fit', 'load']) {
    const h = harness(mode === 'fit' ? { deferBorderFit: true } : { deferBorderLoad: true });
    const task = h.invoke('shot:record-begin', { x: 100, y: 120, width: 300, height: 200 });
    task.catch(() => {});
    await drain();
    assert.equal(h.allBorderWindows().length, 1, `${mode}：第一条还在等 await`);
    h.crashBorder(0);
    await drain();
    if (mode === 'fit') h.releaseBorderFit(); else h.releaseBorderLoad();
    await assert.rejects(task, /录制|边框/);
    assert.equal(h.getSession().phase, 'selecting', `${mode}：不能卡在 record-starting/record-preview`);
    assert.equal(h.getSession().recording, undefined);
    assert.deepEqual(h.windowsAlive(), [], `${mode}：不留任何窗口`);
    assert.equal(h.window.frozen.visible, true, `${mode}：冻结选区重新可见`);
    assert.equal(h.captures.length, 0, `${mode}：绝不建源`);
    assert.equal(h.allBorderWindows().length, 1, `${mode}：取消/失败后不再追加后续条`);
  }
});
