'use strict';
// 自绘托盘快捷菜单（main/tray-menu.cjs）与 preload（main/tray-menu-preload.cjs）的定向用例。
// 全部用替身：不启动 Electron、不建真实窗口、不读写用户文件、不碰真实托盘/快捷键。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const { createTrayMenu, placeTrayMenu, MENU_SIZE, MENU_COMPACT_HEIGHT, ACTIONS } = require('../main/tray-menu.cjs');

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const BOTTOM_TRAY = { x: 1840, y: 1046, width: 32, height: 32 };
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({ workArea = WORK_AREA, cursor = { x: 100, y: 100 }, theme, onAction, onError, stateFail = false } = {}) {
  const handlers = new Map();
  const removed = [];
  const windows = [];
  const bound = [];
  const errors = [];
  const actions = [];
  const state = { hotkeyLabel: 'F1', hotkeyRegistered: true, canFinishScroll: false, hasLastFile: false };
  const flags = { stateFail };

  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.visible = false;
      this.shows = 0;
      this.focuses = 0;
      this.loads = [];
      this.sent = [];
      this.backgrounds = [];
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { id: `main-${windows.length + 1}` };
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      this.webContents.send = (channel, payload) => this.sent.push({ channel, payload });
      windows.push(this);
    }
    loadFile(file) {
      this.loads.push(file);
      return new Promise((resolve, reject) => { this.resolveLoad = () => resolve(); this.rejectLoad = reject; });
    }
    setBackgroundColor(color) { this.backgrounds.push(color); }
    show() { this.visible = true; this.shows += 1; }
    hide() { this.visible = false; this.hides = (this.hides || 0) + 1; }
    setBounds(next) { this.bounds = next; this.boundsCalls = (this.boundsCalls || 0) + 1; }
    focus() { this.focuses += 1; }
    isVisible() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.visible = false;
      this.emit('closed');
    }
  }

  const menu = createTrayMenu({
    BrowserWindow: Window,
    screen: {
      getCursorScreenPoint: () => ({ ...cursor }),
      getDisplayNearestPoint: () => ({ workArea: { ...workArea } })
    },
    ipcMain: {
      handle: (name, fn) => handlers.set(name, fn),
      removeHandler: name => { removed.push(name); handlers.delete(name); }
    },
    theme: theme === undefined
      ? { bind: win => { bound.push(win); win.setBackgroundColor('#17231f'); return () => {}; } }
      : theme,
    rendererFile: 'renderer/tray-menu.html',
    preloadFile: 'main/tray-menu-preload.cjs',
    iconFile: path.join(__dirname, '../assets/app-icon.ico'),
    getState: () => {
      if (flags.stateFail) throw new Error('state broken');
      return { ...state, file: 'C:/secret/last.png' };
    },
    onAction: async action => { actions.push(action); return onAction ? onAction(action) : { ok: true }; },
    onError: error => { errors.push(error); onError?.(error); }
  });

  const eventFor = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  const call = (channel, win, ...args) => handlers.get(channel)(eventFor(win), ...args);
  return { menu, handlers, removed, windows, bound, errors, actions, state, flags, eventFor, call,
    lastWin: () => windows.at(-1) };
}

async function openReady(h, bounds = BOTTOM_TRAY) {
  assert.equal(h.menu.toggle(bounds), true);
  const win = h.lastWin();
  win.resolveLoad();
  await tick();
  assert.equal(win.visible, false, '载完但未报到 ready 前不显示');
  await h.call('tray-menu:ready', win);
  assert.equal(win.visible, true);
  return win;
}

test('创建模块不建窗：先注册固定 IPC，refresh 也不会顺手创建', () => {
  const h = harness();
  assert.equal(h.windows.length, 0);
  assert.deepEqual([...h.handlers.keys()].sort(),
    ['tray-menu:action', 'tray-menu:dismiss', 'tray-menu:ready', 'tray-menu:state']);
  assert.equal(h.menu.refresh(), false);
  assert.equal(h.windows.length, 0);
  h.menu.dispose();
});

