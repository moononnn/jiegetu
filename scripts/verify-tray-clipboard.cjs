/* 真实链路隐藏验收：真实 renderer/tray-menu.html/.js + main/tray-menu-preload.cjs + 真实 main/tray-menu.cjs。
   只把系统托盘/屏幕换成桩，动作走 onAction 记录；窗口构造与 show/focus 被拦住，桌面不会闪出菜单。
   证明“托盘菜单里的剪贴板历史能显示状态、点击能派发 clipboard”；不加载 main/index.cjs、不碰真实剪贴板。
   运行：node_modules\electron\dist\electron.exe scripts\verify-tray-clipboard.cjs */
'use strict';
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTrayMenu } = require('../main/tray-menu.cjs');

const ROOT = path.join(__dirname, '..');
const results = [];
const failures = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures.push(name);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-clipboard-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();
// 菜单窗口被销毁时不跟着退出：验收还要往下跑。
app.on('window-all-closed', () => {});

const windows = [];
class HiddenWindow extends BrowserWindow {
  constructor(options = {}) {
    super({ ...options, show: false });
    this.interceptedShow = 0;
    windows.push(this);
  }
  show() { this.interceptedShow += 1; }
  showInactive() { this.interceptedShow += 1; }
  focus() { /* 不抢前台焦点。 */ }
}

app.whenReady().then(async () => {
  const actions = [];
  const errors = [];
  const state = {
    hotkeyLabel: 'F1',
    hotkeyRegistered: true,
    canFinishScroll: false,
    hasLastFile: false,
    clipboardEnabled: false,
    clipboardPaused: false,
    clipboardHotkey: 'Ctrl + Alt + V'
  };
  const menu = createTrayMenu({
    BrowserWindow: HiddenWindow,
    screen,
    ipcMain,
    theme: { bind: () => () => {} },
    rendererFile: path.join(ROOT, 'renderer', 'tray-menu.html'),
    preloadFile: path.join(ROOT, 'main', 'tray-menu-preload.cjs'),
    iconFile: path.join(ROOT, 'assets', 'app-icon.ico'),
    getState: () => ({ ...state }),
    onAction: async action => { actions.push(action); return { ok: true, action }; },
    onError: error => errors.push(String(error?.message || error))
  });

  // 第一次打开：记录未开启，菜单该照实显示快捷键与关闭态。
  menu.toggle({ x: 100, y: 100, width: 32, height: 32 });
  await sleep(900);
  const win = windows.at(-1);
  check('菜单窗口建出来了', Boolean(win));
  check('菜单没有真的显示', win?.isVisible() === false, `show 拦截 ${win?.interceptedShow} 次`);
  const consoleErrors = [];
  win?.webContents.on('console-message', (_event, level, message) => { if (level >= 2) consoleErrors.push(message); });

  const run = code => win.webContents.executeJavaScript(code, true);
  const first = await run(`(() => ({
    clipText: document.getElementById('clip-hotkey').textContent,
    clipState: document.getElementById('clipboard').dataset.state,
    clipTitle: document.getElementById('clip-hotkey').title,
    actionsPresent: document.querySelectorAll('.item[data-action]').length
  }))()`);
  check('剪贴板行显示真实快捷键（不再是「未设」）', first.clipText === 'Ctrl + Alt + V', first.clipText);
  check('记录未开启时菜单项是关闭态', first.clipState === 'off', first.clipState);
  check('关闭态提示文案', first.clipTitle === '记录未开启', first.clipTitle);
  check('页面无运行时错误', consoleErrors.length === 0, consoleErrors.slice(0, 3));

  // 点“剪贴板历史”：必须派发 clipboard，而不是被当成未知动作吞掉。
  await run(`document.getElementById('clipboard').click()`);
  await sleep(300);
  check('点击派发 clipboard 动作', actions.includes('clipboard'), JSON.stringify(actions));
  check('派发过程没有报错', errors.length === 0, errors.join(' | '));

  // 第二次打开：开启并暂停后，状态点变成 paused。
  state.clipboardEnabled = true;
  state.clipboardPaused = true;
  await sleep(200);
  menu.toggle({ x: 100, y: 100, width: 32, height: 32 });
  await sleep(900);
  const win2 = windows.at(-1);
  const second = await win2.webContents.executeJavaScript(`(() => ({
    clipState: document.getElementById('clipboard').dataset.state,
    clipTitle: document.getElementById('clip-hotkey').title
  }))()`, true);
  check('暂停态落到菜单项', second.clipState === 'paused', second.clipState);
  check('暂停态提示文案', second.clipTitle === '记录已暂停', second.clipTitle);

  menu.dispose();
  const report = { results, failures, actions, errors, consoleErrors, userData };
  fs.writeFileSync(path.join(userData, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
  await sleep(200);
  app.exit(failures.length ? 1 : 0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});

setTimeout(() => { console.error('超时退出'); app.exit(2); }, 30000);
