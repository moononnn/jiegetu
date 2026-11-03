'use strict';
// 主题模块（main/theme.cjs）：三态意图、nativeTheme.themeSource 驱动、以及只给不透明 UI 窗上色。
// 全部用替身：不启动 Electron、不建真实窗口、不读用户文件。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTheme, SOURCES, COLORS } = require('../main/theme.cjs');

function nativeThemeStub({ dark = false } = {}) {
  const events = new EventEmitter();
  return Object.assign(events, {
    themeSource: 'system',
    shouldUseDarkColors: dark,
    listeners: () => events.listenerCount('updated')
  });
}
function settingsStub(initial = {}) {
  let state = { hotkey: 'F1', autoLaunch: false, saveFolder: '', lastSaveFolder: '', theme: 'system', ...initial };
  const updates = [];
  const stub = {
    updates,
    failWrites: false,
    get: () => ({ ...state }),
    update(patch = {}, options = {}) {
      updates.push({ ...patch, options: { ...options } });
      if ('theme' in patch && !SOURCES.includes(patch.theme)) throw new Error('主题设置无效');
      // 严格写入且磁盘不可写：真实 settings 会在这里抛，内存不变。
      if (stub.failWrites && options.strict === true) throw new Error('设置没有保存成功，已保留原来的设置');
      state = { ...state, ...patch };
      return { ...state };
    }
  };
  return stub;
}
function windowStub() {
  const win = new EventEmitter();
  win.backgrounds = [];
  win.overlays = [];
  win.accents = [];
  win.destroyed = false;
  win.setBackgroundColor = color => { win.backgrounds.push(color); };
  win.setTitleBarOverlay = options => { win.overlays.push({ ...options }); };
  win.setAccentColor = color => { win.accents.push(color); };
  win.isDestroyed = () => win.destroyed;
  win.close = () => { win.destroyed = true; win.emit('closed'); };
  return win;
}

test('三态：启动就把保存的意图交给 nativeTheme，颜色读 shouldUseDarkColors', () => {
  for (const source of SOURCES) {
    const nativeTheme = nativeThemeStub({ dark: source === 'dark' });
    const theme = createTheme({ nativeTheme, settings: settingsStub({ theme: source }) });
    assert.equal(nativeTheme.themeSource, source, `保存 ${source} 时启动直接落到 themeSource`);
    assert.deepEqual(theme.state(), { source, dark: source === 'dark' });
  }
  // 读旧设置（没有 theme）/ 磁盘上是非法值：都按 system。
  for (const stored of [undefined, 'neon', 1, null]) {
    const settings = settingsStub();
    settings.get = () => ({ ...settings.get(), theme: stored });
    const nativeTheme = nativeThemeStub();
    const theme = createTheme({ nativeTheme, settings });
    assert.equal(nativeTheme.themeSource, 'system', `磁盘值 ${JSON.stringify(stored)} 回到 system`);
    assert.equal(theme.state().source, 'system');
  }
});

test('set：白名单 → 先写设置再改 themeSource；非法值不写不改', () => {
  const nativeTheme = nativeThemeStub();
  const settings = settingsStub();
  const theme = createTheme({ nativeTheme, settings });
  for (const source of SOURCES) {
    const next = theme.set(source);
    assert.equal(next.source, source);
    assert.equal(nativeTheme.themeSource, source);
    assert.deepEqual(settings.updates.at(-1), { theme: source, options: { strict: true } }, '只写 theme，且用严格写入');
    assert.equal(settings.get().theme, source);
  }
  settings.updates.length = 0;
  theme.set('light');                 // 先固定一个已知状态
  settings.updates.length = 0;
  nativeTheme.themeSource = 'light';
  for (const bad of ['neon', '', 'Light', null, undefined, 1, {}]) {
    assert.throws(() => theme.set(bad), /无效的主题设置/);
    assert.equal(settings.updates.length, 0, '非法值连设置都不写');
    assert.equal(nativeTheme.themeSource, 'light', 'themeSource 也不动');
    assert.equal(theme.state().source, 'light');
  }
});

test('set：设置保存不住（返回值与请求不符）要明确报错，不改主题', () => {  const nativeTheme = nativeThemeStub();
  const settings = settingsStub();
  const theme = createTheme({ nativeTheme, settings });
  const realUpdate = settings.update;
  settings.update = () => ({ theme: 'system' });   // 假装写了但没生效
  nativeTheme.themeSource = 'system';
  assert.throws(() => theme.set('dark'), /没有保存成功/);
  assert.equal(nativeTheme.themeSource, 'system');
  settings.update = realUpdate;
});

