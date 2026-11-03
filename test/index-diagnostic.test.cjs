'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function bootHarness({ failStatusSend = false, loading = false, packaged = false, portableExe, registerFailsFor = [], unregisterThrowsFor = [], loadFails = 0, deferControlLoad = false } = {}) {
  const app = new EventEmitter(), handlers = new Map(), windows = [];
  let quitCalls = 0, active = false, scrolling = false, recording = false, hasReport = false, hooks, diagnosticChanged, tray;
  let started = 0, finished = 0, desktopStarted = 0, remainingLoadFails = loadFails;
  const sent = [], startOptions = [], shortcuts = new Map(), iconCalls = [], loginCalls = [], logs = [], processHandlers = new Map();
  // 控制页加载挂起：专用于验“加载期间不提前 show 空壳”的顺序。
  let releaseControlLoad;
  const controlLoadGate = deferControlLoad ? new Promise(resolve => { releaseControlLoad = resolve; }) : undefined;
  Object.assign(app, { getPath: () => path.resolve('test-not-written'), setPath() {}, setName() {}, getVersion: () => '0.0.0',
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), quit() { quitCalls++; },
    isPackaged: packaged, getAppPath: () => '/fixture/app',
    setLoginItemSettings(value) { loginCalls.push({ method: 'set', value }); },
    getLoginItemSettings(value) { loginCalls.push({ method: 'get', value }); return { openAtLogin: true }; } });
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.visible = false; this.maximized = false; this.minimized = false; this.destroyed = false;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.isLoading = () => loading;
      this.webContents.setWindowOpenHandler = () => {}; this.webContents.send = (...args) => { if (failStatusSend) throw new Error('frame unavailable'); sent.push(args); };
      windows.push(this); }
    isDestroyed() { return this.destroyed; }
    async loadFile(file) {
      this.loads = (this.loads ?? 0) + 1;
      // 只让控制页加载失败；探针窗的 target/overlay 仍照常“加载成功”。
      if (remainingLoadFails > 0 && String(file).endsWith('index.html')) { remainingLoadFails -= 1; this.loadFailed = true; throw new Error('页面加载失败'); }
      if (controlLoadGate && String(file).endsWith('index.html')) await controlLoadGate;
      this.loaded = true;
    }
    removeMenu() { this.menuRemoved = true; }
    hide() { this.visible = false; } show() { this.shows = (this.shows ?? 0) + 1; this.visible = true; } focus() { this.focused = true; }
    isFocused() { return Boolean(this.focused); }
    isVisible() { return Boolean(this.visible); }
    isMaximized() { return this.maximized; } isMinimized() { return this.minimized; }
    maximize() { this.maximized = true; this.emit('maximize'); }
    unmaximize() { this.maximized = false; this.emit('unmaximize'); }
    minimize() { this.minimized = true; } restore() { this.minimized = false; }
    // 主题只碰的纯装饰属性：记下来供断言。
    setBackgroundColor(color) { (this.backgrounds ??= []).push(color); }
    setTitleBarOverlay(options) { (this.overlays ??= []).push({ ...options }); }
    setAccentColor(color) { (this.accents ??= []).push(color); }
    close() { this.closePrevented = false; this.emit('close', { preventDefault: () => { this.closePrevented = true; } }); }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; this.emit('closed'); }
  }
  class Tray {
    constructor(icon) { tray = this; this.icon = icon; this.events = new Map(); this.destroyed = false; this.menus = []; } setToolTip(text) { this.tooltip = text; } on(name, fn) { this.events.set(name, fn); } isDestroyed() { return this.destroyed; }
    setContextMenu(menu) { this.menus.push(menu); } destroy() { this.destroyed = true; }
    getBounds() { return { x: 1200, y: 900, width: 32, height: 32 }; }
  }
  // nativeTheme：真 Electron 的三态对象。手动 light/dark 直接决定深浅，system 时看 systemDark（模拟 Windows）。
  const nativeTheme = new EventEmitter();
  nativeTheme.themeSource = 'system';
  nativeTheme.systemDark = false;
  Object.defineProperty(nativeTheme, 'shouldUseDarkColors', {
    get() { return this.themeSource === 'dark' || (this.themeSource === 'system' && this.systemDark === true); }
  });
  const electron = { app, BrowserWindow: Window, Tray, Menu: { buildFromTemplate: items => items }, nativeTheme,
    session: { defaultSession: { setDisplayMediaRequestHandler() {} } },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, globalShortcut: { register: (key, fn) => { if (registerFailsFor.includes(key)) return false; shortcuts.set(key, fn); return true; }, unregister(key) { if (unregisterThrowsFor.includes(key)) throw new Error(`卸不下 ${key}`); shortcuts.delete(key); } },
    nativeImage: { createFromPath: file => { iconCalls.push(file); return { isEmpty: () => false, resize: options => { iconCalls.push(options); return { girlIcon: true }; } }; } } };
  const diagnostics = { state: () => ({ recording, writing: false, hasReport }), end() { recording = false; diagnosticChanged(); }, flush: async () => {} };
  const screenshot = { isActive: () => active, canFinishScroll: () => scrolling, getLastFile() {}, start(options) { started++; startOptions.push(options); },
    startDesktop() { desktopStarted++; }, prepare() { prepares++; return Promise.resolve({ prepared: true }); }, dispose() { disposedCount++; },
    finishScroll() { finished++; scrolling = false; }, cancel() { cancelledCount++; } };
  let prepares = 0, disposedCount = 0, cancelledCount = 0;
  // 自绘快捷菜单替身（真模块由另一位作者提供）：只记注入的依赖与调用。
  const trayMenuCalls = [];
  let trayMenuOptions;
  const trayMenuApi = {
    toggle: bounds => { trayMenuCalls.push({ kind: 'toggle', bounds: { ...bounds } }); },
    hide: () => { trayMenuCalls.push({ kind: 'hide' }); },
    refresh: () => { trayMenuCalls.push({ kind: 'refresh' }); },
    dispose: () => { trayMenuCalls.push({ kind: 'dispose' }); }
  };
  const context = { module: { exports: {} }, __dirname: path.resolve(__dirname, '../main'), Buffer, setTimeout,
    process: { pid: 4242, on(name, fn) { processHandlers.set(name, fn); }, env: portableExe ? { PORTABLE_EXECUTABLE_FILE: portableExe } : {}, execPath: '/fixture/electron.exe', versions: { electron: 'test', chrome: 'test' }, platform: 'win32' }, console,
    require: name => name === 'electron' ? electron : name === 'node:fs' ? { mkdirSync() {}, appendFileSync(file, text) { logs.push({ file, text }); } } :
      name === './tray-menu.cjs' ? { createTrayMenu: options => { trayMenuOptions = options; return trayMenuApi; } } :
      name === './screenshot.cjs' ? { installScreenshot(options) { hooks = options; return screenshot; } } :
      name === './settings.cjs' ? require('../main/settings.cjs') :
      name === './diagnostics.cjs' ? { createDiagnostics({ onChange }) { diagnosticChanged = onChange; return diagnostics; } } :
      // 被测入口的相对依赖以 main 为基准；不能误以本测试目录解析新增模块。
      require(name.startsWith('./') ? path.resolve(__dirname, '../main', name) : name) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main/index.cjs'), 'utf8'), context);
  await tick();
  // 控制页按需创建：通过自绘菜单注入的 onAction('settings'|'help') 走真实 openSection。
  const trayAction = action => trayMenuOptions.onAction(action);
  const controlClick = section => trayAction(section === 'help' ? 'help' : 'settings');
  const openControl = async (section = 'settings') => { await controlClick(section); await tick(); return windows.at(-1); };
  return { hooks, tray, windows, iconCalls, loginCalls, quitCalls: () => quitCalls, changed: () => diagnosticChanged(), app, logs, processHandlers, nativeTheme,
    trayMenuOptions: () => trayMenuOptions, trayMenuCalls, trayMenuState: () => trayMenuOptions.getState(), trayAction,
    prepares: () => prepares, disposedCount: () => disposedCount,
    controlClick, openControl,
    releaseControlLoad: () => releaseControlLoad?.(), cancelledCount: () => cancelledCount,
    setActive(value) { active = value; }, setScrolling(value) { scrolling = value; }, started: () => started, finished: () => finished, sent, startOptions, shortcuts,
    finishLoad(win = windows.at(-1)) { loading = false; win.webContents.emit('did-finish-load'); },
    setRecording(value) { recording = value; }, setHasReport(value) { hasReport = value; }, handlers,
    desktopStarted: () => desktopStarted };
}

test('主题：启动按保存意图设 themeSource，控制页建窗即上色，shot:state 带 theme', async t => {
  const settingsFile = path.join(path.resolve('test-not-written'), '截个长 · 捕获验证', 'settings.json');
  const { createSettings } = require('../main/settings.cjs');
  const restore = () => { try { createSettings({ file: settingsFile }).update({ theme: 'system' }); } catch { /* 无法恢复就留给下一个用例自己重写 */ } };
  // 先写一份"上次选了深色"的设置，模拟重启后读回。
  t.after(restore);
  createSettings({ file: settingsFile }).update({ theme: 'dark' });
  const h = await bootHarness();
  assert.equal(h.nativeTheme.themeSource, 'dark', '启动就把保存的意图交给 Electron');
  const win = await h.openControl();
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const state = h.handlers.get('shot:state')(event);
  assert.deepEqual(JSON.parse(JSON.stringify(state.theme)), { source: 'dark', dark: true }, 'state 读保存意图，颜色依 shouldUseDarkColors');
  assert.deepEqual(win.backgrounds, ['#17231f'], '深色意图下控制页建窗就用深色背景');
  assert.equal(win.overlays, undefined, '普通设置页不动标题栏叠加');
  assert.equal(win.accents, undefined);
});

