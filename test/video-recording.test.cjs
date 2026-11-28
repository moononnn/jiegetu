'use strict';
// 视频录制主进程用例：全部用假宿主（假窗口、假会话、假对话框、假屏幕），
// 不启动 Electron、不采桌面、不碰麦克风。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const recorderURL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'video-recorder.html')).href;
const { installVideoRecording, PARTITION } = require(path.join(__dirname, '..', 'main', 'video-recording.cjs'));

function fakeSession() {
  const handlers = { display: null, permission: null, check: null };
  const session = {
    handlers, partitions: [],
    fromPartition(name) { session.partitions.push(name); return session; },
    setDisplayMediaRequestHandler(fn) { handlers.display = fn; },
    setPermissionRequestHandler(fn) { handlers.permission = fn; },
    setPermissionCheckHandler(fn) { handlers.check = fn; },
  };
  return session;
}

function fakeWindow() {
  const listeners = new Map();
  return {
    webContents: { mainFrame: {}, send() {}, on() {}, setWindowOpenHandler() {} },
    isDestroyed: () => false,
    destroy() { this.destroyed = true; },
    on(type, fn) { listeners.set(type, fn); },
    showInactive() { this.shown = true; },
    listeners,
  };
}

function harness({ platform = 'win32', workArea = { x: 0, y: 0, width: 1920, height: 1080 }, selection = { x: 400, y: 200, width: 600, height: 400 }, bounds = { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor = 1, clampMask = false, physicalMismatch = false, checkReason = undefined, recoveryFails = false, viewportChanges = false, recoveryCancels = false, freezeObserve = false } = {}) {
  const calls = { windows: [], written: [], dialog: [], cancelled: false, status: [], lifecycle: [], ended: [] };
  const session = fakeSession();
  class BrowserWindow {
    constructor(options) { this.options = options; this.messages = []; this.webContents = { mainFrame: {}, getURL: () => this.file ? pathToFileURL(this.file).href : '', send: (channel, payload) => this.messages.push({ channel, payload }), on() {}, setWindowOpenHandler() {} };
      this.isDestroyed = () => Boolean(this.destroyed); this.destroy = () => { this.destroyed = true; }; this.on = () => {};
      this.showInactive = () => { this.shown = true; }; this.isVisible = () => Boolean(this.shown); this.setTitle = title => { this.title = title; }; this.setIgnoreMouseEvents = flag => { this.ignoresMouse = flag; }; this.setAlwaysOnTop = (flag, level) => { this.topmost = { flag, level }; }; this.setContentProtection = flag => { this.contentProtected = flag; };
      this.getBounds = () => ({ x: options.x, y: options.y, width: options.width + (clampMask && options.transparent ? 1 : 0), height: options.height });
      this.loadFile = async (file, query) => { this.file = file; this.query = query; }; this.webContents.executeJavaScript = async (script, gesture) => { if (options.transparent) return { ready: true, width: options.width + (viewportChanges && this.shown ? 1 : 0), height: options.height }; this.boot = {script,gesture}; }; calls.windows.push(this); }
  }
  const ipcMain = { handle(name, fn) { this.handlers[name] = fn; }, handlers: {} };
  const screen = { getAllDisplays: () => [{ id: 7, bounds, workArea }] };
  const active = { phase: 'selecting' };
  const install = installVideoRecording({
    BrowserWindow, ipcMain, screen, session, platform,
    fitMask: async (win, nonce, target) => { calls.fit = { win, nonce, target }; },
    checkMask: async (win, nonce, target) => { calls.checks = (calls.checks || 0) + 1; if (physicalMismatch === true || physicalMismatch === calls.checks || (Array.isArray(physicalMismatch) && physicalMismatch.includes(calls.checks))) { const error = new Error('SECRET'); error.maskCheckReason = checkReason; throw error; } },
    recoverMask: async (win, nonce, target) => { calls.recoveries = (calls.recoveries || 0) + 1; calls.recovery = { win, nonce, target }; if (recoveryCancels) active.phase = 'selecting'; if (recoveryFails) throw new Error('SECRET'); },
    desktopCapturer: { getSources: async () => [{ id: 'screen:7:0', display_id: '7' }] },
    getOwnerWindow: () => ({hide() { calls.ownerHidden = true; }, show() { calls.ownerRestored = true; }, isVisible: () => !calls.ownerHidden}),
    getActive: () => active,
    allowed: () => true,
    cancel: reason => { calls.ended.push(reason); return true; },
    finishSession: () => { calls.ended.push('finished'); return true; },
    resolveSelection: async () => ({ display: { id: 7, bounds, scaleFactor }, displayPhysical: { x: bounds.x * scaleFactor, y: bounds.y * scaleFactor, width: bounds.width * scaleFactor, height: bounds.height * scaleFactor }, physical: { x: selection.x * scaleFactor, y: selection.y * scaleFactor, width: selection.width * scaleFactor, height: selection.height * scaleFactor }, dip: selection }),
    resolveSaveFolder: () => 'C:\\out',
    writeFile: async (file, bytes) => { calls.written.push({ file, size: bytes.length }); },
    showSaveDialog: async (_window, options) => { calls.dialog.push(options); return calls.cancelled ? { canceled: true } : { canceled: false, filePath: 'C:\\out\\v.webm' }; },
    onStatus: message => calls.status.push(message),
    onLifecycle: (event, fields) => calls.lifecycle.push({ event, fields }),
    freezeObserve,
  });
  return { calls, session, ipcMain, install, BrowserWindow };
}

test('开始录制：开一扇隐藏录制页和一扇选区外的指示条', async () => {
  const { calls, ipcMain, install, session } = harness();
  const result = await ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 }, systemAudio: false, microphone: false });
  assert.equal(result.started, true);
  assert.equal(calls.windows.length, 3);
  assert.deepEqual(session.partitions, [PARTITION], '录制页必须跑在专用分区里');
  assert.equal(calls.windows[0].options.show, false, '录制页必须隐藏，否则会被自己的录屏拍进去');
  assert.equal(calls.windows[1].options.alwaysOnTop, true);
  assert.equal(calls.windows[1].options.thickFrame, false, '不开 thickFrame，避免 DWM 在浮条四周再加一圈强调色边框');
  assert.equal(calls.windows[1].options.transparent, true, '透明窗，圆角由页面卡片自己画');
  assert.equal(calls.windows[1].options.backgroundColor, '#00000000', '窗口不铺底色');
  assert.match(calls.windows[0].file, /video-recorder\.html$/);
  assert.match(calls.windows[1].file, /video-indicator\.html$/);
  assert.equal(calls.windows[0].boot, undefined, '准备阶段不得自动开始');
  const indicator = calls.windows[1];
  assert.equal(await ipcMain.handlers['video:action']({ sender: indicator.webContents, senderFrame: indicator.webContents.mainFrame }, 'start'), true);
  assert.equal(calls.windows[0].boot.gesture, true);
  assert.equal(await ipcMain.handlers['video:action']({ sender: indicator.webContents, senderFrame: indicator.webContents.mainFrame }, 'start'), false);
  const recorder = calls.windows[0], event = { sender: recorder.webContents, senderFrame: recorder.webContents.mainFrame };
  const click = action => ipcMain.handlers['video:action']({ sender: indicator.webContents, senderFrame: indicator.webContents.mainFrame }, action);
  assert.equal(await click('pause'), false);
  assert.equal(ipcMain.handlers['video:state'](event, { state: 'recording' }), true);
  assert.equal(await click('pause'), true);
  assert.equal(recorder.messages.at(-1).channel, 'video:pause');
  ipcMain.handlers['video:state'](event, { state: 'paused' });
  assert.equal(indicator.messages.at(-1).payload.state, 'paused');
  assert.equal(await click('resume'), true);
  assert.equal(recorder.messages.at(-1).channel, 'video:resume');
  ipcMain.handlers['video:state'](event, { state: 'resumed' });
  assert.equal(await click('stop'), true);
  assert.equal(recorder.messages.at(-1).channel, 'video:stop');
  assert.equal(calls.ownerHidden, true);
  // 指示条不得压住选区。
  const spot = calls.windows[1].options;
  assert.equal(spot.x + spot.width <= 400 || spot.y + spot.height <= 200 || spot.x >= 1000 || spot.y >= 600, true);
  const mask = calls.windows[2];
  assert.equal(mask.ignoresMouse, true, '遮罩必须鼠标穿透');
  assert.equal(mask.options.transparent, true);
  assert.equal(mask.shown, true);
  assert.match(mask.file, /scroll-mask\.html$/);
  const layout = JSON.parse(mask.query.query.layout);
  assert.deepEqual(layout, { frame: { width: 1920, height: 1080 }, pixels: { x: 400, y: 200, width: 600, height: 400 } });
  assert.deepEqual(calls.fit.target, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(indicator.topmost, { flag: true, level: 'screen-saver' });
  install.dispose();
  assert.equal(mask.destroyed, true, '清理会销毁遮罩');
});

