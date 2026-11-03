'use strict';
// 独立图片编辑宿主：每个编辑文档（token）一扇普通（frame:true、可缩放/可移动、有任务栏条目、不置顶）BrowserWindow。
// 叠层截图时最多同时保留 3 层（父 2 + 当前 1），每层有自己的 host/doc/phase/握手/导出，互不覆盖。
// 返回预览只隐藏、不销毁；同一 token 再打开沿用同一份 DOM/草稿。宿主异常中断只记 tombstone，绝不用源图“重建”冒充保留草稿。
// 依赖全部由调用方传进来（BrowserWindow/screen/ipcMain），node:test 可以塞替身，不把真实 Electron 拉进测试进程。

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');

const LOAD_TIMEOUT_MS = 6000;
const READY_TIMEOUT_MS = 8000;
const EXPORT_TIMEOUT_MS = 15000;
const MAX_HOSTS = 3;
const MAX_SIZE = { width: 1200, height: 850 };
const MIN_SIZE = { width: 560, height: 400 };
const WORK_RATIO = 0.9;
const FAILED_MESSAGE = '编辑页已异常中断，未保存的编辑无法自动恢复；原截图保留，请明确重选或退出。';
// 编辑页健康读：只要一个布尔，不看文字与像素；单独认编辑根，不拿原选区页的 hint 冒充。
const HEALTH_PROBE = `(() => {
  const root = document.getElementById('editor-root');
  const canvas = root ? root.querySelector('canvas') : null;
  return { ready: document.readyState === 'complete' && Boolean(root) && root.hidden !== true &&
    Boolean(canvas) && canvas.width > 0 && canvas.height > 0 &&
    window.innerWidth > 0 && window.innerHeight > 0 };
})()`;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// 初始几何：工作区内居中，约 9 成、最多 1200×850；任何尺寸都不得超出实际工作区（小屏也不越界）。
function editorBounds(workArea) {
  const area = workArea && Number.isFinite(workArea.width) && Number.isFinite(workArea.height) &&
    workArea.width > 0 && workArea.height > 0
    ? workArea : { x: 0, y: 0, width: 1280, height: 800 };
  const maxWidth = Math.max(1, Math.min(MAX_SIZE.width, Math.floor(area.width)));
  const maxHeight = Math.max(1, Math.min(MAX_SIZE.height, Math.floor(area.height)));
  const width = clamp(Math.floor(area.width * WORK_RATIO), Math.min(MIN_SIZE.width, maxWidth), maxWidth);
  const height = clamp(Math.floor(area.height * WORK_RATIO), Math.min(MIN_SIZE.height, maxHeight), maxHeight);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width, height,
    minWidth: Math.min(MIN_SIZE.width, maxWidth),
    minHeight: Math.min(MIN_SIZE.height, maxHeight)
  };
}