test('主题 IPC：三态写入并落 themeSource，非法值与外来 sender 被拒', async t => {
  const settingsFile = path.join(path.resolve('test-not-written'), '截个长 · 捕获验证', 'settings.json');
  const { createSettings } = require('../main/settings.cjs');
  t.after(() => { try { createSettings({ file: settingsFile }).update({ theme: 'system' }); } catch { /* 忽略 */ } });
  createSettings({ file: settingsFile }).update({ theme: 'system' });
  const h = await bootHarness();
  const win = await h.openControl();
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  for (const source of ['light', 'dark', 'system']) {
    const next = h.handlers.get('shot:set-theme')(event, source);
    assert.equal(h.nativeTheme.themeSource, source, `${source} 落到 nativeTheme`);
    assert.equal(next.theme.source, source, '回包带新的 theme');
    assert.equal(createSettings({ file: settingsFile }).get().theme, source, '也写进了设置文件');
  }
  h.nativeTheme.themeSource = 'system';
  for (const bad of ['neon', '', 'Light', 1, null]) {
    assert.throws(() => h.handlers.get('shot:set-theme')(event, bad), /无效的主题设置/);
    assert.equal(h.nativeTheme.themeSource, 'system', '拒绝后主题不变');
    assert.equal(createSettings({ file: settingsFile }).get().theme, 'system', '也没写进文件');
  }
  // 同一条 IPC 只认当前控制页主 frame。
  assert.throws(() => h.handlers.get('shot:set-theme')({ sender: {}, senderFrame: {} }, 'dark'), /未授权/);
  assert.equal(h.nativeTheme.themeSource, 'system');
});

test('主题：nativeTheme.updated 只刷已绑窗口，退出时摘监听', async t => {
  const settingsFile = path.join(path.resolve('test-not-written'), '截个长 · 捕获验证', 'settings.json');
  const { createSettings } = require('../main/settings.cjs');
  t.after(() => { try { createSettings({ file: settingsFile }).update({ theme: 'system' }); } catch { /* 忽略 */ } });
  createSettings({ file: settingsFile }).update({ theme: 'system' });
  const h = await bootHarness();
  const win = await h.openControl();
  assert.equal(h.nativeTheme.listenerCount('updated'), 1, '控制页绑上就只挂一个监听');
  h.nativeTheme.systemDark = true;
  h.nativeTheme.emit('updated');
  assert.equal(win.backgrounds.at(-1), '#17231f', '跟随系统且系统转深色就跟着换背景');
  h.nativeTheme.systemDark = false;
  h.nativeTheme.emit('updated');
  assert.equal(win.backgrounds.at(-1), '#f7faf6');
  // 明确退出：主题监听也得摘掉。
  h.app.emit('before-quit', { preventDefault() { throw new Error('正常退出不应被拦截'); } });
  assert.equal(h.nativeTheme.listenerCount('updated'), 0);
});

for (const [packaged, portableExe] of [[false, undefined], [true, undefined], [true, 'D:\\Apps\\截个图.exe']]) {
  test(`自启目标与启动形态一致（packaged=${packaged}, portable=${Boolean(portableExe)}）`, async () => {
    const h = await bootHarness({ packaged, portableExe });
    const win = await h.openControl();
    const web = win.webContents;
    h.handlers.get('shot:set-auto-launch')({ sender: web, senderFrame: web.mainFrame }, true);
    const expected = !packaged ? { path: '/fixture/electron.exe', args: ['/fixture/app'] }
      : portableExe ? { path: portableExe, args: [] } : {};
    assert.deepEqual(JSON.parse(JSON.stringify(h.loginCalls)), [
      { method: 'set', value: { ...expected, openAtLogin: true } }, { method: 'get', value: expected }
    ]);
  });
}

test('托盘使用纸卷箭头图片并高质量缩放至32px', async () => {
  const h = await bootHarness();
  assert.equal(h.iconCalls[0], path.resolve(__dirname, '../assets/tray-scroll.png'));
  assert.deepEqual(JSON.parse(JSON.stringify(h.iconCalls[1])), { width: 32, height: 32, quality: 'best' });
  assert.equal(h.tray.icon.girlIcon, true);
  assert.ok(fs.statSync(h.iconCalls[0]).size > 0);
});

for (const failStatusSend of [false, true]) test(`状态页发送与托盘刷新独立，托盘左右键入口正确（sendFails=${failStatusSend}）`, async () => {
  const h = await bootHarness({ failStatusSend });
  assert.equal(h.quitCalls(), 0);
  assert.equal(h.windows.length, 0, '启动只留托盘与快捷键，不预先建控制页');
  assert.equal(h.tray.menus.length, 0, '不再配原生托盘菜单，不会同时弹两个');
  assert.match(h.tray.tooltip, /左键设置/);
  assert.match(h.tray.tooltip, /右键快捷菜单/);
  assert.match(h.tray.tooltip, /F1/);
  // 自绘菜单注入的依赖与状态。
  const options = h.trayMenuOptions();
  assert.equal(options.rendererFile, path.resolve(__dirname, '../renderer/tray-menu.html'));
  assert.equal(options.preloadFile, path.resolve(__dirname, '../main/tray-menu-preload.cjs'));
  assert.deepEqual(JSON.parse(JSON.stringify(h.trayMenuState())), { hotkeyLabel: 'F1', hotkeyRegistered: true, canFinishScroll: false, hasLastFile: false });
  h.setScrolling(true);
  assert.equal(h.trayMenuState().canFinishScroll, true, '长截中菜单可完成');
  h.setScrolling(false);
  // 左键：先收起可能开着的快捷菜单，再打开设置页（不直接截图）。
  h.trayMenuCalls.length = 0;
  h.tray.events.get('click')();
  await tick(); await tick();
  assert.deepEqual(h.trayMenuCalls.map(call => call.kind)[0], 'hide', '左键先把菜单收掉');
  assert.equal(h.started(), 0, '左键不再直接截图');
  assert.equal(h.windows.length, 1, '左键按需建控制页');
  assert.equal(h.windows[0].visible, true);
  if (!failStatusSend) {
    assert.equal(h.sent.filter(args => args[0] === 'shot:focus-section').at(-1)[1], 'settings');
  }
  // 右键：切自绘菜单，参数是托盘矩形。
  h.tray.events.get('right-click')();
  const toggle = h.trayMenuCalls.filter(call => call.kind === 'toggle').at(-1);
  assert.deepEqual(toggle.bounds, { x: 1200, y: 900, width: 32, height: 32 });
  // 菜单动作白名单：capture 仍走 screenshot.start()，finish-scroll 完成前再核一次。
  h.trayAction('capture'); assert.equal(h.started(), 1); assert.equal(h.startOptions.at(-1), undefined);
  assert.throws(() => h.trayAction('finish-scroll'), /没有可完成的长截图/);
  assert.equal(h.finished(), 0);
  h.setScrolling(true);
  h.trayAction('finish-scroll'); assert.equal(h.finished(), 1);
  assert.throws(() => h.trayAction('rm -rf'), /未知的菜单动作/);
  assert.equal(h.handlers.has('shot:diagnose'), false); assert.equal(h.handlers.has('shot:diagnostic-stop'), false);
  for (const name of ['shot:set-hotkey', 'shot:set-auto-launch', 'shot:choose-save-folder']) assert.ok(h.handlers.has(name), `${name} 要能用`);
  // 状态推送只刷新自绘菜单，不再重配原生菜单。
  h.setHasReport(true); h.changed();
  assert.equal(h.trayMenuCalls.some(call => call.kind === 'refresh'), true, '状态变化会 refresh 自绘菜单');
  assert.equal(h.tray.menus.length, 0);
  h.hooks.onCaptureEnd();
  // 新增的自绘菜单文件要进 check（不依赖它们能跑，只保证语法被看住）。
  const check = String(JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).scripts.check);
  for (const file of ['main/tray-menu.cjs', 'main/tray-menu-preload.cjs', 'renderer/tray-menu.js']) assert.ok(check.includes(file), `${file} 要在 check 里`);
});
test('快捷键保留当前窗口，页面和托盘（菜单项）默认隐藏，页面不能伪造入口策略', async () => {
  const h=await bootHarness();
  h.shortcuts.get('F1')();assert.equal(h.startOptions.at(-1).hideControl,false);
  // 只有快捷键入口带 nested:true（允许在已有选区页上再截一层）；页面/托盘入口不传。
  assert.equal(h.startOptions.at(-1).nested,true);
  h.trayAction('capture');assert.equal(h.startOptions.at(-1),undefined);
  const win=await h.openControl();const web=win.webContents;
  h.handlers.get('shot:start')({sender:web,senderFrame:web.mainFrame},{hideControl:false});
  assert.equal(h.startOptions.at(-1),undefined,'IPC参数不能改变主进程固定的页面入口策略');
});