test('负坐标和200%缩放仍按目标屏整窗拟合，透明洞只包含选区及2 DIP余量', async () => {
  const bounds = { x: -1920, y: -100, width: 1920, height: 1080 };
  const selection = { x: -1520, y: 100, width: 600, height: 400 };
  const { calls, ipcMain, install } = harness({ selection, bounds, workArea: bounds, scaleFactor: 2 });
  await ipcMain.handlers['shot:video-begin']({}, { rect: selection });
  const mask = calls.windows[2], layout = JSON.parse(mask.query.query.layout);
  assert.deepEqual(calls.fit.target, { x: -3840, y: -200, width: 3840, height: 2160 });
  assert.deepEqual(layout.pixels, { x: 800, y: 400, width: 1200, height: 800 });
  assert.equal(calls.checks, 2);
  assert.equal(mask.ignoresMouse, true);
  install.dispose();
  assert.equal(mask.destroyed, true);
});

test('真实遮罩页面只留一个选区安全洞，其余四片完整覆盖', async () => {
  const { calls, ipcMain, install } = harness();
  await ipcMain.handlers['shot:video-begin']({}, { rect: { x: 400, y: 200, width: 600, height: 400 } });
  const mask = calls.windows[2];
  let children = [];
  const body = { replaceChildren: (...nodes) => { children = nodes; } };
  const context = { window: {}, document: { body, createElement: () => ({ style: {} }) },
    URLSearchParams, location: { search: '?layout=' + encodeURIComponent(mask.query.query.layout) },
    innerWidth: 1920, innerHeight: 1080, getComputedStyle: () => ({ position: 'fixed' }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'scroll-mask.js'), 'utf8'), context);
  assert.equal(context.window.regionMaskReady, true);
  const boxes = children.map(n => Object.fromEntries(Object.entries(n.style).map(([key, value]) => [key, parseInt(value, 10)])));
  assert.deepEqual(boxes, [
    { left: 0, top: 0, width: 1920, height: 199 },
    { left: 0, top: 601, width: 1920, height: 479 },
    { left: 0, top: 199, width: 399, height: 402 },
    { left: 1001, top: 199, width: 919, height: 402 },
  ]);
  install.dispose();
});

