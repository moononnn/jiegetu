'use strict';
// DEV 可见录制面（指示条兼任录制页）：假宿主下的身份、权限、失败收尾与编辑器别名用例。
// 不启动 Electron、不采集屏幕、不碰设备。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { installVideoRecording, PARTITION } = require(path.join(__dirname, '..', 'main', 'video-recording.cjs'));
const surfaceURL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'video-surface.html')).href;
const webmBytes = () => Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x1f, 0x43, 0xb6, 0x75, 1]);

function harness({ exportVideo, failEditorShow = false, observeShow } = {}) {
  const calls = { windows: [], status: [], ended: [], writes: [] };
  const handlers = { display: null, permission: null, check: null };
  const behavior = { failEditorShow, observeShow, deferSources: null };
  const session = {
    partitions: [],
    fromPartition(name) { session.partitions.push(name); return session; },
    setDisplayMediaRequestHandler(fn) { handlers.display = fn; },
    setPermissionRequestHandler(fn) { handlers.permission = fn; },
    setPermissionCheckHandler(fn) { handlers.check = fn; },
  };
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.messages = [];
      this.webContents = { mainFrame: {}, getURL: () => this.file ? pathToFileURL(this.file).href : '', send: (channel, payload) => this.messages.push({ channel, payload }), on() {}, setWindowOpenHandler() {} };
      this.isDestroyed = () => Boolean(this.destroyed);
      // 与真实 Electron 一致：destroy() 同步发 'closed'，专门用来盯“销毁自己触发收尾”的回归。
      this.destroy = () => {
        if (this.destroyed) return;
        this.destroyed = true;
        const onClosed = this.listeners?.closed;
        if (onClosed) onClosed();
      };
      this.on = (type, fn) => { (this.listeners ||= {})[type] = fn; };
      this.showInactive = () => { this.shown = true; };
      this.show = () => {
        if (behavior.failEditorShow && /video-editor\.html$/.test(this.file || '')) throw new Error('show blocked');
        this.shown = true;
        behavior.observeShow?.(this);
      };
      this.hide = () => { this.shown = false; };
      this.isVisible = () => Boolean(this.shown);
      this.setTitle = () => {};
      this.setIgnoreMouseEvents = flag => { this.ignoresMouse = flag; };
      this.setAlwaysOnTop = () => {}; this.setContentProtection = flag => { this.contentProtected = flag; };
      this.getBounds = () => ({ x: options.x, y: options.y, width: options.width, height: options.height });
      this.loadFile = async file => { this.file = file; };
      // 遮罩探针看脚本容，不看窗口是否透明：可见录制面现在自己也是透明窗了。
      this.webContents.executeJavaScript = async (script, gesture) => {
        if (script.includes('regionMaskReady')) return { ready: true, width: options.width, height: options.height };
        this.boot = { script, gesture };
      };
      calls.windows.push(this);
    }
  }
  const ipcMain = { handle(name, fn) { ipcMain.handlers[name] = fn; }, handlers: {} };
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const selection = { x: 400, y: 200, width: 600, height: 400 };
  const active = { phase: 'selecting' };
  const install = installVideoRecording({
    BrowserWindow, ipcMain, session, platform: 'win32',
    screen: { getAllDisplays: () => [{ id: 7, bounds, workArea: bounds }] },
    fitMask: async () => {}, checkMask: async () => {}, recoverMask: async () => {},
    desktopCapturer: { getSources: () => behavior.deferSources || Promise.resolve([{ id: 'screen:7:0', display_id: '7' }]) },
    getOwnerWindow: () => ({ hide() {}, show() {}, isVisible: () => false }),
    getActive: () => active, allowed: () => true,
    cancel: reason => { calls.ended.push(reason); return true; },
    finishSession: () => { calls.ended.push('finished'); return true; },
    resolveSelection: async () => ({ display: { id: 7, bounds, scaleFactor: 1 },
      displayPhysical: { ...bounds }, physical: { ...selection }, dip: { ...selection } }),
    resolveSaveFolder: () => 'C:\\out',
    writeFile: async (file, bytes) => { calls.writes.push({ file, size: bytes.length }); },
    showSaveDialog: async () => calls.cancelled ? { canceled: true } : { canceled: false, filePath: 'C:\\out\\v.webm' },
    onStatus: message => calls.status.push(message),
    onLifecycle: () => {},
    visibleRecorder: true, exportVideo,
  });
  const event = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  const begin = () => ipcMain.handlers['shot:video-begin']({}, { rect: selection });
  async function startRecording(surface) {
    assert.equal(await ipcMain.handlers['video:action'](event(surface), 'start', {}), true);
    ipcMain.handlers['video:state'](event(surface), { state: 'recording' });
  }
  return { calls, behavior, handlers, ipcMain, install, event, begin, startRecording };
}