test('自定义窗框保留原生缩放，窗口按钮最小化/最大化/还原，关闭只回托盘', async () => {
  const h = await bootHarness();
  assert.equal(h.windows.length, 0, '启动不建控制窗');
  const win = await h.openControl(), web = win.webContents;
  const event = { sender: web, senderFrame: web.mainFrame };
  const invoke = name => h.handlers.get(name)(event);
  assert.equal(win.options.icon, path.resolve(__dirname, '../assets/app-icon.ico'));
  assert.ok(fs.statSync(win.options.icon).size > 0);
  assert.equal(win.options.frame, false); assert.equal(win.options.roundedCorners, true);
  assert.equal(win.options.resizable, true); assert.equal(win.options.minWidth, 580); assert.equal(win.menuRemoved, true);
  assert.equal(invoke('window:state').maximized, false);
  assert.equal(invoke('window:toggle-maximize'), undefined);
  assert.equal(h.sent.at(-1)[0], 'window:state'); assert.equal(h.sent.at(-1)[1].maximized, true);
  assert.equal(invoke('window:toggle-maximize'), undefined);
  assert.equal(h.sent.at(-1)[1].maximized, false);
  win.show(); invoke('window:minimize'); assert.equal(win.isMinimized(), true);
  await h.controlClick('settings');
  assert.equal(win.isMinimized(), false); assert.equal(win.visible, true);
  invoke('window:close'); assert.equal(win.closePrevented, true); assert.equal(win.visible, false);
  assert.equal(win.isDestroyed(), false, '关闭只是 hide，不销毁已用控制页');
  assert.equal(h.windows.length, 1, '关闭不重建也不换窗');
  await h.controlClick('settings');
  assert.equal(win.loads, 1, '重新打开不重载页面，设置输入与试验 DOM 都保留');
  assert.equal(win.visible, true);
  assert.equal(h.quitCalls(), 0);
  h.trayAction('quit'); assert.equal(h.quitCalls(), 1);
});

test('原生最大化延迟生效时只由完成事件推送新状态', async () => {
  const h = await bootHarness(), win = await h.openControl(), web = win.webContents;
  win.maximize = () => setImmediate(() => { win.maximized = true; win.emit('maximize'); });
  const event = { sender: web, senderFrame: web.mainFrame };
  assert.equal(h.handlers.get('window:toggle-maximize')(event), undefined);
  assert.equal(h.handlers.get('window:state')(event).maximized, false);
  await tick(); assert.equal(h.sent.at(-1)[0], 'window:state'); assert.equal(h.sent.at(-1)[1].maximized, true);
});

test('窗口IPC拒绝外来窗口和子框架，不接受可执行的泛型窗口指令', async () => {
  const h = await bootHarness(), web = (await h.openControl()).webContents;
  for (const name of ['window:state', 'window:minimize', 'window:toggle-maximize', 'window:close']) {
    assert.throws(() => h.handlers.get(name)({ sender: {}, senderFrame: web.mainFrame }), /未授权/);
    assert.throws(() => h.handlers.get(name)({ sender: web, senderFrame: {} }), /未授权/);
  }
  assert.equal(h.handlers.has('window:execute'), false); assert.equal(h.quitCalls(), 0);
});

test('窗口最大化事件发送失败不阻断原生操作', async () => {
  const h = await bootHarness({ failStatusSend: true }), win = await h.openControl();
  assert.doesNotThrow(() => { win.maximize(); win.unmaximize(); });
  assert.equal(win.maximized, false); assert.equal(h.quitCalls(), 0);
});

test('标题栏preload只暴露固定IPC及可取消的状态订阅', async () => {
  const api = {}, calls = [], ipc = new EventEmitter();
  ipc.invoke = async (channel, ...args) => { calls.push([channel, ...args]); return { maximized: true }; };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main/preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (key, value) => { api[key] = value; } }, ipcRenderer: ipc }; }
  });
  for (const [method, channel] of [['windowState', 'window:state'], ['minimizeWindow', 'window:minimize'], ['toggleMaximize', 'window:toggle-maximize'], ['closeWindow', 'window:close']]) {
    await api.shot[method](); assert.equal(calls.at(-1)[0], channel); assert.equal(calls.at(-1).length, 1);
  }
  // 改键租约：固定两个通道；setHotkey 旧调用仍只传一个参数。
  await api.shot.beginHotkeyEdit(); assert.deepEqual(calls.at(-1), ['shot:begin-hotkey-edit']);
  await api.shot.endHotkeyEdit('tok-1'); assert.deepEqual(calls.at(-1), ['shot:end-hotkey-edit', 'tok-1']);
  await api.shot.setHotkey('F2'); assert.deepEqual(calls.at(-1), ['shot:set-hotkey', 'F2'], '旧调用形状不变');
  await api.shot.setHotkey('F2', 'tok-1'); assert.deepEqual(calls.at(-1), ['shot:set-hotkey', 'F2', 'tok-1']);
  let last; const unsubscribe = api.shot.onWindowState(state => { last = state; });
  ipc.emit('window:state', {}, { maximized: false }); assert.equal(last.maximized, false);
  unsubscribe(); assert.equal(ipc.listenerCount('window:state'), 0);
});

test('页面尚未加载时托盘导航保留最后选择，加载后准确打开', async () => {
  const h=await bootHarness({loading:true});
  const before=h.sent.filter(args=>args[0]==='shot:focus-section').length;
  h.controlClick('settings');h.controlClick('help');
  assert.equal(h.sent.filter(args=>args[0]==='shot:focus-section').length,before,'加载中一次都不发');
  h.finishLoad();assert.equal(h.sent.at(-1)[0],'shot:focus-section');assert.equal(h.sent.at(-1)[1],'help');
  // 创建/加载在途时第三次点击也走排队分支，等同一个任务完成后才发送。
  await h.controlClick('settings');assert.equal(h.sent.at(-1)[1],'settings');
  assert.equal(h.windows.length,1,'全程只有一扇控制页');
});

for (const recording of [true, false]) test(`退出等写盘期间重复退出仍受阻、菜单收起（recording=${recording}）`, async () => {
  const app = new EventEmitter(), handlers = new Map();
  let quitCalls = 0, disposed = 0, releaseFlush;
  const gate = new Promise(resolve => { releaseFlush = resolve; });
  Object.assign(app, { getPath: () => path.resolve('test-not-written'), setPath() {}, setName() {},
    requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), quit: () => { quitCalls++; } });
  const electron = { app, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, globalShortcut: { unregister() {} } };
  const context = { module: { exports: {} }, __dirname: path.resolve(__dirname, '../main'),
    process: { on() {} }, setTimeout, require: name => name === 'electron' ? electron :
      name === 'node:fs' ? { mkdirSync() {}, appendFileSync() {} } :
      name === './screenshot.cjs' ? { installScreenshot() {} } : require(name.startsWith('./') ? path.resolve(__dirname, '../main', name) : name) };
  const source = fs.readFileSync(path.join(__dirname, '../main/index.cjs'), 'utf8');
  vm.runInNewContext(source + '\nmodule.exports = { configure(d, s, c, t, m) { diagnostics=d; screenshot=s; control=c; tray=t; trayMenu=m; }, handle };', context);
  const control = { webContents: { mainFrame: {} } };
  const menuCalls = [];
  const trayMenu = { hide() { menuCalls.push('hide'); }, dispose() { menuCalls.push('dispose'); }, refresh() {}, toggle() {} };
  const tray = { isDestroyed: () => false, setToolTip(text) { this.tooltip = text; }, destroy() {} };
  context.module.exports.configure({ state: () => ({ recording, writing: true }), end() {}, flush: () => gate },
    { dispose: () => { disposed++; } }, control, tray, trayMenu);
  let operationCalls = 0;
  context.module.exports.handle('test:operation', () => operationCalls++);
  const attempt = () => { const event = { prevented: false, preventDefault() { this.prevented = true; } }; app.emit('before-quit', event); return event; };
  assert.equal(attempt().prevented, true);
  assert.match(tray.tooltip, /正在保存后台记录并退出/);
  assert.deepEqual(menuCalls, ['hide'], '不再配原生菜单，只把自绘菜单收起来');
  assert.equal(attempt().prevented, true);
  assert.equal(quitCalls, 0); assert.equal(disposed, 1);
  assert.throws(() => handlers.get('test:operation')({ sender: control.webContents, senderFrame: control.webContents.mainFrame }), /正在退出/);
  assert.equal(operationCalls, 0);
  releaseFlush(); await tick(); assert.equal(quitCalls, 1);
  assert.equal(attempt().prevented, false);
});

test('控制窗真正被销毁时只收探针与引用，不连带 dispose 截图暖件，下次设置可重建', async () => {
  const h = await bootHarness();
  const first = await h.openControl();
  const before = h.disposedCount();
  first.destroy();
  assert.equal(h.disposedCount(), before, 'closed 不能再 dispose 与设置无关的暖页/暖源');
  const second = await h.openControl('help');
  assert.notEqual(second, first, '旧窗销毁后重新创建');
  assert.equal(second.loaded, true); assert.equal(second.visible, true);
  // 旧 sender 一律拒绝：句柄只认当时的 control。
  const stale = { sender: first.webContents, senderFrame: first.webContents.mainFrame };
  assert.throws(() => h.handlers.get('window:close')(stale), /未授权/);
  assert.throws(() => h.handlers.get('shot:state')(stale), /未授权/);
  assert.equal(h.handlers.get('shot:state')({ sender: second.webContents, senderFrame: second.webContents.mainFrame }).hotkey, 'F1');
});

test('控制页没创建时托盘与 F1 照常工作，IPC 一律拒绝且不建窗', async () => {
  const h = await bootHarness();
  assert.equal(h.windows.length, 0, '启动零窗口');
  h.shortcuts.get('F1')();
  assert.equal(h.started(), 1);
  assert.deepEqual({ ...h.startOptions.at(-1) }, { hideControl: false, nested: true }, 'F1 仍走原来的保画面叠层入口');
  assert.equal(h.windows.length, 0, 'F1 绝不创建设置页');
  h.trayAction('capture'); assert.equal(h.started(), 2, '自绘菜单的截图项仍可用');
  assert.equal(h.windows.length, 0, '菜单截图也不创建设置页');
  const foreign = { sender: { mainFrame: {} }, senderFrame: {} };
  for (const name of ['shot:state', 'window:state', 'shot:start', 'shot:quit']) {
    assert.throws(() => h.handlers.get(name)(foreign), /未授权/, `${name} 没有控制页时不能越权`);
  }
  assert.equal(h.quitCalls(), 0);
});

