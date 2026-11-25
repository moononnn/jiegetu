'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { installVideoRecording } = require('../main/video-recording.cjs');
const bytes = () => Uint8Array.from([0x1a,0x45,0xdf,0xa3,0x1f,0x43,0xb6,0x75,1]);
function setup(exportVideo, resolveVideoExporter, options = {}) {
  const windows = [], handlers = {}, writes = [], monitor = new EventEmitter();
  let cancelSave = false, confirm = 0;
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.visible = false; this.webContents = new EventEmitter(); this.webContents.mainFrame = {}; this.webContents.getURL = () => this.file ? pathToFileURL(this.file).href : ''; this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn; }; this.webContents.send = () => {}; this.webContents.executeJavaScript = async () => options.transparent ? { ready: true, width: options.width, height: options.height } : undefined; windows.push(this); }
    async loadFile(file) { this.file = file; }
    isDestroyed() { return !!this.destroyed; } destroy() { this.destroyed = true; this.emit('closed'); }
    showInactive() { this.visible = true; } show() { this.visible = true; } hide() { this.visible = false; this.emit('hide'); }
    isVisible() { return this.visible; } setTitle() {} setIgnoreMouseEvents() {} setAlwaysOnTop() {}
    removeMenu() { this.menuRemoved = true; }
  }
  const active = { phase: 'selecting' }, owner = { hide() {}, isVisible: () => false };
  const ses = { setDisplayMediaRequestHandler() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
  const api = installVideoRecording({ BrowserWindow: Window, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    screen: { getAllDisplays: () => [{ id: 1, bounds: { x:0,y:0,width:1920,height:1080 }, workArea: { x:0,y:0,width:1920,height:1080 } }] },
    session: { fromPartition: () => ses }, dialog: { showMessageBox: async () => ({ response: confirm }) }, powerMonitor: monitor,
    getActive: () => active, allowed: () => true, getOwnerWindow: () => owner, finishSession() {}, cancel() {},
    fitMask: async () => {}, checkMask: async () => {}, resolveSelection: async () => ({ display: { id:1, bounds: { x:0,y:0,width:1920,height:1080 }, scaleFactor: 1 }, physical: { x:400,y:200,width:600,height:400 }, dip: { x:400,y:200,width:600,height:400 } }),
    showSaveDialog: async () => cancelSave ? { canceled: true } : { filePath: 'C:\\out\\video.webm' }, writeFile: async (_path, data) => { if (options.writeError) throw options.writeError; writes.push(Uint8Array.from(data)); }, exportVideo, resolveVideoExporter, onLifecycle: options.onLifecycle });
  const event = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  async function start() {
    await handlers['shot:video-begin']({}, { rect: {} });
    await handlers['video:action'](event(windows[1]), 'start', {});
    handlers['video:state'](event(windows[0]), { state: 'recording' });
    return handlers['video:result'](event(windows[0]), { bytes: bytes(), extension: 'webm', mimeType: 'video/webm' });
  }
  return { handlers, windows, writes, api, monitor, event, start, setCancel: x => { cancelSave = x; }, setConfirm: x => { confirm = x; } };
}
const range = { durationMs: 10000, startMs: 1000, endMs: 9000, cutStartMs: 3000, cutEndMs: 4000 };

test('authenticated single load, frame denial and no export of renderer supplied bytes', async () => {
  const h = setup(async () => ({ bytes: bytes(), extension: 'webm', mimeType: 'video/webm' }));
  await h.start(); const editor = h.windows[3], e = h.event(editor);
  assert.equal(editor.options.webPreferences.sandbox, true); assert.equal(editor.options.webPreferences.nodeIntegration, false);
  assert.equal(editor.options.minWidth, 480); assert.equal(editor.options.minHeight, 520);
  assert.equal(editor.options.frame, false, '自绘标题栏：不要系统标题栏');
  assert.equal(editor.options.roundedCorners, true);
  assert.equal(editor.options.movable, true, '仍可拖动窗口');
  assert.equal(editor.options.autoHideMenuBar, true);
  assert.equal(editor.options.title, '截个图', '任务栏标题按用户要求');
  assert.match(String(editor.options.icon || ''), /assets[\\/]app-icon\.ico$/, '使用应用自己的图标');
  assert.equal(editor.listenerCount('page-title-updated'), 1, '不让页面 <title> 改掉窗口标题');
  assert.equal(editor.menuRemoved, true, '不保留系统菜单');
  assert.equal(h.windows[0].destroyed, true); assert.equal(h.windows[2].destroyed, true);
  assert.equal(editor.openHandler().action, 'deny');
  assert.throws(() => h.handlers['video-editor:load']({ sender: editor.webContents, senderFrame: {} }), /无效/);
  assert.throws(() => h.handlers['video-editor:load'](h.event(h.windows[1])), /无效/);
  assert.deepEqual(h.handlers['video-editor:load'](e).bytes, bytes());
  assert.throws(() => h.handlers['video-editor:load'](e), /已加载/);
  assert.equal((await h.handlers['video-editor:export'](e, { ...range, bytes: bytes() })).saved, false);
  assert.equal((await h.handlers['video-editor:export'](e, { ...range, ffmpegPath:'C:\\untrusted.exe' })).saved, false);
  assert.equal(h.writes.length, 0); h.api.dispose();
});