test('窗口按托盘位置懒建：无边框/不任务栏/置顶非 modal/不可 resize，show:false 起步', () => {
  const h = harness();
  h.menu.toggle(BOTTOM_TRAY);
  const win = h.lastWin();
  const o = win.options;
  assert.equal(o.show, false);
  assert.equal(o.frame, false);
  assert.equal(o.skipTaskbar, true);
  assert.equal(o.alwaysOnTop, true);
  assert.equal(o.modal, false);
  assert.equal(o.resizable, false);
  assert.equal(o.focusable, true);
  assert.equal(o.width, MENU_SIZE.width);
  assert.equal(o.height, MENU_COMPACT_HEIGHT);
  assert.equal(o.x, 1576);
  assert.equal(o.y, 692);
  assert.equal(o.webPreferences.nodeIntegration, false);
  assert.equal(o.webPreferences.contextIsolation, true);
  assert.equal(o.webPreferences.sandbox, true);
  assert.equal(o.webPreferences.preload, 'main/tray-menu-preload.cjs');
  assert.deepEqual(win.loads, ['renderer/tray-menu.html']);
  assert.deepEqual(win.openHandler(), { action: 'deny' });
  h.menu.dispose();
});

test('主题在 load/show 之前绑定一次：不新增快捷键，也不等显示后再补背景', () => {
  const seen = [];
  const theme = { bind: win => { seen.push({ visible: win.visible, loads: win.loads.length }); win.setBackgroundColor('#17231f'); } };
  const h = harness({ theme });
  h.menu.toggle(BOTTOM_TRAY);
  assert.deepEqual(seen, [{ visible: false, loads: 0 }]);
  assert.equal(h.bound.length, 0, '不绕过注入的 theme');
  assert.equal(h.windows[0].backgrounds[0], '#17231f');
  assert.equal(h.windows[0].options.webPreferences.globalShortcut, undefined);
  h.menu.dispose();
});

test('theme.bind 抛错只记录，不影响菜单加载与显示', async () => {
  const h = harness({ theme: { bind: () => { throw new Error('theme down'); } } });
  const win = await openReady(h);
  assert.equal(win.visible, true);
  assert.equal(h.errors.length, 1);
  h.menu.dispose();
});

test('ready 前不显示；ready 后显示并拿焦点', async () => {
  const h = harness();
  const win = await openReady(h);
  assert.equal(win.shows, 1);
  assert.equal(win.focuses, 1);
  h.menu.dispose();
});

test('state 只回七个有限字段：不外带文件路径', async () => {
  const h = harness();
  const win = await openReady(h);
  const state = await h.call('tray-menu:state', win);
  assert.deepEqual(Object.keys(state).sort(),
    ['canFinishScroll', 'clipboardEnabled', 'clipboardHotkey', 'clipboardPaused', 'hasLastFile', 'hotkeyLabel', 'hotkeyRegistered']);
  assert.equal(state.file, undefined);
  assert.equal(state.hotkeyLabel, 'F1');
  assert.equal(state.clipboardHotkey, '', '没有剪贴板快捷键时给空串，页面自己显示未设');
  assert.equal(state.clipboardEnabled, false);
  h.menu.dispose();
});

test('state 保留剪贴板三项并收敛类型：非字符串/非布尔一律安全回退', async () => {
  const h = harness();
  h.state.clipboardHotkey = '  Ctrl + Alt + V  ';
  h.state.clipboardEnabled = true;
  h.state.clipboardPaused = 'yes';
  const win = await openReady(h);
  const state = await h.call('tray-menu:state', win);
  assert.equal(state.clipboardHotkey, 'Ctrl + Alt + V');
  assert.equal(state.clipboardEnabled, true);
  assert.equal(state.clipboardPaused, false, '只有严格的 true 才算暂停');
  h.state.clipboardHotkey = 42;
  h.state.clipboardEnabled = 1;
  const next = await h.call('tray-menu:state', win);
  assert.equal(next.clipboardHotkey, '', '非字符串不回显');
  assert.equal(next.clipboardEnabled, false, '非布尔不冒充开启');
  h.menu.dispose();
});

