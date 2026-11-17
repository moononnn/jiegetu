'use strict';
// 剪贴板历史窗：sender/mainFrame/token 闸、参数透传、复制/粘贴交付、文件失效提示。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installClipboardWindow } = require('../main/clipboard-window.cjs');

function makeHarness({ store, service, settings } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  const instances = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.visible = false;
      this.events = new Map();
      this.mainFrame = { url: 'file://' };
      this.webContents = {
        mainFrame: this.mainFrame,
        send: () => {},
        on: () => {},
        once: () => {}
      };
      instances.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return false; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    restore() {}
    destroy() { this.destroyed = true; }
    removeMenu() {}
    loadFile() { return Promise.resolve(); }
    on(name, fn) { this.events.set(name, fn); }
    once(name, fn) { this.events.set(name, fn); }
  }
  const api = installClipboardWindow({
    BrowserWindow: FakeWindow,
    ipcMain,
    rendererFile: 'renderer/clipboard-history.html',
    preloadFile: 'main/clipboard-preload.cjs',
    iconFile: 'assets/app-icon.ico',
    theme: { bind: () => {} },
    nativeImage: undefined,
    store,
    service,
    settings,
    getPasteTarget: () => ({ hwnd: 777, pid: 4242 })
  });
  return { handlers, api, instances };
}

function senderEvent(window, { mainFrame = true } = {}) {
  return {
    sender: window.webContents,
    senderFrame: mainFrame ? window.webContents.mainFrame : { url: 'child' }
  };
}

const fakeStore = () => ({
  list: async payload => ({ rows: [{ id: 1, kind: 'text', preview: 'hi', tags: [], favorite: false, pinned: false, files: [], source: 'notepad', createdAt: 1, lastUsedAt: 2 }], total: 1, page: payload.page || 1, pages: 1, pageSize: 50 }),
  get: async id => ({ id, kind: 'files', files: [id === 3 ? 'C:\\gone.txt' : 'C:\\here.txt'], tags: [], note: '', favorite: false }),
  contentOf: async () => ({ parts: [{ format: 'text', bytes: Buffer.concat([Buffer.from('hi', 'utf16le'), Buffer.from([0, 0])]) }] }),
  readBlob: async () => Buffer.from('png'),
  setFavorite: async (id, value) => ({ id, favorite: value }),
  setNote: async (id, text) => ({ id, note: text }),
  setTags: async (id, tags) => ({ id, tags }),
  removeHistory: async id => ({ id }),
  stats: async () => ({ history: 1, blobs: 0, dbBytes: 0 }),
  cleanup: async ({ dryRun } = {}) => ({ count: dryRun ? 2 : 0, removed: dryRun ? 0 : 2 })
});
const fakeService = () => ({
  status: () => ({ phase: 'ready' }),
  publish: async () => ({ ok: true }),
  paste: async () => true,
  setExcludedApps: () => 0
});
const fakeSettings = clipboard => ({
  getClipboard: () => clipboard,
  updateClipboard: (patch, { strict } = {}) => ({ ...clipboard, ...patch })
});

test('错误 sender / 子 frame / 错 token 拒绝请求', async () => {
  const { handlers, api } = makeHarness({ store: fakeStore(), service: fakeService(), settings: fakeSettings({ enabled: true }) });
  const window = await api.show().then(() => api.getWindow());
  const token = api.token();
  // sender 不是这个窗口：直接拒绝。
  await assert.rejects(() => handlers.get('clip:list')({ sender: {}, senderFrame: {} }, { token }), /已失效/);
  // 子 frame：即使 sender 对，mainFrame 不对也拒绝。
  const child = senderEvent(window, { mainFrame: false });
  await assert.rejects(() => handlers.get('clip:list')(child, { token }), /已失效/);
  // token 不对。
  await assert.rejects(() => handlers.get('clip:list')(senderEvent(window), { token: 'wrong' }), /已失效/);
});

test('合法请求透传筛选与页码；copy 走真实发布路径', async () => {
  const published = [];
  const store = fakeStore();
  const service = { ...fakeService(), publish: async parts => published.push(parts) };
  const { handlers, api } = makeHarness({ store, service, settings: fakeSettings({ enabled: true }) });
  const window = await api.show().then(() => api.getWindow());
  const token = api.token();
  const list = await handlers.get('clip:list')(senderEvent(window), { token, query: '情况', kind: 'text', favorite: true, page: 3 });
  assert.equal(list.page, 3);
  assert.equal(list.total, 1);
  const copy = await handlers.get('clip:copy')(senderEvent(window), { token, id: 1 });
  assert.equal(copy.copied, true);
  assert.equal(published.length, 1);
  assert.equal(published[0][0].format, 'text');
});

