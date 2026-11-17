'use strict';
// 托盘预热效果探针（测试侧）：真实 createTrayMenu + 真实页面/preload，拦截 show/focus。
// 测三种首开：冷建、预热后再右键、预热载入中右键；并核原生 isVisible=false 与内存增量。
// 用法：electron scripts/perf/probe-tray-prewarm.cjs
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTrayMenu } = require('../../main/tray-menu.cjs');

const ROOT = path.resolve(__dirname, '../..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-prewarm-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const windows = [];
let shownAt = [];
const nativeVisible = win => BrowserWindow.prototype.isVisible.call(win);
class ProbeWindow extends BrowserWindow {
  constructor(options = {}) {
    super({ ...options, show: false });
    this.loadedAt = 0;
    windows.push(this);
    this.webContents.on('did-finish-load', () => { if (!this.loadedAt) this.loadedAt = performance.now(); });
  }
  show() { shownAt.push(performance.now()); }
  showInactive() { this.show(); }
  focus() {}
  restore() {}
}
const mem = () => {
  const metrics = app.getAppMetrics();
  const pick = type => metrics.filter(entry => entry.type === type)
    .reduce((total, entry) => total + (entry.memory?.workingSetSize || 0), 0) / 1024;
  return { mainMiB: +pick('Browser').toFixed(1), rendererMiB: +pick('Tab').toFixed(1) };
};
const mkMenu = () => createTrayMenu({
  BrowserWindow: ProbeWindow, screen, ipcMain, theme: { bind: () => () => {} },
  rendererFile: path.join(ROOT, 'renderer/tray-menu.html'),
  preloadFile: path.join(ROOT, 'main/tray-menu-preload.cjs'),
  iconFile: path.join(ROOT, 'assets/app-icon.ico'),
  getState: () => ({ hotkeyLabel: 'F1', hotkeyRegistered: true, canFinishScroll: false, hasLastFile: false,
    clipboardEnabled: false, clipboardPaused: false, clipboardHotkey: 'Ctrl + Alt + V' }),
  onAction: async () => ({ ok: true }), onError: () => {}
});
const bounds = { x: 100, y: 100, width: 32, height: 32 };

async function openAndTime(menu, base) {
  shownAt = [];
  const t0 = performance.now();
  menu.toggle(bounds);
  const deadline = t0 + 8000;
  while (!shownAt.length && performance.now() < deadline) await sleep(4);
  const win = windows.at(-1);
  return { showMs: shownAt.length ? +(shownAt.at(-1) - t0).toFixed(1) : null,
    readyMs: win && win.loadedAt ? +(win.loadedAt - t0).toFixed(1) : null };
}

app.whenReady().then(async () => {
  const out = { memory: { base: mem() }, cold: null, prewarmThenOpen: null, prewarmDuringLoadOpen: null, hiddenAll: true };
  // 1) 冷建
  {
    const menu = mkMenu();
    out.cold = await openAndTime(menu, performance.now());
    menu.toggle(bounds);
    await sleep(100);
    out.memory.warm = mem();
    menu.dispose();
    await sleep(100);
    out.memory.afterDispose = mem();
  }
  // 2) 预热完成后再开
  {
    const menu = mkMenu();
    shownAt = [];
    const prepareAt = performance.now();
    menu.prepare(bounds);
    // 等页面 ready（warm）：用 shownAt 判不到，改为轮询窗口 loadedAt + 一点余量
    const win = windows.at(-1);
    const deadline = prepareAt + 8000;
    while ((!win || !win.loadedAt) && performance.now() < deadline) await sleep(4);
    await sleep(120);
    out.prewarmDoneMs = +(performance.now() - prepareAt).toFixed(1);
    out.memory.afterPrewarm = mem();
    out.prewarmThenOpen = await openAndTime(menu, performance.now());
    out.prewarmDidShowWhilePreparing = shownAt.length > 1 ? shownAt.length - 1 : 0;
    menu.toggle(bounds);
    await sleep(80);
    menu.dispose();
    await sleep(80);
  }
  // 3) 预热载入中立刻右键
  {
    const menu = mkMenu();
    shownAt = [];
    menu.prepare(bounds);
    const result = await openAndTime(menu, performance.now());
    out.prewarmDuringLoadOpen = result;
    menu.toggle(bounds);
    await sleep(80);
    menu.dispose();
    await sleep(80);
  }
  out.hiddenAll = windows.every(win => win.isDestroyed() || nativeVisible(win) === false);
  out.windowCount = windows.length;
  console.log(JSON.stringify({ ok: true, result: out }, null, 1));
  await sleep(80);
  app.exit(0);
}).catch(error => { console.log(JSON.stringify({ ok: false, error: String((error && error.stack) || error) })); app.exit(1); });