test('托盘剪贴板动作可派发：白名单包含 clipboard，未知动作仍然拒绝', async () => {
  const h = harness();
  const win = await openReady(h);
  assert.equal(ACTIONS.includes('clipboard'), true);
  const reply = await h.call('tray-menu:action', win, 'clipboard');
  assert.deepEqual(reply, { ok: true, action: 'clipboard' });
  assert.deepEqual(h.actions, ['clipboard']);
  assert.equal(win.visible, false, '派发后菜单收起');
  // 收起后重新右键：复用同一扇窗，不得多开一扇。
  assert.equal(h.menu.toggle(BOTTOM_TRAY), true);
  const win2 = h.lastWin();
  assert.equal(win2, win);
  assert.equal(h.windows.length, 1);
  await assert.rejects(async () => h.call('tray-menu:action', win2, 'open-secret'), /未知的菜单动作/);
  h.menu.dispose();
});

test('refresh 只发给已 ready 的现存窗口，并保持一个窗口', async () => {
  const h = harness();
  h.menu.toggle(BOTTOM_TRAY);
  const win = h.lastWin();
  win.resolveLoad();
  await tick();
  assert.equal(h.menu.refresh(), false, '已载入但还没 ready 时不发');
  assert.equal(win.sent.length, 0);
  await h.call('tray-menu:ready', win);
  h.state.hotkeyLabel = 'Ctrl + Shift + S';
  h.state.canFinishScroll = true;
  assert.equal(h.menu.refresh(), true);
  assert.equal(h.windows.length, 1, 'refresh 绝不创建窗口');
  assert.deepEqual(win.sent.at(-1), {
    channel: 'tray-menu:state',
    payload: { hotkeyLabel: 'Ctrl + Shift + S', hotkeyRegistered: true, canFinishScroll: true, hasLastFile: false,
      clipboardHotkey: '', clipboardEnabled: false, clipboardPaused: false }
  });
  h.menu.dispose();
});

test('载页中再点一次 toggle 是取消：同一 owner 销毁，迟到 load 不能显示', async () => {
  const h = harness();
  h.menu.toggle(BOTTOM_TRAY);
  const win = h.lastWin();
  assert.equal(h.menu.toggle(BOTTOM_TRAY), false, '第二次 toggle 收起而不是再开一扇');
  assert.equal(win.destroyed, true);
  win.resolveLoad();
  await tick();
  assert.equal(win.visible, false);
  assert.equal(h.windows.length, 1);
  await assert.rejects(async () => h.call('tray-menu:state', win), /未授权/);
  h.menu.dispose();
});

test('旧 load 迟到不能 show 新窗：只认当前 owner', async () => {
  const h = harness();
  h.menu.toggle(BOTTOM_TRAY);
  const oldWin = h.lastWin();
  h.menu.toggle(BOTTOM_TRAY);       // 取消第一扇
  h.menu.toggle(BOTTOM_TRAY);       // 开第二扇
  const newWin = h.lastWin();
  assert.notEqual(oldWin, newWin);
  oldWin.resolveLoad();
  await tick();
  assert.equal(oldWin.visible, false);
  assert.equal(newWin.visible, false);
  await assert.rejects(async () => h.call('tray-menu:ready', oldWin), /未授权/);
  newWin.resolveLoad();
  await tick();
  await h.call('tray-menu:ready', newWin);
  assert.equal(newWin.visible, true);
  assert.equal(oldWin.visible, false);
  h.menu.dispose();
});

test('失焦只隐藏保留，渲染进程退出与外部 closed 才回收；之后可重开', async () => {
  const h = harness();
  let win = await openReady(h);
  win.emit('blur');
  assert.equal(win.visible, false, '失焦先收起');
  assert.equal(win.destroyed, false, '失焦不再销毁：留给下一次右键复用');
  assert.equal(h.menu.toggle(BOTTOM_TRAY), true, '同一个 owner 可以重新打开');
  assert.equal(h.lastWin(), win);
  assert.equal(win.visible, true);

  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(win.destroyed, true);
  assert.match(h.errors.at(-1).message, /渲染进程/);

  win = await openReady(h);
  win.destroy();
  assert.equal(h.menu.refresh(), false);
  win = await openReady(h);
  assert.equal(win.visible, true);
  h.menu.dispose();
});

