'use strict';
// 独立图片编辑宿主：每个编辑文档（token）一扇普通（frame:true、可缩放/可移动、有任务栏条目、不置顶）BrowserWindow。
// 叠层截图时最多同时保留 3 层（父 2 + 当前 1），每层有自己的 host/doc/phase/握手/导出，互不覆盖。
// 返回预览只隐藏、不销毁；同一 token 再打开沿用同一份 DOM/草稿。宿主异常中断只记 tombstone，绝不用源图“重建”冒充保留草稿。
// 依赖全部由调用方传进来（BrowserWindow/screen/ipcMain），node:test 可以塞替身，不把真实 Electron 拉进测试进程。

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalize: safeCheckRegions } = require('../core/check-regions.js');
const { plan: segmentPlan, fileName: segmentFileName } = require('../core/segment-export.js');
const { checkEditSize } = require('./edited-image.cjs');

const LOAD_TIMEOUT_MS = 6000;
const READY_TIMEOUT_MS = 8000;
const EXPORT_TIMEOUT_MS = 15000;
const MAX_HOSTS = 3;
const MAX_SIZE = { width: 1200, height: 850 };
const MIN_SIZE = { width: 560, height: 400 };
const WORK_RATIO = 0.9;
const FAILED_MESSAGE = '编辑页已异常中断，未保存的编辑无法自动恢复；原截图保留，请明确重选或退出。';
// 单段 PNG 的接收闸：按 RGBA 最坏体积算，2400 高 × 30000 宽也只有 288MB 原始量；
// 128MiB 足够装真截图，又不会把一个膨胀的坏包直接写进用户目录。
const MAX_SEGMENT_PNG_BYTES = 128 * 1024 * 1024;
const MAX_SEGMENT_BATCH_FILES = 500;
// 整批累计字节闸：36M 像素 RGBA 加上重叠与 PNG 开销留余量；超过就在写盘前拒，不先写一半再说完成。
const MAX_SEGMENT_BATCH_BYTES = 256 * 1024 * 1024;
// 编辑页健康读：只要一个布尔，不看文字与像素；单独认编辑根，不拿原选区页的 hint 冒充。
const HEALTH_PROBE = `(() => {
  const root = document.getElementById('editor-root');
  const canvas = root ? root.querySelector('canvas') : null;
  return { ready: document.readyState === 'complete' && Boolean(root) && root.hidden !== true &&
    Boolean(canvas) && canvas.width > 0 && canvas.height > 0 &&
    window.innerWidth > 0 && window.innerHeight > 0 };
})()`;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// 缺区定位元数据的对外出口：把 {total, truncated, rects} 重新按这张图的尺寸验一遍。
// 规则与渲染层、主进程接收闸共用 core/check-regions.js；计数与位置分开对待，不补造矩形。

// 只读 PNG 头：签名 + IHDR 宽高。不信任页面声明的尺寸，也不把坏包写进用户目录。
function pngHeader(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33) return null;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let index = 0; index < signature.length; index++) if (bytes[index] !== signature[index]) return null;
  if (bytes.readUInt32BE(8) !== 13) return null;
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