test('Electron DIP 报告不一致但物理验证通过时不误拒绝', async () => {
  const { calls, ipcMain, install } = harness({ clampMask: true });
  assert.equal((await ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 } })).started, true);
  assert.equal(calls.checks, 2);
  install.dispose();
});

test('物理边界不匹配时不显示并安全失败', async () => {
  const { calls, ipcMain } = harness({ physicalMismatch: true });
  await assert.rejects(() => ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 } }), /录制遮罩显示前物理校验失败/);
  assert.equal(calls.windows[2].shown, undefined);
  assert.ok(calls.windows.every(win => win.destroyed));
});

test('显示后物理尺寸变化时销毁遮罩并恢复选区', async () => {
  const { calls, ipcMain } = harness({ physicalMismatch: 2 });
  await assert.rejects(() => ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 } }), /录制遮罩显示后物理校验失败/);
  assert.equal(calls.windows[2].shown, true);
  assert.ok(calls.windows.every(win => win.destroyed));
  assert.equal(calls.ownerRestored, true);
});

test('显示前后物理校验的固定原因进入提示与生命周期，任意原因被拒绝', async () => {
  for (const [physicalMismatch, checkReason, phase, expected] of [
    [1, 'window-identity-mismatch', 'before-show', 'window-identity-mismatch'],
    [2, 'client-rect-mismatch', 'after-show', 'client-rect-mismatch'],
    [2, 'SECRET-PRIVATE', 'after-show', 'helper-failed'],
    [2, 'timeout-or-terminated', 'after-show', 'timeout-or-terminated'],
    [2, 'launch-failed', 'after-show', 'launch-failed'],
    [2, 'reply-invalid', 'after-show', 'reply-invalid'],
  ]) {
    const { calls, ipcMain } = harness({ physicalMismatch, checkReason });
    await assert.rejects(() => ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 } }), error => {
      assert.equal(error.message, `录制遮罩显示${phase === 'before-show' ? '前' : '后'}物理校验失败（${expected}）`);
      assert.doesNotMatch(error.message, /SECRET/);
      return true;
    });
    assert.deepEqual(calls.lifecycle.filter(item => item.event === 'video-mask-check-failed'), [{ event: 'video-mask-check-failed', fields: { phase, reason: expected } }]);
    assert.doesNotMatch(JSON.stringify(calls.lifecycle), /SECRET/);
    assert.ok(calls.windows.every(win => win.destroyed));
    assert.equal(calls.ownerRestored, true);
  }
});

test('仅显示后外框不符时恢复一次，重新物理校验及视口确认后才就绪', async () => {
  const { calls, ipcMain, install } = harness({ physicalMismatch: 2, checkReason: 'window-rect-mismatch' });
  assert.equal((await ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 } })).started, true);
  assert.equal(calls.recoveries, 1);
  assert.equal(calls.checks, 3);
  assert.equal(calls.recovery.win, calls.windows[2]);
  assert.equal(calls.recovery.nonce, calls.fit.nonce);
  assert.deepEqual(calls.recovery.target, calls.fit.target);
  assert.ok(calls.lifecycle.some(item => item.event === 'video-mask-check-failed' && item.fields.reason === 'window-rect-mismatch'));
  assert.ok(calls.lifecycle.some(item => item.event === 'video-mask-recovery' && item.fields.result === 'physical-verified'));
  assert.equal(calls.windows[0].boot, undefined, '校验完成前后均未自动开始录制');
  install.dispose();
});