test('收起后复用同一扇窗：重算位置与高度，先推 state 再发 reopen', async () => {
  const h = harness();
  const win = await openReady(h);
  assert.equal(win.shows, 1);
  assert.equal(h.menu.toggle(BOTTOM_TRAY), false, '点第二次是收起');
  assert.equal(win.visible, false);
  assert.equal(win.hides, 1);

  h.state.canFinishScroll = true;
  assert.equal(h.menu.toggle(BOTTOM_TRAY), true, '再点一次重开');
  assert.equal(h.windows.length, 1, '不新建窗口');
  assert.equal(win.shows, 2);
  assert.deepEqual(win.bounds, { x: 1576, y: 668, width: 296, height: 372 }, '按钮变高：按有长截图那一档重新摆');
  const channels = win.sent.slice(-2).map(entry => entry.channel);
  assert.deepEqual(channels, ['tray-menu:state', 'tray-menu:reopen']);
  assert.equal(win.sent.at(-1).payload.canFinishScroll, true, 'reopen 带的就是刚算好的现态');

  h.state.canFinishScroll = false;
  h.menu.toggle(BOTTOM_TRAY);
  h.menu.toggle(BOTTOM_TRAY);
  assert.deepEqual(win.bounds, { x: 1576, y: 692, width: 296, height: 348 }, '没有那行时用矮的一档');
  h.menu.dispose();
});

test('保留有上限：空闲超时真销毁，重开则重新计时', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const win = await openReady(h);
  h.menu.toggle(BOTTOM_TRAY);
  assert.equal(win.destroyed, false);
  h.menu.toggle(BOTTOM_TRAY);
  t.mock.timers.tick(500000);
  assert.equal(win.destroyed, false, '重开过就重新计时');
  h.menu.toggle(BOTTOM_TRAY);
  t.mock.timers.tick(600000);
  assert.equal(win.destroyed, true, '一直没人再用就真销毁');
  assert.equal(h.menu.refresh(), false);
  h.menu.dispose();
});

test('载页失败只报一次并清掉空壳，不自动重试', async () => {
  const h = harness();
  h.menu.toggle(BOTTOM_TRAY);
  const win = h.lastWin();
  win.rejectLoad(new Error('ERR_FILE_NOT_FOUND'));
  await tick();
  assert.equal(win.destroyed, true);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /ERR_FILE_NOT_FOUND/);
  assert.equal(h.windows.length, 1, '失败后不自己重开');
  await assert.rejects(async () => h.call('tray-menu:state', win), /未授权/);
  h.menu.dispose();
});

test('载页超时会回收同一 owner，不留不可见空壳', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.menu.toggle(BOTTOM_TRAY);
  const win = h.lastWin();
  t.mock.timers.tick(5000);
  await tick();
  assert.equal(win.destroyed, true);
  assert.match(h.errors[0].message, /加载超时/);
  h.menu.dispose();
});

test('ready 先到、载页后完成：不再补挂就绪超时把已显示的菜单收掉', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.menu.toggle(BOTTOM_TRAY);
  const win = h.lastWin();
  await h.call('tray-menu:ready', win);
  assert.equal(win.visible, true);
  win.resolveLoad();
  await tick();
  t.mock.timers.tick(3000);
  await tick();
  assert.equal(win.destroyed, false);
  assert.equal(win.visible, true);
  h.menu.dispose();
});

test('授权只认当前 owner 的主 frame：外来 sender、subframe、旧窗都拒绝', async () => {
  const h = harness();
  const win = await openReady(h);
  await assert.rejects(async () => h.handlers.get('tray-menu:state')({ sender: {}, senderFrame: {} }), /未授权/);
  await assert.rejects(async () => h.handlers.get('tray-menu:state')({ sender: win.webContents, senderFrame: {} }), /未授权/);
  await assert.rejects(async () => h.handlers.get('tray-menu:action')({ sender: win.webContents, senderFrame: {} }, 'capture'), /未授权/);
  h.menu.toggle(BOTTOM_TRAY);         // 收起这扇（窗口保留）
  win.emit('closed');                  // 外部关掉，owner 真的没了
  h.menu.toggle(BOTTOM_TRAY);         // 新 owner
  await assert.rejects(async () => h.call('tray-menu:state', win), /未授权/);
  h.menu.dispose();
});