test('injected export receives copy and normalized half-open plan, then saves validated own bytes', async () => {
  let observed;
  const h = setup(async input => { observed = input; input.original.bytes[0] = 0; const out = bytes(); out[8] = 7; return { bytes: out, extension:'webm', mimeType:'video/webm' }; });
  await h.start(); const e = h.event(h.windows[3]);
  h.setCancel(true); const canceled = await h.handlers['video-editor:export'](e, range);
  assert.equal(canceled.canceled, true); assert.deepEqual(h.api.saved().bytes, bytes());
  assert.deepEqual(observed.plan.ranges, [{ startMs:1000,endMs:3000 },{ startMs:4000,endMs:9000 }]);
  assert.equal(observed.original.hasAudio, false); assert.ok(observed.signal instanceof AbortSignal);
  h.setCancel(false); assert.equal((await h.handlers['video-editor:export'](e, range)).saved, true);
  assert.equal(h.writes[0][8], 7); assert.equal(h.api.current(), null);
});

test('export failure, invalid output, close cancellation and no-op preserve original', async () => {
  let calls = 0; const h = setup(async () => { calls++; return { bytes: new Uint8Array([1]), extension:'webm', mimeType:'video/webm' }; });
  await h.start(); const e = h.event(h.windows[3]);
  assert.equal((await h.handlers['video-editor:export'](e, range)).saved, false);
  assert.deepEqual(h.api.saved().bytes, bytes());
  assert.equal((await h.handlers['video-editor:close'](e)).confirmationRequired, true);
  h.setCancel(true);
  assert.equal((await h.handlers['video-editor:export'](e, { durationMs: 10000, startMs: 0, endMs:10000 })).canceled, true);
  assert.equal(calls, 1); assert.deepEqual(h.api.saved().bytes, bytes());
  h.setCancel(false); assert.equal((await h.handlers['video-editor:save-original'](e)).saved, true);
  assert.deepEqual(h.writes[0], bytes());
});

test('after export fails the editor close button discards only after confirmation', async () => {
  const h = setup(async () => { throw new Error('export failed'); });
  await h.start(); const editor = h.windows[3], e = h.event(editor);
  assert.equal((await h.handlers['video-editor:export'](e, range)).saved, false);
  assert.equal((await h.handlers['video-editor:close'](e)).confirmationRequired, true);
  assert.equal(editor.isDestroyed(), false);
  assert.deepEqual(h.api.saved().bytes, bytes());
  assert.equal((await h.handlers['video-editor:close'](e,true)).canceled, false);
  assert.equal(editor.isDestroyed(), true);
  assert.equal(h.api.current(), null);
  assert.equal(h.api.saved(), null);
});

test('thrown exporter error and unexpected editor destruction keep original retryable', async () => {
  const h = setup(async () => { throw new Error('encoder failed'); });
  await h.start(); const editor = h.windows[3], e = h.event(editor);
  assert.equal((await h.handlers['video-editor:export'](e, range)).saved, false);
  editor.destroy();
  assert.deepEqual(h.api.saved().bytes, bytes());
  h.monitor.emit('lock-screen');
  assert.deepEqual(h.api.saved().bytes, bytes());
  assert.equal((await h.handlers['video:action'](h.event(h.windows[1]), 'retry-save')).saved, true);
  assert.deepEqual(h.writes[0], bytes());
});

test('trial resolver invalid or absent preserves immediate original save; valid opens editor', async () => {
  const invalid = setup(undefined, async () => null); assert.equal((await invalid.start()).saved,true);
  assert.equal(invalid.windows.length,3); assert.deepEqual(invalid.writes[0],bytes());
  const throws = setup(undefined, async () => { throw new Error('bad configuration'); }); assert.equal((await throws.start()).saved,true);
  const enabled = setup(undefined, async () => async () => ({ bytes:bytes(), extension:'webm', mimeType:'video/webm' }));
  assert.equal((await enabled.start()).editing,true); assert.equal(enabled.windows.length,4); enabled.api.dispose();
});

