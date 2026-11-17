'use strict';
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session, globalShortcut, Tray, nativeImage, shell, dialog, nativeTheme } = require('electron');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { mkdirSync, appendFileSync } = require('node:fs');
const { execFile } = require('node:child_process');
const { toPixels } = require('../core/coordinates.cjs');
const { installScreenshot } = require('./screenshot.cjs');
const { createTheme } = require('./theme.cjs');
const { createDiagnostics } = require('./diagnostics.cjs');
// 自绘托盘菜单：左键设置 / 右键菜单都走它，不配原生菜单。
const { createTrayMenu } = require('./tray-menu.cjs');
const { createSettings, normalizeHotkey, normalizeClipboardHotkey } = require('./settings.cjs');
const { createClipboardStore } = require('./clipboard-store.cjs');
const { createClipboardService } = require('./clipboard-service.cjs');
const { installClipboardWindow } = require('./clipboard-window.cjs');
const { installWorkspaceWindow } = require('./workspace-window.cjs');
const { queryForegroundTarget } = require('./foreground.cjs');

let control;
let target;
let overlay;
let selectedDisplay;
let busy = false;
let lastReport;
let screenshot;
let diagnostics;
let tray;
// 自绘快捷菜单句柄（另一作者模块；未安装时为 undefined，左右键仍可用）。
let trayMenu;
// 截图结束后排队的一次性托盘预热计时器（不循环、退出即清）。
let trayPrewarmTimer;
// 换快捷键的租约：录入期间只卸本应用自己的 currentHotkey，只允许同 token 保存/结束。
let hotkeyLease;
let quitting = false;
let quitFlushing = false;
let hotkeyRegistered = false;
let currentHotkey = 'F1';
let settings;
// 历史版本号：每入库一条就加一，页面靠它发现“列表里还没出现的新记录”。
let clipboardRevision = 0;
const bumpClipboardRevision = () => { clipboardRevision += 1; };
// 主题：nativeTheme 三态直接驱动所有 renderer 的 prefers-color-scheme；本进程只额外给不透明 UI 窗上色。
let theme;
let shotStatus = { message: '按快捷键框选，松手固定后再选保存、另存或复制。' };
let saveDirectory;
// 剪贴板：历史库、监听服务、独立历史窗；默认全部关闭，设置开启后才启动监听。
let clipboardStore;
let clipboardService;
let clipboardWindow;
let workspaceWindow;
let clipboardHotkeyRegistered = false;
let clipboardHotkey = '';
let lastPasteTarget;
// 定向粘贴只回呼出前不久还在用的窗口：太旧的不认，避免把内容发到早已切走的程序里。
const PASTE_TARGET_MAX_AGE_MS = 60 * 1000;
let clipboardShutdown = false;
const uiFile = name => path.join(__dirname, '..', 'renderer', name);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const options = { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false };

function cleanup() {
  for (const win of [overlay, target]) if (win && !win.isDestroyed()) win.destroy();
  overlay = target = undefined;
  busy = false;
  if (control && !control.isDestroyed()) control.show();
}

function handle(name, fn) {
  ipcMain.handle(name, (event, ...args) => {
    if (quitting) throw new Error('程序正在退出');
    if (!control || event.sender !== control.webContents || event.senderFrame !== control.webContents.mainFrame) {
      throw new Error('未授权的调用来源');
    }
    return fn(...args);
  });
}

function lockWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
}

// 改产品显示名，不迁移原来的报告、日志与用户数据目录。
const userDataDirectory = path.join(app.getPath('appData'), '截个长 · 捕获验证');
mkdirSync(userDataDirectory, { recursive: true });
app.setPath('userData', userDataDirectory);
app.setName('截个图');
settings = createSettings({ file: path.join(userDataDirectory, 'settings.json') });
// 启动就把保存的主题意图交给 Electron（读旧设置/非法值均回到 system），不影响其它启动步骤。
try { theme = createTheme({ nativeTheme, settings }); } catch { theme = undefined; }
currentHotkey = settings.get().hotkey;
logLifecycle('startup', { version: app.getVersion?.(), electron: process.versions?.electron, chrome: process.versions?.chrome,
  platform: process.platform, packaged: app.isPackaged === true });
const hotkeyLabel = accelerator => accelerator.split('+').join(' + ');
function logDirectory() {
  const directory = path.join(app.getPath('userData'), 'logs');
  mkdirSync(directory, { recursive: true });
  return directory;
}
function logError(error) {
  try {
    appendFileSync(path.join(logDirectory(), 'main.log'), `${new Date().toISOString()} ${error?.stack || String(error)}\n`, 'utf8');
  } catch { /* 日志不可写时，不递归报错。 */ }
}
// 同步写一行固定结构生命周期日志：整进程异常退出后仍能在磁盘上看到最后阶段。
// 只记阶段、reason、exitCode 这类固定字段，不记 URL、像素、IPC 负载或错误原文。
function logLifecycle(event, fields = {}) {
  try {
    appendFileSync(path.join(logDirectory(), 'lifecycle.log'),
      `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...fields })}\n`, 'utf8');
  } catch { /* 日志不可写不阻断启动或退出。 */ }
}
process.on('uncaughtException', error => { logError(error); logLifecycle('uncaught-exception'); app.quit(); });
process.on('unhandledRejection', logError);
// 退出时先停监听、再关存储：不把在途事件当成新记录，也不留 worker 碟。
// 返回一个有界 promise：will-quit 会等它落定后再真正退出（最多 service 4s / store 3s，并行）。
let clipboardClose;
let clipboardCloseSettled = true;
let quitWaitingForClipboard = false;
function shutdownClipboard() {
  if (clipboardShutdown) return clipboardClose || Promise.resolve();
  clipboardShutdown = true;
  // 剪贴板入口的自有热键也要在退出路上卸掉：只卸自己的键，不 unregisterAll。
  if (clipboardHotkeyRegistered) {
    try { globalShortcut.unregister(clipboardHotkey); } catch { /* 已经没了。 */ }
    clipboardHotkeyRegistered = false;
  }
  try { clipboardWindow?.dispose?.(); } catch { /* 已销毁。 */ }
  try { workspaceWindow?.dispose?.(); } catch { /* 已销毁。 */ }
  const tasks = [];
  // 退出才最终销毁服务；关闭记录只 stop，历史复制还能走单次 --publish。
  try {
    const result = clipboardService?.dispose?.();
    if (result && typeof result.then === 'function') tasks.push(result);
    else if (result !== undefined) tasks.push(Promise.resolve(result));
  } catch { /* 已停止。 */ }
  try {
    const result = clipboardStore?.close?.();
    if (result && typeof result.then === 'function') tasks.push(result);
    else if (result !== undefined) tasks.push(Promise.resolve(result));
  } catch { /* 已关闭。 */ }
  clipboardCloseSettled = tasks.length === 0;
  clipboardClose = Promise.allSettled(tasks).then(() => { clipboardCloseSettled = true; });
  return clipboardClose;
}
// 渲染进程消失按 app 级收：control、选区、浮条、提示层共用同一条证据，不靠某个窗口自己报。
app.on('render-process-gone', (event, webContents, details) => {
  let role = 'other';
  try {
    if (control && !control.isDestroyed() && webContents === control.webContents) role = 'control';
    else if (target && !target.isDestroyed() && webContents === target.webContents) role = 'probe';
    else if (overlay && !overlay.isDestroyed() && webContents === overlay.webContents) role = 'probe-overlay';
  } catch { /* 已销毁的窗口只保留 other，不因此丢掉事件。 */ }
  logLifecycle('render-process-gone', { role, reason: details?.reason, exitCode: details?.exitCode });
});
app.on('child-process-gone', (event, details) => logLifecycle('child-process-gone',
  { type: details?.type, reason: details?.reason, exitCode: details?.exitCode }));