test('并发打开设置与帮助共用同一次创建，只聚焦最后一次请求', async () => {
  const h = await bootHarness();
  const both = Promise.all([h.controlClick('settings'), h.controlClick('help')]);
  await both;
  assert.equal(h.windows.length, 1, '并发只建一扇窗');
  const win = h.windows[0];
  assert.equal(win.loads, 1, '页面只加载一次');
  assert.equal(win.visible, true);
  const sections = h.sent.filter(args => args[0] === 'shot:focus-section').map(args => args[1]);
  assert.deepEqual(sections, ['help'], '后到的请求覆盖前一个焦点');
});

test('首次加载失败不留空壳，下一次打开重新创建并正常显示', async () => {
  const h = await bootHarness({ loadFails: 1 });
  await h.controlClick('settings');
  await tick();
  assert.equal(h.windows.length, 1, '失败那一轮只建了一扇窗');
  assert.equal(h.windows[0].destroyed, true, '失败不留空壳窗');
  assert.equal(h.windows[0].loaded, undefined, '失败页未被当成就绪');
  // 托盘 tooltip 固定写入口提示；失败只能靠日志与菜单刷新体现（设置页不在）。
  assert.match(h.tray.tooltip, /左键设置/, 'tooltip 固定写入口，不被失败文案覆盖');
  assert.equal(h.trayMenuCalls.some(call => call.kind === 'refresh'), true, '失败也会刷新自绘菜单');
  const events = h.logs.filter(entry => entry.file.endsWith('lifecycle.log')).map(entry => JSON.parse(entry.text.trim()));
  assert.deepEqual(events.filter(entry => entry.event === 'control-open-failed').map(entry => entry.reason), ['load']);

  const retry = await h.openControl('help');
  assert.equal(h.windows.length, 2, '重试重新创建');
  assert.notEqual(retry, h.windows[0]);
  assert.equal(retry.loaded, true); assert.equal(retry.visible, true);
  assert.equal(h.sent.at(-1)[0], 'shot:focus-section'); assert.equal(h.sent.at(-1)[1], 'help');
});

test('没有窗口时托盘独立存活，只有托盘也没了才跟随退出', async () => {
  const h = await bootHarness();
  assert.equal(h.windows.length, 0, '启动即零窗口');
  h.app.emit('window-all-closed');
  assert.equal(h.quitCalls(), 0, '托盘在就不自动退出');
  const win = await h.openControl();
  win.destroy();
  assert.equal(h.quitCalls(), 0);
  h.app.emit('window-all-closed');
  assert.equal(h.quitCalls(), 0, '关掉控制页也不退出，托盘还在');
  h.tray.destroy();
  h.app.emit('window-all-closed');
  assert.equal(h.quitCalls(), 1, '托盘没了才走原来的自动退出');
});

test('明确退出仍走 before-quit：注销热键并 dispose 截图会话与自绘菜单，不依赖控制页', async () => {
  const h = await bootHarness();
  const before = h.disposedCount();
  h.app.emit('before-quit', { preventDefault() { throw new Error('正常退出不应被拦截'); } });
  assert.equal(h.disposedCount(), before + 1, '退出时仍 dispose 截图会话');
  assert.equal(h.shortcuts.has('F1'), false, '热键要注销');
  assert.equal(h.tray.destroyed, true);
  assert.equal(h.trayMenuCalls.some(call => call.kind === 'dispose'), true, '自绘菜单也要收掉');
});

test('改键租约中退出：只丢租约不重新注册，也不把键留在“已暂停”状态', async () => {
  const h = await bootHarness();
  const win = await h.openControl();
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  h.handlers.get('shot:begin-hotkey-edit')(event);
  assert.equal(h.shortcuts.has('F1'), false, '租约中旧键已卸');
  h.app.emit('before-quit', { preventDefault() { throw new Error('正常退出不应被拦截'); } });
  assert.equal(h.shortcuts.size, 0, '退出不重新注册任何键');
  assert.throws(() => h.handlers.get('shot:set-hotkey')(event, 'Ctrl+Alt+3', 'tok-any'), /已失效|正在退出/);
});

test('加载在途的第二次打开不提前亮空壳，两次 open 共等同一次创建', async () => {
  const h = await bootHarness({ deferControlLoad: true });
  const first = h.controlClick('settings');
  const second = h.controlClick('help');
  await tick();
  assert.equal(h.windows.length, 1, '加载期间只建一扇窗');
  const win = h.windows[0];
  assert.equal(win.shows ?? 0, 0, '加载期间一次 show 都不能发生');
  assert.equal(win.visible, false, '加载未完成不上屏');
  assert.equal(win.loads, 1, '两次 open 共用同一次加载');
  h.releaseControlLoad();
  await Promise.all([first, second]);
  assert.equal(win.shows, 1, '加载完成后只 show 一次');
  assert.equal(win.visible, true);
  assert.equal(h.windows.length, 1, '不因第二次 open 重建');
  const sections = h.sent.filter(args => args[0] === 'shot:focus-section').map(args => args[1]);
  assert.deepEqual(sections, ['help'], '最新 section 覆盖排队值');
});

test('加载期间发起退出：不再 show，不闪窗', async () => {
  const h = await bootHarness({ deferControlLoad: true });
  const pending = h.controlClick('settings');
  await tick();
  const win = h.windows[0];
  h.app.emit('before-quit', { preventDefault() { throw new Error('正常退出不应被拦截'); } });
  h.releaseControlLoad();
  await pending;
  assert.equal(win.shows ?? 0, 0, '退出请求后错到的加载完成不能再亮窗');
  assert.equal(win.visible, false);
  assert.equal(win.isDestroyed(), false, '不在退出路径上多动分支；窗口交给 app 退出收');
});

test('控制页渲染进程崩：收掉该窗、不 cancel/dispose 截图，下次打开重建且旧 sender 被拒', async () => {
  const h = await bootHarness();
  const first = await h.openControl();
  const before = { disposed: h.disposedCount(), cancelled: h.cancelledCount() };
  first.webContents.emit('render-process-gone');
  assert.equal(h.cancelledCount(), before.cancelled, '控制页崩溃不跨链路 cancel 截图会话');
  assert.equal(h.disposedCount(), before.disposed, '也不 dispose 暖页/暖源/草稿');
  assert.equal(first.isDestroyed(), true, '死页自己收掉，不再留着被 show');
  const staled = { sender: first.webContents, senderFrame: first.webContents.mainFrame };
  assert.throws(() => h.handlers.get('window:close')(staled), /未授权/, '旧 sender 立刻失效');
  const second = await h.openControl('help');
  assert.notEqual(second, first, '下次点设置/帮助重建新窗');
  assert.equal(second.loaded, true); assert.equal(second.visible, true);
  assert.equal(h.handlers.get('window:state')({ sender: second.webContents, senderFrame: second.webContents.mainFrame }).maximized, false);
});

test('旧控制窗迟到的 closed 不清新一轮 control，旧 sender 仍被拒', async () => {
  const h = await bootHarness();
  const first = await h.openControl();
  first.destroy();
  const second = await h.openControl('help');
  const before = h.windows.length;
  first.emit('closed');
  assert.equal(h.windows.length, before, '旧窗迟到事件不建也不收新窗');
  assert.equal(second.isDestroyed(), false);
  assert.equal(second.visible, true, '新控制页仍然可见');
  assert.equal(h.handlers.get('window:state')({ sender: second.webContents, senderFrame: second.webContents.mainFrame }).maximized, false, '新窗仍是唯一合法 owner');
  assert.throws(() => h.handlers.get('window:close')({ sender: first.webContents, senderFrame: first.webContents.mainFrame }), /未授权/);
});

test('生命周期日志同步记录启动、渲染进程消失、子进程消失与正常退出，只留固定字段', async () => {
  const h = await bootHarness();
  const control = await h.openControl();
  const lines = () => h.logs.filter(entry => entry.file.endsWith('lifecycle.log')).map(entry => JSON.parse(entry.text.trim()));
  assert.deepEqual(lines().map(line => line.event), ['startup', 'hotkey-register', 'ready'], '启动、快捷键注册成功、界面就绪各写一行');
  assert.equal(h.prepares(), 1, '界面就绪后不 await 调一次 prepare');
  const startup = lines()[0];
  assert.deepEqual(Object.keys(startup).sort(), ['at', 'chrome', 'electron', 'event', 'packaged', 'pid', 'platform', 'version'].sort());
  assert.equal(startup.pid, 4242); assert.equal(startup.version, '0.0.0'); assert.equal(startup.electron, 'test');
  assert.equal(startup.chrome, 'test'); assert.equal(startup.platform, 'win32'); assert.equal(startup.packaged, false);
  const register = lines()[1];
  assert.deepEqual({ requested: register.requestedHotkey, hotkey: register.hotkey, ok: register.ok, registered: register.registered, fallback: register.fallback },
    { requested: 'F1', hotkey: 'F1', ok: true, registered: true, fallback: false });
  // 日志现在按 app 级收：不靠哪个窗口自己报，选区/浮条/提示层崩溃同样会落盘。
  h.app.emit('render-process-gone', {}, control.webContents, { reason: 'crashed', exitCode: 5 });
  h.app.emit('render-process-gone', {}, { foreign: true }, { reason: 'oom', exitCode: 9 });
  h.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 7 });
  h.app.emit('before-quit', { preventDefault() { throw new Error('正常退出不应被拦截'); } });
  h.app.emit('quit', {}, 3);
  h.processHandlers.get('exit')(3);
  const events = lines().slice(3);
  assert.deepEqual(events.map(line => line.event), ['render-process-gone', 'render-process-gone', 'child-process-gone', 'quit', 'exit']);
  assert.deepEqual([events[0].role, events[0].reason, events[0].exitCode], ['control', 'crashed', 5]);
  assert.deepEqual([events[1].role, events[1].reason, events[1].exitCode], ['other', 'oom', 9], '非 control 窗口崩溃也必须留原因');
  assert.deepEqual([events[2].type, events[2].reason, events[2].exitCode], ['GPU', 'crashed', 7]);
  assert.equal(events[3].flushing, false, '普通退出不能被写成写盘等待');
  assert.equal(events[4].exitCode, 3, 'app quit 要带 Electron 的退出码');
  const allowed = ['at', 'pid', 'event', 'version', 'electron', 'chrome', 'platform', 'packaged', 'role', 'reason', 'exitCode', 'type', 'flushing',
    // F1 重入留痕：只允许固定事件名与有限枚举/布尔字段。
    'hotkey', 'ok', 'fallback', 'captureActive', 'mode', 'phase', 'action', 'probe', 'minimized', 'visible', 'choice', 'hideControl',
    'requestedHotkey', 'registered'];
  for (const line of lines()) for (const key of Object.keys(line)) {
    assert.ok(allowed.includes(key), `生命周期日志不得出现额外字段：${key}`);
  }
});