test('动作白名单：未知动作不执行也不收窗', async () => {
  const h = harness();
  const win = await openReady(h);
  await assert.rejects(async () => h.call('tray-menu:action', win, 'open-file'), /未知的菜单动作/);
  assert.equal(h.actions.length, 0);
  assert.equal(win.destroyed, false);
  h.menu.dispose();
});

test('state/ready 先到、载页后到：不再装就绪超时，重复 ready 也不第二次 show/focus', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.menu.toggle(BOTTOM_TRAY);
  const win = h.lastWin();
  await h.call('tray-menu:state', win);
  await h.call('tray-menu:ready', win);
  await h.call('tray-menu:ready', win);
  assert.equal(win.shows, 1);
  assert.equal(win.focuses, 1);
  win.resolveLoad();
  await tick();
  t.mock.timers.tick(3000);
  await tick();
  assert.equal(win.destroyed, false, '载页完成后不补挂就绪超时');
  assert.equal(win.visible, true);
  assert.equal(win.shows, 1);
  assert.equal(win.focuses, 1);
  h.menu.dispose();
});

test('动作按现态再校验 finish-scroll / open-last；状态变了不发动作也不收窗', async () => {
  const h = harness();
  const win = await openReady(h);
  await assert.rejects(async () => h.call('tray-menu:action', win, 'finish-scroll'), /没有可完成的长截图/);
  await assert.rejects(async () => h.call('tray-menu:action', win, 'open-last'), /还没有最近的截图/);
  assert.equal(h.actions.length, 0);
  assert.equal(win.destroyed, false);
  h.state.canFinishScroll = true;
  h.state.hasLastFile = true;
  await h.call('tray-menu:action', win, 'finish-scroll');
  assert.deepEqual(h.actions, ['finish-scroll']);
  h.menu.dispose();
});

test('动作前 getState 失败：拒绝 dispatch，不回退旧 state 授权，也不收窗', async () => {
  const h = harness();
  h.state.canFinishScroll = true;
  h.state.hasLastFile = true;
  const win = await openReady(h);
  h.flags.stateFail = true;
  await assert.rejects(async () => h.call('tray-menu:action', win, 'finish-scroll'), /状态暂时不可用/);
  await assert.rejects(async () => h.call('tray-menu:action', win, 'open-last'), /状态暂时不可用/);
  await assert.rejects(async () => h.call('tray-menu:action', win, 'capture'), /状态暂时不可用/);
  assert.equal(h.actions.length, 0, '状态读不到时不 dispatch');
  assert.equal(win.destroyed, false, '拒绝发生在收窗之前');
  assert.ok(h.errors.length >= 3, '每次 getState 失败都走 onError');
  h.flags.stateFail = false;
  await h.call('tray-menu:action', win, 'capture');
  assert.deepEqual(h.actions, ['capture']);
  h.menu.dispose();
});

test('执行动作前先收窗：onAction 看到窗口已隐藏，且同一扇菜单只派发一次', async () => {
  const seen = [];
  const h = harness({ onAction: async action => { seen.push({ action, visible: h.windows[0].visible, destroyed: h.windows[0].destroyed }); return { ok: true }; } });
  const win = await openReady(h);
  const first = h.call('tray-menu:action', win, 'capture');
  const second = h.call('tray-menu:action', win, 'capture');
  await assert.rejects(async () => second, /正在处理/);
  const result = await first;
  assert.deepEqual(result, { ok: true, action: 'capture' });
  assert.deepEqual(seen, [{ action: 'capture', visible: false, destroyed: false }]);
  assert.equal(h.actions.length, 1, '同一扇菜单只执行一次');
  // 复用同一扇窗后，一次性派发锁必须解开，否则下一轮动作全被拒。
  h.menu.toggle(BOTTOM_TRAY);
  assert.equal(h.lastWin(), win);
  await h.call('tray-menu:action', win, 'capture');
  assert.equal(h.actions.length, 2);
  h.menu.dispose();
});