function installImageEditorWindow({ BrowserWindow, screen, ipcMain, rendererFile, preloadFile, iconFile, theme,
  onLifecycle = () => {}, onStatus = () => {},
  onCommit = async () => { throw new Error('当前没有可提交的编辑结果'); },
  onClose = async () => true, onExit = async () => false, canInteract = () => true }) {
  // token → 记录。记录自己保存窗口/文档/阶段/握手/导出；不搞通用管理器。
  const records = new Map();
  const icon = typeof iconFile === 'string' && fs.existsSync(iconFile) ? iconFile : undefined;
  const note = (event, fields) => { try { onLifecycle(event, fields); } catch { /* 留痕失败不影响编辑。 */ } };

  const recordOf = token => (typeof token === 'string' && token ? records.get(token) || null : null);
  const aliveWin = record => (record && record.win && record.win.isDestroyed() !== true ? record.win : null);

  function settleOpen(record, error) {
    const wait = record.openWait;
    if (!wait) return;
    record.openWait = null;
    clearTimeout(wait.timer);
    if (error) wait.reject(error); else wait.resolve(true);
  }

  function settleExports(record, error) {
    for (const entry of record.exports.values()) {
      clearTimeout(entry.timer);
      entry.reject(error || new Error('编辑窗口已关闭'));
    }
    record.exports.clear();
  }

  // 收掉一扇窗口：不再有可用的编辑页时，在途握手/导出都要当场失败，绝不让它们挂到别的文档上。
  function teardown(record, error) {
    const win = record.win;
    record.destroying = true;
    record.win = null;
    record.loaded = null;
    record.rejectLost?.(error || new Error('编辑窗口已关闭'));
    record.rejectLost = null;
    settleOpen(record, error || new Error('编辑窗口已关闭'));
    settleExports(record, error || new Error('编辑窗口已关闭'));
    if (win && win.isDestroyed() !== true) {
      try { win.destroy(); } catch { /* 已关闭。 */ }
    }
  }

  // 已成功打开过的宿主异常中断：保留 tombstone（token 仍可被拒绝与释放），不删记录、不当新建。
  function failRecord(record, reason) {
    if (!record || record.phase === 'failed') return;
    record.phase = 'failed';
    record.failure = reason || FAILED_MESSAGE;
    note('editor-window', { windowEvent: 'failed', reason: record.failure });
    teardown(record, new Error(record.failure));
  }

  function cleanup(token) {
    const record = recordOf(token);
    if (!record) return false;
    records.delete(token);
    teardown(record, new Error('编辑窗口已关闭'));
    return true;
  }

  function createRecord(token, doc) {
    if (records.size >= MAX_HOSTS) throw new Error(`最多同时保留 ${MAX_HOSTS} 层编辑，先结束一层再打开`);
    let workArea;
    try { workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea; } catch { workArea = null; }
    const bounds = editorBounds(workArea);
    const win = new BrowserWindow({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      minWidth: bounds.minWidth, minHeight: bounds.minHeight,
      show: false, frame: true, resizable: true, movable: true, minimizable: true, maximizable: true, closable: true,
      titleBarStyle: 'hidden', titleBarOverlay: { color: '#e6f1e9', symbolColor: '#244e43', height: 36 }, accentColor: '#a8cbb9',
      skipTaskbar: false, alwaysOnTop: false, transparent: false, backgroundColor: '#f7faf6',
      autoHideMenuBar: true, title: '截个图 · 图片编辑',
      ...(icon ? { icon } : {}),
      webPreferences: { preload: preloadFile, contextIsolation: true, sandbox: true,
        nodeIntegration: false, backgroundThrottling: false }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    // 只有这扇不透明编辑窗拿主题色（背景/标题栏叠加/强调），构造参数已是浅色，这里在 load 前就按当前主题回填。
    theme?.bind?.(win, { titleBarOverlay: true });
    const record = {
      token, doc: { ...doc }, win, loaded: null, phase: 'loading', openWait: null,
      exports: new Map(), everOpened: false, failure: null, destroying: false, closing: false
    };
    record.lost = new Promise((resolve, reject) => { record.rejectLost = reject; });
    record.lost.catch(() => {});
    records.set(token, record);
    // 原生 X：先拦下，交给会话层问一次；确认后才由会话收尾销毁本窗。
    win.on('close', event => {
      event.preventDefault();
      if (record.closing || record.destroying) return;
      record.closing = true;
      Promise.resolve().then(() => onExit({ ...record.doc }, 'window-close')).catch(() => false).finally(() => { record.closing = false; });
    });
    win.on('closed', () => {
      if (record.destroying || records.get(record.token) !== record) return;
      if (record.everOpened) failRecord(record, FAILED_MESSAGE);
      else cleanup(record.token);
    });
    win.webContents.on('render-process-gone', () => {
      if (record.destroying || records.get(record.token) !== record) return;
      if (record.everOpened) failRecord(record, FAILED_MESSAGE);
      else cleanup(record.token);
    });
    record.loaded = (async () => {
      let timer;
      try {
        await Promise.race([
          win.loadFile(rendererFile),
          new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('编辑页加载超时')), LOAD_TIMEOUT_MS); })
        ]);
      } finally { if (timer) clearTimeout(timer); }
      if (win.isDestroyed()) throw new Error(FAILED_MESSAGE);
    })();
    record.loaded.catch(() => {});
    return record;
  }

  async function ensureLoaded(record) {
    try { await Promise.race([record.loaded, record.lost]); } catch (error) { throw new Error(`编辑页没能加载：${error?.message || error}`); }
    if (!aliveWin(record)) throw new Error(record.failure || FAILED_MESSAGE);
    return record.win;
  }

  // 打开（或唤回）这份文档：首次带图，已有文档只带元数据；同一 token 不重载页面。
  async function open(document, { dataUrl, warning } = {}) {
    if (!document || typeof document.token !== 'string' || !document.token) throw new TypeError('编辑文档无效');
    let record = recordOf(document.token);
    // 没有这条记录又没有源图：这份文档的编辑页已经不在，不能用空页面冒充“保留草稿”。
    if (!record && typeof dataUrl !== 'string') throw new Error(FAILED_MESSAGE);
    if (record && record.phase === 'failed') throw new Error(record.failure || FAILED_MESSAGE);
    if (!record) record = createRecord(document.token, document);
    else record.doc = { token: document.token, width: document.width, height: document.height,
      rect: { ...document.rect }, longToken: document.longToken,
      ...(typeof document.presentation === 'string' ? { presentation: document.presentation } : {}) };
    let win;
    try { win = await ensureLoaded(record); } catch (error) {
      if (!record.everOpened && records.get(record.token) === record) cleanup(record.token);
      throw error;
    }
    if (record.phase === 'failed') throw new Error(record.failure || FAILED_MESSAGE);
    if (record.openWait) settleOpen(record, new Error('编辑窗口正忙'));
    record.phase = 'opening';
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (record.openWait && record.openWait.token === document.token) settleOpen(record, new Error('编辑窗口没有就绪'));
      }, READY_TIMEOUT_MS);
      record.openWait = { token: document.token, resolve, reject, timer };
    });
    win.webContents.send('shot:editor-open', {
      token: record.doc.token, width: record.doc.width, height: record.doc.height, rect: { ...record.doc.rect },
      ...(typeof record.doc.longToken === 'string' ? { longToken: record.doc.longToken } : {}),
      ...(typeof record.doc.presentation === 'string' ? { presentation: record.doc.presentation } : {}),
      ...(typeof dataUrl === 'string' ? { dataUrl } : {}),
      warning: typeof warning === 'string' ? warning.slice(0, 2000) : ''
    });
    try { await ready; } catch (error) {
      // 首次初始化失败：还没有任何可用编辑，整条记录扔掉，主进程清掉这份新文档后可重试。
      // 已经成功编辑过的宿主：只记 tombstone，不静默回原图。
      if (!record.everOpened && records.get(record.token) === record) cleanup(record.token);
      else if (record.everOpened && aliveWin(record) && record.phase !== 'failed') { try { win.hide(); } catch {} record.phase = 'hidden'; }
      throw error;
    }
    if (!aliveWin(record) || record.phase === 'failed') { failRecord(record, record.failure); throw new Error(record.failure || FAILED_MESSAGE); }
    try {
      win.show();
      if (typeof win.isVisible === 'function' && win.isVisible() !== true) throw new Error('编辑窗口没能显示');
      try { win.focus(); } catch { /* 焦点失败不影响编辑。 */ }
    } catch (error) {
      if (!record.everOpened && records.get(record.token) === record) cleanup(record.token);
      else if (record.everOpened && aliveWin(record) && record.phase !== 'failed') { try { win.hide(); } catch {} record.phase = 'hidden'; }
      throw error;
    }
    record.phase = 'open';
    record.everOpened = true;
    note('editor-window', { windowEvent: 'opened', hasImage: typeof dataUrl === 'string', width: record.doc.width, height: record.doc.height });
    return { token: record.doc.token, width: record.doc.width, height: record.doc.height };
  }

  // 返回预览：只收起这一扇窗口，DOM/草稿/历史全部留着；同一 token 再 open 不重解码。
  async function close(token) {
    const record = recordOf(token);
    if (!record || !record.doc) return false;
    if (record.phase === 'failed') throw new Error(record.failure || FAILED_MESSAGE);
    const win = aliveWin(record);
    if (!win) { failRecord(record, FAILED_MESSAGE); throw new Error(record.failure); }
    if (record.phase === 'open') {
      try { win.hide(); } catch { throw new Error('编辑窗口没能收起'); }
      if (typeof win.isVisible === 'function' && win.isVisible() === true) throw new Error('编辑窗口仍在前台');
      record.phase = 'hidden';
    }
    return true;
  }

  // 原选区页的保存/复制：让这一份文档的编辑窗导出当前画面（PNG 或带说明的复制图），一次一请求。
  function requestExport(token, kind) {
    const record = recordOf(token);
    if (!record || !record.doc) return Promise.reject(new Error('当前没有可导出的编辑文档'));
    if (record.phase === 'failed') return Promise.reject(new Error(record.failure || FAILED_MESSAGE));
    const win = aliveWin(record);
    if (!win) { failRecord(record, FAILED_MESSAGE); return Promise.reject(new Error(record.failure)); }
    if (record.phase !== 'open' && record.phase !== 'hidden') return Promise.reject(new Error('编辑窗口尚未就绪'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { record.exports.delete(id); reject(new Error('导出超时')); }, EXPORT_TIMEOUT_MS);
      record.exports.set(id, { resolve, reject, timer, token: record.token });
      win.webContents.send('shot:editor-export', { id, kind: kind === 'copy' ? 'copy' : 'png', token: record.token });
    });
  }

  async function probe(token) {
    const record = recordOf(token);
    if (!record) return 'gone';
    if (record.phase === 'failed') return 'failed';
    const win = aliveWin(record);
    if (!win) return 'gone';
    let visible;
    try { visible = win.isVisible() === true; } catch { visible = false; }
    if (visible !== true) return 'hidden';
    let timer;
    try {
      const answer = await Promise.race([
        win.webContents.executeJavaScript(HEALTH_PROBE),
        new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 1500); })
      ]);
      if (answer === 'timeout') return 'timeout';
      if (answer && answer.ready === true) return 'drawable';
      if (answer && answer.ready === false) return 'blocked';
      return 'unknown';
    } catch { return 'throw'; } finally { clearTimeout(timer); }
  }

  // 按 sender 主 frame 找记录：两层叠着时，父页 IPC 绝不落到当前子层的记录上。
  function senderToken(event) {
    if (!event || !event.sender) return null;
    for (const record of records.values()) {
      const win = aliveWin(record);
      if (!win) continue;
      const wc = win.webContents;
      if (wc && event.sender === wc && wc.mainFrame && event.senderFrame === wc.mainFrame) return record.token;
    }
    return null;
  }

  // —— 页面来的受限 IPC：每条都核 sender/mainFrame/token ——
  ipcMain.handle('shot:editor-ready', (event, token) => {
    const sender = senderToken(event);
    const record = recordOf(sender);
    if (!record || sender !== token) throw new Error('编辑窗口已失效');
    if (record.phase !== 'opening' || !record.openWait) throw new Error('编辑会话已失效');
    settleOpen(record, null);
    return true;
  });
  ipcMain.handle('shot:editor-open-failed', (event, token, message) => {
    const sender = senderToken(event);
    const record = recordOf(sender);
    if (!record || sender !== token) throw new Error('编辑窗口已失效');
    settleOpen(record, new Error(`编辑页打开失败：${typeof message === 'string' && message ? message : '未知错误'}`));
    return true;
  });
  ipcMain.handle('shot:editor-close', async (event, payload) => {
    const sender = senderToken(event);
    const record = recordOf(sender);
    if (!record || !payload || payload.token !== sender) throw new Error('编辑文档已失效');
    if (!canInteract(record.doc)) throw new Error('编辑会话已失效');
    if (record.phase === 'failed') throw new Error(record.failure || FAILED_MESSAGE);
    if (record.phase === 'hidden') return true;
    if (record.phase !== 'open') throw new Error('编辑窗口尚未就绪');
    const win = aliveWin(record);
    if (!win) { failRecord(record, FAILED_MESSAGE); throw new Error(record.failure); }
    const snapshot = { ...record.doc };
    try { win.hide(); } catch { throw new Error('编辑窗口没能收起'); }
    if (typeof win.isVisible === 'function' && win.isVisible() === true) throw new Error('编辑窗口仍在前台');
    record.phase = 'hidden';
    try { await onClose({ doc: snapshot, payload }); } catch (error) {
      // 会话没接住这次交回：把这一份编辑页放回来，草稿仍在。
      if (records.get(record.token) === record && record.win === win && record.phase !== 'failed' && !win.isDestroyed() && canInteract(record.doc)) {
        try { win.show(); } catch { /* 显示失败只保留数据。 */ }
        record.phase = 'open';
      }
      throw error;
    }
    if (records.get(record.token) !== record || record.win !== win || record.phase === 'failed' || win.isDestroyed()) throw new Error('编辑会话已失效');
    return true;
  });
  ipcMain.handle('shot:editor-exit-request', async (event, token, source) => {
    const sender = senderToken(event);
    const record = recordOf(sender);
    if (!record || !record.doc || sender !== token) throw new Error('编辑窗口已失效');
    if (!canInteract(record.doc)) throw new Error('编辑会话已失效');
    if (record.phase === 'failed') throw new Error(record.failure || FAILED_MESSAGE);
    if (record.phase !== 'open') throw new Error('编辑窗口尚未就绪');
    // 只转交给会话层已有的退出申请：确认面板、保留/放弃与收尾都不在本模块，也不先把图藏起来。
    const from = source === 'context-menu' || source === 'escape-key' ? source : 'window-close';
    return onExit({ ...record.doc }, from);
  });
  ipcMain.handle('shot:editor-commit', async (event, action, edited) => {
    const sender = senderToken(event);
    const record = recordOf(sender);
    if (!record || !record.doc) throw new Error('编辑文档已失效');
    if (!canInteract(record.doc)) throw new Error('编辑会话已失效');
    if (record.phase === 'failed') throw new Error(record.failure || FAILED_MESSAGE);
    if (!['save', 'save-quick', 'copy'].includes(action)) throw new Error('请选择保存或复制');
    if (!edited || typeof edited !== 'object' || edited.token !== sender) throw new Error('编辑结果缺失或已失效');
    return onCommit(action, edited, { ...record.doc });
  });
  ipcMain.handle('shot:editor-export-reply', (event, id, ok, payload) => {
    const sender = senderToken(event);
    const record = recordOf(sender);
    if (!record) throw new Error('编辑窗口已失效');
    if (typeof id !== 'string') throw new Error('导出请求已失效');
    const entry = record.exports.get(id);
    if (!entry || entry.token !== sender) throw new Error('导出请求已失效');
    record.exports.delete(id);
    clearTimeout(entry.timer);
    if (ok === true) entry.resolve(payload);
    else entry.reject(new Error(payload && typeof payload.message === 'string' && payload.message ? payload.message : '导出失败'));
    return true;
  });

  return {
    open, close, export: requestExport, probe, senderToken, isSender: (event, token) => typeof token === 'string' && senderToken(event) === token,
    getWindow: token => aliveWin(recordOf(token)),
    getDocument: token => { const record = recordOf(token); return record && record.doc ? { ...record.doc } : null; },
    isFailed: token => { const record = recordOf(token); return Boolean(record && record.phase === 'failed'); },
    // 只清这一层；父层/子层的记录与窗口不动。
    cleanup,
    // 应用退出才全清。
    dispose: () => { for (const token of [...records.keys()]) cleanup(token); }
  };
}

module.exports = { installImageEditorWindow, editorBounds, FAILED_MESSAGE };