test('定向粘贴：目标窗口在就交 helper；helper 说没接住就明说请手动粘贴', async () => {
  const store = fakeStore();
  const calls = [];
  const { handlers, api } = makeHarness({ store, service: {
    ...fakeService(), publish: async () => ({ ok: true }), paste: async target => { calls.push(target); return false; }
  }, settings: fakeSettings({ enabled: true }) });
  const window = await api.show().then(() => api.getWindow());
  const token = api.token();
  const result = await handlers.get('clip:paste')(senderEvent(window), { token, id: 1 });
  assert.equal(result.copied, true);
  assert.equal(result.pasted, false);
  assert.match(result.message, /Ctrl\+V/);
  assert.deepEqual(calls, [{ hwnd: 777, pid: 4242 }]);
});

test('文件条目：源文件不在了就返回 missingFiles，不假装附件可用', async () => {
  const fsNode = require('node:fs');
  const os = require('node:os');
  const pathNode = require('node:path');
  const here = pathNode.join(os.tmpdir(), `cg-exists-${process.pid}-${Date.now()}.txt`);
  fsNode.writeFileSync(here, 'x');
  const store = { ...fakeStore(),
    get: async id => ({ id, kind: 'files', files: [id === 3 ? 'C:\\gone.txt' : here], tags: [], note: '', favorite: false }) };
  try {
    const { handlers, api } = makeHarness({ store, service: fakeService(), settings: fakeSettings({ enabled: true }) });
    const window = await api.show().then(() => api.getWindow());
    const token = api.token();
    const gone = await handlers.get('clip:get')(senderEvent(window), { token, id: 3 });
    assert.deepEqual(gone.missingFiles, ['C:\\gone.txt']);
    const present = await handlers.get('clip:get')(senderEvent(window), { token, id: 4 });
    assert.deepEqual(present.missingFiles, [], '存在的文件不误报失效');
  } finally { try { fsNode.unlinkSync(here); } catch { /* 已删除。 */ } }
});

test('开关与暂停：只改持久设置，内存对象随请求更新', async () => {
  const clipboard = { enabled: false, paused: false, hotkey: 'Ctrl+Alt+V', retentionDays: 30, maxHistoryItems: 1000, maxStorageBytes: 2147483648, excludedApps: [] };
  let calls = 0;
  const { handlers, api } = makeHarness({ store: fakeStore(), service: fakeService(), settings: {
    getClipboard: () => clipboard,
    updateClipboard: patch => { calls++; return { ...clipboard, ...patch }; }
  } });
  const window = await api.show().then(() => api.getWindow());
  const token = api.token();
  const enabled = await handlers.get('clip:set-enabled')(senderEvent(window), { token, enabled: true });
  assert.equal(enabled.enabled, true);
  const paused = await handlers.get('clip:set-paused')(senderEvent(window), { token, paused: true });
  assert.equal(paused.paused, true);
  assert.equal(calls, 2);
});

test('清理预检与执行使用同一份设置；未确认前不删', async () => {
  const store = fakeStore();
  const { handlers, api } = makeHarness({ store, service: fakeService(), settings: fakeSettings({ enabled: true, retentionDays: 30, maxHistoryItems: 1000, maxStorageBytes: 2147483648 }) });
  const window = await api.show().then(() => api.getWindow());
  const token = api.token();
  const preview = await handlers.get('clip:cleanup-preview')(senderEvent(window), { token });
  assert.equal(preview.count, 2);
  const executed = await handlers.get('clip:cleanup')(senderEvent(window), { token });
  assert.equal(executed.removed, 2);
});

test('备注与标签只接收严格形状', async () => {
  const { handlers, api } = makeHarness({ store: fakeStore(), service: fakeService(), settings: fakeSettings({ enabled: true }) });
  const window = await api.show().then(() => api.getWindow());
  const token = api.token();
  await assert.rejects(() => handlers.get('clip:note')(senderEvent(window), { token, id: 1, text: 'x'.repeat(4001) }), /备注无效/);
  await assert.rejects(() => handlers.get('clip:tags')(senderEvent(window), { token, id: 1, tags: Array.from({ length: 21 }, () => 'a') }), /标签无效/);
});