test('onAction 失败会记录错误并让这次调用失败', async () => {
  const h = harness({ onAction: async () => { throw new Error('quota'); } });
  const win = await openReady(h);
  await assert.rejects(async () => h.call('tray-menu:action', win, 'capture'), /quota/);
  assert.match(h.errors.at(-1).message, /quota/);
  assert.equal(win.visible, false);
  assert.equal(win.destroyed, false, '失败也不丢窗口，下次右键还复用它');
  h.menu.dispose();
});

test('dismiss 收窗但不销毁；之后再 dismiss 仍然安全', async () => {
  const h = harness();
  const win = await openReady(h);
  assert.equal(await h.call('tray-menu:dismiss', win), true);
  assert.equal(win.visible, false);
  assert.equal(win.destroyed, false);
  assert.equal(await h.call('tray-menu:dismiss', win), true, '同一扇已经收起，重复请求不抛');
  h.menu.dispose();
});

test('dispose：载页中也能收窗、摘掉自己的 handler，之后再调用一律拒绝', async () => {
  const h = harness();
  h.menu.toggle(BOTTOM_TRAY);
  const win = h.lastWin();
  h.menu.dispose();
  assert.equal(win.destroyed, true);
  assert.deepEqual(h.removed.sort(), ['tray-menu:action', 'tray-menu:dismiss', 'tray-menu:ready', 'tray-menu:reopen', 'tray-menu:state']);
  win.resolveLoad();
  await tick();
  assert.equal(win.visible, false);
  assert.throws(() => h.menu.toggle(BOTTOM_TRAY), /已释放/);
  assert.throws(() => h.menu.hide(), /已释放/);
  assert.throws(() => h.menu.refresh(), /已释放/);
  assert.doesNotThrow(() => h.menu.dispose());
});

test('getState 出错只记录，菜单按安全默认状态照常打开', async () => {
  const h = harness({ stateFail: true });
  h.menu.toggle(BOTTOM_TRAY);
  const win = h.lastWin();
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].message, /state broken/);
  win.resolveLoad();
  await tick();
  await h.call('tray-menu:ready', win);
  assert.equal(win.visible, true);
  assert.equal(h.menu.refresh(), false, '状态读不到时不发旧状态冒充新状态');
  assert.equal(h.errors.length, 2);
  h.menu.dispose();
});

test('定位：底部/顶部/左右任务栏各自贴边并夹进 workArea', () => {
  const bottom = placeTrayMenu({ trayBounds: BOTTOM_TRAY, workArea: WORK_AREA });
  assert.deepEqual(bottom, { x: 1576, y: 668, width: 296, height: 372 });
  const top = placeTrayMenu({ trayBounds: { x: 1840, y: 4, width: 32, height: 32 }, workArea: { x: 0, y: 40, width: 1920, height: 1040 } });
  assert.deepEqual(top, { x: 1576, y: 42, width: 296, height: 372 });
  const left = placeTrayMenu({ trayBounds: { x: 0, y: 500, width: 32, height: 32 }, workArea: { x: 40, y: 0, width: 1880, height: 1040 } });
  assert.deepEqual(left, { x: 40, y: 538, width: 296, height: 372 });
  const right = placeTrayMenu({ trayBounds: { x: 1880, y: 500, width: 32, height: 32 }, workArea: { x: 0, y: 0, width: 1880, height: 1040 } });
  assert.deepEqual(right, { x: 1584, y: 538, width: 296, height: 372 });
});

test('定位：负坐标屏、光标回退、超小工作区都不越界', () => {
  const negative = placeTrayMenu({ trayBounds: { x: -100, y: -240, width: 32, height: 32 }, workArea: { x: -1920, y: -200, width: 1920, height: 1040 } });
  assert.deepEqual(negative, { x: -364, y: -200, width: 296, height: 372 });
  const cursor = placeTrayMenu({ trayBounds: { x: 0, y: 0, width: 0, height: 0 }, cursorPoint: { x: 1900, y: 1040 }, workArea: WORK_AREA });
  assert.deepEqual(cursor, { x: 1604, y: 662, width: 296, height: 372 });
  const tiny = placeTrayMenu({ workArea: { x: -300, y: -100, width: 200, height: 120 } });
  assert.deepEqual(tiny, { x: -300, y: -100, width: 200, height: 120 });
});