test('恢复失败、恢复后再次不符或视口变化均失败且不重复恢复', async () => {
  for (const extra of [{ recoveryFails: true }, { physicalMismatch: [2, 3] }, { viewportChanges: true }]) {
    const { calls, ipcMain } = harness({ physicalMismatch: 2, checkReason: 'window-rect-mismatch', ...extra });
    await assert.rejects(() => ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 } }));
    assert.equal(calls.recoveries, 1);
    assert.ok(calls.windows.every(win => win.destroyed));
    assert.equal(calls.ownerRestored, true);
    assert.equal(calls.windows[0].boot, undefined);
  }
});

test('恢复期间选区会话失效不再继续物理检查或录制', async () => {
  const { calls, ipcMain } = harness({ physicalMismatch: 2, checkReason: 'window-rect-mismatch', recoveryCancels: true });
  await assert.rejects(() => ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 } }), /录制准备已取消/);
  assert.equal(calls.recoveries, 1);
  assert.equal(calls.checks, 2);
  assert.ok(calls.windows.every(win => win.destroyed));
  assert.equal(calls.windows[0].boot, undefined);
});

test('显示前外框不符及显示后其他原因绝不恢复', async () => {
  for (const [physicalMismatch, checkReason] of [[1, 'window-rect-mismatch'], [2, 'client-rect-mismatch'], [2, 'window-identity-mismatch'], [2, 'timeout-or-terminated']]) {
    const { calls, ipcMain } = harness({ physicalMismatch, checkReason });
    await assert.rejects(() => ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 } }));
    assert.equal(calls.recoveries, undefined);
    assert.ok(calls.windows.every(win => win.destroyed));
  }
});

test('选区占满工作区时：指示条停到任务栏那一条（工作区外、屏幕内）', async () => {
  const { calls, ipcMain } = harness({
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1032 },
    selection: { x: 0, y: 0, width: 1920, height: 1032 }
  });
  await ipcMain.handlers['shot:video-begin']({}, { rect: { x: 0, y: 0, width: 100, height: 100 } });
  const indicator = calls.windows[1];
  assert.ok(indicator, '应当建出录制窗与指示条');
  assert.equal(indicator.contentProtected, undefined, '不再依赖内容保护');
  assert.equal(indicator.options.height, 44, '扁条高度');
  assert.ok(indicator.options.y >= 1032, '落在工作区下方那条任务栏里');
  assert.ok(indicator.options.y + indicator.options.height <= 1080, '不能出屏');
});

test('显示器比指示条还小：明确拒绝，不开始录制', async () => {
  const { calls, ipcMain } = harness({
    bounds: { x: 0, y: 0, width: 400, height: 120 },
    workArea: { x: 0, y: 0, width: 400, height: 120 },
    selection: { x: 0, y: 0, width: 400, height: 120 }
  });
  await assert.rejects(() => ipcMain.handlers['shot:video-begin']({}, { rect: { x: 0, y: 0, width: 100, height: 100 } }), /指示条/);
  assert.equal(calls.windows.length, 0);
});