test('关窗请求有回执：stay 不收起、hide 才收起；无回执超时安全收起；旧回执不误伤新请求', async () => {
  const h = makeHarness({ store: fakeStore(), service: fakeService(), settings: fakeSettings({ enabled: true }) });
  const shown = await h.api.show();
  const win = h.instances.at(-1);
  const sent = [];
  win.webContents.send = (channel, ...args) => { sent.push([channel, ...args]); };
  win.visible = true;
  const close = () => { let prevented = false; win.events.get('close')({ preventDefault() { prevented = true; } }); return prevented; };
  const ack = (id, action) => h.handlers.get('clip:close-ack')(senderEvent(win), { token: h.api.token(), id, action });

  assert.equal(close(), true, '关窗先拦下来问页面');
  const first = sent.find(item => item[0] === 'clip:close-request');
  assert.ok(first && Number.isInteger(first[1]), '要带请求号');
  const stay = await ack(first[1], 'stay');
  assert.equal(stay.applied, true);
  assert.equal(win.visible, true, 'stay：预览已关，窗口留着');

  // 列表状态：回执 hide 才收起
  close();
  const second = sent.filter(item => item[0] === 'clip:close-request').at(-1);
  assert.notEqual(second[1], first[1], '每次请求一个新号');
  await ack(second[1], 'hide');
  assert.equal(win.visible, false, 'hide 回执才收起窗口');

  // 旧回执不能把新请求当已处理
  win.visible = true;
  close();
  const third = sent.filter(item => item[0] === 'clip:close-request').at(-1);
  close();
  const fourth = sent.filter(item => item[0] === 'clip:close-request').at(-1);
  const stale = await ack(third[1], 'stay');
  assert.equal(stale.applied, false, '晚到的旧回执不算数');
  assert.equal(win.visible, true);
  await ack(fourth[1], 'stay');

  // 页面不回执：超时后安全收起，不把窗锁死
  win.visible = true;
  close();
  await new Promise(resolve => setTimeout(resolve, 420));
  assert.equal(win.visible, false, '没有回执要安全收起');
});

test('关窗请求被新呼出作废：旧超时与旧回执都不能把新窗口藏起来；dispose 清掉定时器', async () => {
  const h = makeHarness({ store: fakeStore(), service: fakeService(), settings: fakeSettings({ enabled: true }) });
  await h.api.show();
  const win = h.instances.at(-1);
  const sent = [];
  win.webContents.send = (channel, ...args) => { sent.push([channel, ...args]); };
  win.visible = true;
  const close = () => { let prevented = false; win.events.get('close')({ preventDefault() { prevented = true; } }); return prevented; };
  const ack = (id, action) => h.handlers.get('clip:close-ack')(senderEvent(win), { token: h.api.token(), id, action });

  close();
  const pendingId = sent.filter(item => item[0] === 'clip:close-request').at(-1)[1];
  // 320ms 内又被呼出：旧请求作废
  await h.api.show();
  win.visible = true;
  await new Promise(resolve => setTimeout(resolve, 420));
  assert.equal(win.visible, true, '旧超时不能把新呼出的窗口藏起来');
  const stale = await ack(pendingId, 'hide');
  assert.equal(stale.applied, false);
  assert.equal(win.visible, true, '旧回执也不能藏新窗口');

  // dispose 时把未完成的定时器清掉
  close();
  h.api.dispose();
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(win.destroyed, true, 'dispose 已销毁窗口');
});

for(const format of ['text','png','files']) test('复制成功后自动收起剪贴板：'+format,async()=>{
 const parts=[format==='files'?{format,paths:['C:\\example.txt']}:{format,bytes:Buffer.from(format==='text'?'hi':'data')}];let sent=0;
 const h=makeHarness({store:{...fakeStore(),contentOf:async()=>({parts})},service:{...fakeService(),publish:async value=>{assert.deepEqual(value,parts);sent++;}},settings:fakeSettings({enabled:true})});
 await h.api.show();const win=h.api.getWindow();assert.equal(win.visible,true);
 const result=await h.handlers.get('clip:copy')(senderEvent(win),{token:h.api.token(),id:1});
 assert.equal(result.copied,true);assert.equal(sent,1);assert.equal(win.visible,false);h.api.dispose();
});

test('复制失败保留剪贴板面板；非复制操作不收起',async()=>{
 const h=makeHarness({store:fakeStore(),service:{...fakeService(),publish:async()=>{throw new Error('发布失败');}},settings:fakeSettings({enabled:true})});
 await h.api.show();const win=h.api.getWindow();const payload={token:h.api.token(),id:1};
 await assert.rejects(()=>h.handlers.get('clip:copy')(senderEvent(win),payload),/发布失败/);assert.equal(win.visible,true);
 await h.handlers.get('clip:list')(senderEvent(win),{token:h.api.token()});assert.equal(win.visible,true);h.api.dispose();
});

test('在途复制成功不能藏掉重新呼出的剪贴板面板',async()=>{
 let finish;const h=makeHarness({store:fakeStore(),service:{...fakeService(),publish:()=>new Promise(resolve=>finish=resolve)},settings:fakeSettings({enabled:true})});
 await h.api.show();const win=h.api.getWindow();const pending=h.handlers.get('clip:copy')(senderEvent(win),{token:h.api.token(),id:1});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof finish,'function');h.api.hide();await h.api.show();finish();await pending;
 assert.equal(win.visible,true);h.api.dispose();
});