test('可见录制面：只开一扇窗（兼任指示条）+ 遮罩，页面是 video-surface.html，先隐藏后显形', async () => {
  const h = harness();
  try {
    assert.equal((await h.begin()).started, true);
    assert.equal(h.calls.windows.length, 2, '可见面只开 1 扇窗 + 1 张遮罩');
    const surface = h.calls.windows[0];
    assert.match(surface.file, /video-surface\.html$/);
    assert.equal(surface.options.focusable, true, '指示条语义：可点击');
    assert.equal(surface.options.show, false, '建窗时先隐藏，等遮罩校验完再 showInactive');
    assert.equal(surface.options.thickFrame, false, '不开 thickFrame：不要 DWM 那圈强调色边框');
    assert.equal(surface.options.transparent, true, '透明窗，圆角由卡片 CSS 画');
    assert.equal(surface.options.backgroundColor, '#00000000', '窗口不铺底色，圆角外真透明');
    assert.equal(surface.shown, true, 'begin 返回时已显形');
    assert.equal(surface.options.webPreferences.partition, PARTITION);
    const current = h.install.current();
    assert.equal(current.recorder, surface);
    assert.equal(current.indicator, surface, '同一扇窗兼任两者');
    assert.equal(h.calls.windows[1].options.transparent, true, '内容遮罩仍在');
    assert.equal(h.calls.windows[1].ignoresMouse, true);
  } finally { h.install.dispose(); }
});