test('DEV 观测上报：只放行固定整数白名单，未开启时一律拒绝', async () => {
  const on = harness({ freezeObserve: true });
  await on.ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 }, microphone: false });
  const recorder = on.calls.windows[0], indicator = on.calls.windows[1];
  await on.ipcMain.handlers['video:action']({ sender: indicator.webContents, senderFrame: indicator.webContents.mainFrame }, 'start');
  const event = { sender: recorder.webContents, senderFrame: recorder.webContents.mainFrame };
  assert.equal(on.ipcMain.handlers['video:observe'](event, { windowMs: 4000, elapsedMs: 4001, sourceFrames: 12, sourceGapMs: 250, sourceSupported: 1, paintCount: 60, paintGapMs: 67, outputFrames: 3, outputGapMs: 900, outputSupported: 1 }), true);
  const rows = on.calls.lifecycle.filter(row => row.event === 'video-freeze-observe');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].fields, { windowMs: 4000, elapsedMs: 4001, sourceFrames: 12, sourceGapMs: 250, sourceSupported: 1, paintCount: 60, paintGapMs: 67, outputFrames: 3, outputGapMs: 900, outputSupported: 1 });
  // 同一轮第二次一律拒绝（每轮最多收一次）。
  assert.equal(on.ipcMain.handlers['video:observe'](event, { sourceFrames: 5 }), false);
  assert.equal(on.calls.lifecycle.filter(row => row.event === 'video-freeze-observe').length, 1);
  // 不是录制窗的身份一律拒绝。
  assert.equal(on.ipcMain.handlers['video:observe']({ sender: indicator.webContents, senderFrame: indicator.webContents.mainFrame }, { sourceFrames: 1 }), false);
  on.install.dispose();

  // 另一轮：多余字段、字符串、负数一律不进日志。
  const two = harness({ freezeObserve: true });
  await two.ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 }, microphone: false });
  const twoRecorder = two.calls.windows[0], twoIndicator = two.calls.windows[1];
  await two.ipcMain.handlers['video:action']({ sender: twoIndicator.webContents, senderFrame: twoIndicator.webContents.mainFrame }, 'start');
  assert.equal(two.ipcMain.handlers['video:observe']({ sender: twoRecorder.webContents, senderFrame: twoRecorder.webContents.mainFrame }, { sourceFrames: 5, evil: 'SECRET', path: 'C:\\SECRET', note: 'SECRET', outputFrames: -1 }), true);
  const twoRows = two.calls.lifecycle.filter(row => row.event === 'video-freeze-observe');
  assert.equal(twoRows.length, 1);
  assert.deepEqual(twoRows[0].fields, { sourceFrames: 5 });
  assert.doesNotMatch(JSON.stringify(two.calls.lifecycle), /SECRET/);
  two.install.dispose();

  const off = harness();
  await off.ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 }, microphone: false });
  const offRecorder = off.calls.windows[0], offIndicator = off.calls.windows[1];
  await off.ipcMain.handlers['video:action']({ sender: offIndicator.webContents, senderFrame: offIndicator.webContents.mainFrame }, 'start');
  assert.equal(off.ipcMain.handlers['video:observe']({ sender: offRecorder.webContents, senderFrame: offRecorder.webContents.mainFrame }, { sourceFrames: 1 }), false);
  assert.equal(off.calls.lifecycle.filter(row => row.event === 'video-freeze-observe').length, 0);
  off.install.dispose();
});

test('DEV 观测：可信开始时带上的配置必须带 observe，未开启时不带', async () => {
  const on = harness({ freezeObserve: true });
  await on.ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 }, microphone: false });
  const indicator = on.calls.windows[1];
  await on.ipcMain.handlers['video:action']({ sender: indicator.webContents, senderFrame: indicator.webContents.mainFrame }, 'start');
  const boot = on.calls.windows[0].boot;
  assert.ok(boot && typeof boot.script === 'string', '可信开始必须走 executeJavaScript');
  assert.equal(boot.gesture, true, '必须是可信手势');
  const payload = JSON.parse(boot.script.slice(boot.script.indexOf('(') + 1, boot.script.lastIndexOf(')')));
  assert.equal(payload.observe, true, '可信开始带上的配置必须有 observe，否则录制页不会开观测');
  on.install.dispose();

  const off = harness();
  await off.ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 }, microphone: false });
  const offIndicator = off.calls.windows[1];
  await off.ipcMain.handlers['video:action']({ sender: offIndicator.webContents, senderFrame: offIndicator.webContents.mainFrame }, 'start');
  const offBoot = off.calls.windows[0].boot;
  const offPayload = JSON.parse(offBoot.script.slice(offBoot.script.indexOf('(') + 1, offBoot.script.lastIndexOf(')')));
  assert.equal('observe' in offPayload, false, '默认路径不得带上 observe');
  off.install.dispose();
});

test('DEV 观测：每轮最多收一次，只在录制进行态收，数值必须是有界安全整数', async () => {
  const h = harness({ freezeObserve: true });
  await h.ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 }, microphone: false });
  const recorder = h.calls.windows[0], indicator = h.calls.windows[1];
  const event = { sender: recorder.webContents, senderFrame: recorder.webContents.mainFrame };
  // 还没开始（ready）不收。
  assert.equal(h.ipcMain.handlers['video:observe'](event, { sourceFrames: 1 }), false);
  await h.ipcMain.handlers['video:action']({ sender: indicator.webContents, senderFrame: indicator.webContents.mainFrame }, 'start');
  // 非安全整数、超界、浮点都丢。
  assert.equal(h.ipcMain.handlers['video:observe'](event, { sourceFrames: 1.5 }), false);
  assert.equal(h.ipcMain.handlers['video:observe'](event, { sourceFrames: Number.MAX_SAFE_INTEGER + 10 }), false);
  assert.equal(h.ipcMain.handlers['video:observe'](event, { sourceFrames: 10 ** 9 }), false);
  assert.equal(h.calls.lifecycle.filter(row => row.event === 'video-freeze-observe').length, 0);
  // 第一次收；同一轮第二次一律拒绝。
  assert.equal(h.ipcMain.handlers['video:observe'](event, { sourceFrames: 7 }), true);
  assert.equal(h.ipcMain.handlers['video:observe'](event, { sourceFrames: 8 }), false);
  const rows = h.calls.lifecycle.filter(row => row.event === 'video-freeze-observe');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].fields, { sourceFrames: 7 });
  h.install.dispose();
});