// 批次目录：用户选的目录下新建一个唯一的子目录；每个文件都用 wx 写入，绝不覆盖任何已有文件。
function batchDirectoryName(date) {
  const pad = value => String(value).padStart(2, '0');
  return `截个图分段-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

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
  onClose = async () => true, onExit = async () => false, canInteract = () => true,
  onCopyText = null,
  // 分段导出的目录选择器：由调用方注入 electron dialog，测试可换替身；不注入就不能导。
  showDirectory = null,
  // 分段写盘：默认走 fs.promises.writeFile，测试可注入可控延迟/失败，用来验竞态。
  writeSegmentFile = (file, bytes, options) => fs.promises.writeFile(file, bytes, options) }) {
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
    // 在途分段批次当场作废：迟到的那几段会被拒绝，不会写到另一张图或另一个目录。
    record.segment = null;
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
      exports: new Map(), segment: null, everOpened: false, failure: null, destroying: false, closing: false
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
      ...(typeof document.presentation === 'string' ? { presentation: document.presentation } : {}),
      ...(document.checkRegions ? { checkRegions: document.checkRegions } : {}) };
    // 缺区定位元数据：只带计数与成图内整数矩形，按本份文档尺寸重验一遍；不合法就只当没有位置。
    const regions = safeCheckRegions(document.checkRegions ?? record.doc.checkRegions, record.doc.width, record.doc.height);
    if (regions) record.doc.checkRegions = regions; else delete record.doc.checkRegions;
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
      ...(regions ? { checkRegions: regions } : {}),
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

  // —— 分段导出 ——
  // 目标目录由主进程的目录选择器确定，文件名/序号由主进程生成；渲染层只能一段一段地上传 PNG。
  // 每个文件都用 wx 写入，绝不覆盖已有文件；中途失败/取消只如实报告已写多少张，不删旧文件。
  const activeBatch = record => (record && record.segment && record.segment.plan && record.segment.state === 'ready' ? record.segment : null);

  async function uniqueBatchDir(root) {
    const base = batchDirectoryName(new Date());
    for (let n = 1; n <= 50; n++) {
      const target = path.join(root, n === 1 ? base : `${base}-${n}`);
      try { await fs.promises.mkdir(target); return target; }
      catch (error) { if (error?.code !== 'EEXIST') throw new Error(`无法新建分段目录：${error?.message || error}`); }
    }
    throw new Error('同一秒里已经有太多分段目录，请稍后重试');
  }

  async function startSegmentBatch(record, owner) {
    if (typeof showDirectory !== 'function') throw new Error('当前环境不支持选择分段导出文件夹');
    if (record.segment && !['done', 'aborted', 'failed'].includes(record.segment.state)) throw new Error('上一次分段导出还没结束');
    const choice = await showDirectory(owner, { title: '选择分段导出的文件夹', buttonLabel: '导出到这里',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] });
    if (!choice || choice.canceled === true) return { canceled: true };
    const root = Array.isArray(choice.filePaths) ? choice.filePaths[0] : choice.filePath;
    if (typeof root !== 'string' || !root) throw new Error('没有选到文件夹，已取消');
    const dir = await uniqueBatchDir(root);
    const batch = { id: randomUUID(), token: record.token, dir, plan: null, written: 0, bytes: 0, state: 'ready' };
    record.segment = batch;
    note('segment-export', { windowEvent: 'start', files: 0 });
    return { ok: true, batchId: batch.id, dir: batch.dir };
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

  // OCR 只复用当前可交互文档：捕获图和外部图都按同一宿主主 frame 校验。
  function ocrContext(event, token) {
    const record = recordOf(token);
    if (!record || senderToken(event) !== token || record.phase !== 'open' || record.closing ||
        !aliveWin(record) || !canInteract(record.doc)) return null;
    if (!record.ocrSession) record.ocrSession = { phase: 'selecting', editorOpen: true, editDocument: record.doc };
    return record.ocrSession;
  }
  ipcMain.handle('shot:editor-copy-text', (event, payload) => {
    if (!payload || !ocrContext(event, payload.token)) throw new Error('编辑文档已失效');
    if (typeof payload.text !== 'string' || !payload.text.trim() || Array.from(payload.text).length > 2000) {
      throw new Error('待复制文字为空或过长');
    }
    if (typeof onCopyText !== 'function') throw new Error('当前不能复制文字');
    onCopyText(payload.text);
    return { ok: true };
  });

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

  // —— 分段导出 IPC：每条都核 sender 主 frame / token / 当前文档归属 ——
  ipcMain.handle('shot:editor-segment-start', async (event, payload) => {
    const sender = senderToken(event);
    const record = recordOf(sender);
    if (!record || !record.doc || !payload || payload.token !== sender) throw new Error('编辑文档已失效');
    if (!canInteract(record.doc)) throw new Error('编辑会话已失效');
    if (record.phase === 'failed') throw new Error(record.failure || FAILED_MESSAGE);
    if (record.phase !== 'open' && record.phase !== 'hidden') throw new Error('编辑窗口尚未就绪');
    const win = aliveWin(record);
    if (!win) { failRecord(record, FAILED_MESSAGE); throw new Error(record.failure || FAILED_MESSAGE); }
    return startSegmentBatch(record, win);
  });
  ipcMain.handle('shot:editor-segment-begin', (event, payload) => {
    const sender = senderToken(event);
    const record = recordOf(sender);
    if (!record || !record.doc || !payload || payload.token !== sender) throw new Error('编辑文档已失效');
    if (!canInteract(record.doc)) throw new Error('编辑会话已失效');
    const batch = record.segment;
    if (!batch || payload.batchId !== batch.id) throw new Error('分段导出会话已失效');
    if (batch.state !== 'ready' || batch.plan || batch.written) throw new Error('分段计划已经确定');
    // 计划只信主进程自己算的：页面只报“要切的整张输出尺寸”，段数与边界全部按同一份规则重算。
    const plan = segmentPlan(payload.width, payload.height);
    // 整图尺寸走编辑/复制同一条 36M 像素、30000 边长闸：分段不是绕过编辑容量的后门。
    checkEditSize({ width: plan.width, height: plan.height });
    if (plan.segments.length > MAX_SEGMENT_BATCH_FILES) throw new Error('分段数量超过上限');
    batch.plan = plan;
    return { ok: true, width: plan.width, height: plan.height, total: plan.segments.length, segmentHeight: plan.segmentHeight, overlap: plan.overlap };
  });
  ipcMain.handle('shot:editor-segment-part', async (event, payload) => {
    const sender = senderToken(event);
    const record = recordOf(sender);
    if (!record || !record.doc || !payload || payload.token !== sender) throw new Error('编辑文档已失效');
    if (!canInteract(record.doc)) throw new Error('编辑会话已失效');
    const batch = activeBatch(record);
    if (!batch || payload.batchId !== batch.id) throw new Error('分段导出会话已失效');
    const index = payload.index;
    if (!Number.isInteger(index) || index !== batch.written) throw new Error('分段顺序不对，已停止导出');
    const segment = batch.plan.segments[index];
    if (!segment) throw new Error('分段序号超出计划');
    const png = payload.png;
    if (!(png instanceof ArrayBuffer) || png.byteLength === 0 || png.byteLength > MAX_SEGMENT_PNG_BYTES) throw new Error('分段图片无效或过大');
    const bytes = Buffer.from(png);
    const header = pngHeader(bytes);
    if (!header || header.width !== batch.plan.width || header.height !== segment.height) throw new Error('分段图片尺寸与计划不符');
    // 整批累计字节闸放在写盘之前：超限就一张也不写，不先写一半再说不够。
    if (batch.bytes + bytes.length > MAX_SEGMENT_BATCH_BYTES) throw new Error(`这一批超过 ${MAX_SEGMENT_BATCH_BYTES / 1048576}MB 上限，已停止导出`);
    const file = path.join(batch.dir, segmentFileName(index, batch.plan.segments.length));
    batch.state = 'writing';
    // 写盘是异步的：abort 可能就发生在这一刻。把这次写入的 promise 留在批次上，
    // 让 abort/done 等它落定再记账；写完也只从 writing 回到 ready，绝不把终态复活。
    const write = (async () => {
      try { await writeSegmentFile(file, bytes, { flag: 'wx' }); }
      catch (error) {
        if (batch.state === 'writing') batch.state = 'failed';
        if (error?.code === 'EEXIST') throw new Error(`目标文件已存在，未覆盖：${path.basename(file)}`);
        throw new Error(`写入分段失败：${error?.message || error}`);
      }
      batch.written += 1; batch.bytes += bytes.length;
      if (batch.state === 'writing') batch.state = 'ready';
      return { ok: true, written: batch.written, total: batch.plan.segments.length, bytes: batch.bytes };
    })();
    batch.writeChain = write.catch(() => {});
    return write;
  });
  ipcMain.handle('shot:editor-segment-done', async (event, payload) => {
    const sender = senderToken(event);
    const record = recordOf(sender);
    if (!record || !record.doc || !payload || payload.token !== sender) throw new Error('编辑文档已失效');
    const batch = record.segment;
    if (!batch || payload.batchId !== batch.id) throw new Error('分段导出会话已失效');
    // 有在途写入时先等它落定，再判断完成；aborted/failed 批次永远不算成功。
    if (batch.writeChain) { try { await batch.writeChain; } catch { /* 失败已在 part 里记账。 */ } }
    if (!batch.plan) throw new Error('分段还没有计划');
    if (batch.state !== 'ready' || batch.written !== batch.plan.segments.length) throw new Error('分段还没写完，不能算完成');
    batch.state = 'done';
    note('segment-export', { windowEvent: 'done', files: batch.written });
    return { ok: true, dir: batch.dir, files: batch.written, bytes: batch.bytes, total: batch.plan.segments.length };
  });
  ipcMain.handle('shot:editor-segment-abort', async (event, payload) => {
    const sender = senderToken(event);
    const record = recordOf(sender);
    if (!record || !payload || payload.token !== sender) throw new Error('编辑文档已失效');
    const batch = record.segment;
    if (!batch || payload.batchId !== batch.id) return { ok: false, written: 0 };
    // 终态不可复活：done/aborted/failed 都不再改；只有 running 中的批次会被叫停。
    if (batch.state !== 'done' && batch.state !== 'aborted' && batch.state !== 'failed') batch.state = 'aborted';
    // 在途写入要等它落定再报账：不能少报一张，也不把还在写的说成已写。
    if (batch.writeChain) { try { await batch.writeChain; } catch { /* 失败已在 part 里记账。 */ } }
    note('segment-export', { windowEvent: 'abort', files: batch.written });
    return { ok: true, written: batch.written, bytes: batch.bytes, dir: batch.dir, state: batch.state };
  });

  return {
    open, close, export: requestExport, probe, senderToken, isSender: (event, token) => typeof token === 'string' && senderToken(event) === token,
    ocrContext,
    getWindow: token => aliveWin(recordOf(token)),
    getDocument: token => { const record = recordOf(token); return record && record.doc ? { ...record.doc } : null; },
    // 只给测试/调用方看已写到第几张，不向外发目录内容。
    getSegment: token => { const record = recordOf(token); return record && record.segment ? { ...record.segment, plan: undefined } : null; },
    isFailed: token => { const record = recordOf(token); return Boolean(record && record.phase === 'failed'); },
    // 只清这一层；父层/子层的记录与窗口不动。
    cleanup,
    // 应用退出才全清。
    dispose: () => { for (const token of [...records.keys()]) cleanup(token); }
  };
}

module.exports = { installImageEditorWindow, editorBounds, FAILED_MESSAGE };
