/* 托盘快捷菜单延迟探针：真实 createTrayMenu + 真实页面/preload，只把 show/focus 拦住不让窗口真的闪出来。
   每轮测两段：「右键打开」与「收起后再次右键」；后者走窗口复用（warm）路径。
   运行：node_modules\electron\dist\electron.exe scripts\probe-tray-latency.cjs [轮数] [两次之间的间隔毫秒]
   不加载 main/index.cjs，不碰系统托盘、屏幕、剪贴板；userData 用临时目录。 */
'use strict';
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTrayMenu } = require('../main/tray-menu.cjs');

const ROOT = path.join(__dirname, '..');
const ROUNDS = Math.max(1, Math.min(20, Number(process.argv[2]) || 6));
const GAP_MS = Math.max(0, Math.min(120000, Number(process.argv[3]) || 400));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-probe-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.on('window-all-closed', () => {});

const windows = [];
let shownAt = [];

class ProbeWindow extends BrowserWindow {
  constructor(options = {}) {
    const constructAt = performance.now();
    super({ ...options, show: false });
    this.constructAt = constructAt;
    this.domReadyAt = 0;
    this.loadedAt = 0;
    this.createdRound = currentRound;
    windows.push(this);
    this.webContents.on('dom-ready', () => { if (!this.domReadyAt) this.domReadyAt = performance.now(); });
    this.webContents.on('did-finish-load', () => { if (!this.loadedAt) this.loadedAt = performance.now(); });
  }
  show() { this.interceptedShow = (this.interceptedShow || 0) + 1; shownAt.push(performance.now()); }
  showInactive() { this.show(); }
  focus() {}
}

let currentRound = 0;

function newMark() {
  shownAt = [];
  const t0 = performance.now();
  const win = windows.at(-1);
  return { t0, win };
}

function pick(win, base) {
  return {
    show: shownAt.length ? Number((shownAt.at(-1) - base).toFixed(1)) : null,
    domReady: win && win.domReadyAt ? Number((win.domReadyAt - base).toFixed(1)) : null,
    finishLoad: win && win.loadedAt ? Number((win.loadedAt - base).toFixed(1)) : null,
    windows: windows.length,
    reused: win ? win.createdRound !== currentRound || undefined : undefined
  };
}

app.whenReady().then(async () => {
  const state = {
    hotkeyLabel: 'F1', hotkeyRegistered: true, canFinishScroll: false, hasLastFile: false,
    clipboardEnabled: false, clipboardPaused: false, clipboardHotkey: 'Ctrl + Alt + V'
  };
  const menu = createTrayMenu({
    BrowserWindow: ProbeWindow,
    screen,
    ipcMain,
    theme: { bind: () => () => {} },
    rendererFile: path.join(ROOT, 'renderer', 'tray-menu.html'),
    preloadFile: path.join(ROOT, 'main', 'tray-menu-preload.cjs'),
    iconFile: path.join(ROOT, 'assets', 'app-icon.ico'),
    getState: () => ({ ...state }),
    onAction: async () => ({ ok: true }),
    onError: error => console.error('[menu error]', error?.message || error)
  });

  const bounds = { x: 100, y: 100, width: 32, height: 32 };
  const rounds = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    currentRound = i;
    // 第一段：右键打开（第一轮是冷建，之后是复用已经收起的窗口）
    let mark = newMark();
    menu.toggle(bounds);
    let deadline = mark.t0 + 8000;
    while (!shownAt.length && performance.now() < deadline) await sleep(5);
    const open = pick(mark.win, mark.t0);
    menu.toggle(bounds); // 收起（保留窗口）

    await sleep(GAP_MS);

    // 第二段：同一个窗口再开一次
    mark = newMark();
    menu.toggle(bounds);
    deadline = mark.t0 + 8000;
    while (!shownAt.length && performance.now() < deadline) await sleep(5);
    const reopen = pick(mark.win, mark.t0);
    menu.toggle(bounds);

    rounds.push({ round: i + 1, open, reopen });
    await sleep(200);
  }

  menu.dispose();
  console.log(JSON.stringify({ gapMs: GAP_MS, rounds, electron: process.versions.electron, userData }, null, 2));
  await sleep(150);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

setTimeout(() => { console.error('超时退出'); app.exit(2); }, 180000);