test('权限诊断只记录本轮固定类别，不改变无麦克风时的拒绝行为', async () => {
  const { calls, session, ipcMain, install } = harness();
  await ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 }, microphone: false });
  const recorder = calls.windows[0], indicator = calls.windows[1];
  await ipcMain.handlers['video:action']({ sender: indicator.webContents, senderFrame: indicator.webContents.mainFrame }, 'start');
  const result = [];
  session.handlers.permission(recorder.webContents, 'media', value => result.push(value), { isMainFrame: true, mediaTypes: [], requestingUrl: 'file://SECRET' });
  session.handlers.permission(recorder.webContents, 'media', value => result.push(value), { isMainFrame: true, mediaTypes: ['audio'], requestingUrl: 'file://SECRET' });
  session.handlers.permission({}, 'media', value => result.push(value), { isMainFrame: true, mediaTypes: [] });
  const checked = session.handlers.check(recorder.webContents, 'display-capture', 'file://SECRET', { isMainFrame: true, mediaTypes: ['SECRET'] });
  assert.deepEqual(result, [false, false, false]);
  assert.equal(checked, true, '保留现有 display-capture 判定');
  assert.deepEqual(calls.lifecycle.filter(row => row.event === 'video-permission-gate').map(row => row.fields), [
    { gate: 'request', permission: 'media', types: 'empty', allowed: false },
    { gate: 'request', permission: 'media', types: 'audio', allowed: false },
    { gate: 'check', permission: 'display-capture', types: 'other', allowed: true },
  ]);
  assert.doesNotMatch(JSON.stringify(calls.lifecycle), /SECRET/);
  install.dispose();
});

test('屏幕采集授权：只有本轮录制页自己拿得到', async () => {
  const { calls, session, ipcMain } = harness();
  await ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 } });
  const handler = session.handlers.display;
  const early = [];
  await handler({ frame: calls.windows[0].webContents.mainFrame, videoRequested: true, userGesture: true }, source => early.push(source));
  assert.deepEqual(early, [{}], '点击开始前不授权');
  const contents = calls.windows[0].webContents;
  assert.equal(session.handlers.check(contents, 'display-capture', 'file://', { isMainFrame: true }), false);
  await ipcMain.handlers['video:action']({ sender: calls.windows[1].webContents, senderFrame: calls.windows[1].webContents.mainFrame }, 'start');
  assert.ok(handler, '专用分区上必须装 displayMedia 请求处理');
  assert.equal(session.handlers.check(contents, 'display-capture', 'file://', { isMainFrame: true }), true);
  assert.equal(session.handlers.check(contents, 'display-capture', 'file://', {}), false);
  assert.equal(session.handlers.check(contents, 'display-capture', 'file://', { isMainFrame: false }), false);
  assert.equal(session.handlers.check(calls.windows[1].webContents, 'display-capture', 'file://', { isMainFrame: true }), false);
  assert.equal(session.handlers.check(contents, 'media', 'file://', { mediaType: 'audio' }), false);
  const permission = [];
  session.handlers.permission(contents, 'display-capture', ok => permission.push(ok), { isMainFrame: true });
  assert.deepEqual(permission, [true]);
  const recorder = calls.windows[0];
  const granted = [];
  await handler({ frame: recorder.webContents.mainFrame, videoRequested: true, userGesture: true, audioRequested: false }, source => granted.push(source));
  assert.equal(granted.length, 1);
  assert.equal(granted[0].video.display_id, '7');
  assert.equal(session.handlers.check(contents, 'display-capture', 'file://', { isMainFrame: true }), false);
  // 别的页面来要：不给。
  const denied = [];
  await handler({ frame: {}, videoRequested: true, userGesture: true, audioRequested: false }, source => denied.push(source));
  assert.deepEqual(denied, [{}], '不是本轮录制页的一律不给');
});

