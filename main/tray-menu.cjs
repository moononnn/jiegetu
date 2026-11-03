'use strict';
// 自绘托盘快捷菜单宿主：右键托盘时临时建一扇无边框小窗，失焦、按 Esc、执行动作或关闭后立即销毁。
// 不常驻 renderer、不注册全局快捷键、不碰设置页与截图链路；所有能力由调用方注入，node:test 可塞替身。
// 菜单只拿最小状态（快捷键文案、能否完成长截图、有没有上一张），动作走固定白名单，不向 renderer 开放任意 channel 或路径。

const fs = require('node:fs');

const MENU_SIZE = Object.freeze({ width: 296, height: 372 });
// 没有“完成长截图”那行时用更矮的一档，别让常用状态底部空一大块。
const MENU_COMPACT_HEIGHT = 348;
const LOAD_TIMEOUT_MS = 5000;
const READY_TIMEOUT_MS = 3000;
const GAP = 6;
const CHANNELS = Object.freeze({
  state: 'tray-menu:state',
  ready: 'tray-menu:ready',
  action: 'tray-menu:action',
  dismiss: 'tray-menu:dismiss'
});
const ACTIONS = Object.freeze(['capture', 'finish-scroll', 'open-folder', 'open-last', 'settings', 'help', 'quit']);
const ACTION_SET = new Set(ACTIONS);
const DISPOSED_MESSAGE = '快捷菜单已释放';
const UNAUTHORIZED_MESSAGE = '未授权的快捷菜单调用';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function rectOf(value) {
  if (!value || typeof value !== 'object') return null;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function pointOf(value) {
  if (!value || typeof value !== 'object') return null;
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
  return { x: value.x, y: value.y };
}

// 纯定位：托盘 rect 与屏幕 workArea 都是 DIP，不自己乘缩放。
// 托盘在下半边（典型底部任务栏）就向上展开，否则向下；托盘在右半边就贴右，否则贴左。
// bounds 缺失或为 0 时退回鼠标位置；尺寸不超过工作区，最后把整块夹进 workArea（容纳负坐标屏）。
function placeTrayMenu({ trayBounds, cursorPoint, workArea, size = MENU_SIZE } = {}) {
  const wantedWidth = Number.isFinite(size?.width) && size.width > 0 ? Math.round(size.width) : MENU_SIZE.width;
  const wantedHeight = Number.isFinite(size?.height) && size.height > 0 ? Math.round(size.height) : MENU_SIZE.height;
  const area = rectOf(workArea) || { x: 0, y: 0, width: wantedWidth, height: wantedHeight };
  const width = Math.max(1, Math.min(wantedWidth, Math.floor(area.width)));
  const height = Math.max(1, Math.min(wantedHeight, Math.floor(area.height)));
  const tray = rectOf(trayBounds);
  const cursor = pointOf(cursorPoint);
  const anchor = tray
    ? { x: tray.x + tray.width / 2, y: tray.y + tray.height / 2 }
    : cursor;
  let x;
  let y;
  if (anchor) {
    const centerX = area.x + area.width / 2;
    const centerY = area.y + area.height / 2;
    x = anchor.x >= centerX
      ? (tray ? tray.x + tray.width : anchor.x) - width
      : (tray ? tray.x : anchor.x);
    y = anchor.y >= centerY
      ? (tray ? tray.y : anchor.y) - GAP - height
      : (tray ? tray.y + tray.height : anchor.y) + GAP;
  } else {
    x = area.x + (area.width - width) / 2;
    y = area.y + (area.height - height) / 2;
  }
  const minX = Math.ceil(area.x);
  const minY = Math.ceil(area.y);
  const maxX = Math.max(minX, Math.floor(area.x + area.width - width));
  const maxY = Math.max(minY, Math.floor(area.y + area.height - height));
  return { x: Math.round(clamp(x, minX, maxX)), y: Math.round(clamp(y, minY, maxY)), width, height };
}

function createTrayMenu({ BrowserWindow, screen, ipcMain, theme, rendererFile, preloadFile, iconFile,
  getState, onAction, onError } = {}) {
  if (typeof BrowserWindow !== 'function') throw new TypeError('快捷菜单需要 BrowserWindow');
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new TypeError('快捷菜单需要 ipcMain');
  if (typeof rendererFile !== 'string' || !rendererFile) throw new TypeError('快捷菜单需要页面文件');
  if (typeof preloadFile !== 'string' || !preloadFile) throw new TypeError('快捷菜单需要 preload');
  if (typeof getState !== 'function') throw new TypeError('快捷菜单需要 getState');
  if (typeof onAction !== 'function') throw new TypeError('快捷菜单需要 onAction');

  const report = error => { try { onError?.(error); } catch { /* 记录失败不再抛。 */ } };
  const icon = typeof iconFile === 'string' && fs.existsSync(iconFile) ? iconFile : undefined;
  let owner = null;
  let disposed = false;

  const ensureLive = () => { if (disposed) throw new Error(DISPOSED_MESSAGE); };

  const fallbackState = () => ({ hotkeyLabel: 'F1', hotkeyRegistered: false, canFinishScroll: false, hasLastFile: false });

  // 只保留这四个布尔/文案字段；不把文件路径或页面内容带进 renderer。
  function readState() {
    let raw;
    try { raw = getState(); } catch (error) { report(error); return null; }
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      hotkeyLabel: typeof source.hotkeyLabel === 'string' && source.hotkeyLabel.trim()
        ? source.hotkeyLabel.trim().slice(0, 32) : 'F1',
      hotkeyRegistered: source.hotkeyRegistered === true,
      canFinishScroll: source.canFinishScroll === true,
      hasLastFile: source.hasLastFile === true
    };
  }

  function screenContext(bounds) {
    const tray = rectOf(bounds);
    let cursor = null;
    try { cursor = pointOf(screen?.getCursorScreenPoint?.()); } catch { cursor = null; }
    const point = tray
      ? { x: Math.round(tray.x + tray.width / 2), y: Math.round(tray.y + tray.height / 2) }
      : cursor || { x: 0, y: 0 };
    let workArea = null;
    try { workArea = screen?.getDisplayNearestPoint?.(point)?.workArea || null; } catch { workArea = null; }
    return { tray, cursor, workArea };
  }

  function clearTimers(record) {
    if (record.loadTimer) { clearTimeout(record.loadTimer); record.loadTimer = null; }
    if (record.readyTimer) { clearTimeout(record.readyTimer); record.readyTimer = null; }
  }

  // 只回收这一条 owner：先断引用、再解挂载、再销毁，迟到的 load/ready 回包都看不到当前 owner。
  function endOwner(record) {
    if (!record || record.cancelled) return;
    record.cancelled = true;
    record.ready = false;
    clearTimers(record);
    if (owner === record) owner = null;
    record.abortResolve?.();
    record.abortResolve = null;
    const win = record.win;
    if (win && win.isDestroyed?.() !== true) {
      try { win.destroy(); } catch { /* 已关闭。 */ }
    }
  }

  function failOwner(record, error) {
    if (!record || record.cancelled || record.failed) return;
    record.failed = true;
    report(error);
    endOwner(record);
  }

  // 只认当前 owner 的主 frame；subframe、外来 webContents、已收掉的旧窗一律拒绝。
  function senderRecord(event) {
    const record = owner;
    if (!record || !event || !event.sender) return null;
    const win = record.win;
    if (!win || win.isDestroyed?.() === true) return null;
    const contents = win.webContents;
    if (!contents || event.sender !== contents) return null;
    const mainFrame = contents.mainFrame;
    if (!mainFrame || event.senderFrame !== mainFrame) return null;
    return record;
  }

  function showOwner(record) {
    if (!record || record.cancelled || record.failed || owner !== record) throw new Error('菜单已关闭');
    const win = record.win;
    if (!win || win.isDestroyed?.() === true) throw new Error('菜单已关闭');
    try {
      win.show();
    } catch (error) {
      failOwner(record, error);
      throw error;
    }
    try { win.focus?.(); } catch { /* 焦点失败不影响菜单内容。 */ }
    record.shown = true;
    return true;
  }

  function createOwner(bounds) {
    const context = screenContext(bounds);
    const state = readState() || fallbackState();
    const placement = placeTrayMenu({ trayBounds: context.tray, cursorPoint: context.cursor, workArea: context.workArea,
      size: { width: MENU_SIZE.width, height: state.canFinishScroll ? MENU_SIZE.height : MENU_COMPACT_HEIGHT } });
    let win;
    try {
      win = new BrowserWindow({
        x: placement.x, y: placement.y, width: placement.width, height: placement.height,
        show: false, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
        fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, modal: false, focusable: true, closable: true,
        transparent: false, backgroundColor: '#f7faf6', autoHideMenuBar: true, title: '截个图 · 快捷菜单',
        ...(icon ? { icon } : {}),
        webPreferences: { preload: preloadFile, nodeIntegration: false, contextIsolation: true,
          sandbox: true, devTools: false, spellcheck: false, backgroundThrottling: false }
      });
    } catch (error) {
      report(error);
      throw error;
    }
    const record = {
      win, state, ready: false, shown: false, failed: false, cancelled: false, dispatching: false,
      loadTimer: null, readyTimer: null, abortResolve: null
    };
    record.abort = new Promise(resolve => { record.abortResolve = resolve; });
    owner = record;

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    // 显示前就按当前主题上色（与设置页同一套 shared theme / prefers-color-scheme），不在 show 后补色。
    try { theme?.bind?.(win); } catch (error) { report(error); }
    win.on('blur', () => { if (owner === record) endOwner(record); });
    win.on('closed', () => {
      if (owner === record) owner = null;
      record.cancelled = true;
      record.ready = false;
      clearTimers(record);
      record.abortResolve?.();
      record.abortResolve = null;
    });
    win.webContents.on('render-process-gone', () => {
      if (owner === record) failOwner(record, new Error('快捷菜单渲染进程已退出'));
    });
    win.webContents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
      if (isMainFrame === false) return;
      failOwner(record, new Error(`快捷菜单加载失败：${description || code || '未知错误'}`));
    });

    // 有界载页：只等一次，不重试、不另起进程；取消/关闭会提前 resolve abort。
    (async () => {
      let loading;
      try { loading = win.loadFile(rendererFile); } catch (error) { failOwner(record, error); return; }
      let timer;
      try {
        await Promise.race([
          loading,
          record.abort,
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('快捷菜单加载超时')), LOAD_TIMEOUT_MS);
            record.loadTimer = timer;
          })
        ]);
      } catch (error) {
        failOwner(record, error);
        return;
      } finally {
        if (timer) clearTimeout(timer);
        if (record.loadTimer === timer) record.loadTimer = null;
      }
      if (owner !== record || record.cancelled || record.failed || win.isDestroyed()) return;
      // 页面可能已经先报到 ready 并显示；那就不要再挂“没有就绪”的回收计时器。
      if (record.ready || record.shown) return;
      // 页面必须自己报到 ready（状态已落到 DOM）才能显示；超时同样回收这一条 owner。
      record.readyTimer = setTimeout(() => failOwner(record, new Error('快捷菜单没有就绪')), READY_TIMEOUT_MS);
    })();
    return record;
  }

  ipcMain.handle(CHANNELS.state, event => {
    ensureLive();
    const record = senderRecord(event);
    if (!record) throw new Error(UNAUTHORIZED_MESSAGE);
    const state = readState() || record.state;
    record.state = state;
    return state;
  });

  ipcMain.handle(CHANNELS.ready, event => {
    ensureLive();
    const record = senderRecord(event);
    if (!record) throw new Error(UNAUTHORIZED_MESSAGE);
    record.ready = true;
    if (record.readyTimer) { clearTimeout(record.readyTimer); record.readyTimer = null; }
    // 重复 ready 只认第一次：已显示的菜单不再重新 show/focus。
    if (record.shown) return true;
    return showOwner(record);
  });

  ipcMain.handle(CHANNELS.dismiss, event => {
    ensureLive();
    const record = senderRecord(event);
    if (!record) throw new Error(UNAUTHORIZED_MESSAGE);
    endOwner(record);
    return true;
  });

  ipcMain.handle(CHANNELS.action, async (event, action) => {
    ensureLive();
    const record = senderRecord(event);
    if (!record) throw new Error(UNAUTHORIZED_MESSAGE);
    // 同一扇菜单只允许一次动作；这个检查必须在 hide / 结束 owner 之前。
    if (record.dispatching) throw new Error('菜单动作正在处理');
    if (typeof action !== 'string' || !ACTION_SET.has(action)) throw new Error('未知的菜单动作');
    // 动作授权只认现态：getState 读不到就拒绝，不拿记录里的旧布尔回退放行。
    const state = readState();
    if (!state) throw new Error('菜单状态暂时不可用');
    if (action === 'finish-scroll' && !state.canFinishScroll) throw new Error('当前没有可完成的长截图');
    if (action === 'open-last' && !state.hasLastFile) throw new Error('还没有最近的截图');
    record.dispatching = true;
    // 先收菜单再执行主进程动作；不 await 回包后再往已销毁的 renderer 发消息。
    endOwner(record);
    try {
      await onAction(action);
    } catch (error) {
      report(error);
      throw error;
    }
    return { ok: true, action };
  });

  function toggle(bounds) {
    ensureLive();
    if (owner) {
      endOwner(owner);
      return false;
    }
    createOwner(bounds);
    return true;
  }

  function hide() {
    ensureLive();
    const record = owner;
    if (!record) return false;
    endOwner(record);
    return true;
  }

  // 只刷新已经报到 ready 的现存窗口；不创建窗口，也不在 getState 失败时发旧状态冒充新状态。
  function refresh() {
    ensureLive();
    const record = owner;
    if (!record) return false;
    const state = readState();
    if (!state) return false;
    record.state = state;
    if (!record.ready || record.cancelled || !record.win || record.win.isDestroyed?.() === true) return false;
    try {
      record.win.webContents.send(CHANNELS.state, state);
      return true;
    } catch (error) {
      report(error);
      return false;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (owner) endOwner(owner);
    for (const channel of Object.values(CHANNELS)) {
      try { ipcMain.removeHandler?.(channel); } catch { /* 没注册成功也无需摘。 */ }
    }
  }

  return { toggle, hide, refresh, dispose };
}

module.exports = { createTrayMenu, placeTrayMenu, MENU_SIZE, MENU_COMPACT_HEIGHT, ACTIONS, CHANNELS };