test('浮条样式：卡片自己画 10px 圆角、不带外框，窗口则是透明的', async () => {
  const css = await require('node:fs/promises').readFile(path.join(__dirname, '..', 'renderer', 'video-indicator.css'), 'utf8');
  const bar = /\.bar\{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(bar, /background:#f7faf6/, '卡片底色不变');
  assert.match(bar, /border-radius:10px/, '圆角由卡片自己画');
  assert.match(css, /html,body\{[^}]*background:transparent/, '根节点透明，四角才能透出桌面');
  assert.doesNotMatch(bar, /#b8d4c3/, '不要内层对比描边');
});

test('权限门只认可见面的精确文件与主帧，且必须先点开始', async () => {
  const h = harness();
  try {
    await h.begin();
    const surface = h.calls.windows[0];
    const stranger = h.calls.windows[1];
    const grant = payload => new Promise(resolve => h.handlers.display(payload, resolve));
    const frame = surface.webContents.mainFrame;
    assert.deepEqual(await grant({ frame, videoRequested: true, userGesture: true, audioRequested: false }), {}, '还没点开始就不给');
    await h.ipcMain.handlers['video:action'](h.event(surface), 'start', {});
    assert.equal(surface.boot.gesture, true, '开录带可信手势');
    assert.match(surface.boot.script, /startVideoRecording/);
    assert.deepEqual(await grant({ frame: stranger.webContents.mainFrame, videoRequested: true, userGesture: true }), {}, '别的窗口不给');
    assert.deepEqual(await grant({ frame, videoRequested: true, userGesture: false }), {}, '没有手势不给');
    assert.deepEqual(await grant({ frame, videoRequested: false, userGesture: true }), {}, '没要视频不给');
    const granted = await grant({ frame, videoRequested: true, userGesture: true, audioRequested: false });
    assert.ok(granted.video, '应带回屏幕源');
    assert.deepEqual(await grant({ frame, videoRequested: true, userGesture: true }), {}, '用过即废');
  } finally { h.install.dispose(); }
});

test('枚举是异步的：回来时身份/状态已变就不给屏幕', async () => {
  const h = harness();
  try {
    await h.begin();
    const surface = h.calls.windows[0];
    await h.ipcMain.handlers['video:action'](h.event(surface), 'start', {});
    let release;
    h.behavior.deferSources = new Promise(resolve => { release = resolve; });
    const answer = new Promise(resolve => h.handlers.display({ frame: surface.webContents.mainFrame, videoRequested: true, userGesture: true, audioRequested: false }, resolve));
    // 枚举还没回来，会话状态已经推进到 recording（等于“开始之后又变了”）。
    h.ipcMain.handlers['video:state'](h.event(surface), { state: 'recording' });
    release([{ id: 'screen:7:0', display_id: '7' }]);
    assert.deepEqual(await answer, {}, '异步枚举回来必须再核一次 starting/身份');
  } finally { h.install.dispose(); }
});

test('权限类型：只放行本轮空 mediaTypes 与授权后的纯音频，摄像头一律拒绝', async () => {
  const h = harness();
  try {
    await h.begin();
    const surface = h.calls.windows[0];
    const decide = details => new Promise(resolve => h.handlers.permission(surface.webContents, 'media', resolve, details));
    const check = details => h.handlers.check(surface.webContents, 'media', 'file://', details);
    await h.ipcMain.handlers['video:action'](h.event(surface), 'start', {});
    const base = { isMainFrame: true, requestingUrl: surfaceURL, mediaType: null };
    assert.equal(await decide({ ...base, mediaTypes: [] }), true, '第一次的空类型（屏幕）放行一次');
    assert.equal(await decide({ ...base, mediaTypes: [] }), false, '第二次不再放行');
    assert.equal(await decide({ ...base, mediaTypes: ['video'] }), false, '摄像头不放行');
    assert.equal(await decide({ ...base, mediaTypes: ['audio'] }), false, '没勾麦克风时纯音频也不放行');
    assert.equal(check({ ...base, mediaTypes: ['video'] }), false);
    assert.equal(await decide({ ...base, requestingUrl: 'file:///tmp/other.html', mediaTypes: [] }), false);
  } finally { h.install.dispose(); }
});

test('失败/超时：别名录制面同步收掉（不靠页面配合），选区恢复、状态可见', async () => {
  const h = harness();
  try {
    await h.begin();
    const surface = h.calls.windows[0];
    const mask = h.calls.windows[1];
    await h.startRecording(surface);
    // 与 video-start-timeout / power-lock / encoder failure 走同一个 fail()
    h.ipcMain.handlers['video:state'](h.event(surface), { state: 'failed', message: '录制没有在时限内开始' });
    assert.equal(surface.destroyed, true, '采集面必须同步销毁');
    assert.equal(mask.destroyed, true, '遮罩一起收掉');
    assert.equal(h.install.current(), null, '会话已结束');
    assert.ok(h.calls.ended.includes('video-failed'), '调用方拿到结束原因');
    assert.ok(h.calls.status.some(text => /时限内开始/.test(text)), '失败原因仍上报给状态栏');
  } finally { h.install.dispose(); }
});

test('finish 后打开编辑器：同步 closed 事件不得反触发 fail，编辑态存活且能保存原视频', async () => {
  const h = harness({ exportVideo: async () => ({ bytes: webmBytes(), extension: 'webm', mimeType: 'video/webm' }) });
  try {
    await h.begin();
    const surface = h.calls.windows[0];
    await h.startRecording(surface);
    const result = await h.ipcMain.handlers['video:result'](h.event(surface), { bytes: webmBytes(), extension: 'webm', mimeType: 'video/webm' });
    assert.equal(result.editing, true);
    // 关键：surface.destroy() 同步发 closed，不能把会话收掉。
    const current = h.install.current();
    assert.ok(current, '会话必须还在');
    assert.equal(current.videoState, 'editing', '仍在编辑态，而不是被视频-surface-closed 收尾');
    assert.equal(surface.destroyed, true);
    assert.deepEqual(h.calls.ended, [], '不应走到 capture-end / cancel');
    assert.ok(!h.calls.status.some(text => /录制窗口意外关闭/.test(text)), '不能报意外关闭');
    // 原片在编辑器手里：可以直接保存原视频。
    const editor = h.calls.windows.find(win => /video-editor\.html$/.test(win.file || ''));
    assert.ok(editor, '编辑器窗口存在');
    const saved = await h.ipcMain.handlers['video-editor:save-original']({ sender: editor.webContents, senderFrame: editor.webContents.mainFrame });
    assert.equal(saved.saved, true, '保存原视频成功');
    assert.equal(h.calls.writes.length, 1);
    assert.equal(h.calls.writes[0].size, webmBytes().length, '写的是原片字节');
    assert.equal(h.install.current(), null);
  } finally { h.install.dispose(); }
});

test('录制中录制面真的被关掉：仍走 fail→cleanup，并恢复选区', async () => {
  const h = harness();
  try {
    await h.begin();
    const surface = h.calls.windows[0];
    const mask = h.calls.windows[1];
    await h.startRecording(surface);
    surface.listeners.closed();
    assert.equal(surface.destroyed, true);
    assert.equal(mask.destroyed, true);
    assert.ok(h.calls.ended.includes('video-surface-closed'), '调用方拿到结束原因');
    assert.ok(h.calls.status.some(text => /录制窗口意外关闭/.test(text)));
    assert.equal(h.install.current(), null);
  } finally { h.install.dispose(); }
});

test('openEditor：编辑器先显形再拆采集面；显示失败时原视频仍可重试保存', async () => {
  const h = harness({ exportVideo: async () => ({ bytes: webmBytes(), extension: 'webm', mimeType: 'video/webm' }) });
  try {
    await h.begin();
    const surface = h.calls.windows[0];
    const mask = h.calls.windows[1];
    await h.startRecording(surface);
    let surfaceAliveWhenEditorShown = null;
    h.behavior.observeShow = win => {
      if (/video-editor\.html$/.test(win.file || '')) surfaceAliveWhenEditorShown = !surface.destroyed;
    };
    const result = await h.ipcMain.handlers['video:result'](h.event(surface), { bytes: webmBytes(), extension: 'webm', mimeType: 'video/webm' });
    assert.equal(result.editing, true);
    assert.equal(surfaceAliveWhenEditorShown, true, '编辑器显示时采集面还应活着（没有“先拆后显”的窗口期）');
    assert.equal(surface.destroyed, true);
    assert.equal(mask.destroyed, true);
    const current = h.install.current();
    assert.equal(current.videoState, 'editing');
    assert.equal(current.recorder, undefined);
    assert.equal(current.indicator, undefined, '别名一起清掉');
  } finally { h.install.dispose(); }
});

test('编辑器显示失败：不先拆采集面，直接回落到保存原视频', async () => {
  const h = harness({ exportVideo: async () => ({ bytes: webmBytes(), extension: 'webm', mimeType: 'video/webm' }), failEditorShow: true });
  try {
    await h.begin();
    const surface = h.calls.windows[0];
    await h.startRecording(surface);
    const result = await h.ipcMain.handlers['video:result'](h.event(surface), { bytes: webmBytes(), extension: 'webm', mimeType: 'video/webm' });
    assert.equal(result.editing, undefined, '没有进入编辑态');
    assert.equal(result.saved, true, '直接保存原视频');
    assert.equal(h.calls.writes.length, 1);
    assert.equal(h.install.current(), null);
  } finally { h.install.dispose(); }
});

test('编辑器显示失败且用户取消保存：采集面留着，可重试保存原视频', async () => {
  const h = harness({ exportVideo: async () => ({ bytes: webmBytes(), extension: 'webm', mimeType: 'video/webm' }), failEditorShow: true });
  try {
    await h.begin();
    const surface = h.calls.windows[0];
    await h.startRecording(surface);
    h.calls.cancelled = true;
    const result = await h.ipcMain.handlers['video:result'](h.event(surface), { bytes: webmBytes(), extension: 'webm', mimeType: 'video/webm' });
    assert.equal(result.canceled, true, '用户取消保存');
    const current = h.install.current();
    assert.ok(current, '会话仍在');
    assert.equal(current.videoState, 'unsaved');
    assert.ok(!surface.destroyed, '采集面保留，用户还能操作');
    assert.ok(surface.messages.some(item => item.payload?.state === 'unsaved'), '指示条回到“可重试保存”');
    h.calls.cancelled = false;
    assert.equal((await h.ipcMain.handlers['video:action'](h.event(surface), 'retry-save')).saved, true);
    assert.equal(h.calls.writes.length, 1, '重试保存写回原视频');
    assert.equal(h.install.current(), null);
  } finally { h.install.dispose(); }
});