test('power interruption during trial validation keeps original for retry', async () => {
  let release, entered; const ready=new Promise(resolve=>{entered=resolve});
  const h=setup(undefined,()=>{entered();return new Promise(resolve=>{release=resolve})});
  const pending=h.start();await ready;h.monitor.emit('suspend');release(null);
  assert.equal((await pending).saved,false);assert.deepEqual(h.api.saved().bytes,bytes());
  assert.equal((await h.handlers['video:action'](h.event(h.windows[1]),'retry-save')).saved,true);
  assert.deepEqual(h.writes[0],bytes());
});

test('cleanup failure is visible and original remains saveable', async () => {
  const h=setup(async()=>{const error=new Error('cleanup');error.code='TRIAL_CLEANUP_FAILED';throw error});
  await h.start();const e=h.event(h.windows[3]);
  assert.match((await h.handlers['video-editor:export'](e,range)).message,/临时文件/);
  assert.deepEqual(h.api.saved().bytes,bytes());
  assert.equal((await h.handlers['video-editor:save-original'](e)).saved,true);
});

test('power aborts export without losing original; missing exporter saves immediately', async () => {
  let unblock; const h = setup(input => new Promise(resolve => { unblock = () => resolve({ bytes: bytes(), extension:'webm', mimeType:'video/webm' }); input.signal.addEventListener('abort', unblock); }));
  await h.start(); const e = h.event(h.windows[3]);
  const pending = h.handlers['video-editor:export'](e, range); h.monitor.emit('suspend');
  assert.equal((await pending).saved, false); assert.deepEqual(h.api.saved().bytes, bytes()); h.api.dispose();
  const legacy = setup(undefined); assert.equal((await legacy.start()).saved, true);
  assert.equal(legacy.windows.length, 3); assert.deepEqual(legacy.writes[0], bytes());
});

test('多段删除：cuts 数组直接进导出计划，重叠/相邻先合并', async () => {
  let seen;
  const h = setup(async request => { seen = request; return { bytes: bytes(), extension: 'webm', mimeType: 'video/webm' }; });
  try {
    await h.start(); const e = h.event(h.windows[3]);
    const result = await h.handlers['video-editor:export'](e, { durationMs: 10000, startMs: 1000, endMs: 9000,
      cuts: [{ startMs: 4000, endMs: 4500 }, { startMs: 2500, endMs: 3000 }, { startMs: 4300, endMs: 5000 }] });
    assert.equal(result.saved, true);
    assert.deepEqual(seen.plan.ranges, [{ startMs: 1000, endMs: 2500 }, { startMs: 3000, endMs: 4000 }, { startMs: 5000, endMs: 9000 }]);
    assert.equal(seen.plan.totalMs, 1500 + 1000 + 4000);
  } finally { h.api.dispose(); }
});

test('非法剪辑计划：混用/超过 24 段/删空/未知字段都给固定代码与中文原因，原片不动', async () => {
  const h = setup(async () => ({ bytes: bytes(), extension: 'webm', mimeType: 'video/webm' }));
  try {
    await h.start(); const e = h.event(h.windows[3]);
    const send = extra => h.handlers['video-editor:export'](e, { durationMs: 10000, startMs: 1000, endMs: 9000, ...extra });
    const mixed = await send({ cutStartMs: 3000, cutEndMs: 4000, cuts: [] });
    assert.equal(mixed.code, 'timeline-invalid');
    assert.ok(mixed.message && !/[\\/]/.test(mixed.message), '消息里不能带路径');
    const halfLegacy = await send({ cutStartMs: 3000 });
    assert.equal(halfLegacy.code, 'timeline-invalid');
    const tooMany = await send({ cuts: Array.from({ length: 25 }, (_, i) => ({ startMs: 1100 + i * 100, endMs: 1150 + i * 100 })) });
    assert.equal(tooMany.code, 'timeline-too-many-cuts');
    const empty = await send({ cuts: [{ startMs: 1000, endMs: 9000 }] });
    assert.equal(empty.code, 'timeline-too-short');
    const unknown = await send({ extra: 1 });
    assert.equal(unknown.code, 'timeline-invalid');
    assert.deepEqual(h.api.saved().bytes, bytes());
    assert.equal(h.writes.length, 0);
  } finally { h.api.dispose(); }
});