test('preload：只暴露固定通道，action 白名单在桥内生效', async () => {
  let api;
  const calls = [];
  const listeners = new Map();
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main/tray-menu-preload.cjs'), 'utf8'), {
    require: name => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'trayMenu'); api = value; } },
        ipcRenderer: {
          invoke: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); },
          on: (channel, listener) => listeners.set(channel, listener),
          removeListener: (channel, listener) => { assert.equal(listeners.get(channel), listener); listeners.delete(channel); }
        }
      };
    }
  });
  assert.deepEqual(Object.keys(api).sort(), ['action', 'dismiss', 'onReopen', 'onState', 'ready', 'state']);
  await api.state();
  assert.deepEqual(calls.at(-1), ['tray-menu:state']);
  await api.ready();
  assert.deepEqual(calls.at(-1), ['tray-menu:ready']);
  await api.dismiss();
  assert.deepEqual(calls.at(-1), ['tray-menu:dismiss']);
  for (const action of ACTIONS) {
    await api.action(action);
    assert.deepEqual(calls.at(-1), ['tray-menu:action', action]);
  }
  const before = calls.length;
  for (const bad of ['open-file', 'tray-menu:state', null, undefined, {}]) {
    await assert.rejects(async () => api.action(bad), /不支持/);
  }
  assert.equal(calls.length, before, '未知动作不会触达 IPC');

  let received;
  const off = api.onState(value => { received = value; });
  listeners.get('tray-menu:state')({}, { canFinishScroll: true });
  assert.deepEqual(received, { canFinishScroll: true });
  off();
  assert.equal(listeners.has('tray-menu:state'), false);

  let reopened;
  const offReopen = api.onReopen(value => { reopened = value; });
  assert.equal(listeners.has('tray-menu:reopen'), true);
  listeners.get('tray-menu:reopen')({}, { hasLastFile: true });
  assert.deepEqual(reopened, { hasLastFile: true });
  offReopen();
  assert.equal(listeners.has('tray-menu:reopen'), false);
});

test('createTrayMenu 缺依赖时直接抛出，不建半套 IPC', () => {
  assert.throws(() => createTrayMenu({}), /BrowserWindow/);
  assert.throws(() => createTrayMenu({ BrowserWindow: class {}, ipcMain: { handle() {} } }), /页面文件/);
});




// —— 托盘预热：只建窗载页，绝不 show/focus；进原 warm 池、幂等、不续期 ——
test('prepare：只建窗载页，不 show/focus，ready 后进暖池', async () => {
  const h = harness();
  assert.deepEqual(h.menu.prepare(BOTTOM_TRAY), { prepared: true });
  assert.equal(h.windows.length, 1, '只建一扇');
  const win = h.lastWin();
  assert.equal(win.visible, false);
  win.resolveLoad();
  await tick();
  await h.call('tray-menu:ready', win);
  assert.equal(win.shows, 0, '后台 ready 不 show');
  assert.equal(win.focuses, 0, '后台 ready 不 focus');
  assert.equal(win.visible, false);
});

test('prepare 幂等：已有 owner 时不再建第二扇，也不重置暖池计时', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.menu.prepare(BOTTOM_TRAY);
  const win = h.lastWin();
  win.resolveLoad();
  await tick();
  await h.call('tray-menu:ready', win);
  assert.deepEqual(h.menu.prepare(BOTTOM_TRAY), { prepared: false, reason: 'exists' });
  assert.equal(h.windows.length, 1);
  // 暖池到期：原计时没有被 prepare 重置过一次就销毁
  t.mock.timers.tick(600000);
  await tick();
  assert.equal(win.destroyed, true, '到期就销毁，不因 prepare 续期');
});

test('预热载入中右键：转成显式打开，ready 时正常显示，不吞第一次', async () => {
  const h = harness();
  h.menu.prepare(BOTTOM_TRAY);
  const win = h.lastWin();
  assert.equal(h.menu.toggle(BOTTOM_TRAY), true, '载入中点开也要接受');
  win.resolveLoad();
  await tick();
  await h.call('tray-menu:ready', win);
  assert.equal(win.shows, 1);
  assert.equal(win.visible, true);
});