// app 'quit' 带 Electron 自己的退出码（Windows 关机/注销不会发这个事件），process 'exit' 作同步兼底。
let exitLogged = false;
app.on('quit', (event, exitCode) => { exitLogged = true; logLifecycle('exit', { exitCode }); });
process.on('exit', exitCode => { if (!exitLogged) logLifecycle('process-exit', { exitCode }); });
app.on('before-quit', event => {
  if (trayPrewarmTimer) { clearTimeout(trayPrewarmTimer); trayPrewarmTimer = undefined; }
  shutdownClipboard();
  if (quitFlushing) { event.preventDefault(); return; }
  if (!quitting && diagnostics && (diagnostics.state().recording || diagnostics.state().writing)) {
    event.preventDefault(); quitting = true; quitFlushing = true; logLifecycle('quit', { flushing: true });
    try { trayMenu?.hide(); } catch { /* 菜单不在也无所谓。 */ }
    try { tray?.setToolTip('截个图 · 正在保存后台记录并退出…'); } catch { /* 托盘可能已不可达。 */ }
    if (hotkeyRegistered) { globalShortcut.unregister(currentHotkey); hotkeyRegistered = false; }
    // 退出不重新注册：只丢掉租约，不恢复旧键。
    hotkeyLease = undefined;
    screenshot?.dispose();
    try { theme?.dispose(); } catch { /* 退出路上不再抛。 */ }
    diagnostics.end('app-quit');
    diagnostics.flush().finally(() => { quitFlushing = false; app.quit(); });
    return;
  }
  if (!quitting) logLifecycle('quit', { flushing: false });
  quitting = true;
  if (hotkeyRegistered) globalShortcut.unregister(currentHotkey);
  // 退出不重新注册：只丢掉租约，不恢复旧键。
  hotkeyLease = undefined;
  try { trayMenu?.dispose(); } catch { /* 退出路上不再抛。 */ }
  screenshot?.dispose();
  // 退出去所有主题监听：不再随系统主题变化去改即将销毁的窗口。
  try { theme?.dispose(); } catch { /* 退出路上不再抛。 */ }
  tray?.destroy();
});
// 存储/服务关闭是异步有界的（service 4s / store 3s，并行）；will-quit 先拦一次，
// 等它们落定再真正退出。只在确实有在途关闭时拦，不改变无剪贴板资源时的退出路径。
app.on('will-quit', event => {
  if (!clipboardClose || clipboardCloseSettled || quitWaitingForClipboard) return;
  event.preventDefault();
  quitWaitingForClipboard = true;
  clipboardClose.finally(() => {
    quitWaitingForClipboard = false;
    try { app.quit(); } catch { /* 已经在退出。 */ }
  });
});
if (!app.requestSingleInstanceLock()) { logLifecycle('single-instance-lock-failed'); app.quit(); }
else app.whenReady().then(async () => {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const captureRequest = screenshot?.getCaptureRequest(request.frame);
      diagnostics?.record('media-source-request', { accepted: Boolean(captureRequest) });
      if (captureRequest) {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        const source = sources.find(item => item.display_id === String(captureRequest.displayId));
        const fresh = screenshot?.getCaptureRequest(request.frame);
        if (!source || fresh?.token !== captureRequest.token || fresh?.displayId !== captureRequest.displayId) {
          diagnostics?.record('media-source-rejected', { accepted: false });
          return callback({});
        }
        diagnostics?.record('media-source-granted', { accepted: true });
        return callback({ video: source });
      }
      if (!control || request.frame !== control.webContents.mainFrame || !selectedDisplay || busy || screenshot?.isActive()) {
        return callback({});
      }
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(item => item.display_id === String(selectedDisplay.id));
      if (!source) throw new Error('无法匹配所选显示器，未自动改用主屏');
      callback({ video: source });
    } catch (error) {
      diagnostics?.record('media-source-rejected', { errorName: error.name, errorMessage: error.message });
      logError(error);
      console.error(error.message);
      callback({});
    }
  }, { useSystemPicker: false });

  // —— 设置/帮助控制页：按需创建 ——
  // 启动不再建窗，也不加载页面：托盘的设置/帮助、页面里的入口都走 ensureControl。
  // 关窗仍是 hide（保留设置输入与试验 DOM）；只有“首次加载失败”才销毁这次建的空壳，允许重试。
  // 截图链路（F1 暖页、原生 lazy helper、未完成草稿）与这里无关，绝不因打开或关掉设置页被重建。
  let controlTask;
  let pendingSection;
  const windowState = () => ({ maximized: Boolean(control && !control.isDestroyed() && control.isMaximized()) });
  const publishWindowState = () => {
    try { if (!quitting && control && !control.isDestroyed()) control.webContents.send('window:state', windowState()); }
    catch { /* 标题栏暂时不可达，不影响原生窗口操作。 */ }
  };
  // 装载完成的页面才收 section；还在 loading 就排队，由 did-finish-load 补发。
  const sendSection = section => {
    if (!section || !control || control.isDestroyed()) return;
    if (control.webContents.isLoading()) { pendingSection = section; return; }
    pendingSection = undefined;
    try { control.webContents.send('shot:focus-section', section); }
    catch { /* 页面刚不可达：下次打开重新创建。 */ }
  };
  const showControl = section => {
    if (!control || control.isDestroyed()) return false;
    if (control.isMinimized()) control.restore();
    control.show(); control.focus();
    sendSection(section);
    return true;
  };
  function createControl() {
    const win = new BrowserWindow({ show: false, width: 760, height: 620, minWidth: 580, minHeight: 480,
      frame: false, roundedCorners: true, resizable: true,
      icon: path.join(__dirname, '..', 'assets', 'app-icon.ico'),
      backgroundColor: '#f7faf6', autoHideMenuBar: true,
      webPreferences: { ...options, preload: path.join(__dirname, 'preload.cjs') } });
    // 设置页是不透明 UI 窗：建好就按当前主题上色，后续跟随 nativeTheme.updated。
    theme?.bind(win);
    lockWindow(win);
    win.removeMenu();
    win.on('maximize', publishWindowState);
    win.on('unmaximize', publishWindowState);
    // 改键兜底：失焦/收起/关闭/崩溃都要把租约收掉并恢复原注册，绝不留着键被卸下不管。
    win.on('blur', () => endHotkeyLease('blur', win));
    win.on('hide', () => endHotkeyLease('hide', win));
    win.on('close', event => {
      endHotkeyLease('close', win);
      if (!quitting) { event.preventDefault(); win.hide(); }
    });
    win.on('closed', () => {
      endHotkeyLease('closed', win);
      // 只清同一扇窗：旧窗迟到的 closed 不得动新一轮的 control，也不收它的探针窗。
      if (control !== win) return;
      control = undefined;
      // 只收控制页自己的引用与探针窗：截图会话的暖页、暖源和未完成草稿与设置页无关，不连带 dispose。
      cleanup();
    });
    win.webContents.on('did-finish-load', () => {
      // 只补发给同一扇窗：加载期间窗口已被换掉就不拿旧 section 去干扰新一轮。
      if (control !== win || quitting) return;
      const section = pendingSection;
      pendingSection = undefined;
      if (section) { try { win.webContents.send('shot:focus-section', section); } catch { /* 页面已不可达。 */ } }
    });
    // 页面崩溃：控制页与 F1 独立，不 cancel/dispose 截图会话；只收掉自己这一扇和它的探针窗，
    // 下次点设置/帮助重新创建，不让一扇死页被反复 show。
    win.webContents.on('render-process-gone', () => {
      // 先清当前 control 引用，cleanup 里的 show 才不会去亮一扇已经死掉的页。
      endHotkeyLease('renderer-gone', win);
      if (control === win) control = undefined;
      cleanup();
      if (!win.isDestroyed()) { try { win.destroy(); } catch { /* 已经不在就只清引用。 */ } }
    });
    // 刷新/跳转也算“页面不在了”：旧页面的 token 不能再持有租约，原键要回来。
    win.webContents.on('did-start-navigation', () => endHotkeyLease('navigation', win));
    return win;
  }
  // 并发打开共用同一次创建；后到的只更新要聚焦的 section，不建第二个窗。
  // 失败时销毁半成品并抛回，下一次点设置/帮助重新走完整创建，不留空壳窗。
  async function ensureControl(section) {
    if (quitting) return undefined;
    // 创建/加载在途：只登记最新要聚焦的 section，等同一次创建完成。
    // 必须先于“control 已存在”判断：建窗后 control 立刻就位，但页面还没加载完，
    // 这时 showControl 会把一扇空壳提前亮出来。
    if (controlTask) { pendingSection = section; return controlTask; }
    if (control && !control.isDestroyed()) { showControl(section); return control; }
    pendingSection = section;
    const task = (async () => {
      const win = createControl();
      control = win;
      try { await win.loadFile(uiFile('index.html')); }
      catch (error) {
        // 只清属于这一扇窗的状态：旧窗迟到的失败不得清掉新一轮的 control/pendingSection。
        if (control === win) { control = undefined; pendingSection = undefined; }
        if (!win.isDestroyed()) { try { win.destroy(); } catch { /* 已经不在就只清引用。 */ } }
        logLifecycle('control-open-failed', { reason: 'load' });
        throw error;
      }
      // 加载期间可能已经发起退出：这时候不再 show，避免退出路上闪一扇窗。
      if (quitting) return undefined;
      if (control !== win || win.isDestroyed()) throw new Error('设置页已关闭');
      if (win.isMinimized()) win.restore();
      win.show(); win.focus();
      // loadFile 回来时 did-finish-load 可能已把 section 发走；还排着的在这里补发。
      sendSection(pendingSection);
      return win;
    })();
    controlTask = task;
    try { return await task; } finally { if (controlTask === task) controlTask = undefined; }
  }
  // 这些 IPC 只在启动时注册一次；发送方验的是“当时的 control”，窗口换掉/销毁后旧 sender 一律被拒。
  handle('window:state', windowState);
  handle('window:minimize', () => { if (control && !control.isDestroyed()) control.minimize(); });
  handle('window:toggle-maximize', () => {
    if (!control || control.isDestroyed()) return;
    if (control.isMaximized()) control.unmaximize(); else control.maximize();
    // 原生最大化完成后由事件推送状态，不把即时查询当成完成结果。
  });
  handle('window:close', () => { if (control && !control.isDestroyed()) control.close(); });
  const defaultFolder = () => path.join(app.getPath('pictures'), '截个长');
  saveDirectory = settings.resolveSaveFolder(defaultFolder());
  const currentSaveDirectory = () => settings.resolveSaveFolder(screenshot?.getLastFile() ? path.dirname(screenshot.getLastFile()) : app.getPath('pictures'));
  // 设置页只拿剪贴板的摘要状态：开关、暂停、快捷键与监听相位；不拿路径或历史内容。
  const clipboardSummary = () => {
    const clipboard = settings.getClipboard();
    return { enabled: clipboard.enabled === true, paused: clipboard.paused === true,
      hotkey: clipboard.hotkey, hotkeyLabel: hotkeyLabel(clipboard.hotkey),
      hotkeyRegistered: clipboardHotkeyRegistered === true,
      hotkeyEditing: hotkeyLease?.target === 'clipboard',
      phase: clipboardService?.status?.().phase || 'stopped' };
  };
  const shotState = () => ({ ...shotStatus, hotkeyRegistered, hotkey: currentHotkey, hotkeyLabel: hotkeyLabel(currentHotkey),
    hotkeyEditing: Boolean(hotkeyLease),
    autoLaunch: settings.get().autoLaunch, saveFolder: settings.resolveSaveFolder(defaultFolder()),
    directory: currentSaveDirectory(), theme: theme?.state() ?? { source: 'system', dark: false },
    diagnostic: diagnostics?.state(), clipboard: clipboardSummary() });
  const publishState = () => {
    try {
      if (control && !control.isDestroyed()) control.webContents.send('shot:status', shotState());
    } catch { /* 状态页暂时不可达，仍独立刷新原生托盘。 */ }
    try { if (tray && !tray.isDestroyed()) refreshTray(); } catch { /* 界面失败不阻断截图。 */ }
  };
  const notifyStatus = status => {
    shotStatus = status;
    // 托盘 tooltip 固定写“左键设置/右键快捷菜单/F1 截图”，不再被状态文案覆盖。
    publishState();
    // 截图出错时选区和浮条都已收回，状态只写在托盘内部没人看得见（长截图零增长就是这样静默失败）。
    // 用托盘气泡补一条看得见的，不抢焦点、不阻塞截图事务。
    if ((status?.error || status?.notice) && tray) {
      try { tray.displayBalloon({ title: '截个图', content: String(status.message || '').slice(0, 200), noSound: true }); }
      catch { /* 气泡不可用不影响截图。 */ }
    }
  };
  const openDirectory = async () => {
    try {
      const directory = currentSaveDirectory();
      await fs.mkdir(directory, { recursive: true });
      const error = await shell.openPath(directory);
      if (error) throw new Error(error);
    } catch (error) { notifyStatus({ message: `无法打开保存目录：${error.message}`, error: true }); }
  };
  const openLast = async () => {
    const file = screenshot.getLastFile();
    if (!file) return;
    const error = await shell.openPath(file);
    if (error) notifyStatus({ message: `无法打开截图：${error}`, error: true });
  };
  const openDiagnostic = async () => {
    await diagnostics.flush();
    const file = diagnostics.getFile();
    if (!file) return;
    const error = await shell.openPath(file);
    if (error) notifyStatus({ message: `无法打开后台记录：${error}`, error: true });
  };
  const openSection = section => {
    if (quitting) return Promise.resolve(undefined);
    // 失败只报一句可读提示，并允许下次重试；绝不留空壳窗。
    return ensureControl(section).catch(error => {
      notifyStatus({ message: `设置页没能打开：${error.message}`, error: true });
      return undefined;
    });
  };
  // 托盘只保留一个入口：左键设置、右键自绘快捷菜单；菜单内容与状态归 tray-menu 模块。
  function refreshTray() {
    // 启动早期（诊断/状态先于托盘创建）没有菜单可刷，直接跳过。
    if (!trayMenu) return;
    if (quitting) {
      try { trayMenu.hide(); } catch { /* 已收掉。 */ }
      try { tray?.setToolTip('截个图 · 正在保存后台记录并退出…'); } catch { /* 托盘可能已不可达。 */ }
      return;
    }
    try { tray?.setToolTip(`截个图 · 左键设置 · 右键快捷菜单 · ${hotkeyLabel(currentHotkey)} 截图`); } catch { /* 装饰文字不影响热键。 */ }
    try { trayMenu.refresh(); } catch (error) { logError(error); }
  }
  // 快捷菜单要的最小状态：快捷键、能否完成长截图、有没有上一张；不把页面内容交给它。
  const trayMenuState = () => ({
    hotkeyLabel: hotkeyLabel(currentHotkey),
    hotkeyRegistered: hotkeyRegistered === true,
    canFinishScroll: Boolean(screenshot?.canFinishScroll?.()),
    hasLastFile: Boolean(screenshot?.getLastFile?.()),
    clipboardEnabled: settings.getClipboard().enabled === true,
    clipboardPaused: settings.getClipboard().paused === true,
    clipboardHotkey: hotkeyLabel(settings.getClipboard().hotkey)
  });
  // 菜单动作白名单：全部落到已有函数，不新增功能。
  const trayActions = {
    capture: () => screenshot.start(),
    'finish-scroll': () => {
      // 菜单开着时状态可能已经变了：完成前再问一次主进程。
      if (!screenshot?.canFinishScroll?.()) throw new Error('当前没有可完成的长截图');
      return screenshot.finishScroll();
    },
    'open-folder': () => openDirectory(),
    'open-last': () => openLast(),
    settings: () => openSection('settings'),
    help: () => openSection('help'),
    clipboard: () => openClipboardHistory(),
    quit: () => app.quit()
  };
  const handleTrayAction = action => {
    if (typeof action !== 'string' || !Object.hasOwn(trayActions, action)) throw new Error('未知的菜单动作');
    return trayActions[action]();
  };
  function createTrayMenuHandle() {
    return createTrayMenu({ BrowserWindow, screen, ipcMain, theme,
      rendererFile: uiFile('tray-menu.html'),
      preloadFile: path.join(__dirname, 'tray-menu-preload.cjs'),
      iconFile: path.join(__dirname, '..', 'assets', 'app-icon.ico'),
      getState: trayMenuState, onAction: handleTrayAction,
      onError: error => { logError(error); notifyStatus({ message: `快捷菜单没能工作：${error?.message || error}`, error: true }); } });
  }
  diagnostics = createDiagnostics({ directory: path.join(app.getPath('userData'), 'diagnostics'), onChange: publishState,
    environment: { version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform } });
  const gifClipboard = require('./gif-clipboard.cjs').createGifClipboard({
    directory: path.join(app.getPath('userData'), 'gif-clipboard') });

  // —— 剪贴板：存储、监听、历史窗 ——
  // 默认全部关闭；enabled 才启动监听，paused 只退订监听但保留发布通道。
  async function applyClipboardSettings() {
    const clipboard = settings.getClipboard();
    try { clipboardService.setExcludedApps(clipboard.excludedApps); } catch { /* 下次启动同样生效。 */ }
    registerClipboardHotkey(clipboard.hotkey);
    if (!clipboard.enabled) {
      if (clipboardService.isAlive()) { try { await clipboardService.stop(); } catch { /* 已停止。 */ } }
      clipboardWindow?.pushState?.();
      return;
    }
    try {
      if (!clipboardService.isAlive()) await clipboardService.restart();
      if (clipboard.paused) await clipboardService.pause();
      else if (clipboardService.status().phase === 'paused') await clipboardService.resume();
    } catch (error) {
      logError(error);
      notifyStatus({ message: `剪贴板监听没能启动：${error?.message || error}。托盘入口仍可打开历史。`, error: true });
    }
    clipboardWindow?.pushState?.();
  }

  function registerClipboardHotkey(accelerator) {
    const wanted = normalizeHotkey(accelerator);
    if (!wanted) return false;
    if (clipboardHotkeyRegistered && clipboardHotkey === wanted) return true;
    if (clipboardHotkeyRegistered) { try { globalShortcut.unregister(clipboardHotkey); } catch { /* 已经没了。 */ } clipboardHotkeyRegistered = false; }
    // 新热键不得抢掉截图键；抢不到就退回托盘入口，不顶替旧功能。
    if (wanted === currentHotkey) {
      notifyStatus({ message: `${hotkeyLabel(wanted)} 已经留给截图；剪贴板热键没有占用它，可从托盘打开历史。`, error: true });
      return false;
    }
    try { clipboardHotkeyRegistered = globalShortcut.register(wanted, () => { openClipboardHistory(); }); }
    catch { clipboardHotkeyRegistered = false; }
    if (clipboardHotkeyRegistered) { clipboardHotkey = wanted; return true; }
    notifyStatus({ message: `剪贴板热键 ${hotkeyLabel(wanted)} 被其他程序占用了；仍可从托盘打开历史。`, error: true });
    return false;
  }

  // 抢到新键并写设置；两步都成功才提交。失败时旧键与旧设置都不动，调用方拿到可读错误。
  // 租约期间旧键已经卸下（clipboardHotkeyRegistered=false），这里只需抢新的，不重复卸。
  function commitClipboardHotkey(wanted) {
    if (wanted === currentHotkey) throw new Error(`${hotkeyLabel(wanted)} 已经留给截图，换一个组合`);
    let registered = false;
    try { registered = globalShortcut.register(wanted, () => { openClipboardHistory(); }); }
    catch { registered = false; }
    if (!registered) throw new Error(`${hotkeyLabel(wanted)} 被其他程序占用了，换一个试试`);
    try { settings.updateClipboard({ hotkey: wanted }, { strict: true }); }
    catch (error) {
      // 写盘失败：撤回刚抢的新键，旧键与旧设置都保留。
      try { globalShortcut.unregister(wanted); } catch { /* 已经没了。 */ }
      throw new Error(`${error.message}；快捷键没有改，可以再试或换个组合`);
    }
    const previous = clipboardHotkeyRegistered ? clipboardHotkey : '';
    if (previous && previous !== wanted) { try { globalShortcut.unregister(previous); } catch { /* 已经没了。 */ } }
    clipboardHotkey = wanted;
    clipboardHotkeyRegistered = true;
    return wanted;
  }
  // 无租约的直接设置路径：设置页改键走下面的租约，这里留作兼容与单独调用。
  function setClipboardHotkey(accelerator) {
    const wanted = normalizeClipboardHotkey(accelerator);
    if (!wanted) throw new Error('剪贴板快捷键要带 Ctrl／Alt／Shift，例如 Ctrl+Alt+V');
    if (clipboardHotkeyRegistered && clipboardHotkey === wanted) return shotState();
    commitClipboardHotkey(wanted);
    notifyStatus({ message: `剪贴板历史快捷键已改成 ${hotkeyLabel(wanted)}。` });
    return shotState();
  }

  async function openClipboardHistory() {
    if (quitting) return;
    // 先记下呼出前的前台窗口：定向粘贴只回这一扇，不盲发 Ctrl+V。
    // 从托盘菜单进来时查到的是自家菜单窗，那就沿用上一次记下的外部窗口，不要拿 null 冲掉。
    try {
      const found = await queryForegroundTarget();
      if (found) lastPasteTarget = { ...found, at: Date.now() };
    } catch { /* 查不到就沿用上一次。 */ }
    try { await clipboardWindow.show(); }
    catch (error) { notifyStatus({ message: `剪贴板历史没能打开：${error?.message || error}`, error: true }); }
  }

  // 托盘被点时前台还是用户程序，赶紧把这一扇记下来，供菜单里的“剪贴板历史”定向粘贴。
  function rememberPasteTarget() {
    queryForegroundTarget()
      .then(found => { if (found) lastPasteTarget = { ...found, at: Date.now() }; })
      .catch(() => {});
  }

  function currentPasteTarget() {
    if (!lastPasteTarget) return undefined;
    if (Date.now() - (lastPasteTarget.at || 0) > PASTE_TARGET_MAX_AGE_MS) return undefined;
    return lastPasteTarget;
  }

  // 只为提示语查一个进程名：查不到就用空串，不让它拖住粘贴。
  function queryProcessName(pid) {
    return new Promise(resolve => {
      try {
        execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
          { windowsHide: true, timeout: 3000 },
          (error, stdout) => {
            if (error || !stdout) return resolve('');
            const match = /^"([^"]+)"/.exec(String(stdout).trim());
            resolve(match ? match[1] : '');
          });
      } catch { resolve(''); }
    });
  }

  clipboardStore = createClipboardStore({ root: path.join(app.getPath('userData'), 'clipboard') });
  clipboardService = createClipboardService({
    helperPath: path.join(__dirname, '..', 'native', 'clipboard-helper.exe'),
    spoolDir: path.join(app.getPath('userData'), 'clipboard', 'spool'),
    excludedApps: settings.getClipboard().excludedApps,
    onEvent: parts => {
      clipboardStore.addEntry({ entries: parts.entries, assetHash: parts.assetHash,
        source: parts.source || '外部复制' })
        .then(() => { bumpClipboardRevision(); clipboardWindow?.pushState?.(); })
        .catch(error => notifyStatus({ message: `这次复制没能入库：${error?.message || error}`, error: true }));
    },
    onStatus: () => { try { clipboardWindow?.pushState?.(); } catch { /* 窗口暂时不可达。 */ } }
  });
  workspaceWindow = installWorkspaceWindow({
    BrowserWindow, ipcMain, screen, dialog, theme,
    rendererFile: uiFile('workspace.html'),
    preloadFile: path.join(__dirname, 'workspace-preload.cjs'),
    iconFile: path.join(__dirname, '..', 'assets', 'app-icon.ico'),
    store: clipboardStore, service: clipboardService, settings,
    exportRoot: path.join(app.getPath('userData'), 'clipboard', 'workspace-export'),
    onStatus: () => { try { clipboardWindow?.pushState?.(); } catch { /* 窗口暂时不可达。 */ } }
  });
  clipboardWindow = installClipboardWindow({
    BrowserWindow, ipcMain,
    rendererFile: uiFile('clipboard-history.html'),
    preloadFile: path.join(__dirname, 'clipboard-preload.cjs'),
    iconFile: path.join(__dirname, '..', 'assets', 'app-icon.ico'),
    theme, nativeImage, store: clipboardStore, service: clipboardService, settings,
    getRevision: () => clipboardRevision,
    multiCopyDir: path.join(app.getPath('pictures'), 'JiegeTu', 'multi'),
    // 编辑页与截图共用同一套文档宿主；图从剪贴板来，保存/复制不经过截图会话。
    openEditor: bytes => screenshot.openExternalEditor({ bytes }),
    onStatus: () => { applyClipboardSettings().catch(error => logError(error)); },
    getPasteTarget: () => currentPasteTarget(),
    getProcessName: pid => queryProcessName(pid),
    onLifecycle: logLifecycle,
    onOpenWorkspace: ids => workspaceWindow.openFromEntries(ids),
    onOpenGroup: groupId => workspaceWindow.openGroup(groupId)
  });
  applyClipboardSettings().catch(error => logError(error));

  // 截图复制：监听开启时只走同一个原生发布通道；未开启沿用旧 Electron 写入。
  // 暂停只停采集，发布通道还在：paused 也走 broker，避免两条写入路径混用。
  async function publishScreenshotPng(bytes) {
    const clipboard = settings.getClipboard();
    if (!clipboard.enabled) return false;
    const phase = clipboardService.status().phase;
    // 只有真正就绪（或暂停但仍保留发布通道）时才接，启动中/中断都不冒充成功。
    if (phase !== 'ready' && phase !== 'paused') return false;
    await clipboardService.publish([{ format: 'png', bytes }]);
    return true;
  }
  // 截图入库：一次成功提交只记当次真实产物；watcher 已抑制自身写入，不会双记。
  function recordScreenshot({ png, width, height, copied }) {
    const clipboard = settings.getClipboard();
    if (!clipboard.enabled) return;
    if (!Buffer.isBuffer(png) || !png.length) return;
    clipboardStore.addEntry({ entries: [{ key: 'png', bytes: png }], source: '截个图' })
      .then(() => { bumpClipboardRevision(); clipboardWindow?.pushState?.(); })
      .catch(error => notifyStatus({ message: `这张截图没能存进剪贴板历史：${error?.message || error}`, error: true }));
  }

  screenshot = installScreenshot({ getControl: () => control, isProbeBusy: () => busy || quitting,
    publishPng: publishScreenshotPng,
    onCommitted: recordScreenshot,
    copyGif: async (bytes, options) => {
      // 监听开启时只发布一次：缓存文件交给同一 broker，不再调旧 publisher。
      const clipboard = settings.getClipboard();
      const phase = clipboardService.status().phase;
      if (!clipboard.enabled || (phase !== 'ready' && phase !== 'paused')) {
        return gifClipboard.copy(bytes, options);
      }
      const result = await gifClipboard.copy(bytes, { ...options, publishNow: false });
      await clipboardService.publish([{ format: 'files', paths: [result.file] }, { format: 'gif', bytes: Buffer.from(bytes) }]);
      return result;
    },
    directory: saveDirectory, settings, theme, onStatus: notifyStatus, diagnostics, onLifecycle: logLifecycle,
    onCaptureEnd: () => { publishState(); scheduleTrayPrewarm(); },
    // 剪贴板图编辑完关页时，把那扇历史窗叫回来。
    onExternalEditorClosed: () => { try { clipboardWindow?.show?.(); } catch { /* 窗口暂时不可达。 */ } } });
  // 这里只安装菜单宿主与固定 IPC；右键打开时才创建 renderer。
  trayMenu = createTrayMenuHandle();
  // 截图结束后排队做一次托盘预热（有界、不循环）：忙就放弃，失败不影响任何功能。
  const TRAY_PREWARM_DELAY_MS = 1750;
  const trayPrewarmBusy = () => {
    if (busy || quitting) return true;                 // 控件验证/探针与退出都算忙
    if (screenshot?.isActive?.() === true) return true; // 截图会话进行中
    try { if (diagnostics?.state?.().writing === true) return true; } catch { /* 查不到就当不忙。 */ }
    return false;
  };
  function scheduleTrayPrewarm() {
    if (quitting) return;
    if (trayPrewarmTimer) { clearTimeout(trayPrewarmTimer); trayPrewarmTimer = undefined; }
    trayPrewarmTimer = setTimeout(() => {
      trayPrewarmTimer = undefined;
      if (quitting || trayPrewarmBusy()) return;   // 忙就放弃这次，不重试
      try { trayMenu?.prepare?.(tray?.getBounds?.() || undefined); } catch { /* 预热失败静默。 */ }
    }, TRAY_PREWARM_DELAY_MS);
    trayPrewarmTimer.unref?.();
  }
  // 纸卷箭头图标仅裁去透明空边，保持原比例。
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray-scroll.png'));
  if (trayIcon.isEmpty()) throw new Error('托盘图标未能加载');
  tray = new Tray(trayIcon.resize({ width: 32, height: 32, quality: 'best' }));
  tray.setToolTip(`截个图 · 左键设置 · 右键快捷菜单 · ${hotkeyLabel(currentHotkey)} 截图`);
  // 托盘左键：先把可能开着的快捷菜单收起，再按需打开设置页。
  tray.on('click', () => {
    if (quitting) return;
    rememberPasteTarget();
    try { trayMenu.hide(); } catch { /* 菜单不在前台。 */ }
    openSection('settings');
  });
  tray.on('right-click', () => {
    if (quitting) return;
    rememberPasteTarget();
    try { trayMenu.toggle(tray.getBounds()); }
    catch (error) { logError(error); notifyStatus({ message: `快捷菜单没能打开：${error?.message || error}`, error: true }); }
  });
  refreshTray();
  // 换快捷键：新键抢不到时把原来那个抢回来，不让用户白丢功能。
  // F1 回调额外留一行：按键与当时是否有活动会话，只记归一化快捷键和布尔，不记页面内容。
  const triggerCapture = () => {
    logLifecycle('hotkey-trigger', { hotkey: currentHotkey, captureActive: screenshot?.isActive?.() === true });
    // 只有快捷键入口允许「在已有选区页上再截一层」；页面/托盘入口保持旧重入语义。
    return screenshot.start({ hideControl: false, nested: true });
  };
  const registerAccelerator = accelerator => {
    try { return globalShortcut.register(accelerator, triggerCapture); } catch { return false; }
  };
  const applyHotkey = accelerator => {
    const previous = currentHotkey;
    // requested 是本次要注册的键（已归一化）；hotkey 是实际生效的键，失败回退时才不会把旧键写成注册失败。
    const requested = normalizeHotkey(accelerator) ?? currentHotkey;
    if (hotkeyRegistered) { try { globalShortcut.unregister(previous); } catch { /* 已经没了就当没注册。 */ } hotkeyRegistered = false; }
    if (registerAccelerator(accelerator)) {
      currentHotkey = accelerator; hotkeyRegistered = true;
      logLifecycle('hotkey-register', { requestedHotkey: requested, hotkey: currentHotkey, ok: true, registered: hotkeyRegistered, fallback: false });
      return true;
    }
    const fallback = previous !== accelerator && registerAccelerator(previous) === true;
    if (fallback) { currentHotkey = previous; hotkeyRegistered = true; }
    logLifecycle('hotkey-register', { requestedHotkey: requested, hotkey: currentHotkey, ok: false, registered: hotkeyRegistered, fallback: fallback === true });
    return false;
  };
  const registerHotkey = () => {
    if (hotkeyLease) throw new Error('正在修改快捷键，先保存或取消');
    if (!hotkeyRegistered) applyHotkey(currentHotkey);
    notifyStatus({ message: hotkeyRegistered
      ? `${hotkeyLabel(currentHotkey)} 已就绪，松手固定选框，可选择保存或复制，回车默认复制。`
      : `${hotkeyLabel(currentHotkey)} 注册失败，可能被 Snipaste 等程序占用。可换一个快捷键，也可直接点“截图”。`, error: !hotkeyRegistered });
    return shotState();
  };
  // —— 换快捷键租约 ——
  // 录入期间只暂停本应用自己的那个键（截图或剪贴板，每轮只动一个）；记录开始前的注册状态与随机 token；
  // 只有同一轮控制页、同一 token 才能保存或结束。结束（取消/失焦/关窗/崩溃/退出）一律恢复原注册。
  // owner 给出时只认同一扇窗：旧窗迟到的 closed/gone 不得收掉新控制页的租约。
  function endHotkeyLease(reason, owner) {
    const lease = hotkeyLease;
    if (!lease) return false;
    if (owner !== undefined && lease.owner !== owner) return false;
    if (quitting) {
      // 退出路上只丢租约，绝不重新注册。
      hotkeyLease = undefined;
      logLifecycle('hotkey-edit', { action: 'restore-skipped', reason, restored: false });
      return false;
    }
    hotkeyLease = undefined;
    if (lease.target === 'clipboard') {
      // 剪贴板改键取消：只恢复它自己那一个键，不碰截图键的注册状态。
      let restored = false;
      if (lease.wasRegistered) {
        try { restored = globalShortcut.register(lease.hotkey, () => { openClipboardHistory(); }); }
        catch { restored = false; }
        clipboardHotkeyRegistered = restored;
        if (!restored) notifyStatus({ message: `剪贴板快捷键 ${hotkeyLabel(lease.hotkey)} 没能恢复，可能被别的程序占用了。`, error: true });
      }
      logLifecycle('hotkey-edit', { action: 'restore', target: 'clipboard', reason, restored });
      publishState();
      return true;
    }
    currentHotkey = lease.hotkey;
    let restored = false;
    if (lease.wasRegistered) {
      restored = registerAccelerator(lease.hotkey);
      hotkeyRegistered = restored;
      if (!restored) {
        // 恢复失败不能静默：说清楚并留一行生命周期记录。
        notifyStatus({ message: `原来的快捷键 ${hotkeyLabel(lease.hotkey)} 没能恢复，可能被别的程序占用了。`, error: true });
        logLifecycle('hotkey-edit', { action: 'restore-failed', reason, restored: false });
      } else {
        logLifecycle('hotkey-edit', { action: 'restore', reason, restored: true });
      }
    } else {
      // 开始前本来就没注册上：不凭空占键。
      hotkeyRegistered = false;
      logLifecycle('hotkey-edit', { action: 'restore-skipped', reason, restored: false });
    }
    publishState();
    return true;
  }
  function beginHotkeyLease(win, target = 'screenshot') {
    if (hotkeyLease) throw new Error(target === 'clipboard' ? '正在修改快捷键，先保存或取消' : '已经在修改快捷键，先保存或取消');
    if (quitting) throw new Error('程序正在退出');
    if (busy || screenshot?.isActive?.() === true) throw new Error('截图或验证进行中，稍后再改快捷键');
    if (!win || win.isDestroyed?.() === true) throw new Error('设置页还没准备好');
    let ready = false;
    try { ready = win.isVisible() === true && win.isFocused() === true; } catch { ready = false; }
    if (!ready) throw new Error('设置窗口不在前台，先点一下窗口再改快捷键');
    if (target === 'clipboard') {
      // 剪贴板行：只暂停剪贴板键，截图键保持原样。
      const wasClipboardRegistered = clipboardHotkeyRegistered === true;
      if (wasClipboardRegistered) {
        try { globalShortcut.unregister(clipboardHotkey); }
        catch (error) {
          clipboardHotkeyRegistered = true;
          throw new Error(`剪贴板快捷键暂时没法暂停（${error?.message || error}），稍后再试`);
        }
        clipboardHotkeyRegistered = false;
      }
      const clipToken = randomUUID();
      hotkeyLease = { token: clipToken, owner: win, target: 'clipboard', wasRegistered: wasClipboardRegistered, hotkey: clipboardHotkey };
      logLifecycle('hotkey-edit', { action: 'begin', target: 'clipboard', paused: wasClipboardRegistered, registered: false });
      publishState();
      return { token: clipToken, state: shotState() };
    }
    const wasRegistered = hotkeyRegistered === true;
    if (wasRegistered) {
      // 只卸本应用自己的这个键；卸不下就不能宣称“已暂停”，也不建租约。
      try { globalShortcut.unregister(currentHotkey); }
      catch (error) {
        hotkeyRegistered = true;
        logLifecycle('hotkey-edit', { action: 'pause-failed', paused: false, registered: true });
        throw new Error(`当前快捷键暂时没法暂停（${error?.message || error}），稍后再试`);
      }
      hotkeyRegistered = false;
    }
    const token = randomUUID();
    hotkeyLease = { token, owner: win, wasRegistered, hotkey: currentHotkey };
    logLifecycle('hotkey-edit', { action: 'begin', paused: wasRegistered, registered: false });
    publishState();
    return { token, state: shotState() };
  }
  // 存租约里的候选键：先抢新键，再严格写设置；两件都成功才提交。
  function saveHotkeyInLease(lease, normalized) {
    // 入口再核一次：还必须是当前这轮、还属于当前控制页，而且那扇页还在前台（同步检查，没有 await 竞态）。
    if (!lease || lease !== hotkeyLease || !control || lease.owner !== control) throw new Error('这次改键已失效，请重新点「更改」');
    let ready = false;
    try { ready = control.isDestroyed() !== true && control.isVisible() === true && control.isFocused() === true; } catch { ready = false; }
    if (!ready) throw new Error('设置窗口不在前台了，请重新点「更改」');
    if (lease.target === 'clipboard') {
      const wanted = normalizeClipboardHotkey(normalized);
      if (!wanted) throw new Error('剪贴板快捷键必须带 Ctrl／Alt／Shift，例如 Ctrl+Alt+V');
      commitClipboardHotkey(wanted);
      hotkeyLease = undefined;
      logLifecycle('hotkey-edit', { action: 'save', target: 'clipboard', ok: true });
      notifyStatus({ message: `剪贴板历史快捷键已改成 ${hotkeyLabel(wanted)}。` });
      return shotState();
    }
    const registered = registerAccelerator(normalized);
    if (!registered) throw new Error(`${hotkeyLabel(normalized)} 被其他程序占用了，换一个试试`);
    try {
      settings.update({ hotkey: normalized }, { strict: true });
    } catch (error) {
      // 写盘失败：撤回刚抢的新键，旧 current 与租约都保留，用户可重试或取消。
      try { globalShortcut.unregister(normalized); } catch { /* 已经没了。 */ }
      throw new Error(`${error.message}；快捷键没有改，可以再试或取消`);
    }
    currentHotkey = normalized;
    hotkeyRegistered = true;
    hotkeyLease = undefined;
    logLifecycle('hotkey-edit', { action: 'save', ok: true });
    notifyStatus({ message: `快捷键已改成 ${hotkeyLabel(normalized)}。` });
    return shotState();
  }
  handle('shot:state', shotState);
  // 开始录入：只允许当前控制页主 frame（handle 已核），并再核一次窗口可见且有焦点。
  handle('shot:begin-hotkey-edit', () => beginHotkeyLease(control));
  handle('shot:begin-clipboard-hotkey-edit', () => beginHotkeyLease(control, 'clipboard'));
  handle('shot:end-hotkey-edit', token => {
    const lease = hotkeyLease;
    if (!lease) return shotState();
    if (typeof token !== 'string' || token !== lease.token) throw new Error('这次改键已失效，请重新点「更改」');
    endHotkeyLease('renderer', lease.owner);
    return shotState();
  });
  // 主题三态：只改 nativeTheme 与不透明 UI 窗的装饰色，不碰截图会话。非法值写设置前就抛。
  handle('shot:set-theme', source => {
    if (!theme) throw new Error('当前环境不支持切换主题');
    theme.set(source);
    return shotState();
  });
  handle('shot:start', () => screenshot.start());
  // 旧版跨屏入口的 IPC 通道保留（老页面/脚本仍可调用），界面与托盘不再单独列一项。
  handle('shot:start-desktop', () => screenshot.startDesktop());
  handle('shot:retry-hotkey', registerHotkey);
  handle('shot:set-hotkey', (accelerator, token) => {
    const normalized = normalizeHotkey(accelerator);
    if (!normalized) throw new Error('这个组合不能当快捷键：功能键可单用，其他键要带 Ctrl／Alt／Shift');
    const lease = hotkeyLease;
    // 带 token 的请求必须对应当前这轮租约：过期/外来一律拒绝，既不结束也不改键。
    if (token !== undefined) {
      if (!lease || typeof token !== 'string' || token !== lease.token) throw new Error('这次改键已失效，请重新点「更改」');
      return saveHotkeyInLease(lease, normalized);
    }
    // 录入中不接受无 token 的旧路径，避免绕过租约。
    if (lease) throw new Error('正在修改快捷键，先保存或取消');
    if (normalized === currentHotkey && hotkeyRegistered) return shotState();
    if (!applyHotkey(normalized)) throw new Error(`${hotkeyLabel(normalized)} 被其他程序占用了，换一个试试`);
    settings.update({ hotkey: normalized });
    notifyStatus({ message: `快捷键已改成 ${hotkeyLabel(normalized)}。` });
    return shotState();
  });
  handle('shot:set-clipboard-hotkey', (accelerator, token) => {
    if (token === undefined) return setClipboardHotkey(accelerator);
    const lease = hotkeyLease;
    if (!lease || typeof token !== 'string' || token !== lease.token || lease.target !== 'clipboard') {
      throw new Error('这次改键已失效，请重新点「更改」');
    }
    return saveHotkeyInLease(lease, accelerator);
  });
  // 设置页的记录开关：只改持久开关，真实监听交给同一个 applyClipboardSettings。
  handle('shot:set-clipboard-enabled', async enabled => {
    const want = enabled === true;
    settings.updateClipboard({ enabled: want, paused: false }, { strict: true });
    await applyClipboardSettings();
    const phase = clipboardService.status().phase;
    if (!want) notifyStatus({ message: '已停止记录剪贴板；已有历史仍可查看和复制。' });
    else if (phase === 'ready') notifyStatus({ message: '已开始记录剪贴板历史；复制的东西只存在本机。' });
    else if (phase === 'paused') notifyStatus({ message: '记录已打开，但现在是暂停状态。' });
    // 监听没能启动时，保留 applyClipboardSettings 写下的错误文案。
    return shotState();
  });
  handle('shot:open-clipboard', () => openClipboardHistory());
  handle('shot:choose-save-folder', async () => {
    const result = await dialog.showOpenDialog(control, { title: '选择直接保存的文件夹', buttonLabel: '用这个文件夹',
      defaultPath: settings.resolveSaveFolder(defaultFolder()), properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return shotState();
    settings.update({ saveFolder: result.filePaths[0] });
    saveDirectory = result.filePaths[0];
    notifyStatus({ message: `直接保存改到：${result.filePaths[0]}` });
    return shotState();
  });
  handle('shot:set-auto-launch', enabled => {
    const wanted = enabled === true;
    // portable启动器会解压到临时目录，自启必须指向外层稳定的EXE。
    const portableExe = app.isPackaged && process.env?.PORTABLE_EXECUTABLE_FILE;
    const target = app.isPackaged ? (portableExe ? { path: portableExe, args: [] } : {})
      : { path: process.execPath, args: [app.getAppPath()] };
    try { app.setLoginItemSettings({ ...target, openAtLogin: wanted }); } catch (error) { throw new Error(`开机自启没设置成功：${error.message}`); }
    const actual = app.getLoginItemSettings(target).openAtLogin === true;
    settings.update({ autoLaunch: actual });
    notifyStatus({ message: actual ? '已设为开机自启。' : '已取消开机自启。' });
    return shotState();
  });
  handle('shot:open-directory', openDirectory);
  handle('shot:open-last', openLast);
  handle('shot:diagnostic-open', openDiagnostic);
  handle('shot:quit', () => { app.quit(); });
  registerHotkey();
  handle('probe:displays', () => screen.getAllDisplays().map(display => ({
    id: display.id, label: display.label || `显示器 ${display.id}`, bounds: display.bounds,
    scaleFactor: display.scaleFactor, primary: display.id === screen.getPrimaryDisplay().id
  })));
  handle('probe:select', id => {
    if (busy || screenshot.isActive()) throw new Error('截图或验证正在进行');
    selectedDisplay = screen.getAllDisplays().find(display => display.id === id);
    if (!selectedDisplay) throw new Error('显示器已断开');
  });
  handle('probe:prepare', async () => {
    if (busy || screenshot.isActive() || !selectedDisplay) throw new Error('请先完成当前截图并选择显示器');
    const display = screen.getAllDisplays().find(item => item.id === selectedDisplay.id);
    if (!display) throw new Error('所选显示器已断开');
    selectedDisplay = display;
    busy = true;
    lastReport = undefined;
    const area = display.workArea;
    const bounds = { x: area.x + Math.floor((area.width - Math.min(480, area.width)) / 2),
      y: area.y + Math.floor((area.height - Math.min(320, area.height)) / 2),
      width: Math.min(480, area.width), height: Math.min(320, area.height) };
    try {
      target = new BrowserWindow({ ...bounds, frame: false, resizable: false, alwaysOnTop: true,
        skipTaskbar: true, show: false, backgroundColor: '#287d72', webPreferences: options });
      lockWindow(target);
      await target.loadFile(uiFile('target.html'));
      target.showInactive();
      overlay = new BrowserWindow({ ...bounds, frame: false, resizable: false, alwaysOnTop: true,
        skipTaskbar: true, show: false, transparent: true, focusable: false, webPreferences: options });
      lockWindow(overlay);
      overlay.setIgnoreMouseEvents(true, { forward: true });
      await overlay.loadFile(uiFile('overlay.html'));
      // 探针入口只能从控制页进来；控制页万一已被销毁也不报错，只跳过收窗。
      if (control && !control.isDestroyed()) control.hide();
      // 主进程看门狗，渲染层崩溃或 IPC 中断也不能留下挡屏测试窗。
      const currentTarget = target;
      setTimeout(() => { if (target === currentTarget) cleanup(); }, 20000).unref();
      return { display: { id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor },
        sample: { x: bounds.x + Math.floor(bounds.width / 2) - 16,
          y: bounds.y + Math.floor(bounds.height / 2) - 16, width: 32, height: 32 } };
    } catch (error) { cleanup(); throw error; }
  });
  handle('probe:phase', async mode => {
    if (!busy || !overlay || overlay.isDestroyed()) throw new Error('验证窗口已关闭');
    if (mode === 'hidden') overlay.hide();
    else if (mode === 'visible' || mode === 'protected') {
      overlay.hide();
      overlay.setContentProtection(mode === 'protected');
      overlay.showInactive();
      overlay.moveTop();
    } else throw new Error('无效验证阶段');
    await delay(700);
  });
  handle('probe:map', (rect, frame) => {
    if (!busy || !selectedDisplay) throw new Error('验证未启动');
    return toPixels(rect, selectedDisplay.bounds, frame);
  });
  handle('probe:finish', async report => {
    try {
      if (!busy || typeof report !== 'object' || report === null || JSON.stringify(report).length > 16000) {
        throw new Error('无效报告');
      }
      // 不持久化桌面画面，仅保存本程序色块的采样结果。
      lastReport = { createdAt: new Date().toISOString(), electron: process.versions.electron,
        platform: process.platform, ...report };
      const directory = path.join(app.getPath('userData'), 'probe-results');
      await fs.mkdir(directory, { recursive: true });
      const file = path.join(directory, `probe-${Date.now()}.json`);
      await fs.writeFile(file, JSON.stringify(lastReport, null, 2), 'utf8');
      return { file, report: lastReport };
    } finally { cleanup(); }
  });
  handle('probe:cancel', () => { if (busy) cleanup(); });
  // 就绪日志不再等设置页：托盘、快捷键、托盘菜单与截图链路到这里已可用，控制页按需创建。
  logLifecycle('ready');
  // 单屏 Windows 的冷启动预备：不 await，不管成败；下次 F1 仍按原 start 流程自检。
  try { Promise.resolve(screenshot.prepare?.()).catch(() => {}); } catch { /* 预备失败走冷路径。 */ }
}).catch(error => { logError(error); console.error(error); app.quit(); });
app.on('window-all-closed', () => {
  // 控制页按需创建后，“截图窗全关”也会是零窗口：托盘还在就继续活着，不能跟着自动退出。
  // 只有托盘也没了（已在退出路上）才让 Electron 走原来的退出流程。
  if (tray && !tray.isDestroyed()) return;
  app.quit();
});