test('只有指示条主帧的首次开始可冻结严格布尔音源，忽略选区和其他窗口', async () => {
  for (const [systemAudio, microphone, expectedSystem, expectedMic] of [[false,false,false,false],[true,false,true,false],[false,true,false,true],[true,true,true,true],['true',1,false,false]]) {
    const {calls, ipcMain, install} = harness();
    await ipcMain.handlers['shot:video-begin']({}, {rect:{x:1,y:1,width:10,height:10},systemAudio:true,microphone:true});
    const recorder = calls.windows[0], indicator = calls.windows[1];
    const recEvent = {sender:recorder.webContents,senderFrame:recorder.webContents.mainFrame};
    const event = {sender:indicator.webContents,senderFrame:indicator.webContents.mainFrame};
    assert.throws(() => ipcMain.handlers['video:config'](recEvent), /尚未开始/);
    assert.equal(await ipcMain.handlers['video:action'](recEvent,'start',{systemAudio:true,microphone:true}),false);
    assert.equal(await ipcMain.handlers['video:action']({sender:indicator.webContents,senderFrame:{}},'start',{systemAudio:true,microphone:true}),false);
    assert.equal(recorder.boot,undefined);
    assert.equal(await ipcMain.handlers['video:action'](event,'start',{systemAudio,microphone}),true);
    const plan = ipcMain.handlers['video:config'](recEvent).plan;
    assert.equal(plan.wantSystem,expectedSystem); assert.equal(plan.wantMicrophone,expectedMic); assert.equal(plan.mix,expectedSystem && expectedMic);
    assert.equal(await ipcMain.handlers['video:action'](event,'start',{systemAudio:!expectedSystem,microphone:!expectedMic}),false);
    assert.equal(ipcMain.handlers['video:config'](recEvent).plan,plan);
    install.dispose();
  }
});

test('系统声音只有明确打开且在 Windows 上才给', async () => {
  const { calls, session, ipcMain } = harness({ platform: 'win32' });
  await ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 } });
  await ipcMain.handlers['video:action']({ sender: calls.windows[1].webContents, senderFrame: calls.windows[1].webContents.mainFrame }, 'start', {systemAudio: true});
  const recorder = calls.windows[0];
  const granted = [];
  await session.handlers.display({ frame: recorder.webContents.mainFrame, videoRequested: true, userGesture: true, audioRequested: true }, source => granted.push(source));
  assert.equal(granted[0].audio, 'loopback');
  // 非 Windows：不给回环。
  const other = harness({ platform: 'darwin' });
  await other.ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 } });
  await other.ipcMain.handlers['video:action']({ sender: other.calls.windows[1].webContents, senderFrame: other.calls.windows[1].webContents.mainFrame }, 'start', {systemAudio: true});
  const denied = [];
  await other.session.handlers.display({ frame: other.calls.windows[0].webContents.mainFrame, videoRequested: true, userGesture: true, audioRequested: true }, source => denied.push(source));
  assert.deepEqual(denied, [{}]);
});

test('屏幕空类型门限本轮主帧、精确文件、一次且在源授权之前', async () => {
  const { calls, session, ipcMain, install } = harness();
  await ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 } });
  const recorder = calls.windows[0], indicator = calls.windows[1], decisions = [];
  const request = (wc, details) => session.handlers.permission(wc, 'media', ok => decisions.push(ok), details);
  const trusted = { isMainFrame: true, requestingUrl: recorderURL, mediaTypes: [] };
  request(recorder.webContents, trusted); // not started
  await ipcMain.handlers['video:action']({ sender: indicator.webContents, senderFrame: indicator.webContents.mainFrame }, 'start');
  request({}, trusted);
  request(recorder.webContents, { ...trusted, isMainFrame: false });
  request(recorder.webContents, { ...trusted, isMainFrame: undefined });
  request(recorder.webContents, { ...trusted, requestingUrl: 'file://other' });
  request(recorder.webContents, { isMainFrame: true, requestingUrl: recorderURL });
  request(recorder.webContents, { ...trusted, mediaType: 'video' });
  request(recorder.webContents, { ...trusted, mediaTypes: ['video'] });
  request(recorder.webContents, trusted);
  request(recorder.webContents, trusted);
  assert.deepEqual(decisions, [false, false, false, false, false, false, false, false, true, false]);
  assert.equal(session.handlers.check(recorder.webContents, 'media', 'file://', { isMainFrame: true, mediaTypes: [] }), false, 'check 缺少设备类型不推测');
  const granted = [];
  await session.handlers.display({ frame: recorder.webContents.mainFrame, videoRequested: true, userGesture: true, audioRequested: false }, source => granted.push(source));
  assert.equal(granted[0].video.display_id, '7');
  request(recorder.webContents, trusted);
  request(recorder.webContents, { ...trusted, mediaTypes: ['audio'] });
  request(recorder.webContents, { ...trusted, mediaTypes: ['video'] });
  assert.deepEqual(decisions.slice(-3), [false, false, false], '屏幕授权后无麦克风选择时仍拒绝所有设备');
  install.dispose();
});

