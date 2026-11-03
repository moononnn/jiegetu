'use strict';
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session, globalShortcut, Tray, nativeImage, shell, dialog, nativeTheme } = require('electron');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { mkdirSync, appendFileSync } = require('node:fs');
const { toPixels } = require('../core/coordinates.cjs');
const { installScreenshot } = require('./screenshot.cjs');
const { createTheme } = require('./theme.cjs');
const { createDiagnostics } = require('./diagnostics.cjs');
// 自绘托盘菜单：左键设置 / 右键菜单都走它，不配原生菜单。
const { createTrayMenu } = require('./tray-menu.cjs');
const { createSettings, normalizeHotkey } = require('./settings.cjs');

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
// 换快捷键的租约：录入期间只卸本应用自己的 currentHotkey，只允许同 token 保存/结束。
let hotkeyLease;
let quitting = false;
let quitFlushing = false;
let hotkeyRegistered = false;
let currentHotkey = 'F1';
let settings;
// 主题：nativeTheme 三态直接驱动所有 renderer 的 prefers-color-scheme；本进程只额外给不透明 UI 窗上色。
let theme;
let shotStatus = { message: '按快捷键框选，松手固定后再选保存、另存或复制。' };
let saveDirectory;
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
  const shotState = () => ({ ...shotStatus, hotkeyRegistered, hotkey: currentHotkey, hotkeyLabel: hotkeyLabel(currentHotkey),
    hotkeyEditing: Boolean(hotkeyLease),
    autoLaunch: settings.get().autoLaunch, saveFolder: settings.resolveSaveFolder(defaultFolder()),
    directory: currentSaveDirectory(), theme: theme?.state() ?? { source: 'system', dark: false },
    diagnostic: diagnostics?.state() });
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
    hasLastFile: Boolean(screenshot?.getLastFile?.())
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
  screenshot = installScreenshot({ getControl: () => control, isProbeBusy: () => busy || quitting,
    copyGif: (bytes, options) => gifClipboard.copy(bytes, options),
    directory: saveDirectory, settings, theme, onStatus: notifyStatus, diagnostics, onLifecycle: logLifecycle, onCaptureEnd: publishState });
  // 这里只安装菜单宿主与固定 IPC；右键打开时才创建 renderer。
  trayMenu = createTrayMenuHandle();
  // 纸卷箭头图标仅裁去透明空边，保持原比例。
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray-scroll.png'));
  if (trayIcon.isEmpty()) throw new Error('托盘图标未能加载');
  tray = new Tray(trayIcon.resize({ width: 32, height: 32, quality: 'best' }));
  tray.setToolTip(`截个图 · 左键设置 · 右键快捷菜单 · ${hotkeyLabel(currentHotkey)} 截图`);
  // 托盘左键：先把可能开着的快捷菜单收起，再按需打开设置页。
  tray.on('click', () => {
    if (quitting) return;
    try { trayMenu.hide(); } catch { /* 菜单不在前台。 */ }
    openSection('settings');
  });
  tray.on('right-click', () => {
    if (quitting) return;
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
  // 录入期间只暂停本应用自己的 currentHotkey（绝不 unregisterAll），记录开始前的注册状态与随机 token；
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
  function beginHotkeyLease(win) {
    if (hotkeyLease) throw new Error('已经在修改快捷键，先保存或取消');
    if (quitting) throw new Error('程序正在退出');
    if (busy || screenshot?.isActive?.() === true) throw new Error('截图或验证进行中，稍后再改快捷键');
    if (!win || win.isDestroyed?.() === true) throw new Error('设置页还没准备好');
    let ready = false;
    try { ready = win.isVisible() === true && win.isFocused() === true; } catch { ready = false; }
    if (!ready) throw new Error('设置窗口不在前台，先点一下窗口再改快捷键');
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