test('导出器错误映射成固定代码，未知错误兜底 export-failed', async () => {
  for (const [raw, expected] of [['export-audio', 'export-audio'], ['export-timing', 'export-timing'], ['export-tool', 'export-tool'], ['export-encoder', 'export-encoder'], ['WEIRD', 'export-failed'], ['TRIAL_CLEANUP_FAILED', 'export-cleanup']]) {
    const h = setup(async () => { const error = new Error('内部细节'); error.code = raw; throw error; });
    try {
      await h.start(); const e = h.event(h.windows[3]);
      const result = await h.handlers['video-editor:export'](e, { durationMs: 10000, startMs: 1000, endMs: 9000, cuts: [] });
      assert.equal(result.code, expected, raw);
      assert.equal(result.saved, false);
      assert.ok(result.message.length > 0);
      assert.deepEqual(h.api.saved().bytes, bytes());
    } finally { h.api.dispose(); }
  }
});

test('保存失败：同名文件给 disk-exists，写入失败给 disk-write', async () => {
  for (const [code, expected] of [['EEXIST', 'disk-exists'], ['EACCES', 'disk-write']]) {
    const error = new Error('raw');
    error.code = code;
    const h = setup(async () => ({ bytes: bytes(), extension: 'webm', mimeType: 'video/webm' }), undefined, { writeError: error });
    try {
      await h.start(); const e = h.event(h.windows[3]);
      const result = await h.handlers['video-editor:save-original'](e);
      assert.equal(result.saved, false);
      assert.equal(result.code, expected);
      assert.deepEqual(h.api.saved().bytes, bytes(), '原片仍在');
    } finally { h.api.dispose(); }
  }
});

test('时间轴导出失败：固定总码+白名单子码+粗粒度数值指标，不泄露原始报错或路径', async () => {
  const plan = { durationMs: 10000, startMs: 1000, endMs: 9000, cuts: [] };
  const make = (code, subcode, metrics, lifecycle) => setup(async () => {
    const error = new Error('内部细节 C:\\secret\\a.mp4'); error.code = code; error.subcode = subcode; error.metrics = metrics; throw error;
  }, undefined, { onLifecycle: (event, fields) => lifecycle.push({ event, fields }) });

  const lifecycle = [];
  const h = make('export-timing', 'video-gap-large', { video: 1, gapMs: 123 }, lifecycle);
  await h.start();
  const r = await h.handlers['video-editor:export'](h.event(h.windows[3]), plan);
  assert.equal(r.saved, false);
  assert.equal(r.code, 'export-timing');
  assert.equal(r.subcode, 'video-gap-large');
  assert.deepEqual(r.metrics, { video: 1, gapMs: 123 });
  assert.ok(r.message.length > 0 && !/[\\/]/.test(r.message), '消息不带路径');
  assert.ok(!r.message.includes('内部细节'), '不泄露原始报错');
  const note = lifecycle.find(x => x.event === 'video-export-failed');
  assert.equal(note.fields.code, 'export-timing');
  assert.equal(note.fields.subcode, 'video-gap-large');
  assert.deepEqual(note.fields.metrics, { video: 1, gapMs: 123 });
  assert.deepEqual(h.api.saved().bytes, bytes(), '原片仍在');
  h.api.dispose();

  const life2 = [];
  const h2 = make('export-audio', 'evil', { path: 'C:\\secret', gapMs: 5 }, life2);
  await h2.start();
  const r2 = await h2.handlers['video-editor:export'](h2.event(h2.windows[3]), plan);
  assert.equal(r2.code, 'export-audio');
  assert.equal(r2.subcode, undefined, '非白名单子码不放行');
  assert.equal(r2.metrics, undefined);
  h2.api.dispose();

  const life3 = [];
  const h3 = make('export-audio', 'audio-frame-drift-cumulative', { overlapCount: 497, rate: 48000, path: 'C:\\secret', stderr: 'raw' }, life3);
  await h3.start();
  const r3 = await h3.handlers['video-editor:export'](h3.event(h3.windows[3]), plan);
  assert.equal(r3.subcode, 'audio-frame-drift-cumulative');
  assert.deepEqual(r3.metrics, { overlapCount: 497, rate: 48000 }, '私有/非数值指标被净化');
  assert.ok(!JSON.stringify(r3).includes('secret'));
  assert.ok(!JSON.stringify(r3).includes('raw'));
  h3.api.dispose();
});