test('set 严格写入：落盘失败时抛错，themeSource 与 state 都不动，修好后才能生效', () => {
  const nativeTheme = nativeThemeStub();
  const settings = settingsStub();
  const theme = createTheme({ nativeTheme, settings });
  theme.set('light');
  const before = theme.state();
  settings.failWrites = true;
  assert.throws(() => theme.set('dark'), /设置没有保存成功/);
  assert.equal(nativeTheme.themeSource, 'light', '没写成就不改 nativeTheme');
  assert.deepEqual(theme.state(), before, 'state 仍是上一个已保存的意图');
  assert.equal(settings.get().theme, 'light', '设置里也没变');
  settings.failWrites = false;
  assert.equal(theme.set('dark').source, 'dark', '磁盘恢复后可正常切');
  assert.equal(nativeTheme.themeSource, 'dark');
});

test('bind：建窗就上色；带标题栏的窗额外拿叠加色与强调色，其它窗只改背景', () => {
  const light = nativeThemeStub({ dark: false });
  const theme = createTheme({ nativeTheme: light, settings: settingsStub() });
  const control = windowStub();
  const editor = windowStub();
  theme.bind(control);
  theme.bind(editor, { titleBarOverlay: true });
  assert.deepEqual(control.backgrounds, [COLORS.light.background], '初次立即上色，不等事件');
  assert.deepEqual(control.overlays, [], '普通设置页不动标题栏叠加');
  assert.deepEqual(control.accents, []);
  assert.deepEqual(editor.backgrounds, [COLORS.light.background]);
  assert.deepEqual(editor.overlays, [{ color: COLORS.light.titleBar, symbolColor: COLORS.light.symbol, height: 36 }]);
  assert.deepEqual(editor.accents, [COLORS.light.accent]);
});

test('bind：nativeTheme.updated 按当前解析色刷新所有已绑窗；浅/深切换成对生效', () => {
  const nativeTheme = nativeThemeStub({ dark: false });
  const theme = createTheme({ nativeTheme, settings: settingsStub() });
  const control = windowStub();
  const editor = windowStub();
  theme.bind(control);
  theme.bind(editor, { titleBarOverlay: true });
  nativeTheme.shouldUseDarkColors = true;
  nativeTheme.emit('updated');
  assert.equal(control.backgrounds.at(-1), COLORS.dark.background);
  assert.deepEqual(editor.overlays.at(-1), { color: COLORS.dark.titleBar, symbolColor: COLORS.dark.symbol, height: 36 });
  assert.equal(editor.accents.at(-1), COLORS.dark.accent);
  nativeTheme.shouldUseDarkColors = false;
  nativeTheme.emit('updated');
  assert.equal(control.backgrounds.at(-1), COLORS.light.background);
  assert.equal(editor.accents.at(-1), COLORS.light.accent);
});

test('bind：窗口 closed 只摘自己；最后一个关掉或 dispose 后不再监听，也不再改已关窗', () => {
  const nativeTheme = nativeThemeStub({ dark: false });
  const theme = createTheme({ nativeTheme, settings: settingsStub() });
  const a = windowStub();
  const b = windowStub();
  theme.bind(a);
  theme.bind(b, { titleBarOverlay: true });
  assert.equal(nativeTheme.listeners(), 1, '整组共用一个 updated 监听');
  a.close();
  assert.equal(nativeTheme.listeners(), 1, '还有一个窗时就继续听');
  nativeTheme.shouldUseDarkColors = true;
  nativeTheme.emit('updated');
  assert.equal(a.backgrounds.length, 1, '已关窗不再被改');
  assert.equal(b.backgrounds.at(-1), COLORS.dark.background);
  b.close();
  assert.equal(nativeTheme.listeners(), 0, '最后一个关掉就摘监听');
  nativeTheme.emit('updated');           // 不应抛，也不应再改任何窗口
  assert.equal(b.backgrounds.length, 2);
});

test('dispose：退出去所有绑定与监听，之后 updated 不改任何窗口', () => {
  const nativeTheme = nativeThemeStub({ dark: false });
  const theme = createTheme({ nativeTheme, settings: settingsStub() });
  const win = windowStub();
  theme.bind(win, { titleBarOverlay: true });
  assert.equal(nativeTheme.listeners(), 1);
  theme.dispose();
  assert.equal(nativeTheme.listeners(), 0);
  const before = { backgrounds: win.backgrounds.length, overlays: win.overlays.length };
  nativeTheme.shouldUseDarkColors = true;
  nativeTheme.emit('updated');
  assert.equal(win.backgrounds.length, before.backgrounds);
  assert.equal(win.overlays.length, before.overlays);
});

test('透明/采集窗：没有 setBackgroundColor 的窗口一律不绑（返回空解绑函数，不抛）', () => {
  const nativeTheme = nativeThemeStub({ dark: true });
  const theme = createTheme({ nativeTheme, settings: settingsStub() });
  const transparent = new EventEmitter();       // 只有事件，没有上色 API
  transparent.setBounds = () => {};
  const unbind = theme.bind(transparent);
  assert.equal(typeof unbind, 'function');
  assert.doesNotThrow(() => unbind());
  nativeTheme.emit('updated');
  assert.equal(nativeTheme.listeners(), 0, '没有真绑上就不留监听');
});
