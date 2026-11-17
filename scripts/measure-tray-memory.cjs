/* 托盘菜单「收起后保留」的内存代价：同一份真实窗口，比较收起保留期与销毁后的进程内存。
   运行：node_modules\electron\dist\electron.exe scripts\measure-tray-memory.cjs
   不加载 main/index.cjs，不碰系统托盘，userData 用临时目录；窗口 show 被拦住，桌面不会闪。 */
'use strict';
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTrayMenu } = require('../main/tray-menu.cjs');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-mem-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.on('window-all-closed', () => {});

class ProbeWindow extends BrowserWindow {
  show() {}
  showInactive() {}
  focus() {}
}

const totalMb = () => Number((app.getAppMetrics()
  .reduce((sum, metric) => sum + (metric.memory?.workingSetSize || 0), 0) / 1024).toFixed(1));

app.whenReady().then(async () => {
  await sleep(1500);
  const baseline = totalMb();
  const menu = createTrayMenu({
    BrowserWindow: ProbeWindow, screen, ipcMain,
    theme: { bind: () => () => {} },
    rendererFile: path.join(ROOT, 'renderer', 'tray-menu.html'),
    preloadFile: path.join(ROOT, 'main', 'tray-menu-preload.cjs'),
    iconFile: path.join(ROOT, 'assets', 'app-icon.ico'),
    getState: () => ({ hotkeyLabel: 'F1', hotkeyRegistered: true, canFinishScroll: false, hasLastFile: false,
      clipboardEnabled: false, clipboardPaused: false, clipboardHotkey: 'Ctrl + Alt + V' }),
    onAction: async () => ({ ok: true }),
    onError: error => console.error('[menu error]', error?.message || error)
  });
  const bounds = { x: 100, y: 100, width: 32, height: 32 };
  menu.toggle(bounds);
  await sleep(2500);
  const loaded = totalMb();
  menu.toggle(bounds); // 收起后保留
  await sleep(3000);
  const warm = totalMb();
  const processes = app.getAppMetrics().map(metric => ({
    type: metric.type, mb: Number(((metric.memory?.workingSetSize || 0) / 1024).toFixed(1))
  }));
  menu.dispose();
  await sleep(3000);
  const disposed = totalMb();
  console.log(JSON.stringify({ baseline, loaded, warm, disposed, keptMb: Number((warm - baseline).toFixed(1)),
    freedMb: Number((warm - disposed).toFixed(1)), processes, userData }, null, 2));
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
setTimeout(() => { console.error('超时退出'); app.exit(2); }, 90000);