test('app quit 未触发时由 process exit 同步补记退出码，不重复写两行', async () => {
  const h = await bootHarness();
  h.processHandlers.get('exit')(2);
  const lines = h.logs.filter(entry => entry.file.endsWith('lifecycle.log')).map(entry => JSON.parse(entry.text.trim()));
  assert.deepEqual(lines.map(line => line.event), ['startup', 'hotkey-register', 'ready', 'process-exit']);
  assert.equal(lines[3].exitCode, 2);
});

test('F1 回调与快捷键注册都留一行固定字段，无页外文本', async () => {
  const h = await bootHarness();
  const lines = () => h.logs.filter(entry => entry.file.endsWith('lifecycle.log')).map(entry => JSON.parse(entry.text.trim()));
  h.setActive(true);
  h.shortcuts.get('F1')();
  const trigger = lines().at(-1);
  assert.equal(trigger.event, 'hotkey-trigger');
  assert.deepEqual({ hotkey: trigger.hotkey, captureActive: trigger.captureActive }, { hotkey: 'F1', captureActive: true });
  assert.deepEqual(Object.keys(trigger).sort(), ['at', 'captureActive', 'event', 'hotkey', 'pid'].sort(), '只记按键与当时有无活动会话');
  const before = lines().length;
  h.hooks.onStatus({ message: 'x' });
  assert.equal(lines().length, before, '状态推送不额外写生命周期行');
  // 新键被占：回退到旧键，留痕要能看出「请求的是新键、生效的是旧键、已回退」。
  const blocked = await bootHarness({ registerFailsFor: ['Ctrl+Alt+9'] });
  const blockedLines = () => blocked.logs.filter(entry => entry.file.endsWith('lifecycle.log')).map(entry => JSON.parse(entry.text.trim()));
  const web = (await blocked.openControl()).webContents;
  assert.throws(() => blocked.handlers.get('shot:set-hotkey')({ sender: web, senderFrame: web.mainFrame }, 'Ctrl+Alt+9'), /占用了/);
  const fallbackLine = blockedLines().at(-1);
  assert.deepEqual({ event: fallbackLine.event, requestedHotkey: fallbackLine.requestedHotkey, hotkey: fallbackLine.hotkey, ok: fallbackLine.ok, registered: fallbackLine.registered, fallback: fallbackLine.fallback },
    { event: 'hotkey-register', requestedHotkey: 'Ctrl+Alt+9', hotkey: 'F1', ok: false, registered: true, fallback: true }, '请求新键失败、旧键回退成功不能写成 F1 注册失败');
  assert.equal(blocked.shortcuts.has('F1'), true, '旧键仍可用');
  // 新键与旧键都抢不到：registered 必须是实际值 false。
  const dead = await bootHarness({ registerFailsFor: ['F1', 'Ctrl+Alt+9'] });
  const deadLines = () => dead.logs.filter(entry => entry.file.endsWith('lifecycle.log')).map(entry => JSON.parse(entry.text.trim()));
  const deadWeb = (await dead.openControl()).webContents;
  assert.throws(() => dead.handlers.get('shot:set-hotkey')({ sender: deadWeb, senderFrame: deadWeb.mainFrame }, 'Ctrl+Alt+9'), /占用了/);
  const deadLine = deadLines().at(-1);
  assert.deepEqual({ requestedHotkey: deadLine.requestedHotkey, hotkey: deadLine.hotkey, ok: deadLine.ok, registered: deadLine.registered, fallback: deadLine.fallback },
    { requestedHotkey: 'Ctrl+Alt+9', hotkey: 'F1', ok: false, registered: false, fallback: false }, '双失败如实记录未注册');
});

test('跨屏不再单列入口：托盘菜单与页面都走原 start，旧 start-desktop 只留兼容', async () => {
  const h = await bootHarness();
  const web = (await h.openControl()).webContents;
  assert.equal(Object.hasOwn(h.trayMenuOptions(), 'onAction'), true);
  h.trayAction('capture'); assert.equal(h.started(), 1);
  assert.equal(h.desktopStarted(), 0);
  // 旧通道继续可用但只认设置窗口，界面已不再引用。
  assert.ok(h.handlers.has('shot:start-desktop'), '旧 IPC 通道保留兼容');
  assert.throws(() => h.handlers.get('shot:start-desktop')({ sender: {}, senderFrame: {} }), /未授权的调用来源/);
  assert.equal(h.desktopStarted(), 0);
  h.handlers.get('shot:start-desktop')({ sender: web, senderFrame: web.mainFrame });
  assert.equal(h.desktopStarted(), 1);
  h.handlers.get('shot:start')({ sender: web, senderFrame: web.mainFrame });
  assert.equal(h.started(), 2);
  assert.equal(h.startOptions.at(-1), undefined, 'F1/默认路径不带额外模式参数');
});

test('页面入口只留普通截图按钮，帮助统一说 F1/开始截图直接跨屏', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  assert.equal(html.includes('take-desktop'), false, '独立跨屏按钮不留孤儿');
  assert.equal(html.includes('跨屏截图'), false, '不再宣传单独的跨屏截图入口');
  assert.match(html, /<button id="take"[^>]*>/, '普通截图按钮保留');
  assert.match(html, /F1 或点「开始截图」/);
  const script = fs.readFileSync(path.join(__dirname, '../renderer/shot-control.js'), 'utf8');
  assert.equal(script.includes('startDesktop'), false, 'renderer 不再引用旧跨屏桥');
  assert.match(script, /window\.shot\.start\(\)/);
});

// —— 换快捷键：更改 → 录入候选 → 明确保存/取消（主进程租约） ——
const hotkeySettingsFile = () => path.join(path.resolve('test-not-written'), '截个长 · 捕获验证', 'settings.json');
const hotkeySettings = () => require('../main/settings.cjs').createSettings({ file: hotkeySettingsFile() });

test('改键租约：开始就暂停本应用的原键，F1 不再触发截图，保存成功才换键并落盘', async t => {
  t.after(() => { try { hotkeySettings().update({ hotkey: 'F1' }, { strict: true }); } catch { /* 忽略 */ } });
  const h = await bootHarness();
  const win = await h.openControl();
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  assert.equal(h.shortcuts.has('F1'), true);
  const began = h.handlers.get('shot:begin-hotkey-edit')(event);
  assert.equal(typeof began.token, 'string');
  assert.equal(began.state.hotkeyEditing, true);
  assert.equal(h.shortcuts.has('F1'), false, '录入期间卸下本应用的 F1');
  assert.equal(h.started(), 0, '没有触发截图');
  const saved = h.handlers.get('shot:set-hotkey')(event, 'Ctrl+Alt+8', began.token);
  assert.equal(saved.hotkey, 'Ctrl+Alt+8');
  assert.equal(saved.hotkeyEditing, false);
  assert.equal(saved.hotkeyRegistered, true);
  assert.ok(h.tray.tooltip.includes('Ctrl + Alt + 8 截图'), '托盘提示跟随新键，不写死 F1');
  assert.equal(h.shortcuts.has('Ctrl+Alt+8'), true, '新键已注册');
  assert.equal(h.shortcuts.has('F1'), false, '旧键不再占');
  assert.equal(hotkeySettings().get().hotkey, 'Ctrl+Alt+8', '严格写入成功，重启能读回');
  // 租约结束后，无 token 的旧路径仍然可用。
  assert.equal(h.handlers.get('shot:set-hotkey')(event, 'Ctrl+Alt+7').hotkey, 'Ctrl+Alt+7');
  assert.equal(h.shortcuts.has('Ctrl+Alt+7'), true);
});

test('改键冲突：新键被占不写设置、不结束租约；取消后恢复原 F1', async t => {
  t.after(() => { try { hotkeySettings().update({ hotkey: 'F1' }, { strict: true }); } catch { /* 忽略 */ } });
  const h = await bootHarness({ registerFailsFor: ['Ctrl+Alt+9'] });
  const win = await h.openControl();
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const began = h.handlers.get('shot:begin-hotkey-edit')(event);
  assert.throws(() => h.handlers.get('shot:set-hotkey')(event, 'Ctrl+Alt+9', began.token), /占用了/);
  assert.equal(h.shortcuts.has('Ctrl+Alt+9'), false);
  const state = h.handlers.get('shot:state')(event);
  assert.equal(state.hotkeyEditing, true, '冲突不结束租约');
  assert.equal(state.hotkey, 'F1', 'currentHotkey 没变');
  assert.equal(state.hotkeyRegistered, false, '旧键仍在暂停中');
  const ended = h.handlers.get('shot:end-hotkey-edit')(event, began.token);
  assert.equal(ended.hotkeyEditing, false);
  assert.equal(h.shortcuts.has('F1'), true, '取消恢复原键');
  assert.equal(ended.hotkeyRegistered, true);
});