test('麦克风仅在屏幕源授权后按明确 audio 类型开放，不开放摄像头或含混类型', async () => {
  const { calls, session, ipcMain, install } = harness();
  await ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 } });
  const recorder = calls.windows[0], indicator = calls.windows[1], decisions = [];
  await ipcMain.handlers['video:action']({ sender: indicator.webContents, senderFrame: indicator.webContents.mainFrame }, 'start', {microphone: true});
  const audio = { isMainFrame: true, requestingUrl: recorderURL, mediaTypes: ['audio'] };
  const request = details => session.handlers.permission(recorder.webContents, 'media', ok => decisions.push(ok), details);
  request(audio); // source not yet granted
  await session.handlers.display({ frame: recorder.webContents.mainFrame, videoRequested: true, userGesture: true, audioRequested: false }, () => {});
  request(audio);
  request({ ...audio, mediaTypes: [] });
  request({ ...audio, mediaTypes: ['video'] });
  request({ ...audio, mediaTypes: ['audio', 'video'] });
  request({ isMainFrame: true, requestingUrl: recorderURL });
  request({ ...audio, isMainFrame: false });
  request({ ...audio, requestingUrl: 'file://other' });
  assert.deepEqual(decisions, [false, true, false, false, false, false, false, false]);
  assert.equal(session.handlers.check(recorder.webContents, 'media', 'file://', { isMainFrame: true, mediaType: 'audio' }), true);
  assert.equal(session.handlers.check(recorder.webContents, 'media', 'file://', { mediaType: 'audio' }), false);
  assert.equal(session.handlers.check(recorder.webContents, 'media', 'file://', { isMainFrame: true }), false);
  assert.equal(session.handlers.check(recorder.webContents, 'media', 'file://', { isMainFrame: true, mediaType: 'video' }), false);
  install.dispose();
});

test('保存：写本地文件，不进剪贴板也不上传', async () => {
  const { calls, ipcMain } = harness();
  await ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 } });
  const bytes = new Uint8Array(2048);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  bytes.set([0x1f, 0x43, 0xb6, 0x75], 40);
  const saved = await ipcMain.handlers['video:result']({ sender: calls.windows[0].webContents, senderFrame: calls.windows[0].webContents.mainFrame },
    { bytes, mimeType: 'video/webm', extension: 'webm' });
  assert.equal(saved.saved, true);
  assert.equal(calls.written.length, 1);
  assert.equal(calls.written[0].file, 'C:\\out\\v.webm');
});

test('编码中断但有有效数据时，保存对话框警告不完整', async () => {
  const { calls, ipcMain } = harness();
  await ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 } });
  const bytes = new Uint8Array(2048);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0); bytes.set([0x1f, 0x43, 0xb6, 0x75], 40);
  const saved = await ipcMain.handlers['video:result']({ sender: calls.windows[0].webContents, senderFrame: calls.windows[0].webContents.mainFrame },
    { bytes, mimeType: 'video/webm', extension: 'webm', encoderInterrupted: true });
  assert.equal(saved.saved, true); assert.match(calls.dialog[0].title, /编码中断/);
});

test('用户取消保存：产物留着可以重试，不静默丢掉', async () => {
  const { calls, ipcMain } = harness();
  await ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 } });
  calls.cancelled = true;
  const bytes = new Uint8Array(2048);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  bytes.set([0x1f, 0x43, 0xb6, 0x75], 40);
  const result = await ipcMain.handlers['video:result']({ sender: calls.windows[0].webContents, senderFrame: calls.windows[0].webContents.mainFrame },
    { bytes, mimeType: 'video/webm', extension: 'webm' });
  assert.equal(result.saved, false);
  assert.equal(result.canceled, true);
  assert.equal(calls.written.length, 0);
  // 产物还在：重试能存下来。
  calls.cancelled = false;
  const retry = await ipcMain.handlers['video:action']({ sender: calls.windows[1].webContents, senderFrame: calls.windows[1].webContents.mainFrame }, 'retry-save');
  assert.equal(retry.saved, true);
  assert.equal(calls.written.length, 1);
});

test('只有文件头的产物：明确拒绝，不当成录好的视频', async () => {
  const { calls, ipcMain } = harness();
  await ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 } });
  const bytes = new Uint8Array(64);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  await assert.rejects(() => ipcMain.handlers['video:result']({ sender: calls.windows[0].webContents, senderFrame: calls.windows[0].webContents.mainFrame },
    { bytes, mimeType: 'video/webm', extension: 'webm' }), /只有文件头/);
});

test('结束会话后：授权处理被拆掉，不再给别的页面发屏幕', async () => {
  const { calls, session, ipcMain } = harness();
  await ipcMain.handlers['shot:video-begin']({}, { rect: { x: 1, y: 1, width: 10, height: 10 } });
  ipcMain.handlers['video:action']({ sender: calls.windows[1].webContents, senderFrame: calls.windows[1].webContents.mainFrame }, 'cancel');
  assert.equal(session.handlers.display, null, '拆掉 displayMedia 请求处理');
  assert.equal(session.handlers.permission, null);
});