test('预热载入失败：清掉 owner，下次右键仍走冷建', async () => {
  const h = harness();
  h.menu.prepare(BOTTOM_TRAY);
  const win = h.lastWin();
  win.rejectLoad(Object.assign(new Error('load failed'), { code: 'ERR_FILE_NOT_FOUND' }));
  await tick();
  assert.equal(win.destroyed, true);
  assert.equal(h.errors.length >= 1, true);
  assert.equal(h.menu.toggle(BOTTOM_TRAY), true, '失败后仍能正常打开');
  const fresh = h.lastWin();
  assert.notEqual(fresh, win);
});

test('预热期间渲染进程崩溃：不误弹，下次冷建正常', async () => {
  const h = harness();
  h.menu.prepare(BOTTOM_TRAY);
  const win = h.lastWin();
  win.resolveLoad();
  await tick();
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await tick();
  assert.equal(win.destroyed, true);
  assert.equal(win.shows, 0);
  assert.equal(h.menu.toggle(BOTTOM_TRAY), true);
});

test('dispose 清掉预热 owner 与暖池计时', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.menu.prepare(BOTTOM_TRAY);
  const win = h.lastWin();
  win.resolveLoad();
  await tick();
  await h.call('tray-menu:ready', win);
  h.menu.dispose();
  assert.equal(win.destroyed, true);
  // 计时器已清：再怎么推进也不会再触发销毁或重建
  t.mock.timers.tick(600000);
  assert.equal(win.destroyed, true, '销毁后不再重建');
});

test('预热后台/隐藏暖窗不因准备页面获得动作权限；显式显示后正常，派发锁保持', async () => {
  const h = harness();
  h.menu.prepare(BOTTOM_TRAY);
  const win = h.lastWin();
  // 载入中：不能派发
  await assert.rejects(async () => h.call('tray-menu:action', win, 'capture'), /未授权/);
  win.resolveLoad();
  await tick();
  await h.call('tray-menu:ready', win);
  // 后台已 ready 但从未显示：仍不能派发
  await assert.rejects(async () => h.call('tray-menu:action', win, 'capture'), /未授权/);
  // 显式打开后可以派发
  h.menu.toggle(BOTTOM_TRAY);
  await tick();
  const result = await h.call('tray-menu:action', win, 'capture');
  assert.deepEqual(result, { ok: true, action: 'capture' });
  assert.equal(h.actions.length, 1);
  h.menu.dispose();
});

test('重复 ready 不再续期：暖池按原 TTL 到期销毁', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.menu.prepare(BOTTOM_TRAY);
  const win = h.lastWin();
  win.resolveLoad();
  await tick();
  await h.call('tray-menu:ready', win);
  t.mock.timers.tick(300000);
  await tick();
  await h.call('tray-menu:ready', win);   // 迟到/重复 ready
  t.mock.timers.tick(300000);
  await tick();
  assert.equal(win.destroyed, true, '仍按原来那 10 分钟到期');
});

test('预热后显示再收迟到 ready：不多 show，下一次 toggle 仍能正常收起与再开', async () => {
  const h = harness();
  h.menu.prepare(BOTTOM_TRAY);
  const win = h.lastWin();
  win.resolveLoad();
  await tick();
  await h.call('tray-menu:ready', win);
  h.menu.toggle(BOTTOM_TRAY);           // 预热后第一次显示
  await tick();
  assert.equal(win.shows, 1);
  await h.call('tray-menu:ready', win); // 迟到 ready 不能把 shown 改掉
  assert.equal(win.shows, 1, '不重复 show');
  h.menu.toggle(BOTTOM_TRAY);           // 收起
  assert.equal(win.visible, false);
  h.menu.toggle(BOTTOM_TRAY);           // 再开
  assert.equal(win.visible, true);
  assert.equal(win.shows, 2);
  h.menu.dispose();
});

test('收窗后迟到的 dismiss 只收起，不会把窗口再弹出来', async () => {
  const h = harness();
  const win = await openReady(h);
  h.menu.toggle(BOTTOM_TRAY);   // 收起
  assert.equal(win.visible, false);
  await h.call('tray-menu:dismiss', win);
  assert.equal(win.visible, false, '迟到 dismiss 不弹窗');
  assert.equal(win.shows, 1);
  h.menu.dispose();
});