test('改键写盘失败：撤回新键、保持旧 current 与租约，取消后恢复', async t => {
  t.after(() => { try { hotkeySettings().update({ hotkey: 'F1' }, { strict: true }); } catch { /* 忽略 */ } });
  const h = await bootHarness();
  const win = await h.openControl();
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const block = `${hotkeySettingsFile()}.tmp`;
  fs.rmSync(block, { recursive: true, force: true });
  fs.mkdirSync(block, { recursive: true });
  t.after(() => fs.rmSync(block, { recursive: true, force: true }));
  const began = h.handlers.get('shot:begin-hotkey-edit')(event);
  assert.throws(() => h.handlers.get('shot:set-hotkey')(event, 'Ctrl+Alt+6', began.token), /没有保存成功/);
  assert.equal(h.shortcuts.has('Ctrl+Alt+6'), false, '写失败的新键已撤回');
  assert.equal(h.shortcuts.has('F1'), false, '旧键仍是暂停状态（租约还在）');
  const state = h.handlers.get('shot:state')(event);
  assert.equal(state.hotkeyEditing, true);
  assert.equal(state.hotkey, 'F1');
  fs.rmSync(block, { recursive: true, force: true });
  assert.equal(h.handlers.get('shot:end-hotkey-edit')(event, began.token).hotkeyRegistered, true);
  assert.equal(h.shortcuts.has('F1'), true, '取消后旧键回来');
});

test('租约兜底：blur / hide / 页面崩溃 / 关窗都恢复原键，迟到 token 无效', async t => {
  t.after(() => { try { hotkeySettings().update({ hotkey: 'F1' }, { strict: true }); } catch { /* 忽略 */ } });
  for (const kind of ['blur', 'hide', 'renderer-gone', 'navigation', 'closed']) {
    const h = await bootHarness();
    const win = await h.openControl();
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    const began = h.handlers.get('shot:begin-hotkey-edit')(event);
    assert.equal(h.shortcuts.has('F1'), false, `${kind}: 先暂停`);
    if (kind === 'blur') win.emit('blur');
    else if (kind === 'hide') win.emit('hide');
    else if (kind === 'renderer-gone') win.webContents.emit('render-process-gone');
    else if (kind === 'navigation') win.webContents.emit('did-start-navigation');
    else win.destroy();
    assert.equal(h.shortcuts.has('F1'), true, `${kind} 后原键自动恢复`);
    assert.throws(() => h.handlers.get('shot:set-hotkey')(event, 'Ctrl+Alt+4', began.token), /已失效|未授权/);
  }
});

test('旧控制页的迟到事件不收新租约：owner 不同一概不理', async t => {
  t.after(() => { try { hotkeySettings().update({ hotkey: 'F1' }, { strict: true }); } catch { /* 忽略 */ } });
  const h = await bootHarness();
  const oldWin = await h.openControl();
  const oldEvent = { sender: oldWin.webContents, senderFrame: oldWin.webContents.mainFrame };
  const oldLease = h.handlers.get('shot:begin-hotkey-edit')(oldEvent);
  oldWin.destroy();
  assert.equal(h.shortcuts.has('F1'), true, '旧页真关掉时自己的租约照常恢复');
  const win = await h.openControl();
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const lease = h.handlers.get('shot:begin-hotkey-edit')(event);
  assert.equal(h.shortcuts.has('F1'), false);
  // 旧页迟到的 closed / 崩溃 / blur / hide / 导航都不能动这一轮。
  oldWin.emit('closed'); oldWin.emit('blur'); oldWin.emit('hide');
  oldWin.webContents.emit('render-process-gone'); oldWin.webContents.emit('did-start-navigation');
  const state = h.handlers.get('shot:state')(event);
  assert.equal(state.hotkeyEditing, true, '新租约还在');
  assert.equal(state.hotkeyRegistered, false, '原键仍是暂停态');
  assert.equal(h.shortcuts.has('F1'), false, '旧页事件没把 F1 抢回来');
  assert.throws(() => h.handlers.get('shot:set-hotkey')(event, 'Ctrl+Alt+8', oldLease.token), /已失效/);
  const saved = h.handlers.get('shot:set-hotkey')(event, 'Ctrl+Alt+8', lease.token);
  assert.equal(saved.hotkey, 'Ctrl+Alt+8', '新租约照常能存');
  assert.equal(hotkeySettings().get().hotkey, 'Ctrl+Alt+8', '并且真的落盘');
});

test('保存入口再核一遍前台：租约中还隐藏/失焦就不抢键、不落盘', async t => {
  t.after(() => { try { hotkeySettings().update({ hotkey: 'F1' }, { strict: true }); } catch { /* 忽略 */ } });
  const h = await bootHarness();
  const win = await h.openControl();
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const lease = h.handlers.get('shot:begin-hotkey-edit')(event);
  // 不发 hide 事件：直接改状态，验保存入口自己也在看前台。
  win.visible = false;
  assert.throws(() => h.handlers.get('shot:set-hotkey')(event, 'Ctrl+Alt+5', lease.token), /不在前台/);
  assert.equal(h.shortcuts.has('Ctrl+Alt+5'), false, '被拒时没抢新键');
  assert.equal(h.handlers.get('shot:state')(event).hotkeyEditing, true, '租约还在');
  win.visible = true; win.focused = false;
  assert.throws(() => h.handlers.get('shot:set-hotkey')(event, 'Ctrl+Alt+5', lease.token), /不在前台/);
  win.focused = true;
  assert.equal(h.handlers.get('shot:set-hotkey')(event, 'Ctrl+Alt+5', lease.token).hotkey, 'Ctrl+Alt+5', '回到前台就能存');
});

test('租约开始必须窗口在前台且不在截图：忙/隐藏/无焦点都拒绝，重复开始也拒绝', async () => {
  const h = await bootHarness();
  const win = await h.openControl();
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  h.setActive(true);
  assert.throws(() => h.handlers.get('shot:begin-hotkey-edit')(event), /截图或验证进行中/);
  assert.equal(h.shortcuts.has('F1'), true, '拒绝时不动现有注册');
  h.setActive(false);
  win.visible = false;
  assert.throws(() => h.handlers.get('shot:begin-hotkey-edit')(event), /不在前台/);
  win.visible = true; win.focused = false;
  assert.throws(() => h.handlers.get('shot:begin-hotkey-edit')(event), /不在前台/);
  win.focused = true;
  const began = h.handlers.get('shot:begin-hotkey-edit')(event);
  assert.equal(typeof began.token, 'string');
  assert.throws(() => h.handlers.get('shot:begin-hotkey-edit')(event), /已经在修改/);
  assert.throws(() => h.handlers.get('shot:retry-hotkey')(event), /先保存或取消/);
  h.handlers.get('shot:end-hotkey-edit')(event, began.token);
});

test('租约开始卸不下原键：报错、不建租约、注册状态保留，F1 照样能截图', async () => {
  const h = await bootHarness({ unregisterThrowsFor: ['F1'] });
  const win = await h.openControl();
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  assert.throws(() => h.handlers.get('shot:begin-hotkey-edit')(event), /没法暂停/);
  const state = h.handlers.get('shot:state')(event);
  assert.equal(state.hotkeyEditing, false, '没建租约');
  assert.equal(state.hotkeyRegistered, true, '不能声称已暂停');
  assert.equal(h.shortcuts.has('F1'), true, '原键仍在');
  h.shortcuts.get('F1')();
  assert.equal(h.started(), 1, '键没被卸下，F1 仍能触发截图');
  assert.equal(h.handlers.get('shot:end-hotkey-edit')(event, 'tok-x').hotkeyEditing, false, '没租约时结束是空操作');
  assert.throws(() => h.handlers.get('shot:set-hotkey')(event, 'Ctrl+Alt+2', 'tok-x'), /已失效/, '没租约也不认旧 token');
});

test('改键 token：结束后的旧 token、外来 sender 一律拒绝', async () => {
  const h = await bootHarness();
  const win = await h.openControl();
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const began = h.handlers.get('shot:begin-hotkey-edit')(event);
  assert.equal(h.handlers.get('shot:end-hotkey-edit')(event, began.token).hotkeyEditing, false);
  assert.throws(() => h.handlers.get('shot:set-hotkey')(event, 'Ctrl+Alt+4', began.token), /已失效/);
  assert.equal(h.shortcuts.has('Ctrl+Alt+4'), false);
  // 外来 sender 不能开始/结束/保存。
  const foreign = { sender: {}, senderFrame: {} };
  for (const name of ['shot:begin-hotkey-edit', 'shot:end-hotkey-edit', 'shot:set-hotkey']) {
    assert.throws(() => h.handlers.get(name)(foreign, 'x', 'y'), /未授权/, `${name} 外来 sender 被拒`);
  }
  // 没有租约时再来一轮，旧 token 仍然对不上。
  const second = h.handlers.get('shot:begin-hotkey-edit')(event);
  assert.notEqual(second.token, began.token);
  assert.throws(() => h.handlers.get('shot:set-hotkey')(event, 'Ctrl+Alt+4', began.token), /已失效/);
  h.handlers.get('shot:end-hotkey-edit')(event, second.token);
});

test('shot-control 纯 VM：改键是“更改→候选→保存/取消”，候选不自动提交', async () => {
  const elements = new Map();
  const node = key => {
    if (!elements.has(key)) {
      const listeners = new Map();
      const classes = new Set();
      elements.set(key, { hidden: false, disabled: false, textContent: '', title: '', style: {}, dataset: {}, attrs: {}, focused: false,
        classList: {
          add(name) { classes.add(name); },
          remove(name) { classes.delete(name); },
          contains: name => classes.has(name),
          toggle(name, on) {
            if (on === undefined) { if (classes.has(name)) classes.delete(name); else classes.add(name); }
            else if (on === true) classes.add(name); else classes.delete(name);
          }
        },
        setAttribute(name, value) { this.attrs[name] = value; }, removeAttribute(name) { delete this.attrs[name]; },
        toggleAttribute() {}, focus() { this.focused = true; }, scrollTo() {}, contains: () => false,
        addEventListener(type, fn) { listeners.set(type, fn); }, emit(type, event) { listeners.get(type)?.(event); },
        onclick: null,
        // 真实 DOM 里禁用的按钮不派发 click：这里照样拦，才能验出“灰着点不动”。
        click() { if (this.disabled) return; this.emit('click', {}); this.onclick?.(); } });
    }
    return elements.get(key);
  };
  const windowListeners = new Map();
  let docFocused = true;
  const document = { hasFocus: () => docFocused, querySelector: selector => node(selector), querySelectorAll: () => [], addEventListener() {} };
  const baseState = (over = {}) => ({ hotkeyLabel: 'F1', hotkeyRegistered: true, hotkeyEditing: false, message: '就绪',
    autoLaunch: false, saveFolder: '', diagnostic: {}, ...over });
  let pendingBegin, pendingSave, pendingEnd, statusCallback, sectionCallback;
  const saves = [], ends = [];
  const shot = {
    state: async () => baseState(),
    onStatus(callback) { statusCallback = callback; },
    onFocusSettings() {}, onFocusSection(callback) { sectionCallback = callback; }, onWindowState() {}, windowState: async () => ({ maximized: false }),
    start: async () => {}, startDesktop: async () => {}, retryHotkey: async () => ({}), openLast: async () => {}, openDiagnostic: async () => {},
    chooseSaveFolder: async () => baseState(), setAutoLaunch: async () => baseState(), openDirectory: async () => {},
    minimizeWindow: async () => {}, toggleMaximize: async () => {}, closeWindow: async () => {},
    beginHotkeyEdit: () => new Promise(resolve => { pendingBegin = resolve; }),
    setHotkey: (accelerator, token) => { saves.push({ accelerator, token }); return new Promise((resolve, reject) => { pendingSave = { resolve, reject }; }); },
    endHotkeyEdit: token => { ends.push(token); return Promise.resolve(baseState()); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/shot-control.js'), 'utf8'),
    { document, window: { shot, addEventListener: (type, fn) => windowListeners.set(type, fn), removeEventListener() {} } });
  await tick();
  // 与 renderer/index.html 对齐：#hotkey-save 一开始就是 disabled（脚本不该擅自点亮）。
  elements.get('#hotkey-save').disabled = true;
  const display = () => elements.get('#hotkey-display').textContent;
  const capture = () => elements.get('#hotkey-capture');
  const editor = () => elements.get('#hotkey-editor');
  const help = () => elements.get('#hotkey-help').textContent;
  const key = (values) => capture().emit('keydown', { preventDefault() {}, stopPropagation() {}, ...values });
  const helpEl = () => elements.get('#hotkey-help');
  assert.equal(display(), 'F1', '当前键写在独立显示位');
  assert.equal(elements.get('#hotkey-save').disabled, true, 'HTML 初始就是灰的保存键');

  // 更改 → begin 在飞 → 回包后才开编辑器。
  elements.get('#hotkey-button').click();
  await tick();
  pendingBegin({ token: 'tok-1', state: baseState({ hotkeyEditing: true }) });
  await tick(); await tick();
  assert.equal(editor().hidden, false, '打开编辑器');
  assert.equal(capture().focused, true, '焦点进录入区');
  assert.equal(capture().textContent, '按下新组合键…');
  assert.equal(capture().classList.contains('recording'), true, '录入中高亮录入区');
  assert.equal(elements.get('#hotkey-button').classList.contains('recording'), true);
  assert.equal(elements.get('#hotkey-button').attrs['aria-expanded'], 'true', '展开态跟上');
  assert.equal(elements.get('#hotkey-save').disabled, true, '没候选时保存仍不可点');
  assert.equal(helpEl().classList.contains('warning'), false, '开场提示不是警告态');
  // Tab 不拦（可移到保存/取消）。
  let tabPrevented = false;
  capture().emit('keydown', { key: 'Tab', preventDefault() { tabPrevented = true; }, stopPropagation() {} });
  assert.equal(tabPrevented, false, 'Tab 保持普通导航');
  // 候选不自动提交。
  key({ key: 'F2', code: 'F2' });
  assert.equal(saves.length, 0, '录键不直接保存');
  key({ key: 'Enter', isComposing: true });
  assert.equal(saves.length, 0, '输入法确认不能提交快捷键');
  assert.equal(capture().textContent, 'F2');
  assert.equal(elements.get('#hotkey-save').disabled, false, '合法候选才把保存键点亮');
  // 别的状态回包不换掉正在录的候选。
  statusCallback(baseState({ message: '快捷键已就绪', hotkeyEditing: true }));
  assert.equal(capture().textContent, 'F2', 'showState 不碰候选');
  // 有候选后点按钮（不是 Enter）也能保存，并带上 token。
  elements.get('#hotkey-save').click();
  assert.deepEqual(saves, [{ accelerator: 'F2', token: 'tok-1' }]);
  assert.equal(elements.get('#hotkey-save').disabled, true, '保存中全锁');
  pendingSave.resolve(baseState({ hotkeyLabel: 'F2' }));
  await tick(); await tick();
  assert.equal(editor().hidden, true, '成功后关编辑器');
  assert.equal(display(), 'F2');
  assert.match(help(), /已经生效/);
  assert.equal(elements.get('#hotkey-button').focused, true, '解禁后焦点回到更改按钮');
  assert.equal(elements.get('#hotkey-button').classList.contains('recording'), false, '收起后不再高亮');
  assert.equal(elements.get('#hotkey-button').attrs['aria-expanded'], 'false');

  // 第二次：录多个键以最后一个为准，Esc 取消并交回 token。
  elements.get('#hotkey-button').click();
  await tick();
  pendingBegin({ token: 'tok-2', state: baseState({ hotkeyLabel: 'F2', hotkeyEditing: true }) });
  await tick(); await tick();
  key({ key: 'F3', code: 'F3' });
  key({ key: 'F4', code: 'F4' });
  assert.equal(capture().textContent, 'F4', '后按的覆盖候选');
  key({ key: 'Escape' });
  await tick();
  assert.deepEqual(ends, ['tok-2'], '取消交回 token');
  assert.equal(editor().hidden, true);

  // 第三次：保存失败保留候选与错误，可再取消。
  elements.get('#hotkey-button').click();
  await tick();
  pendingBegin({ token: 'tok-3', state: baseState({ hotkeyEditing: true }) });
  await tick(); await tick();
  key({ key: '5', code: 'Digit5', ctrlKey: true, altKey: true });
  assert.equal(capture().textContent, 'Ctrl + Alt + 5');
  key({ key: 'Enter' });
  pendingSave.reject(new Error('Ctrl+Alt+5 被其他程序占用了'));
  await tick(); await tick();
  assert.equal(editor().hidden, false, '失败不关编辑器');
  assert.equal(capture().textContent, 'Ctrl + Alt + 5', '候选保留');
  assert.match(help(), /没能保存/);
  // 修饰键只显示临时值；非法单键就地提示。
  key({ key: 'Control', ctrlKey: true });
  assert.equal(capture().textContent, 'Ctrl + …');
  assert.equal(elements.get('#hotkey-save').disabled, true, '不完整组合不能暗存上次候选');
  key({ key: 'a', code: 'KeyA' });
  assert.match(help(), /单键只能用功能键/);
  assert.equal(elements.get('#hotkey-save').disabled, true, '非法组合清掉旧候选');
  key({ key: 'Tab', code: 'Tab', ctrlKey: true });
  assert.equal(capture().textContent, 'Ctrl + Tab', '改键时可录 Ctrl+Tab，普通Tab才做导航');
  assert.equal(elements.get('#hotkey-save').disabled, false);
  key({ key: 'Escape' }); await tick();
  assert.equal(ends.at(-1), 'tok-3');

  // begin 回包前按 Esc：回包后立刻结束主进程租约，不打开编辑器。
  elements.get('#hotkey-button').click();
  await tick();
  windowListeners.get('keydown')({ key: 'Escape', preventDefault() {} });
  pendingBegin({ token: 'tok-4', state: baseState({ hotkeyEditing: true }) });
  await tick(); await tick();
  assert.equal(ends.at(-1), 'tok-4', '迟到回包也把租约结束');
  assert.equal(editor().hidden, true, '不打开编辑器');

  // 再开一次：候选清空、保存键回灰（不沿用上次残留）。
  ends.length = 0;
  elements.get('#hotkey-button').click();
  await tick();
  pendingBegin({ token: 'tok-5', state: baseState({ hotkeyLabel: 'F2', hotkeyEditing: true }) });
  await tick(); await tick();
  assert.equal(capture().textContent, '按下新组合键…', '每次打开都从空候选开始');
  assert.equal(elements.get('#hotkey-save').disabled, true, '每次打开保存键回灰');
  assert.equal(helpEl().classList.contains('warning'), false, '上次的红字不延续');
  // 主进程已收掉租约（失焦/崩溃）：新的 state 说 editing=false，残留编辑器要自己收起。
  statusCallback(baseState({ hotkeyLabel: 'F2', hotkeyEditing: false }));
  assert.equal(editor().hidden, true, 'stale lease 的编辑器自动收起');
  assert.equal(elements.get('#hotkey-button').attrs['aria-expanded'], 'false');
  assert.equal(ends.length, 0, '主进程已经收过，不再重复交回 token');

  // 开着的编辑器遇窗口失焦：收起、不抢焦点、不重复结束租约。
  elements.get('#hotkey-button').click();
  await tick();
  pendingBegin({ token: 'tok-6', state: baseState({ hotkeyLabel: 'F2', hotkeyEditing: true }) });
  await tick(); await tick();
  assert.equal(editor().hidden, false);
  elements.get('#hotkey-button').focused = false;
  windowListeners.get('blur')();
  assert.equal(editor().hidden, true, '失焦收起编辑器');
  assert.equal(capture().classList.contains('recording'), false);
  assert.equal(elements.get('#hotkey-button').focused, false, '失焦时不把焦点抢回来');
  assert.equal(ends.length, 0, '失焦由主进程兜底，不重复交回');

  // begin 在飞时窗口失焦：晚回包不会再复活编辑器，并且把租约结束掉。
  elements.get('#hotkey-button').click();
  await tick();
  windowListeners.get('blur')();
  pendingBegin({ token: 'tok-7', state: baseState({ hotkeyLabel: 'F2', hotkeyEditing: true }) });
  await tick(); await tick();
  assert.equal(editor().hidden, true, '失焦后的迟到回包不开编辑器');
  assert.deepEqual(ends, ['tok-7'], '迟到的 token 也要结束掉');
  // 页面卸载同样把在飞的 begin 标记为取消。
  ends.length = 0;
  elements.get('#hotkey-button').click();
  await tick();
  windowListeners.get('pagehide')();
  pendingBegin({ token: 'tok-8', state: baseState({ hotkeyLabel: 'F2', hotkeyEditing: true }) });
  await tick(); await tick();
  assert.equal(editor().hidden, true, 'pagehide 后的迟到回包不开编辑器');
  assert.deepEqual(ends, ['tok-8'], 'pagehide 后晚回包也交回 token');

  // 非法键与保存失败都是警告态；页面已失焦时成功后不抢焦点。
  elements.get('#hotkey-button').click();
  await tick();
  pendingBegin({ token: 'tok-9', state: baseState({ hotkeyLabel: 'F2', hotkeyEditing: true }) });
  await tick(); await tick();
  key({ key: '3', code: 'Digit3' });
  assert.equal(helpEl().classList.contains('warning'), true, '非法单键提示是警告态');
  key({ key: 'F5', code: 'F5' });
  assert.equal(helpEl().classList.contains('warning'), false, '合法候选后回到普通提示');
  key({ key: 'Enter' });
  assert.equal(capture().disabled, true, '保存中录入区锁住');
  docFocused = false;
  pendingSave.resolve(baseState({ hotkeyLabel: 'F5' }));
  await tick(); await tick();
  assert.equal(editor().hidden, true);
  assert.equal(elements.get('#hotkey-button').focused, false, '页面不在前台就不抢焦点');
  docFocused = true;

  // 导航发生在 begin 回包前，也不能在帮助页复活改键或留下暂停的原键。
  ends.length = 0;
  elements.get('#hotkey-button').click();
  await tick();
  sectionCallback('help');
  pendingBegin({ token: 'tok-10', state: baseState({ hotkeyEditing: true }) });
  await tick(); await tick();
  assert.equal(editor().hidden, true);
  assert.deepEqual(ends, ['tok-10'], '切页后的迟到租约立即交回');
});

test('shot-control 纯 VM：素面板一下主题三按钮互斥回填、请求期间禁用、失败回显旧态', async () => {
  const elements = new Map();
  const element = key => {
    if (!elements.has(key)) elements.set(key, { hidden: false, disabled: false, textContent: '', title: '', style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {}, toggleAttribute() {}, focus() {},
      contains: () => false, addEventListener() {} });
    return elements.get(key);
  };
  const themeButtons = ['system', 'light', 'dark'].map(source => ({
    dataset: { themeSource: source }, disabled: false, pressed: undefined,
    setAttribute(name, value) { if (name === 'aria-pressed') this.pressed = value; },
    addEventListener(type, fn) { if (type === 'click') this.click = fn; }
  }));
  const document = {
    querySelector: selector => element(selector),
    querySelectorAll: selector => {
      if (selector === 'nav [data-section]') return [
        Object.assign(element('nav-settings'), { dataset: { section: 'settings' } }),
        Object.assign(element('nav-help'), { dataset: { section: 'help' } })];
      if (selector === '[data-theme-source]') return themeButtons;
      return [];
    },
    addEventListener() {}
  };
  const baseState = (source = 'system') => ({ hotkeyRegistered: true, hotkeyLabel: 'F1', message: '就绪', autoLaunch: false,
    saveFolder: '', diagnostic: {}, theme: { source, dark: source === 'dark' } });
  let statusCallback = null;
  const pending = [];
  const shot = {
    state: async () => baseState('system'),
    onStatus(callback) { statusCallback = callback; },
    onFocusSettings() {}, onFocusSection() {}, onWindowState() {}, windowState: async () => ({ maximized: false }),
    start: async () => {}, startDesktop: async () => {}, retryHotkey: async () => ({}), openLast: async () => {}, openDiagnostic: async () => {},
    setTheme: source => new Promise((resolve, reject) => { pending.push({ source, resolve, reject }); }),
    minimizeWindow: async () => {}, toggleMaximize: async () => {}, closeWindow: async () => {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/shot-control.js'), 'utf8'),
    { document, window: { shot, addEventListener() {}, removeEventListener() {} } });
  await tick();
  const pressed = () => themeButtons.filter(button => button.pressed === 'true').map(button => button.dataset.themeSource);
  assert.deepEqual(pressed(), ['system'], '初始按 state 回填');
  themeButtons[2].click();
  await tick();
  assert.deepEqual(pressed(), ['dark'], '点了就先回填，不等到回包');
  assert.equal(themeButtons.every(button => button.disabled === true), true, '请求期间三个按钮都禁用');
  assert.equal(pending.length, 1); assert.equal(pending[0].source, 'dark');
  // 待存档期间别的状态回包不能把选择抢回去。
  statusCallback({ ...baseState('system'), message: '快捷键已就绪' });
  assert.deepEqual(pressed(), ['dark'], 'pending 期间不被别的回包重置');
  themeButtons[1].click(); await tick();
  assert.equal(pending.length, 1, '禁用期间连点不会发第二个请求');
  pending[0].resolve(baseState('dark'));
  await tick(); await tick();
  assert.deepEqual(pressed(), ['dark']);
  assert.equal(themeButtons.every(button => button.disabled === false), true, '终于恢复可点');
  // 失败：回显旧态 + 提示，不假装成功。
  themeButtons[1].click(); await tick();
  assert.deepEqual(pressed(), ['light']);
  pending[1].reject(new Error('主题设置无效'));
  await tick(); await tick();
  assert.deepEqual(pressed(), ['dark'], '失败回到上一次生效的值');
  assert.match(elements.get('#shot-status').textContent, /主题设置无效/);
  assert.equal(themeButtons.every(button => button.disabled === false), true, '失败后也恢复可点');
});

test('设置页有界面主题三按钮，theme.css 最后加载，CSP 不变', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  const group = /<div id="theme-group"[^>]*role="group"[^>]*aria-label="界面主题">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(group, '主题行要有 role=group + aria-label 的分组容器');
  assert.match(group[0], /id="theme-group" class="row-actions"/);
  const buttons = [...group[1].matchAll(/<button type="button" data-theme-source="(system|light|dark)" aria-pressed="(true|false)">([^<]+)<\/button>/g)];
  assert.deepEqual(buttons.map(item => item[1]), ['system', 'light', 'dark'], '三个真实 button，顺序固定');
  assert.deepEqual(buttons.map(item => item[3]), ['跟随系统', '浅色', '深色']);
  assert.deepEqual(buttons.map(item => item[2]), ['true', 'false', 'false'], '初始互斥');
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(item => item[1]);
  assert.equal(links.at(-1), 'theme.css', 'theme.css 必须最后加载');
  assert.equal(links.filter(href => href === 'theme.css').length, 1, '只引一次');
  assert.match(html, /style-src 'self'/, 'CSP 不改');
  assert.doesNotMatch(html, /unsafe-inline/, '不为主题放开内联样式');
});

test('shoot-control 纯 VM：唯一截图按钮点击就调原 start，没有第二个入口', async () => {
  const elements = new Map(), calls = [];
  const element = key => {
    if (!elements.has(key)) elements.set(key, { hidden: false, disabled: false, textContent: '', title: '', style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {}, toggleAttribute() {}, focus() {},
      contains: () => false, addEventListener() {} });
    return elements.get(key);
  };
  const document = {
    querySelector: selector => element(selector),
    querySelectorAll: selector => selector === 'nav [data-section]' ? [
      Object.assign(element('nav-settings'), { dataset: { section: 'settings' } }),
      Object.assign(element('nav-help'), { dataset: { section: 'help' } })] : [],
    addEventListener() {}
  };
  const shot = {
    state: async () => ({ hotkeyRegistered: true, hotkeyLabel: 'F1', message: '就绪', autoLaunch: false, saveFolder: '', diagnostic: {} }),
    onStatus() {}, onFocusSettings() {}, onFocusSection() {}, onWindowState() {}, windowState: async () => ({ maximized: false }),
    start: async () => { calls.push('shot:start'); },
    startDesktop: async () => { calls.push('shot:start-desktop'); },
    retryHotkey: async () => ({}), openLast: async () => {}, openDiagnostic: async () => {},
    minimizeWindow: async () => {}, toggleMaximize: async () => {}, closeWindow: async () => {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/shot-control.js'), 'utf8'),
    { document, window: { shot, addEventListener() {}, removeEventListener() {} } });
  await tick();
  assert.equal(typeof elements.get('#take').onclick, 'function');
  await elements.get('#take').onclick();
  assert.deepEqual(calls, ['shot:start'], '普通开始入口就调原 start，不绕跨屏桥');
  assert.equal(elements.get('#take').disabled, false);
});
